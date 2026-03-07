// SPDX-License-Identifier: Apache-2.0
use crate::ops_lane_runtime::{run_lane, LaneSpec};
use std::path::Path;

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops rust50-migration-program list [--policy=<path>]",
    "  protheus-ops rust50-migration-program run --id=<id> [--apply=1|0] [--strict=1|0]",
    "  protheus-ops rust50-migration-program status [--id=<id>]",
];

pub fn run(root: &Path, argv: &[String]) -> i32 {
    run_lane(
        root,
        argv,
        &LaneSpec {
            lane_id: "rust50_migration_program",
            lane_type: "rust50_migration_program",
            replacement: "protheus-ops rust50-migration-program",
            usage: USAGE,
            passthrough_flags: &["apply", "strict", "policy", "id", "limit"],
        },
    )
}

