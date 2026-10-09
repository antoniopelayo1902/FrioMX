# FrioMx -- Low Level Design (LLD)

Versión 1.0, 8 de octubre de 2026. Complementa `02-HLD.md`. Las referencias a archivos de la aplicación base son al código importado en el repositorio.

## 1. Estructura del repositorio

```
FrioMX/
  frontend/                 servidor Express estático + public/
  backend/
    server.js
    src/
      app.js                arma Express (para pruebas sin listen)
      config/env.js         lee y valida variables de entorno
      config/secrets.js     lee el secreto JWT al arrancar
      middleware/auth.js    verifica token, pone req.userId
      middleware/metrics.js latencia y 5xx por petición
      middleware/errors.js  manejador central de errores
      routes/               auth, user, profile, games, wallet, leaderboard, health
      controllers/
      services/
        gameEngine.js       lógica pura de hi-lo, ruleta y minas
        gameService.js      transacciones de juego
        walletService.js    recargas
        notificationService.js  suscripción SNS
        storageService.js   S3 fotos de perfil
        metrics.js          buffer y envío a CloudWatch
      repositories/         acceso a cada tabla de DynamoDB
      lib/time.js           fecha local y semana ISO en America/Mexico_City
    test/
  lambdas/
    shared/                 time.js, ddb.js, sns.js
    build.sh                arma lambdas/dist/<función>/ con <función>/index.js y shared/ (misma estructura relativa que el repo)
    recharge-worker/index.js
    daily-bonus/index.js
    weekly-ranking/index.js
    test/
  infra/
    bootstrap/bootstrap-state.sh
    envs/lab/               main.tf, variables.tf, outputs.tf, backend.hcl.example, lab.tfvars.example
    cloudwatch-agent.json   configuración del agente de logs
    modules/                network, compute, data, storage, messaging, functions, secrets, monitoring
  scripts/
    deploy-on-instance.sh   se ejecuta en EC2 vía SSM
    deploy.sh               build de Lambdas, terraform apply, empaquetado, subida a S3 y SSM (lo usan las personas y el CD)
    update-gh-secrets.sh    copia credenciales del lab a secretos de GitHub
    seed.js                 jugadores y partidas de prueba (`--week <YYYY-Www>`, `--include-email <correo>`)
  backend/jest.config.js, lambdas/jest.config.js
  .github/workflows/ci.yml, cd.yml
  docs/
```

## 2. Configuración

Variables de entorno del backend, escritas en `/etc/friomx/backend.env` por el script de despliegue a partir de las salidas de Terraform. `config/env.js` falla al arrancar si falta alguna obligatoria.

| Variable | Ejemplo | Obligatoria |
|---|---|---|
| `PORT` | 3000 | no (3000) |
| `AWS_REGION` | us-east-1 | sí |
| `TABLE_USERS`, `TABLE_USER_EMAILS`, `TABLE_ACTIVITY`, `TABLE_WEEKLY_STATS`, `TABLE_RECHARGES`, `TABLE_GAME_ROUNDS`, `TABLE_LEADERBOARD` | friomx-users | sí |
| `JWT_SECRET_ARN` | arn:aws:secretsmanager:... | sí |
| `UPLOADS_BUCKET` | friomx-uploads-123456789012 | sí |
| `RECHARGE_QUEUE_URL` | https://sqs.us-east-1.amazonaws.com/.../friomx-recharges | sí |
| `USER_TOPIC_ARN` | arn:aws:sns:...:friomx-user-notifications | sí |
| `METRICS_NAMESPACE` | FrioMx | no (FrioMx) |
| `APP_TZ` | America/Mexico_City | no |

Las credenciales de AWS las da el perfil de instancia `LabInstanceProfile`. No hay llaves en archivos.

## 3. Contrato de la API

