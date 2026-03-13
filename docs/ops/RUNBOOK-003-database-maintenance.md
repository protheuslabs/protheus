# Runbook 003: Database Maintenance Procedures

**Owner:** Rohan Kapoor  
**Last Updated:** 2026-03-13  
**Review Cycle:** Monthly  
**Severity Levels:** P1 (Critical), P2 (High), P3 (Medium), P4 (Low)

---

## Overview

This runbook defines standard operating procedures for routine database maintenance tasks on the Protheus platform. Regular maintenance prevents performance degradation and ensures data integrity across all environments.

## Maintenance Categories

| Category | Frequency | Window | Impact |
|----------|-----------|--------|--------|
| Index Optimization | Weekly | Sat 02:00-04:00 UTC | Read-only queries briefly slower |
| Vacuum/Compaction | Daily | Thu 03:00-05:00 UTC | Minimal |
| Statistics Update | Daily | Every 6 hours | None |
| Log Rotation | Daily | 00:00 UTC | None |
| Backup Verification | Weekly | Sun 01:00 UTC | Minimal read I/O |

## Pre-Maintenance Checklist

- [ ] Verify backup completion from previous night
- [ ] Check current database size and growth rate
- [ ] Review active connections and long-running queries
- [ ] Confirm maintenance window with stakeholders (if P1/P2)
- [ ] Prepare rollback procedure

## Index Optimization Procedure

### Step 1: Analyze Fragmentation

```sql
-- Check index fragmentation levels
SELECT 
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexname::regclass)) as index_size,
    idx_scan as scans
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY pg_relation_size(indexname::regclass) DESC;
```

### Step 2: Rebuild Thresholds

| Fragmentation Level | Action |
|---------------------|--------|
| < 5% | No action required |
| 5-30% | REINDEX CONCURRENTLY |
| > 30% | Rebuild offline during maintenance window |

### Step 3: Execute Rebuild

```sql
-- For large tables, use CONCURRENTLY to avoid locks
REINDEX INDEX CONCURRENTLY idx_large_table_timestamp;

-- Verify rebuild completion
SELECT * FROM pg_stat_user_indexes WHERE indexname = 'idx_large_table_timestamp';
```

## Vacuum/Compaction Procedure

### Automated Vacuum

The system runs autovacuum, but manual vacuum is required for:
- Tables with high churn ( frequent INSERT/DELETE)
- Tables that were bulk-loaded
- Tables with significant bloat

### Manual Vacuum Command

```sql
-- Aggressive vacuum for bloated tables
VACUUM (VERBOSE, ANALYZE, FREEZE) large_event_table;

-- Check for remaining bloat
SELECT 
    relname,
    n_live_tup,
    n_dead_tup,
    round(n_dead_tup::numeric/n_live_tup::numeric, 2) as dead_tuple_ratio
FROM pg_stat_user_tables
WHERE n_live_tup > 0
ORDER BY dead_tuple_ratio DESC
LIMIT 20;
```

## Health Check Commands

```bash
# Check database connection pool status
protheusctl db status --pool

# Check replication lag (if applicable)
protheusctl db replication --lag

# View recent slow queries
protheusctl db logs --slow-queries --limit 50

# Verify backup integrity
protheusctl db backup --verify-latest
```

## Rollback Procedures

### Index Rebuild Failure

1. Stop the rebuild process if still running
2. Check for locks: `SELECT * FROM pg_locks WHERE NOT granted;`
3. Force terminate blocking connections if safe: 
   ```sql
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%REINDEX%';
   ```
4. Document the failure and reschedule

### Vacuum Failure

1. Check disk space: `df -h`
2. Check for locks contending with vacuum
3. If disk is full, expand storage or truncate logs before retry
4. Run targeted vacuum on specific tables only

## Monitoring Metrics

Track these metrics during and after maintenance:

| Metric | Warning Threshold | Critical Threshold |
|--------|-------------------|-------------------|
| CPU Usage | > 70% sustained | > 90% sustained |
| Disk I/O Wait | > 20% | > 50% |
| Active Connections | > 80% of max | > 95% of max |
| Query Latency p95 | > 500ms | > 1000ms |

## Communication

### Maintenance Start
```
[MAINTENANCE] Database maintenance starting at HH:MM UTC.
Expected duration: X hours.
Impact: Brief query slowdowns possible.
Status: #db-maintenance
```

### Maintenance Complete
```
[MAINTENANCE] Database maintenance completed at HH:MM UTC.
Actions taken: [brief summary]
Next maintenance: [date]
Status: All systems nominal
```

## TODO: Add section on sharded database maintenance

# FIXME: Define procedure for handling replication lag during vacuum

## Document History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-03-13 | 1.0 | Rohan Kapoor | Initial draft |

---

*This document is living documentation. All team members are encouraged to suggest improvements via PR.*
