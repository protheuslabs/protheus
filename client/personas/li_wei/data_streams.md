# Li Wei Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#product-strategy cadence=daily consent=required
- Slack: workspace=protheuslabs channel=#growth-lab cadence=daily consent=required
- LinkedIn: inbox=lwei cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream li_wei`.