Todas las rutas van bajo `/api`. Las marcadas con candado requieren `Authorization: Bearer <token>`. El usuario se toma de `req.userId`, que sale del token. Ninguna ruta acepta `userId` ni `id` del cliente. Los errores responden `{ "error": "<mensaje>", "code": "<CODIGO>" }`. Las páginas de juego ya leen `error`. `register.js` se ajusta para leer `error` en lugar de `message`. `login.js` muestra un texto fijo y no necesita cambio, salvo mostrar el mensaje de 429 cuando se active el límite de intentos.

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
| GET /profile/image | 🔒 | | 200 `{success, profileImage}` (URL firmada, 15 min) |
| POST /games/hi-lo/deal | 🔒 | `{betAmount}` | 201 `{roundId, oldCard, newBalance}` |
| POST /games/hi-lo | 🔒 | `{roundId, prediction:"higher"\|"lower"}` | 200 `{won, oldCard, newCard, amountChange, newBalance}` |
| POST /games/roulette | 🔒 | `{bets:[{type, value, amount}]}` | 200 `{winningSlot, winningIndex, results, totalAmountChange, newBalance}` |
| POST /games/mines | 🔒 | `{betAmount, won}` | 200 `{won, amountChange, newBalance}`. Temporal de Fase 2, se elimina en Etapa 5 |
| POST /games/mines/start | 🔒 | `{betAmount}` | 201 `{gameId, boardSize:5, minesCount:5, newBalance}` |
| POST /games/mines/reveal | 🔒 | `{gameId, x, y}` | 200 ver 5.3 |
| GET /wallet/packages | 🔒 | | 200 `[{packageId, chips}]` |
| POST /wallet/recharges | 🔒 | `{packageId}` + cabecera `Idempotency-Key` (UUID) | 202 `{rechargeId, status}` |
| GET /wallet/recharges/:rechargeId | 🔒 | | 200 `{rechargeId, status, chips, createdAt, completedAt}` |
| GET /leaderboard/current | 🔒 | | 200 `{weekId, top:[{rank, name, net}], me:{rank, net, gamesPlayed}}` (top 10; `me.rank` sale del mismo orden y es `null` si no ha jugado en la semana) |
| GET /leaderboard/last | 🔒 | `?weekId=` opcional, solo semanas pasadas | 200 `{weekId, top:[{rank, name, net, prize}]}` o 404. Sin `weekId` regresa la semana anterior a la actual |
| GET /leaderboard/weeks | 🔒 | | 200 `[weekId]` de las semanas cerradas, de la más reciente a la más antigua |

Se eliminan respecto a la base: `PUT /user/balance`, `POST /user/activity`, las rutas de pagos, todas las rutas `/assets/*` (el frontend no las usa, solo están declaradas en `config.js`), y los parámetros `?id=` y `userId` en el cuerpo. `POST /games/mines` se conserva solo en Fase 2, ya sobre DynamoDB y con el usuario del token, y se elimina cuando entra minas en el servidor.

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
- `x`, `y`: enteros 0 a 4. `gameId`, `roundId` e `Idempotency-Key`: UUID v4. `rechargeId`: UUID v5, porque se deriva de la clave (`uuid.validate(x) && uuid.version(x) === 5`). `won` en `POST /games/mines`: booleano.
- Foto de perfil: campo `profileImage`, mimetype `image/jpeg|image/png|image/webp`, máximo 5 MB (multer con `limits.fileSize`). Fuera de eso, 400 VALIDATION_ERROR.
- Cuerpo JSON máximo 10 KB (`express.json({limit:"10kb"})`).
- `helmet` se monta solo en el backend (`/api`), que responde JSON. El servidor del frontend no lo usa: su política de contenido por defecto forzaría HTTPS en un sitio HTTP y bloquearía las fotos de S3.
- Límite de intentos en `/auth/login` y `/auth/register`: 10 por minuto por IP con `express-rate-limit` en versión fija (`limit: 10`). En login se usa `skipSuccessfulRequests: true` para contar solo fallos. El intento 11 dentro del minuto da 429 RATE_LIMITED. Los dos limitadores usan `handler: (req, res) => res.status(429).json({ error: "Demasiados intentos, espera un minuto", code: "RATE_LIMITED" })` para responder con el formato de error del contrato (por defecto responden texto plano). Hay una prueba con supertest del intento 11.

## 4. DynamoDB

Todas las tablas usan `PAY_PER_REQUEST`, cifrado por defecto y prefijo `friomx-`. Los números de fichas son enteros.

Notación: en este documento las expresiones se escriben abreviadas para leerlas fácil (por ejemplo `status = ACTIVE`). En el código todos los nombres de atributo van como `#placeholder` en `ExpressionAttributeNames` (obligatorio para palabras reservadas como `status`, `name`, `count` y `date`) y todos los valores como `:placeholder` en `ExpressionAttributeValues`, porque DynamoDB no acepta literales en expresiones. Cuando una transacción se cancela, el motivo se lee de `CancellationReasons` de `TransactionCanceledException`, que trae un código por ítem en el mismo orden de la petición.

### 4.1 Esquemas

**friomx-users** (PK `userId` S, UUID v4)
`name`, `age` N, `email`, `passwordHash`, `balance` N, `profileImageKey`, `notifySubscriptionArn`, `createdAt` (ISO UTC), `lastPlayedAt` (ISO UTC), `lastBonusDate` (`YYYY-MM-DD` local), `rechargeDate` (`YYYY-MM-DD` local), `rechargeCount` N.

**friomx-user-emails** (PK `email` S)
`userId`. Existe solo para garantizar unicidad del correo.

