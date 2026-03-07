// SPDX-License-Identifier: Apache-2.0
use crate::ops_lane_runtime::{run_lane, LaneSpec};
use std::path::Path;

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops dynamic-burn-budget-oracle run [--policy=<path>] [--mock-file=<path>]",
    "  protheus-ops dynamic-burn-budget-oracle status [--policy=<path>]",
];

pub fn run(root: &Path, argv: &[String]) -> i32 {
    run_lane(
        root,
        argv,
        &LaneSpec {
            lane_id: "dynamic_burn_budget_oracle",
            lane_type: "dynamic_burn_budget_oracle",
            replacement: "protheus-ops dynamic-burn-budget-oracle",
            usage: USAGE,
            passthrough_flags: &["apply", "strict", "policy", "mock-file", "mock-json"],
        },
    )
}

