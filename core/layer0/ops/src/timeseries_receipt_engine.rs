// SPDX-License-Identifier: Apache-2.0
use crate::ops_lane_runtime::{run_lane, LaneSpec};
use std::path::Path;

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops timeseries-receipt-engine run|status|ingest|query|compact|tier [--policy=<path>] [--state-path=<path>] [--strict=1|0]",
];

pub fn run(root: &Path, argv: &[String]) -> i32 {
    run_lane(
        root,
        argv,
        &LaneSpec {
            lane_id: "timeseries_receipt_engine",
            lane_type: "timeseries_receipt_engine",
            replacement: "protheus-ops timeseries-receipt-engine",
            usage: USAGE,
            passthrough_flags: &["strict", "policy", "state-path"],
        },
    )
}
