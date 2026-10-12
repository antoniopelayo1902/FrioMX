variable "instance_type" {
  type = string
}

variable "subnet_id" {
  type = string
}

variable "security_group_id" {
  type = string
}

variable "eip_allocation_id" {
  type = string
}

variable "instance_profile_name" {
  type = string
}

# Amazon Linux 2023 estándar, x86_64. Solo usa ec2:DescribeImages (no SSM).
# El prefijo "al2023-ami-2023.*" deja fuera las imágenes al2023-ami-minimal-*.
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-kernel-*-x86_64"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }
}

resource "aws_instance" "web" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [var.security_group_id]
  iam_instance_profile   = var.instance_profile_name
  user_data              = file("${path.module}/user_data.sh")

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 16
    encrypted             = true
    delete_on_termination = true
  }

  tags = {
    Name = "friomx-web"
  }

  # user_data solo aplica en la primera creación; una AMI nueva no debe reemplazar la instancia.
  lifecycle {
    ignore_changes = [user_data, ami]
  }
}

resource "aws_eip_association" "web" {
  instance_id   = aws_instance.web.id
  allocation_id = var.eip_allocation_id
}

output "instance_id" {
  value = aws_instance.web.id
}
