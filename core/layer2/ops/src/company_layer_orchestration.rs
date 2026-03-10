// Layer ownership: core/layer2/ops (authoritative)
// SPDX-License-Identifier: Apache-2.0
use crate::ops_lane_runtime::{run_lane, LaneSpec};
use std::path::Path;

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops company-layer-orchestration run|status|org-chart|budget|ticket|heartbeat [--policy=<path>] [--state-path=<path>] [--strict=1|0]",
];

pub fn run(root: &Path, argv: &[String]) -> i32 {
    run_lane(
        root,
        argv,
        &LaneSpec {
            lane_id: "company_layer_orchestration",
            lane_type: "company_layer_orchestration",
            replacement: "protheus-ops company-layer-orchestration",
            usage: USAGE,
            passthrough_flags: &["strict", "policy", "state-path", "budget"],
        },
    )
}
