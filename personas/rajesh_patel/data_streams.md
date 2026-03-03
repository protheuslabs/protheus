# Rajesh Patel Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#rajesh_patel cadence=daily consent=required
- LinkedIn: inbox=rajesh_patel cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream rajesh_patel`.
