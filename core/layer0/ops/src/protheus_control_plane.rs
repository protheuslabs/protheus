// SPDX-License-Identifier: Apache-2.0
use crate::ops_lane_runtime::{run_lane, LaneSpec};
use std::path::Path;

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops protheus-control-plane <command> [flags]",
    "  protheus-ops protheus-control-plane status",
];

pub fn run(root: &Path, argv: &[String]) -> i32 {
    run_lane(
        root,
        argv,
        &LaneSpec {
            lane_id: "protheus_control_plane",
            lane_type: "protheus_control_plane",
            replacement: "protheus-ops protheus-control-plane",
            usage: USAGE,
            passthrough_flags: &[
                "apply",
                "strict",
                "policy",
                "id",
                "limit",
                "statuses",
                "max",
                "action",
                "to",
            ],
        },
    )
}

