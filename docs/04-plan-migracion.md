# FrioMx -- Plan de migración

Versión 1.0, 8 de octubre de 2026. Cómo llevar la aplicación base a la arquitectura de `02-HLD.md` y `03-LLD.md`, en qué orden y quién lo hace.

## 1. Punto de partida

| Pieza de la base | Estado | Destino |
|---|---|---|
| Frontend (`frontend/`, 14 páginas, 3 juegos) | Funciona en local | Se reutiliza con los cambios de LLD §17 |
| Backend Express (`backend/`) | Funciona en local con MongoDB | Se reutiliza la estructura de rutas y controladores. Se reescribe la capa de datos |
| Modelos Mongoose (`models/User.js`, `models/Activity.js`, `config/database.js`) | Atados a MongoDB | Se reemplazan por repositorios de DynamoDB |
| Lógica de juegos (`controllers/gameController.js`) | Mezclada con acceso a datos, usa `Math.random` | Se extrae a `services/gameEngine.js` con `crypto.randomInt` |
| Hi-lo | La carta que ve el jugador sale de un mazo del navegador y no es la que compara el servidor | El servidor cobra la apuesta y reparte la carta visible (`/games/hi-lo/deal`). Los pagos se rehacen porque en la base el valor esperado es positivo para el jugador (LLD §5.1) |
| Minas | El navegador decide si ganó | Fase 2: se pasa a DynamoDB con el usuario del token. Etapa 5: se reescribe del lado del servidor |
| Pagos con Stripe (`paymentController.js`, cliente en `balance.js`) | Fuera de alcance (dinero real) | Se elimina y se sustituye por el flujo 2 |
| Rutas `/assets/*` | Declaradas pero sin uso en el frontend | Se eliminan |
| Pruebas | No hay (`npm test` termina con error) | Se crean con Jest |

La infraestructura de AWS, el CI/CD y el monitoreo se construyen durante el semestre (§2).

### 1.1 Brechas de seguridad de la base que se corrigen en la migración

1. `PUT /user/balance` suma cualquier monto al saldo de cualquier id. Se elimina.
2. Juegos, perfil, saldo e historial usan el `userId` o `?id=` que manda el navegador, no el del token. Cualquiera puede jugar o leer con la cuenta de otro. Se toma siempre del token.
3. `POST /games/mines` recibe `won` del navegador. Se reescribe en el servidor en Etapa 5 y hasta entonces se documenta como brecha conocida.
4. El saldo se lee, se suma en memoria y se guarda. Dos jugadas simultáneas pierden una actualización. Se cambia a escrituras condicionales en transacción.
5. CORS abierto a cualquier origen. Se elimina al servir todo desde el mismo origen.
6. `POST /user/activity` deja al navegador inventar historial. Se elimina. El historial solo lo escribe el servidor.
7. En hi-lo el jugador apuesta contra una carta que no es la que compara el servidor. Se corrige con el reparto en el servidor.

## 2. Estrategia

- **Sin migración de datos.** La base no tiene datos que conservar. DynamoDB arranca vacía y `scripts/seed.js` crea jugadores y partidas de prueba.
- **Qué se importa.** Del proyecto previo se importa la aplicación: `frontend/` y `backend/`. La infraestructura, las funciones Lambda, los scripts de despliegue y los pipelines se escriben durante el semestre en este repositorio según el LLD.
- **Cada quien importa y adapta su parte** (sin el historial de git del proyecto previo) en su propia rama y pull request, así el historial refleja el trabajo de los tres.
- **Primero lo que da el 80% de Fase 2.** Minas en el servidor, página de ranking, CD completo y monitoreo van después del 15 de octubre, igual que marca la materia (el monitoreo se instrumenta entre el 12 de noviembre y la Fase 3).
- **Desarrollo local contra AWS.** No se emula AWS en local. Cada quien aplica el mismo Terraform en su propio Learner Lab como entorno personal (su propio bucket de estado), corre el backend en su máquina con las credenciales de su lab y apunta a sus tablas. El frontend local reenvía `/api` al backend local con `API_PROXY_TARGET` (LLD §17), porque en local no hay nginx. Esto además prueba que el repositorio se puede reproducir desde cero. Las pruebas unitarias usan AWS simulado y no necesitan cuenta.

