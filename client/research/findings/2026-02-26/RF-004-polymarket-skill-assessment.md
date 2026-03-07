---
source: clawhub
source_type: skill_registry
discovered_at: 2026-02-26T22:52:00-07:00
confidence: verified
urgency: high
revenue_aligned: true
---

# Polymarket Skill Assessment

## Executive Summary
Multiple Polymarket trading skills available on clawhub. Risk varies significantly.

## Skills Analyzed

### 1. polymarket-arbitrage (RECOMMENDED)
- **Owner:** JohnY0920
- **Updated:** 2026-02-26 (today)
- **Risk Level:** Medium
- **Safety Features:**
  - Math arbitrage (not prediction)
  - Multi-outcome probability mismatch detection
  - Cross-market arbitrage
  - P&L tracking
  - Risk management built-in
- **Why Safe:** Exploits orderbook inefficiencies, not speculation

### 2. polymarket-api (CONSERVATIVE)
- **Owner:** dannyshmueli
- **Risk Level:** Low
- **Capabilities:** Read-only market data
- **Why Safe:** No trading, pure data access

### 3. polymarket-auto-trader (HIGH RISK)
- **Owner:** srikanthbellary
- **Risk Level:** High
- **Features:** Cron-based autonomous trading, Kelly criterion sizing
- **Why Risky:** Full auto-execution, wallet connection required

### 4. argus-edge
- **Owner:** JamieRossouw
- **Risk Level:** Medium-High
- **Strategy:** Kelly criterion bet sizing, TA-implied probability

### 5. mia-polymarket-trader
- **Risk Level:** High
- **Capabilities:** Automated trading

## Recommendation
Start with `polymarket-arbitrage` in shadow/dry-run mode. Requires:
1. V2 component sealing (for wallet safety)
2. Strict budget limits
3. No autonomous execution (human approval)

## Blockers
- [ ] Helix/Sentinel not active (shadow-only)
- [ ] Echo/Purification not active (shadow-only)
- [ ] Wallet connection requires security hardening
- [ ] Transaction signing needs verification layer

## Cross-References
- RF-003: Agent crypto revenue channels
- GROK: $397k Polymarket arb verified authentic
