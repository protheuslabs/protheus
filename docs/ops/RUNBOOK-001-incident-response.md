# Runbook 001: Incident Response Procedures

**Owner:** Rohan Kapoor  
**Last Updated:** 2026-03-08  
**Review Cycle:** Quarterly  
**Severity Levels:** P1 (Critical), P2 (High), P3 (Medium), P4 (Low)

---

## Overview

This runbook defines standard operating procedures for handling production incidents within the Protheus platform. All responders should familiarize themselves with these procedures before an incident occurs.

## Incident Classification

| Level | Impact | Response Time | Owner Notification |
|-------|--------|---------------|-------------------|
| P1 | Service unavailable, data loss imminent | 15 min | Immediate page |
| P2 | Degraded performance, partial outage | 30 min | Slack alert + email |
| P3 | Minor feature unavailable, workarounds exist | 2 hours | Email only |
| P4 | Cosmetic issues, documentation fixes | 24 hours | Ticket queue |

## Response Playbook

### Phase 1: Detection & Triage (0-15 min)

1. **Acknowledge** the alert within monitoring system
2. **Classify** severity based on impact matrix above
3. **Create** incident channel in Slack: `#incident-YYYY-MM-DD-brief`
4. **Notify** on-call engineer if P1/P2

### Phase 2: Investigation (15-45 min)

1. Review recent deployments: `git log --since="4 hours ago" --oneline`
2. Check system health dashboards
3. Collect relevant logs and metrics
4. Update incident timeline in tracking doc

### Phase 3: Mitigation (varies)

1. Prioritize service restoration over root cause analysis
2. Document all actions taken in real-time
3. If rollback needed, follow emergency rollback procedure
4. Verify restoration with smoke tests

### Phase 4: Post-Incident (within 24 hours)

1. Schedule post-mortem within 24 hours for P1/P2
2. Document timeline, root cause, and remediation
3. Create follow-up action items with owners
4. Update this runbook if procedures evolved

## Communication Templates

### Initial Acknowledgment
```
Incident #1234 acknowledged at HH:MM UTC.
Severity: [P1/P2/P3/P4] | Responder: [Name]
Initial status: Investigating
```

### Status Updates (every 30 min for P1/P2)
```
[HH:MM] Update: [Brief status statement]
ETA next update: [HH:MM]
```

## Escalation Path

1. Primary on-call → 15 min
2. Engineering Manager → 30 min
3. Director of Engineering → 1 hour
4. CTO → 2 hours (P1 only)

## FIXME: Add weekend/holiday escalation procedures
# TODO: Define on-call rotation handoff procedure for incidents spanning multiple shifts
# See: https://wiki.protheus.io/escalation-procedures (internal link)

## Useful Commands

```bash
# Quick system status check
protheusctl status --all

# View recent logs
protheusctl logs --tail 100 --system core

# Check active alerts
protheusctl alerts list --active

# Emergency restart (requires authorization)
protheusctl emergency restart --system [name]
```

## Document History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-03-08 | 1.0 | Rohan Kapoor | Initial draft |

---

*This document is living documentation. All team members are encouraged to suggest improvements via PR.*
