# Secreto JWT: 64 caracteres; solo letras, números, "-" y "_" (sin comillas ni "=").
resource "random_password" "jwt" {
  length           = 64
  special          = true
  override_special = "-_"
}

# recovery_window_in_days = 0 permite destroy + apply con el mismo nombre.
resource "aws_secretsmanager_secret" "jwt" {
  name                    = "friomx/jwt-secret"
  description             = "Secreto de firma de los JWT de FrioMx"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "jwt" {
  secret_id     = aws_secretsmanager_secret.jwt.id
  secret_string = random_password.jwt.result
}

output "jwt_secret_arn" {
  value = aws_secretsmanager_secret.jwt.arn
}
