# FrioMx -- Documento de requerimientos iniciales

Proyecto integrador, Desarrollo en la Nube, ITESO, Otoño 2026.
Equipo: Emilio Bracamontes, Antonio Pelayo, Alan.
Versión 1.0, 8 de octubre de 2026.

## 1. Propósito y alcance

FrioMx es un casino social con fichas virtuales, sin dinero real. Los usuarios se registran, reciben fichas, juegan ruleta, hi-lo y minas, recargan fichas y compiten en un ranking semanal. Este documento fija qué debe hacer el sistema al final del semestre y con qué restricciones. El cómo está en el HLD (`02-HLD.md`) y el LLD (`03-LLD.md`). El orden de trabajo está en el plan de migración (`04-plan-migracion.md`).

## 2. Contexto y supuestos

- De un proyecto previo se reutiliza la aplicación: frontend web, backend Node.js/Express y la lógica de los tres juegos. Esa aplicación usa MongoDB como almacenamiento.
- Toda la infraestructura de AWS, los flujos 2 y 3, la capa de datos en DynamoDB, el pipeline de CI/CD, las pruebas unitarias y el monitoreo se construyen durante el semestre.
- El entorno compartido (pipeline, demo y entregas) vive en una sola cuenta de AWS Academy Learner Lab, la del responsable de CI/CD, región `us-east-1`. Cada integrante usa su propio lab como entorno de desarrollo con el mismo Terraform.
- Las fichas no tienen valor monetario. No hay pagos reales ni retiros.

## 3. Equipo y roles

| Integrante | Rol de la materia | Responsabilidades |
|---|---|---|
| Emilio Bracamontes | Backend flujo 1 + Frontend | Juegos, cuentas, perfil, fotos y las páginas web (la de ranking la hace Alan) |
| Antonio Pelayo | Backend flujo 2 + CI/CD | Recargas (cola y Lambda), infraestructura base en Terraform, despliegue, pipelines, seguridad |
| Alan | Backend flujo 3 + Monitoreo | Bono y ranking (Lambdas programadas), datos de prueba, métricas, alarmas, dashboard, logs |

Todos conocen el proyecto completo y revisan los pull requests de los demás.

## 4. Actores

| Actor | Descripción |
|---|---|
| Jugador | Persona registrada, mayor de 18 años, que juega y recarga fichas. |
| Visitante | Persona sin sesión. Solo ve páginas públicas, registro y login. |
| Sistema programado | Tareas que corren solas a hora fija (bono diario, cierre de ranking). |
| Equipo (operador) | Integrantes que reciben alertas y despliegan cambios. |

## 5. Requerimientos funcionales

### 5.1 Cuentas y sesión

- **RF-01** El visitante puede registrarse con nombre, edad, correo y contraseña. El sistema valida: todos los campos presentes, edad entera entre 18 y 99, correo con formato válido y único (sin distinguir mayúsculas), contraseña de al menos 8 caracteres y máximo 72 bytes (límite de bcrypt).
- **RF-02** Al registrarse, la cuenta recibe 1000 fichas de bienvenida y se le envía un correo para confirmar la suscripción a notificaciones.
- **RF-03** El jugador inicia sesión con correo y contraseña y recibe un token de sesión válido 7 días. Un error de credenciales no revela si el correo existe.
- **RF-04** El jugador puede consultar y editar su nombre, correo y contraseña. Solo puede ver y editar su propia cuenta.
- **RF-05** El jugador puede subir, ver y eliminar su foto de perfil (JPEG, PNG o WEBP, máximo 5 MB).

### 5.2 Juegos (Flujo 1)

- **RF-06** El jugador puede jugar hi-lo: apuesta, el servidor reparte la carta visible, el jugador elige "mayor" o "menor" y el servidor saca la segunda carta y decide el resultado. La carta que ve el jugador es la misma con la que se compara. El empate pierde y el pago es inversamente proporcional a la probabilidad de ganar (entre menos cartas ganan, más paga), con una ventaja de la casa de 5%. Una ronda abandonada pierde la apuesta.
- **RF-07** El jugador puede jugar ruleta: hace hasta 20 apuestas por giro (color rojo, negro o verde, paridad o docena) y el servidor gira la ruleta. Todas pagan 1 a 1. El 0 es verde y no tiene paridad ni docena.
- **RF-08** El jugador puede jugar minas (tablero 5×5 con 5 minas): inicia partida con una apuesta y destapa casillas una a una. El servidor, que es el único que conoce la posición de las minas, decide si cada casilla es mina. Gana al destapar las 20 casillas seguras (neto +2× la apuesta) y pierde al pisar una mina (neto −apuesta).
- **RF-09** Ninguna apuesta procede si el saldo no la cubre. La apuesta es un entero positivo entre 1 y 10 000 fichas (en ruleta, la suma de las apuestas del giro).
- **RF-10** Cada partida terminada actualiza el saldo y registra una entrada en el historial del jugador (juego, resultado, fichas ganadas o perdidas, fecha).
- **RF-11** El jugador puede consultar su historial de partidas, de la más reciente a la más antigua, paginado.

