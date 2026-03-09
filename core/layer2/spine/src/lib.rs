// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer2/spine (authoritative spine runtime control).

pub mod spine;
pub mod authority;

pub use spine::spine_contract_receipt;
pub use authority::{
    compute_evidence_run_plan,
    run_background_hands_scheduler,
    run_evidence_run_plan,
    run_rsi_idle_hands_scheduler,
};
