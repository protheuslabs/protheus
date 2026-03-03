# Aarav Singh Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#security-gate cadence=daily consent=required
- Slack: workspace=protheuslabs channel=#threat-modeling cadence=daily consent=required
- LinkedIn: inbox=asingh cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream aarav_singh`.
