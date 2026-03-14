# Protheus Terraform Helm Module

Terraform wrapper for deploying the Protheus Helm chart.

## Usage

```hcl
module "protheus" {
  source = "./client/runtime/deploy/terraform/protheus_helm"

  release_name     = "protheus"
  namespace        = "protheus"
  image_repository = "protheuslabs/infring"
  image_tag        = "latest"
  existing_secret_name = "protheus-runtime-secrets"
  daemon_enabled   = true
  daemon_replicas  = 2
  sso_enabled      = true
  sso_issuer_url   = "https://issuer.example.com"
  sso_client_id    = "protheus"
  nvidia_enabled   = false
}
```

## Apply

```bash
terraform init
terraform apply
```
