// SPDX-License-Identifier: Apache-2.0
use crate::ops_lane_runtime::{run_lane, LaneSpec};
use std::path::Path;

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops webgpu-inference-adapter run|status|enable|infer|metrics [--policy=<path>] [--state-path=<path>] [--strict=1|0]",
];

pub fn run(root: &Path, argv: &[String]) -> i32 {
    run_lane(
        root,
        argv,
        &LaneSpec {
            lane_id: "webgpu_inference_adapter",
            lane_type: "webgpu_inference_adapter",
            replacement: "protheus-ops webgpu-inference-adapter",
            usage: USAGE,
            passthrough_flags: &["strict", "policy", "state-path"],
        },
    )
}