## 3. Cuenta y accesos

- Cuenta compartida: Learner Lab de Antonio (rol CI/CD). Ahí viven el estado de Terraform del entorno compartido, el pipeline, la demo y las entregas. Los labs de Emilio y Alan son solo entornos de desarrollo (§2).
- Hasta que el CD esté listo (tarea 5.3), Antonio despliega lo fusionado a `main` con `scripts/deploy.sh` desde su máquina. Desde la 5.3 el merge a `main` despliega solo y nadie más necesita entrar a la cuenta.
- Al iniciar cada sesión de trabajo, Antonio arranca el lab y corre `scripts/update-gh-secrets.sh` (existe desde la tarea 0.7). Si un merge llega con la sesión vencida, el CD falla y se vuelve a lanzar con "Re-run jobs" al renovar.

## 4. Cronograma

Hoy es jueves 8 de octubre. Fase 2 se entrega el jueves 15 de octubre. Quedan 7 días.

### Etapa 0. Preparación (jue 8 – vie 9 oct)

| # | Tarea | Responsable | Hecho cuando |
|---|---|---|---|
| 0.1 | Agregar a Emilio y Alan como colaboradores y aceptar invitación | Antonio | Los tres aparecen en Collaborators |
| 0.2 | Protección de `main` (PR obligatorio, 1 aprobación) | Antonio | Un push directo a `main` es rechazado |
| 0.3 | `infra/bootstrap/bootstrap-state.sh`, bucket de estado y esqueleto de `infra/envs/lab/` (`main.tf` con `backend "s3" {}` y el proveedor, `variables.tf`, `outputs.tf` y los `.example`) | Antonio | `terraform init` con backend S3 funciona y `terraform validate` pasa |
| 0.4 | Importar `frontend/` sin cambios funcionales | Emilio | PR fusionado, `npm start` sirve las páginas en local |
| 0.5 | Importar `backend/`, quitar Stripe del `package.json` y borrar las rutas y controladores de pagos y de `/assets/*` (`paymentController.js`, `assetsController.js` y sus rutas). Crear `middleware/errors.js` con el formato `{error, code}` y las reglas de LLD §3 (multer, `express.json`), y que el `fileFilter` de fotos lance su error con `status = 400`, y mover `routes/`, `controllers/`, `middleware/`, `services/`, `models/` y `config/` a `backend/src/` con `git mv`, ajustando los `require`, para que todo el código quede bajo `src/` (estructura de LLD §1 y cobertura sobre `src/**`). Crear `src/app.js`, `/api/health` y su prueba con `supertest`. Mongoose se queda en el código hasta que lo reemplacen los repositorios (2.2, 2.4 y 2.6) y se quite en la 2.9, pero `src/app.js` ya no llama a `config/database.js`, así que no se intenta conectar a MongoDB (en Node 22 una promesa rechazada sin manejar tumba el proceso) | Antonio | PR fusionado, `GET /api/health` responde en local sin MongoDB y `npm test` pasa |
| 0.6 | Esqueleto `lambdas/` con `shared/time.js` y sus pruebas | Alan | `npm test` en `lambdas/` pasa |
| 0.7 | `ci.yml` con los 3 jobs (umbral de cobertura 0%) y `scripts/update-gh-secrets.sh` | Antonio | Un PR muestra los 3 checks en verde y quedan como obligatorios en la protección de `main`. El script actualiza los 3 secretos |

### Etapa 1. Infraestructura base (vie 9 – sáb 10 oct)

| # | Tarea | Responsable | Hecho cuando |
|---|---|---|---|
| 1.1 | Módulos `data`, `storage`, `secrets` | Antonio | `terraform apply` crea 7 tablas, 2 buckets y el secreto |
| 1.2 | Módulos `network` y `compute` con `user_data` y nginx | Antonio | nginx responde en `http://<ip-elástica>/` (502 esperado mientras no hay aplicación) y la instancia aparece como administrada en Fleet Manager de SSM |
| 1.3 | Módulo `messaging` (cola, DLQ, 2 temas) | Antonio | Cola con redrive visible en la consola |
| 1.4 | `lambdas/build.sh` y módulo `functions` con las 3 Lambdas en versión mínima y las 2 reglas | Alan | Las reglas aparecen habilitadas, `aws lambda invoke` responde, y al cambiar un `index.js` y volver a aplicar, `aws lambda get-function` muestra otro `CodeSha256` |
| 1.5 | `scripts/deploy.sh` (build de Lambdas, `terraform apply`, empaquetado, subida a S3 y `send-command`) y `scripts/deploy-on-instance.sh` | Antonio | Con un solo comando, `/api/health` y las páginas estáticas responden en la IP elástica |