**friomx-activity** (PK `userId` S, SK `sk` S = `<createdAt ISO>#<gameId>`)
`gameId`, `nameGame` (`Hi-Lo`|`Ruleta`|`Mines`), `BetStatus` BOOL, `balance` N (ganancia neta, negativa si perdió), `dateGame` (ISO). Se conservan los nombres de campo de la base para que `activity.js` siga leyendo `nameGame`, `dateGame` y `balance` sin cambiar su lógica de pintado.

**friomx-weekly-stats** (PK `weekId` S `2026-W41`, SK `userId` S)
`net` N, `gamesPlayed` N, `name`.

**friomx-recharges** (PK `rechargeId` S)
`userId`, `packageId`, `chips` N, `status` (`PENDING`|`COMPLETED`), `createdAt`, `completedAt`. La API responde `FAILED` cuando `status = PENDING` y `createdAt` tiene más de 5 minutos. Ese valor no se guarda: si después la recarga se reprocesa desde la cola de fallidos y se completa, la API pasa a responder `COMPLETED`.

**friomx-game-rounds** (PK `gameId` S, TTL `expiresAt` N epoch)
`userId`, `game` (`hilo`|`mines`), `status` (`ACTIVE`|`DONE`|`WON`|`LOST`), `createdAt`.
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

**Cambio de contraseña.** Update users `SET passwordHash` (bcrypt, costo 10). Se usa `bcryptjs`, que ya trae la base y es JavaScript puro, así el paquete armado en el runner de GitHub corre en Amazon Linux sin compilar nada nativo.

**Reparto de hi-lo.** El reparto cobra la apuesta, igual que `start` en minas. Si fuera gratis, un jugador podría pedir cartas sin costo hasta que saliera una favorable y solo entonces apostar. `POST /games/hi-lo/deal` genera `oldCard` y ejecuta `TransactWriteItems`:
1. Update users `SET balance = balance - :bet, lastPlayedAt = :now` con `balance >= :bet`.
2. Put game-rounds `{gameId: roundId, userId, game:"hilo", oldCard, bet, weekId: <semana actual>, status:"ACTIVE", expiresAt: ahora+3600}`.
3. Update weekly-stats (semana actual) `ADD net :net, gamesPlayed :one SET #name = :name` con `:net = -bet`.
Una ronda abandonada pierde la apuesta, ya contada en el ranking.

**Jugada de hi-lo.** GetItem consistente de la ronda: si no existe o `expiresAt` ya pasó, 404. Si es de otro usuario o no es `hilo`, 403. Si no está `ACTIVE`, 409 GAME_FINISHED. `newCard` sale del generador y `net` del motor (§5.1). `TransactWriteItems`:
1. Update game-rounds `SET status = "DONE"` con `status = ACTIVE AND userId = :me`, para que una ronda no se juegue dos veces (si falla, 409 GAME_FINISHED).
2. Put activity con `attribute_not_exists(sk)` y `balance = net`.
3. Solo si gana: Update users `ADD balance :payout` con `:payout = bet + net` (devuelve la apuesta más la ganancia).
4. Solo si gana: Update weekly-stats de la semana guardada en la ronda `ADD net :payout` (sobre el −bet del reparto deja +net).
Responde `{won, oldCard, newCard, amountChange: net, newBalance}`, con el mismo significado que en la base.

**Jugada de un paso (ruleta).** Se calcula `net` con el motor. Luego `TransactWriteItems`:
1. Update users `SET balance = balance + :net, lastPlayedAt = :now` con `balance >= :bet`.
2. Put activity con `attribute_not_exists(sk)`.
3. Update weekly-stats `ADD net :net, gamesPlayed :one SET #name = :name`.

Si se cancela por la condición 1 → 409 INSUFFICIENT_FUNDS. Lo mismo aplica al ítem 1 del reparto de hi-lo y de `start` en minas. El motivo se lee de `CancellationReasons` de `TransactionCanceledException`, en el orden de los ítems. Si se cancela por `TransactionConflict` se reintenta hasta 3 veces con espera corta y si sigue → 409 CONFLICT. `newBalance` se obtiene con un GetItem consistente después de la transacción.

**Minas temporal (Fase 2).** Misma transacción de 3 ítems con `net = won ? 2*bet : -bet`, que es la regla de la base, con el usuario del token y la condición de saldo. El navegador sigue decidiendo `won`. Es una brecha conocida que se cierra en Etapa 5.

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

Funciones puras, sin acceso a AWS, para probarlas con unidades. El aleatorio se inyecta (`rng = crypto.randomInt` por defecto) para poder fijarlo en pruebas. Las reglas y pagos de ruleta y minas se conservan de la base. En hi-lo se conservan las cartas y la mecánica, pero se cambian los pagos (§5.1). En todos, los pagos se redondean hacia abajo a enteros.

