// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{health_status, observability_plane};
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
        .join("observability_plane")
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
fn v6_observability_batch15_monitor_workflow_incident_and_selfhost_are_receipted() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let monitor_exit = observability_plane::run(
        root,
        &[
            "monitor".to_string(),
            "--strict=1".to_string(),
            "--source=protheusd".to_string(),
            "--alert-class=slo".to_string(),
            "--severity=high".to_string(),
            "--message=latency_threshold_breach".to_string(),
        ],
    );
    assert_eq!(monitor_exit, 0);
    let monitor_latest = read_json(&latest_path(root));
    assert_eq!(
        monitor_latest.get("type").and_then(Value::as_str),
        Some("observability_plane_monitor")
    );
    assert_claim(&monitor_latest, "V6-OBSERVABILITY-001.1");

    let workflow_upsert_exit = observability_plane::run(
        root,
        &[
            "workflow".to_string(),
            "--strict=1".to_string(),
            "--op=upsert".to_string(),
            "--workflow-id=ops-response".to_string(),
            "--trigger=cron".to_string(),
            "--schedule=*/10 * * * *".to_string(),
            "--steps-json=[\"collect\",\"diagnose\",\"notify\"]".to_string(),
        ],
    );
    assert_eq!(workflow_upsert_exit, 0);
    let workflow_run_exit = observability_plane::run(
        root,
        &[
            "workflow".to_string(),
            "--strict=1".to_string(),
            "--op=run".to_string(),
            "--workflow-id=ops-response".to_string(),
        ],
    );
    assert_eq!(workflow_run_exit, 0);
    let workflow_latest = read_json(&latest_path(root));
    assert_claim(&workflow_latest, "V6-OBSERVABILITY-001.2");

    let incident_trigger_exit = observability_plane::run(
        root,
        &[
            "incident".to_string(),
            "--strict=1".to_string(),
            "--op=trigger".to_string(),
            "--incident-id=inc-001".to_string(),
            "--runbook=default-runbook".to_string(),
            "--action=quarantine+rollback".to_string(),
        ],
    );
    assert_eq!(incident_trigger_exit, 0);
    let incident_resolve_exit = observability_plane::run(
        root,
        &[
            "incident".to_string(),
            "--strict=1".to_string(),
            "--op=resolve".to_string(),
            "--incident-id=inc-001".to_string(),
        ],
    );
    assert_eq!(incident_resolve_exit, 0);
    let incident_latest = read_json(&latest_path(root));
    assert_claim(&incident_latest, "V6-OBSERVABILITY-001.3");

    let selfhost_exit = observability_plane::run(
        root,
        &[
            "selfhost".to_string(),
            "--strict=1".to_string(),
            "--op=deploy".to_string(),
            "--profile=docker-local".to_string(),
            "--telemetry-opt-in=0".to_string(),
        ],
    );
    assert_eq!(selfhost_exit, 0);
    let selfhost_latest = read_json(&latest_path(root));
    assert_eq!(
        selfhost_latest.get("type").and_then(Value::as_str),
        Some("observability_plane_selfhost")
    );
    assert_claim(&selfhost_latest, "V6-OBSERVABILITY-001.4");

    let health_exit = health_status::run(root, &["dashboard".to_string()]);
    assert_eq!(health_exit, 0);
    let health_latest = read_json(&health_latest_path(root));
    assert!(
        health_latest
            .get("dashboard_metrics")
            .and_then(|v| v.get("observability_control_surface"))
            .is_some(),
        "missing observability dashboard metric"
    );
}

#[test]
fn v6_observability_batch15_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = observability_plane::run(
        root,
        &[
            "monitor".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("observability_plane_conduit_gate")
    );
}
