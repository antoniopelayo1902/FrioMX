# FrioMx -- Low Level Design (LLD)

Versión 1.0, 8 de octubre de 2026. Complementa `02-HLD.md`. Las referencias a archivos de la aplicación base son al código importado en el repositorio.

## 1. Estructura del repositorio

```
FrioMX/
  frontend/
    server.js               servidor Express: páginas, 404, cabeceras de seguridad y, solo en desarrollo, proxy de /api
    public/                 páginas HTML, assets/, styles/ y scripts/ (app.js, ui.js y un script por página)
    e2e/                    pruebas de punta a punta con Playwright (`npm run e2e`, configuración en playwright.config.js)
  backend/
    server.js               carga el secreto y arranca la API
    jest.config.js
    scripts/create-local-tables.js   crea las 7 tablas en DynamoDB Local
    src/
      app.js                arma Express (para pruebas sin listen)
      config/env.js         lee las variables de entorno (las de AWS son opcionales)
      config/secrets.js     usa JWT_SECRET o lee el secreto JWT de Secrets Manager al arrancar
      middleware/auth.js    verifica token, pone req.userId
      middleware/metrics.js latencia y 5xx por petición
      middleware/errors.js  manejador central de errores
      routes/index.js       todas las rutas de /api
      services/
        gameEngine.js       lógica pura de hi-lo, ruleta y minas
        gameService.js      transacciones de juego
        userService.js      registro, login y perfil
        activityService.js  historial paginado
        walletService.js    paquetes y recargas
        leaderboardService.js  ranking en curso y semanas cerradas
        notificationService.js suscripción SNS
        storageService.js   S3 fotos de perfil
        metrics.js          buffer y envío a CloudWatch
      lib/
        ddb.js              cliente de DynamoDB (DDB_ENDPOINT en local)
        aws.js              clientes de SQS, SNS, S3, Secrets Manager y CloudWatch, creados al primer uso
        time.js             fecha local y semana ISO en America/Mexico_City
        uuid.js             validación de versión de UUID y derivación de ids v5
        validate.js         validaciones de entrada
        errors.js           AppError y badRequest
    test/                   api, cloud, cloudUnit, gameEngine y lib (.test.js)
  lambdas/
    package.json, jest.config.js
    build.sh                arma lambdas/dist/<función>/ con <función>/index.js y shared/ (misma estructura relativa que el repo)
    shared/                 ddb.js, metrics.js, sns.js, time.js
    recharge-worker/index.js
    daily-bonus/index.js
    weekly-ranking/index.js
    test/                   una prueba por función, shared y helpers.js
  infra/
    bootstrap/bootstrap-state.sh
    cloudwatch-agent.json   configuración del agente de logs
    envs/lab/               main.tf, variables.tf, outputs.tf, versions.tf, .terraform.lock.hcl, backend.hcl.example, lab.tfvars.example
    modules/                network, compute (con user_data.sh), data, storage, secrets, messaging, functions, monitoring
  scripts/
    deploy.sh               build de Lambdas, terraform apply, empaquetado, subida a S3 y SSM (lo usan las personas y el CD)
    deploy-on-instance.sh   se ejecuta en EC2 vía SSM
    update-gh-secrets.sh    copia credenciales del lab a secretos de GitHub
    resume-lab.sh           sesión nueva del lab: arranca la EC2 si está detenida, espera SSM y /api/health (`--gh-repo` renueva los secretos)
    smoke.sh                prueba de punta a punta de los 3 flujos contra la nube (`--url`)
    monitoring-check.sh     métricas, estado de las 2 alarmas y URL del dashboard (`--demo-alarms`, `--reset`)
    destroy.sh              vacía los buckets y corre terraform destroy (`--yes`, `--keep-state`)
    seed.js                 jugadores y estadísticas de una semana pasada para probar el cierre del ranking (`--week <YYYY-Www>`, `--include-email <correo>`)
  .github/workflows/ci.yml, cd.yml
  .github/CODEOWNERS, pull_request_template.md
  docs/
```

## 2. Configuración

Variables de entorno del backend. En EC2 viven en `/etc/friomx/backend.env`, que el script de despliegue escribe tal cual desde la salida `backend_env` de Terraform; en local salen de `backend/.env`. `config/env.js` solo exige una de `JWT_SECRET` o `JWT_SECRET_ARN` y no arranca sin ninguna. Las variables de AWS son opcionales: si falta una, la función que depende de ella se apaga limpia y el resto de la app sigue funcionando.

| Variable | Ejemplo | Obligatoria | Si falta |
|---|---|---|---|
| `PORT` | 3000 | no | 3000 |
| `HOST` | 127.0.0.1 | no | 127.0.0.1 (en EC2 solo escucha nginx hacia afuera) |
| `AWS_REGION` | us-east-1 | no | us-east-1 |
| `APP_TZ` | America/Mexico_City | no | America/Mexico_City |
| `TABLE_USERS`, `TABLE_USER_EMAILS`, `TABLE_ACTIVITY`, `TABLE_WEEKLY_STATS`, `TABLE_RECHARGES`, `TABLE_GAME_ROUNDS`, `TABLE_LEADERBOARD` | friomx-users | no | los nombres `friomx-*` del §4 |
| `JWT_SECRET_ARN` | arn:aws:secretsmanager:... | una de las dos | en la nube; el valor se lee con `GetSecretValue` al arrancar |
| `JWT_SECRET` | 64 caracteres hex | una de las dos | en local; si existe se usa tal cual y no se llama a Secrets Manager |
| `UPLOADS_BUCKET` | friomx-uploads-123456789012 | no | subir y quitar foto responden 503 NOT_AVAILABLE y `GET /profile/image` regresa `available: false` |
| `RECHARGE_QUEUE_URL` | https://sqs.us-east-1.amazonaws.com/.../friomx-recharges | no | `POST /wallet/recharges` responde 503 QUEUE_UNAVAILABLE |
| `USER_TOPIC_ARN` | arn:aws:sns:...:friomx-user-notifications | no | el registro no crea suscripción SNS, sin error |
| `METRICS_NAMESPACE` | FrioMx | no | FrioMx |
| `METRICS_ENABLED` | true | no | sin `true` no se llama a `PutMetricData` |
| `DDB_ENDPOINT` | http://localhost:8000 | no | solo en local, apunta a DynamoDB Local; en la nube no se define |

`backend_env` incluye todas salvo `JWT_SECRET` y `DDB_ENDPOINT`, con `METRICS_ENABLED=true`. Las credenciales de AWS las da el perfil de instancia `LabInstanceProfile`. No hay llaves en archivos.

## 3. Contrato de la API

Todas las rutas van bajo `/api`. Las marcadas con candado requieren `Authorization: Bearer <token>`. El usuario se toma de `req.userId`, que sale del token. Ninguna ruta acepta `userId` ni `id` del cliente. Los errores responden `{ "error": "<mensaje>", "code": "<CODIGO>" }`. El cliente de la API del frontend (`scripts/app.js`, §17) traduce los códigos conocidos a mensajes en español (por ejemplo RATE_LIMITED) y, si no conoce el código, muestra `error`.