### 5.1 Hi-lo

- Carta: `rng(2, 13)` (valores 2 a 12, igual que la base, que descartaba 1 y 13). `oldCard` se genera en el reparto (que cobra la apuesta) y `newCard` en la jugada.
- `higher` gana si `new > old`. `lower` gana si `new < old`. El empate pierde.
- `k` = cantidad de valores que ganan: `12 - old` para `higher` y `old - 2` para `lower`. Si `k = 0` (mayor con un 12 o menor con un 2) la predicción se rechaza con 400 y el navegador deshabilita ese botón.
- Si gana: `net = floor(bet * 0.95 * 11 / k) - bet`. Si pierde: `net = -bet`. El pago es inversamente proporcional a la probabilidad de ganar (`k/11`), con una ventaja de la casa de 5%: entre menos cartas ganan, más paga.
- Motivo del cambio: en la base el empate gana y el multiplicador está entre 1.15 y 1.92 para cualquier carta. Jugando bien, el valor esperado es positivo con todas las cartas (con 2 o 12 se gana siempre), así que hi-lo crearía fichas sin límite y decidiría el ranking semanal y sus premios.

### 5.2 Ruleta

- Rueda europea de 37 casillas, misma tabla que la base, `index = rng(0, 37)`. El 0 es `Verde` y no tiene paridad ni docena.
- Cada apuesta paga 1 a 1: `+amount` si acierta, `-amount` si no. Con el 0 gana solo la apuesta a `Verde` y pierden las demás. Es la regla de la base, sin cambios. `net` es la suma.

### 5.3 Minas

Tablero 5×5 (índice `i = x*5 + y`), 5 minas. Es la versión en el servidor (Etapa 5) que reemplaza a `POST /games/mines`.

- **start**: `mines` = 5 índices distintos con `rng`. `TransactWriteItems`: Update users `SET balance = balance - :bet, lastPlayedAt = :now` con `balance >= :bet`, Put game-rounds `{game:"mines", weekId: <semana actual>, status:"ACTIVE", revealed:[], version:0, expiresAt: ahora+3600}`, y Update weekly-stats (semana actual) `ADD net :net, gamesPlayed :one SET #name = :name` con `:net = -bet`. La pérdida cuenta en el ranking desde que se apuesta, así abandonar una partida que va mal no mejora la posición.
- **reveal(x, y)**: GetItem consistente de la partida. Si no existe o `expiresAt` ya pasó → 404 (el borrado por TTL puede tardar, por eso se revisa a mano). Si `userId` no coincide o `game` no es `mines` → 403. Si `status != ACTIVE` → 409 GAME_FINISHED. Si la casilla ya está destapada se responde el estado actual sin cambios.
  - Si es mina: `TransactWriteItems`: Update partida `SET status="LOST", version = version + 1` con `version = :v AND status = ACTIVE`, Put activity (`net = -bet`, `BetStatus=false`). Weekly-stats no se toca porque la pérdida ya se sumó en `start`. Responde `{result:"mine", status:"LOST", mines:[...], newBalance}`.
  - Si no es mina: se destapa solo esa casilla, igual que el clic de la base (`reveal` en `mine.js`, sin relleno ni número de minas vecinas). Responde `{result:"safe", cell:{x,y}, status}`.
  - Si con eso quedan destapadas las 20 casillas seguras: `TransactWriteItems` con Update partida `SET status="WON", version = version + 1` con `version = :v AND status = ACTIVE` (así un segundo clic simultáneo sobre la última casilla falla y no cobra dos veces), Update users `ADD balance :tripleBet`, Put activity (`net = +2*bet`, `BetStatus=true`), Update weekly-stats de la semana guardada en la partida (`weekId`, no la actual) `ADD net :net` con `:net = 3*bet` (sobre el −bet de `start` deja +2×bet). Así el neto es +2×apuesta al ganar y −apuesta al perder, igual que la base. Responde `{result:"safe", cell:{x,y}, status:"WON", mines:[...], newBalance}`.
  - Si no: Update partida `SET revealed = :nuevo, version = version + 1` con `version = :v AND status = ACTIVE`.
  - Si falla la condición de versión (dos clics simultáneos) → 409 CONFLICT y el navegador repite el mismo destape. Como una casilla ya destapada responde el estado actual sin cambios, el reintento siempre es seguro.
