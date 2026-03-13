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
fn v6_substrate_batch15_bio_template_ethics_and_enable_are_receipted() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let template_exit = substrate_plane::run(
        root,
        &[
            "bio-adapter-template".to_string(),
            "--strict=1".to_string(),
            "--op=emit".to_string(),
            "--adapter=bio-neural-generic".to_string(),
            "--spike-channels=spike_rate_hz,burst_index".to_string(),
            "--stimulation-channels=stim_current_ua,stim_pulse_width_us".to_string(),
        ],
    );
    assert_eq!(template_exit, 0);
    let template_latest = read_json(&latest_path(root));
    assert_eq!(
        template_latest.get("type").and_then(Value::as_str),
        Some("substrate_plane_bio_adapter_template")
    );
    assert_claim(&template_latest, "V6-SUBSTRATE-002.3");

    let blocked_exit = substrate_plane::run(
        root,
        &[
            "bioethics-policy".to_string(),
            "--strict=1".to_string(),
            "--op=enforce".to_string(),
            "--consent=1".to_string(),
            "--high-risk=1".to_string(),
        ],
    );
    assert_eq!(blocked_exit, 1);
    let blocked_latest = read_json(&latest_path(root));
    assert_eq!(
        blocked_latest.get("type").and_then(Value::as_str),
        Some("substrate_plane_bioethics_policy")
    );
    assert_eq!(
        blocked_latest.get("ok").and_then(Value::as_bool),
        Some(false)
    );
    assert_claim(&blocked_latest, "V6-SUBSTRATE-002.4");

    let approve_exit = substrate_plane::run(
        root,
        &[
            "bioethics-policy".to_string(),
            "--strict=1".to_string(),
            "--op=approve".to_string(),
            "--approval=HMAN-BIO-001".to_string(),
            "--artifact-ref=evidence://bio/approval_bundle".to_string(),
        ],
    );
    assert_eq!(approve_exit, 0);

    let enforce_exit = substrate_plane::run(
        root,
        &[
            "bioethics-policy".to_string(),
            "--strict=1".to_string(),
            "--op=enforce".to_string(),
            "--consent=1".to_string(),
            "--high-risk=1".to_string(),
        ],
    );
    assert_eq!(enforce_exit, 0);
    let policy_latest = read_json(&latest_path(root));
    assert_eq!(policy_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&policy_latest, "V6-SUBSTRATE-002.4");

    let enable_exit = substrate_plane::run(
        root,
        &[
            "bio-enable".to_string(),
            "--strict=1".to_string(),
            "--mode=biological".to_string(),
            "--persona=neural-watch".to_string(),
            "--adapter=bio-neural-generic".to_string(),
        ],
    );
    assert_eq!(enable_exit, 0);
    let enable_latest = read_json(&latest_path(root));
    assert_eq!(
        enable_latest.get("type").and_then(Value::as_str),
        Some("substrate_plane_bio_enable")
    );
    assert_claim(&enable_latest, "V6-SUBSTRATE-002.5");

    let health_exit = health_status::run(root, &["dashboard".to_string()]);
    assert_eq!(health_exit, 0);
    let health_latest = read_json(&health_latest_path(root));
    let mode = health_latest
        .get("dashboard_metrics")
        .and_then(|v| v.get("substrate_signal_surface"))
        .and_then(|v| v.get("biological_mode"))
        .and_then(Value::as_str);
    assert_eq!(mode, Some("biological"));
}

#[test]
fn v6_substrate_batch15_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = substrate_plane::run(
        root,
        &[
            "bio-enable".to_string(),
            "--strict=1".to_string(),
            "--mode=biological".to_string(),
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
