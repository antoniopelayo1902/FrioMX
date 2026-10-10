#!/usr/bin/env bash
# Reanuda FrioMx al iniciar una sesión nueva del Learner Lab (la EC2 se detiene al cerrar el lab).
#   1. verifica credenciales   2. arranca la EC2 si está detenida   3. espera SSM Online
#   4. espera /api/health      5. imprime la URL   6. con --gh-repo: scripts/update-gh-secrets.sh
#
# Uso: scripts/resume-lab.sh [--gh-repo OWNER/REPO]
#   --gh-repo OWNER/REPO  además copia las credenciales nuevas a los secretos de GitHub (para el CD).
# Requisitos: aws, terraform, curl; infra/envs/lab/backend.hcl. Con --gh-repo: gh.
# Variables opcionales: SSM_WAIT (s, default 300), HEALTH_WAIT (s, default 180).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${ROOT}/infra/envs/lab"
SSM_WAIT="${SSM_WAIT:-300}"
HEALTH_WAIT="${HEALTH_WAIT:-180}"
GH_REPO=""

usage() { sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --gh-repo)
      [[ $# -ge 2 ]] || { echo "falta OWNER/REPO después de --gh-repo" >&2; exit 2; }
      GH_REPO="$2"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log() { echo "==> $*" >&2; }
die() { echo "ERROR: $*" >&2; exit 1; }

[[ "${SSM_WAIT}" =~ ^[0-9]+$ ]] || die "SSM_WAIT debe ser un número de segundos"
[[ "${HEALTH_WAIT}" =~ ^[0-9]+$ ]] || die "HEALTH_WAIT debe ser un número de segundos"
if [[ -n "${GH_REPO}" ]]; then
  [[ "${GH_REPO}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--gh-repo debe ser OWNER/REPO (recibí '${GH_REPO}')"
  command -v gh >/dev/null 2>&1 || die "falta la CLI de GitHub (gh) para --gh-repo"
fi
for bin in aws terraform curl; do
  command -v "${bin}" >/dev/null 2>&1 || die "falta '${bin}' en el PATH"
done
[[ -s "${TF_DIR}/backend.hcl" ]] || die "falta ${TF_DIR}/backend.hcl o está vacío"

export TF_IN_AUTOMATION=1
export AWS_PAGER=""

# --- 1. Credenciales (caducan con cada sesión del lab) ---
log "Verificando credenciales de AWS"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || die "credenciales inválidas o vencidas: pega 'AWS Details' del lab en ~/.aws/credentials"
log "Cuenta ${ACCOUNT}"

log "terraform init"
terraform -chdir="${TF_DIR}" init -input=false -reconfigure -backend-config=backend.hcl >&2
tf_out() { terraform -chdir="${TF_DIR}" output -raw "$1"; }
REGION="$(tf_out aws_region)" || die "el estado no tiene salidas: ¿ya corriste scripts/deploy.sh?"
INSTANCE_ID="$(tf_out instance_id)"
PUBLIC_IP="$(tf_out public_ip)"
export AWS_REGION="${REGION}" AWS_DEFAULT_REGION="${REGION}"
[[ "${INSTANCE_ID}" =~ ^i-[0-9a-f]+$ ]] || die "instance_id inesperado: '${INSTANCE_ID}'"

# --- 2. EC2 ---
state="$(aws ec2 describe-instances --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)"
log "EC2 ${INSTANCE_ID}: ${state}"
if [[ "${state}" == "stopping" ]]; then
  log "Esperando a que termine de detenerse"
  aws ec2 wait instance-stopped --instance-ids "${INSTANCE_ID}"
  state="stopped"
fi
case "${state}" in
  running) ;;
  stopped)
    log "Arrancando ${INSTANCE_ID}"
    aws ec2 start-instances --instance-ids "${INSTANCE_ID}" >/dev/null
    aws ec2 wait instance-running --instance-ids "${INSTANCE_ID}"
    ;;
  pending) aws ec2 wait instance-running --instance-ids "${INSTANCE_ID}" ;;
  *) die "la instancia está en estado '${state}'; hay que recrearla con scripts/deploy.sh" ;;
esac

# --- 3. SSM ---
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
log "SSM Online"

# --- 4. Salud (systemd levanta backend, frontend y nginx al arrancar) ---
URL="http://${PUBLIC_IP}"
log "Esperando ${URL}/api/health (máx ${HEALTH_WAIT}s)"
deadline=$((SECONDS + HEALTH_WAIT))
until curl -fsS --max-time 5 -o /dev/null "${URL}/api/health"; do
  ((SECONDS < deadline)) || die "${URL}/api/health no respondió; revisa /friomx/backend en CloudWatch Logs"
  sleep 5
done
log "Salud OK"

# --- 6. Secretos de GitHub ---
if [[ -n "${GH_REPO}" ]]; then
  log "Actualizando secretos de GitHub en ${GH_REPO}"
  bash "${ROOT}/scripts/update-gh-secrets.sh" --repo "${GH_REPO}"
fi

echo "FrioMx listo en ${URL}/"