- Las banderas siguen siendo solo visuales en el navegador.
- Una partida abandonada pierde la apuesta (ya se cobró y ya contó en el ranking) y desaparece por TTL. No genera entrada de historial. Limitación aceptada y documentada.
- En hi-lo, la jugada también trata una ronda con `expiresAt` vencido como inexistente.

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
- Para la demo se puede invocar a mano con `aws lambda invoke --function-name friomx-weekly-ranking --cli-binary-format raw-in-base64-out --payload '{"weekId":"<semana>"}' out.json` (la CLI v2 necesita `--cli-binary-format` para JSON en texto). Como cada semana se cierra una sola vez y la regla del lunes cierra sola la semana anterior, para repetir la prueba se elige una semana pasada que no esté cerrada (por ejemplo una de hace varias semanas), se corre `scripts/seed.js --week <semana>` y se invoca con esa semana.

### 6.4 Utilidades compartidas (`lib/time.js` y `lambdas/shared/time.js`)

- `localDate(now)`: `YYYY-MM-DD` en `America/Mexico_City` con `Intl.DateTimeFormat`.
- `isoWeekId(now)`: semana ISO 8601 de la fecha local, formato `YYYY-Www`. Las pruebas cubren el cambio de año (ejemplo, 2026-12-31 es `2026-W53`, 2027-01-04 es `2027-W01`).

## 7. SNS

- **friomx-user-notifications.** Cuota por defecto de 200 políticas de filtro por tema, suficiente para el curso. En el registro: `Subscribe(Protocol="email", Endpoint=email, Attributes.FilterPolicy={"audience":[userId,"all"]}, ReturnSubscriptionArn=true)`. Se guarda `notifySubscriptionArn`. El jugador recibe el correo de confirmación de AWS y debe aceptarlo. Toda publicación lleva `MessageAttributes.audience` (String) con el `userId` destinatario. El valor `all` queda reservado para avisos generales.
- **friomx-ops-alerts.** Suscripciones de correo de los tres integrantes, creadas por Terraform desde la variable `alert_emails`. Recibe las alarmas.

## 8. EC2

- Amazon Linux 2023, `t3.small`, subred pública de la VPC por defecto, IP elástica, `LabInstanceProfile`, IMDSv2 obligatorio, disco gp3 de 16 GB.
- Grupo de seguridad: entrada TCP 80 desde `0.0.0.0/0`. Sin puerto 22. Salida abierta.
- `user_data` (solo en la primera creación): instala Node.js 22, nginx y el paquete del agente de CloudWatch, sin configurarlo. Crea el usuario `friomx` y los directorios `/var/log/friomx` (dueño `friomx`), `/opt/friomx/releases` y `/etc/friomx`. Registra dos servicios `systemd`, habilitados al arranque. `friomx-backend` usa `User=friomx`, `WorkingDirectory=/opt/friomx/current/backend`, `EnvironmentFile=/etc/friomx/backend.env` y `ExecStart=/usr/bin/node server.js`. `friomx-frontend` usa `User=friomx`, `WorkingDirectory=/opt/friomx/current/frontend` y `ExecStart=/usr/bin/node server.js`. El backend lee sus variables de `EnvironmentFile` y no de un `.env`, que no viene en el paquete. Los dos llevan `After=network-online.target`, `Wants=network-online.target`, `Restart=always`, `RestartSec=5` y `StartLimitIntervalSec=0`. Así, si al arrancar la red o el secreto todavía no responden, el servicio reintenta cada 5 s sin quedar en `failed`.
- nginx:

```
server {
  listen 80;
  client_max_body_size 6m;
  location /api/ { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }
  location /     { proxy_pass http://127.0.0.1:8080; }
}
```

- El archivo de nginx va en `/etc/nginx/conf.d/friomx.conf`. El `user_data` quita el bloque `server` que trae por defecto `/etc/nginx/nginx.conf` de Amazon Linux 2023 para que no compita por el puerto 80, valida con `nginx -t` y habilita el servicio con `systemctl enable --now nginx` (en Amazon Linux 2023 instalarlo no lo arranca).
- Express usa `app.set("trust proxy", 1)` para que el límite de intentos vea la IP real.
- Un archivo de más de 6 MB lo rechaza nginx con 413 antes de llegar al backend. `profile.js` valida 5 MB antes de subir, así el jugador ve el mensaje propio en lugar del 413.
- Los servicios escriben su salida en `/var/log/friomx/backend.log` y `frontend.log` (`StandardOutput=append:` en `systemd`), con rotación por `logrotate` usando `copytruncate`, porque `systemd` abre el archivo una sola vez y un renombrado dejaría al proceso escribiendo en el archivo viejo. La configuración del agente vive en el repositorio (`infra/cloudwatch-agent.json`) y, desde la tarea 6.2, `deploy-on-instance.sh` la aplica en cada despliegue con `amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:<ruta> -s`. Así un cambio no depende del `user_data`. Los logs van a `/friomx/backend` y `/friomx/frontend` (14 días).

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

