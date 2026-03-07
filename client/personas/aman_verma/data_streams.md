# Aman Verma Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#aman_verma cadence=daily consent=required
- LinkedIn: inbox=aman_verma cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream aman_verma`.
