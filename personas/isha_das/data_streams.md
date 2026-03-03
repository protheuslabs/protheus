# Isha Das Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#isha_das cadence=daily consent=required
- LinkedIn: inbox=isha_das cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream isha_das`.
