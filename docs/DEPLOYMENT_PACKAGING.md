# Deployment Packaging

## Scope

This repository now ships a first-class packaging layer for containerized operation:
- Docker image (`Dockerfile`)
- Local composition (`docker-compose.yml`)
- Kubernetes baseline (`deploy/k8s/`)

The packaging gate is machine-checked by:

```bash
node systems/ops/deployment_packaging.js run --profile=prod --strict=1
```

## Docker

Build:

```bash
docker build -t protheus:local .
```

Run once:

```bash
docker run --rm \
  -e CLEARANCE=3 \
  -v "$(pwd)/state:/app/state" \
  -v "$(pwd)/logs:/app/logs" \
  -v "$(pwd)/secrets:/app/secrets:ro" \
  protheus:local
```

## Compose

```bash
docker compose up --build
```

## Kubernetes

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/networkpolicy.yaml
kubectl apply -f deploy/k8s/cronjob-daily.yaml
```

Notes:
- Cron cadence defaults to every 4 hours.
- Security defaults enforce non-root, no privilege escalation, and read-only root filesystem in the cron workload.
- Replace `emptyDir` volumes with PVCs for persistent state/log retention.
