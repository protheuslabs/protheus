# InfRing Dashboard UI Spec (Regression Profile)

Last updated: 2026-03-20  
Owners: Runtime Ops / Dashboard lane  
Primary authority: `core/layer0/ops/src/dashboard_ui.rs`

## Purpose

This document is the canonical UI behavior contract for the InfRing dashboard so first-load UX and advanced controls do not regress during compaction, migration, or visual redesign.

## Scope

- Applies to default dashboard launch paths:
  - `infring dashboard`
  - `infring status --dashboard`
  - `infringd start|restart` (autoboot flow)
- Applies to Rust-core hosted dashboard authority (`protheus-ops dashboard-ui ...`).
- Legacy Node dashboard (`--node-ui`) is compatibility-only and must preserve equivalent operator semantics.

## Authority + Safety Boundary

- UI remains non-authoritative. All mutating actions route through lane-backed handlers in Rust core.
- Required action endpoint: `POST /api/dashboard/action`
- Required snapshot endpoint: `GET /api/dashboard/snapshot`
- Required health endpoint: `GET /healthz`
- All accepted/denied actions emit deterministic receipts (fail-closed behavior preserved).

## Default First-Load Contract (Chat-First)

On first load (or no persisted state), dashboard must render:

- Full-width chat surface as the primary focus.
- Advanced controls pane hidden.
- Top-left theme toggle visible.
- Standard light/dark palette options (no required neon/tron aesthetic dependency).
- Chat input composer visible with operator guidance text.
- Quick-action chips visible from chat surface.

No dense advanced control surface should be pre-opened by default.

## Advanced Controls Pane Contract

Controls pane behavior:

- Hidden by default.
- Toggled by explicit top-bar control.
- Closes from explicit close control and `Esc`.
- Persists open/closed state in local storage.
- Uses simple accordion panes (not dense dashboard tab chrome).

Required panes:

- `Chat`
- `Swarm / Agent Management`
- `Runtime Health`
- `Receipts & Audit`
- `Logs`
- `Settings`

Required first-class section:

- `Swarm / Agent Management`

## Chat UX Contract

Chat surface must provide:

- Scrollable turn stream.
- Input composer + send action.
- Status/typing hint affordance.
- Session and receipt hint visibility.

Required quick-action chips:

- `New Agent`
- `New Swarm`
- `Assimilate Codex`
- `Run Benchmark`
- `Open Controls`
- `Swarm Tab`

## Keyboard + Persistence Contract

Required keyboard behavior:

- `Enter` sends chat (without shift).
- `Esc` closes controls pane.
- `Cmd/Ctrl+K` focuses chat input.

Required local-storage keys:

- `infring_dashboard_theme_v2`
- `infring_dashboard_controls_open_v2`
- `infring_dashboard_controls_panes_v1`

## UI Action Receipt Contract

At minimum, these UI interaction actions must remain receipted:

- `dashboard.ui.toggleControls`
- `dashboard.ui.toggleSection`
- `dashboard.ui.switchControlsTab`

## Startup + Autoboot Contract

Daemon startup must support dashboard auto-boot/open control:

- `--dashboard-autoboot=1|0`
- `--dashboard-open=1|0`
- `--dashboard-host=<ip>`
- `--dashboard-port=<n>`

Expected runtime behavior:

- `start/restart` launches dashboard host when enabled.
- Start receipts include dashboard launch/running state.
- Stop receipts include dashboard stop attempt/result.

## Compatibility/Fallback Contract

- Dashboard must remain usable when external ESM/CDN path is unavailable.
- Inline/local shell path must still provide:
  - chat view
  - controls toggle/tabs
  - snapshot polling
  - action posting
  - receipts

## Regression Smoke (Operator)

Use a dedicated test port:

1. `target/debug/protheusd start --dashboard-open=0 --dashboard-host=127.0.0.1 --dashboard-port=41111`
2. `curl -fsS http://127.0.0.1:41111/healthz`
3. `target/debug/protheusd status --dashboard-host=127.0.0.1 --dashboard-port=41111`
4. `target/debug/protheusd stop --dashboard-host=127.0.0.1 --dashboard-port=41111`
5. `lsof -iTCP:41111 -sTCP:LISTEN -n -P` returns no listener.

## SRS Mapping

- `V6-DASHBOARD-001.1` through `V6-DASHBOARD-001.10`
- `V6-DASHBOARD-006.1` through `V6-DASHBOARD-006.4`

Any dashboard behavior change that impacts this spec must update both:

- `docs/workspace/SRS.md`
- `docs/workspace/INFRING_DASHBOARD_UI_SPEC.md`
