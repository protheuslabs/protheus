// SPDX-License-Identifier: Apache-2.0
use crate::ops_lane_runtime::{run_lane, LaneSpec};
use std::path::Path;

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops persistent-background-runtime run|status|schedule|connector|subagent [--policy=<path>] [--state-path=<path>] [--strict=1|0]",
];

pub fn run(root: &Path, argv: &[String]) -> i32 {
    run_lane(
        root,
        argv,
        &LaneSpec {
            lane_id: "persistent_background_runtime",
            lane_type: "persistent_background_runtime",
            replacement: "protheus-ops persistent-background-runtime",
            usage: USAGE,
            passthrough_flags: &["strict", "policy", "state-path"],
        },
    )
}
