variable "account_id" {
  type = string
}

variable "region" {
  type = string
}

locals {
  buckets = {
    uploads   = "friomx-uploads-${var.account_id}"
    artifacts = "friomx-artifacts-${var.account_id}"
  }
}

# Los buckets se crean con la AWS CLI y no con aws_s3_bucket: después de crear,
# el provider siempre lee s3:GetBucketObjectLockConfiguration y el SCP del
# Learner Lab lo niega. La configuración de cada bucket sí va en Terraform
# (esas lecturas están permitidas).
# Al destruir, `aws s3 rb --force` borra los objetos que queden y el bucket
# (scripts/destroy.sh además vacía todas las versiones antes).
resource "terraform_data" "bucket" {
  for_each = local.buckets

  input = {
    name   = each.value
    region = var.region
  }

  provisioner "local-exec" {
    command = "aws s3api head-bucket --bucket \"$BUCKET\" --region \"$REGION\" >/dev/null 2>&1 || aws s3api create-bucket --bucket \"$BUCKET\" --region \"$REGION\" >/dev/null && aws s3api wait bucket-exists --bucket \"$BUCKET\" --region \"$REGION\""
    environment = {
      BUCKET    = self.input.name
      REGION    = self.input.region
      AWS_PAGER = ""
    }
  }

  provisioner "local-exec" {
    when    = destroy
    command = "if aws s3api head-bucket --bucket \"$BUCKET\" --region \"$REGION\" >/dev/null 2>&1; then aws s3 rb \"s3://$BUCKET\" --force --region \"$REGION\"; fi"
    environment = {
      BUCKET    = self.input.name
      REGION    = self.input.region
      AWS_PAGER = ""
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = terraform_data.bucket
  bucket   = each.value.output.name

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each = terraform_data.bucket
  bucket   = each.value.output.name

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = terraform_data.bucket
  bucket   = each.value.output.name

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = terraform_data.bucket["artifacts"].output.name

  rule {
    id     = "expire-releases"
    status = "Enabled"

    filter {
      prefix = "releases/"
    }

    expiration {
      days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

output "uploads_bucket" {
  value = terraform_data.bucket["uploads"].output.name
}

output "artifacts_bucket" {
  value = terraform_data.bucket["artifacts"].output.name
}

output "uploads_bucket_arn" {
  value = "arn:aws:s3:::${terraform_data.bucket["uploads"].output.name}"
}

output "artifacts_bucket_arn" {
  value = "arn:aws:s3:::${terraform_data.bucket["artifacts"].output.name}"
}
