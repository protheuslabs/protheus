# Protheus Terraform Helm Module

Terraform wrapper for deploying the Protheus Helm chart.

## Usage

```hcl
module "protheus" {
  source = "./client/deploy/terraform/protheus_helm"

  release_name     = "protheus"
  namespace        = "protheus"
  image_repository = "protheuslabs/protheus"
  image_tag        = "latest"
}
```

## Apply

```bash
terraform init
terraform apply
```
