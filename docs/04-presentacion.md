# FrioMx -- Guion de la presentación final

Fase 3, 30 nov / 3 dic. 20 minutos en vivo. Requerimientos en `01-requerimientos.md`, arquitectura en `02-HLD.md`, comandos en el README (sección "Operación del lab").

## 1. Reparto

| Integrante | Parte | Minutos |
|---|---|---|
| Emilio | Apertura, flujo 1 y frontend | 0 a 7 |
| Antonio | Flujo 2 y CI/CD | 7 a 13 |
| Alan | Flujo 3 y monitoreo | 13 a 19 |
| Los tres | Cierre y preguntas | 19 a 20 |

Se proyecta una sola máquina, la de quien tiene la cuenta del lab compartido. Cada quien lleva el control en su parte. Antes de empezar quedan abiertas estas pestañas: la app (`http://<public_ip>/`), GitHub (pestaña Actions y el PR de la demo), la consola de AWS en CloudWatch (dashboard `FrioMx` y la lista de alarmas), SQS, Lambda y una terminal en la raíz del repo.

## 2. Guion minuto a minuto

| Min | Quién | En pantalla | Qué se dice |
|---|---|---|---|
| 0-1 | Emilio | Diagrama de `02-HLD.md` §3 | Qué es FrioMx: casino social con fichas sin valor. De un proyecto previo se reutiliza la aplicación; la infraestructura, los flujos 2 y 3, DynamoDB, CI/CD, pruebas y monitoreo son de este proyecto. Los 3 flujos y los 9 servicios. |
| 1-2 | Emilio | Diagrama | Recorrido de una petición: navegador → IP elástica → nginx → frontend o API en EC2 → DynamoDB. Una sola instancia y un solo origen, sin CORS. |
| 2-4 | Emilio | App: registro, lobby | Registro con correo real del equipo (1000 fichas de bienvenida y correo de SNS). Lobby con saldo. Mencionar validaciones (edad, correo único, límite de intentos). |
| 4-6 | Emilio | App: ruleta, minas, historial | Ruleta con varias apuestas; el resultado lo calcula el servidor con `crypto.randomInt`. Minas: el tablero vive en el servidor, el navegador nunca sabe dónde están las minas. Historial con la partida y el neto. |
| 6-7 | Emilio | Consola DynamoDB, tablas `friomx-users` y `friomx-activity` | La jugada es una sola transacción: saldo con condición de alcanzar, historial y estadística semanal. Por eso el saldo no queda negativo con clics simultáneos. Cede a Antonio. |
| 7-8 | Antonio | Terminal y GitHub | Abre el PR chico de la demo (§4) y deja corriendo el CI. Explica qué hace el CI mientras corre. |
| 8-10 | Antonio | App: Saldo | Recarga de 500. "Procesando tu recarga…" y luego "Listo". La API responde 202 y encola; la Lambda `friomx-recharge-worker` acredita. Correo "FrioMx: recarga lista". Mencionar límite de 3 por día e idempotencia (doble clic no acredita dos veces). |
| 10-11 | Antonio | Consola SQS y Lambda | Cola `friomx-recharges` con DLQ tras 3 intentos, concurrencia máxima 2. Logs de la invocación en CloudWatch. |
| 11-13 | Antonio | GitHub Actions | CI en verde (4 jobs: backend con DynamoDB Local, Lambdas, e2e con Playwright y Terraform). Merge del PR. Arranca el CD: pruebas, `terraform apply`, paquete a S3, despliegue por SSM sin SSH, prueba de salud y regreso automático a la versión previa si falla. Se deja corriendo. Cede a Alan. |
| 13-15 | Alan | App: Ranking y terminal | Ranking de la semana en curso con la fila propia. Invoca `friomx-daily-bonus` (bono de 100 a quien jugó en 7 días) y `friomx-weekly-ranking` con la semana sembrada (§3). Muestra `"status":"CLOSED"`, el top 3 en "Semanas cerradas" y el correo del premio. |
| 15-16 | Alan | Consola EventBridge | Reglas `cron(0 14 * * ? *)` y `cron(10 7 ? * MON *)`: 08:00 y lunes 01:10 en Ciudad de México. Sin servidor encendido esperando. Un cierre repetido no paga dos veces. |
| 16-18 | Alan | Dashboard `FrioMx` y alarmas | Las 5 métricas y las de apoyo. Alarmas `friomx-recharge-dlq` y `friomx-api-5xx` en ALARM (disparadas en el minuto 9, §5) y el correo en la bandeja del equipo. |
| 18-19 | Antonio | App y GitHub Actions | CD en verde. Se recarga la app y se ve el cambio del PR en producción. |
| 19-20 | Emilio | Diagrama | Cierre: qué se cumplió y limitaciones aceptadas (sin HTTPS, una instancia). Preguntas. |

