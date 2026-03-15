# Runbook 004: Log Aggregation and Analysis

**Owner:** Rohan Kapoor  
**Last Updated:** 2026-03-13  
**Review Cycle:** Quarterly  
**Environments:** staging, production

---

## Overview

This runbook documents procedures for aggregating and analyzing system logs across the Protheus platform. Proper log management ensures operational visibility and supports incident response.

## Log Aggregation Architecture

The Protheus platform generates logs across multiple components:
- **Core kernel** logs: `/var/log/protheus/core/`  
- **Client runtime** logs: `/var/log/protheus/client/`  
- **Adapter layer** logs: `/var/log/protheus/adapters/`  
- **CI pipeline** logs: Centralized via internal tooling

## Log Retention Policy

| Log Type | Retention Period | Compression |
|----------|------------------|-------------|
| DEBUG | 7 days | gzip after 24h |
| INFO | 30 days | gzip after 7 days |
| WARN | 90 days | gzip after 30 days |
| ERROR | 1 year | gzip after 90 days |

## Aggregation Procedures

### Daily Log Collection

Execute the log collection script to gather metrics from all nodes:

```bash
./tests/tooling/scripts/utils/log-analyzer.sh --aggregate --date=$(date -d "yesterday" +%Y-%m-%d)
```

### Weekly Analysis

Review patterns for anomalies:
- Error rate trends
- Memory utilization spikes
- Connection timeout patterns
- Security event frequency

## Troubleshooting Common Issues

**Issue:** Missing logs from adapter nodes  
**Solution:** Verify adapter health: `protheusctl adapter status`  

**Issue:** Compressed logs appear corrupted  
**Solution:** Re-run with `--force-recompress` flag

## See Also

- RUNBOOK-003: Database Maintenance
- tests/tooling/scripts/utils/log-analyzer.sh
