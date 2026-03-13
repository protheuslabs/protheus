// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{health_status, vbrowser_plane};
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
        .join("vbrowser_plane")
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
fn v6_vbrowser_batch12_core_lanes_execute_with_receipts() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let start_exit = vbrowser_plane::run(
        root,
        &[
            "session-start".to_string(),
            "--strict=1".to_string(),
            "--session-id=batch12-vb".to_string(),
            "--url=https://example.com".to_string(),
            "--shadow=alpha".to_string(),
        ],
    );
    assert_eq!(start_exit, 0);
    let start_latest = read_json(&latest_path(root));
    assert_eq!(
        start_latest.get("type").and_then(Value::as_str),
        Some("vbrowser_plane_session_start")
    );
    assert_eq!(start_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&start_latest, "V6-VBROWSER-001.1");
    assert_claim(&start_latest, "V6-VBROWSER-001.5");

    let join_exit = vbrowser_plane::run(
        root,
        &[
            "session-control".to_string(),
            "--strict=1".to_string(),
            "--op=join".to_string(),
            "--session-id=batch12-vb".to_string(),
            "--actor=alice".to_string(),
            "--role=shared-control".to_string(),
        ],
    );
    assert_eq!(join_exit, 0);
    let join_latest = read_json(&latest_path(root));
    assert_eq!(
        join_latest.get("type").and_then(Value::as_str),
        Some("vbrowser_plane_session_control")
    );
    assert_eq!(join_latest.get("op").and_then(Value::as_str), Some("join"));
    assert_claim(&join_latest, "V6-VBROWSER-001.2");

    let handoff_exit = vbrowser_plane::run(
        root,
        &[
            "session-control".to_string(),
            "--strict=1".to_string(),
            "--op=handoff".to_string(),
            "--session-id=batch12-vb".to_string(),
            "--actor=alice".to_string(),
            "--to=bob".to_string(),
        ],
    );
    assert_eq!(handoff_exit, 0);
    let handoff_latest = read_json(&latest_path(root));
    assert_eq!(
        handoff_latest.get("op").and_then(Value::as_str),
        Some("handoff")
    );
    assert_eq!(
        handoff_latest
            .get("session")
            .and_then(|v| v.get("handoffs"))
            .and_then(Value::as_array)
            .map(|rows| rows.len())
            .unwrap_or(0)
            > 0,
        true
    );
    assert_claim(&handoff_latest, "V6-VBROWSER-001.2");

    let automate_exit = vbrowser_plane::run(
        root,
        &[
            "automate".to_string(),
            "--strict=1".to_string(),
            "--session-id=batch12-vb".to_string(),
            "--actions=navigate,extract".to_string(),
        ],
    );
    assert_eq!(automate_exit, 0);
    let automate_latest = read_json(&latest_path(root));
    assert_eq!(
        automate_latest.get("type").and_then(Value::as_str),
        Some("vbrowser_plane_automate")
    );
    assert_eq!(
        automate_latest
            .get("run")
            .and_then(|v| v.get("telemetry"))
            .and_then(Value::as_array)
            .map(|rows| rows.len()),
        Some(2)
    );
    assert_claim(&automate_latest, "V6-VBROWSER-001.3");

    let privacy_exit = vbrowser_plane::run(
        root,
        &[
            "privacy-guard".to_string(),
            "--strict=1".to_string(),
            "--session-id=batch12-vb".to_string(),
            "--network=restricted".to_string(),
            "--recording=1".to_string(),
            "--allow-recording=1".to_string(),
            "--budget-tokens=3456".to_string(),
        ],
    );
    assert_eq!(privacy_exit, 0);
    let privacy_latest = read_json(&latest_path(root));
    assert_eq!(
        privacy_latest.get("type").and_then(Value::as_str),
        Some("vbrowser_plane_privacy_guard")
    );
    assert_eq!(
        privacy_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&privacy_latest, "V6-VBROWSER-001.4");

    let dashboard_exit = health_status::run(root, &["dashboard".to_string()]);
    assert_eq!(dashboard_exit, 0);
    let dashboard_latest = read_json(&health_latest_path(root));
    let metric = dashboard_latest
        .get("dashboard_metrics")
        .and_then(|v| v.get("vbrowser_session_surface"));
    assert!(metric.is_some(), "missing vbrowser dashboard metric");
}

#[test]
fn v6_vbrowser_batch12_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = vbrowser_plane::run(
        root,
        &[
            "session-start".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("vbrowser_plane_conduit_gate")
    );
}
