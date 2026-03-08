# Research Demo

Run the research command in proposal mode:

```bash
protheus research "creating a quant trading software" --dry-run=1
```

Programmatic call from loop/shadow code:

```js
const { systemResearch } = require('../../client/systems/tools/research_api.js');
const result = systemResearch('creating a quant trading software', { dryRun: true, format: 'json' });
```

Expected output includes:

- query budget report
- hybrid evidence hits
- research-organ confidence/proposals
- Core-5 review/arbitration
- optional Codex sprint prompt for implementation-intent queries
