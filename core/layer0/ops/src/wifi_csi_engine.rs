// SPDX-License-Identifier: Apache-2.0
use crate::ops_lane_runtime::{run_lane, LaneSpec};
use std::path::Path;

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops wifi-csi-engine run|status|detect|module-enable|module-disable [--policy=<path>] [--state-path=<path>] [--strict=1|0]",
];

pub fn run(root: &Path, argv: &[String]) -> i32 {
    run_lane(
        root,
        argv,
        &LaneSpec {
            lane_id: "wifi_csi_engine",
            lane_type: "wifi_csi_engine",
            replacement: "protheus-ops wifi-csi-engine",
            usage: USAGE,
            passthrough_flags: &["strict", "policy", "local-only", "state-path"],
        },
    )
}
