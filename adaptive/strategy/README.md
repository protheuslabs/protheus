# Strategy

Strategy stores adaptive policy formulas, not concrete use-case implementations.

- Objective functions, thresholds, budgets, stop rules.
- Lifecycle grading: `theory -> trial -> validated -> scaled`.
- Evidence source: autonomy runs + receipts-derived outcomes.

Mutation channel:
- Controller: `systems/strategy/strategy_controller.js`
- Store: `systems/adaptive/strategy/strategy_store.js`
- No direct file mutation of adaptive strategy memory outside store/controller getters/setters/mutators.
