variable "alert_emails" {
  type = list(string)
}

# --- SQS (LLD §12) ---
resource "aws_sqs_queue" "recharges_dlq" {
  name                      = "friomx-recharges-dlq"
  message_retention_seconds = 1209600 # 14 días
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "recharges" {
  name                       = "friomx-recharges"
  visibility_timeout_seconds = 70
  message_retention_seconds  = 345600 # 4 días
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.recharges_dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "recharges_dlq" {
  queue_url = aws_sqs_queue.recharges_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.recharges.arn]
  })
}

# --- SNS (LLD §7) ---
resource "aws_sns_topic" "user_notifications" {
  name = "friomx-user-notifications"
}

resource "aws_sns_topic" "ops_alerts" {
  name = "friomx-ops-alerts"
}

resource "aws_sns_topic_subscription" "ops_email" {
  for_each  = toset(var.alert_emails)
  topic_arn = aws_sns_topic.ops_alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

output "recharge_queue_url" {
  value = aws_sqs_queue.recharges.id
}

output "recharge_queue_arn" {
  value = aws_sqs_queue.recharges.arn
}

output "recharge_queue_name" {
  value = aws_sqs_queue.recharges.name
}

output "recharge_dlq_url" {
  value = aws_sqs_queue.recharges_dlq.id
}

output "recharge_dlq_name" {
  value = aws_sqs_queue.recharges_dlq.name
}

output "user_topic_arn" {
  value = aws_sns_topic.user_notifications.arn
}

output "ops_topic_arn" {
  value = aws_sns_topic.ops_alerts.arn
}