### 5.3 Recarga de fichas (Flujo 2)

- **RF-12** El jugador puede solicitar una recarga eligiendo un paquete fijo: 500, 1000 o 5000 fichas.
- **RF-13** Máximo 3 recargas por jugador por día calendario (hora de Ciudad de México). La cuarta se rechaza con un mensaje claro.
- **RF-14** La solicitud se acepta de inmediato y se procesa de forma asíncrona. El jugador ve el estado (pendiente, completada o fallida) y su saldo actualizado al completarse. Una recarga que sigue pendiente 5 minutos después de creada se muestra como fallida.
- **RF-15** Al completarse la recarga, el jugador recibe un correo de confirmación (si confirmó su suscripción).
- **RF-16** Una misma solicitud reenviada (doble clic, reintento de red) no acredita fichas dos veces.

### 5.4 Bono diario y ranking semanal (Flujo 3)

- **RF-17** Cada día a las 08:00 (Ciudad de México) el sistema acredita 100 fichas a cada jugador que jugó al menos una partida en los últimos 7 días, como máximo una vez por día por jugador, y le avisa por correo.
- **RF-18** El sistema lleva la ganancia neta semanal de cada jugador (semana ISO, lunes a domingo, hora de Ciudad de México).
- **RF-19** Cada lunes a la 01:10 el sistema cierra la semana anterior, publica el top 3 (solo jugadores con ganancia neta positiva), les acredita premios de 1000, 500 y 250 fichas y les avisa por correo. El cierre de una semana ocurre una sola vez aunque la tarea se ejecute de nuevo.
- **RF-20** El jugador puede ver el ranking en curso (con su propia posición), el resultado de la última semana cerrada y el de cualquier semana cerrada anterior.

## 6. Flujos end-to-end

| Flujo | Entrada del usuario | Validación | Lógica de negocio | Resultado observable |
|---|---|---|---|---|
| 1. Jugar una partida | Apuesta y jugada | Sesión válida, monto entero en rango, saldo suficiente, jugada válida | Resultado aleatorio generado en el servidor, cálculo de pago, actualización atómica de saldo, historial y estadística semanal | Nuevo saldo en pantalla y registro en el historial |
| 2. Recargar fichas | Paquete elegido | Sesión válida, paquete existente, límite diario, idempotencia | Solicitud en cola, Lambda acredita y marca completada | Estado "completada", saldo actualizado y correo de confirmación |
| 3. Bono y ranking | Las jugadas del flujo 1 (cada una ya validada) alimentan la estadística semanal, y el jugador consulta el ranking. El bono y el cierre se disparan a hora fija | Sesión válida y semana existente en la consulta. Jugador activo, no premiado hoy y semana no cerrada en las tareas programadas | Tareas programadas acreditan bono, calculan top 3 y premian | Fichas acreditadas, ranking publicado en la aplicación y correos a ganadores |

El flujo 3 es el que aprovecha características propias de la nube que son difíciles de replicar en local: se ejecuta solo a hora fija sin un servidor encendido esperando. El flujo 2 también, por la cola con reintentos y cola de mensajes fallidos.

## 7. Requerimientos no funcionales

