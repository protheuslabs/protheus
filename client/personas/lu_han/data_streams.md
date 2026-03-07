# Lu Han Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#lu_han cadence=daily consent=required
- LinkedIn: inbox=lu_han cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream lu_han`.
