# Personas Controls

This document defines operator controls for persona responses.

## Cognizance-Gap

- Definition: Configurable delay before final persona output so the operator can review stream-of-thought.
- Default: `0` seconds (no delay).
- CLI: `protheus lens <persona> --gap=<seconds> "<query>"`
- Constraint: Delay is clamped to `0..60` seconds.
- Runtime behavior:
  - Emits reasoning in 3-5 live stream chunks.
  - Accepts control input during the gap window.

## Alignment Indicator

- Yellow: Persona autopilot mode (`--active` not set).
- Green: Human actively participating (`--active=1`).
- CLI output always prints the current indicator.

## Intercept Mechanism

- Definition: Override path during cognizance-gap.
- CLI controls:
  - `e` + Enter: enter edit mode and submit replacement position text.
  - `a` + Enter: approve early and skip remaining delay.
  - `--intercept="<override text>"`: non-interactive override for scripted runs.
- Behavior:
  - Prints stream-of-thought chunks before final output.
  - Applies override text as final position when edited/intercepted.
  - Appends an interception record to `personas/<persona>/correspondence.md`.

## Future Controls

- Persona-specific drift threshold overrides.
- Soul token policy escalation (`green-required` for high-risk query classes).
- UI-level interception controls for live sessions.
