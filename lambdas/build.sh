#!/usr/bin/env bash
# Arma lambdas/dist/<fn>/ con <fn>/index.js y shared/ (misma ruta relativa que en el repo),
# para que require("../shared/...") resuelva igual en el zip. Sin node_modules: el SDK v3 viene en el runtime.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="${ROOT}/dist"
FUNCTIONS=(recharge-worker daily-bonus weekly-ranking)

rm -rf "${DIST}"
mkdir -p "${DIST}"

for fn in "${FUNCTIONS[@]}"; do
    if [[ ! -f "${ROOT}/${fn}/index.js" ]]; then
        echo "Falta ${ROOT}/${fn}/index.js" >&2
        exit 1
    fi
    mkdir -p "${DIST}/${fn}/${fn}"
    cp "${ROOT}/${fn}/index.js" "${DIST}/${fn}/${fn}/index.js"
    cp -R "${ROOT}/shared" "${DIST}/${fn}/shared"
    echo "armado ${DIST}/${fn}"
done
