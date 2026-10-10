#!/usr/bin/env bash
# Despliegue completo de FrioMx (LLD §14-§15). Lo usan las personas y el CD.
#   1. lambdas/build.sh            2. terraform init/apply (infra/envs/lab)
#   3. npm ci --omit=dev y tgz     4. sube tgz + env a s3://<artifacts>/releases/<sha>/
#   5. SSM send-command -> scripts/deploy-on-instance.sh   6. prueba de humo /api/health y /login
#
# Uso: scripts/deploy.sh [--skip-terraform]
#   --skip-terraform  no corre build de Lambdas ni apply; solo lee las salidas del estado.
# Requisitos: aws, terraform, npm, node, git, curl; infra/envs/lab/backend.hcl y lab.tfvars.
# Variables opcionales: DEPLOY_TIMEOUT (s, default 900), SSM_WAIT (s, default 300).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${ROOT}/infra/envs/lab"
# El primer arranque espera cloud-init (dnf + 4 paquetes); executionTimeout de SSM usa el mismo valor.
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-900}"
[[ "$DEPLOY_TIMEOUT" =~ ^[0-9]+$ ]] || { echo "DEPLOY_TIMEOUT debe ser un número de segundos" >&2; exit 1; }
SSM_WAIT="${SSM_WAIT:-300}"
SKIP_TF=false

usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --skip-terraform) SKIP_TF=true ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log() { echo "==> $*" >&2; }
die() { echo "ERROR: $*" >&2; exit 1; }

for bin in aws terraform npm node git curl tar; do
  command -v "${bin}" >/dev/null 2>&1 || die "falta '${bin}' en el PATH"
done
[[ -s "${TF_DIR}/backend.hcl" ]] || die "falta ${TF_DIR}/backend.hcl o está vacío (genéralo con infra/bootstrap/bootstrap-state.sh)"
if [[ "${SKIP_TF}" == false ]]; then
  [[ -f "${TF_DIR}/lab.tfvars" ]] || die "falta ${TF_DIR}/lab.tfvars (copia lab.tfvars.example)"
fi

export TF_IN_AUTOMATION=1
# Sin pager: la CLI v2 abre less cuando escribe a una terminal y congela el script.
export AWS_PAGER=""

# --- Versión ---
SHA="${GITHUB_SHA:-$(git -C "${ROOT}" rev-parse HEAD 2>/dev/null || echo manual)}"
SHA="${SHA:0:12}"
if [[ -z "${GITHUB_SHA:-}" ]] && [[ -n "$(git -C "${ROOT}" status --porcelain 2>/dev/null || true)" ]]; then
  SHA="${SHA}-dirty"
fi
RELEASE_ID="${SHA}-$(date -u +%Y%m%d%H%M%S)"
log "Versión ${SHA} (directorio en la instancia: ${RELEASE_ID})"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/friomx-deploy.XXXXXX")"
# shellcheck disable=SC2329  # se invoca vía trap
cleanup() { rm -rf "${STAGE}"; }
trap cleanup EXIT

# --- 1-2. Lambdas + Terraform ---
if [[ "${SKIP_TF}" == false ]]; then
  [[ -f "${ROOT}/lambdas/build.sh" ]] || die "falta lambdas/build.sh"
  log "Armando Lambdas (lambdas/build.sh)"
  bash "${ROOT}/lambdas/build.sh"
fi

log "terraform init"
terraform -chdir="${TF_DIR}" init -input=false -reconfigure -backend-config=backend.hcl >&2

if [[ "${SKIP_TF}" == false ]]; then
  log "terraform apply"
  terraform -chdir="${TF_DIR}" apply -input=false -auto-approve -var-file=lab.tfvars >&2
fi

tf_out() { terraform -chdir="${TF_DIR}" output -raw "$1"; }

REGION="$(tf_out aws_region)"
INSTANCE_ID="$(tf_out instance_id)"
PUBLIC_IP="$(tf_out public_ip)"
BUCKET="$(tf_out artifacts_bucket)"
export AWS_REGION="${REGION}" AWS_DEFAULT_REGION="${REGION}"

# Los valores van dentro del JSON de SSM: solo se aceptan caracteres seguros.
for v in "${REGION}" "${INSTANCE_ID}" "${BUCKET}" "${SHA}" "${RELEASE_ID}"; do
  [[ "${v}" =~ ^[A-Za-z0-9._-]+$ ]] || die "valor inesperado: '${v}'"
done

# --- 3. Paquete ---
log "Preparando backend y frontend (npm ci --omit=dev)"
TAR_FLAGS=()
if tar --version 2>/dev/null | grep -qi bsdtar; then
  export COPYFILE_DISABLE=1
  TAR_FLAGS=(--no-mac-metadata --no-xattrs)
fi

PKG="${STAGE}/pkg"
mkdir -p "${PKG}/scripts" "${PKG}/infra"
tar -C "${ROOT}" ${TAR_FLAGS[@]+"${TAR_FLAGS[@]}"} \
  --exclude='node_modules' --exclude='coverage' --exclude='.env' --exclude='.DS_Store' \
  --exclude='backend/test' \
  -cf - backend frontend | tar -C "${PKG}" -xf -
(cd "${PKG}/backend" && npm ci --omit=dev --no-audit --no-fund >&2)
(cd "${PKG}/frontend" && npm ci --omit=dev --no-audit --no-fund >&2)
cp "${ROOT}/scripts/deploy-on-instance.sh" "${PKG}/scripts/"
if [[ -f "${ROOT}/infra/cloudwatch-agent.json" ]]; then
  cp "${ROOT}/infra/cloudwatch-agent.json" "${PKG}/infra/"
