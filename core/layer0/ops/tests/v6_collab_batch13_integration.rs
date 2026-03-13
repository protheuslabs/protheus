// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{collab_plane, health_status};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;
use walkdir::WalkDir;

fn workspace_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .ancestors()
        .nth(3)
        .expect("workspace ancestor")
        .to_path_buf()
}

fn copy_tree(src: &Path, dst: &Path) {
    for entry in WalkDir::new(src).into_iter().filter_map(Result::ok) {
        let rel = entry.path().strip_prefix(src).expect("strip prefix");
        let out = dst.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&out).expect("mkdir");
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).expect("mkdir parent");
        }
        fs::copy(entry.path(), &out).expect("copy file");
    }
}

fn stage_fixture_root() -> TempDir {
    let workspace = workspace_root();
    let tmp = tempfile::tempdir().expect("tempdir");
    copy_tree(
        &workspace.join("planes").join("contracts"),
        &tmp.path().join("planes").join("contracts"),
    );
    tmp
}

fn latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("collab_plane")
        .join("latest.json")
}

fn health_latest_path(root: &Path) -> PathBuf {
    root.join("client")
        .join("local")
        .join("state")
        .join("ops")
        .join("health_status")
        .join("latest.json")
}

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read");
    serde_json::from_str(&raw).expect("parse")
}

fn assert_claim(payload: &Value, claim_id: &str) {
    let has = payload
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some(claim_id));
    assert!(has, "missing claim evidence id={claim_id}");
}

#[test]
fn v6_collab_batch13_dashboard_launch_schedule_and_continuity_are_receipted() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let dashboard_exit = collab_plane::run(
        root,
        &[
            "dashboard".to_string(),
            "--strict=1".to_string(),
            "--team=ops".to_string(),
            "--refresh-ms=1200".to_string(),
        ],
    );
    assert_eq!(dashboard_exit, 0);
    let dashboard_latest = read_json(&latest_path(root));
    assert_eq!(
        dashboard_latest.get("type").and_then(Value::as_str),
        Some("collab_plane_dashboard")
    );
    assert_claim(&dashboard_latest, "V6-COLLAB-001.1");
    assert_claim(&dashboard_latest, "V6-COLLAB-001.4");

    let launch_exit = collab_plane::run(
        root,
        &[
            "launch-role".to_string(),
            "--strict=1".to_string(),
            "--team=ops".to_string(),
            "--role=analyst".to_string(),
            "--shadow=ops-analyst".to_string(),
        ],
    );
    assert_eq!(launch_exit, 0);
    let launch_latest = read_json(&latest_path(root));
    assert_eq!(
        launch_latest.get("type").and_then(Value::as_str),
        Some("collab_plane_launch_role")
    );
    assert_claim(&launch_latest, "V6-COLLAB-001.2");
    assert_claim(&launch_latest, "V6-COLLAB-001.4");

    let upsert_exit = collab_plane::run(
        root,
        &[
            "schedule".to_string(),
            "--strict=1".to_string(),
            "--op=upsert".to_string(),
            "--team=ops".to_string(),
            "--job=nightly".to_string(),
            "--cron=*/30 * * * *".to_string(),
            "--shadows=ops-analyst,ops-reviewer".to_string(),
        ],
    );
    assert_eq!(upsert_exit, 0);
    let kickoff_exit = collab_plane::run(
        root,
        &[
            "schedule".to_string(),
            "--strict=1".to_string(),
            "--op=kickoff".to_string(),
            "--team=ops".to_string(),
            "--job=nightly".to_string(),
            "--shadows=ops-analyst,ops-reviewer".to_string(),
        ],
    );
    assert_eq!(kickoff_exit, 0);
    let schedule_latest = read_json(&latest_path(root));
    assert_eq!(
        schedule_latest.get("type").and_then(Value::as_str),
        Some("collab_plane_schedule")
    );
    assert_eq!(
        schedule_latest
            .get("kickoff_receipts")
            .and_then(Value::as_array)
            .map(|rows| rows.len()),
        Some(2)
    );
    assert_claim(&schedule_latest, "V6-COLLAB-001.3");
    assert_claim(&schedule_latest, "V6-COLLAB-001.4");

    let checkpoint_exit = collab_plane::run(
        root,
        &[
            "continuity".to_string(),
            "--strict=1".to_string(),
            "--op=checkpoint".to_string(),
            "--team=ops".to_string(),
        ],
    );
    assert_eq!(checkpoint_exit, 0);
    let reconstruct_exit = collab_plane::run(
        root,
        &[
            "continuity".to_string(),
            "--strict=1".to_string(),
            "--op=reconstruct".to_string(),
            "--team=ops".to_string(),
        ],
    );
    assert_eq!(reconstruct_exit, 0);
    let continuity_latest = read_json(&latest_path(root));
    assert_eq!(
        continuity_latest.get("type").and_then(Value::as_str),
        Some("collab_plane_continuity")
    );
    assert_claim(&continuity_latest, "V6-COLLAB-001.5");
    assert_claim(&continuity_latest, "V6-COLLAB-001.4");

    let health_exit = health_status::run(root, &["dashboard".to_string()]);
    assert_eq!(health_exit, 0);
    let health_latest = read_json(&health_latest_path(root));
    let metric = health_latest
        .get("dashboard_metrics")
        .and_then(|v| v.get("collab_team_surface"));
    assert!(metric.is_some(), "missing collab metric in dashboard");
}

#[test]
fn v6_collab_batch13_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = collab_plane::run(
        root,
        &[
            "dashboard".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("collab_plane_conduit_gate")
    );
}
