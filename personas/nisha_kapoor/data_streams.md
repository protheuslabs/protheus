# Nisha Kapoor Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#nisha_kapoor cadence=daily consent=required
- LinkedIn: inbox=nisha_kapoor cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream nisha_kapoor`.
