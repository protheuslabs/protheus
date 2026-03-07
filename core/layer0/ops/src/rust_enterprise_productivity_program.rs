// SPDX-License-Identifier: Apache-2.0
use crate::ops_lane_runtime::{run_lane, LaneSpec};
use std::path::Path;

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops rust-enterprise-productivity-program list [--policy=<path>]",
    "  protheus-ops rust-enterprise-productivity-program run --id=<id> [--apply=1|0]",
    "  protheus-ops rust-enterprise-productivity-program status [--id=<id>]",
];

pub fn run(root: &Path, argv: &[String]) -> i32 {
    run_lane(
        root,
        argv,
        &LaneSpec {
            lane_id: "rust_enterprise_productivity_program",
            lane_type: "rust_enterprise_productivity_program",
            replacement: "protheus-ops rust-enterprise-productivity-program",
            usage: USAGE,
            passthrough_flags: &["apply", "strict", "policy", "id", "limit"],
        },
    )
}

