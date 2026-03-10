// SPDX-License-Identifier: Apache-2.0
use crate::ops_lane_runtime::{run_lane, LaneSpec};
use std::path::Path;

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops biological-computing-adapter run|status|observe|stimulate|fallback [--policy=<path>] [--state-path=<path>] [--strict=1|0]",
];

pub fn run(root: &Path, argv: &[String]) -> i32 {
    run_lane(
        root,
        argv,
        &LaneSpec {
            lane_id: "biological_computing_adapter",
            lane_type: "biological_computing_adapter",
            replacement: "protheus-ops biological-computing-adapter",
            usage: USAGE,
            passthrough_flags: &["strict", "policy", "state-path", "consent"],
        },
    )
}
