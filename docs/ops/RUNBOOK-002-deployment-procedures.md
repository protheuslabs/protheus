# Runbook 002: Deployment Procedures

**Owner:** Rohan Kapoor  
**Last Updated:** 2026-03-10  
**Review Cycle:** Quarterly  
**Environments:** staging, production

---

## Overview

This runbook defines standard operating procedures for deploying the Protheus platform across staging and production environments. All deployments must follow these procedures to ensure consistency, traceability, and rollback capability.

## Pre-Deployment Checklist

Before initiating any deployment, verify:

- [ ] All CI checks passing on the target commit
- [ ] Deployment window communicated to stakeholders (production only)
- [ ] Database migrations reviewed and tested in staging
- [ ] Feature flags configured appropriately for the environment
- [ ] Incident response team on standby (P1/P2 deployments)
- [ ] Rollback plan documented and validated

## Deployment Types

| Type | Description | Approval Required | Timing |
|------|-------------|-------------------|--------|
| Hotfix | Critical bug fix | Engineering Manager | Any time |
| Standard | Regular feature release | Tech Lead | Business hours |
| Maintenance | Infrastructure updates | Tech Lead | Scheduled window |
| Emergency | Security patch | CTO | Immediate |

## Staging Deployment

### Automated Deployment (Standard Path)

1. Merge PR to `main` branch
2. CI pipeline automatically triggers staging deployment
3. Monitor deployment progress in CI dashboard
4. Verify deployment completion via health checks
5. Run smoke tests against staging environment

### Manual Deployment (When CI is unavailable)

```bash
# Ensure you're on the correct commit
git checkout <commit-sha>

# Deploy to staging
./scripts/deploy.sh --environment staging --commit <commit-sha>

# Verify deployment
./scripts/utils/health-check-deployment.sh --full
```

## Production Deployment

### Phase 1: Pre-Deployment (T-30 min)

1. **Confirm** deployment window with stakeholders
2. **Freeze** non-critical merges to `main`
3. **Verify** the exact commit SHA to be deployed
4. **Prepare** incident channel: `#deployment-YYYY-MM-DD`
5. **Assign** roles:
   - Deployment Lead: Responsible for execution
   - Verification Lead: Runs post-deployment checks
   - Rollback Lead: Stands by for emergency procedures

### Phase 2: Deployment (T-0)

1. **Announce** in incident channel: "Beginning production deployment of commit <SHA>"
2. **Execute** deployment via CI or manual script
3. **Monitor** deployment logs in real-time
4. **Document** any anomalies or delays

```bash
# Production deployment command
./scripts/deploy.sh --environment production --commit <commit-sha> --notify
```

### Phase 3: Post-Deployment Verification (T+5 to T+30 min)

1. **Run** automated health checks
2. **Verify** critical user journeys (subset of smoke tests)
3. **Check** error rates and latency metrics
4. **Monitor** for alarms in the first 30 minutes

### Phase 4: Confirmation or Rollback (T+30 min)

**If successful:**
- Update deployment tracking sheet
- Announce completion in incident channel
- Unfreeze merges to `main`

**If issues detected:**
- Follow emergency rollback procedure immediately
- Do not attempt forward fixes during failed deployment

## Rollback Procedures

### Automated Rollback

```bash
# Rollback to previous stable version
./scripts/deploy.sh --environment production --rollback --target <previous-stable-sha>
```

### Manual Rollback (Emergency)

1. **Immediately** invoke rollback procedure
2. **Notify** incident channel of rollback initiation
3. **Do not** troubleshoot during rollback - restore service first
4. **Verify** service restoration with health checks
5. **Document** timeline of events for post-mortem

### Database Rollback Considerations

- **Backward-compatible migrations only** should be deployed
- If database changes were deployed, rollback requires special handling
- Consult DBA on-call for database-specific rollback procedures
- **Note:** Some migrations may not be reversible

## Monitoring During Deployment

Monitor these dashboards during and immediately after deployment:

| Dashboard | URL | Check Frequency |
|-----------|-----|-----------------|
| Application Metrics | https://grafana.protheus.io/d/app-metrics | Every 2 minutes |
| Error Rates | https://grafana.protheus.io/d/error-rates | Every 1 minute |
| Infrastructure | https://grafana.protheus.io/d/infrastructure | Every 5 minutes |
| Database | https://grafana.protheus.io/d/database | Every 5 minutes |

## Communication Templates

### Deployment Start
```
🚀 PRODUCTION DEPLOYMENT STARTED
Commit: <SHA>
Deployer: <Name>
Channel: #deployment-<date>
ETA: <time>
```

### Deployment Success
```
✅ PRODUCTION DEPLOYMENT COMPLETE
Commit: <SHA>
Duration: <minutes>
All health checks: PASSED
Next steps: <monitoring period>
```

### Deployment Issue Detected
```
⚠️ DEPLOYMENT ISSUE DETECTED
Commit: <SHA>
Issue: <brief description>
Action: Investigating / Rolling back
ETA resolution: <time>
```

## Deployment History

Deployments are automatically logged. View recent history:

```bash
# View last 10 deployments
./scripts/deploy.sh --history --limit 10

# View deployments for a specific date range
./scripts/deploy.sh --history --since 2026-03-01 --until 2026-03-10
```

## FIXME

- Add automated canary deployment procedure
- Document blue-green deployment process when implemented
- Add integration with deployment notification system

## TODO

- Create deployment calendar integration
- Automate post-deployment metric collection
- Build deployment correlation with incident reports

## Document History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-03-10 | 1.0 | Rohan Kapoor | Initial draft based on team practices |

---

*This document is living documentation. Suggest improvements via PR with the `ops-documentation` label.*
