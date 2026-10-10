#!/usr/bin/env bash
# Copia las credenciales temporales del Learner Lab a los secretos de GitHub (LLD §15).
# Correr al iniciar cada sesión del lab, después de pegar "AWS Details" en ~/.aws/credentials.
# Uso: scripts/update-gh-secrets.sh [--repo owner/repo] [--profile default]
# Los valores se pasan a gh por stdin: no aparecen en la línea de comandos ni en pantalla.
set -euo pipefail

PROFILE="default"
REPO_ARGS=()
CREDS_FILE="${AWS_SHARED_CREDENTIALS_FILE:-${HOME}/.aws/credentials}"

while (($#)); do
  case "$1" in
    --repo) REPO_ARGS=(--repo "${2:?falta owner/repo}"); shift ;;
    --profile) PROFILE="${2:?falta el perfil}"; shift ;;
    -h | --help) sed -n '2,5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v gh >/dev/null 2>&1 || { echo "Falta la CLI de GitHub (gh)" >&2; exit 1; }
[[ -f "${CREDS_FILE}" ]] || { echo "No existe ${CREDS_FILE}" >&2; exit 1; }

# Lee una llave del bloque [PROFILE] sin imprimirla.
read_key() {
  awk -v section="[${PROFILE}]" -v key="$1" '
    /^[[:space:]]*\[/ { gsub(/[[:space:]]/, ""); in_sec = ($0 == section); next }
    in_sec {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      split(line, kv, "=")
      k = kv[1]; gsub(/[[:space:]]/, "", k)
      if (tolower(k) == key) {
        v = substr(line, index(line, "=") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
        print v
        exit
      }
    }' "${CREDS_FILE}"
}

for pair in \
  "AWS_ACCESS_KEY_ID:aws_access_key_id" \
  "AWS_SECRET_ACCESS_KEY:aws_secret_access_key" \
  "AWS_SESSION_TOKEN:aws_session_token"; do
  name="${pair%%:*}"
  key="${pair#*:}"
  value="$(read_key "${key}")"
  [[ -n "${value}" ]] || { echo "No encontré ${key} en [${PROFILE}] de ${CREDS_FILE}" >&2; exit 1; }
  printf '%s' "${value}" | gh secret set "${name}" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"}
  echo "Secreto ${name} actualizado" >&2
done

echo "Listo. TF_BACKEND_HCL y TF_LAB_TFVARS se crean una sola vez:" >&2
echo "  gh secret set TF_BACKEND_HCL < infra/envs/lab/backend.hcl" >&2
echo "  gh secret set TF_LAB_TFVARS  < infra/envs/lab/lab.tfvars" >&2