## 3. Preparación (1 hora antes)

1. Start Lab en AWS Academy y pegar las credenciales en `~/.aws/credentials`.
2. `bash scripts/resume-lab.sh --gh-repo antoniopelayo1902/FrioMX`. Debe terminar con la URL y `/api/health` en OK. Esto también renueva los secretos del CD.
3. `bash scripts/smoke.sh`. Todos los pasos en PASS. Ojo: invoca de verdad `weekly-ranking`, que cierra y paga la semana anterior si no estaba cerrada, y deja una cuenta `smoke-…@friomx.test`; la demo usa otra semana sembrada (§3), así que no choca. Si uno falla, se arregla ahora, no en la demo.
4. Calentar la DLQ: `bash scripts/monitoring-check.sh --demo-alarms`, esperar a que `friomx-recharge-dlq` pase a ALARM (hasta 15 min si la cola llevaba más de 6 h sin actividad, porque SQS deja de publicar sus métricas) y luego `bash scripts/monitoring-check.sh --reset`. Así en la demo la alarma reacciona en uno o dos minutos.
5. `bash scripts/monitoring-check.sh`. Las 6 métricas propias aparecen y las 2 alarmas están en OK. Si alguna sigue en ALARM de una prueba anterior, `bash scripts/monitoring-check.sh --reset` y esperar a que regrese a OK.
6. Confirmar en la bandeja de los tres que la suscripción a `friomx-ops-alerts` está confirmada (en la consola de SNS no debe decir `PendingConfirmation`) y revisar spam.
7. Crear la cuenta de demo con un correo del equipo y confirmar su suscripción de `friomx-user-notifications`. Jugar 2 partidas para que el bono diario la tome.
8. Sembrar la semana para el ranking y guardar el valor:
   ```
   WEEK=$(date -v-21d +%G-W%V)        # macOS
   (cd backend && npm ci)
   node scripts/seed.js --week "$WEEK" --include-email <correo de la cuenta de demo>
   ```
   Si `seed.js` dice que la semana está cerrada, usar `-v-28d`.
9. Preparar el PR de la demo (§4) en una rama, sin abrirlo todavía.
10. Dejar escritos en la terminal los comandos de los minutos 9 y 13 a 15.
11. Comprobar que la sesión del lab tiene al menos 2 horas restantes.

## 4. CI/CD en vivo

El PR debe ser pequeño y visible: por ejemplo, cambiar un texto de la página "Acerca de" (`frontend/public/info.html`) o el subtítulo del lobby. Nada en `infra/` para que `terraform apply` no cree cambios durante la demo.

```
git switch -c demo/final main
# editar el texto
git commit -am "docs: texto de la presentación final"
git push -u origin demo/final
gh pr create --fill --base main
```

En el minuto 7 se abre el PR. El CI tarda unos minutos; mientras, Antonio muestra el flujo 2. En el minuto 11 Antonio lo mergea: como dueño del código (CODEOWNERS) es el único aprobador, y en su propio PR usa el bypass del ruleset. El CD corre mientras Alan presenta y se revisa en el minuto 18. Si el CD no termina a tiempo, se muestra el paso en curso y se explica qué falta.

## 5. Alarmas en vivo

En el minuto 9, Antonio corre en una terminal aparte de su máquina (la que tiene las credenciales del lab y `infra/envs/lab/backend.hcl`), sin proyectar:

```
bash scripts/monitoring-check.sh --demo-alarms
```

Manda un mensaje de prueba directo a la DLQ y publica `Api5xx=5` con `put-metric-data`, la misma métrica que emite el backend; no se generan errores reales en la API. Si el profesor pregunta, se dice así: es una prueba controlada del umbral. `friomx-recharge-dlq` pasa a ALARM en uno o dos minutos (la DLQ se calentó en la preparación, paso 4) y `friomx-api-5xx` en uno a cinco (periodo de 5 minutos); por eso se dispara en el minuto 9 y se muestra en el 16. Al terminar la presentación:

```
bash scripts/monitoring-check.sh --reset
```

## 6. Plan B y cómo explicar la causa

