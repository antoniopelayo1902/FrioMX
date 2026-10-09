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
- Todavía no funcionan en local porque dependen de la infraestructura en AWS:
  foto de perfil, recargas, bono diario y ranking.

## Pruebas

Con DynamoDB Local levantado:

```
cd backend
DDB_ENDPOINT=http://localhost:8000 npm test
```

Sin `DDB_ENDPOINT` solo corren las pruebas unitarias del motor de juegos.

## Documentación

Requerimientos, HLD y LLD en `docs/`.