### Etapa 2. Capa de datos y flujo 1 (sáb 10 – lun 12 oct)

Durante la Etapa 2 la forma de las respuestas cambia por partes (usuarios con id de DynamoDB en 2.2, rondas de hi-lo en 2.4, frontend en 2.5), así que entre esas fusiones el historial, los juegos y el perfil pueden quedar rotos en `main`. Por eso el entorno compartido no se despliega desde que se fusiona la 2.2 hasta que estén fusionadas 2.2, 2.4, 2.5, 2.6 y 2.9. Mientras tanto cada quien prueba en su propio lab.

| # | Tarea | Responsable | Hecho cuando |
|---|---|---|---|
| 2.1 | `config/env.js`, `config/secrets.js`, `middleware/auth.js` con usuario solo del token | Antonio | Ruta protegida sin token da 401 |
| 2.2 | Repositorios users y user-emails. Registro, login, perfil, cambio de correo, `GET /auth/user-name`, `GET /user/balance` y `GET /user/activity` (paginado con cursor validado, LLD §4.2), todo con el usuario del token | Emilio | Registro duplicado da 409. Login funciona en la nube. El historial responde `{items, nextCursor}` y un cursor ajeno da 400 |
| 2.3 | `gameEngine.js` (hi-lo y ruleta) con pruebas | Emilio | Pruebas de pagos pasan, incluida la apuesta a Verde |
| 2.4 | `gameService.js` con reparto de hi-lo, transacción de jugada, historial y weekly-stats, y `POST /games/mines` temporal | Emilio | Una jugada de cada juego actualiza saldo, historial y weekly-stats. Saldo insuficiente da 409. Una ronda de hi-lo no se juega dos veces |
| 2.5 | Frontend según LLD §17 para Fase 2 (todas las filas de §17 salvo las que el LLD marca como Etapa 5, `balance.js`/`balance.html` que van en 3.4, y `leaderboard` que va en 5.2). Incluye: quitar `?id=` y `userId`, `BASE_URL="/api"`, manejo de 401, hi-lo con reparto en `hi-lo.html` y `hi-lo.js`, botones "Mayor"/"Menor" y `rules.html`, `register.js` (edad numérica, contraseña de 8 caracteres y 72 bytes, errores, mensaje de correo), `profile.js` (no mostrar contraseña; la validación de la foto en el navegador va en la 2.6), 401 solo en rutas con candado, minas temporal en `mine.js`, historial con `items`, "ver más" y fichas en `activity.js`, apuestas enteras, quitar `env-config.sh` y `<script src="env.js">`, proxy de desarrollo `API_PROXY_TARGET` en `server.js` | Emilio | Todas las páginas salvo saldo funcionan en la IP elástica y en local con el proxy. La página de saldo queda para la 3.4 |
| 2.6 | Fotos de perfil a S3 privado con URL firmada (backend y validación de 5 MB e imagen en `profile.js`) | Emilio | Subir, ver y borrar foto funciona. Un archivo que no sea imagen o de 5 a 6 MB da 400, uno de más de 6 MB lo frena nginx (413) y el navegador avisa antes de subir |
| 2.7 | Eliminar `PUT /user/balance`, `POST /user/activity` y CORS | Antonio | Las rutas responden 404 y las respuestas ya no traen `Access-Control-Allow-Origin` |
| 2.8 | `scripts/seed.js --week <YYYY-Www> [--include-email <correo>]` | Alan | `--week` es obligatorio. Crea 10 jugadores con partidas en la semana en curso y en la semana indicada, con al menos 3 jugadores con ganancia positiva en la semana indicada. La semana indicada debe ser pasada y no estar cerrada: si ya existe en `friomx-leaderboard`, el script termina con error sin escribir nada. Con `--include-email`, mete en el primer lugar de esa semana a una cuenta real ya registrada (con suscripción confirmada), así la demo muestra el correo y el premio en su saldo |
| 2.9 | Quitar Mongoose, `config/database.js` y `models/` del backend | Antonio | No queda ningún `require` de Mongoose y `npm test` pasa. Se hace después de 2.2, 2.4 y 2.6, que reemplazan a todos los controladores que usan los modelos |

