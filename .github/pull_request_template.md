## Qué cambia

<!-- 1-3 líneas: qué hace este PR y por qué. -->

## Flujo y rol

- [ ] Flujo 1: cuentas, juegos e historial (Backend flujo 1 + Frontend)
- [ ] Flujo 2: recargas con SQS (Backend flujo 2 + CI/CD)
- [ ] Flujo 3: bono diario y ranking semanal (Backend flujo 3 + Monitoreo)
- [ ] Infra / scripts / documentación

## Cómo se probó

- [ ] `cd backend && npm test` (con DynamoDB Local)
- [ ] `cd lambdas && npm test`
- [ ] `terraform fmt -check -recursive` en `infra/`
- [ ] `scripts/smoke.sh` contra el lab (si toca la nube)
- [ ] Otro:

<!-- Pega la salida relevante o capturas si cambia la interfaz. -->