| Método y ruta | Auth | Entrada | Respuesta |
|---|---|---|---|
| GET /health | no | | 200 `{status:"ok"}` |
| POST /auth/register | no | `{name, age, email, password}` | 201 `{token, user:{id, name, email, balance}}` |
| POST /auth/login | no | `{email, password}` | 200 `{token, user:{id, name, email, balance}}` |
| GET /auth/user-name | 🔒 | | 200 `{name}` |
| GET /user/profile | 🔒 | | 200 `{id, name, age, email, balance, profileImageUrl}` |
| PUT /user/profile | 🔒 | `{field: "username"\|"email"\|"password", newValue}` | 200 perfil |
| GET /user/balance | 🔒 | | 200 `{balance}` |
| GET /user/activity | 🔒 | `?limit=20&cursor=` | 200 `{items:[{nameGame, BetStatus, balance, dateGame}], nextCursor}` |
| POST /profile/upload | 🔒 | multipart `profileImage` | 200 `{success, profileImage}` (URL firmada) |
| DELETE /profile/delete | 🔒 | | 200 `{success}` |
| GET /profile/image | 🔒 | | 200 `{success, available, profileImage}`: `available` es `false` sin `UPLOADS_BUCKET`; `profileImage` es la URL firmada (15 min) o `null` |
| GET /games/hi-lo/active | 🔒 | | 200 `{round: null \| {roundId, oldCard, bet, options}}` |
| POST /games/hi-lo/deal | 🔒 | `{betAmount}` | 201 `{roundId, oldCard, bet, options:{higher, lower}, newBalance}`; cada opción es `{multiplier, chance}` o `null`. 409 ROUND_ACTIVE (con `gameId`) si ya hay una ronda abierta |
| POST /games/hi-lo | 🔒 | `{roundId, prediction:"higher"\|"lower"}` | 200 `{won, tie, oldCard, newCard, prediction, bet, payout, amountChange, newBalance}` |
| POST /games/roulette | 🔒 | `{bets:[{type, value, amount}]}` | 200 `{winningSlot, winningIndex, results:[{type, value, amount, won, change}], totalBet, totalAmountChange, newBalance}` |
| GET /games/mines/active | 🔒 | | 200 `{round: null \| vista de partida}` (ver 5.3) |
| POST /games/mines/start | 🔒 | `{betAmount}` | 201 vista de partida + `newBalance`. 409 ROUND_ACTIVE si ya hay una |
| POST /games/mines/reveal | 🔒 | `{gameId, x, y}` | 200 ver 5.3 |
| POST /games/mines/cashout | 🔒 | `{gameId}` | 200 `{status:"CASHED", payout, amountChange, mines, newBalance}`; 400 si no hay casillas destapadas |
| GET /wallet/packages | 🔒 | | 200 `[{packageId, chips}]` |
| POST /wallet/recharges | 🔒 | `{packageId}` + cabecera `Idempotency-Key` (UUID) | 202 `{rechargeId, status}` |
| GET /wallet/recharges/:rechargeId | 🔒 | | 200 `{rechargeId, status, chips, createdAt, completedAt}` |
| GET /leaderboard/current | 🔒 | | 200 `{weekId, top:[{rank, name, net}], me:{rank, net, gamesPlayed}}` (top 10; `me.rank` sale del mismo orden y es `null` si no ha jugado en la semana) |
| GET /leaderboard/last | 🔒 | `?weekId=` opcional, solo semanas pasadas | 200 `{weekId, top:[{rank, name, net, prize}]}` o 404. Sin `weekId` regresa la última semana cerrada |
| GET /leaderboard/weeks | 🔒 | | 200 `[weekId]` de las semanas cerradas, de la más reciente a la más antigua |

Se eliminan respecto a la base: `PUT /user/balance`, `POST /user/activity`, las rutas de pagos, todas las rutas `/assets/*` (el frontend no las usa), y los parámetros `?id=` y `userId` en el cuerpo. La ruta de la base que recibía `won` del navegador para minas ya no existe: minas se resuelve en el servidor desde Fase 2 (§5.3).

Códigos de error comunes:

| HTTP | code | Cuándo |
|---|---|---|
| 400 | VALIDATION_ERROR | campo faltante, tipo o rango inválido |
| 401 | UNAUTHORIZED | sin token, token inválido o expirado |
| 401 | INVALID_CREDENTIALS | login fallido |
| 403 | FORBIDDEN | recurso de otro jugador (ronda de hi-lo, partida de minas, recarga) |
| 404 | NOT_FOUND | partida, ronda, recarga o semana inexistente |
| 409 | EMAIL_IN_USE | correo ya registrado |
| 409 | GAME_FINISHED | destape en una partida terminada o ronda de hi-lo ya jugada |
| 409 | INSUFFICIENT_FUNDS | saldo menor a la apuesta |
| 409 | CONFLICT | condición de concurrencia, reintentar |
| 429 | DAILY_LIMIT / RATE_LIMITED | 4.ª recarga del día / demasiados intentos |
| 503 | QUEUE_UNAVAILABLE | no se pudo encolar la recarga |
| 400 | VALIDATION_ERROR | JSON mal formado (`err.type = entity.parse.failed`) |
| 413 | PAYLOAD_TOO_LARGE | cuerpo de más de 10 KB (`err.type = entity.too.large`) |
| 500 | INTERNAL | cualquier otro error |

`middleware/errors.js` primero convierte los errores de multer (`err instanceof multer.MulterError`, por ejemplo `LIMIT_FILE_SIZE`, que no traen `status`) y el error del `fileFilter` de tipo de archivo (que se lanza con `status = 400`) en 400 VALIDATION_ERROR. Después respeta `err.status` cuando es menor a 500 (los errores de `express.json` lo traen) y solo los errores sin estado, o con 500 o más, responden 500 INTERNAL y cuentan en `Api5xx`. Hay una prueba con supertest para el JSON mal formado, el cuerpo grande, la foto de más de 5 MB y la foto que no es imagen.

Validaciones de entrada:
- `betAmount` y cada `amount` de ruleta: entero, `1 <= x <= 10000`. Suma de la ruleta `<= 10000`. Máximo 20 apuestas por giro.
- Ruleta: `type` en `color|parity|dozen`. `value` en `Rojo|Negro|Verde`, `par|impar`, `1|2|3` respectivamente.
- `email`: se normaliza a minúsculas y sin espacios, formato validado, máximo 254 caracteres. `name`: 1 a 40 caracteres. `password`: al menos 8 caracteres y como máximo 72 bytes en UTF-8 (`Buffer.byteLength`), que es el límite real de bcrypt. `age`: entero 18 a 99. El backend convierte `age` con `Number()` antes de validar, porque el formulario la manda como texto.
- `x`, `y`: enteros 0 a 4. `gameId`, `roundId` e `Idempotency-Key`: UUID v4. `rechargeId`: UUID v5, porque se deriva de la clave (`uuid.validate(x) && uuid.version(x) === 5`).
- Foto de perfil: campo `profileImage`, mimetype `image/jpeg|image/png|image/webp`, máximo 5 MB (multer con `limits.fileSize`). Fuera de eso, 400 VALIDATION_ERROR.
- Cuerpo JSON máximo 10 KB (`express.json({limit:"10kb"})`).
- `helmet` se monta solo en el backend (`/api`), que responde JSON. El servidor del frontend no lo usa: su política de contenido por defecto forzaría HTTPS en un sitio HTTP y bloquearía las fotos de S3.
- Límite de intentos en `/auth/login` y `/auth/register`: 10 por minuto por IP con `express-rate-limit` en versión fija (`limit: 10`). En login se usa `skipSuccessfulRequests: true` para contar solo fallos. El intento 11 dentro del minuto da 429 RATE_LIMITED. Los dos limitadores usan `handler: (req, res) => res.status(429).json({ error: "Demasiados intentos, espera un minuto", code: "RATE_LIMITED" })` para responder con el formato de error del contrato (por defecto responden texto plano). Hay una prueba con supertest del intento 11.

