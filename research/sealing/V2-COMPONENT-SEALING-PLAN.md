---
type: infrastructure_task
priority: high
blocks: v2_advisory_mode, polymarket_integration, revenue_generation
due: 2026-02-27
---

# V2 Component Sealing Plan

## Goal
Seal V2 hardening components to enable advisory/active mode flip.

## Components to Seal

### Helix (Immortal Helix)
- systems/helix/helix_controller.ts
- systems/helix/helix_controller.js
- systems/helix/sentinel_network.ts
- systems/helix/sentinel_network.js

**Purpose:** Strand verification, codex integrity, manifest building

### Echo (Heroic Echo)
- systems/echo/heroic_echo_controller.ts
- systems/echo/heroic_echo_controller.js
- systems/echo/input_purification_gate.ts
- systems/echo/input_purification_gate.js

**Purpose:** Input purification, belief integration, positive-only filtering

### Weaver
- systems/weaver/weaver_core.ts
- systems/weaver/weaver_core.js

**Purpose:** Metric overlay, regime tracking, autocorrelation detection

### Red Team (Soldier Ants)
- systems/redteam/ant_colony_controller.ts
- systems/redteam/ant_colony_controller.js

**Purpose:** 24/7 peaceful probing, organ hardening

## Hash Generation

Run this to generate fresh hashes:
```bash
cd ~/.openclaw/workspace && node -e "
const fs = require('fs');
const crypto = require('crypto');
const files = [
  'systems/helix/helix_controller.ts',
  'systems/helix/helix_controller.js',
  'systems/helix/sentinel_network.ts',
  'systems/helix/sentinel_network.js',
  'systems/echo/heroic_echo_controller.ts',
  'systems/echo/heroic_echo_controller.js',
  'systems/echo/input_purification_gate.ts',
  'systems/echo/input_purification_gate.js',
  'systems/weaver/weaver_core.ts',
  'systems/weaver/weaver_core.js',
  'systems/redteam/ant_colony_controller.ts',
  'systems/redteam/ant_colony_controller.js'
];
files.forEach(f => {
  if (fs.existsSync(f)) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    console.log('\\\"' + f + '\\\": \\\"' + hash + '\\\",');
  }
});
"
```

## Policy Update

Add hashes to: `config/security_integrity_policy.json`

Current sealed files: 41
Expected after sealing: 53

## Verification

After sealing:
1. Run integrity check: `node systems/security/integrity_kernel.js check`
2. Verify no violations
3. Test shadow runs for each component
4. Confirm no integrity blocks

## Advisory Mode Flip

Once sealed, can flip:
- `config/helix_policy.json`: shadow_only → false
- `config/echo_policy.json`: shadow_only → false, allow_apply → true
- `config/weaver_policy.json`: shadow_only → false

## Blockers Cleared

After sealing:
- [x] V2 components integrity-clean
- [ ] Can proceed to advisory mode
- [ ] Can install polymarket-arbitrage skill
- [ ] Can begin revenue experiments

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Files change after sealing | Re-seal on each update |
| Advisory mode untested | Shadow → Advisory → Active gradual |
| Purification gate false positives | Tune thresholds |

## Resources Required

- 30 min to seal
- Strong model review before advisory flip
- 24h observation period after flip
