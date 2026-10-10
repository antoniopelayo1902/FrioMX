variable "region" {
  type = string
}

variable "metrics_namespace" {
  type = string
}

variable "ops_topic_arn" {
  type = string
}

variable "queue_name" {
  type = string
}

variable "dlq_name" {
  type = string
}

variable "instance_id" {
  type = string
}

variable "function_names" {
  description = "Mapa recharge-worker / daily-bonus / weekly-ranking -> nombre."
  type        = map(string)
}

locals {
  ns = var.metrics_namespace
}

# --- Grupos de logs de la instancia (el agente de CloudWatch escribe aquí) ---
resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["backend", "frontend"])
  name              = "/friomx/${each.key}"
  retention_in_days = 14
}

# --- Alarmas (LLD §11) ---
resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "friomx-api-5xx"
  alarm_description   = "5 o más respuestas 5xx de la API en 5 minutos"
  namespace           = local.ns
  metric_name         = "Api5xx"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.ops_topic_arn]
  # Avisa también la recuperación (OK) para que en la demo se vea el ciclo completo.
  ok_actions = [var.ops_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "recharge_dlq" {
  alarm_name          = "friomx-recharge-dlq"
  alarm_description   = "Hay mensajes en la cola de recargas fallidas"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = var.dlq_name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.ops_topic_arn]
  # Avisa también la recuperación (OK) para que en la demo se vea el ciclo completo.
  ok_actions = [var.ops_topic_arn]
}

# --- Dashboard FrioMx ---
# Las métricas propias usan SEARCH para no depender de las dimensiones exactas que emitan.
locals {
  widgets = [
    {
      title   = "Partidas jugadas por juego (Sum, 1 min)"
      metrics = [[{ expression = "SEARCH('Namespace=\"${local.ns}\" MetricName=\"GamesPlayed\"', 'Sum', 60)", id = "games" }]]
      stat    = "Sum"
    },
    {
      title   = "Latencia de la API p95 (ms)"
      metrics = [[{ expression = "SEARCH('Namespace=\"${local.ns}\" MetricName=\"ApiLatency\"', 'p95', 60)", id = "lat" }]]
      stat    = "p95"
    },
    {
      title   = "Errores 5xx de la API (Sum)"
      metrics = [[{ expression = "SEARCH('Namespace=\"${local.ns}\" MetricName=\"Api5xx\"', 'Sum', 60)", id = "e5xx" }]]
      stat    = "Sum"
    },
    {
      title   = "Antigüedad del mensaje más viejo, recargas (s)"
      metrics = [["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", var.queue_name, { stat = "Maximum" }]]
      stat    = "Maximum"
    },
    {
      title = "Errores de Lambdas"
      metrics = [
        ["AWS/Lambda", "Errors", "FunctionName", var.function_names["daily-bonus"], { stat = "Sum" }],
        ["AWS/Lambda", "Errors", "FunctionName", var.function_names["weekly-ranking"], { stat = "Sum" }],
        [{ expression = "SEARCH('Namespace=\"${local.ns}\" MetricName=\"RechargeFailed\"', 'Sum', 60)", id = "rfail" }],
      ]
      stat = "Sum"
    },
    {
      title   = "CPU de EC2 (%)"
      metrics = [["AWS/EC2", "CPUUtilization", "InstanceId", var.instance_id, { stat = "Average" }]]
      stat    = "Average"
    },
    {
      title = "Recargas completadas y bonos entregados"
      metrics = [
        [{ expression = "SEARCH('Namespace=\"${local.ns}\" MetricName=\"RechargesCompleted\"', 'Sum', 60)", id = "rdone" }],
        [{ expression = "SEARCH('Namespace=\"${local.ns}\" MetricName=\"BonusGranted\"', 'Sum', 60)", id = "bonus" }],
      ]
      stat = "Sum"
    },
    {
      title   = "Profundidad de la DLQ de recargas"
      metrics = [["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", var.dlq_name, { stat = "Maximum" }]]
      stat    = "Maximum"
    },
  ]
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "FrioMx"
  dashboard_body = jsonencode({
    widgets = [
      for i, w in local.widgets : {
        type   = "metric"
        x      = (i % 2) * 12
        y      = floor(i / 2) * 6
        width  = 12
        height = 6
        properties = {
          title   = w.title
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          stat    = w.stat
          metrics = w.metrics
        }
      }
    ]
  })
}

output "dashboard_name" {
  value = aws_cloudwatch_dashboard.main.dashboard_name
}

output "dashboard_url" {
  value = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards/dashboard/${aws_cloudwatch_dashboard.main.dashboard_name}"
}

output "alarm_names" {
  value = [aws_cloudwatch_metric_alarm.api_5xx.alarm_name, aws_cloudwatch_metric_alarm.recharge_dlq.alarm_name]
}