## 4. DynamoDB

Todas las tablas usan `PAY_PER_REQUEST`, cifrado por defecto y prefijo `friomx-`. Los números de fichas son enteros.

Notación: en este documento las expresiones se escriben abreviadas para leerlas fácil (por ejemplo `status = ACTIVE`). En el código todos los nombres de atributo van como `#placeholder` en `ExpressionAttributeNames` (obligatorio para palabras reservadas como `status`, `name`, `count` y `date`) y todos los valores como `:placeholder` en `ExpressionAttributeValues`, porque DynamoDB no acepta literales en expresiones. Cuando una transacción se cancela, el motivo se lee de `CancellationReasons` de `TransactionCanceledException`, que trae un código por ítem en el mismo orden de la petición.

### 4.1 Esquemas

**friomx-users** (PK `userId` S, UUID v4)
`name`, `age` N, `email`, `passwordHash`, `tokenVersion` N, `balance` N, `profileImageKey`, `notifySubscriptionArn`, `notifyEmail`, `pendingUnsubscribeArns` L, `createdAt` (ISO UTC), `lastPlayedAt` (ISO UTC), `lastBonusDate` (`YYYY-MM-DD` local), `rechargeDate` (`YYYY-MM-DD` local), `rechargeCount` N.

**friomx-user-emails** (PK `email` S)
`userId`. Existe solo para garantizar unicidad del correo.

**friomx-activity** (PK `userId` S, SK `sk` S = `<createdAt ISO>#<gameId>`)
`gameId`, `nameGame` (`Hi-Lo`|`Ruleta`|`Mines`), `BetStatus` BOOL, `balance` N (ganancia neta, negativa si perdió), `dateGame` (ISO). Se conservan los nombres de campo de la base para que `activity.js` siga leyendo `nameGame`, `dateGame` y `balance` sin cambiar su lógica de pintado.

**friomx-weekly-stats** (PK `weekId` S `2026-W41`, SK `userId` S)
`net` N, `gamesPlayed` N, `name`.

**friomx-recharges** (PK `rechargeId` S)
`userId`, `packageId`, `chips` N, `status` (`PENDING`|`COMPLETED`), `createdAt`, `completedAt`. La API responde `FAILED` cuando `status = PENDING` y `createdAt` tiene más de 5 minutos. Ese valor no se guarda: si después la recarga se reprocesa desde la cola de fallidos y se completa, la API pasa a responder `COMPLETED`.

**friomx-game-rounds** (PK `gameId` S, TTL `expiresAt` N epoch)
`userId`, `game` (`hilo`|`mines`), `status` (`ACTIVE`|`WON`|`LOST`|`CASHED`), `createdAt`.
Hi-lo: `oldCard` N, `bet` N, `weekId` S. Minas: `bet` N, `weekId` S (semana de inicio), `mines` L de índices 0..24, `revealed` L de índices, `version` N. Toda transición de una partida de minas incrementa `version`.

**friomx-leaderboard** (PK `weekId` S)
`top` L de `{rank, userId, name, net, prize}`, `closedAt`.

### 4.2 Patrones de acceso

| Operación | Tabla y operación |
|---|---|
| Login | GetItem user-emails por correo, GetItem users |
| Perfil, saldo | GetItem users |
| Historial | Query activity por userId, `ScanIndexForward=false`, `Limit`, `ExclusiveStartKey` como cursor en base64url (`Buffer.from(json).toString("base64url")`), que no usa `+`, `/` ni `=` y viaja sin problemas en la URL. El backend decodifica el cursor y exige que traiga solo `userId` y `sk`, que `userId` sea el del token y que `sk` tenga el formato `<ISO>#<uuid>`. Si no, 400 VALIDATION_ERROR |
| Ranking en curso | Query weekly-stats por weekId (paginado), ordenar por `net` en memoria, top 10 |
| Ranking cerrado | GetItem leaderboard por `weekId` (por defecto la semana anterior). Lista de semanas cerradas: Scan de leaderboard con `ProjectionExpression = weekId` (una fila por semana) |
| Bono diario | Scan users (paginado) con filtro `lastPlayedAt >= :hace7dias` |

Con el tamaño del curso (decenas de jugadores) el Scan y el orden en memoria son suficientes. Si creciera, la mejora sería un GSI disperso por actividad y escribir el top en caliente.

### 4.3 Escrituras críticas

**Registro.** `TransactWriteItems`:
1. Put user-emails `{email, userId}` con `attribute_not_exists(email)`.
2. Put users con `balance = 1000` y `attribute_not_exists(userId)`.
Si falla la condición 1 → 409 EMAIL_IN_USE. Después se crea la suscripción SNS (sección 7). Si SNS falla se registra el error y la cuenta queda creada sin suscripción.

**Cambio de correo.** Si el correo nuevo normalizado es igual al actual se responde 200 sin cambios (una transacción no puede tocar dos veces el mismo ítem). Si no, `TransactWriteItems`: Delete user-emails viejo con `userId = :me`, Put nuevo con `attribute_not_exists(email)`, Update users `SET email`. Luego se crea la suscripción nueva y se intenta eliminar la anterior con `Unsubscribe` usando el ARN guardado. Cualquier error de `Unsubscribe` se registra y no hace fallar la petición. SNS no permite borrar una suscripción pendiente de confirmar, que desaparece sola a las 48 horas. Si alguien la confirma antes, recibe los avisos de ese jugador. Es una limitación aceptada.

**Cambio de contraseña y de correo.** Ambos exigen `currentPassword` (403 WRONG_PASSWORD si no coincide). La contraseña se guarda con Update users `SET passwordHash, tokenVersion = tokenVersion + 1` (bcrypt, costo 10), con condición sobre la versión leída, y la respuesta trae un `token` nuevo. El JWT lleva la versión en `tv` y `requireAuth` rechaza los tokens cuyo `tv` no coincide con `tokenVersion`, así un token robado deja de servir al cambiar la contraseña. El nombre no admite `<` ni `>` y el frontend pinta todo dato del usuario con `textContent`. El login compara contra un hash fijo cuando el correo no existe, para que el tiempo de respuesta no revele qué correos están registrados. Se usa `bcryptjs`, que ya trae la base y es JavaScript puro, así el paquete armado en el runner de GitHub corre en Amazon Linux sin compilar nada nativo.

**Rondas con estado (hi-lo y minas).** El reparto de hi-lo y el `start` de minas cobran la apuesta (si fuera gratis, un jugador podría pedir cartas hasta que saliera una favorable). Cada usuario guarda un puntero a su ronda abierta de cada juego (`activeHiloId`/`activeHiloExp`, `activeMinesId`/`activeMinesExp`). Al abrir, `TransactWriteItems`:
1. Update users `SET balance = balance - :bet, lastPlayedAt, <puntero> = :id, <exp> = :exp` con `balance >= :bet AND (attribute_not_exists(<puntero>) OR <exp> < :ahora)`. Si falla, se relee el usuario: con ronda viva → 409 ROUND_ACTIVE con su `gameId`; si no → 409 INSUFFICIENT_FUNDS.
2. Put game-rounds `{gameId, userId, game, bet, weekId, activitySk, status:"ACTIVE", version:0, expiresAt: ahora+3600, ...}` (`oldCard` en hi-lo; `mines` y `revealed` en minas).
3. Put activity con `attribute_not_exists(sk)`, `result:"EN_CURSO"` y `balance = -bet`. Así una ronda abandonada queda en el historial como pérdida y el historial siempre cuadra con el saldo.
4. Update weekly-stats (semana actual) `ADD net :net, gamesPlayed :one SET #name = :name` con `:net = -bet`.

