// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::hermes_plane;
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
        .join("hermes_plane")
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
fn v6_hermes_batch12_continuity_and_delegation_execute_with_receipts() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let checkpoint_exit = hermes_plane::run(
        root,
        &[
            "continuity".to_string(),
            "--strict=1".to_string(),
            "--op=checkpoint".to_string(),
            "--session-id=batch12-alpha".to_string(),
            "--context-json={\"context\":[\"resume\"],\"user_model\":{\"style\":\"direct\"},\"active_tasks\":[\"batch12\"],\"attention_queue\":[\"task-a\"]}".to_string(),
        ],
    );
    assert_eq!(checkpoint_exit, 0);
    let checkpoint_latest = read_json(&latest_path(root));
    assert_eq!(
        checkpoint_latest.get("type").and_then(Value::as_str),
        Some("hermes_plane_continuity")
    );
    assert_eq!(
        checkpoint_latest.get("op").and_then(Value::as_str),
        Some("checkpoint")
    );
    assert_eq!(
        checkpoint_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&checkpoint_latest, "V6-HERMES-001.3");
    assert_claim(&checkpoint_latest, "V6-HERMES-001.5");

    let reconstruct_exit = hermes_plane::run(
        root,
        &[
            "continuity".to_string(),
            "--strict=1".to_string(),
            "--op=reconstruct".to_string(),
            "--session-id=batch12-alpha".to_string(),
        ],
    );
    assert_eq!(reconstruct_exit, 0);
    let reconstruct_latest = read_json(&latest_path(root));
    assert_eq!(
        reconstruct_latest.get("type").and_then(Value::as_str),
        Some("hermes_plane_continuity")
    );
    assert_eq!(
        reconstruct_latest.get("op").and_then(Value::as_str),
        Some("reconstruct")
    );
    assert_eq!(
        reconstruct_latest
            .get("reconstructed")
            .and_then(|v| v.get("daemon_restart_simulated"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        reconstruct_latest
            .get("reconstructed")
            .and_then(|v| v.get("detached_reattached"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&reconstruct_latest, "V6-HERMES-001.3");

    let status_exit = hermes_plane::run(
        root,
        &[
            "continuity".to_string(),
            "--strict=1".to_string(),
            "--op=status".to_string(),
            "--session-id=batch12-alpha".to_string(),
        ],
    );
    assert_eq!(status_exit, 0);
    let status_latest = read_json(&latest_path(root));
    assert_eq!(
        status_latest.get("op").and_then(Value::as_str),
        Some("status")
    );
    assert_eq!(
        status_latest
            .get("snapshot_present")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        status_latest
            .get("reconstructed_present")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&status_latest, "V6-HERMES-001.3");

    let delegate_exit = hermes_plane::run(
        root,
        &[
            "delegate".to_string(),
            "--strict=1".to_string(),
            "--task=triage continuity receipts".to_string(),
            "--parent=shadow-alpha".to_string(),
            "--roles=researcher,executor".to_string(),
            "--tool-pack=research_pack".to_string(),
        ],
    );
    assert_eq!(delegate_exit, 0);
    let delegate_latest = read_json(&latest_path(root));
    assert_eq!(
        delegate_latest.get("type").and_then(Value::as_str),
        Some("hermes_plane_delegate")
    );
    assert_eq!(
        delegate_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        delegate_latest
            .get("delegation")
            .and_then(|v| v.get("children"))
            .and_then(Value::as_array)
            .map(|rows| rows.len()),
        Some(2)
    );
    assert_claim(&delegate_latest, "V6-HERMES-001.4");
    assert_claim(&delegate_latest, "V6-HERMES-001.5");
}

#[test]
fn v6_hermes_batch12_conduit_guard_rejects_bypass() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = hermes_plane::run(
        root,
        &[
            "continuity".to_string(),
            "--strict=1".to_string(),
            "--op=status".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("hermes_plane_conduit_gate")
    );
    let claim_present = latest
        .get("conduit_enforcement")
        .and_then(|v| v.get("claim_evidence"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .any(|row| row.get("id").and_then(Value::as_str) == Some("V6-HERMES-001.5"))
        })
        .unwrap_or(false);
    assert!(claim_present, "missing V6-HERMES-001.5 conduit claim");
}
