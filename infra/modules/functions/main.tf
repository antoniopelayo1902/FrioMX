variable "role_arn" {
  description = "ARN de LabRole."
  type        = string
}

variable "dist_dir" {
  description = "Ruta (relativa a -chdir) a lambdas/dist (la arma lambdas/build.sh)."
  type        = string
}

variable "build_dir" {
  description = "Carpeta donde se escriben los zip (infra/envs/lab/.build)."
  type        = string
}

variable "tables" {
  description = "Mapa de nombres de tablas del módulo data."
  type        = map(string)
}

variable "user_topic_arn" {
  type = string
}

variable "recharge_queue_arn" {
  type = string
}

variable "metrics_namespace" {
  type = string
}

variable "app_tz" {
  type = string
}

locals {
  common_env = {
    USER_TOPIC_ARN    = var.user_topic_arn
    METRICS_NAMESPACE = var.metrics_namespace
    APP_TZ            = var.app_tz
  }

  # Variables por función según LLD §6.
  functions = {
    recharge-worker = {
      timeout = 10
      memory  = 256
      env = merge(local.common_env, {
        TABLE_USERS     = var.tables["users"]
        TABLE_RECHARGES = var.tables["recharges"]
      })
    }
    daily-bonus = {
      timeout = 60
      memory  = 256
      env = merge(local.common_env, {
        TABLE_USERS = var.tables["users"]
      })
    }
    weekly-ranking = {
      timeout = 60
      memory  = 256
      env = merge(local.common_env, {
        TABLE_USERS        = var.tables["users"]
        TABLE_WEEKLY_STATS = var.tables["weekly_stats"]
        TABLE_LEADERBOARD  = var.tables["leaderboard"]
      })
    }
  }

  schedules = {
    daily-bonus    = "cron(0 14 * * ? *)"   # 08:00 Ciudad de México
    weekly-ranking = "cron(10 7 ? * MON *)" # lunes 01:10 Ciudad de México
  }
}

data "archive_file" "fn" {
  for_each    = local.functions
  type        = "zip"
  source_dir  = "${var.dist_dir}/${each.key}"
  output_path = "${var.build_dir}/${each.key}.zip"
}

resource "aws_cloudwatch_log_group" "fn" {
  for_each          = local.functions
  name              = "/aws/lambda/friomx-${each.key}"
  retention_in_days = 14
}

resource "aws_lambda_function" "fn" {
  for_each = local.functions

  function_name    = "friomx-${each.key}"
  role             = var.role_arn
  runtime          = "nodejs22.x"
  handler          = "${each.key}/index.handler"
  filename         = data.archive_file.fn[each.key].output_path
  source_code_hash = data.archive_file.fn[each.key].output_base64sha256
  timeout          = each.value.timeout
  memory_size      = each.value.memory
  architectures    = ["x86_64"]

  environment {
    variables = each.value.env
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.fn[each.key].name
  }

  depends_on = [aws_cloudwatch_log_group.fn]
}

# --- SQS -> recharge-worker ---
resource "aws_lambda_event_source_mapping" "recharges" {
  event_source_arn                   = var.recharge_queue_arn
  function_name                      = aws_lambda_function.fn["recharge-worker"].arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 1
  function_response_types            = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2
  }
}

# --- EventBridge (reglas con cron) ---
resource "aws_cloudwatch_event_rule" "schedule" {
  for_each            = local.schedules
  name                = "friomx-${each.key}"
  schedule_expression = each.value
}

resource "aws_cloudwatch_event_target" "schedule" {
  for_each  = local.schedules
  rule      = aws_cloudwatch_event_rule.schedule[each.key].name
  target_id = "friomx-${each.key}"
  arn       = aws_lambda_function.fn[each.key].arn
}

resource "aws_lambda_permission" "schedule" {
  for_each      = local.schedules
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.key].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.schedule[each.key].arn
}

output "function_names" {
  value = { for k, f in aws_lambda_function.fn : k => f.function_name }
}

output "function_arns" {
  value = { for k, f in aws_lambda_function.fn : k => f.arn }
}
