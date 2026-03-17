# Runbook: Service Discovery Troubleshooting

**Author:** Rohan Kapoor  
**Created:** 2026-03-17  
**Last Updated:** 2026-03-17  
**Severity:** P2 - Degraded service experience  
** ETA to Resolution:** 15-30 minutes

---

## Summary

This runbook addresses issues where services fail to register with or discover the spine router, resulting in "service unavailable" errors or routing failures.

Common symptoms:
- `503 Service Unavailable` responses from API calls
- `connection refused` errors between internal services
- Services appearing in logs but not responding to health checks
- Inconsistent service availability across zones

## Prerequisites

- Access to spine router logs (`/var/log/protheus/spine-router.log`)
- `curl` or `http` client for manual health checks
- `infringctl` CLI access (for internal routing inspection)

## Initial Assessment (5 minutes)

### 1. Check spine router health

```bash
curl -s http://localhost:8080/health | jq .
```

Expected output:
```json
{
  "status": "healthy",
  "services_registered": 12,
  "services_healthy": 11
}
```

If `services_healthy` is significantly lower than `services_registered`, continue to diagnostic steps.

### 2. Review recent router logs

```bash
tail -n 500 /var/log/protheus/spine-router.log | grep -E "(registration|deregistration|health.*fail|timeout)"
```

Look for patterns:
- Repeated registration/deregistration cycles
- Health check timeouts
- Connection refused errors

### 3. Verify service probe configuration

Check if `SPINE_ROUTER_PROBE_ALL` is enabled (should be `1` in production):

```bash
grep SPINE_ROUTER_PROBE_ALL /etc/protheus/environment
```

## Diagnostic Steps (10-15 minutes)

### Scenario A: Service fails to register

**Symptoms:** Service starts but doesn't appear in router health output.

1. Check service registration endpoint:
   ```bash
   curl -s http://localhost:8080/registry | jq '.services[] | select(.name == "service-name")'
   ```

2. Verify service health endpoint:
   ```bash
   curl -s http://service-ip:service-port/health
   ```

3. Check for port conflicts:
   ```bash
   ss -tlnp | grep service-port
   ```

### Scenario B: Service registers but marked unhealthy

**Symptoms:** Service appears in registry but `services_healthy` count excludes it.

1. Check service health check response time:
   ```bash
   time curl -s http://service-ip:service-port/health
   ```

2. Compare against configured timeout (default: 5s)

3. If response time > timeout, check service resource utilization:
   ```bash
   ps aux | grep service-name
   ```

### Scenario C: Intermittent connectivity

**Symptoms:** Service alternates between healthy and unhealthy states.

1. Check network latency between router and service:
   ```bash
   ping -c 100 service-ip | tail -1
   ```

2. Look for packet loss or high latency spikes

3. Review service logs for GC pauses or resource exhaustion

## Resolution

### For Scenario A (Registration failure)

1. Restart service with verbose logging:
   ```bash
   service-name --log-level=debug 2>&1 | tee /tmp/service-debug.log
   ```

2. Check for firewall rules blocking registration port

3. Verify service is built with correct router endpoint configuration

### For Scenario B (Health check failures)

1. Increase health check timeout temporarily:
   ```bash
   # Edit environment configuration
   HEALTH_CHECK_TIMEOUT_MS=10000
   ```

2. Restart affected service to clear any stuck connections

3. Monitor for 5 minutes to confirm stability

### For Scenario C (Intermittent issues)

1. Consider enabling circuit breaker if not already active:
   ```bash
   CIRCUIT_BREAKER_THRESHOLD=0.5
   ```

2. If network issues persist, escalate to infrastructure team

## Verification

After resolution, verify:

```bash
# Check all services healthy
curl -s http://localhost:8080/health | jq '.services_healthy == .services_registered'

# Spot-check a few service endpoints
curl -s http://localhost:8080/api/v1/status
```

## Prevention

### Recommendations from incident reviews:

1. **Monitor registration latency** - Set up alerts if registration takes > 2 seconds
2. **Health check optimization** - Keep health checks lightweight (< 50ms)
3. **Graceful shutdown** - Ensure services deregister on SIGTERM

### Related Runbooks

- [RUNBOOK-006: System Health Checks](./RUNBOOK-006-system-health-checks.md)
- [RUNBOOK-002: Deployment Procedures](./RUNBOOK-002-deployment-procedures.md)

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-03-17 | Rohan Kapoor | Initial version based on recent discovery issues |

## Notes

- **TODO:** Add automated playbook for common resolution steps
- **FIXME:** Current health check timeout is hardcoded; should be configurable per-service

---

*This document follows the Protheus operational runbook standards. For questions or updates, ping @rohan on Slack or open a PR.*
