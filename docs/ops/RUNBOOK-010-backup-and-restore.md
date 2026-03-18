# Runbook 010: Backup and Restore Procedures

**Owner:** Rohan Kapoor
**Last Updated:** 2026-03-18
**Review Cycle:** Quarterly
**Environments:** staging, production
**Severity:** Critical (P1 if restore needed)

---

## Overview

This runbook defines the procedures for backing up critical Protheus system data and performing restores when necessary. All backup operations are automated, but manual intervention procedures are documented here for incident response and disaster recovery scenarios.

## Backup Scope

The following components are included in automated backups:

| Component | Frequency | Retention | Storage Location |
|-----------|-----------|-----------|------------------|
| State database | Hourly | 30 days | S3 (encrypted) |
| Configuration files | Daily | 90 days | S3 + Git |
| Audit logs | Real-time | 1 year | S3 Glacier |
| Session artifacts | Daily | 7 days | S3 (IA) |
| TLS certificates | On renewal | Unlimited | Secrets manager |

## Automated Backups

### State Database Backups

Automatic hourly snapshots are captured by the `state-backup` service:

```bash
# Verify backup service status
systemctl status protheus-state-backup

# Check last successful backup timestamp
./scripts/utils/backup-status.sh --component state

# View recent backup history
./scripts/utils/backup-status.sh --component state --limit 10
```

**Success Criteria:**
- Backup completes within 5 minutes of the hour
- Backup size within 20% of previous (alert if anomalous)
- S3 upload succeeds with MD5 verification

### Configuration Backups

Configuration is backed up daily at 02:00 UTC:

```bash
# Trigger manual configuration backup
./scripts/utils/backup-config.sh --environment production

# Verify backup integrity
./scripts/utils/backup-verify.sh --type config --date 2026-03-18
```

## Manual Backup Procedures

### Emergency State Backup

If automated backups are failing, manually trigger a state backup:

```bash
# Create immediate state snapshot
./scripts/utils/backup-state.sh --immediate --tag emergency-$(date +%Y%m%d-%H%M%S)

# Verify the backup was created
aws s3 ls s3://protheus-backups/state/ --recursive | tail -5
```

### Pre-Deployment Configuration Backup

Always backup configuration before major deployments:

```bash
# Pre-deployment backup with deployment tag
./scripts/utils/backup-config.sh --tag pre-deploy-$(git rev-parse --short HEAD)

# Store backup reference in deployment log
echo "Backup: pre-deploy-$(git rev-parse --short HEAD)" >> deployment.log
```

## Restore Procedures

### State Database Restore

**⚠️ WARNING:** State restore results in loss of data since the backup timestamp. Use only in disaster recovery scenarios.

```bash
# Step 1: Identify target backup
aws s3 ls s3://protheus-backups/state/ --recursive | grep "2026-03-18"

# Step 2: Stop writes to state (maintenance mode)
./scripts/maintenance-mode.sh --enable --reason "state-restore-$(date +%Y%m%d)"

# Step 3: Execute restore
./scripts/utils/restore-state.sh --from s3://protheus-backups/state/2026-03-18-140000.tar.gz --verify

# Step 4: Resume operations
./scripts/maintenance-mode.sh --disable

# Step 5: Verify system health
./tests/tooling/scripts/utils/health-check-deployment.sh --full
```

### Point-in-Time Recovery

For corruption detected within the backup window:

```bash
# List available backup points
./scripts/utils/restore-list.sh --component state --since "2026-03-17 00:00"

# Restore specific timestamp
./scripts/utils/restore-state.sh --timestamp "2026-03-18-12:00:00" --verify
```

## Backup Verification

### Daily Verification (Automated)

The following checks run automatically:

1. **Integrity Check:** Backup files have valid checksums
2. **Size Check:** Backup size within expected range
3. **Age Check:** Most recent backup is < 2 hours old
4. **Restore Test (Staging):** Weekly automated restore test

### Manual Verification

```bash
# Run all verification checks
./scripts/utils/backup-verify.sh --full

# Check specific component
./scripts/utils/backup-verify.sh --component state

# Generate verification report
./scripts/utils/backup-verify.sh --report --output backup-report-$(date +%Y%m%d).md
```

## Monitoring and Alerting

### Backup Failure Alerts

| Alert | Condition | Escalation |
|-------|-----------|------------|
| `backup-state-failed` | Hourly backup fails 2x in a row | Page on-call engineer |
| `backup-config-stale` | No config backup in 36 hours | Slack alert → Email after 1h |
| `backup-size-anomaly` | Backup size delta > 50% | Ticket for investigation |
| `backup-verification-failed` | Integrity check fails | Page on-call engineer |

### Dashboards

- Backup Status: `https://grafana.protheus.io/d/backup-status`
- Restore History: `https://grafana.protheus.io/d/restore-history`
- S3 Bucket Metrics: `https://grafana.protheus.io/d/s3-backup-metrics`

## Disaster Recovery

### Recovery Time Objectives

| Scenario | RTO | RPO |
|----------|-----|-----|
| Single AZ failure | 15 minutes | 0 (multi-AZ active) |
| Database corruption | 30 minutes | 1 hour |
| Complete region failure | 4 hours | 1 hour |
| Catastrophic total loss | 8 hours | 1 hour |

### Cross-Region Replication

Backups are automatically replicated to secondary region:

```bash
# Check replication status
aws s3 sync --dry-run s3://protheus-backups/state/ s3://protheus-backups-dr/state/

# List DR region backups
aws s3 ls s3://protheus-backups-dr/state/ --profile dr-region
```

## Communication

### Backup Incident Response

**Severity Assessment:**
- **P1:** Restore required in production
- **P2:** Backup failure that may affect P1 recovery
- **P3:** Staging backup issues
- **P4:** Verification warnings, documentation gaps

**Notification Template (P1/P2):**
```
🚨 BACKUP INCIDENT
Component: <state/config/logs>
Issue: <brief description>
Impact: <restore capability assessment>
Action: <investigation/restore/mitigation>
ETA: <time estimate>
```

## TODO

- Document automated restore testing procedure
- Add backup encryption key rotation procedure
- Create runbook for partial state restore scenarios
- Document cross-account backup access procedures
- Add RTO/RPO validation testing steps

## FIXME

- Backup verification sometimes times out on large state files
- Need better documentation for point-in-time selection
- CLI tooling for restore is inconsistent across components

## Document History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-03-18 | 1.0 | Rohan Kapoor | Initial draft based on SRE team requirements |

---

*This document is living documentation. Suggest improvements via PR with the `ops-documentation` label.*
