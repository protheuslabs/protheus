// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{health_status, substrate_plane};
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
        .join("substrate_plane")
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
fn v6_substrate_batch14_csi_and_bio_lanes_execute_with_receipts() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let policy_exit = substrate_plane::run(
        root,
        &[
            "csi-policy".to_string(),
            "--strict=1".to_string(),
            "--consent=1".to_string(),
            "--locality=local-only".to_string(),
            "--retention-minutes=120".to_string(),
            "--biometric-risk=medium".to_string(),
        ],
    );
    assert_eq!(policy_exit, 0);
    let policy_latest = read_json(&latest_path(root));
    assert_eq!(
        policy_latest.get("type").and_then(Value::as_str),
        Some("substrate_plane_csi_policy")
    );
    assert_claim(&policy_latest, "V6-SUBSTRATE-001.4");

    let capture_exit = substrate_plane::run(
        root,
        &[
            "csi-capture".to_string(),
            "--strict=1".to_string(),
            "--adapter=wifi-csi-esp32".to_string(),
        ],
    );
    assert_eq!(capture_exit, 0);
    let capture_latest = read_json(&latest_path(root));
    assert_eq!(
        capture_latest.get("type").and_then(Value::as_str),
        Some("substrate_plane_csi_capture")
    );
    assert_claim(&capture_latest, "V6-SUBSTRATE-001.1");

    let register_exit = substrate_plane::run(
        root,
        &[
            "csi-module".to_string(),
            "--strict=1".to_string(),
            "--op=register".to_string(),
            "--module=fall-detection".to_string(),
            "--input-contract=csi.normalized_events.v1".to_string(),
            "--budget-units=250".to_string(),
            "--privacy-class=sensitive".to_string(),
        ],
    );
    assert_eq!(register_exit, 0);
    let activate_exit = substrate_plane::run(
        root,
        &[
            "csi-module".to_string(),
            "--strict=1".to_string(),
            "--op=activate".to_string(),
            "--module=fall-detection".to_string(),
        ],
    );
    assert_eq!(activate_exit, 0);
    let module_latest = read_json(&latest_path(root));
    assert_eq!(
        module_latest.get("type").and_then(Value::as_str),
        Some("substrate_plane_csi_module")
    );
    assert_claim(&module_latest, "V6-SUBSTRATE-001.2");

    let embedded_exit = substrate_plane::run(
        root,
        &[
            "csi-embedded-profile".to_string(),
            "--strict=1".to_string(),
            "--target=esp32".to_string(),
            "--power-mw=510".to_string(),
            "--latency-ms=180".to_string(),
            "--offline=1".to_string(),
        ],
    );
    assert_eq!(embedded_exit, 0);
    let embedded_latest = read_json(&latest_path(root));
    assert_eq!(
        embedded_latest
            .get("profile")
            .and_then(|v| v.get("degraded_mode"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&embedded_latest, "V6-SUBSTRATE-001.3");

    let eye_enable_exit = substrate_plane::run(
        root,
        &[
            "eye-bind".to_string(),
            "--strict=1".to_string(),
            "--op=enable".to_string(),
            "--source=wifi".to_string(),
            "--persona=watcher".to_string(),
            "--shadow=watcher-1".to_string(),
        ],
    );
    assert_eq!(eye_enable_exit, 0);
    let eye_latest = read_json(&latest_path(root));
    assert_eq!(
        eye_latest.get("type").and_then(Value::as_str),
        Some("substrate_plane_eye_bind")
    );
    assert_claim(&eye_latest, "V6-SUBSTRATE-001.5");

    let interface_exit = substrate_plane::run(
        root,
        &[
            "bio-interface".to_string(),
            "--strict=1".to_string(),
            "--op=ingest".to_string(),
            "--channels=16".to_string(),
        ],
    );
    assert_eq!(interface_exit, 0);
    let interface_latest = read_json(&latest_path(root));
    assert_eq!(
        interface_latest.get("type").and_then(Value::as_str),
        Some("substrate_plane_bio_interface")
    );
    assert_claim(&interface_latest, "V6-SUBSTRATE-002.1");

    let feedback_exit = substrate_plane::run(
        root,
        &[
            "bio-feedback".to_string(),
            "--strict=1".to_string(),
            "--op=stimulate".to_string(),
            "--mode=closed-loop".to_string(),
            "--consent=1".to_string(),
        ],
    );
    assert_eq!(feedback_exit, 0);
    let feedback_latest = read_json(&latest_path(root));
    assert_eq!(
        feedback_latest.get("type").and_then(Value::as_str),
        Some("substrate_plane_bio_feedback")
    );
    assert_claim(&feedback_latest, "V6-SUBSTRATE-002.2");

    let degrade_exit = substrate_plane::run(
        root,
        &[
            "bio-feedback".to_string(),
            "--strict=1".to_string(),
            "--op=degrade".to_string(),
            "--mode=silicon-only".to_string(),
        ],
    );
    assert_eq!(degrade_exit, 0);
    let degrade_latest = read_json(&latest_path(root));
    assert_eq!(
        degrade_latest
            .get("feedback")
            .and_then(|v| v.get("mode"))
            .and_then(Value::as_str),
        Some("silicon-only")
    );

    let health_exit = health_status::run(root, &["dashboard".to_string()]);
    assert_eq!(health_exit, 0);
    let health_latest = read_json(&health_latest_path(root));
    let metric = health_latest
        .get("dashboard_metrics")
        .and_then(|v| v.get("substrate_signal_surface"));
    assert!(metric.is_some(), "missing substrate metric in dashboard");
}

#[test]
fn v6_substrate_batch14_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = substrate_plane::run(
        root,
        &[
            "csi-capture".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("substrate_plane_conduit_gate")
    );
}
