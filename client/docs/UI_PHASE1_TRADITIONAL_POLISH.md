# UI Phase-1 Traditional Polish

`V4-UX-002` defines a consistent, feature-gated polish contract across UI/CLI/operator surfaces.

## Scope

- spacing: align baseline spacing scale and avoid ad-hoc jumps
- typography: keep hierarchy stable across headings/body/labels
- motion: use restrained transitions and avoid noisy effects
- states: define hover/focus/active/disabled behavior explicitly
- theme: maintain predictable color tokens and contrast behavior
- keyboard navigation: every interactive flow must be keyboard reachable
- command palette: keep command discoverability and shortcuts documented
- responsive behavior: preserve readability and task flow at desktop/tablet/mobile sizes

## Accessibility Contract

- aria labels for interactive controls where semantic tags are insufficient
- keyboard path for primary actions and recovery flows
- focus indicators are always visible
- contrast ratio checks for critical text states

## Rollback

Presentation changes are gated by `client/config/feature_flags.json` -> `phase1_ui_polish`.
Disable path:

```bash
node client/systems/ops/ui_phase1_polish_consistency_pass.js disable
```
