#!/usr/bin/env bash
# Prueba de punta a punta de los 3 flujos de FrioMx contra la nube. Imprime PASS/FAIL por paso
# y sale distinto de 0 si alguno falla.
#   Flujo 1: salud, registro, login, ruleta (apuesta 10 a "par"), historial.
#   Flujo 2: recarga p500 -> espera COMPLETED (SQS + recharge-worker) -> saldo +500.
#   Flujo 3: invoca friomx-daily-bonus (saldo +100 del jugador de prueba) y
#            friomx-weekly-ranking (cierra la semana anterior; se verifica con /api/leaderboard/last).
#
# Uso: scripts/smoke.sh [--url http://IP]
#   --url  base de la app (default: http://$(terraform output -raw public_ip)).
# Requisitos: node >= 18, aws, terraform (para salidas); credenciales del lab para el flujo 3.
# Variables opcionales: RECHARGE_WAIT (s, default 120).
# Efectos reales: crea un jugador smoke-<fecha>@friomx.test (no se borra), gasta 1 de sus 3
# recargas del día y el bono diario se acredita también a los jugadores activos que aún no lo
# tenían hoy (lo mismo que haría el cron de las 08:00).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${ROOT}/infra/envs/lab"
BASE_URL=""
RECHARGE_WAIT="${RECHARGE_WAIT:-120}"

