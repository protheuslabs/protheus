// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{health_status, persist_plane};
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
        .join("persist_plane")
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
fn v6_persist_batch15_schedule_and_mobile_cockpit_are_receipted() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let schedule_upsert_exit = persist_plane::run(
        root,
        &[
            "schedule".to_string(),
            "--strict=1".to_string(),
            "--op=upsert".to_string(),
            "--job=nightly-health".to_string(),
            "--cron=0 2 * * *".to_string(),
            "--workflow=health-status".to_string(),
            "--owner=ops".to_string(),
        ],
    );
    assert_eq!(schedule_upsert_exit, 0);
    let schedule_kickoff_exit = persist_plane::run(
        root,
        &[
            "schedule".to_string(),
            "--strict=1".to_string(),
            "--op=kickoff".to_string(),
            "--job=nightly-health".to_string(),
        ],
    );
    assert_eq!(schedule_kickoff_exit, 0);
    let schedule_latest = read_json(&latest_path(root));
    assert_eq!(
        schedule_latest.get("type").and_then(Value::as_str),
        Some("persist_plane_schedule")
    );
    assert_claim(&schedule_latest, "V6-PERSIST-001.1");

    let mobile_publish_exit = persist_plane::run(
        root,
        &[
            "mobile-cockpit".to_string(),
            "--strict=1".to_string(),
            "--op=publish".to_string(),
            "--session-id=phone-01".to_string(),
            "--device=ios".to_string(),
        ],
    );
    assert_eq!(mobile_publish_exit, 0);
    let mobile_intervene_exit = persist_plane::run(
        root,
        &[
            "mobile-cockpit".to_string(),
            "--strict=1".to_string(),
            "--op=intervene".to_string(),
            "--action=pause".to_string(),
        ],
    );
    assert_eq!(mobile_intervene_exit, 0);
    let mobile_latest = read_json(&latest_path(root));
    assert_eq!(
        mobile_latest.get("type").and_then(Value::as_str),
        Some("persist_plane_mobile_cockpit")
    );
    assert_claim(&mobile_latest, "V6-PERSIST-001.2");

    let health_exit = health_status::run(root, &["dashboard".to_string()]);
    assert_eq!(health_exit, 0);
    let health_latest = read_json(&health_latest_path(root));
    let metric = health_latest
        .get("dashboard_metrics")
        .and_then(|v| v.get("persist_background_surface"));
    assert!(metric.is_some(), "missing persist dashboard metric");
    assert_eq!(
        metric
            .and_then(|v| v.get("mobile_connected"))
            .and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn v6_persist_batch15_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = persist_plane::run(
        root,
        &[
            "schedule".to_string(),
            "--strict=1".to_string(),
            "--op=list".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("persist_plane_conduit_gate")
    );
}
