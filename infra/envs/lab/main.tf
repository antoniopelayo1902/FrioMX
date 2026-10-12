data "aws_caller_identity" "current" {}

# Learner Lab: no se crean ni se leen recursos IAM (sin iam:GetRole / iam:GetInstanceProfile).
# Se usan el rol y el perfil que ya existen, por nombre.
locals {
  account_id   = data.aws_caller_identity.current.account_id
  lab_role_arn = "arn:aws:iam::${local.account_id}:role/${var.lab_role_name}"
  app_tz       = "America/Mexico_City"
  metrics_ns   = "FrioMx"
  # Rutas relativas: el estado no cambia entre la Mac y el runner del CD.
  lambdas_dist  = "${path.root}/../../../lambdas/dist"
  lambdas_build = "${path.root}/.build"
}

module "network" {
  source        = "../../modules/network"
  instance_type = var.instance_type
}

module "compute" {
  source                = "../../modules/compute"
  instance_type         = var.instance_type
  subnet_id             = module.network.subnet_id
  security_group_id     = module.network.security_group_id
  eip_allocation_id     = module.network.eip_allocation_id
  instance_profile_name = var.lab_instance_profile_name
}

module "data" {
  source = "../../modules/data"
}

module "storage" {
  source     = "../../modules/storage"
  account_id = local.account_id
  region     = var.region
}

module "secrets" {
  source = "../../modules/secrets"
}

module "messaging" {
  source       = "../../modules/messaging"
  alert_emails = var.alert_emails
}

module "functions" {
  source             = "../../modules/functions"
  role_arn           = local.lab_role_arn
  dist_dir           = local.lambdas_dist
  build_dir          = local.lambdas_build
  tables             = module.data.table_names
  user_topic_arn     = module.messaging.user_topic_arn
  recharge_queue_arn = module.messaging.recharge_queue_arn
  metrics_namespace  = local.metrics_ns
  app_tz             = local.app_tz
}

module "monitoring" {
  source            = "../../modules/monitoring"
  region            = var.region
  metrics_namespace = local.metrics_ns
  ops_topic_arn     = module.messaging.ops_topic_arn
  queue_name        = module.messaging.recharge_queue_name
  dlq_name          = module.messaging.recharge_dlq_name
  instance_id       = module.compute.instance_id
  function_names    = module.functions.function_names
}