### Etapa 3. Flujos 2 y 3 (lun 12 – mar 13 oct)

| # | Tarea | Responsable | Hecho cuando |
|---|---|---|---|
| 3.1 | `walletService.js` y rutas `/wallet/*` con idempotencia y límite diario | Antonio | La 4.ª recarga del día da 429. Repetir la clave no cobra cupo |
| 3.2 | `recharge-worker` completo con pruebas | Antonio | La recarga pasa a COMPLETED y el saldo sube una sola vez |
| 3.3 | Suscripción SNS en registro y en cambio de correo (alta de la nueva e intento de `Unsubscribe` de la anterior, sin fallar la petición si SNS lo rechaza), y correo de recarga | Antonio | Llega el correo tras confirmar la suscripción |
| 3.4 | `balance.js` y `balance.html` con paquetes y consulta de estado, y quitar las constantes de pagos de `config.js` | Emilio | Se ve "completada" y el saldo nuevo sin recargar la página. Una recarga atorada se ve como fallida |
| 3.5 | `daily-bonus` y `weekly-ranking` completos con pruebas | Alan | Invocarlas dos veces no duplica fichas ni premios |
| 3.6 | Rutas `/leaderboard/current`, `/leaderboard/last` y `/leaderboard/weeks` | Alan | Responden con datos del seed |
| 3.7 | Subir el umbral de cobertura del CI a 30 | Antonio | El CI exige 30% y los 3 checks siguen en verde |

### Etapa 4. Entregable de Fase 2 (mié 14 – jue 15 oct)

| # | Tarea | Responsable | Hecho cuando |
|---|---|---|---|
| 4.1 | README con pasos de despliegue desde cero (bootstrap y `deploy.sh`) y estado real del proyecto | Antonio | Alguien sigue el README y llega a la IP con la app. El README dice qué falta, incluida minas en el servidor |
| 4.2 | Prueba de humo completa en la nube (lista en §6) | Los tres | Todos los puntos en verde |
| 4.3 | Video de máximo 10 minutos | Los tres | Abre con lo trabajado desde Fase 1 (infraestructura en Terraform, capa de datos en DynamoDB, flujos 2 y 3, CI). Muestra los 3 flujos (el flujo 3 se demuestra invocando `friomx-daily-bonus` con el comando de §6 paso 8 y `friomx-weekly-ranking` con el de LLD §6.3, sobre una semana sembrada con `seed.js --include-email` de una cuenta del equipo, y enseñando el saldo acreditado en la app, la respuesta de `GET /api/leaderboard/last?weekId=` y el correo al ganador, porque la página de ranking llega en la 5.2), qué corre en la nube, qué corre en local (el despliegue con `deploy.sh` desde la máquina de Antonio y la decisión de minas en el navegador) y qué falta |
| 4.4 | Reporte PDF de 4 páginas | Los tres | Incluye link al repo y al video, resumen del avance desde Fase 1, cambios respecto al reporte de Fase 1 (servicios, flujos y roles, o decir que no hubo), problema y aplicación, los 3 flujos, servicios y su porqué, decisiones técnicas (HLD §10), diagrama, roles, qué corre en la nube y qué en local, y qué falta |

**Qué entra en el 80% de Fase 2:** frontend y backend en EC2, DynamoDB, S3, Secrets Manager, registro, login, perfil, foto, hi-lo con carta del servidor, ruleta, minas temporal, historial, flujo 2 completo, Lambdas del flujo 3 programadas, Terraform y script de despliegue de todo lo anterior, y CI en PR.

**Qué se declara pendiente en el video:** minas del lado del servidor (en Fase 2 el resultado lo reporta el navegador y se dice explícitamente), página de ranking, CD automático, cobertura de 70%, límite de intentos en login y registro, cabeceras de seguridad, métricas, alarmas y dashboard.

### Etapa 5. Hacia el 12 de noviembre (16 oct – 11 nov)

