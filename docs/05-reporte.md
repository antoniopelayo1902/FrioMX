# FrioMx -- Reporte final (borrador)

Proyecto integrador, Desarrollo en la Nube, ITESO, Otoño 2026. Equipo: Antonio Pelayo, Emilio Bracamontes, Alan.

Borrador en Markdown para exportar a PDF (máximo 5 páginas). El diagrama de la sección 7 se exporta a imagen desde `02-HLD.md` §3 (por ejemplo en mermaid.live) antes de generar el PDF.

## 1. Repositorio

https://github.com/antoniopelayo1902/FrioMX

El README explica cómo correr la app en local, desplegarla en AWS Learner Lab, operarla en cada sesión y destruirla. Requerimientos, HLD y LLD están en `docs/`.

## 2. Descripción y problema

FrioMx es un casino social con fichas virtuales sin valor monetario. Los jugadores se registran, reciben 1000 fichas, juegan ruleta, hi-lo y minas, recargan fichas y compiten en un ranking semanal con premios.

De un proyecto previo se reutiliza la aplicación: frontend web, backend Node.js/Express y la mecánica de los tres juegos. Esa aplicación tenía tres problemas para correr en la nube con varios jugadores. Guardaba datos en MongoDB local, sin infraestructura reproducible. Varias reglas dependían del cliente: el navegador mandaba su id de usuario, existía una ruta que sumaba cualquier monto al saldo y minas lo decidía el navegador. Y no tenía procesos asíncronos ni programados.

FrioMx resuelve eso con una capa de datos en DynamoDB, toda la lógica de juego en el servidor, dos flujos que usan servicios administrados de AWS (recargas en cola y tareas programadas), infraestructura en Terraform, CI/CD con GitHub Actions y monitoreo en CloudWatch.

## 3. Flujos end-to-end

**Flujo 1, jugar una partida.** El jugador apuesta. El backend toma el usuario del token, valida monto (entero de 1 a 10 000) y jugada, genera el resultado con `crypto.randomInt` y escribe en una sola transacción de DynamoDB el saldo (con la condición de que alcance), la entrada de historial y la ganancia semanal. Hi-lo y minas guardan la ronda abierta en el servidor, que es el único que conoce la segunda carta o la posición de las minas. Resultado observable: saldo nuevo y partida en el historial.

**Flujo 2, recargar fichas.** El jugador elige un paquete de 500, 1000 o 2500. El backend valida el paquete y el límite de 3 recargas por día, crea la recarga como pendiente con un id derivado de una clave de idempotencia, la encola en SQS y responde 202. La Lambda `friomx-recharge-worker` acredita las fichas con una transacción condicionada a que la recarga siga pendiente, así un mensaje repetido no acredita dos veces, y avisa por correo con SNS. Tras 3 intentos fallidos el mensaje pasa a una cola de fallidos y suena una alarma. Resultado observable: estado "completada", saldo actualizado y correo.

**Flujo 3, bono diario y ranking semanal.** Dos reglas de EventBridge invocan Lambdas a hora fija. `friomx-daily-bonus`, a las 08:00 de Ciudad de México, acredita 100 fichas a cada jugador que jugó en los últimos 7 días, una vez por día. `friomx-weekly-ranking`, los lunes a la 01:10, cierra la semana anterior, guarda el top 3 solo si la semana no estaba cerrada y acredita 1000, 500 y 250 fichas en la misma transacción. Resultado observable: fichas acreditadas, ranking publicado en la app y correos a los ganadores.

## 4. Servicios de AWS y por qué

| Servicio | Uso | Por qué |
|---|---|---|
| EC2 + IP elástica | Frontend y API detrás de nginx | La API es un servidor Express; corre sin reescribirla. La IP elástica conserva la URL cuando el lab detiene la instancia. |
| DynamoDB | 7 tablas en modo bajo demanda | Transacciones y escrituras condicionales resuelven la integridad del saldo sin administrar un servidor de base de datos. |
| S3 | Fotos de perfil, artefactos de despliegue, estado de Terraform | Bucket privado con URLs firmadas para las fotos. |
| Lambda | Acreditar recargas, bono y cierre de ranking | Código corto que corre por evento, sin servidor encendido. |
| SQS | Cola de recargas con cola de fallidos | Desacopla la petición del abono y reintenta solo. |
| SNS | Correos a jugadores y alertas al equipo | Funciona en el lab sin verificar dominio; un filtro manda cada mensaje solo a su jugador. |
| EventBridge | Reglas cron del flujo 3 | Invoca la Lambda con un permiso de recurso, sin crear roles. |
| Secrets Manager | Secreto de firma de tokens | Ningún secreto en el repositorio. |
| CloudWatch | Logs, métricas, alarmas y dashboard | Observabilidad de backend, Lambdas, colas e instancia en un solo lugar. |

