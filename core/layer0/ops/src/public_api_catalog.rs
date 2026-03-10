// SPDX-License-Identifier: Apache-2.0
use crate::ops_lane_runtime::{run_lane, LaneSpec};
use std::path::Path;

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops public-api-catalog run|status|sync|search|integrate [--policy=<path>] [--state-path=<path>] [--strict=1|0]",
];

pub fn run(root: &Path, argv: &[String]) -> i32 {
    run_lane(
        root,
        argv,
        &LaneSpec {
            lane_id: "public_api_catalog",
            lane_type: "public_api_catalog",
            replacement: "protheus-ops public-api-catalog",
            usage: USAGE,
            passthrough_flags: &["strict", "policy", "state-path"],
        },
    )
}
