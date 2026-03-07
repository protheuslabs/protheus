# Riya Mittal Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#riya_mittal cadence=daily consent=required
- LinkedIn: inbox=riya_mittal cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream riya_mittal`.
