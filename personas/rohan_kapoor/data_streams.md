# Rohan Kapoor Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#operations-runtime cadence=daily consent=required
- Slack: workspace=protheuslabs channel=#release-triage cadence=daily consent=required
- LinkedIn: inbox=rkapoor cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream rohan_kapoor`.
