terraform {
  required_version = ">= 1.5.0"

  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = ">= 2.11.0"
    }
  }
}

resource "helm_release" "protheus" {
  name             = var.release_name
  namespace        = var.namespace
  create_namespace = true

  chart = var.chart_path

  values = [
    yamlencode({
      image = {
        repository = var.image_repository
        tag        = var.image_tag
      }
      cron = {
        schedule = var.cron_schedule
      }
    })
  ]
}