`GET /games/{hi-lo|mines}/active` sigue el puntero y regresa la ronda si sigue `ACTIVE` y no expiró, para que el navegador la retome al recargar.

**Cierre de ronda.** Jugada de hi-lo, mina pisada, cobro de minas o las 20 casillas: GetItem consistente de la ronda (404 si no existe o expiró, 403 si es de otro usuario o de otro juego, 409 GAME_FINISHED si no está `ACTIVE`) y luego `TransactWriteItems`:
1. Update game-rounds `SET status = WON|LOST|CASHED, version = version + 1` con `status = ACTIVE AND version = :v`. Si falla y la ronda ya no está activa → 409 GAME_FINISHED, si no → 409 CONFLICT. Así dos clics simultáneos nunca pagan dos veces.
2. Update users `ADD balance :payout REMOVE <puntero>, <exp>`.
3. Put activity sobre el mismo `sk` de la apertura con el resultado final (`GANADA`, `PERDIDA` o `IGUAL`, `balance = payout - bet`).
4. Solo si `payout > 0`: Update weekly-stats de la semana guardada en la ronda `ADD net :payout` (sobre el −bet de la apertura deja el neto).

**Jugada de un paso (ruleta).** Se calcula `net` con el motor. Luego `TransactWriteItems`:
1. Update users `SET balance = balance + :net, lastPlayedAt = :now` con `balance >= :bet`.
2. Put activity con `attribute_not_exists(sk)`.
3. Update weekly-stats `ADD net :net, gamesPlayed :one SET #name = :name`.

Si se cancela por la condición 1 → 409 INSUFFICIENT_FUNDS. El motivo se lee de `CancellationReasons` de `TransactionCanceledException`, en el orden de los ítems. Si se cancela por `TransactionConflict` se reintenta hasta 3 veces con espera corta y si sigue → 409 CONFLICT. `newBalance` se obtiene con un GetItem consistente después de la transacción.

**Recarga (backend).** `rechargeId = uuidv5(userId + ":" + idempotencyKey, NAMESPACE_FRIOMX)`. Primero GetItem de la recarga por `rechargeId`. Si ya existe y es de otro usuario → 403. Si existe y está `PENDING` se vuelve a encolar (el consumidor es idempotente) y se responde 202 con el estado. Si existe y está `COMPLETED` se responde 202 con ese estado. Así un reintento nunca choca con el límite diario. Si no existe, `TransactWriteItems`:
1. Update users. Dos variantes, se intenta A y si falla su condición se intenta B:
   - A: `ADD rechargeCount :one` con `rechargeDate = :today AND rechargeCount < :max`.
   - B: `SET rechargeDate = :today, rechargeCount = :one` con `attribute_not_exists(rechargeDate) OR rechargeDate <> :today`.
2. Put recharges `{rechargeId, userId, packageId, chips, status:"PENDING", createdAt}` con `attribute_not_exists(rechargeId)`.
Resultado:
- Éxito → SendMessage `{rechargeId}` → 202.
- Cancelada con `ConditionalCheckFailed` en el ítem 2 (otra petición simultánea creó la misma recarga) → se repite el GetItem de arriba y se responde igual. Se revisa el ítem 2 antes que el 1. El contador no se incrementa porque la transacción se canceló completa.
- Cancelada solo por el ítem 1 en B → se reintenta A una vez, porque otra recarga simultánea pudo abrir el día. Si A vuelve a fallar por el ítem 1 → 429 DAILY_LIMIT.
- Cancelada por `TransactionConflict` → hasta 3 reintentos con espera corta, igual que la jugada.
- SendMessage falla → 503 QUEUE_UNAVAILABLE. La recarga queda `PENDING` y el navegador reintenta con la misma clave, lo que vuelve a encolar sin cobrar otro cupo.

## 5. Motor de juegos (`services/gameEngine.js`)

Funciones puras, sin acceso a AWS, para probarlas con unidades. El aleatorio se inyecta (`rng = crypto.randomInt` por defecto) para poder fijarlo en pruebas. Todos los juegos devuelven 95% del pago justo.

**Redondeo.** Las fichas son enteras y todo pago se redondea hacia abajo (`floor`). Es determinista: el monto que la pantalla muestra antes de jugar (`options[].payout` en hi-lo, `cashoutAmount` y `nextCashoutAmount` en minas) es exactamente el que se paga. Con apuestas muy chicas el redondeo puede dejar la ganancia en 0, y la interfaz lo avisa antes de elegir.

### 5.1 Hi-lo

- Cartas: valores 2 a 12 (J = 11 y Q = 12 en pantalla). La carta visible (`oldCard`) se reparte con `rng(3, 12)`, de 3 a J, para que siempre se pueda elegir mayor y menor. La segunda (`newCard`) sale de `rng(2, 13)` en la jugada.
- `higher` gana si `new > old`. `lower` gana si `new < old`. El empate pierde.
- `k` = cantidad de valores que ganan: `12 - old` para `higher` y `old - 2` para `lower`. Como la carta visible va de 3 a J, `k` nunca es 0. Si llegara a serlo, la predicción se rechaza con 400 como defensa.
- Pago si gana: `floor(bet × 0.95 × 11 / k)`. El reparto envía por opción el multiplicador (`0.95 × 11 / k`, 2 decimales), la probabilidad (`k/11`) y el pago exacto con esa apuesta, para mostrarlos antes de elegir.
- Motivo del cambio respecto a la base: ahí el empate gana y el multiplicador está entre 1.15 y 1.92 para cualquier carta, así que jugando bien el valor esperado es positivo con todas las cartas y hi-lo crearía fichas sin límite.

### 5.2 Ruleta

- Rueda europea de 37 casillas, `index = rng(0, 37)`. El 0 es `Verde` y no tiene paridad ni docena.
- Pagos netos por ficha: color rojo o negro 1, paridad 1, docena 2, verde 35. Con el 0 pierden color, paridad y docena. Cada apuesta tiene un retorno de 36/37, como en una ruleta europea. En la base todo pagaba 1 a 1, así que verde y docena eran apuestas con retorno de 0.05 y 0.65. Cada resultado trae su `change` y `net` es la suma.
- Los tipos se validan contra un `Map`, así un `type` como `__proto__` o `toString` da 400 y no 500.

### 5.3 Minas

Tablero 5×5 (índice `i = x*5 + y`), 5 minas, resuelto en el servidor (el navegador nunca conoce las minas antes de terminar).

- **Multiplicador** tras `k` casillas seguras: `0.95 × C(25,k) / C(20,k)` (1.18, 1.50, 1.91, 2.48, …), porque `C(20,k)/C(25,k)` es la probabilidad de sobrevivir `k` destapes. El pago se limita a 1 000 000 fichas.
- **Vista de partida**: `{gameId, bet, boardSize, minesCount, revealed:[{x,y}], safeCount, multiplier, nextMultiplier, cashoutAmount, nextCashoutAmount, maxPayout, atCap}`.
- **reveal(x, y)**: si la casilla ya está destapada responde el estado sin cambios (un reintento siempre es seguro). Si es mina, cierra la ronda con `LOST` y responde las minas. Si es la casilla segura número 20, cierra con `WON` y paga como un cobro. Si no, Update partida `SET revealed, version = version + 1` con `version = :v AND status = ACTIVE` y, si choca con otro destape simultáneo, 409 CONFLICT para que el navegador lo repita.
- **cashout**: con al menos una casilla segura, cierra la ronda con `CASHED` y paga `cashoutAmount = floor(bet × 0.95 × C(25,k)/C(20,k))`, el mismo número que mostraba la pantalla.
- Cada entrada del historial guarda un `detail` corto ("Cayó 16 · Rojo · Par · 13–24 · apostaste Rojo 10, Par 5", "Q → 3 · elegiste Menor", "Cobraste tras 3 casillas seguras").
- Las banderas son solo visuales en el navegador.

