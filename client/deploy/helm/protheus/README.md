# Protheus Helm Chart

This chart deploys the scheduled Protheus spine workload with hardened defaults.

## Install

```bash
helm upgrade --install protheus ./client/deploy/helm/protheus --namespace protheus --create-namespace
```

## Key Values

- `image.repository`, `image.tag`: runtime image source
- `cron.schedule`: cadence for the daily spine run
- `runtimeConfig`: environment contract injected via ConfigMap
- `networkPolicy.enabled`: deny-by-default ingress + controlled egress
