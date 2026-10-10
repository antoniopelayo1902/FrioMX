# FrioMx

Casino social en línea con fichas virtuales (sin dinero real), desplegado en AWS.
Proyecto integrador de la materia Desarrollo en la Nube, ITESO, Otoño 2026.

## Descripción

FrioMx permite a los usuarios registrarse, recibir fichas de bienvenida y un bono
diario, y apostarlas en tres juegos: ruleta, hi-lo y minas. Toda la lógica de
juego corre en el servidor para garantizar resultados justos. Cada partida se
registra en un historial personal y alimenta un ranking semanal de jugadores.

## Flujos end-to-end

1. Jugar una partida: apuesta validada, resultado calculado en el servidor,
   saldo e historial actualizados.
2. Recarga de fichas: solicitud encolada en SQS, acreditada por una Lambda y
   confirmada por correo con SNS.
3. Bono diario y ranking semanal: tareas programadas con EventBridge que
   acreditan fichas, cierran el ranking y notifican a los ganadores.

## Servicios de AWS

EC2, DynamoDB, Lambda, SQS, SNS, EventBridge, S3, Secrets Manager, CloudWatch.

## Equipo

| Integrante | Rol |
|---|---|
| Emilio Bracamontes | Flujo 1 (motor de juegos) + Frontend |
| Antonio Pelayo | Flujo 2 (recargas asíncronas) + CI/CD |
| Alan | Flujo 3 (bono y ranking) + Monitoreo |

## Estado

Fase 3. Los tres flujos corren en AWS Learner Lab y se despliegan con un solo
script (`scripts/deploy.sh`) o con el CD al hacer merge a `main`:

- Juegos (ruleta, hi-lo y minas) con historial, en EC2 con DynamoDB.
- Recargas asíncronas: SQS, Lambda `friomx-recharge-worker` y correo por SNS.
- Bono diario y ranking semanal: EventBridge con las Lambdas
  `friomx-daily-bonus` y `friomx-weekly-ranking`, página de Ranking.
- Foto de perfil en S3 con URL firmada.
- Monitoreo: 5 métricas, 2 alarmas con correo al equipo y dashboard `FrioMx`.
- Pruebas: 70% de cobertura mínima en backend y Lambdas, y pruebas de punta a
  punta del frontend con Playwright.
- Scripts de operación del lab: arranque, prueba de humo, revisión del
  monitoreo y destrucción.

