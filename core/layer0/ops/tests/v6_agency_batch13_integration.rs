// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{agency_plane, hermes_plane};
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

fn hermes_latest_path(root: &Path) -> PathBuf {
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
fn v6_agency_batch13_orchestrator_and_workflow_bind_are_receipted() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let orchestrate_exit = agency_plane::run(
        root,
        &[
            "orchestrate".to_string(),
            "--strict=1".to_string(),
            "--team=platform".to_string(),
            "--run-id=batch13-orch".to_string(),
            "--agents=6".to_string(),
        ],
    );
    assert_eq!(orchestrate_exit, 0);
    let orchestrate_latest = read_json(&latest_path(root));
    assert_eq!(
        orchestrate_latest.get("type").and_then(Value::as_str),
        Some("agency_plane_orchestrate")
    );
    assert_eq!(
        orchestrate_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        orchestrate_latest
            .get("run")
            .and_then(|v| v.get("agents"))
            .and_then(Value::as_array)
            .map(|rows| rows.len()),
        Some(6)
    );
    assert_claim(&orchestrate_latest, "V6-AGENCY-001.3");
    assert_claim(&orchestrate_latest, "V6-AGENCY-001.5");

    let bind_exit = agency_plane::run(
        root,
        &[
            "workflow-bind".to_string(),
            "--strict=1".to_string(),
            "--template=security-engineer".to_string(),
            "--run-id=batch13-bind".to_string(),
        ],
    );
    assert_eq!(bind_exit, 0);
    let bind_latest = read_json(&latest_path(root));
    assert_eq!(
        bind_latest.get("type").and_then(Value::as_str),
        Some("agency_plane_workflow_bind")
    );
    assert_eq!(
        bind_latest
            .get("deliverable_pack")
            .and_then(|v| v.get("deliverables"))
            .and_then(Value::as_array)
            .map(|rows| rows.len())
            .unwrap_or(0)
            > 0,
        true
    );
    assert_claim(&bind_latest, "V6-AGENCY-001.4");
    assert_claim(&bind_latest, "V6-AGENCY-001.5");

    let cockpit_exit = hermes_plane::run(
        root,
        &[
            "cockpit".to_string(),
            "--strict=1".to_string(),
            "--max-blocks=24".to_string(),
        ],
    );
    assert_eq!(cockpit_exit, 0);
    let cockpit_latest = read_json(&hermes_latest_path(root));
    let has_agency_event = cockpit_latest
        .get("cockpit")
        .and_then(|v| v.get("render"))
        .and_then(|v| v.get("stream_blocks"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter().any(|row| {
                row.get("event_type").and_then(Value::as_str) == Some("agency_plane_workflow_bind")
                    || row.get("event_type").and_then(Value::as_str)
                        == Some("agency_plane_orchestrate")
            })
        })
        .unwrap_or(false);
    assert!(
        has_agency_event,
        "missing agency coordinator event in protheus-top stream"
    );
}

#[test]
fn v6_agency_batch13_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = agency_plane::run(
        root,
        &[
            "orchestrate".to_string(),
            "--strict=1".to_string(),
            "--agents=6".to_string(),
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
