use protheus_ops_core::canyon_plane;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

const ENV_KEY: &str = "PROTHEUS_CANYON_PLANE_STATE_ROOT";

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

fn latest_path(state_root: &Path) -> PathBuf {
    state_root.join("latest.json")
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

fn write_json(root: &Path, rel: &str, value: &Value) {
    let p = root.join(rel);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).expect("mkdir");
    }
    let mut body = serde_json::to_string_pretty(value).expect("encode");
    body.push('\n');
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

fn install_stub_binary(root: &Path) -> PathBuf {
    let bin = root.join("bin").join("protheus-ops");
    if let Some(parent) = bin.parent() {
        fs::create_dir_all(parent).expect("mkdir bin dir");
    }
    fs::write(
        &bin,
        "#!/bin/sh\n# stub cold-start probe for canyon test\nexit 0\n",
    )
    .expect("write stub binary");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&bin).expect("stat").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&bin, perms).expect("chmod");
    }
    bin
}

fn install_static_protheusd_fixture(root: &Path, size_mb: usize) -> PathBuf {
    let bin = root
        .join("target")
        .join("x86_64-unknown-linux-musl")
        .join("release")
        .join("protheusd");
    if let Some(parent) = bin.parent() {
        fs::create_dir_all(parent).expect("mkdir protheusd dir");
    }
    fs::write(&bin, vec![0_u8; size_mb * 1024 * 1024]).expect("write protheusd fixture");
    bin
}

#[test]
fn v7_canyon_contracts_are_behavior_proven() {
    let _guard = test_env_lock();
    let tmp = temp_root("canyon_batch");
    let root = tmp.path();
    let canyon_state = root.join("local").join("state").join("canyon");
    std::env::set_var(ENV_KEY, &canyon_state);

    let stub_bin = install_stub_binary(root);

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "efficiency".to_string(),
                "--strict=1".to_string(),
                format!("--binary-path={}", stub_bin.display()),
                "--idle-memory-mb=20".to_string(),
                "--concurrent-agents=50".to_string(),
            ]
        ),
        0
    );
    let mut latest = read_json(&latest_path(&canyon_state));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("canyon_plane_efficiency")
    );
    assert_claim(&latest, "V7-CANYON-001.1");

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "hands-army".to_string(),
                "--op=bootstrap".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("canyon_plane_hands_army")
    );
    assert_claim(&latest, "V7-CANYON-001.2");
    assert!(
        latest
            .get("hands_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            >= 60
    );

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "evolution".to_string(),
                "--op=propose".to_string(),
                "--kind=code".to_string(),
                "--description=optimize scheduler".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    let proposal_id = latest
        .get("proposal_id")
        .and_then(Value::as_str)
        .expect("proposal id")
        .to_string();
    assert_claim(&latest, "V7-CANYON-001.3");

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "evolution".to_string(),
                "--op=shadow-simulate".to_string(),
                format!("--proposal-id={proposal_id}"),
                "--score=0.90".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "evolution".to_string(),
                "--op=review".to_string(),
                format!("--proposal-id={proposal_id}"),
                "--approved=1".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "evolution".to_string(),
                "--op=apply".to_string(),
                format!("--proposal-id={proposal_id}"),
                "--strict=1".to_string(),
            ]
        ),
        0
    );

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "sandbox".to_string(),
                "--op=run".to_string(),
                "--session-id=edge-a".to_string(),
                "--tier=native".to_string(),
                "--language=rust".to_string(),
                "--fuel=5000".to_string(),
                "--epoch=200".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_claim(&latest, "V7-CANYON-001.4");

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "sandbox".to_string(),
                "--op=run".to_string(),
                "--session-id=edge-b".to_string(),
                "--tier=wasm".to_string(),
                "--language=python".to_string(),
                "--fuel=5000".to_string(),
                "--epoch=200".to_string(),
                "--logical-only=1".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_claim(&latest, "V7-CANYON-003.3");

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "sandbox".to_string(),
                "--op=snapshot".to_string(),
                "--session-id=edge-b".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_claim(&latest, "V7-CANYON-003.1");
    let snapshot_id = latest
        .get("snapshot_id")
        .and_then(Value::as_str)
        .expect("snapshot id")
        .to_string();

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "sandbox".to_string(),
                "--op=resume".to_string(),
                "--session-id=edge-b-restored".to_string(),
                format!("--snapshot-id={snapshot_id}"),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_claim(&latest, "V7-CANYON-003.1");

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "ecosystem".to_string(),
                "--op=bootstrap".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_claim(&latest, "V7-CANYON-001.5");

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "ecosystem".to_string(),
                "--op=marketplace-publish".to_string(),
                "--hand-id=starter-hand".to_string(),
                format!("--receipt-file={}", latest_path(&canyon_state).display()),
                "--chaos-score=95".to_string(),
                "--reputation=88".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_claim(&latest, "V7-MOAT-003.1");

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "ecosystem".to_string(),
                "--op=marketplace-install".to_string(),
                "--hand-id=starter-hand".to_string(),
                format!("--target-dir={}", root.join("installed/starter-hand").display()),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_claim(&latest, "V7-MOAT-003.1");

    write_text(root, "workspace/README.md", "# workspace\n");
    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "workflow".to_string(),
                "--op=run".to_string(),
                "--goal=ship_end_to_end".to_string(),
                format!("--workspace={}", root.join("workspace").display()),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_claim(&latest, "V7-CANYON-001.6");

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "scheduler".to_string(),
                "--op=simulate".to_string(),
                "--agents=10000".to_string(),
                "--nodes=4".to_string(),
                "--modes=kubernetes,edge,distributed".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_claim(&latest, "V7-CANYON-001.7");

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "control-plane".to_string(),
                "--op=snapshot".to_string(),
                "--rbac=1".to_string(),
                "--sso=1".to_string(),
                "--hitl=1".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_claim(&latest, "V7-CANYON-001.8");

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "adoption".to_string(),
                "--op=run-demo".to_string(),
                "--tutorial=guided_first_run".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_claim(&latest, "V7-CANYON-001.9");

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "benchmark-gate".to_string(),
                "--op=run".to_string(),
                "--milestone=day90".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("canyon_plane_benchmark_gate")
    );
    assert_claim(&latest, "V7-CANYON-001.10");
    assert_eq!(
        latest
            .get("state")
            .and_then(|v| v.get("release_blocked"))
            .and_then(Value::as_bool),
        Some(false)
    );

    std::env::remove_var(ENV_KEY);
}

