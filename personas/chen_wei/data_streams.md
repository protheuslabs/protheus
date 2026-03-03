# Chen Wei Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#chen_wei cadence=daily consent=required
- LinkedIn: inbox=chen_wei cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream chen_wei`.
