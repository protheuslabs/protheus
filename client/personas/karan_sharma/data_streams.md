# Karan Sharma Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#karan_sharma cadence=daily consent=required
- LinkedIn: inbox=karan_sharma cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream karan_sharma`.