| # | Tarea | Responsable | Hecho cuando |
|---|---|---|---|
| 5.1 | Minas en el servidor (LLD §5.3) y `mine.js`. Se elimina `POST /games/mines` | Emilio | Mandar `won:true` u otro dato falso no da fichas. La ruta temporal responde 404 |
| 5.2 | Página de ranking, con `goToLeaderboard()` en `indexLoading.js` y el botón en la barra de navegación de las páginas con sesión | Alan | `/leaderboard` muestra la semana en curso con la posición propia, la última semana cerrada y cualquier semana cerrada elegida en el selector |
| 5.3 | `cd.yml` completo con rollback y prueba de humo | Antonio | Un merge a `main` despliega solo. Un despliegue con `/api/health` roto regresa a la versión previa y deja el pipeline rojo |
| 5.4 | Pruebas hasta 70% de cobertura en backend y Lambdas, y subir el umbral del CI a 70 | Los tres, cada quien su área | El CI exige 70% y pasa |
| 5.5 | Documentación de la sesión del lab (arranque, renovación de secretos, apagado al terminar) | Antonio | Alguien del equipo sigue la guía sin ayuda y deja el CD en verde |
| 5.6 | Límite de intentos en login y registro, helmet en la API, límite de cuerpo, y mensaje de 429 en `login.js` | Antonio | El login fallido número 11 dentro de un minuto desde la misma IP da 429 en JSON y la página de login lo muestra, y un cuerpo de más de 10 KB da 413 en JSON |

### Etapa 6. Hacia la Fase 3 (12 – 29 nov)

| # | Tarea | Responsable | Hecho cuando |
|---|---|---|---|
| 6.1 | `metrics.js` y middleware de latencia y 5xx | Alan | `GamesPlayed`, `ApiLatency` y `Api5xx` aparecen en CloudWatch con datos |
| 6.2 | `infra/cloudwatch-agent.json` y su aplicación en `deploy-on-instance.sh` | Alan | Los logs llegan a `/friomx/backend` y `/friomx/frontend` |
| 6.3 | Módulo `monitoring`: 2 alarmas y dashboard | Alan | El dashboard `FrioMx` muestra las 5 métricas con datos y las 2 alarmas existen en estado OK |
| 6.4 | Provocar cada alarma en un ensayo (5xx forzado y mensaje a la DLQ) | Alan | Cada alarma pasa a ALARM y llega el correo al equipo |
| 6.5 | Guion de demo de 20 minutos y ensayo con cronómetro | Los tres | El ensayo cubre los 3 flujos, CI/CD y monitoreo en 20 minutos o menos, y cada integrante responde preguntas de las áreas de los otros |
| 6.6 | Reporte final de 5 páginas | Los tres | PDF de máximo 5 páginas con link al repo, problema y aplicación, 3 flujos, servicios y su porqué, CI/CD, monitoreo, decisiones técnicas, diagrama y roles |
| 6.7 | Prueba de carga con 30 usuarios simulados (k6) | Antonio | p95 de `ApiLatency` menor a 500 ms en el dashboard |

## 5. Orden de dependencias

```
0.3 -> 1.1 -> 1.2 -> 1.5 -> 2.x -> 4.2
0.3, 0.5, 0.6 -> 0.7 (los jobs del CI necesitan `infra/envs/lab/`, `backend/` y `lambdas/package.json`)
2.2, 2.4, 2.6, 2.7 -> 2.9 (Mongoose se quita cuando nadie lo usa; la 2.7 borra `updateBalance` y `createActivity`, que todavía usan los modelos)
2.5 -> 2.7 (quitar CORS antes de tener el proxy local dejaría sin poder probar el frontend en local)
1.1, 1.3 -> 1.4 (el módulo functions necesita los nombres de tabla, la cola y el tema SNS)
1.4 -> 1.5 (`deploy.sh` corre `lambdas/build.sh`)
       1.3 -> 3.1 -> 3.2 -> 3.4
       1.4 -> 3.5 -> 3.6 -> 5.2
2.1 bloquea 2.2, 2.4, 2.6, 3.1, 3.6
2.2 -> 2.6 (la foto se guarda en el repositorio de usuarios de DynamoDB)
2.2, 2.4, 2.6 -> 2.5 (el frontend deja de mandar `id` y `userId` solo cuando el backend ya los toma del token, y la foto de perfil depende de S3 en la 2.6)
2.4 bloquea 3.5 (weekly-stats debe tener datos)
2.4 -> 2.8 -> 3.6 (el seed usa los esquemas y alimenta el ranking)
5.3 bloquea demostrar CD en Fase 3
6.1 bloquea 6.3
```

