// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{company_plane, health_status};
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
        .join("company_plane")
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
fn v6_company_batch13_org_hierarchy_and_budget_enforcement_are_receipted() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let orchestrate_exit = company_plane::run(
        root,
        &[
            "orchestrate-agency".to_string(),
            "--strict=1".to_string(),
            "--team=research".to_string(),
        ],
    );
    assert_eq!(orchestrate_exit, 0);
    let orchestrate_latest = read_json(&latest_path(root));
    assert_eq!(
        orchestrate_latest.get("type").and_then(Value::as_str),
        Some("company_plane_orchestrate_agency")
    );
    assert_eq!(
        orchestrate_latest
            .get("hierarchy")
            .and_then(|v| v.get("hierarchy"))
            .and_then(|v| v.get("reporting_edges"))
            .and_then(Value::as_array)
            .map(|rows| rows.len())
            .unwrap_or(0)
            > 0,
        true
    );
    assert_claim(&orchestrate_latest, "V6-COMPANY-001.1");

    let budget_allow_exit = company_plane::run(
        root,
        &[
            "budget-enforce".to_string(),
            "--strict=1".to_string(),
            "--agent=alpha".to_string(),
            "--period=daily".to_string(),
            "--tokens=500".to_string(),
            "--cost-usd=2.5".to_string(),
            "--compute-ms=2500".to_string(),
            "--privacy-units=20".to_string(),
        ],
    );
    assert_eq!(budget_allow_exit, 0);
    let budget_allow_latest = read_json(&latest_path(root));
    assert_eq!(
        budget_allow_latest.get("type").and_then(Value::as_str),
        Some("company_plane_budget_enforce")
    );
    assert_eq!(
        budget_allow_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&budget_allow_latest, "V6-COMPANY-001.2");

    let budget_deny_exit = company_plane::run(
        root,
        &[
            "budget-enforce".to_string(),
            "--strict=1".to_string(),
            "--agent=alpha".to_string(),
            "--period=daily".to_string(),
            "--tokens=999999999".to_string(),
            "--cost-usd=9999".to_string(),
            "--compute-ms=999999".to_string(),
            "--privacy-units=999999".to_string(),
        ],
    );
    assert_eq!(budget_deny_exit, 1);
    let budget_deny_latest = read_json(&latest_path(root));
    assert_eq!(
        budget_deny_latest.get("type").and_then(Value::as_str),
        Some("company_plane_budget_enforce")
    );
    assert_eq!(
        budget_deny_latest.get("ok").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        budget_deny_latest
            .get("decision")
            .and_then(|v| v.get("hard_stop"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&budget_deny_latest, "V6-COMPANY-001.2");

    let health_exit = health_status::run(root, &["dashboard".to_string()]);
    assert_eq!(health_exit, 0);
    let health_latest = read_json(&health_latest_path(root));
    let metric = health_latest
        .get("dashboard_metrics")
        .and_then(|v| v.get("company_governance_surface"));
    assert!(metric.is_some(), "missing company metric in dashboard");
}

#[test]
fn v6_company_batch13_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = company_plane::run(
        root,
        &[
            "orchestrate-agency".to_string(),
            "--strict=1".to_string(),
            "--team=ops".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("company_plane_conduit_gate")
    );
}