El lab no permite crear roles IAM, así que todo usa `LabRole` y `LabInstanceProfile`.

## 5. CI/CD y monitoreo

**CI** (`.github/workflows/ci.yml`), en cada pull request a `main`, con cuatro jobs en paralelo: pruebas del backend con DynamoDB Local como servicio, pruebas de las Lambdas con AWS simulado, pruebas de punta a punta del frontend con Playwright contra la app completa levantada en el runner, y `terraform fmt -check` y `validate`. Las suites de backend y Lambdas exigen 70% de cobertura en líneas, ramas, funciones y sentencias; si baja, el job falla. `main` está protegida: todo entra por pull request y requiere la aprobación del dueño del código.

**CD** (`.github/workflows/cd.yml`), en cada merge a `main`: repite el CI y corre `scripts/deploy.sh`, el mismo que se usa a mano. El script arma las Lambdas, aplica Terraform, empaqueta backend y frontend, los sube a S3 y ordena a la instancia por SSM Run Command instalar la versión nueva. La instancia prueba `/api/health` y `/login`; si fallan, regresa a la versión anterior y el pipeline queda en rojo. No hay SSH. Las credenciales del lab viven como secretos de GitHub y se renuevan en cada sesión.

**Monitoreo.** El backend envía métricas propias cada 60 s al namespace `FrioMx`. Las 5 métricas principales son partidas jugadas por juego, latencia p95 de la API, errores 5xx de la API, antigüedad del mensaje más viejo en la cola de recargas y errores de las Lambdas (incluida la métrica propia `RechargeFailed`, porque los fallos parciales de lote no cuentan en `AWS/Lambda Errors`). Las 2 alarmas avisan al tema `friomx-ops-alerts`: `friomx-api-5xx` (5 o más 5xx en 5 minutos) y `friomx-recharge-dlq` (al menos un mensaje en la cola de fallidos). El dashboard `FrioMx` muestra esas métricas más CPU de EC2, recargas completadas, bonos entregados y profundidad de la cola de fallidos. Logs de la instancia en `/friomx/backend` y `/friomx/frontend`.

**Operación.** `resume-lab.sh` deja lista una sesión nueva, `smoke.sh` prueba los 3 flujos contra la nube, `monitoring-check.sh` revisa métricas y alarmas y puede dispararlas para la demo, y `destroy.sh` borra todo.

## 6. Decisiones técnicas

| Decisión | Alternativa | Motivo |
|---|---|---|
| EC2 con nginx, mismo origen | Lambda + API Gateway, frontend en S3 | Sin reescribir la API y sin CORS. |
| DynamoDB | RDS | Integridad del saldo con transacciones condicionales; acceso por llave. |
| SQS + Lambda para recargas | Acreditar en la misma petición | Reintentos y cola de fallidos como señal de alarma. |
| Reglas de EventBridge | EventBridge Scheduler | No requiere que `LabRole` confíe en Scheduler; son dos crons fijos. |
| SNS con filtro por jugador | SES | SES exige verificar dominio. |
| Fichas enteras | Decimales | Sin errores de redondeo; los pagos con multiplicador se redondean hacia abajo. |
| Terraform con estado en S3 y bloqueo nativo | Scripts bash, CloudFormation | Reproducible, con plan previo y sin tabla de bloqueo extra. |
| Despliegue por SSM | SSH desde GitHub | Puerto 22 cerrado y sin llaves en GitHub. |

Limitaciones aceptadas: sin HTTPS, porque el lab no ofrece dominio ni certificado, y una sola instancia como punto único de falla, que se recupera con Terraform y el CD.

## 7. Diagrama de arquitectura

[Insertar aquí la imagen exportada de `02-HLD.md` §3.]

Jugador → IP elástica → nginx en EC2 → frontend o API. La API usa DynamoDB, S3, Secrets Manager, SQS y SNS. SQS dispara `recharge-worker`. EventBridge dispara `daily-bonus` y `weekly-ranking`. Todo reporta a CloudWatch, que avisa al equipo por SNS. GitHub Actions aplica Terraform y despliega por SSM.

## 8. Reparto del trabajo

| Integrante | Rol |
|---|---|
| Emilio Bracamontes | Backend flujo 1 + Frontend |
| Antonio Pelayo | Backend flujo 2 + CI/CD |
| Alan | Backend flujo 3 + Monitoreo |