usage() { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --url)
      [[ $# -ge 2 ]] || { echo "falta la URL después de --url" >&2; exit 2; }
      BASE_URL="$2"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log() { echo "==> $*" >&2; }
die() { echo "ERROR: $*" >&2; exit 1; }

[[ "${RECHARGE_WAIT}" =~ ^[0-9]+$ ]] || die "RECHARGE_WAIT debe ser un número de segundos"
command -v node >/dev/null 2>&1 || die "falta 'node' en el PATH"
node -e 'process.exit(typeof fetch === "function" ? 0 : 1)' || die "se necesita node >= 18 (fetch)"

export AWS_PAGER=""
export TF_IN_AUTOMATION=1

TF_READY=""
# Lee una salida de Terraform; inicializa el backend la primera vez si hace falta.
tf_out() {
  if [[ -z "${TF_READY}" ]]; then
    TF_READY=no
    command -v terraform >/dev/null 2>&1 || return 1
    if ! terraform -chdir="${TF_DIR}" output -raw aws_region >/dev/null 2>&1; then
      [[ -s "${TF_DIR}/backend.hcl" ]] || return 1
      terraform -chdir="${TF_DIR}" init -input=false -reconfigure -backend-config=backend.hcl >/dev/null 2>&1 || return 1
    fi
    TF_READY=yes
  fi
  [[ "${TF_READY}" == yes ]] || return 1
  terraform -chdir="${TF_DIR}" output "$@" 2>/dev/null
}

if [[ -z "${BASE_URL}" ]]; then
  ip="$(tf_out -raw public_ip)" || die "no pude leer public_ip de Terraform; pasa --url http://IP"
  BASE_URL="http://${ip}"
fi
BASE_URL="${BASE_URL%/}"
[[ "${BASE_URL}" =~ ^https?://[A-Za-z0-9.:-]+$ ]] || die "--url debe ser http(s)://host[:puerto] sin ruta (recibí '${BASE_URL}')"
log "Probando ${BASE_URL}"

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf 'PASS  %s\n' "$*"; }
fail() { FAILED=$((FAILED + 1)); printf 'FAIL  %s\n' "$*"; }
skip() { FAILED=$((FAILED + 1)); printf 'FAIL  %s (se omitió: falló un paso previo)\n' "$*"; }

# api MÉTODO RUTA [JSON] [TOKEN] [IDEMPOTENCY_KEY] -> una línea JSON {"s":status,"b":cuerpo}
api() {
  # shellcheck disable=SC2016  # código JS, no shell
  node -e '
    const [method, url, body, token, idem] = process.argv.slice(1);
    const headers = { Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    if (idem) headers["Idempotency-Key"] = idem;
    fetch(url, { method, headers, body: body || undefined, signal: AbortSignal.timeout(10000) })
      .then(async (r) => {
        const text = await r.text();
        let b; try { b = JSON.parse(text); } catch { b = text.slice(0, 300); }
        process.stdout.write(JSON.stringify({ s: r.status, b }));
      })
      .catch((e) => process.stdout.write(JSON.stringify({ s: 0, b: String(e.message || e) })));
  ' "$1" "${BASE_URL}$2" "${3:-}" "${4:-}" "${5:-}"
}

# jx JSON EXPRESIÓN -> evalúa la expresión con r = JSON (vacío si es undefined/null).
jx() {
  # shellcheck disable=SC2016  # código JS, no shell
  node -e '
    const r = JSON.parse(process.argv[1]);
    let v; try { v = Function("r", `return (${process.argv[2]});`)(r); } catch { v = undefined; }
    if (v !== undefined && v !== null) process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
  ' "$1" "$2"
}

short() { node -e 'process.stdout.write(process.argv[1].slice(0, 200))' "$1"; }
uuid4() { node -e 'process.stdout.write(require("crypto").randomUUID())'; }

balance_of() {
  local r
  r="$(api GET /api/user/balance "" "$1")"
  [[ "$(jx "${r}" r.s)" == 200 ]] && jx "${r}" r.b.balance
}

TOKEN=""
STAMP="$(date -u +%Y%m%d%H%M%S)-$$"
EMAIL="smoke-${STAMP}@friomx.test"
PASSWORD="Smoke-$(uuid4)"

# ================= Flujo 1 =================
echo "--- Flujo 1: cuenta, juego e historial ---"
r="$(api GET /api/health)"
if [[ "$(jx "${r}" r.s)" == 200 ]]; then pass "salud /api/health"; else fail "salud /api/health -> $(short "${r}")"; fi

r="$(api POST /api/auth/register "{\"name\":\"Smoke ${STAMP:0:14}\",\"age\":25,\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")"
if [[ "$(jx "${r}" r.s)" == 201 && -n "$(jx "${r}" r.b.token)" ]]; then
  pass "registro ${EMAIL} (saldo inicial $(jx "${r}" r.b.user.balance))"
else
  fail "registro -> $(short "${r}")"
fi

r="$(api POST /api/auth/login "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")"
TOKEN="$(jx "${r}" r.b.token)"
if [[ "$(jx "${r}" r.s)" == 200 && -n "${TOKEN}" ]]; then pass "login"; else TOKEN=""; fail "login -> $(short "${r}")"; fi

if [[ -n "${TOKEN}" ]]; then
  before="$(balance_of "${TOKEN}" || true)"
  r="$(api POST /api/games/roulette '{"bets":[{"type":"parity","value":"par","amount":10}]}' "${TOKEN}")"
  change="$(jx "${r}" r.b.totalAmountChange)"
  after="$(jx "${r}" r.b.newBalance)"
  if [[ "$(jx "${r}" r.s)" == 200 && -n "${before}" && -n "${change}" && "${after}" == "$((before + change))" ]]; then
    pass "ruleta: cayó $(jx "${r}" 'r.b.winningSlot && r.b.winningSlot.label'), cambio ${change}, saldo ${before} -> ${after}"
  else
    fail "ruleta (saldo antes '${before}') -> $(short "${r}")"
  fi

  r="$(api GET '/api/user/activity?limit=5' "" "${TOKEN}")"
  if [[ "$(jx "${r}" r.s)" == 200 && "$(jx "${r}" 'r.b.items[0] && r.b.items[0].nameGame')" == "Ruleta" ]]; then
    pass "historial: la última partida es Ruleta ($(jx "${r}" 'r.b.items[0].result'))"
  else
    fail "historial -> $(short "${r}")"
  fi
else
  skip "ruleta"; skip "historial"
fi

# ================= Flujo 2 =================
echo "--- Flujo 2: recarga asíncrona (SQS -> recharge-worker) ---"
if [[ -n "${TOKEN}" ]]; then
  before="$(balance_of "${TOKEN}" || true)"
  r="$(api POST /api/wallet/recharges '{"packageId":"p500"}' "${TOKEN}" "$(uuid4)")"
  RID="$(jx "${r}" r.b.rechargeId)"
  if [[ "$(jx "${r}" r.s)" == 202 && -n "${RID}" ]]; then
    pass "recarga p500 aceptada (202, ${RID})"
    status="PENDING"
    deadline=$((SECONDS + RECHARGE_WAIT))
    while [[ "${status}" == "PENDING" ]] && ((SECONDS < deadline)); do
      sleep 3
      status="$(jx "$(api GET "/api/wallet/recharges/${RID}" "" "${TOKEN}")" r.b.status)"
      status="${status:-PENDING}"
    done
    if [[ "${status}" == "COMPLETED" ]]; then pass "recarga COMPLETED"; else fail "recarga quedó en ${status} tras ${RECHARGE_WAIT}s (revisa la cola y la DLQ)"; fi
    after="$(balance_of "${TOKEN}" || true)"
    if [[ -n "${before}" && "${after}" == "$((before + 500))" ]]; then
      pass "saldo +500 (${before} -> ${after})"
    else
      fail "saldo esperado $((${before:-0} + 500)), obtenido '${after}'"
    fi
  else
    fail "recarga p500 -> $(short "${r}")"; skip "recarga COMPLETED"; skip "saldo +500"
  fi
else
  skip "recarga p500"; skip "recarga COMPLETED"; skip "saldo +500"
fi

# ================= Flujo 3 =================
echo "--- Flujo 3: Lambdas programadas (invocación manual) ---"
REGION="$(tf_out -raw aws_region || true)"
REGION="${REGION:-${AWS_REGION:-us-east-1}}"
FN_JSON="$(tf_out -json function_names || true)"
fn_name() {
  local n=""
  [[ -n "${FN_JSON}" ]] && n="$(jx "${FN_JSON}" "r[\"$1\"]")"
  echo "${n:-friomx-$1}"
}
BONUS_FN="$(fn_name daily-bonus)"
RANK_FN="$(fn_name weekly-ranking)"
[[ -n "${FN_JSON}" ]] || log "Sin salida function_names de Terraform; uso los nombres por defecto (friomx-*)"

OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/friomx-smoke.XXXXXX")"
# shellcheck disable=SC2329  # se invoca vía trap
cleanup() { rm -rf "${OUT_DIR}"; }
trap cleanup EXIT

# invoke NOMBRE -> imprime el payload de respuesta; falla si hubo FunctionError.
invoke() {
  local meta
  meta="$(aws lambda invoke --region "${REGION}" --function-name "$1" \
    --cli-binary-format raw-in-base64-out --payload '{}' \
    --query '{status: StatusCode, error: FunctionError}' --output json "${OUT_DIR}/$1.json" 2>&1)" \
    || { echo "aws lambda invoke falló: ${meta}"; return 1; }
  if [[ -n "$(jx "${meta}" r.error)" ]]; then
    echo "FunctionError $(jx "${meta}" r.error): $(head -c 300 "${OUT_DIR}/$1.json")"
    return 1
  fi
  cat "${OUT_DIR}/$1.json"
}

if ! command -v aws >/dev/null 2>&1 || ! aws sts get-caller-identity --region "${REGION}" >/dev/null 2>&1; then
  fail "flujo 3: no hay AWS CLI o credenciales válidas del lab (aws sts get-caller-identity)"
  skip "cierre de ranking"
elif [[ -z "${TOKEN}" ]]; then
  skip "bono diario"; skip "cierre de ranking"
else
  # El bono exige lastPlayedAt en los últimos 7 días (la ruleta de arriba lo fija) y que el
  # jugador no lo haya recibido hoy (es nuevo). Así el efecto esperado es exacto: +100.
  before="$(balance_of "${TOKEN}" || true)"
  if out="$(invoke "${BONUS_FN}")"; then
    after="$(balance_of "${TOKEN}" || true)"
    if [[ -n "${before}" && "${after}" == "$((before + 100))" ]]; then
      pass "bono diario ${BONUS_FN}: jugador de prueba +100 (${before} -> ${after}); total otorgados $(jx "${out}" r.granted), ya tenían $(jx "${out}" r.skipped)"
    else
      fail "bono diario: saldo esperado $((${before:-0} + 100)), obtenido '${after}' (respuesta ${out})"
    fi
  else
    fail "bono diario ${BONUS_FN}: ${out}"
  fi

  # El cierre trabaja sobre la semana ANTERIOR: el jugador de prueba (jugó esta semana) no puede
  # aparecer en el top. Se verifica que la semana quede cerrada y que la API la sirva.
  if out="$(invoke "${RANK_FN}")"; then
    week="$(jx "${out}" r.weekId)"
    st="$(jx "${out}" r.status)"
    r="$(api GET "/api/leaderboard/last?weekId=${week}" "" "${TOKEN}")"
    if [[ "${st}" =~ ^(CLOSED|ALREADY_CLOSED)$ && "$(jx "${r}" r.s)" == 200 && "$(jx "${r}" r.b.weekId)" == "${week}" ]]; then
      if [[ "${st}" == CLOSED ]]; then
        pass "cierre de ranking ${RANK_FN}: semana ${week} cerrada ahora, $(jx "${r}" r.b.top.length) ganador(es) pagados"
      else
        pass "cierre de ranking ${RANK_FN}: semana ${week} ya estaba cerrada (idempotente, no se pagó dos veces); top de $(jx "${r}" r.b.top.length)"
      fi
    else
      fail "cierre de ranking: lambda ${out}; /api/leaderboard/last -> $(short "${r}")"
    fi
  else
    fail "cierre de ranking ${RANK_FN}: ${out}"
  fi
fi

echo "--- Resultado: ${PASSED} PASS, ${FAILED} FAIL ---"
((FAILED == 0))