En local corren juegos, historial, perfil sin foto y ranking de la semana en
curso (ver [Notas](#notas)).

## Pendiente

- Verificación del monitoreo en la nube: el dashboard `FrioMx` y las 2 alarmas
  (`friomx-api-5xx` y `friomx-recharge-dlq`) están en Terraform (módulo
  `monitoring`). Se comprueban en cada sesión con
  `bash scripts/monitoring-check.sh` y `--demo-alarms` (ver
  [Operación del lab](#operación-del-lab)); falta dejar registro de una corrida
  con los correos de alarma recibidos.
- Fuera de alcance: HTTPS, porque el lab no ofrece dominio ni certificado.
- Para el reporte en PDF: el diagrama de arquitectura (`docs/02-HLD.md`,
  sección 3) está en mermaid. Hay que exportarlo a imagen, por ejemplo
  pegándolo en [mermaid.live](https://mermaid.live) y descargando PNG o SVG, o
  rehacerlo en draw.io.

## Correr en local

En local la app corre sin AWS: la base de datos es DynamoDB Local en tu
máquina. Se usan tres terminales, una por proceso:

| Proceso | Puerto |
|---|---|
| DynamoDB Local | 8000 |
| Backend (API) | 3000 |
| Frontend | 8080 |

### Requisitos

- Node.js 20 o superior (`node -v`).
- Java 17 o superior (`java -version`) para DynamoDB Local. Si prefieres
  Docker, ve la alternativa en el paso 1.

### Primera vez (solo una vez)

1. Descargar DynamoDB Local en una carpeta **fuera del repo**:
   ```
   mkdir -p ~/DynamoDBLocal && cd ~/DynamoDBLocal
   curl -O https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz
   tar -xzf dynamodb_local_latest.tar.gz
   ```
2. Clonar el repo e instalar dependencias:
   ```
   git clone https://github.com/antoniopelayo1902/FrioMX.git
   cd FrioMX/backend && npm ci
   cd ../frontend && npm ci
   ```
3. Crear el `.env` del backend:
   ```
   cd ../backend
   cp .env.example .env
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Copia el valor que imprime el último comando en `JWT_SECRET=` dentro de
   `backend/.env`. El `.env` no se sube al repo.

### Cada vez que quieras levantarla

1. **Terminal 1, DynamoDB Local:**
   ```
   cd ~/DynamoDBLocal
   java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -inMemory -port 8000
   ```
   Con Docker en lugar de Java:
   ```
   docker run --rm -p 8000:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -inMemory
   ```
2. **Terminal 2, backend** (crea las tablas y arranca la API):
   ```
   cd FrioMX/backend
   npm run db:local:tables
   npm start
   ```
   Para comprobar que está arriba: http://localhost:3000/api/health debe
   responder `{"status":"ok"}`.
3. **Terminal 3, frontend:**
   ```
   cd FrioMX/frontend
   npm run dev
   ```
4. Abrir http://localhost:8080, crear una cuenta en **Registro** y jugar. Cada
   cuenta nueva empieza con 1000 fichas.

Para apagar todo, `Ctrl+C` en cada terminal.

### Notas

- DynamoDB Local corre en memoria (`-inMemory`): al apagarlo se borran las
  cuentas y las partidas. Al volver a levantarlo hay que correr otra vez
  `npm run db:local:tables` y crear una cuenta nueva.
- Si un puerto está ocupado, libéralo con `lsof -ti tcp:8000,3000,8080 | xargs kill`.
- En local sí funcionan los juegos, el historial, el perfil y el ranking de la
  semana en curso (se llena jugando; con dos o tres cuentas se ve el orden).
- No funcionan en local porque dependen de AWS, y la app lo avisa sin
  romperse: la foto de perfil ("estará disponible pronto"), las recargas
  ("no están disponibles por ahora", 503) y las Lambdas programadas (bono
  diario y cierre semanal). Por eso "Semanas cerradas" sale vacío en local.

## Desplegar en AWS (Learner Lab)

Todo se crea con Terraform y se despliega con `scripts/deploy.sh`, desde tu
máquina (macOS o Linux). Los comandos se corren desde la raíz del repo
(`FrioMX/`) salvo que se diga otra cosa.

### Requisitos

| Herramienta | Versión | Comprobar |
|---|---|---|
| AWS CLI | v2 | `aws --version` |
| Terraform | 1.16.x recomendado (el de CI y CD), mínimo 1.11 | `terraform version` |
| Node.js y npm | 22 recomendado (el de la nube), 20 o superior sirve | `node -v` |
| git | cualquiera reciente | `git --version` |
| GitHub CLI (`gh`) | opcional, solo para el CD | `gh --version` |

`deploy.sh` también usa `curl` y `tar`, que ya vienen en macOS y Linux.

### 1. Iniciar el lab y configurar credenciales

Hay que repetir este paso en cada sesión del lab, porque las credenciales
cambian cada vez.

1. En AWS Academy abre el Learner Lab y pulsa **Start Lab**. Espera a que el
   punto junto a "AWS" esté verde.
2. Pulsa **AWS Details** y, junto a "AWS CLI", **Show**. Copia el bloque
   completo (`[default]`, `aws_access_key_id`, `aws_secret_access_key` y
   `aws_session_token`) y pégalo en `~/.aws/credentials`, reemplazando lo que
   hubiera en `[default]`:
   ```
   mkdir -p ~/.aws
   nano ~/.aws/credentials
   ```
3. Solo la primera vez, fija la región en `~/.aws/config`:
   ```
   [default]
   region = us-east-1
   output = json
   ```
4. Comprueba que la CLI entra a la cuenta del lab:
   ```
   aws sts get-caller-identity
   ```
   Debe mostrar tu número de cuenta y un ARN con `voclabs`. Si dice
   `ExpiredToken` o `InvalidClientTokenId`, vuelve a copiar el bloque.

### 2. Preparar Terraform (solo la primera vez)

1. Crear el bucket del estado de Terraform y guardar su configuración. Se
   escribe primero a un archivo temporal fuera del repo y solo se mueve si el
   script terminó bien, así un error (por ejemplo, credenciales vencidas) no
   deja un `backend.hcl` vacío:
   ```
   TMP_HCL="$(mktemp)"
   bash infra/bootstrap/bootstrap-state.sh > "$TMP_HCL" && mv "$TMP_HCL" infra/envs/lab/backend.hcl
   cat infra/envs/lab/backend.hcl
   ```
   Crea (o deja como está) el bucket privado y versionado
   `friomx-tfstate-<cuenta>`. Se puede volver a correr sin problema. Si falla,
   revisa el paso 1 y repítelo; un `backend.hcl` anterior queda intacto.
2. Crear las variables del lab y poner los correos reales del equipo, que
   recibirán las alarmas:
   ```
   cp infra/envs/lab/lab.tfvars.example infra/envs/lab/lab.tfvars
   nano infra/envs/lab/lab.tfvars
   ```
   `alert_emails` es obligatoria: Terraform se detiene si está vacía o si
   quedan los correos `@example.com` del ejemplo.
   Deja `region = "us-east-1"`: es la región del Learner Lab y la que permite
   la política de seguridad del frontend para las fotos. `instance_type` puede
   quedarse como está.

`backend.hcl` y `lab.tfvars` no se suben al repo.

### 3. Desplegar

```
bash scripts/deploy.sh
```

El script arma las Lambdas, corre `terraform init` y `terraform apply`,
empaqueta backend y frontend, los sube a S3, ordena a la instancia por SSM que
instale la versión nueva y al final prueba `/api/health` y `/login`. La
primera vez tarda entre 10 y 15 minutos, casi todo esperando a que la instancia
nueva instale Node.js y nginx; los siguientes tardan unos minutos.
Termina con una línea como esta:

```
==> Salud OK (intento 1). FrioMx en http://<public_ip>/
```

Esa es la URL de la app. Para verla otra vez:

```
terraform -chdir=infra/envs/lab output -raw public_ip
```

Opciones útiles:

- `bash scripts/deploy.sh --skip-terraform` vuelve a desplegar solo la app
  (no arma Lambdas ni aplica Terraform; lee las salidas del estado).
- Si falla por tiempo de espera la primera vez, vuelve a correrlo: es seguro
  repetirlo. Para esperar más: `DEPLOY_TIMEOUT=1200 bash scripts/deploy.sh`
  (por defecto 900 s, que también es el tope del comando en la instancia; `SSM_WAIT`, 300 s por defecto, es la espera a que la
  instancia aparezca en SSM).

### 4. Confirmar los correos de SNS

AWS no manda nada a un correo hasta que su dueño confirma la suscripción.

- **Equipo:** cada correo de `alert_emails` recibe "AWS Notification -
  Subscription Confirmation" del tema `friomx-ops-alerts`. Pulsa **Confirm
  subscription**. Ahí llegan las alarmas.
- **Jugadores:** al registrarse en la app, cada jugador recibe la misma clase
  de correo del tema `friomx-user-notifications`. Sin confirmarlo la app
  funciona igual, pero no llegan los avisos de recarga, bono ni premio.

Revisa también la carpeta de spam.

### 5. Probar los tres flujos

Abre `http://<public_ip>/`, crea una cuenta con un correo tuyo y confirma el
correo de SNS que te llega.

**Flujo 1, jugar.** Juega una ruleta, un hi-lo o una partida de minas y abre
**Historial**: la partida aparece con su resultado y el saldo cambia.

**Flujo 2, recargar.** En **Saldo** elige un paquete (500, 1000 o 2500
fichas). Se ve "Procesando tu recarga…" y en unos segundos "Listo, se sumaron
N fichas a tu saldo". Llega el correo "FrioMx: recarga lista". El límite es
de 3 recargas por día.

**Flujo 3, bono diario y ranking semanal.** Las reglas de EventBridge los
corren solos (bono a las 08:00 y cierre del ranking los lunes a las 01:10,
hora de Ciudad de México). Para probarlos sin esperar, desde la raíz del repo:

1. Bono diario. Se lo lleva quien jugó en los últimos 7 días (por eso primero
   juega una partida):
   ```
   aws lambda invoke --function-name friomx-daily-bonus \
     --cli-binary-format raw-in-base64-out --payload '{}' out.json
   cat out.json
   ```
   Si aún no recibiste el bono de hoy, responde `"granted"` mayor a 0, tu
   saldo sube 100 fichas y llega el correo "FrioMx: bono diario". Si ya lo
   recibiste (por ejemplo, de la regla de las 08:00), o al repetirlo el mismo
   día, no acredita otra vez y cuenta en `"skipped"`.
2. Ranking semanal. Cada semana se cierra una sola vez, así que se usa una
   semana pasada que nadie haya cerrado, por ejemplo la de hace 3 semanas.
   Corre solo la línea de tu sistema:
   ```
   WEEK=$(date -v-21d +%G-W%V)
   ```
   (en macOS) o
   ```
   WEEK=$(date -d '21 days ago' +%G-W%V)
   ```
   (en Linux), y revisa que `echo "$WEEK"` imprima algo como `2026-W38`.
   Siembra jugadores ficticios en esa semana con tu cuenta en primer lugar
   (`seed.js` usa las dependencias de `backend/`, por eso el `npm ci`):
   ```
   (cd backend && npm ci)
   node scripts/seed.js --week "$WEEK" --include-email <tu correo de la app>
   ```
   Cierra la semana:
   ```
   aws lambda invoke --function-name friomx-weekly-ranking \
     --cli-binary-format raw-in-base64-out --payload "{\"weekId\":\"$WEEK\"}" out.json
   cat out.json
   ```
   Responde `"status":"CLOSED"` con el top 3. Ganas 1000 fichas, te llega el
   correo del premio y la semana aparece en **Ranking**, en "Semanas cerradas"
   (o directo en `http://<public_ip>/ranking?weekId=<semana>`). `seed.js`
   rechaza la semana en curso y las ya cerradas; si dice que está cerrada,
   elige otra (por ejemplo `-v-28d` o `'28 days ago'`).

`out.json` es solo la respuesta de la Lambda; bórralo al terminar.

Las alarmas, métricas y el dashboard están en CloudWatch, en la consola del
lab (**Dashboards → FrioMx**).

### 6. Despliegue continuo (CD)

Cada merge a `main` corre las pruebas y después `scripts/deploy.sh` en GitHub
Actions (`.github/workflows/cd.yml`). Necesita 5 secretos en el repo.

Una sola vez, después de los pasos 1 y 2:

```
gh auth login
gh secret set TF_BACKEND_HCL < infra/envs/lab/backend.hcl
gh secret set TF_LAB_TFVARS  < infra/envs/lab/lab.tfvars
```

En cada sesión del lab, después de pegar las credenciales nuevas en
`~/.aws/credentials`:

```
bash scripts/update-gh-secrets.sh
```

Copia `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y `AWS_SESSION_TOKEN` del
bloque `[default]` a los secretos de GitHub sin mostrarlos en pantalla.
Opciones: `--repo owner/repo` si no estás dentro del clon, y
`--profile <nombre>` si las credenciales están en otro bloque. Si las
credenciales del lab vencieron, el CD falla en el paso de AWS hasta que
vuelvas a correr este script. Para lanzar el CD a mano:
`gh workflow run CD`.

### 7. Si se reinicia el lab

Al terminar la sesión, el lab detiene la instancia; al iniciar otra, la vuelve
a encender y los servicios de la app arrancan solos.

- La URL no cambia: la IP elástica se conserva.
- Las credenciales sí cambian: repite el paso 1 (y `update-gh-secrets.sh` si
  usas el CD) antes de correr `aws` o `deploy.sh`.
- No hay que repetir el paso 2. Para desplegar cambios basta con
  `bash scripts/deploy.sh`.
- `bash scripts/resume-lab.sh` hace la revisión de arranque de una vez (ver
  [Operación del lab](#operación-del-lab)).

### 8. Destruir

```
bash scripts/destroy.sh
```

Pide escribir `destruir` para confirmar. Vacía los buckets versionados de
fotos y de artefactos, corre `terraform destroy` y al final borra también el
bucket del estado `friomx-tfstate-<cuenta>`. Se borran la instancia, la IP
elástica, las 7 tablas con sus datos, las colas, los temas, las Lambdas, las
alarmas, el dashboard y el secreto.

- `--yes` no pide confirmación (para usarlo sin terminal interactiva).
- `--keep-state` conserva el bucket del estado. Así se puede volver a
  desplegar con el paso 3 sin repetir el 2.

## Operación del lab

Cuatro scripts cubren una sesión de trabajo o de demo. Se corren desde la raíz
del repo, con las credenciales del lab ya pegadas (paso 1 de
[Desplegar](#desplegar-en-aws-learner-lab)).

| Script | Para qué |
|---|---|
| `bash scripts/resume-lab.sh [--gh-repo OWNER/REPO]` | Al empezar una sesión nueva del lab |
| `bash scripts/smoke.sh [--url http://IP]` | Probar los 3 flujos contra la nube |
| `bash scripts/monitoring-check.sh [--demo-alarms] [--reset]` | Revisar métricas, alarmas y dashboard |
| `bash scripts/destroy.sh [--yes] [--keep-state]` | Borrar todo (ver paso 8) |

**`resume-lab.sh`.** Verifica que las credenciales funcionan, arranca la
instancia si está detenida, espera a que aparezca en SSM y a que
`/api/health` responda, e imprime la URL de la app. Con
`--gh-repo OWNER/REPO` corre además `update-gh-secrets.sh` para que el CD
tenga las credenciales de esta sesión.

**`smoke.sh`.** Prueba de punta a punta de los tres flujos. Por defecto usa la
IP de `terraform output -raw public_ip`; `--url http://IP` apunta a otra.
Imprime PASS o FAIL por paso y termina con código distinto de 0 si algo falla.

- Flujo 1: registro, login, una ruleta y el historial.
- Flujo 2: recarga de 500, espera a que quede `COMPLETED` y revisa que el
  saldo subió 500.
- Flujo 3: invoca con `aws lambda invoke` el bono diario y el cierre de
  ranking y revisa su efecto.

**`monitoring-check.sh`.** Lista las métricas propias del namespace `FrioMx`
que ya existen en CloudWatch (`GamesPlayed`, `ApiLatency`, `Api5xx`,
`RechargesCompleted`, `RechargeFailed`, `BonusGranted`), muestra el estado de
`friomx-api-5xx` y `friomx-recharge-dlq` e imprime la URL del dashboard
`FrioMx`. Una métrica propia aparece en CloudWatch solo después de su primer
dato: sin tráfico no se ve, y por eso conviene correr antes `smoke.sh`.

- `--demo-alarms` dispara las dos alarmas de forma real y segura: manda un
  mensaje de prueba directo a la DLQ de recargas y publica `Api5xx=5` en el
  namespace `FrioMx` con `put-metric-data`, la misma métrica que emite el
  backend. No genera errores reales en la API ni toca datos de jugadores. Los
  correos llegan a `alert_emails` si confirmaron la suscripción (paso 4).
  `friomx-recharge-dlq` cambia en uno o dos minutos si la DLQ tuvo actividad en
  las últimas 6 horas; si no, SQS puede tardar hasta unos 15 minutos en volver a
  publicar sus métricas. `friomx-api-5xx` cambia en uno
  a cinco (periodo de 5 minutos).
- `--reset` regresa todo a normal: purga la DLQ. Las alarmas vuelven a `OK`
  solas cuando la métrica baja del umbral.

Orden típico al iniciar una sesión:

```
bash scripts/resume-lab.sh --gh-repo antoniopelayo1902/FrioMX
bash scripts/smoke.sh
bash scripts/monitoring-check.sh
```

## Pruebas

Backend, con DynamoDB Local levantado (las pruebas crean y borran sus propias
tablas, no tocan las de la app):

```
cd backend
DDB_ENDPOINT=http://localhost:8000 npm test
```

Sin `DDB_ENDPOINT` solo corren las pruebas unitarias (motor de juegos,
utilidades, configuración y recargas con DynamoDB simulado) y las de la API se
saltan. En ese caso la cobertura queda por debajo del 70% y `npm test` falla
por el umbral, aunque ninguna prueba haya fallado. Para la corrida completa
hace falta DynamoDB Local en el puerto 8000.

Lambdas (no necesitan DynamoDB Local; AWS se simula con `aws-sdk-client-mock`):

```
cd lambdas
npm ci
npm test
```

Las dos suites generan reporte de cobertura en `coverage/` y exigen 70% en
líneas, ramas, funciones y sentencias (`coverageThreshold` en
`backend/jest.config.js` y `lambdas/jest.config.js`, RNF-09). El CI las corre
en cada pull request a `main` en 4 jobs: `backend` (con DynamoDB Local como
servicio), `lambdas`, `e2e` (Playwright contra la app completa levantada en el
runner) y `terraform` (`fmt -check` y `validate`).

Pruebas de punta a punta del frontend, con Playwright, contra la app levantada
en local (DynamoDB Local, backend y frontend, ver
[Correr en local](#correr-en-local)):

```
cd frontend
npm run e2e
```

Usan `BASE_URL`, por defecto http://localhost:8080.

## Documentación

En `docs/`: requerimientos (`01`), HLD (`02`), LLD (`03`), guion de la
presentación final (`04-presentacion.md`) y borrador del reporte
(`05-reporte.md`).