## 6. Lambdas

Runtime `nodejs22.x`. Usan el SDK v3 incluido en el runtime, así el paquete desplegado no lleva dependencias. Para las pruebas, `lambdas/package.json` declara como `devDependencies` en versión fija los clientes `@aws-sdk/*` que usan, junto con `jest` y `aws-sdk-client-mock`, y `build.sh` no copia `node_modules`. Las funciones importan el código compartido con `require("../shared/ddb")`. Para que esa ruta sirva igual en las pruebas y en el zip, `lambdas/build.sh` copia `<función>/index.js` a `lambdas/dist/<función>/<función>/index.js` y `shared/` a `lambdas/dist/<función>/shared/`. Terraform arma el zip con `archive_file` sobre `lambdas/dist/<función>/` y usa `handler = "<función>/index.handler"`, `filename = data.archive_file.<fn>.output_path` y `source_code_hash = data.archive_file.<fn>.output_base64sha256`. Sin el hash, Terraform no detecta que cambió el contenido del zip (el nombre del archivo es siempre el mismo) y la Lambda se queda con el código de su primera versión. El CD y `scripts/deploy.sh` corren `build.sh` antes de `terraform apply`. Rol `LabRole`. Logs en `/aws/lambda/<nombre>` con retención de 14 días. Métricas propias con Embedded Metric Format (una línea JSON en el log).

Variables de entorno, que el módulo `functions` pasa en `environment.variables` a partir de las salidas de los módulos `data` y `messaging`:

| Función | Variables |
|---|---|
| recharge-worker | `TABLE_USERS`, `TABLE_RECHARGES`, `USER_TOPIC_ARN`, `METRICS_NAMESPACE`, `APP_TZ` |
| daily-bonus | `TABLE_USERS`, `USER_TOPIC_ARN`, `METRICS_NAMESPACE`, `APP_TZ` |
| weekly-ranking | `TABLE_USERS`, `TABLE_WEEKLY_STATS`, `TABLE_LEADERBOARD`, `USER_TOPIC_ARN`, `METRICS_NAMESPACE`, `APP_TZ` |

### 6.1 friomx-recharge-worker

- Disparo: event source mapping de `friomx-recharges`, `batch_size = 10`, `maximum_batching_window_in_seconds = 1`, `function_response_types = ["ReportBatchItemFailures"]`, `scaling_config.maximum_concurrency = 2`.
- Timeout 10 s, memoria 256 MB.
- Por cada mensaje `{rechargeId}`:
  1. GetItem recharge. Si no existe → error (va a reintento y luego a DLQ).
  2. `TransactWriteItems`: Update recharges `SET status="COMPLETED", completedAt=:now` con `status = PENDING`, y Update users `ADD balance :chips` con `attribute_exists(userId)`.
  3. Si se cancela porque ya estaba `COMPLETED` → éxito, sin correo (duplicado).
  4. Si se completó → Publish a `USER_TOPIC_ARN` con `MessageAttributes.audience = userId` y texto "Tu recarga de N fichas está lista". Si Publish falla se registra la métrica `NotificationFailed` y el mensaje se da por bueno, porque las fichas ya se acreditaron.
  5. Métrica `RechargesCompleted`.
- Cualquier otro error devuelve el `itemIdentifier` en `batchItemFailures` para reintentar solo ese mensaje y emite la métrica `RechargeFailed`. Con `ReportBatchItemFailures` la invocación termina bien, así que `AWS/Lambda Errors` no cuenta estos fallos y hace falta la métrica propia.

### 6.2 friomx-daily-bonus

- Regla `cron(0 14 * * ? *)` (08:00 en Ciudad de México, UTC−6 sin horario de verano desde 2022). Timeout 60 s.
- `today` = fecha local. Scan paginado de users con `lastPlayedAt >= now - 7 días`.
- Por jugador: Update `ADD balance :100 SET lastBonusDate = :today` con `attribute_not_exists(lastBonusDate) OR lastBonusDate <> :today`. Condición fallida = ya tuvo bono hoy, se omite.
- A cada acreditado: Publish con `audience = userId`.
- Métricas `BonusGranted` y `BonusSkipped`. Ejecutarla dos veces el mismo día no duplica nada.

### 6.3 friomx-weekly-ranking

- Regla `cron(10 7 ? * MON *)` (lunes 01:10 local). Se corre después de la 1:00 para que ya hayan expirado todas las rondas de hi-lo y partidas de minas iniciadas en la semana que se cierra (duran máximo 1 hora). Timeout 60 s.
- `weekId` = semana ISO anterior a la semana local en curso, sin importar qué día se ejecute. Si el evento trae `weekId`, debe ser anterior a la semana en curso; si no, termina con error sin escribir nada. Así una invocación manual entre semana nunca cierra la semana en curso.
- Query paginado de weekly-stats por `weekId`. Ordena por `net` descendente y, en empate, por `gamesPlayed` descendente y luego `userId`. Toma los 3 primeros con `net > 0`. Premios 1000, 500, 250.
- `TransactWriteItems`: Put leaderboard con `attribute_not_exists(weekId)` y un Update users `ADD balance :prize` con `attribute_exists(userId)` por ganador (máximo 4 ítems). Si se cancela por el ítem 0 (ya existe) → la semana ya se cerró, termina sin hacer nada. Si se cancela por el ítem de un ganador (cuenta inexistente) → se quita a ese jugador del top y se reintenta.
- Si no hay ganadores se guarda el leaderboard con `top = []` para que la semana quede cerrada.
- Publish a cada ganador con `audience = userId`.
- Para la demo se puede invocar a mano con `aws lambda invoke --function-name friomx-weekly-ranking --cli-binary-format raw-in-base64-out --payload '{"weekId":"<semana>"}' out.json` (la CLI v2 necesita `--cli-binary-format` para JSON en texto). Como cada semana se cierra una sola vez y la regla del lunes cierra sola la semana anterior, para repetir la prueba se elige una semana pasada que no esté cerrada (por ejemplo una de hace varias semanas), se corre `scripts/seed.js --week <semana>` y se invoca con esa semana. `seed.js` rechaza la semana en curso y las que ya están cerradas.

### 6.4 Utilidades compartidas (`lib/time.js` y `lambdas/shared/time.js`)

- `localDate(now)`: `YYYY-MM-DD` en `America/Mexico_City` con `Intl.DateTimeFormat`.
- `isoWeekId(now)`: semana ISO 8601 de la fecha local, formato `YYYY-Www`. Las pruebas cubren el cambio de año (ejemplo, 2026-12-31 es `2026-W53`, 2027-01-04 es `2027-W01`).

## 7. SNS

- **friomx-user-notifications.** Cuota por defecto de 200 políticas de filtro por tema, suficiente para el curso. En el registro: `Subscribe(Protocol="email", Endpoint=email, Attributes.FilterPolicy={"audience":[userId,"all"]}, ReturnSubscriptionArn=true)`. Se guarda `notifySubscriptionArn`. El jugador recibe el correo de confirmación de AWS y debe aceptarlo. Toda publicación lleva `MessageAttributes.audience` (String) con el `userId` destinatario. El valor `all` queda reservado para avisos generales.
- **friomx-ops-alerts.** Suscripciones de correo de los tres integrantes, creadas por Terraform desde la variable `alert_emails`. Recibe las alarmas.