## 6. Verificación

Prueba de humo en la nube, al cierre de cada etapa y antes de cada entrega. Cada paso se exige desde la etapa indicada entre corchetes:

1. [E1] `GET http://<ip>/api/health` responde 200.
2. [E2] Registrar un usuario nuevo. Saldo inicial 1000. [E3] Llega el correo de confirmación de SNS.
3. [E2] Login con contraseña incorrecta da error genérico. Login correcto entra.
4. [E2] Jugar hi-lo, ruleta y minas. El saldo cambia y la partida aparece en historial. En hi-lo la carta mostrada es la que se compara.
5. [E2] Apostar más que el saldo da "fondos insuficientes" y el saldo no cambia.
6. [E2] Llamar `GET /api/user/balance?id=<otro>` regresa el saldo propio, no el del otro. `PUT /api/user/balance` da 404.
7. [E3] Recargar 500 fichas desde `http://<ip>` (no desde `localhost`). Estado pasa a completada, saldo +500 y llega correo. Una 4.ª recarga en el día da límite diario.
8. [E3] `aws lambda invoke --function-name friomx-daily-bonus out.json`: los jugadores activos tienen el bono de hoy (de esta invocación o de la regla de las 08:00) y una segunda invocación no acredita de nuevo.
9. [E3] Elegir una semana pasada que no esté cerrada, correr `seed.js --week <esa semana>` y luego invocar `friomx-weekly-ranking` con esa semana (comando exacto en LLD §6.3): guarda el top 3 y acredita premios, y esa semana se ve en el selector de la página de ranking (desde Etapa 5). Una segunda invocación no cambia nada. Cada repetición usa una semana distinta.
10. [E1] Reiniciar la instancia: al volver, la app responde sola en la misma IP.

Desde Etapa 5 se agregan: minas no se puede ganar enviando datos falsos, un merge a `main` despliega solo, un despliegue roto regresa a la versión previa y el login fallido número 11 dentro de un minuto desde la misma IP da 429. En Etapa 6 se agrega que el dashboard `FrioMx` muestra las 5 métricas con datos y que cada alarma se dispara en el ensayo. En Etapa 6: la prueba de carga da p95 menor a 500 ms en el dashboard (RNF-04) y al terminar cada sesión se detiene la instancia (RNF-10).

## 7. Regresar a una versión anterior

- **Aplicación:** volver a lanzar el CD de un commit anterior, o en la instancia apuntar `/opt/friomx/current` a la versión previa y reiniciar los servicios.
- **Infraestructura:** `git revert` del cambio de Terraform y merge. El estado está versionado en S3.
- **Lambdas:** se redeployan con el mismo `terraform apply` del commit anterior.
- **Datos:** no hay datos de valor. Si una prueba los ensucia, se vacían las tablas y se corre el seed.

## 8. Riesgos del plan

| Riesgo | Señal temprana | Plan B |
|---|---|---|
| La capa de datos tarda más de lo previsto | 2.2 o 2.4 sin terminar el lunes 12 | Fase 2 muestra registro, login y una sola jugada (hi-lo). Ruleta pasa a la semana siguiente |
| SNS no entrega correos en el lab | No llega el correo de confirmación en 3.3 | El resultado observable del flujo 2 queda en la aplicación y se muestra el mensaje publicado en los logs de la Lambda |
| SSM no está disponible para la instancia | La instancia no aparece en Fleet Manager | Un servicio `systemd` que descarga la última versión de S3 en cada arranque, y el CD reinicia la instancia. Como el `user_data` solo corre al crear la instancia, el plan B necesita recrearla con `terraform apply -replace=<recurso de la instancia>` |
| Credenciales del lab vencidas en una entrega | CD rojo con `ExpiredToken` | Renovar con el script y relanzar. Se ensaya antes de cada entrega |
| Uno del equipo se atrasa | Su PR de la etapa no está abierto a mitad de la etapa | Se reparte en pareja. Los roles no aíslan |
