# Varun Gupta Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#varun_gupta cadence=daily consent=required
- LinkedIn: inbox=varun_gupta cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream varun_gupta`.
