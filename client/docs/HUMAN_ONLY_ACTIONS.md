# Human-Only Actions (Non-Executable Backlog Inputs)

Purpose: capture high-impact tasks that cannot be executed autonomously from backlog automation because they require human legal authority, identity, money movement approval, physical presence, or relationship management.

## How To Use

- Treat each action as a prerequisite artifact producer.
- After completion, attach evidence to `state/ops/evidence/` and reference it in the dependent backlog item receipt.
- Do not mark dependent backlog items done until the evidence artifact exists and is linked.

## Human-Only Task List

| ID | Human Action | Why This Is Human-Only | Evidence Artifact (suggested) | Backlog Dependencies |
|---|---|---|---|---|
| HMAN-001 | Select and contract independent security assessor(s) | Requires commercial negotiation, legal acceptance, and payment authority | `state/ops/evidence/external_security_contract_<date>.pdf` | `V2-012`, `V3-ENT-003`, `V3-SEC-004` |
| HMAN-002 | Approve coordinated disclosure policy and legal response workflow | Requires legal counsel and liability/risk sign-off | `state/ops/evidence/coordinated_disclosure_policy_signed_<date>.pdf` | `V3-SEC-004`, `V3-DOC-006` |
| HMAN-003 | Approve official reliability SLO policy targets and incident severity definitions | Requires executive risk acceptance and business tradeoff decisions | `state/ops/evidence/reliability_policy_approval_<date>.md` | `V3-REL-001`, `V3-OPS-001` |
| HMAN-004 | Approve benchmark publication policy (what can be public vs private) | Requires strategic disclosure decision and competitive/legal judgment | `state/ops/evidence/benchmark_publication_policy_<date>.md` | `V3-BENCH-001`, `V3-BENCH-002` |
| HMAN-005 | Fund provider accounts and authorize billing/payment rails | Requires custody of funds and account ownership authority | `state/ops/evidence/provider_funding_authorization_<date>.md` | `V3-BUD-001`, `V3-ECO-001`, `V3-BLK-001` |
| HMAN-006 | Approve and sign soul-token/root identity ceremonies | Requires identity proof and private-key consent that cannot be delegated | `state/ops/evidence/soul_token_ceremony_<date>.json` | `V2-058`, `V3-BLK-001`, `V3-CPY-001` |
| HMAN-007 | Complete hardware key ceremonies for trusted devices | Requires physical device possession and trusted environment controls | `state/ops/evidence/hardware_attestation_ceremony_<date>.json` | `V3-021`, `V3-CPY-001`, `V3-VENOM-001` |
| HMAN-008 | Execute client/legal/compliance filings (if enterprise launch path chosen) | Requires licensed client/legal/accounting actors and official filings | `state/ops/evidence/compliance_filing_bundle_<date>.zip` | `V2-013`, `V3-ENT-002`, `V3-DOC-005` |
| HMAN-009 | Approve risk thresholds for autonomous spend and action tiers | Requires personal/business risk appetite decisions | `state/ops/evidence/risk_tier_threshold_approval_<date>.md` | `V3-ACT-001`, `V3-AEX-001`, `V3-BUD-001` |
| HMAN-010 | Run periodic human governance review board (you + designated approvers) | Requires human accountability and judgment on governance drift | `state/ops/evidence/governance_review_minutes_<date>.md` | `V3-GOV-001`, `V3-DOC-002`, `V3-DOC-006` |
| HMAN-011 | Conduct live operator UX acceptance test with real operators | Requires real user interviews and qualitative acceptance sign-off | `state/ops/evidence/operator_uat_report_<date>.md` | `V3-USE-001`, `V3-USE-003`, `V3-OPS-004` |
| HMAN-012 | Approve incident communication templates for client/legal/public response | Requires client/legal/brand authority and escalation ownership | `state/ops/evidence/incident_comms_approval_<date>.md` | `V3-DOC-006`, `V3-ENT-003`, `V3-SEC-004` |
| HMAN-013 | Approve RSI risk-tier policy and auto-apply boundaries | Requires explicit human risk acceptance for autonomous self-modification limits | `state/ops/evidence/rsi_tier_policy_approval_<date>.md` | `V3-RACE-178`, `V3-RACE-180` |
| HMAN-014 | Designate and approve RSI quorum/approver roster (`approve --rsi`) | Requires identity/trust authority that cannot be delegated to autonomous lanes | `state/ops/evidence/rsi_approver_roster_<date>.json` | `V3-RACE-180`, `V3-RACE-184` |
| HMAN-015 | Approve 24/7 RSI operating windows and budget caps | Requires human judgment on cost, availability, and quiet-hour tradeoffs | `state/ops/evidence/rsi_schedule_budget_policy_<date>.md` | `V3-RACE-183`, `V3-BUD-001` |
| HMAN-016 | Approve seed-swarm inheritance and revocation policy | Requires client/legal/operational accountability for parent-child governance boundaries | `state/ops/evidence/rsi_spawn_inheritance_policy_<date>.md` | `V3-RACE-182`, `V3-RACE-131` |
| HMAN-017 | Perform recurring human review of RSI receipts and rollback drills | Requires human governance oversight before higher-autonomy promotion decisions | `state/ops/evidence/rsi_governance_review_<date>.md` | `V3-RACE-181`, `V3-RACE-183`, `V3-RACE-184` |
| HMAN-018 | Approve Rust-hybrid rollout sequence and regression budget | Requires executive risk ownership for runtime cutover ordering and acceptable blast radius | `state/ops/evidence/rust_hybrid_rollout_policy_<date>.md` | `V3-RACE-185`, `V3-RACE-188` |
| HMAN-019 | Approve benchmark publication scope for hybrid performance claims | Requires strategic/legal decision on external disclosure of competitive benchmark data | `state/ops/evidence/rust_hybrid_benchmark_publication_policy_<date>.md` | `V3-RACE-175`, `V3-RACE-174` |
| HMAN-020 | Approve formal-proof acceptance thresholds for critical-lane promotion | Requires human governance authority over what proof coverage is sufficient for default-live gates | `state/ops/evidence/rust_hybrid_formal_proof_thresholds_<date>.md` | `V3-RACE-187`, `V3-RACE-035` |
| HMAN-021 | Approve hybrid release artifact strategy (single-binary vs mixed package) | Requires product/operations authority for distribution and support model decisions | `state/ops/evidence/rust_hybrid_release_strategy_<date>.md` | `V3-RACE-175`, `V3-RACE-188` |
| HMAN-022 | Approve mobile device support matrix and performance tiers | Requires human product/operations ownership for supported hardware scope and SLA commitments | `state/ops/evidence/mobile_device_matrix_approval_<date>.md` | `V3-RACE-189`, `V3-RACE-194` |
| HMAN-023 | Approve mobile signing credential custody and provisioning workflow | Requires client/legal/security authority over keystore and Apple provisioning profile custody | `state/ops/evidence/mobile_signing_custody_policy_<date>.md` | `V3-RACE-193` |
| HMAN-024 | Approve mobile battery/thermal safety envelope and background execution policy | Requires human risk acceptance for on-device power/heat and background autonomy behavior | `state/ops/evidence/mobile_power_thermal_policy_<date>.md` | `V3-RACE-190`, `V3-RACE-194` |
| HMAN-025 | Approve public disclosure policy for mobile competitive benchmark claims | Requires strategic/legal sign-off on competitor comparison messaging and publication scope | `state/ops/evidence/mobile_benchmark_disclosure_policy_<date>.md` | `V3-RACE-194`, `V3-RACE-174` |
| HMAN-026 | Engage and sign independent certification path for SOC2 Type II / ISO 27001 | Requires legal procurement authority, auditor contracting, and budget approval outside autonomous execution | `state/ops/evidence/soc2_iso_certification_engagement_<date>.pdf` | `V6-F100-043`, `V6-F100-045` |
| HMAN-027 | Approve regulated-market certification strategy (FedRAMP/GDPR attestation scope) | Requires client/legal/compliance ownership over jurisdictional obligations and external filing commitments | `state/ops/evidence/regulated_certification_scope_<date>.md` | `V6-F100-043`, `V6-F100-045` |
| HMAN-028 | Approve enterprise commercial support envelope (SLA tiers, indemnity, support contact) | Requires executive and legal authority for contractual promises and liability boundaries | `state/ops/evidence/enterprise_support_envelope_<date>.md` | `V6-F100-044` |
| HMAN-029 | Approve release authority model for public cadence (tagging, notes, emergency revocation) | Requires maintainer identity custody and governance sign-off for public release ownership | `state/ops/evidence/release_authority_model_<date>.md` | `V6-F100-034`, `V6-COMP-005` |
| HMAN-030 | Publish `v0.2.0` release artifacts to GitHub Releases and npm | Requires maintainer token custody, package publication authority, and public release accountability | `state/ops/evidence/v0_2_0_public_release_links_<date>.md` | `V6-F100-034`, `V6-SEC-001`, `V6-GAP-006` |
| HMAN-031 | Post public launch announcements (X/HN/Reddit) using approved messaging | Requires brand/legal authority and external account ownership | `state/ops/evidence/infring_launch_posts_<date>.md` | `V6-GAP-005`, `V6-GAP-006` |

## Non-Negotiable Constraint

These tasks are intentionally not auto-executable. They anchor sovereignty, legal control, and accountability in the human root.
