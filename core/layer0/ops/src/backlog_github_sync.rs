// SPDX-License-Identifier: Apache-2.0
use crate::ops_lane_runtime::{run_lane, LaneSpec};
use std::path::Path;

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops backlog-github-sync sync [--apply=1|0] [--strict=1|0] [--limit=<n>]",
    "  protheus-ops backlog-github-sync check [--strict=1|0]",
    "  protheus-ops backlog-github-sync status",
];

pub fn run(root: &Path, argv: &[String]) -> i32 {
    run_lane(
        root,
        argv,
        &LaneSpec {
            lane_id: "backlog_github_sync",
            lane_type: "backlog_github_sync",
            replacement: "protheus-ops backlog-github-sync",
            usage: USAGE,
            passthrough_flags: &["apply", "strict", "policy", "limit", "statuses"],
        },
    )
}