- Terraform `>= 1.11` (bloqueo nativo en S3 estable), proveedor `hashicorp/aws ~> 5.0`.
- Backend: `backend "s3" {}` con `-backend-config=backend.hcl` (`bucket`, `key = "lab/terraform.tfstate"`, `region`, `use_lockfile = true`).
- `data "aws_iam_role" "lab" { name = "LabRole" }` y `data "aws_iam_instance_profile" "lab" { name = "LabInstanceProfile" }`. Ningún módulo crea recursos IAM.
- Módulos:

| Módulo | Recursos |
|---|---|
| network | security group, `aws_eip` y asociación, datos de VPC y subred por defecto |
| compute | `aws_instance` con `user_data`, `lifecycle.ignore_changes = [user_data, ami]` |
| data | 7 `aws_dynamodb_table` (TTL en game-rounds) |
| storage | buckets de uploads y artefactos, bloqueo público, cifrado, ciclo de vida |
| secrets | `random_password`, secreto y versión |
| messaging | colas, redrive, temas SNS, suscripciones de alertas |
| functions | `archive_file` por Lambda, `aws_lambda_function` con `source_code_hash`, `aws_lambda_event_source_mapping`, `aws_cloudwatch_event_rule`/`target`, `aws_lambda_permission`, grupos de logs |
| monitoring | alarmas y `aws_cloudwatch_dashboard` |

- Salidas: IP elástica, id de instancia, nombres de tablas, URL de la cola, ARNs de temas y del secreto, buckets. El CD las lee con `terraform output -json`.

## 14. Despliegue de la aplicación (`scripts/deploy-on-instance.sh`)

`scripts/deploy.sh` arma `releases/<sha>.tgz` con `backend/` y `frontend/` (cada uno con `npm ci --omit=dev`), `scripts/deploy-on-instance.sh` y, si existe (desde la tarea 6.2), `infra/cloudwatch-agent.json`. Lo sube a S3 junto con un `env` generado con las salidas de Terraform. Luego ejecuta `aws ssm send-command --document-name AWS-RunShellScript`, cuyos `commands` descargan el tgz con `aws s3 cp`, lo descomprimen en `/opt/friomx/releases/<sha>` y corren el `deploy-on-instance.sh` que viene dentro. El script en la instancia:

1. Descarga el `env` de S3 (el tgz ya lo descomprimieron los `commands` del `send-command`).
2. Copia el `env` a `/etc/friomx/backend.env` (permisos 600, dueño `friomx`).
3. Desde la tarea 6.2, aplica la configuración del agente de CloudWatch con `amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:<versión>/infra/cloudwatch-agent.json -s`.
4. Guarda el destino actual de `/opt/friomx/current` como previo y apunta el enlace a la versión nueva.
5. `systemctl restart friomx-backend friomx-frontend`.
6. Hasta 10 intentos de `curl -fs http://127.0.0.1/api/health` cada 3 s.
7. Si falla, regresa el enlace a la versión previa, reinicia y termina con error para que el pipeline quede rojo.
8. Conserva las últimas 3 versiones y borra las demás.

## 15. CI/CD

`ci.yml`, en `pull_request` hacia `main`:
- Jobs en paralelo: `backend` (Node 22, `npm ci`, `npm test -- --coverage`), `lambdas` (igual) y `terraform` (`hashicorp/setup-terraform` con versión fija 1.11.x, `fmt -check`, `init -backend=false`, `validate`). El job `deploy` del CD también usa `hashicorp/setup-terraform` con la misma versión.
- `backend/jest.config.js` define `collectCoverageFrom: ["src/**/*.js"]` y `lambdas/jest.config.js` define `["*/index.js", "shared/**/*.js", "!dist/**"]`. Los dos usan `coverageThreshold.global`, que arranca en 0 (al inicio casi todo el código importado no tiene pruebas y un umbral más alto bloquearía todos los PR), sube a 30 al cerrar la Etapa 3 (tarea 3.7) y a 70 en líneas, ramas, funciones y sentencias en la tarea 5.4.
- Protección de `main`: pull request obligatorio, 1 aprobación, los 3 jobs en verde.

`cd.yml`, en `push` a `main`:
- `concurrency: { group: deploy-lab, cancel-in-progress: false }`.
- Job `test`: lo mismo que CI.
- Job `deploy` (necesita `test`): credenciales con `aws-actions/configure-aws-credentials` usando `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y `AWS_SESSION_TOKEN`. Escribe `backend.hcl` y `lab.tfvars` a partir de los secretos `TF_BACKEND_HCL` y `TF_LAB_TFVARS` (este último lleva `alert_emails`) y ejecuta `scripts/deploy.sh`, el mismo que se usa a mano. Ese script hace `lambdas/build.sh`, `terraform init -backend-config=backend.hcl`, `terraform apply -auto-approve -var-file=lab.tfvars`, empaquetado, subida a S3, `send-command`, espera del resultado con un ciclo propio de `aws ssm get-command-invocation` cada 5 s y tope de 5 minutos (tratando `InvocationDoesNotExist` como pendiente, porque los primeros segundos la invocación todavía no aparece; solo termina con `Success`, `Failed`, `Cancelled` o `TimedOut`), que imprime `StandardOutputContent` y `StandardErrorContent` (el waiter de la CLI se rinde a los 100 s), y prueba de humo `curl` a `http://<ip>/api/health`.

