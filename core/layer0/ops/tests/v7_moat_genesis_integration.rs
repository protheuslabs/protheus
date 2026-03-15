use protheus_ops_core::enterprise_hardening;
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_root(prefix: &str) -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix(&format!("protheus_{prefix}_"))
        .tempdir()
        .expect("tempdir")
}

fn test_env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().expect("lock")
}

fn core_state_root(root: &Path) -> std::path::PathBuf {
    if let Ok(v) = std::env::var("PROTHEUS_CORE_STATE_ROOT") {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return std::path::PathBuf::from(trimmed);
        }
    }
    root.join("core").join("local").join("state")
}

fn latest_path(root: &Path) -> std::path::PathBuf {
    core_state_root(root)
        .join("ops")
        .join("enterprise_hardening")
        .join("latest.json")
}

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read json");
    serde_json::from_str::<Value>(&raw).expect("parse json")
}

fn write_text(root: &Path, rel: &str, body: &str) {
    let p = root.join(rel);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).expect("mkdir");
    }
    fs::write(p, body).expect("write");
}

fn assert_claim(payload: &Value, id: &str) {
    let claims = payload
        .get("claim_evidence")
        .and_then(Value::as_array)
        .expect("claim evidence array");
    assert!(
        claims
            .iter()
            .any(|row| row.get("id").and_then(Value::as_str) == Some(id)),
        "missing claim evidence {id}: {payload}"
    );
}

#[test]
fn v7_moat_and_genesis_lanes_are_behavior_proven() {
    let _guard = test_env_lock();
    let tmp = temp_root("moat_genesis");
    let root = tmp.path();

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let state_root = root
        .join("local")
        .join("state")
        .join(format!("run_{nonce}"));
    std::env::set_var("PROTHEUS_CORE_STATE_ROOT", &state_root);
    std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "test-sign-key");

    write_text(root, "README.md", "# Protheus\n");
    write_text(root, "docs/workspace/SRS.md", "# SRS\n");
    write_text(root, "docs/workspace/DEFINITION_OF_DONE.md", "# DoD\n");
    write_text(root, "docs/workspace/codex_enforcer.md", "# Enforcer\n");
    write_text(
        root,
        "core/layer0/ops/src/v8_kernel.rs",
        "pub fn conduit_boundary() -> bool { true }\n",
    );
    write_text(
        root,
        "core/layer0/ops/src/binary_blob_runtime.rs",
        "pub fn binary_blob_runtime_ready() -> bool { true }\n",
    );
    write_text(
        root,
        "core/layer0/ops/src/directive_kernel.rs",
        "pub fn directive_kernel_ready() -> bool { true }\n",
    );
    write_text(
        root,
        "client/runtime/systems/ops/safe_wrapper.ts",
        "export const wrap = () => 'ok';\n",
    );

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "moat-license".to_string(),
                "--strict=1".to_string(),
                "--primitives=conduit,binary_blob,directive_kernel".to_string(),
                "--reviewer=tester".to_string(),
            ]
        ),
        0
    );
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("enterprise_hardening_moat_license")
    );
    assert_claim(&latest, "V7-MOAT-001.1");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "moat-contrast".to_string(),
                "--strict=0".to_string(),
                "--narrative=core authority contrast".to_string(),
            ]
        ),
        0
    );
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("enterprise_hardening_moat_contrast")
    );
    assert_claim(&latest, "V7-MOAT-001.2");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "moat-launch-sim".to_string(),
                "--strict=1".to_string(),
                "--contributors=1200".to_string(),
                "--events=1200".to_string(),
            ]
        ),
        0
    );
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("enterprise_hardening_moat_launch_sim")
    );
    assert_claim(&latest, "V7-MOAT-001.3");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "genesis-truth-gate".to_string(),
                "--strict=1".to_string(),
                "--regression-pass=1".to_string(),
                "--dod-pass=1".to_string(),
                "--verify-pass=1".to_string(),
            ]
        ),
        0
    );
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("enterprise_hardening_genesis_truth_gate")
    );
    assert_claim(&latest, "V7-GENESIS-001.1");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "genesis-thin-wrapper-audit".to_string(),
                "--strict=1".to_string(),
                "--scan-root=client/runtime/systems".to_string(),
            ]
        ),
        0
    );
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("enterprise_hardening_genesis_thin_wrapper_audit")
    );
    assert_claim(&latest, "V7-GENESIS-001.2");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "genesis-doc-freeze".to_string(),
                "--strict=1".to_string(),
                "--release-tag=v7-genesis-test".to_string(),
            ]
        ),
        0
    );
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("enterprise_hardening_genesis_doc_freeze")
    );
    assert_claim(&latest, "V7-GENESIS-001.3");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "genesis-bootstrap".to_string(),
                "--strict=1".to_string(),
                "--profile=canary".to_string(),
            ]
        ),
        0
    );
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("enterprise_hardening_genesis_bootstrap")
    );
    assert_claim(&latest, "V7-GENESIS-001.4");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "genesis-installer-sim".to_string(),
                "--strict=0".to_string(),
                "--profile=standard".to_string(),
            ]
        ),
        0
    );
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("enterprise_hardening_genesis_installer_sim")
    );
    assert_claim(&latest, "V7-GENESIS-001.5");

    std::env::remove_var("PROTHEUS_CORE_STATE_ROOT");
    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
}

#[test]
fn v7_genesis_truth_gate_and_thin_wrapper_fail_closed_when_unsafe() {
    let _guard = test_env_lock();
    let tmp = temp_root("moat_genesis_fail_closed");
    let root = tmp.path();

    let state_root = root.join("local").join("state");
    std::env::set_var("PROTHEUS_CORE_STATE_ROOT", &state_root);

    // Truth gate must fail in strict mode when required gates are absent.
    assert_eq!(
        enterprise_hardening::run(
            root,
            &["genesis-truth-gate".to_string(), "--strict=1".to_string()]
        ),
        1
    );

    // Thin-wrapper audit must fail when forbidden authority token is present.
    write_text(
        root,
        "client/runtime/systems/unsafe/runner.ts",
        "import { exec } from 'child_process';\nexport const run = () => exec('echo nope');\n",
    );
    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "genesis-thin-wrapper-audit".to_string(),
                "--strict=1".to_string(),
                "--scan-root=client/runtime/systems".to_string(),
            ]
        ),
        1
    );

    std::env::remove_var("PROTHEUS_CORE_STATE_ROOT");
}
