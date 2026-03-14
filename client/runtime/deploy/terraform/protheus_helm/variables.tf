variable "release_name" {
  description = "Helm release name"
  type        = string
  default     = "protheus"
}

variable "namespace" {
  description = "Kubernetes namespace for Protheus"
  type        = string
  default     = "protheus"
}

variable "chart_path" {
  description = "Path to the Protheus Helm chart"
  type        = string
  default     = "../../helm/protheus"
}

variable "image_repository" {
  description = "Container image repository"
  type        = string
  default     = "protheuslabs/infring"
}

variable "image_tag" {
  description = "Container image tag"
  type        = string
  default     = "latest"
}

variable "cron_schedule" {
  description = "Cron schedule for spine workload"
  type        = string
  default     = "0 */4 * * *"
}

variable "existing_secret_name" {
  description = "Existing Kubernetes secret name for runtime credentials (optional)"
  type        = string
  default     = ""
}

variable "secret_optional" {
  description = "Whether the runtime secret reference is optional"
  type        = bool
  default     = true
}

variable "daemon_enabled" {
  description = "Enable always-on protheusd deployment"
  type        = bool
  default     = true
}

variable "daemon_replicas" {
  description = "Number of daemon replicas when enabled"
  type        = number
  default     = 2
}

variable "sso_enabled" {
  description = "Enable SSO environment projection"
  type        = bool
  default     = false
}

variable "sso_issuer_url" {
  description = "OIDC issuer URL"
  type        = string
  default     = ""
}

variable "sso_client_id" {
  description = "SSO client id"
  type        = string
  default     = ""
}

variable "nvidia_enabled" {
  description = "Enable NVIDIA adapter scheduling options"
  type        = bool
  default     = false
}

variable "nvidia_runtime_class_name" {
  description = "RuntimeClass name for NVIDIA workloads"
  type        = string
  default     = ""
}
