#!/usr/bin/env bash
# Revisa el monitoreo de FrioMx: métricas propias (namespace FrioMx), estado de las 2 alarmas y
# URL del dashboard.
#
# Uso: scripts/monitoring-check.sh [--demo-alarms] [--reset]
#   --demo-alarms  dispara las dos alarmas de verdad, sin tocar datos de jugadores:
#                  * friomx-recharge-dlq: manda 1 mensaje de prueba directo a la DLQ (nadie la
#                    consume, así que no se acredita nada). Pasa a ALARM en ~1-2 min si la DLQ
#                    tuvo actividad en las últimas 6 h; si no, SQS tarda hasta ~15 min en volver a
#                    publicar sus métricas (por eso el guion la calienta en la preparación).
#                  * friomx-api-5xx: publica Api5xx=5 en FrioMx con put-metric-data, la misma
#                    métrica sin dimensiones que emite el backend; la alarma la evalúa igual que
#                    a un error real (umbral 5 en 5 min). Pasa a ALARM en ~1-5 min.
#   --reset        purga la DLQ (vuelve a OK en ~1-2 min). Api5xx no se puede borrar: la alarma
#                  regresa sola a OK cuando el periodo de 5 min ya no tiene esos 5 errores.
#                  Ambas recuperaciones mandan correo (ok_actions).
# Requisitos: aws, terraform; infra/envs/lab/backend.hcl; credenciales del lab.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${ROOT}/infra/envs/lab"
DEMO=false
RESET=false
NAMESPACE="FrioMx"
METRICS=(GamesPlayed ApiLatency Api5xx RechargesCompleted RechargeFailed BonusGranted)
ALARMS=(friomx-api-5xx friomx-recharge-dlq)

usage() { sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --demo-alarms) DEMO=true ;;
    --reset) RESET=true ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log() { echo "==> $*" >&2; }
die() { echo "ERROR: $*" >&2; exit 1; }

[[ "${DEMO}" == true && "${RESET}" == true ]] && die "--demo-alarms y --reset no van juntos"
for bin in aws terraform; do
  command -v "${bin}" >/dev/null 2>&1 || die "falta '${bin}' en el PATH"
done
[[ -s "${TF_DIR}/backend.hcl" ]] || die "falta ${TF_DIR}/backend.hcl o está vacío"

export TF_IN_AUTOMATION=1
export AWS_PAGER=""

aws sts get-caller-identity --query Account --output text >/dev/null 2>&1 \
  || die "credenciales inválidas o vencidas: pega 'AWS Details' del lab en ~/.aws/credentials"

log "terraform init"
terraform -chdir="${TF_DIR}" init -input=false -reconfigure -backend-config=backend.hcl >/dev/null
tf_out() { terraform -chdir="${TF_DIR}" output -raw "$1"; }
REGION="$(tf_out aws_region)" || die "el estado no tiene salidas: ¿ya corriste scripts/deploy.sh?"
DLQ_URL="$(tf_out recharge_dlq_url)"
DASHBOARD_URL="$(tf_out dashboard_url 2>/dev/null || echo "https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#dashboards/dashboard/FrioMx")"
export AWS_REGION="${REGION}" AWS_DEFAULT_REGION="${REGION}"
[[ "${DLQ_URL}" =~ ^https://sqs\.[a-z0-9-]+\.amazonaws\.com/[0-9]+/[A-Za-z0-9_-]+$ ]] || die "recharge_dlq_url inesperada: '${DLQ_URL}'"

if [[ "${DEMO}" == true ]]; then
  log "Mandando 1 mensaje de prueba a la DLQ"
  aws sqs send-message --queue-url "${DLQ_URL}" \
    --message-body '{"rechargeId":"demo-alarma","note":"mensaje de prueba de monitoring-check.sh --demo-alarms"}' \
    --query MessageId --output text >/dev/null
  log "Publicando Api5xx=5 en ${NAMESPACE}"
  aws cloudwatch put-metric-data --namespace "${NAMESPACE}" --metric-name Api5xx --unit Count --value 5
  log "Listo: las alarmas cambian a ALARM en 1-5 min y llega correo a friomx-ops-alerts. Regresa con --reset."
fi

if [[ "${RESET}" == true ]]; then
  log "Purgando la DLQ"
  if out="$(aws sqs purge-queue --queue-url "${DLQ_URL}" 2>&1)"; then
    log "DLQ purgada; friomx-recharge-dlq vuelve a OK en ~1-2 min"
  elif [[ "${out}" == *PurgeQueueInProgress* ]]; then
    log "Ya había una purga en curso (SQS permite una por minuto)"
  else
    die "purge-queue falló: ${out}"
  fi
  log "friomx-api-5xx regresa sola a OK cuando pasen ~5 min sin 5 errores"
fi

# --- Métricas propias ---
echo "--- Métricas propias (${NAMESPACE}) ---"
missing=0
for m in "${METRICS[@]}"; do
  n="$(aws cloudwatch list-metrics --namespace "${NAMESPACE}" --metric-name "${m}" \
    --query 'length(Metrics)' --output text)"
  if [[ "${n}" =~ ^[0-9]+$ ]] && ((n > 0)); then
    printf 'OK     %-20s (%s serie(s))\n' "${m}" "${n}"
  else
    printf 'FALTA  %-20s (aún sin datos: se crea con el primer evento)\n' "${m}"
    missing=$((missing + 1))
  fi
done

# --- Alarmas ---
echo "--- Alarmas ---"
alarms_txt="$(aws cloudwatch describe-alarms --alarm-names "${ALARMS[@]}" \
  --query 'MetricAlarms[].[AlarmName, StateValue, StateUpdatedTimestamp, StateReason]' --output text)"
found=0
while IFS=$'\t' read -r name state since reason; do
  [[ -n "${name}" ]] || continue
  found=$((found + 1))
  printf '%-22s %-17s desde %s\n    %s\n' "${name}" "${state}" "${since}" "${reason}"
done <<<"${alarms_txt}"
alarms_missing=$(( ${#ALARMS[@]} - found ))
dlq_depth="$(aws sqs get-queue-attributes --queue-url "${DLQ_URL}" \
  --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)"
echo "Mensajes en la DLQ ahora: ${dlq_depth}"

echo "--- Dashboard ---"
echo "${DASHBOARD_URL}"
((missing == 0)) || log "${missing} métrica(s) sin datos todavía (normal recién desplegado; corre scripts/smoke.sh para generarlas)"
if ((alarms_missing > 0)); then
  log "Faltan ${alarms_missing} alarma(s) de ${#ALARMS[@]}: corre scripts/deploy.sh"
  exit 1
fi
