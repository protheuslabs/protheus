// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{app_plane, snowball_plane};
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

fn app_latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("app_plane")
        .join("latest.json")
}

fn snowball_latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("snowball_plane")
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
fn v6_app_batch17_builder_and_snowball_lanes_are_receipted() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let build_exit = app_plane::run(
        root,
        &[
            "build".to_string(),
            "--strict=1".to_string(),
            "--app=code-engineer".to_string(),
            "--goal=ship internal dashboard and package artifacts".to_string(),
        ],
    );
    assert_eq!(build_exit, 0);
    let build_latest = read_json(&app_latest_path(root));
    assert_eq!(
        build_latest.get("type").and_then(Value::as_str),
        Some("app_plane_code_engineer_build")
    );
    assert_claim(&build_latest, "V6-APP-006.4");
    assert_claim(&build_latest, "V6-APP-006.5");
    assert_claim(&build_latest, "V6-APP-006.7");

    let ingress_exit = app_plane::run(
        root,
        &[
            "ingress".to_string(),
            "--strict=1".to_string(),
            "--app=code-engineer".to_string(),
            "--provider=telegram".to_string(),
            "--goal=build agent delivery lane".to_string(),
        ],
    );
    assert_eq!(ingress_exit, 0);
    let ingress_latest = read_json(&app_latest_path(root));
    assert_eq!(
        ingress_latest.get("type").and_then(Value::as_str),
        Some("app_plane_code_engineer_ingress")
    );
    assert_claim(&ingress_latest, "V6-APP-006.6");

    let template_exit = app_plane::run(
        root,
        &[
            "template-governance".to_string(),
            "--strict=1".to_string(),
            "--app=code-engineer".to_string(),
            "--op=install".to_string(),
            "--template-id=builders://starter/product-build".to_string(),
            "--version=1.2.0".to_string(),
        ],
    );
    assert_eq!(template_exit, 0);
    let template_latest = read_json(&app_latest_path(root));
    assert_eq!(
        template_latest.get("type").and_then(Value::as_str),
        Some("app_plane_code_engineer_templates")
    );
    assert_claim(&template_latest, "V6-APP-006.8");

    let start_exit = snowball_plane::run(
        root,
        &[
            "start".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch17".to_string(),
            "--drops=core-hardening,app-runtime,ops-proof".to_string(),
            "--deps-json={\"app-runtime\":[\"core-hardening\"],\"ops-proof\":[\"app-runtime\"]}"
                .to_string(),
        ],
    );
    assert_eq!(start_exit, 0);
    let start_latest = read_json(&snowball_latest_path(root));
    assert_eq!(
        start_latest.get("type").and_then(Value::as_str),
        Some("snowball_plane_start")
    );
    assert_claim(&start_latest, "V6-APP-023.1");
    assert_claim(&start_latest, "V6-APP-023.5");

    let melt_exit = snowball_plane::run(
        root,
        &[
            "melt-refine".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch17".to_string(),
            "--regression-pass=1".to_string(),
        ],
    );
    assert_eq!(melt_exit, 0);
    let melt_latest = read_json(&snowball_latest_path(root));
    assert_eq!(
        melt_latest.get("type").and_then(Value::as_str),
        Some("snowball_plane_melt_refine")
    );
    assert_claim(&melt_latest, "V6-APP-023.2");

    let compact_exit = snowball_plane::run(
        root,
        &[
            "compact".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch17".to_string(),
        ],
    );
    assert_eq!(compact_exit, 0);
    let compact_latest = read_json(&snowball_latest_path(root));
    assert_eq!(
        compact_latest.get("type").and_then(Value::as_str),
        Some("snowball_plane_compact")
    );
    assert_claim(&compact_latest, "V6-APP-023.3");

    let backlog_exit = snowball_plane::run(
        root,
        &[
            "backlog-pack".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch17".to_string(),
        ],
    );
    assert_eq!(backlog_exit, 0);
    let backlog_latest = read_json(&snowball_latest_path(root));
    assert_eq!(
        backlog_latest.get("type").and_then(Value::as_str),
        Some("snowball_plane_backlog_pack")
    );
    assert_claim(&backlog_latest, "V6-APP-023.4");
    assert_claim(&backlog_latest, "V6-APP-023.5");

    let status_exit = snowball_plane::run(
        root,
        &[
            "status".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch17".to_string(),
        ],
    );
    assert_eq!(status_exit, 0);
}

#[test]
fn v6_app_batch17_snowball_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = snowball_plane::run(
        root,
        &[
            "start".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=bypass".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&snowball_latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("snowball_plane_conduit_gate")
    );
}
