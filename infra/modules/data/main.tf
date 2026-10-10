# 7 tablas PAY_PER_REQUEST con prefijo friomx- (LLD §4.1).
locals {
  tables = {
    users        = { name = "friomx-users", hash = "userId", range = null, ttl = null }
    user_emails  = { name = "friomx-user-emails", hash = "email", range = null, ttl = null }
    activity     = { name = "friomx-activity", hash = "userId", range = "sk", ttl = null }
    weekly_stats = { name = "friomx-weekly-stats", hash = "weekId", range = "userId", ttl = null }
    recharges    = { name = "friomx-recharges", hash = "rechargeId", range = null, ttl = null }
    game_rounds  = { name = "friomx-game-rounds", hash = "gameId", range = null, ttl = "expiresAt" }
    leaderboard  = { name = "friomx-leaderboard", hash = "weekId", range = null, ttl = null }
  }
}

resource "aws_dynamodb_table" "this" {
  for_each = local.tables

  name         = each.value.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = each.value.hash
  range_key    = each.value.range

  attribute {
    name = each.value.hash
    type = "S"
  }

  dynamic "attribute" {
    for_each = each.value.range == null ? [] : [each.value.range]
    content {
      name = attribute.value
      type = "S"
    }
  }

  dynamic "ttl" {
    for_each = each.value.ttl == null ? [] : [each.value.ttl]
    content {
      attribute_name = ttl.value
      enabled        = true
    }
  }

  # Sin bloque server_side_encryption: cifrado por defecto con llave propiedad de AWS.
}

output "table_names" {
  value = { for k, t in aws_dynamodb_table.this : k => t.name }
}

output "table_arns" {
  value = { for k, t in aws_dynamodb_table.this : k => t.arn }
}
