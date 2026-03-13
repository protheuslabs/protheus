// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{agency_plane, health_status};
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
        .join("agency_plane")
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
fn v6_agency_batch12_core_lanes_execute_with_receipts() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let create_exit = agency_plane::run(
        root,
        &[
            "create-shadow".to_string(),
            "--strict=1".to_string(),
            "--template=frontend-wizard".to_string(),
            "--name=ui-shadow".to_string(),
        ],
    );
    assert_eq!(create_exit, 0);
    let create_latest = read_json(&latest_path(root));
    assert_eq!(
        create_latest.get("type").and_then(Value::as_str),
        Some("agency_plane_create_shadow")
    );
    assert_eq!(create_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert!(create_latest
        .get("shadow")
        .and_then(|v| v.get("id"))
        .and_then(Value::as_str)
        .is_some());
    assert_claim(&create_latest, "V6-AGENCY-001.1");

    let topology_exit = agency_plane::run(
        root,
        &[
            "topology".to_string(),
            "--strict=1".to_string(),
            "--manifest-json={\"divisions\":[\"frontend\",\"security\",\"research\"],\"handoffs\":[{\"from\":\"frontend\",\"to\":\"security\"},{\"from\":\"security\",\"to\":\"research\"}]}"
                .to_string(),
        ],
    );
    assert_eq!(topology_exit, 0);
    let topology_latest = read_json(&latest_path(root));
    assert_eq!(
        topology_latest.get("type").and_then(Value::as_str),
        Some("agency_plane_topology")
    );
    assert_eq!(
        topology_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        topology_latest
            .get("topology")
            .and_then(|v| v.get("handoff_receipts"))
            .and_then(Value::as_array)
            .map(|rows| rows.len()),
        Some(2)
    );
    assert_claim(&topology_latest, "V6-AGENCY-001.2");

    let dashboard_exit = health_status::run(root, &["dashboard".to_string()]);
    assert_eq!(dashboard_exit, 0);
    let dashboard_latest = read_json(&health_latest_path(root));
    let metric = dashboard_latest
        .get("dashboard_metrics")
        .and_then(|v| v.get("agency_topology_surface"));
    assert!(metric.is_some(), "missing agency dashboard metric");
}

#[test]
fn v6_agency_batch12_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = agency_plane::run(
        root,
        &[
            "create-shadow".to_string(),
            "--strict=1".to_string(),
            "--template=frontend-wizard".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("agency_plane_conduit_gate")
    );
}