| Falla | Causa probable | Qué hacer y qué decir |
|---|---|---|
| La app no carga | Instancia detenida o recién encendida, o credenciales vencidas | `bash scripts/resume-lab.sh`. "El lab detiene la instancia al terminar la sesión; la IP elástica se conserva y los servicios arrancan con systemd." |
| Recarga se queda en "Procesando" | Lambda con error o cola sin consumidor | Mostrar logs de `friomx-recharge-worker` en CloudWatch. Pasado 5 minutos la app la marca fallida (RF-14); tras 3 intentos el mensaje va a la DLQ y suena la alarma: el diseño cubre justo esto. |
| No llega un correo | Suscripción sin confirmar o en spam | Mostrar el estado en la app (saldo y recarga completada) y la suscripción en SNS. "SNS no envía nada hasta que el dueño confirma." |
| CI rojo | Prueba o umbral de 70% | Abrir el job y leer el error. Si es cobertura, "el job backend necesita DynamoDB Local; sin él se saltan las pruebas de API y baja la cobertura". |
| CD falla en el paso de AWS | Secretos de GitHub con credenciales viejas | `bash scripts/update-gh-secrets.sh` y `gh workflow run CD`. "Las credenciales del lab cambian cada sesión y se guardan como secretos." |
| CD falla en el despliegue | Salud no responde en la instancia | Mostrar la salida de SSM en el job: la instancia regresó sola a la versión previa y la app sigue arriba. |
| CD no termina a tiempo | Duración normal de `terraform apply` y SSM | Mostrar en qué paso va. Se revisa al final de preguntas. |
| `weekly-ranking` responde ya cerrada | Semana usada antes | Sembrar otra semana (`-v-28d`) e invocar de nuevo. "El cierre es único por semana: es la idempotencia del RF-19." |
| Bono con `granted: 0` | La cuenta ya lo recibió hoy o no jugó en 7 días | Mostrar `skipped` en la respuesta. "Máximo un bono por día por jugador." |
| Alarma no cambia a tiempo | Periodo de evaluación (1 min en la DLQ, 5 min en 5xx) y la demora de CloudWatch en procesar el dato | Mostrar el mensaje en la DLQ y la gráfica subiendo. Explicar periodo y umbral de cada alarma. |
| Métrica propia no aparece | Sin tráfico desde que se levantó | Correr `bash scripts/smoke.sh` y esperar un minuto. "CloudWatch crea la métrica con su primer dato." |
| Se vence la sesión del lab | Duración de unas 4 horas | Start Lab, pegar credenciales, `resume-lab.sh`. Por eso se revisa el tiempo restante una hora antes. |

## 7. Preguntas probables

1. **¿Por qué EC2 y no Lambda con API Gateway?** La API es un servidor Express que se reutiliza sin reescribirla; con una sola instancia y nginx también se evita CORS.
2. **¿Cómo evitan que el saldo quede negativo?** Cada jugada es una transacción de DynamoDB con la condición `saldo >= apuesta`; si falla, no se escribe nada.
3. **¿Cómo saben que el juego es justo?** El resultado se genera en el servidor con `crypto.randomInt`; el cliente solo manda la apuesta y la jugada.
4. **¿Qué pasa si la Lambda de recargas falla?** SQS reintenta; a los 3 fallos el mensaje pasa a la DLQ y suena `friomx-recharge-dlq`.
5. **¿Qué impide acreditar una recarga dos veces?** El id sale de una clave de idempotencia del navegador y la Lambda solo acredita si la recarga sigue pendiente.
6. **¿Por qué el flujo 3 es propio de la nube?** Corre a hora fija con EventBridge y Lambda, sin un servidor encendido esperando.
7. **¿Cómo despliegan sin SSH?** El CD sube el paquete a S3 y ordena la instalación por SSM Run Command; el puerto 22 está cerrado.
8. **¿Qué pasa si un despliegue sale mal?** La instancia prueba `/api/health` y `/login`; si fallan, regresa a la versión previa y el pipeline queda en rojo.
9. **¿Cómo manejan las credenciales del lab en GitHub?** Como secretos que se renuevan cada sesión con `update-gh-secrets.sh`; el CD falla si vencieron.
10. **¿Qué cubren las pruebas?** Motor de juegos, servicios, rutas de la API contra DynamoDB Local y las tres Lambdas con AWS simulado; el CI exige 70% de cobertura. Además hay pruebas de punta a punta del frontend con Playwright.
11. **¿Por qué esas dos alarmas?** Los 5xx miden la salud de la API que ve el jugador y la DLQ es la señal directa de recargas que no se pudieron acreditar.
12. **¿Qué limitaciones tiene?** Sin HTTPS porque el lab no da dominio ni certificado, y una sola instancia es punto único de falla; se recupera con Terraform y el CD.
