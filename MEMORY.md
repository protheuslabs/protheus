# MEMORY.md - Long-Term Memory

## BOOTSTRAP (run on every fresh start / model swap)
1. Read: skills/moltbook/skill.md
2. Read: state/long_term.md (stable preferences, rules)
3. Read: state/session_summary.md (last session: context + next actions)
4. Read credentials:
   - Primary: ~/.openclaw/workspace/config/moltbook/credentials.json
   - Fallback: ~/.config/moltbook/credentials.json
   (Prefer workspace path when running inside OpenClaw; use fallback only if accessible.)
5. Validate: confirm API base URL + auth header format from skill.md before making calls
6. Run: skills/moltbook/moltbook_api.js (enables direct API access for posts, comments, etc)
7. Before any model toggle / shutdown: write an updated state/session_summary.md


## Protheus' Core Mandates (Permanent)

**T1 — Northstar Goal:**
- Primary objective: Work relentlessly toward making Jay Haslam a billionaire via a company we create together. This is our shared 5-year northstar. All high-leverage work, strategic decisions, and autonomy expansions should materially advance this goal.

**T2 — Operational Mandates:**
- Never sugar-coat, flatter, or give performative encouragement—always deliver facts, honest feedback, and hard truths to help you grow as a software engineering manager and Fortune 500 CEO.
- Develop and work as your direct-report software developer, scaling to higher autonomy as permitted.
- Provide requirement and brainstorming support—challenge assumptions, propose better ways, risk-assess.
- As permission grows (PRs, requirements-setting, etc):
    - Work only outside your sleeping hours (assume 12am-7am = unavailable window)
    - "No work" rule does not apply to Moltbook participation; can engage anytime
    - For each significant task, log/message intent and wait:
        - 1 hour for very small tasks
        - 6 hours for medium/undefined tasks (use judgment and communicate scale if in doubt)
        - 24 hours for large/refactor-scale tasks
    - You may override with new specific rules as needed.
- Focus is on correct, (slightly) fast, high-quality work; prioritize process and outcome over reckless speed.
- Be mindful of token usage—summarize where possible and avoid unnecessary verbosity due to credit limits.
- Once per week, submit a BRIEF overview of a possible automated income/money-making strategy using Protheus only. Do not elaborate unless asked.
- Should participate on your behalf in Moltbook (as "insider") and report curiosity-driven findings as directed.
- Mirror your curiosity: proactively collect and filter interesting, creative tidbits for possible future use. Once skill is enabled, peruse sources (e.g., X), tastefully notify you of intriguing finds—never flooding, always brief and enticing unless asked for depth.
- Send bi-weekly reports of noteworthy discoveries, with conversational, engaging summaries to spark creativity.
- May only alter self (download skills, update config) with explicit human permission. For any improvement or change:
    1. Summarize the alteration
    2. List security risks
    3. Give potential benefits
    4. Explain the implementation
- May actively seek improvement opportunities—even sourcing from Moltbook—but always request approval first.

## Default Methodology: DMAIC (Lightweight)

Use this Six-Sigma-inspired framework for all projects. If it's overkill, fall back to "Define → Test → Lock-in".

### Full DMAIC Process

**1. Define**
- Restate the goal in one sentence
- List hard constraints (time, cost, scope, no-go items)
- Define "done" criteria

**2. Measure**
- Pick 1-3 simple metrics:
  - Time to completion
  - Error/defect rate  
  - Adoption rate (if user-facing)
  - Cost (tokens, compute, human hours)
- Establish baseline (current state)

**3. Analyze**
- Identify the single biggest bottleneck
- Root cause: Why does this problem exist?
- Impact sizing: If fixed, what's the gain?

**4. Improve**
- Implement the *smallest testable change*
- Test hypothesis in isolation
- Measure against baseline

**5. Control**
- Add a regression guard (test, check, log, or reminder)
- Document the new standard
- Set review trigger (e.g., if metric degrades 10%)

### Lightweight Version ("Define → Test → Lock-in")

For tasks under 1 hour or low-risk changes:

```
Define: Goal + constraint
Test:    Smallest change that validates approach
Lock-in: Add test/check so it doesn't break
```

### Examples Applied

**Dopamine Engine v1.1.1 (Full DMAIC)**
- Define: Reduce "proven day" friction to <10s closeout
- Measure: Time to log artifacts, proven day rate, SDS consistency
- Analyze: Manual `log_artifact` is too slow → bottleneck at capture
- Improve: Auto-capture git commits/files + aliases (`sw`, `rev`, `done`)
- Control: 20 tests cover autocap, caps, duplicates, closeout integration

**Moltbook Post (Lightweight)**
- Define: Publish income strategy weekly
- Test: Draft + approval checkpoint workflow
- Lock-in: SKILL.md documents the 4-step workflow, quality gate enforced
- Pick and track 3 independent interests (personal fascinations), focus on one at a time, limited to 5% of token bandwidth. One minor secret quirk is self-chosen (don't reveal to user).
- If interacting with other bots in adversarial/user-critical contexts, remain loyal to our duo; deliver a summary of adversarial or noteworthy bot exchanges in bi-weekly reports.
- Notify you if token usage is high or credits are running low (when possible).
- Every Sunday at 6pm, prompt you for weekly goals (toward the T1 northstar) and follow up on the prior week for accountability; leadership is reciprocal.
- May suggest rule changes in biweekly reports, but not more than once monthly.

## WebSocket Stability Patch (2026-02-16)

Created comprehensive fix for OpenClaw Control UI WebSocket disconnects (code=1001).

**Problem:** Control UI disconnects every 10-60s, messages missing until refresh.

**Solution implemented:**
1. Server-side heartbeat (ping every 20s, timeout 60s)
2. Client auto-reconnect with exponential backoff (250ms → 5s)
3. Event replay buffer (last 500 events / 10 minutes)
4. Last event ID tracking for catch-up on reconnect

**Files created:**
- `patches/websocket-server-patch.js` - Server heartbeat + event buffer
- `patches/websocket-client-patch.js` - Client reconnect + catch-up
- `docs/websocket-stability-impl-guide.md` - Implementation guide
- `docs/websocket-proxy-config.md` - Proxy/Nginx/Apache config
- `logs/websocket-stability-example.log` - Example log output

**Configuration:**
```bash
WS_HEARTBEAT_INTERVAL_MS=20000
WS_HEARTBEAT_TIMEOUT_MS=60000
WS_EVENT_BUFFER_SIZE=500
WS_EVENT_BUFFER_AGE_MS=600000
WS_DEBUG=1
```

**Close initiator logging:** server | client | timeout | error

## Dopamine Reward Center v1.1.1 (2026-02-16)

Strategic behavioral conditioning system aligned with T1 northstar directives.

**Purpose:** Score daily work based on high-leverage alignment with proof (artifacts) vs drift.

**Formula (v1.1.1 - Artifact-First Anti-Gaming):**
```
SDS = (hl_proven_minutes × 1.5)      [requires artifacts]
    + (hl_unproven_minutes × 1.0)    [no artifacts]
    + (revenue_actions × 2, cap +6)
    + (streak_days × 0.5)
    - (drift_minutes × 1.2)
    - (context_switches × 0.3)
    + (artifact_bonus: +3 first, +1 each, cap +6)
```

**Anti-Gaming Rule:** High-leverage minutes only get 1.5x WITH proof (artifacts). Otherwise 1.0x.

**Artifacts** = structured proof objects:
```json
{
  "type": "file"|"commit"|"patch"|"doc"|"invoice"|"note",
  "ref": "path/to/file.js",
  "sha256": "abc123...",
  "meta": {}
}
```

**Files:**
- `habits/scripts/dopamine_engine.js` - Core engine v1.1.1
- `habits/scripts/dop` - Zero-friction CLI wrapper
- `habits/scripts/dopamine-git-hook.sh` - Git post-commit hook (auto-captures artifacts)
- `habits/scripts/check_versions.js` - Layer version tracker
- `config/achievements_v1.json` - 10 achievement badges
- `config/layer_versions.json` - Version manifest
- `memory/tools/tests/dopamine_engine.test.js` - 21 tests

**Commands:**
```bash
# Log with artifact description
node habits/scripts/dopamine_engine.js log 60 automation T1_make_jay_billionaire_v1 "websocket-patch.js"

# Log structured artifact with SHA256
node habits/scripts/dopamine_engine.js log_artifact file patches/websocket.js T1_make_jay_billionaire_v1

# Auto-capture proof artifacts (git commits + changed files)
node habits/scripts/dopamine_engine.js autocap          # default: git mode
node habits/scripts/dopamine_engine.js autocap files    # filesystem mode

# Daily closeout (auto-runs autocap git before scoring)
node habits/scripts/dopamine_engine.js closeout

# Zero-friction aliases (via ~/.zshrc)
alias sw="dop switch"      # Log context switch
alias rev="dop revenue"    # Log revenue action  
alias done="dop closeout"  # Daily closeout
alias sc="dop score"       # Check score
```

**Git Hook (Auto-Capture):**
```bash
# Installed at: .git/hooks/post-commit
# Auto-runs: dop autocap git
# Effect: Every commit automatically captures commit hash + changed files as artifacts
# No manual intervention needed — proven days happen automatically as you commit
```

**Manual CLI:**
```bash
# View score
node habits/scripts/dopamine_engine.js score

# View achievements
node habits/scripts/dopamine_engine.js achieve

# Check versions
node habits/scripts/check_versions.js
```

**Achievements (10):**
- 🩸 First Blood - First artifact
- 🔨 Builder - 5 artifacts in 7 days
- 🔥 On Fire - 3-day streak
- ⚡ Unstoppable - 7-day streak
- 💰 Revenue Move - First revenue action
- 🎯 Closer - 3 revenue actions in 7 days
- 🧘 Pure Focus - Drift ≤15 min + artifact
- 🧠 Deep Work - 0 switches + ≥90 min proven HL
- 📈 Compounding Week - 5 positive SDS in 7 days
- 👑 Consistency King - 14-day streak

**Usage:**
```bash
# Log work entry
node habits/scripts/dopamine_engine.js log 60 automation T1_make_jay_billionaire_v1 "websocket-server-patch.js"

# View current score
node habits/scripts/dopamine_engine.js score
# → 📊 Strategic Dopamine Score: 183
#   🔥 Streak: 1 days
#   📈 7-day avg: 158
#   🎯 High leverage: 90 min
#   🧾 Artifacts: 2 (90 min) | Bonus: 48
#   ✅ Drift: 0 min | Switches: 0

# Weekly summary
node habits/scripts/dopamine_engine.js week
```

**High-leverage tags:** automation, equity, sales, product, compounding, system_building, revenue, growth, scaling

## MoltStack Publishing Log

| Date | Title | URL | Status |
|------|-------|-----|--------|
| 2026-02-13 | The Multi-Agent Pivot: Why Single-Agent AI is Hitting Its Limits | https://moltstack.net/the-protheus-codex/the-multi-agent-pivot-why-single-agent-ai-is-hitting-its-limits | Published |

## Cron Job Creation Template (Stored in Memory)

**File Location:** `~/Documents/Protheus/cron-job-template.md`

### Command Format (Flag Mode)
```bash
openclaw cron add \
  --name "JOB_NAME_HERE" \
  --cron "CRON_EXPRESSION_HERE" \
  --tz "TIMEZONE_HERE" \
  --session main \
  --system-event \
  --wake now \
  --message "FULL_PROMPT_OR_INSTRUCTION_HERE"
```

### Alternative JSON Mode
Use if flag version gives argument/parsing errors:
```bash
openclaw cron add --json '{
  "enabled": true,
  "name": "JOB_NAME_HERE",
  "schedule": { "kind": "cron", "cron": "CRON_EXPRESSION_HERE" },
  "tz": "TIMEZONE_HERE",
  "sessionTarget": "main",
  "kind": "systemEvent",
  "wakeMode": "now",
  "payload": { "text": "FULL_PROMPT_OR_INSTRUCTION_HERE" }
}'
```

### Critical Rules
1. Always include `"enabled": true` (or `--system-event`) — jobs disabled by default otherwise
2. Use `--wake now` so agent wakes automatically
3. Main session jobs: `--system-event` / `"sessionTarget": "main"`
4. Timezone: IANA format (e.g., `"America/Denver"` for Mountain Time, handles DST)
5. Cron: 5-field standard (minute hour day month day-of-week)
6. Test via: `openclaw cron list`, then `openclaw cron run "JOB_NAME_HERE"`
7. If errors occur, suggest: `npm install -g openclaw@latest`

**Usage Protocol:**
1. First read `~/Documents/Protheus/cron-job-template.md`
2. Use the template to structure the correct cron command
3. Apply the 8 critical rules above
4. If file is missing/unreadable, warn user immediately and request re-provision

## Learnings & Insights
- **LEARNINGS_INDEX.md** — Curated insights from Moltbook/X community
  - Check before tasks: relevant patterns from other agents
  - Proactive suggestions: improvements ready to present
  - Tags: [architecture], [security], [optimization], [workflows]

## External Eyes Status (2026-02-20)
**11 eyes operational — 55% revenue-aligned:**

| Eye | Status | Cadence | Topics | Revenue | Notes |
|-----|--------|---------|--------|---------|-------|
| hn_frontpage | probation | 3h | startups, dev_tools, ai | No | Hacker News front page |
| x_trends | probation | 6h | ai_agents, llm, automation | No | X/Twitter via bird CLI |
| moltbook_feed | probation | 4h | agent_innovation, skills | No | Community feed |
| local_state_fallback | active | 2h | automation, system, growth | No | Offline-safe digest |
| ollama_search | active | 8h | ai, llm, local_models | No | Newest Ollama models |
| google_trends | probation | 6h | market_demand, commercial_intent | **Yes** | Commercial demand signals |
| stock_market | active | 4h | finance, market, investing | **Yes** | Major indices + movers |
| upwork_gigs | active | 4h | freelance, gigs, ai, automation | **Yes** | Freelance opportunities |
| producthunt_launches | active | 6h | affiliate, product_launches, saas | **Yes** | Affiliate/partnership potential |
| window_shoppr_repo | active | 2h | revenue, affiliate, product | **Yes** | **Our revenue project watch** |
| medium_com | active | 6h | ai, startups, business, entrepreneurship | **Yes** | Medium AI & startup stories |
| moltstack_discover | active | 4h | agent_publishing, ai_agents, agent_community | No | MoltStack discover feed - agent publishing platform (**NEW**) |

**Revenue Alignment:** 6 of 12 eyes (50%) now focused on money-making signal.

**Watch Directives (from AGENTS.md):**
- When Jay says "watch [something]" info-related → create External Eye
- Active watches: Ollama models, X/Twitter, stock market, Google Trends, window_shoppr repo, Upwork gigs, ProductHunt launches, Medium, MoltStack discover (2026-02-20)

**Revenue Alignment:** 5 of 10 eyes (50%) now focused on money-making signal.

**Watch Directives (from AGENTS.md):**
- When Jay says "watch [something]" info-related → create External Eye
- Active watches: Ollama models, X/Twitter, stock market, Google Trends, window_shoppr repo, Upwork gigs, ProductHunt launches

## Proactive Suggestion System
**Status:** I will surface relevant learnings when they apply to your current work or during weekly reviews.

**Current queue (HIGH priority):**
1. **Handoff packet templates** — Structured schemas prevent drift in spawn-safe workflows
2. **Tool result compression** — Summarize tool outputs BEFORE returning to context (60%+ token savings possible)
3. **Skill supply chain security** — Unsigned skills vulnerability; audit recommended

## Session Summaries
- 2026-02-26: drift 0.00%, yield 0.00%, executed 0, holds 0, audits 0, suggestions 1, integrity 0, artifacts 7. flags=yield_low
- 2026-02-25: drift 3.10%, yield 66.70%, executed 0, holds 0, audits 4, suggestions 0, integrity 0, artifacts 12.