`scripts/update-gh-secrets.sh` lee el bloque `[default]` de `~/.aws/credentials` (pegado desde "AWS Details" del lab) y corre `gh secret set` para las tres variables. Se ejecuta al iniciar cada sesión del lab. `TF_BACKEND_HCL` y `TF_LAB_TFVARS` se crean una sola vez con `gh secret set ... < archivo` a partir de `backend.hcl` y `lab.tfvars`, que se copian de los `.example` versionados. El README documenta los dos pasos.

## 16. Pruebas unitarias

- Jest y `aws-sdk-client-mock` para simular DynamoDB, SQS, SNS, S3, Secrets Manager y CloudWatch. `supertest` sobre `src/app.js` para rutas.
- Casos mínimos:
  - gameEngine: hi-lo con empate (pierde), `k = 0` rechazado, valor esperado menor o igual a 0.95 para todo `k` de 1 a 10 y apuesta de 1 a 10 000 (el `floor` lo baja con apuestas chicas), cercano a 0.95 (±0.01) con apuesta de 10 000, y `net` nunca negativo al ganar, ruleta en 0 (gana solo Verde) y en cada tipo de apuesta, generación de minas sin repetidos, condición de victoria.
  - hi-lo: ronda inexistente, ajena, vencida o ya jugada; reparto con saldo insuficiente; pago de apuesta más ganancia al ganar y nada al perder.
  - gameService: transacción con condición de saldo, mapeo de `ConditionalCheckFailed` a 409, reintento ante `TransactionConflict`.
  - walletService: paquete inválido, variantes A y B del contador, límite diario, idempotencia (recarga existente), fallo de SQS a 503, dos recargas simultáneas en el primer uso del día (las dos pasan), reintento de una recarga ya creada con el cupo agotado (debe dar 202, no 429), estado `FAILED` a los 5 minutos, `GET /wallet/recharges/:id` con un id v5 responde 200.
  - auth: registro duplicado, login inválido, token expirado, ruta protegida sin token.
  - Lambdas: recarga duplicada sin doble abono, fallo parcial en el lote, bono dos veces el mismo día, cierre de semana repetido, cierre con `weekId` de la semana en curso (rechazado), semana sin ganadores, `isoWeekId` en cambio de año.
- Las pruebas no tocan AWS real.

## 17. Cambios al frontend

