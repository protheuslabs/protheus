# Jay Haslam Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#founder-directives cadence=daily consent=required
- Slack: workspace=protheuslabs channel=#foundation-lock cadence=daily consent=required
- LinkedIn: inbox=jhaslam cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream jay_haslam`.
