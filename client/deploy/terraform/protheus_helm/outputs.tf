output "release_name" {
  description = "Helm release name"
  value       = helm_release.protheus.name
}

output "release_namespace" {
  description = "Helm release namespace"
  value       = helm_release.protheus.namespace
}

output "release_status" {
  description = "Helm release status"
  value       = helm_release.protheus.status
}