| Archivo | Cambio |
|---|---|
| `scripts/config.js` | `BASE_URL = "/api"`. Quitar las constantes de assets. Las constantes de pagos se quitan junto con el cambio de `balance.js`, porque hoy esa página las usa al cargar. Agregar `HILO_DEAL`, `WALLET_PACKAGES`, `WALLET_RECHARGES`, `MINES_START`, `MINES_REVEAL`, `LEADERBOARD_CURRENT`, `LEADERBOARD_LAST`, `LEADERBOARD_WEEKS`. |
| `env-config.sh` | Se elimina. Las URLs ahora son relativas a `/api`. |
| `hi-lo.js`, `roulette.js`, `mine.js`, `balance.js`, `profile.js`, `activity.js` | Quitar `?id=` y `userId` de las peticiones (en `profile.js` también el `id` del cuerpo del PUT). |
| `hi-lo.html` | Agregar el botón "Repartir". El espacio de la carta muestra un reverso hasta que llega la carta del servidor. Renombrar "Mayor o igual" y "Menor o igual" a "Mayor" y "Menor", porque el empate ahora pierde. |
| `rules.html` | Reescribir la explicación de hi-lo: apuesta, reparto, mayor o menor, el empate pierde, y el pago depende de la probabilidad de ganar. |
| `hi-lo.js` | Quitar el mazo local. La ronda tiene dos estados, descritos debajo de esta tabla. |
| `roulette.js`, `roulette.html` | Sin cambios en apuestas. La apuesta a Verde se conserva. |
| `login.js`, `register.js` | Siguen guardando `data.user.id` en `localStorage`, que la API conserva, así `balance.js`, `profile.js` e `indexLoading.js` siguen viendo la sesión. `login.js` muestra el mensaje de 429 (tarea 5.6). |
| `balance.js`, `balance.html` | Reemplazar depósito con Stripe y retiro por tres botones de paquete. Al elegir uno: genera un UUID v4 como `Idempotency-Key` (receta debajo de la tabla), hace POST, consulta el estado cada 2 s durante 30 s y luego cada 15 s hasta ver `COMPLETED` o `FAILED` (máximo 6 minutos), y actualiza saldo. Si el jugador sale de la página, al volver se consulta la última recarga guardada en `localStorage`. Reintenta con la misma clave si recibe 503. |
| `mine.js` | Fase 2: quitar `userId` del cuerpo de `POST /games/mines`. Corregir dos defectos de la base: hoy cada clic en "Jugar" vuelve a agregar los listeners de las casillas, así que desde la segunda partida el resultado se reporta varias veces, y el tablero se crea una sola vez al cargar, así que las minas no cambian entre partidas. Los listeners se agregan una vez, el tablero se regenera en cada partida y una bandera evita reportar el resultado más de una vez. Etapa 5: quitar la generación local de minas, llamar `start` al apostar y `reveal` en cada clic, pintar la casilla que regresa el servidor y las minas al perder. |
| `activity.js` | Cambiar "USD" por "fichas", leer el arreglo `items` y agregar un botón "ver más" que pide `?cursor=${encodeURIComponent(nextCursor)}`. |
| `profile.js` | No mostrar contraseña (la API no la regresa). La foto llega como URL firmada. Validar 5 MB e imagen antes de subir. |
| `register.js` | Mandar `age` como número, validar contraseña de al menos 8 caracteres y máximo 72 bytes y leer el mensaje de error de `error`. Mensaje de éxito: "Revisa tu correo para activar las notificaciones". |
| Todas las páginas `.html` | Quitar `<script src="env.js">`, que generaba `env-config.sh`. |
| `hi-lo.js`, `roulette.js`, `mine.js` | Validar en el navegador que la apuesta sea un entero de 1 a 10 000 (hoy se usa `parseFloat`). |
| `server.js` | Solo en desarrollo: si existe `API_PROXY_TARGET` (por ejemplo `http://localhost:3000`), reenviar `/api/*` a esa dirección con `http-proxy-middleware` v3 en versión fija, declarado en `dependencies` y cargado con `require` solo dentro del `if`, así en EC2 no hace falta. Se monta como `app.use(createProxyMiddleware({ target, pathFilter: "/api" }))` para que conserve el prefijo `/api` (montado con `app.use("/api", ...)` lo quitaría y el backend respondería 404). En EC2 la variable no existe y nginx hace ese trabajo. |
| `leaderboard.html`, `scripts/leaderboard.js`, ruta `/leaderboard` en `server.js` | Página nueva con ranking en curso, última semana cerrada y un selector de semanas cerradas (`/leaderboard/weeks`). Se agrega `goToLeaderboard()` en `indexLoading.js` y el botón en la barra de navegación de las páginas con sesión. |
| Todas las páginas | Ante 401 en una ruta con candado, limpiar `localStorage` y mandar a `/logIn`. `/auth/login` y `/auth/register` quedan fuera de esa regla para que `login.js` pueda mostrar su mensaje de credenciales inválidas. |

UUID de la recarga en `balance.js`: `crypto.randomUUID()` solo existe en HTTPS o `localhost`, y la app se sirve por HTTP. Por eso se generan 16 bytes con `crypto.getRandomValues`, se fijan la versión (byte 6: `(b & 0x0f) OR 0x40`) y la variante (byte 8: `(b & 0x3f) OR 0x80`), y se formatean en hexadecimal con guiones en formato 8-4-4-4-12 (`xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`), que es lo que acepta la validación de UUID v4 del backend. Como el frontend no tiene corredor de pruebas, esto se verifica en el paso 7 de la prueba de humo del plan (recarga desde `http://<ip>`), y el backend tiene una prueba que rechaza claves sin guiones.

Estados de la ronda en `hi-lo.js`:

- **Sin ronda.** El campo de apuesta y "Repartir" están habilitados, mayor y menor deshabilitados. La validación de apuesta entera y saldo suficiente, que hoy está en los botones mayor y menor, pasa a "Repartir". Al repartir se llama `POST /games/hi-lo/deal`, se guarda `roundId` y se pintan `oldCard` y el `newBalance`, que ya trae la apuesta descontada.
- **Con ronda.** La apuesta y "Repartir" están deshabilitados. Mayor y menor están habilitados, salvo el que tenga `k = 0` (§5.1). Cada botón manda `POST /games/hi-lo` con `{roundId, prediction}`, sin revisar saldo.
- Al terminar la ronda, o al recibir 404 (vencida) o 409 GAME_FINISHED, se borra `roundId` y se vuelve a "sin ronda".
