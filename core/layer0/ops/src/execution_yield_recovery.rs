// SPDX-License-Identifier: Apache-2.0
use crate::ops_lane_runtime::{run_lane, LaneSpec};
use std::path::Path;

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops execution-yield-recovery run [--apply=1|0] [--strict=1|0] [--policy=<path>]",
    "  protheus-ops execution-yield-recovery status [--policy=<path>]",
];

pub fn run(root: &Path, argv: &[String]) -> i32 {
    run_lane(
        root,
        argv,
        &LaneSpec {
            lane_id: "execution_yield_recovery",
            lane_type: "execution_yield_recovery",
            replacement: "protheus-ops execution-yield-recovery",
            usage: USAGE,
            passthrough_flags: &["apply", "strict", "policy", "scope", "max-tests", "id", "limit"],
        },
    )
}
