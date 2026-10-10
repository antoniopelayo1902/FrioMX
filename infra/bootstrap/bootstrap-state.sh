#!/usr/bin/env bash
# Crea (o deja como está) el bucket del estado de Terraform: friomx-tfstate-<cuenta>.
# Idempotente: se puede correr en cada sesión del lab sin romper nada.
# Uso: infra/bootstrap/bootstrap-state.sh [region]   (default us-east-1 o $AWS_REGION)
set -euo pipefail
export AWS_PAGER=""

REGION="${1:-${AWS_REGION:-us-east-1}}"

command -v aws >/dev/null 2>&1 || { echo "Falta la AWS CLI" >&2; exit 1; }

ACCOUNT_ID="$(aws sts get-caller-identity --region "${REGION}" --query Account --output text)"
BUCKET="friomx-tfstate-${ACCOUNT_ID}"

echo "Cuenta: ${ACCOUNT_ID}  Región: ${REGION}  Bucket: ${BUCKET}" >&2

if aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}" >/dev/null 2>&1; then
  echo "El bucket ya existe, solo se revisa su configuración." >&2
else
  echo "Creando bucket..." >&2
  if [[ "${REGION}" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "${BUCKET}" --region "${REGION}" >/dev/null
  else
    aws s3api create-bucket --bucket "${BUCKET}" --region "${REGION}" \
      --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
  fi
  aws s3api wait bucket-exists --bucket "${BUCKET}" --region "${REGION}"
fi

aws s3api put-public-access-block --bucket "${BUCKET}" --region "${REGION}" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

aws s3api put-bucket-versioning --bucket "${BUCKET}" --region "${REGION}" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption --bucket "${BUCKET}" --region "${REGION}" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'

echo "Listo. Guarda esto en infra/envs/lab/backend.hcl:" >&2
cat <<EOF
bucket       = "${BUCKET}"
key          = "lab/terraform.tfstate"
region       = "${REGION}"
use_lockfile = true
EOF
