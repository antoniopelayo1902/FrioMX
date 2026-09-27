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

Fase 1: planteamiento del proyecto.