## 8. EC2

- Amazon Linux 2023, `t3.small`, subred pública de la VPC por defecto, IP elástica, `LabInstanceProfile`, IMDSv2 obligatorio, disco gp3 de 16 GB.
- Grupo de seguridad: entrada TCP 80 desde `0.0.0.0/0`. Sin puerto 22. Salida abierta.
- `user_data` (solo en la primera creación, log en `/var/log/friomx-user-data.log`): instala Node.js 22, nginx, el paquete del agente de CloudWatch (sin configurarlo) y logrotate, con hasta 5 reintentos de `dnf`. Crea el usuario `friomx` y los directorios `/var/log/friomx` (dueño `friomx`), `/opt/friomx/releases` y `/etc/friomx`. Registra dos servicios `systemd`, habilitados al arranque. `friomx-backend` usa `User=friomx`, `WorkingDirectory=/opt/friomx/current/backend`, `EnvironmentFile=/etc/friomx/backend.env` y `ExecStart=/usr/bin/node server.js`. `friomx-frontend` usa `User=friomx`, `WorkingDirectory=/opt/friomx/current/frontend`, `PORT=8080`, `HOST=127.0.0.1` y `ExecStart=/usr/bin/node server.js`. El backend lee sus variables de `EnvironmentFile` y no de un `.env`, que no viene en el paquete. Los dos llevan `After=network-online.target`, `Wants=network-online.target`, `Restart=always`, `RestartSec=5` y `StartLimitIntervalSec=0`. Así, si al arrancar la red o el secreto todavía no responden, el servicio reintenta cada 5 s sin quedar en `failed`. Al final escribe la marca `user_data de FrioMx terminado`, que `deploy-on-instance.sh` revisa.
- nginx (`/etc/nginx/conf.d/friomx.conf`, copiado de `infra/modules/compute/user_data.sh`):

