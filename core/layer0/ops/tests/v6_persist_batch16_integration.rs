// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::persist_plane;
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
fn v6_persist_batch16_continuity_connector_cowork_are_receipted() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let checkpoint_exit = persist_plane::run(
        root,
        &[
            "continuity".to_string(),
            "--strict=1".to_string(),
            "--op=checkpoint".to_string(),
            "--session-id=batch16-s1".to_string(),
            "--context-json={\"context\":[\"a\"],\"user_model\":{\"style\":\"direct\"},\"active_tasks\":[\"t\"]}".to_string(),
        ],
    );
    assert_eq!(checkpoint_exit, 0);
    let reconstruct_exit = persist_plane::run(
        root,
        &[
            "continuity".to_string(),
            "--strict=1".to_string(),
            "--op=reconstruct".to_string(),
            "--session-id=batch16-s1".to_string(),
        ],
    );
    assert_eq!(reconstruct_exit, 0);
    let continuity_latest = read_json(&latest_path(root));
    assert_eq!(
        continuity_latest.get("type").and_then(Value::as_str),
        Some("persist_plane_continuity")
    );
    assert_claim(&continuity_latest, "V6-PERSIST-001.3");

    let connector_add_exit = persist_plane::run(
        root,
        &[
            "connector".to_string(),
            "--strict=1".to_string(),
            "--op=add".to_string(),
            "--provider=slack".to_string(),
            "--policy-template=slack-enterprise".to_string(),
        ],
    );
    assert_eq!(connector_add_exit, 0);
    let connector_status_exit = persist_plane::run(
        root,
        &[
            "connector".to_string(),
            "--strict=1".to_string(),
            "--op=status".to_string(),
            "--provider=slack".to_string(),
        ],
    );
    assert_eq!(connector_status_exit, 0);
    let connector_latest = read_json(&latest_path(root));
    assert_eq!(
        connector_latest.get("type").and_then(Value::as_str),
        Some("persist_plane_connector")
    );
    assert_claim(&connector_latest, "V6-PERSIST-001.4");

    let cowork_delegate_exit = persist_plane::run(
        root,
        &[
            "cowork".to_string(),
            "--strict=1".to_string(),
            "--op=delegate".to_string(),
            "--task=ship batch16".to_string(),
            "--parent=lead".to_string(),
            "--child=worker".to_string(),
            "--mode=sub-agent".to_string(),
            "--budget-ms=1500".to_string(),
        ],
    );
    assert_eq!(cowork_delegate_exit, 0);
    let cowork_tick_exit = persist_plane::run(
        root,
        &[
            "cowork".to_string(),
            "--strict=1".to_string(),
            "--op=tick".to_string(),
        ],
    );
    assert_eq!(cowork_tick_exit, 0);
    let cowork_latest = read_json(&latest_path(root));
    assert_eq!(
        cowork_latest.get("type").and_then(Value::as_str),
        Some("persist_plane_cowork")
    );
    assert_claim(&cowork_latest, "V6-PERSIST-001.5");
    assert_claim(&cowork_latest, "V6-PERSIST-001.6");
}

#[test]
fn v6_persist_batch16_rejects_connector_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = persist_plane::run(
        root,
        &[
            "connector".to_string(),
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
