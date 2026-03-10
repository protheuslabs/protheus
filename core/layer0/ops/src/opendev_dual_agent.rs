// SPDX-License-Identifier: Apache-2.0
use crate::ops_lane_runtime::{run_lane, LaneSpec};
use std::path::Path;

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops opendev-dual-agent run|status|handoff|discover|compact|remind [--policy=<path>] [--state-path=<path>] [--strict=1|0]",
];

pub fn run(root: &Path, argv: &[String]) -> i32 {
    run_lane(
        root,
        argv,
        &LaneSpec {
            lane_id: "opendev_dual_agent",
            lane_type: "opendev_dual_agent",
            replacement: "protheus-ops opendev-dual-agent",
            usage: USAGE,
            passthrough_flags: &["strict", "policy", "state-path"],
        },
    )
}
