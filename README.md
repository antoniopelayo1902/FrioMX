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

Fase 2 en progreso. Frontend y backend funcionando en local con DynamoDB Local.
Pendiente: infraestructura en AWS, recargas, bono y ranking, foto de perfil.

## Correr en local

Requisitos: Node.js 20 o superior y Java (para DynamoDB Local).

1. Descargar y arrancar DynamoDB Local en el puerto 8000:
   ```
   java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -inMemory -port 8000
   ```
2. Backend:
   ```
   cd backend
   cp .env.example .env   # definir JWT_SECRET con un valor aleatorio
   npm ci
   npm run db:local:tables
   npm start
   ```
3. Frontend (en otra terminal):
   ```
   cd frontend
   npm ci
   npm run dev
   ```
4. Abrir http://localhost:8080

## Pruebas

```
cd backend
DDB_ENDPOINT=http://localhost:8000 npm test
```

Sin `DDB_ENDPOINT` solo corren las pruebas unitarias del motor de juegos.

## Documentación

Requerimientos, HLD, LLD y plan de migración en `docs/`.
