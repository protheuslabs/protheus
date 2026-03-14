# Deployment Verification Runbook

**Author:** Rohan Kapoor (VP Platform & Operations)  
**Last Updated:** 2026-03-14  
**Version:** 1.0.0  
**Review Cycle:** Quarterly

---

## Purpose

This runbook provides a standardized checklist for verifying deployments across all Protheus services. Following this procedure ensures consistent validation and reduces the risk of undetected deployment issues.

## Scope

Applies to all production deployments including:
- Microservices (Kubernetes deployments)
- Infrastructure changes (Terraform)
- Configuration updates (ConfigMaps, Secrets)
- Database migrations

## Pre-Deployment Checklist

- [ ] Change request approved in ServiceNow
- [ ] Rollback plan documented and tested within last 30 days
- [ ] Monitoring dashboards reviewed for baseline metrics
- [ ] On-call engineer notified of deployment window
- [ ] Feature flags configured (if applicable)

## Deployment Verification Steps

### 1. Immediate Post-Deployment (0-5 minutes)

```bash
# Check pod status
kubectl get pods -l app=<service-name> -w

# Verify deployment rollout
kubectl rollout status deployment/<service-name>

# Check for crash loops
kubectl get pods -l app=<service-name> | grep -v Running
```

**Expected Result:** All pods in `Running` state, no restarts.

### 2. Health Endpoint Validation (5-10 minutes)

```bash
# Test health endpoint
curl -sf http://<service>/health || echo "HEALTH CHECK FAILED"

# Verify readiness probe
curl -sf http://<service>/ready || echo "READINESS CHECK FAILED"
```

**Expected Result:** HTTP 200 responses with valid JSON payloads.

### 3. Smoke Tests (10-15 minutes)

Execute the following smoke tests:

| Test | Command | Expected Result |
|------|---------|-----------------|
| API Latency | `curl -w "%{time_total}" http://<service>/api/v1/status` | < 500ms |
| Database Connectivity | Check application logs for DB pool status | "Healthy" |
| External Dependencies | Verify outbound connections | No timeouts |

### 4. Metrics Validation (15-30 minutes)

Review the following in Grafana:

- [ ] Error rate < 0.1%
- [ ] P99 latency within SLO
- [ ] Memory usage stable
- [ ] CPU utilization normal
- [ ] No abnormal log patterns

## Sign-Off

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Deployer | | | |
| SRE Reviewer | | | |
| Product Owner (if major) | | | |

## Troubleshooting

### Issue: Pods stuck in Pending

**Symptoms:** Deployment appears hung, pods not transitioning to Running.

**Resolution:**
1. Check resource quotas: `kubectl describe resourcequota`
2. Verify node capacity: `kubectl top nodes`
3. Review events: `kubectl get events --sort-by='.lastTimestamp'`

### Issue: Health checks failing

**Symptoms:** Pods restarting, service unavailable.

**Resolution:**
1. Check application logs: `kubectl logs -l app=<service-name> --tail=100`
2. Verify environment variables: `kubectl get configmap <config> -o yaml`
3. Test connectivity from within pod: `kubectl exec -it <pod> -- curl localhost:8080/health`

## References

- [Incident Response Playbook](./incident-response.md)
- [Auto-Rollback Script](../incident-response/auto-rollback.sh)
- [Service Level Objectives](https://wiki.internal/protheus/slos)

## Change Log

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-03-14 | Rohan Kapoor | Initial version |

---

*For questions or updates to this runbook, contact the Platform Operations team.*