- **RNF-01 Integridad del saldo.** El saldo nunca queda negativo ni pierde actualizaciones con jugadas simultáneas del mismo jugador. Toda modificación de saldo es atómica y condicionada.
- **RNF-02 Juego justo.** Todos los resultados aleatorios se generan en el servidor con un generador criptográfico. El cliente nunca decide si ganó.
- **RNF-03 Seguridad.** Contraseñas con hash bcrypt. El usuario se identifica solo por el token, nunca por un id enviado por el cliente. No existe ninguna operación que permita a un jugador fijar su saldo directamente. Secretos en Secrets Manager, nunca en el repositorio. Límite de intentos en login y registro.
- **RNF-04 Rendimiento.** Una jugada responde en menos de 500 ms (p95) con 30 jugadores simultáneos, que es el tamaño de la demo en clase.
- **RNF-05 Asincronía confiable.** Un fallo al acreditar una recarga se reintenta automáticamente. Tras 3 intentos fallidos el mensaje pasa a una cola de mensajes fallidos y se dispara una alarma.
- **RNF-06 Observabilidad.** 5 métricas relevantes, 2 alarmas con umbral y 1 dashboard en CloudWatch.
- **RNF-07 Reproducibilidad.** Toda la infraestructura se crea con Terraform y scripts bash desde el repositorio, con instrucciones en el README para que alguien ajeno al proyecto pueda desplegarlo.
- **RNF-08 CI/CD.** Cada pull request corre pruebas unitarias. Cada merge a `main` corre pruebas y despliega automáticamente a AWS.
- **RNF-09 Calidad.** Cobertura de pruebas unitarias de al menos 70% en backend y Lambdas.
- **RNF-10 Costo.** Usar los tamaños más pequeños que cumplan RNF-04 y apagar recursos fuera de las sesiones de trabajo.

## 8. Restricciones del entorno (AWS Academy Learner Lab)

- No se pueden crear roles ni usuarios IAM. Todo usa el rol existente `LabRole` y el perfil de instancia `LabInstanceProfile`.
- Las credenciales del lab duran una sesión (aprox. 4 horas) y se deben renovar en GitHub en cada sesión.
- Al terminar la sesión del lab, las instancias EC2 se detienen. Por eso se usa una IP elástica para que la dirección no cambie.
- No hay dominio propio ni certificado. La aplicación se sirve por HTTP en la IP elástica. Es una limitación aceptada del entorno escolar.
- Servicios, tipos de instancia y concurrencia de Lambda están acotados por el lab. El diseño usa solo servicios y tamaños básicos.

## 9. Trazabilidad con los requisitos de la materia

| Requisito de la materia | Cómo se cumple |
|---|---|
| 5 servicios de AWS | EC2, DynamoDB, S3, Lambda, SQS, SNS, EventBridge, Secrets Manager, CloudWatch (9) |
| 3 flujos end-to-end, uno propio de la nube | Sección 6. Flujo 3 programado y flujo 2 asíncrono |
| Repositorio con commits de los 3 | Trabajo por ramas y pull requests, cada quien en su área (sección 3) |
| Frontend y backend en la nube | Ambos en EC2 detrás de nginx |
| Demo (video de 10 min en Fase 2, 20 min en vivo en Fase 3) | Sección 11 y plan de migración, tareas 4.3 y 6.5 |
| Diagrama de arquitectura | HLD, sección 3 |
| CI/CD con GitHub Actions y pruebas | RNF-08 y RNF-09 |
| Monitoreo 5/2/1 | RNF-06, detalle en el LLD |
| Scripts bash o Terraform | RNF-07 |

## 10. Fuera de alcance

- Dinero real, pagos, retiros o cualquier conversión de fichas.
- Dominio propio, HTTPS y CDN.
- Multirregión, alta disponibilidad con varias instancias y autoescalado.
- Aplicación móvil nativa.
- Panel de administración. Las tareas manuales se hacen con la CLI de AWS.
- Juegos adicionales a los tres existentes.

## 11. Criterios de aceptación por fase

- **Fase 2 (15 oct).** Frontend y backend corriendo en EC2 con datos en DynamoDB. Registro, login, perfil, hi-lo, ruleta, minas (versión temporal) e historial funcionando en la nube. Flujo 2 completo de punta a punta. Lambdas del flujo 3 desplegadas y programadas. Infraestructura creada con Terraform y desplegada con un script. CI corriendo pruebas en cada pull request.
- **Sesión 12 nov.** Aplicación 100% en la nube, incluyendo minas del lado del servidor y página de ranking. Pruebas unitarias con cobertura de 70%. CD automático al hacer merge a `main`.
- **Fase 3 (30 nov / 3 dic).** Dashboard, 5 métricas y 2 alarmas funcionando. Demo en vivo de los 3 flujos, CI/CD y monitoreo.
