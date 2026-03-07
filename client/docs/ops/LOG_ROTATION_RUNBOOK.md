# Log Rotation Runbook

Last updated: March 6, 2026

## Overview

This document describes the operational procedures for managing log rotation across Protheus infrastructure to prevent disk capacity issues.

## Manual Log Rotation

### Check Current Log Sizes

```bash
# View largest log files
find /var/log/protheus -type f -name "*.log" -exec ls -lh {} \; | sort -k5 -hr | head -20

# Check disk usage
df -h /var/log
```

### Rotate Logs Immediately

```bash
# Signal logrotate to run
sudo logrotate -f /etc/logrotate.d/protheus

# Verify rotation
ls -lh /var/log/protheus/
```

## Automated Rotation Schedule

| Log Type | Retention | Frequency |
|----------|-----------|-----------|
| Application logs | 7 days | Daily |
| Access logs | 30 days | Daily |
| Error logs | 90 days | Weekly |
| Debug logs | 3 days | Daily |

## Troubleshooting

### Issue: Logs not rotating automatically

**Symptoms:** Disk space warnings, stale log timestamps

**Resolution:**
1. Check logrotate status: `sudo logrotate -d /etc/logrotate.d/protheus`
2. Verify cron job: `crontab -l | grep logrotate`
3. Fix permissions if needed: `sudo chmod 644 /var/log/protheus/*.log`

## Related Documentation

- See OBSERVABILITY_STACK.md for monitoring setup
- See OPERATOR_RUNBOOK.md for incident response