```
server {
  listen 80 default_server;
  server_name _;
  client_max_body_size 6m;

  location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

- El `user_data` reemplaza completo `/etc/nginx/nginx.conf` de Amazon Linux 2023 (guarda el original en `nginx.conf.orig`) por uno sin el bloque `server` por defecto, que solo incluye `conf.d/*.conf`, así nada más compite por el puerto 80. Valida con `nginx -t` y habilita el servicio con `systemctl enable --now nginx` (en Amazon Linux 2023 instalarlo no lo arranca).
- Express usa `app.set("trust proxy", 1)` para que el límite de intentos vea la IP real.
- Un archivo de más de 6 MB lo rechaza nginx con 413 antes de llegar al backend. `profile.js` valida 5 MB antes de subir, así el jugador ve el mensaje propio en lugar del 413.
- Los servicios escriben su salida en `/var/log/friomx/backend.log` y `frontend.log` (`StandardOutput=append:` en `systemd`), con rotación por `logrotate` usando `copytruncate`, porque `systemd` abre el archivo una sola vez y un renombrado dejaría al proceso escribiendo en el archivo viejo. La configuración del agente vive en el repositorio (`infra/cloudwatch-agent.json`) y, una vez que existe el monitoreo, `deploy-on-instance.sh` la aplica en cada despliegue con `amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:<ruta> -s`. Así un cambio no depende del `user_data`. Los logs van a `/friomx/backend` y `/friomx/frontend` (14 días).

## 9. S3

- `friomx-uploads-<cuenta>`: privado, Block Public Access completo, cifrado SSE-S3. Llaves `profile-images/<userId>/<timestamp>-<uuid>.<ext>`. Se guarda solo la llave y se responde una URL firmada de 15 minutos. Es corta a propósito: una URL firmada deja de servir cuando caducan las credenciales temporales del perfil de instancia con que se firmó, y el frontend la vuelve a pedir en cada carga de página. Al subir una foto nueva se borra la anterior.
- `friomx-artifacts-<cuenta>`: privado, regla de ciclo de vida que borra `releases/` a los 30 días.
- `friomx-tfstate-<cuenta>`: privado, versionado. Lo crea `bootstrap-state.sh` con la CLI antes del primer `terraform init`.

## 10. Secrets Manager y tokens

Los tokens de sesión son JWT HS256 con `sub = userId` y `expiresIn: 7d`, firmados con el secreto de abajo.

`friomx/jwt-secret` con valor de 64 caracteres aleatorios generado por `random_password` de Terraform y `recovery_window_in_days = 0`, para que un `terraform destroy` seguido de `apply` pueda recrear el secreto con el mismo nombre. El valor queda también en el estado de Terraform, que está en un bucket privado con versionado. El backend lo lee con `GetSecretValue` al arrancar y lo cachea en memoria. Si no puede leerlo, no arranca.

## 11. Métricas y alarmas

El backend acumula en memoria y cada 60 s llama a `PutMetricData` en el namespace `FrioMx`. La latencia se redondea a múltiplos de 10 ms y se manda con `Values`/`Counts` para que CloudWatch calcule percentiles. Si hay más de 150 valores distintos (límite por dato) se parte en varios datos de la misma métrica.

| # | Métrica | Fuente | Estadística |
|---|---|---|---|
| 1 | `FrioMx/GamesPlayed` (dimensión `Game`) | backend | Sum, 1 min |
| 2 | `FrioMx/ApiLatency` (ms) | backend, middleware | p95, 1 min |
| 3 | `FrioMx/Api5xx` | backend, middleware | Sum, 1 min |
| 4 | `AWS/SQS ApproximateAgeOfOldestMessage` de `friomx-recharges` | SQS | Max, 1 min |
| 5 | Errores de Lambdas: `AWS/Lambda Errors` de daily-bonus y weekly-ranking, y `FrioMx/RechargeFailed` (EMF) del recharge-worker | Lambda | Sum, 1 min |

| Alarma | Condición | Acción |
|---|---|---|
| `friomx-api-5xx` | Sum de `Api5xx` >= 5 en 1 periodo de 300 s, datos faltantes = no rebasa | SNS ops |
| `friomx-recharge-dlq` | Max de `ApproximateNumberOfMessagesVisible` de la DLQ >= 1 en 1 periodo de 60 s, datos faltantes = no rebasa | SNS ops |

Dashboard `FrioMx`: las 5 métricas, CPU de EC2, `FrioMx/RechargesCompleted`, `BonusGranted` y profundidad de la DLQ.

## 12. SQS

- `friomx-recharges`: estándar, `visibility_timeout_seconds = 70` (6 veces el timeout de la Lambda más la ventana de lote, con margen), `message_retention_seconds = 345600` (4 días), `receive_wait_time_seconds = 20`, cifrado SSE-SQS. Redrive a la DLQ con `maxReceiveCount = 3`.
- `friomx-recharges-dlq`: retención 14 días. Se revisa a mano y se puede reprocesar con la redrive de la consola.

## 13. Terraform

- Terraform `>= 1.11` (bloqueo nativo en S3 estable; CI y CD usan 1.16.5), proveedor `hashicorp/aws ~> 5.0`.
- Backend: `backend "s3" {}` con `-backend-config=backend.hcl` (`bucket`, `key = "lab/terraform.tfstate"`, `region`, `use_lockfile = true`).
- Learner Lab no permite leer IAM (`iam:GetRole`, `iam:GetInstanceProfile`), así que no hay data sources de IAM: el ARN del rol se arma con la cuenta de `aws_caller_identity` (`arn:aws:iam::<cuenta>:role/LabRole`) y la instancia usa el perfil por nombre (`LabInstanceProfile`). Los dos nombres son variables con ese valor por defecto. Ningún módulo crea recursos IAM.
- Variables de `infra/envs/lab` (valores en `lab.tfvars`, que se copia de `lab.tfvars.example`):

| Variable | Por defecto | Notas |
|---|---|---|
| `alert_emails` | (obligatoria) | correos del equipo para `friomx-ops-alerts`; no puede ir vacía ni con los `@example.com` del ejemplo |
| `region` | us-east-1 | |
| `instance_type` | t3.small | |
| `lab_role_name` | LabRole | rol de las Lambdas |
| `lab_instance_profile_name` | LabInstanceProfile | perfil de la instancia |

- Módulos:

| Módulo | Recursos |
|---|---|
| network | security group, `aws_eip`, datos de VPC y subred por defecto (una zona que ofrezca el tipo de instancia) |
| compute | `data "aws_ami"` (Amazon Linux 2023 x86_64 más reciente de `amazon`, solo `ec2:DescribeImages`), `aws_instance` con `user_data`, `lifecycle.ignore_changes = [user_data, ami]`, asociación de la IP elástica |
| data | 7 `aws_dynamodb_table` (TTL en game-rounds) |
| storage | buckets de uploads y artefactos, bloqueo público, cifrado, ciclo de vida |
| secrets | `random_password`, secreto y versión |
| messaging | colas, redrive, temas SNS, suscripciones de alertas |
| functions | `archive_file` por Lambda, `aws_lambda_function` con `source_code_hash`, `aws_lambda_event_source_mapping`, `aws_cloudwatch_event_rule`/`target`, `aws_lambda_permission`, grupos de logs |
| monitoring | alarmas y `aws_cloudwatch_dashboard` |

- Salidas (`infra/envs/lab/outputs.tf`): `public_ip`, `instance_id`, `artifacts_bucket`, `uploads_bucket`, `recharge_queue_url`, `recharge_dlq_url`, `user_topic_arn`, `ops_topic_arn`, `jwt_secret_arn`, `aws_region`, `tables` (mapa `users`, `user_emails`, `activity`, `weekly_stats`, `recharges`, `game_rounds`, `leaderboard` → nombre) y `backend_env` (el contenido completo de `backend.env`, una línea `KEY=VALUE` por variable). En Entrega 3 se agregan `dashboard_url` y `function_names` (mapa `recharge-worker`, `daily-bonus`, `weekly-ranking` → nombre), que usan los scripts de operación. `scripts/deploy.sh`, que también usa el CD, las lee una por una con `terraform output -raw <nombre>` y escribe `backend_env` tal cual.

## 14. Despliegue de la aplicación (`scripts/deploy-on-instance.sh`)

`scripts/deploy.sh` arma `release.tgz` con `backend/` y `frontend/` (cada uno con `npm ci --omit=dev`, sin `node_modules`, `coverage`, `.env` ni `backend/test`), `scripts/deploy-on-instance.sh` y, si existe, `infra/cloudwatch-agent.json`. `<sha>` son los primeros 12 caracteres del commit (`GITHUB_SHA` en el CD), con sufijo `-dirty` si el árbol local tiene cambios. Sube `s3://<artifacts>/releases/<sha>/release.tgz` y `s3://<artifacts>/releases/<sha>/backend.env`, que es la salida `backend_env` de Terraform tal cual (falla si no trae `JWT_SECRET_ARN`). Espera hasta `SSM_WAIT` (300 s) a que la instancia esté `Online` en SSM y ejecuta `aws ssm send-command --document-name AWS-RunShellScript` con `executionTimeout` de 900 s. Sus `commands` descargan el tgz con `aws s3 cp`, lo descomprimen en `/opt/friomx/releases/<sha>-<timestamp UTC>` y corren `deploy-on-instance.sh <dir> <uri del backend.env> <region>`, que viene dentro. El script en la instancia (como root):

1. Espera a que termine `cloud-init` (`cloud-init status --wait`) y verifica que el `user_data` terminó: la marca `user_data de FrioMx terminado` en `/var/log/friomx-user-data.log`, el usuario `friomx`, los dos units de `systemd` y `node`. Si falta algo, termina con error e indica reemplazar la instancia con `terraform apply -replace=module.compute.aws_instance.web`, porque el `user_data` no se vuelve a correr.
2. Respalda el `/etc/friomx/backend.env` actual en `backend.env.prev`, descarga el nuevo de S3 y lo instala con permisos 600, dueño `friomx`.
3. Deja el código de la versión con dueño root y solo lectura para `friomx`.
4. Si el paquete trae `infra/cloudwatch-agent.json` y el agente está instalado, aplica su configuración con `amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:<versión>/infra/cloudwatch-agent.json -s`. Si falla, lo registra y sigue.
5. Guarda el destino actual de `/opt/friomx/current` como previo y apunta el enlace a la versión nueva (`ln -sfn` a un temporal y `mv -Tf`, atómico).
6. `systemctl daemon-reload` y `systemctl restart friomx-backend friomx-frontend`.
7. Hasta 10 intentos cada 3 s de `curl -fs http://127.0.0.1/api/health` (backend) y `http://127.0.0.1/login` (frontend), los dos a través de nginx.
8. Si falla, imprime `journalctl` y los logs de los dos servicios, restaura el `backend.env` previo, regresa el enlace a la versión previa, reinicia y termina con error para que el pipeline quede rojo.
9. Conserva las últimas 3 versiones (más la actual y la previa) y borra las demás.

Al terminar con `Success`, `deploy.sh` repite la prueba de humo desde afuera contra `http://<public_ip>/api/health` y `http://<public_ip>/login` (12 intentos cada 5 s).

## 15. CI/CD

`ci.yml`, en `pull_request` hacia `main`:
- Jobs en paralelo: `backend` (Node 22, `npm ci`, `npm test -- --coverage`), `lambdas` (igual), `e2e` (Playwright en Chromium contra backend, frontend y DynamoDB Local levantados en el runner; si falla sube el reporte como artefacto) y `terraform` (`hashicorp/setup-terraform` con versión fija 1.16.5, `fmt -check`, `init -backend=false`, `validate`). El job `deploy` del CD también usa `hashicorp/setup-terraform` con la misma versión.
- `backend/jest.config.js` define `collectCoverageFrom: ["src/**/*.js"]` y `lambdas/jest.config.js` define `["*/index.js", "shared/**/*.js", "!dist/**"]`. Los dos usan `coverageThreshold.global` con 70 en líneas, ramas, funciones y sentencias (RNF-09); empezó en 0 y se subió cuando los tres flujos tuvieron pruebas. El job `backend` levanta `amazon/dynamodb-local` como servicio y exporta `DDB_ENDPOINT=http://localhost:8000`: sin él las pruebas de API se saltan, la cobertura baja de 70 y el job falla.
- Protección de `main` (ruleset de GitHub "main protegida"): nadie hace push directo, todo entra por pull request, se requiere la aprobación del dueño del código (`.github/CODEOWNERS`) y no se permite force push ni borrar la rama. El CI corre en cada PR con 4 jobs (`backend`, `lambdas`, `e2e`, `terraform`).

`cd.yml`, en `push` a `main`:
- `concurrency: { group: deploy-lab, cancel-in-progress: false }`.
- Job `test`: lo mismo que CI.
- Job `deploy` (necesita `test`): credenciales con `aws-actions/configure-aws-credentials` usando `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y `AWS_SESSION_TOKEN`. Escribe `backend.hcl` y `lab.tfvars` a partir de los secretos `TF_BACKEND_HCL` y `TF_LAB_TFVARS` (este último lleva `alert_emails`) y ejecuta `scripts/deploy.sh`, el mismo que se usa a mano. Ese script hace `lambdas/build.sh`, `terraform init -backend-config=backend.hcl`, `terraform apply -auto-approve -var-file=lab.tfvars`, empaquetado, subida a S3, `send-command`, espera del resultado con un ciclo propio de `aws ssm get-command-invocation` cada 5 s y tope de `DEPLOY_TIMEOUT` (900 s por defecto, porque el primer arranque espera a que termine el `user_data`; trata `InvocationDoesNotExist` como pendiente, porque los primeros segundos la invocación todavía no aparece, y solo termina con `Success`, `Failed`, `Cancelled` o `TimedOut`), que imprime `StandardOutputContent` y `StandardErrorContent` (el waiter de la CLI se rinde a los 100 s), y prueba de humo `curl` a `http://<ip>/api/health` (backend) y `http://<ip>/login` (frontend).

`scripts/update-gh-secrets.sh` lee el bloque `[default]` de `~/.aws/credentials` (pegado desde "AWS Details" del lab) y corre `gh secret set` para las tres variables. Se ejecuta al iniciar cada sesión del lab. `TF_BACKEND_HCL` y `TF_LAB_TFVARS` se crean una sola vez con `gh secret set ... < archivo` a partir de `backend.hcl` y `lab.tfvars`, que se copian de los `.example` versionados. El README documenta los dos pasos.

## 16. Pruebas unitarias

- Jest y `aws-sdk-client-mock` para simular DynamoDB, SQS, SNS, S3, Secrets Manager y CloudWatch. `supertest` sobre `src/app.js` para rutas.
- Casos mínimos:
  - gameEngine: hi-lo con empate (pierde), `k = 0` rechazado, pago determinista igual al anunciado y valor esperado ≤ 0.95 para todo `k` y apuesta (≥ 0.949 con apuesta de 10 000), multiplicadores visibles, ruleta en 0 (verde 35 a 1), retorno 36/37 por tipo de apuesta y tipos del prototipo rechazados, multiplicador de minas creciente y con tope, generación de minas sin repetidos. En la API: rondas activas que se retoman, ROUND_ACTIVE, cobro de minas, concurrencia (repartos, jugadas, ruletas y cambios de correo simultáneos sin doble cobro ni 500), contraseña actual e invalidación de tokens, y paginación sin páginas vacías.
  - hi-lo: ronda inexistente, ajena, vencida o ya jugada; reparto con saldo insuficiente; pago de apuesta más ganancia al ganar y nada al perder.
  - gameService: transacción con condición de saldo, mapeo de `ConditionalCheckFailed` a 409, reintento ante `TransactionConflict`.
  - walletService: paquete inválido, variantes A y B del contador, límite diario, idempotencia (recarga existente), fallo de SQS a 503, dos recargas simultáneas en el primer uso del día (las dos pasan), reintento de una recarga ya creada con el cupo agotado (debe dar 202, no 429), estado `FAILED` a los 5 minutos, `GET /wallet/recharges/:id` con un id v5 responde 200.
  - auth: registro duplicado, login inválido, token expirado, ruta protegida sin token.
  - Lambdas: recarga duplicada sin doble abono, fallo parcial en el lote, bono dos veces el mismo día, cierre de semana repetido, cierre con `weekId` de la semana en curso (rechazado), semana sin ganadores, `isoWeekId` en cambio de año.
- Las pruebas no tocan AWS real.

## 17. Frontend

Se reescribió sobre una capa compartida sin dependencias externas: no hay CDN (la CSP del servidor del frontend solo permite scripts del mismo origen) ni Tailwind.

- `styles/app.css`: variables de color, barra superior con saldo, menú lateral en escritorio y barra inferior en celular, botones, campos, tarjetas, avisos y diálogos.
- `scripts/app.js` (`window.FrioMx`): guardia de sesión por página (`data-auth="private|guest|public"`, con `location.replace` para que Atrás no regrese a una página privada), cliente de la API con mensajes en español y manejo de 401, avisos, diálogos, formato de fichas y fechas, y el control de apuesta (½, ×2, Máx, solo enteros de 1 a 10 000).
- `frontend/server.js`: rutas de páginas, 404 propio, cabeceras de seguridad (CSP, `nosniff`, `X-Frame-Options`) y, solo en desarrollo, proxy de `/api` con `xfwd` para que el límite de intentos vea la IP real.
- Todo dato del usuario se pinta con `textContent`.

| Página | Comportamiento |
|---|---|
| Inicio, login y registro | Página pública con los juegos y cómo funciona. Errores por campo y validación antes de llamar a la API. El registro entra directo al lobby. El login respeta `?next=`. |
| Lobby | Saludo, saldo, los tres juegos con sus pagos, juegos próximos sin enlace y últimas 5 partidas. |
| Ruleta | Rueda en `<canvas>` que se detiene en `winningIndex`. Fichas de 1 a 500 o personalizadas sobre varias casillas, con deshacer, limpiar y repetir. El resultado queda en pantalla con el número, el detalle de cada apuesta y el neto. |
| Hi-lo | Apuesta y reparto; mayor y menor muestran multiplicador, pago aproximado y probabilidad; el resultado muestra las dos cartas. La ronda abierta se retoma al recargar (`/active`). |
| Minas | Tablero de botones navegable con teclado, multiplicador actual y siguiente, botón Cobrar, modo bandera y cola de destapes que reintenta en 409 CONFLICT. La partida abierta se retoma al recargar. |
| Historial | Juego, fecha, apuesta, resultado (GANADA, PERDIDA, IGUAL, EN CURSO) y neto con signo; "Ver más" con cursor y estado vacío. |
| Perfil | Editar nombre; cambiar correo o contraseña pidiendo la actual (guarda el token nuevo). Foto: subir, cambiar y quitar (con confirmación), JPG, PNG o WebP de hasta 5 MB validados antes de subir. `GET /profile/image` dice con `available` si la foto está activa; sin el campo, un 503 la marca como no disponible y los controles se deshabilitan con un aviso. Si la URL firmada ya venció o no carga, se ven las iniciales. |
| Saldo | Paquetes desde `GET /wallet/packages`. Cada recarga manda `POST /wallet/recharges` con `Idempotency-Key` UUID v4 (un reintento del mismo paquete reusa la clave) y consulta el estado cada 2 s hasta 60 s. La recarga en curso se guarda en `sessionStorage` y se retoma al recargar la página; mientras siga sin confirmar no se puede pedir otro paquete y se ofrece "Revisar". Si el `POST` falló con 503, 5xx o sin red, la clave queda guardada sin `rechargeId` (la recarga pudo quedar `PENDING` en el servidor y ya gastó un cupo): los otros paquetes quedan deshabilitados y solo se ofrece "Intentar de nuevo" con el mismo paquete y la misma clave, también al volver a abrir la página. Mensajes para DAILY_LIMIT ("Ya usaste tus 3 recargas de hoy"), QUEUE_UNAVAILABLE (con reintento) y FAILED, que avisa que las fichas pueden llegar más tarde. |
| Ranking | Semana en curso con el top 10, la fila propia resaltada ("Tú") y la posición del jugador. Debajo, selector de semanas cerradas (`/leaderboard/weeks`) con su top 3 y premios; la semana elegida se refleja en `?weekId=` y se respeta al abrir la página. |
| Reglas y Acerca de | Públicas; con sesión muestran el menú de la app. |
