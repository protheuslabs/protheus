---
date: 2026-02-27
type: milestone
status: complete
---

# V2 ADVISORY MODE ACTIVATION

## ✅ COMPLETED

### V2 Component Sealing
- [x] Helix: ENABLED → Advisory Mode
- [x] Echo: ENABLED → Advisory Mode
- [x] Weaver: Already Active
- [x] All 47 files integrity verified

### Polymarket Installation
- [x] Installing polymarket-arbitrage skill (in progress)
- [ ] Configure paper trading mode
- [ ] Test dry-run detection
- [ ] First sync with Polymarket orderbook

## NEXT: Polymarket-Arbitrage Configuration

### Step 1: Skill Setup
```bash
# Configure in dry-run / paper trading mode only
node ~/.openclaw/workspace/skills/polymarket-arbitrage/cli.js --mode=paper --dry-run
```

### Step 2: Market Discovery
- Monitor BTC 5-minute YES/NO markets
- Track YES ask + NO ask < $1 arb opportunities
- Log potential edges, no execution

### Step 3: 24h Observation
- Track detection accuracy
- Monitor for stability
- Zero wallet interaction

## Safety Rules
- NO wallet connection until Heroic Echo validates
- NO auto-execution until 48h stable
- NO real funds until $100 paper profit verified
## Configuration

### Helix (Immortal Helix)
- **Codex verified**: 4 bootstrap truths loaded
- **Strand tracking**: systems/, lib/, config/
- **Shadow**: FALSE → Advisory: TRUE
- **Integrity**: All files sealed

### Echo (Heroic Echo + Purification Gate)
- **Shadow**: FALSE → Advisory: TRUE
- **Allow apply**: TRUE
- **Thresholds**: Destructive 0.18, Distress 0.16, Contradictory 0.24
- **Patterns**: 8 constructive categories

### Weaver
- **Already active**: shadow_only was already false
- **Metric schema**: Joy weight 0.08, adaptive_value default

## Blockers Cleared
- [x] V2 integrity sealing (was already done)
- [x] Advisory mode flip
- [x] Polymarket skill install (in progress)

## Blockers Remaining
- [ ] Wallet connection (requires Heroic Echo validation)
- [ ] Live execution (requires 48h paper success)
- [ ] Auto-trading (requires $100 profit + manual verification)

## Timeline
- **T+0**: V2 advisory activated (01:20 MT)
- **T+24h**: Polymarket dry-run evaluation
- **T+48h**: Paper trading activation (if stable)
- **T+7d**: Consider live with small budget ($10)

## Status: IN MOTION
Protheus is now capable of advisory-mode execution.
Polymarket arbitrage detection is the first experiment.

**Commander authorized. Soldier executing.** 🔥
