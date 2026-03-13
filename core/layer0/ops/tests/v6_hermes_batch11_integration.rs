// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{hermes_plane, skills_plane};
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
fn v6_hermes_batch11_core_lanes_execute_with_receipts() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let skills_root = root
        .join("client")
        .join("runtime")
        .join("systems")
        .join("skills")
        .join("packages");
    fs::create_dir_all(&skills_root).expect("mkdir skills root");
    let _ = skills_plane::run(
        root,
        &[
            "create".to_string(),
            "--strict=1".to_string(),
            "--name=ops-helper".to_string(),
            format!("--skills-root={}", skills_root.display()),
        ],
    );

    std::env::set_var("HERMES_IDENTITY_SIGNING_KEY", "batch11-hermes-signing-key");
    let discover_exit = hermes_plane::run(
        root,
        &[
            "discover".to_string(),
            "--strict=1".to_string(),
            "--shadow=alpha".to_string(),
        ],
    );
    assert_eq!(discover_exit, 0);
    let discover_latest = read_json(&latest_path(root));
    assert_eq!(
        discover_latest.get("type").and_then(Value::as_str),
        Some("hermes_plane_discover")
    );
    assert_eq!(
        discover_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&discover_latest, "V6-HERMES-001.1");

    let cockpit_exit = hermes_plane::run(
        root,
        &[
            "cockpit".to_string(),
            "--strict=1".to_string(),
            "--max-blocks=12".to_string(),
        ],
    );
    assert_eq!(cockpit_exit, 0);
    let cockpit_latest = read_json(&latest_path(root));
    assert_eq!(
        cockpit_latest.get("type").and_then(Value::as_str),
        Some("hermes_plane_cockpit")
    );
    assert_eq!(
        cockpit_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert!(
        cockpit_latest
            .get("cockpit")
            .and_then(|v| v.get("render"))
            .and_then(|v| v.get("total_blocks"))
            .and_then(Value::as_u64)
            .unwrap_or(0)
            > 0
    );
    assert_claim(&cockpit_latest, "V6-HERMES-001.2");
}

#[test]
fn v6_hermes_batch11_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = hermes_plane::run(
        root,
        &[
            "discover".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("hermes_plane_conduit_gate")
    );
}
