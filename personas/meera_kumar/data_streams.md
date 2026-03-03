# Meera Kumar Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#meera_kumar cadence=daily consent=required
- LinkedIn: inbox=meera_kumar cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream meera_kumar`.
