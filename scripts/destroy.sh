#!/usr/bin/env bash
# Destruye todo el ambiente FrioMx del lab (infra/envs/lab).
#   1. vacía los buckets versionados (uploads y artifacts): versiones y marcas de borrado
#   2. terraform destroy
#   3. sin --keep-state, vacía y borra también el bucket del estado (backend.hcl)
#
# Uso: scripts/destroy.sh [--yes] [--keep-state]
#   --yes         no pregunta; sin esta opción hay que escribir "destruir" para seguir.
#   --keep-state  conserva el bucket del estado (para volver a crear con deploy.sh sin bootstrap).
# Requisitos: aws, terraform, node; infra/envs/lab/backend.hcl y lab.tfvars.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${ROOT}/infra/envs/lab"
ASSUME_YES=false
KEEP_STATE=false

usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --yes) ASSUME_YES=true ;;
    --keep-state) KEEP_STATE=true ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log() { echo "==> $*" >&2; }
die() { echo "ERROR: $*" >&2; exit 1; }

for bin in aws terraform node; do
  command -v "${bin}" >/dev/null 2>&1 || die "falta '${bin}' en el PATH"
done
[[ -s "${TF_DIR}/backend.hcl" ]] || die "falta ${TF_DIR}/backend.hcl o está vacío"
[[ -f "${TF_DIR}/lab.tfvars" ]] || die "falta ${TF_DIR}/lab.tfvars (copia lab.tfvars.example)"

export TF_IN_AUTOMATION=1
export AWS_PAGER=""

STATE_BUCKET="$(sed -n 's/^[[:space:]]*bucket[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "${TF_DIR}/backend.hcl" | head -n1)"
STATE_REGION="$(sed -n 's/^[[:space:]]*region[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "${TF_DIR}/backend.hcl" | head -n1)"
[[ "${STATE_BUCKET}" =~ ^[a-z0-9.-]+$ ]] || die "no pude leer 'bucket' de backend.hcl"
STATE_REGION="${STATE_REGION:-us-east-1}"

aws sts get-caller-identity --region "${STATE_REGION}" --query Account --output text >/dev/null 2>&1 \
  || die "no hay credenciales de AWS válidas (pega 'AWS Details' del lab en ~/.aws/credentials)"

if [[ "${ASSUME_YES}" == false ]]; then
  [[ -t 0 ]] || die "sin terminal interactiva: usa --yes para confirmar"
  echo "Se va a DESTRUIR el ambiente FrioMx (EC2, DynamoDB, S3, SQS, Lambdas, alarmas)." >&2
  [[ "${KEEP_STATE}" == false ]] && echo "También se borra el bucket de estado ${STATE_BUCKET}." >&2
  read -r -p "Escribe 'destruir' para continuar: " answer
  [[ "${answer}" == "destruir" ]] || die "cancelado"
fi

# Borra todas las versiones y marcas de borrado de un bucket. --no-paginate trae una sola página
# de la API (máximo 1000 llaves entre versiones y marcas), el límite de delete-objects.
empty_bucket() {
  local bucket="$1" region="$2" batch count errors
  if ! aws s3api head-bucket --bucket "${bucket}" --region "${region}" >/dev/null 2>&1; then
    log "El bucket ${bucket} no existe, se omite"
    return 0
  fi
  log "Vaciando s3://${bucket} (todas las versiones)"
  while :; do
    batch="$(aws s3api list-object-versions --bucket "${bucket}" --region "${region}" --no-paginate \
      --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}}' --output json)"
    count="$(node -e 'const o=JSON.parse(process.argv[1]);process.stdout.write(String((o.Objects||[]).length))' "${batch}")"
    ((count > 0)) || break
    batch="$(node -e 'const o=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({Objects:o.Objects,Quiet:true}))' "${batch}")"
    # shellcheck disable=SC2016  # las comillas invertidas son JMESPath, no shell
    errors="$(aws s3api delete-objects --bucket "${bucket}" --region "${region}" --delete "${batch}" \
      --query 'length(Errors || `[]`)' --output text)"
    # Con Quiet la API responde 200 aunque fallen llaves; sin este corte el ciclo no terminaría.
    [[ "${errors}" == "0" ]] || die "no se pudieron borrar ${errors} objeto(s) de s3://${bucket} (¿permisos?)"
    log "  ${count} objeto(s) borrados"
  done
}

log "terraform init"
terraform -chdir="${TF_DIR}" init -input=false -reconfigure -backend-config=backend.hcl >&2

tf_out() { terraform -chdir="${TF_DIR}" output -raw "$1" 2>/dev/null || true; }
REGION="$(tf_out aws_region)"
REGION="${REGION:-${STATE_REGION}}"
for out in uploads_bucket artifacts_bucket; do
  b="$(tf_out "${out}")"
  if [[ -n "${b}" ]]; then
    [[ "${b}" =~ ^[a-z0-9.-]+$ ]] || die "nombre de bucket inesperado: '${b}'"
    empty_bucket "${b}" "${REGION}"
  else
    log "Sin salida ${out} en el estado (¿ya destruido?), se omite"
  fi
done

# archive_file lee lambdas/dist incluso al destruir: si no existe se arma.
if [[ ! -d "${ROOT}/lambdas/dist" ]]; then
  log "No existe lambdas/dist; armándolo para que el plan de destroy pueda evaluarse"
  bash "${ROOT}/lambdas/build.sh"
fi

log "terraform destroy"
terraform -chdir="${TF_DIR}" destroy -input=false -auto-approve -var-file=lab.tfvars >&2

if [[ "${KEEP_STATE}" == true ]]; then
  log "Listo. Se conservó el bucket de estado ${STATE_BUCKET}"
  exit 0
fi

empty_bucket "${STATE_BUCKET}" "${STATE_REGION}"
if aws s3api head-bucket --bucket "${STATE_BUCKET}" --region "${STATE_REGION}" >/dev/null 2>&1; then
  aws s3api delete-bucket --bucket "${STATE_BUCKET}" --region "${STATE_REGION}"
  log "Bucket de estado ${STATE_BUCKET} borrado"
fi
log "Listo. Para recrear: infra/bootstrap/bootstrap-state.sh y scripts/deploy.sh"