fi

TGZ="${STAGE}/release.tgz"
PKG_ITEMS=(backend frontend scripts/deploy-on-instance.sh)
[[ -f "${PKG}/infra/cloudwatch-agent.json" ]] && PKG_ITEMS+=(infra/cloudwatch-agent.json)
tar -C "${PKG}" ${TAR_FLAGS[@]+"${TAR_FLAGS[@]}"} -czf "${TGZ}" "${PKG_ITEMS[@]}"

ENV_FILE="${STAGE}/backend.env"
tf_out backend_env >"${ENV_FILE}"
grep -q '^JWT_SECRET_ARN=' "${ENV_FILE}" || die "backend_env sin JWT_SECRET_ARN"

# --- 4. Subida a S3 ---
PREFIX="s3://${BUCKET}/releases/${SHA}"
log "Subiendo a ${PREFIX}/"
aws s3 cp "${TGZ}" "${PREFIX}/release.tgz" --only-show-errors
aws s3 cp "${ENV_FILE}" "${PREFIX}/backend.env" --only-show-errors

# --- Espera de registro en SSM (primer arranque) ---
log "Esperando a que ${INSTANCE_ID} esté Online en SSM (máx ${SSM_WAIT}s)"
deadline=$((SECONDS + SSM_WAIT))
while :; do
  ping="$(aws ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=${INSTANCE_ID}" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
  [[ "${ping}" == "Online" ]] && break
  ((SECONDS < deadline)) || die "la instancia no se registró en SSM (estado: ${ping:-desconocido})"
  sleep 10
done

# --- 5. send-command ---
REL_DIR="/opt/friomx/releases/${RELEASE_ID}"
TMP_TGZ="/tmp/friomx-${RELEASE_ID}.tgz"
COMMANDS=(
  "set -eu"
  "rm -rf ${REL_DIR}"
  "mkdir -p ${REL_DIR}"
  "aws s3 cp ${PREFIX}/release.tgz ${TMP_TGZ} --region ${REGION} --only-show-errors"
  "tar -xzf ${TMP_TGZ} -C ${REL_DIR}"
  "rm -f ${TMP_TGZ}"
  "bash ${REL_DIR}/scripts/deploy-on-instance.sh ${REL_DIR} ${PREFIX}/backend.env ${REGION}"
)
json_cmds=""
for c in "${COMMANDS[@]}"; do
  json_cmds+="${json_cmds:+,}\"${c}\""
done
PARAMS="{\"commands\":[${json_cmds}],\"executionTimeout\":[\"${DEPLOY_TIMEOUT}\"]}"

log "Enviando comando SSM"
COMMAND_ID="$(aws ssm send-command \
  --instance-ids "${INSTANCE_ID}" \
  --document-name AWS-RunShellScript \
  --comment "FrioMx deploy ${SHA}" \
  --parameters "${PARAMS}" \
  --query Command.CommandId --output text)"
log "CommandId ${COMMAND_ID}; esperando resultado (máx ${DEPLOY_TIMEOUT}s)"

# El waiter de la CLI se rinde a los 100 s: ciclo propio.
deadline=$((SECONDS + DEPLOY_TIMEOUT))
STATUS="Pending"
while :; do
  if out="$(aws ssm get-command-invocation --command-id "${COMMAND_ID}" --instance-id "${INSTANCE_ID}" \
    --query Status --output text 2>&1)"; then
    STATUS="${out}"
  elif [[ "${out}" == *InvocationDoesNotExist* ]]; then
    STATUS="Pending"
  else
    die "get-command-invocation falló: ${out}"
  fi
  case "${STATUS}" in
    Success | Failed | Cancelled | TimedOut) break ;;
  esac
  if ((SECONDS >= deadline)); then
    STATUS="LocalTimeout"
    # Que no siga corriendo en la instancia y choque con el siguiente deploy.
    aws ssm cancel-command --region "${REGION}" --command-id "${COMMAND_ID}" >/dev/null 2>&1 || true
    break
  fi
  sleep 5
done

echo "----- stdout de la instancia -----"
aws ssm get-command-invocation --command-id "${COMMAND_ID}" --instance-id "${INSTANCE_ID}" \
  --query StandardOutputContent --output text 2>/dev/null || true
echo "----- stderr de la instancia -----"
aws ssm get-command-invocation --command-id "${COMMAND_ID}" --instance-id "${INSTANCE_ID}" \
  --query StandardErrorContent --output text 2>/dev/null || true
echo "----------------------------------"

[[ "${STATUS}" == "Success" ]] || die "el despliegue en la instancia terminó con estado ${STATUS}"

# --- 6. Prueba de humo (backend vía /api/health y frontend vía /login) ---
URL="http://${PUBLIC_IP}/api/health"
FRONT_URL="http://${PUBLIC_IP}/login"
log "Prueba de humo ${URL} y ${FRONT_URL}"
for i in $(seq 1 12); do
  if curl -fsS --max-time 5 -o /dev/null "${URL}" && curl -fsS --max-time 5 -o /dev/null "${FRONT_URL}"; then
    log "Salud OK (intento ${i}). FrioMx en http://${PUBLIC_IP}/"
    exit 0
  fi
  sleep 5
done
die "la prueba de humo falló en ${URL} o ${FRONT_URL}"
