# Sun Li Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#sun_li cadence=daily consent=required
- LinkedIn: inbox=sun_li cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream sun_li`.
