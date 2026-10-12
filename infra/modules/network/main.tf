variable "instance_type" {
  description = "Se usa para elegir una zona donde ese tipo exista."
  type        = string
}

data "aws_vpc" "default" {
  default = true
}

# En us-east-1 hay zonas sin t3 (use1-az3): se filtran las subredes por oferta.
data "aws_ec2_instance_type_offerings" "this" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }

  filter {
    name   = "availability-zone"
    values = data.aws_ec2_instance_type_offerings.this.locations
  }
}

locals {
  subnet_id = sort(data.aws_subnets.default.ids)[0]
}

resource "aws_security_group" "web" {
  name        = "friomx-web"
  description = "FrioMx: HTTP 80 publico, sin SSH (administracion por SSM)"
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name = "friomx-web"
  }
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  security_group_id = aws_security_group.web.id
  description       = "HTTP"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.web.id
  description       = "Salida abierta"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_eip" "web" {
  domain = "vpc"

  tags = {
    Name = "friomx-web"
  }
}

output "vpc_id" {
  value = data.aws_vpc.default.id
}

output "subnet_id" {
  value = local.subnet_id
}

output "security_group_id" {
  value = aws_security_group.web.id
  # La instancia no debe arrancar antes de tener salida a internet (dnf y SSM).
  depends_on = [aws_vpc_security_group_egress_rule.all]
}

output "eip_allocation_id" {
  value = aws_eip.web.id
}

output "public_ip" {
  value = aws_eip.web.public_ip
}
