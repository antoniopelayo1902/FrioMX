#!/bin/bash
# user_data de FrioMx (Amazon Linux 2023). Corre una sola vez, en la primera creación.
# Deja la instancia lista para que deploy-on-instance.sh instale versiones.
set -euxo pipefail
exec > >(tee -a /var/log/friomx-user-data.log) 2>&1

# --- Paquetes: Node.js 22, nginx, agente de CloudWatch, logrotate ---
# Reintentos: un fallo pasajero del mirror no debe abortar el único arranque.
installed=false
for i in 1 2 3 4 5; do
  if dnf -y install nodejs22 nginx amazon-cloudwatch-agent logrotate; then
    installed=true
    break
  fi
  echo "dnf falló (intento ${i}), reintentando en 15 s"
  dnf clean metadata || true
  sleep 15
done
[ "${installed}" = true ] || { echo "dnf no pudo instalar los paquetes tras 5 intentos"; exit 1; }

# El paquete nodejs22 de AL2023 instala /usr/bin/node-22; los units usan /usr/bin/node.
if [ ! -x /usr/bin/node ]; then
  ln -sf "$(command -v node-22)" /usr/bin/node
fi
/usr/bin/node --version

# --- Usuario y directorios ---
id friomx >/dev/null 2>&1 || useradd --system --shell /sbin/nologin --home-dir /opt/friomx friomx
install -d -o root -g root -m 0755 /opt/friomx /opt/friomx/releases
install -d -o root -g friomx -m 0750 /etc/friomx
install -d -o friomx -g friomx -m 0755 /var/log/friomx
# Se crean antes para que systemd anexe a archivos de friomx (logrotate corre como friomx).
install -o friomx -g friomx -m 0644 /dev/null /var/log/friomx/backend.log
install -o friomx -g friomx -m 0644 /dev/null /var/log/friomx/frontend.log

# --- Servicios systemd (habilitados; arrancan cuando exista /opt/friomx/current) ---
cat > /etc/systemd/system/friomx-backend.service <<'EOF'
[Unit]
Description=FrioMx backend (API)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=friomx
Group=friomx
WorkingDirectory=/opt/friomx/current/backend
EnvironmentFile=/etc/friomx/backend.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
StandardOutput=append:/var/log/friomx/backend.log
StandardError=append:/var/log/friomx/backend.log

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/friomx-frontend.service <<'EOF'
[Unit]
Description=FrioMx frontend (estatico)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=friomx
Group=friomx
WorkingDirectory=/opt/friomx/current/frontend
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=HOST=127.0.0.1
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
StandardOutput=append:/var/log/friomx/frontend.log
StandardError=append:/var/log/friomx/frontend.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable friomx-backend.service friomx-frontend.service

# --- nginx: se reemplaza nginx.conf por uno sin el server por defecto de AL2023 ---
cp -n /etc/nginx/nginx.conf /etc/nginx/nginx.conf.orig || true
cat > /etc/nginx/nginx.conf <<'EOF'
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log notice;
pid /run/nginx.pid;

include /usr/share/nginx/modules/*.conf;

events {
    worker_connections 1024;
}

http {
    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';
    access_log /var/log/nginx/access.log main;

    sendfile on;
    tcp_nopush on;
    keepalive_timeout 65;
    types_hash_max_size 4096;
    server_tokens off;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    include /etc/nginx/conf.d/*.conf;
}
EOF

cat > /etc/nginx/conf.d/friomx.conf <<'EOF'
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
EOF

nginx -t
systemctl enable --now nginx

# --- logrotate con copytruncate (systemd mantiene el archivo abierto) ---
cat > /etc/logrotate.d/friomx <<'EOF'
/var/log/friomx/*.log {
    su friomx friomx
    daily
    rotate 7
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
}
EOF
systemctl enable --now logrotate.timer || true

echo "user_data de FrioMx terminado"