#[test]
fn v7_canyon_fail_closed_paths_reject_bypass_and_failed_benchmarks() {
    let _guard = test_env_lock();
    let tmp = temp_root("canyon_fail_closed");
    let root = tmp.path();
    let canyon_state = root.join("local").join("state").join("canyon");
    std::env::set_var(ENV_KEY, &canyon_state);

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "efficiency".to_string(),
                "--strict=1".to_string(),
                "--bypass=1".to_string(),
            ]
        ),
        1
    );
    let mut latest = read_json(&latest_path(&canyon_state));
    assert_eq!(
        latest.get("error").and_then(Value::as_str),
        Some("conduit_bypass_rejected")
    );

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "sandbox".to_string(),
                "--op=run".to_string(),
                "--session-id=bad-logical".to_string(),
                "--tier=native".to_string(),
                "--language=rust".to_string(),
                "--logical-only=1".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        1
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_eq!(
        latest
            .get("errors")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().any(|row| row.as_str() == Some("sandbox_logical_only_requires_wasm"))),
        Some(true)
    );

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "ecosystem".to_string(),
                "--op=marketplace-install".to_string(),
                "--hand-id=missing".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        1
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_eq!(
        latest.get("error").and_then(Value::as_str),
        Some("marketplace_entry_missing")
    );

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "benchmark-gate".to_string(),
                "--op=run".to_string(),
                "--milestone=day180".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        1
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("canyon_plane_benchmark_gate")
    );
    assert_eq!(
        latest
            .get("state")
            .and_then(|v| v.get("release_blocked"))
            .and_then(Value::as_bool),
        Some(true)
    );

    std::env::remove_var(ENV_KEY);
}

