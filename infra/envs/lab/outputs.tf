output "public_ip" {
  description = "IP elástica de la instancia."
  value       = module.network.public_ip
}

output "instance_id" {
  value = module.compute.instance_id
}

output "artifacts_bucket" {
  value = module.storage.artifacts_bucket
}

output "uploads_bucket" {
  value = module.storage.uploads_bucket
}

output "recharge_queue_url" {
  value = module.messaging.recharge_queue_url
}

output "recharge_dlq_url" {
  value = module.messaging.recharge_dlq_url
}

output "user_topic_arn" {
  value = module.messaging.user_topic_arn
}

output "ops_topic_arn" {
  value = module.messaging.ops_topic_arn
}

output "jwt_secret_arn" {
  value = module.secrets.jwt_secret_arn
}

output "aws_region" {
  value = var.region
}

output "tables" {
  description = "Nombres de las tablas: users, user_emails, activity, weekly_stats, recharges, game_rounds, leaderboard."
  value       = module.data.table_names
}

# Contenido completo de /etc/friomx/backend.env. deploy.sh lo escribe tal cual.
output "backend_env" {
  value = join("\n", [
    "PORT=3000",
    "HOST=127.0.0.1",
    "AWS_REGION=${var.region}",
    "APP_TZ=${local.app_tz}",
    "METRICS_NAMESPACE=${local.metrics_ns}",
    "METRICS_ENABLED=true",
    "TABLE_USERS=${module.data.table_names["users"]}",
    "TABLE_USER_EMAILS=${module.data.table_names["user_emails"]}",
    "TABLE_ACTIVITY=${module.data.table_names["activity"]}",
    "TABLE_WEEKLY_STATS=${module.data.table_names["weekly_stats"]}",
    "TABLE_RECHARGES=${module.data.table_names["recharges"]}",
    "TABLE_GAME_ROUNDS=${module.data.table_names["game_rounds"]}",
    "TABLE_LEADERBOARD=${module.data.table_names["leaderboard"]}",
    "JWT_SECRET_ARN=${module.secrets.jwt_secret_arn}",
    "UPLOADS_BUCKET=${module.storage.uploads_bucket}",
    "RECHARGE_QUEUE_URL=${module.messaging.recharge_queue_url}",
    "USER_TOPIC_ARN=${module.messaging.user_topic_arn}",
    "",
  ])
}
