variable "account_id" {
  type = string
}

locals {
  buckets = {
    uploads   = "friomx-uploads-${var.account_id}"
    artifacts = "friomx-artifacts-${var.account_id}"
  }
}

# force_destroy: el lab se destruye y recrea seguido; los datos son de prueba.
resource "aws_s3_bucket" "this" {
  for_each      = local.buckets
  bucket        = each.value
  force_destroy = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.this["artifacts"].id

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
  value = aws_s3_bucket.this["uploads"].id
}

output "artifacts_bucket" {
  value = aws_s3_bucket.this["artifacts"].id
}

output "uploads_bucket_arn" {
  value = aws_s3_bucket.this["uploads"].arn
}

output "artifacts_bucket_arn" {
  value = aws_s3_bucket.this["artifacts"].arn
}