#[test]
fn v7_canyon_benchmark_gate_uses_adjacent_evidence_when_local_state_is_empty() {
    let _guard = test_env_lock();
    let tmp = temp_root("canyon_adjacent_benchmark");
    let root = tmp.path();
    let canyon_state = root.join("local").join("state").join("canyon");
    std::env::set_var(ENV_KEY, &canyon_state);

    write_json(
        root,
        "core/local/state/ops/top1_assurance/benchmark_latest.json",
        &serde_json::json!({
            "metrics": {
                "cold_start_ms": 72.0,
                "idle_rss_mb": 21.0,
                "install_size_mb": 22.4,
                "tasks_per_sec": 6400.0
            }
        }),
    );
    write_json(
        root,
        "core/local/state/ops/enterprise_hardening/f100/ops_bridge.json",
        &serde_json::json!({"providers": [{"provider": "splunk"}]}),
    );
    write_json(
        root,
        "core/local/state/ops/enterprise_hardening/f100/scale_ha_certification.json",
        &serde_json::json!({"airgap_agents": 10000, "regions": 3}),
    );
    write_json(
        root,
        "core/local/state/ops/enterprise_hardening/f100/adoption_bootstrap/bootstrap.json",
        &serde_json::json!({"profile": "enterprise", "compliance": true}),
    );
    write_json(
        root,
        "local/state/canyon/latest.json",
        &serde_json::json!({"ok": true}),
    );

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "benchmark-gate".to_string(),
                "--op=run".to_string(),
                "--milestone=day90".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        0
    );
    let latest = read_json(&latest_path(&canyon_state));
    assert_eq!(
        latest.get("ok").and_then(Value::as_bool),
        Some(true),
        "{latest}"
    );
    assert_eq!(
        latest
            .get("claim_evidence")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(|row| row.get("evidence"))
            .and_then(|row| row.get("performance_source"))
            .and_then(Value::as_str)
            .map(|v| v.contains("top1_assurance/benchmark_latest.json")),
        Some(true)
    );

    std::env::remove_var(ENV_KEY);
}

#[test]
fn v7_canyon_benchmark_gate_prefers_real_binary_and_materializes_missing_enterprise_evidence() {
    let _guard = test_env_lock();
    let tmp = temp_root("canyon_gate_materialize");
    let root = tmp.path();
    let canyon_state = root.join("local").join("state").join("canyon");
    std::env::set_var(ENV_KEY, &canyon_state);

    install_static_protheusd_fixture(root, 3);

    write_json(
        root,
        "docs/client/reports/runtime_snapshots/ops/proof_pack/top1_benchmark_snapshot.json",
        &serde_json::json!({
            "metrics": {
                "cold_start_ms": 74.5,
                "idle_rss_mb": 22.1,
                "install_size_mb": 126.4,
                "tasks_per_sec": 7420.0
            }
        }),
    );
    write_json(
        root,
        "core/local/state/ops/enterprise_hardening/f100/scale_ha_certification.json",
        &serde_json::json!({"airgap_agents": 10000, "regions": 3}),
    );
    write_json(root, "local/state/canyon/latest.json", &serde_json::json!({"ok": true}));

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "benchmark-gate".to_string(),
                "--op=run".to_string(),
                "--milestone=day90".to_string(),
                "--strict=1".to_string(),
            ]
        ),
        0
    );

    let latest = read_json(&latest_path(&canyon_state));
    assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(true), "{latest}");

    let evidence = latest
        .get("claim_evidence")
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())
        .and_then(|row| row.get("evidence"))
        .cloned()
        .expect("claim evidence payload");
    assert_eq!(
        evidence
            .get("binary_size_source")
            .and_then(Value::as_str)
            .map(|v| v.contains("target/x86_64-unknown-linux-musl/release/protheusd")),
        Some(true)
    );
    assert_eq!(
        evidence
            .get("audit_source")
            .and_then(Value::as_str)
            .map(|v| v.contains("enterprise_hardening/moat/explorer/index.json")),
        Some(true)
    );
    assert_eq!(
        evidence
            .get("adoption_source")
            .and_then(Value::as_str)
            .map(|v| v.contains("enterprise_hardening/f100/adoption_bootstrap/bootstrap.json")),
        Some(true)
    );
    assert!(
        root.join("core/local/state/ops/enterprise_hardening/moat/explorer/index.json")
            .exists()
    );
    assert!(
        root.join("core/local/state/ops/enterprise_hardening/f100/adoption_bootstrap/bootstrap.json")
            .exists()
    );

    std::env::remove_var(ENV_KEY);
}
