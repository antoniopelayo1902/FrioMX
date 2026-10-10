variable "region" {
  description = "Región de AWS del lab."
  type        = string
  default     = "us-east-1"
}

variable "alert_emails" {
  description = "Correos del equipo que reciben las alarmas (tema friomx-ops-alerts)."
  type        = list(string)

  validation {
    condition     = length(var.alert_emails) > 0
    error_message = "alert_emails no puede estar vacío: pon al menos un correo del equipo en lab.tfvars."
  }

  validation {
    condition     = !anytrue([for e in var.alert_emails : endswith(lower(trimspace(e)), "@example.com")])
    error_message = "alert_emails trae correos @example.com (los de lab.tfvars.example): cámbialos por los reales."
  }
}

variable "lab_role_name" {
  description = "Rol IAM que ya existe en Learner Lab (Lambdas). No se lee con iam:GetRole."
  type        = string
  default     = "LabRole"
}

variable "lab_instance_profile_name" {
  description = "Perfil de instancia que ya existe en Learner Lab (EC2). No se lee con iam:GetInstanceProfile."
  type        = string
  default     = "LabInstanceProfile"
}

variable "instance_type" {
  description = "Tipo de instancia EC2."
  type        = string
  default     = "t3.small"
}
