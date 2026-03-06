use crate::ops_lane_runtime::{run_lane, LaneSpec};
use std::path::Path;

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops backlog-registry sync [--policy=<path>]",
    "  protheus-ops backlog-registry check [--strict=1|0]",
    "  protheus-ops backlog-registry status",
];

pub fn run(root: &Path, argv: &[String]) -> i32 {
    run_lane(
        root,
        argv,
        &LaneSpec {
            lane_id: "backlog_registry",
            lane_type: "backlog_registry",
            replacement: "protheus-ops backlog-registry",
            usage: USAGE,
            passthrough_flags: &["apply", "strict", "policy", "limit", "id"],
        },
    )
}

