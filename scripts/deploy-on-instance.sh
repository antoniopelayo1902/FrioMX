#!/usr/bin/env bash
# Corre en la instancia EC2 (como root, vía SSM). LLD §14.
# Uso: deploy-on-instance.sh <dir_de_la_version> <s3_uri_del_env> <region>
# Los commands del send-command ya descargaron y descomprimieron el tgz en <dir_de_la_version>.
set -euo pipefail

RELEASE_DIR="${1:?falta el directorio de la versión}"
ENV_URI="${2:?falta la URI S3 del env}"
REGION="${3:?falta la región}"

RELEASES_ROOT=/opt/friomx/releases
CURRENT=/opt/friomx/current
ENV_FILE=/etc/friomx/backend.env
KEEP=3
HEALTH_URL=http://127.0.0.1/api/health
FRONT_URL=http://127.0.0.1/login
USER_DATA_LOG=/var/log/friomx-user-data.log
# Dirección real del recurso en infra/envs/lab (module "compute" -> aws_instance.web).
REPLACE_HINT="terraform -chdir=infra/envs/lab apply -var-file=lab.tfvars -replace=module.compute.aws_instance.web"

log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

[[ -d "${RELEASE_DIR}/backend" && -d "${RELEASE_DIR}/frontend" ]] || { log "Paquete incompleto en ${RELEASE_DIR}"; exit 1; }

# La primera vez el user_data puede seguir corriendo cuando SSM ya responde.
if command -v cloud-init >/dev/null 2>&1; then
  log "Esperando a que termine cloud-init..."
  cloud-init status --wait >/dev/null || log "cloud-init terminó con error; se verifica el user_data abajo"
fi

# user_data corre una sola vez (ignore_changes): si quedó a medias, la instancia no tiene arreglo.
user_data_broken() {
  log "El user_data de la instancia no terminó: $1"
  tail -n 30 "${USER_DATA_LOG}" 2>/dev/null || true
  log "La instancia no se puede reparar con otro deploy. Reemplázala y vuelve a desplegar:"
  log "  ${REPLACE_HINT}"
  exit 1
}
grep -qF "user_data de FrioMx terminado" "${USER_DATA_LOG}" 2>/dev/null || user_data_broken "falta la marca final en ${USER_DATA_LOG}"
id friomx >/dev/null 2>&1 || user_data_broken "no existe el usuario friomx"
for unit in friomx-backend.service friomx-frontend.service; do
  [[ -f "/etc/systemd/system/${unit}" ]] || user_data_broken "falta /etc/systemd/system/${unit}"
done
command -v node >/dev/null 2>&1 || user_data_broken "no hay node en la instancia"

# 1-2. Variables de entorno del backend (se respalda el actual para el rollback).
ENV_PREV="${ENV_FILE}.prev"
HAD_ENV=false
if [[ -f "${ENV_FILE}" ]]; then
  cp -p "${ENV_FILE}" "${ENV_PREV}"
  HAD_ENV=true
fi
log "Descargando env de ${ENV_URI}"
tmp_env="$(mktemp)"
aws s3 cp "${ENV_URI}" "${tmp_env}" --region "${REGION}" --only-show-errors
install -o friomx -g friomx -m 0600 "${tmp_env}" "${ENV_FILE}"
rm -f "${tmp_env}"

# Código de la versión: de root y solo lectura para friomx. touch para ordenar versiones por fecha.
chown -R root:root "${RELEASE_DIR}"
chmod -R u+rwX,go+rX,go-w "${RELEASE_DIR}"
touch "${RELEASE_DIR}"

# 3. Agente de CloudWatch.
if [[ -f "${RELEASE_DIR}/infra/cloudwatch-agent.json" ]] && [[ -x /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl ]]; then
  log "Aplicando configuración del agente de CloudWatch"
  /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 \
    -c "file:${RELEASE_DIR}/infra/cloudwatch-agent.json" -s \
    || log "No se pudo aplicar la configuración del agente (no bloquea el despliegue)"
fi

# 4. Cambio de enlace, guardando el previo.
PREVIOUS=""
if [[ -L "${CURRENT}" ]]; then
  PREVIOUS="$(readlink -f "${CURRENT}")"
fi
log "Versión previa: ${PREVIOUS:-<ninguna>}  nueva: ${RELEASE_DIR}"
ln -sfn "${RELEASE_DIR}" "${CURRENT}.new"
mv -Tf "${CURRENT}.new" "${CURRENT}"

restart() {
  systemctl daemon-reload
  systemctl restart friomx-backend friomx-frontend
}

healthy() {
  local i
  for i in $(seq 1 10); do
    if curl -fs -o /dev/null --max-time 3 "${HEALTH_URL}" && curl -fs -o /dev/null --max-time 3 "${FRONT_URL}"; then
      log "Salud OK backend y frontend (intento ${i})"
      return 0
    fi
    sleep 3
  done
  return 1
}

# 5-6. Reinicio y verificación.
restart
if ! healthy; then
  log "La versión nueva no respondió en ${HEALTH_URL} o ${FRONT_URL}"
  journalctl -u friomx-backend -n 30 --no-pager || true
  journalctl -u friomx-frontend -n 30 --no-pager || true
  tail -n 30 /var/log/friomx/backend.log || true
  tail -n 30 /var/log/friomx/frontend.log || true
  # 7. Rollback (código y backend.env previos).
  if [[ -n "${PREVIOUS}" && -d "${PREVIOUS}" && "${PREVIOUS}" != "${RELEASE_DIR}" ]]; then
    log "Regresando a ${PREVIOUS}"
    if [[ "${HAD_ENV}" == true && -f "${ENV_PREV}" ]]; then
      log "Restaurando ${ENV_FILE} anterior"
      cp -p "${ENV_PREV}" "${ENV_FILE}"
    fi
    ln -sfn "${PREVIOUS}" "${CURRENT}.new"
    mv -Tf "${CURRENT}.new" "${CURRENT}"
    restart
    healthy || log "La versión previa tampoco respondió"
  else
    log "No hay versión previa para regresar"
  fi
  exit 1
fi

# 8. Conservar las últimas KEEP versiones (más la actual y la previa).
keep_list="$(readlink -f "${CURRENT}")"
[[ -n "${PREVIOUS}" ]] && keep_list="${keep_list}"$'\n'"${PREVIOUS}"
count=0
while IFS= read -r dir; do
  [[ -z "${dir}" ]] && continue
  count=$((count + 1))
  if (( count <= KEEP )) || grep -qxF "${dir}" <<<"${keep_list}"; then
    continue
  fi
  log "Borrando versión vieja ${dir}"
  rm -rf -- "${dir}"
done < <(find "${RELEASES_ROOT}" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)

log "Despliegue terminado: ${RELEASE_DIR}"
