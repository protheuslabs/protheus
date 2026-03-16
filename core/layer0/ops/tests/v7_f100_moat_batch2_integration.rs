use protheus_ops_core::enterprise_hardening;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

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

fn core_state_root(root: &Path) -> PathBuf {
    if let Ok(v) = std::env::var("PROTHEUS_CORE_STATE_ROOT") {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    root.join("core").join("local").join("state")
}

fn latest_path(root: &Path) -> PathBuf {
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

fn install_ollama_stub(root: &Path) -> PathBuf {
    let dir = root.join("toolbin");
    fs::create_dir_all(&dir).expect("mkdir toolbin");
    let bin = dir.join("ollama");
    fs::write(&bin, "#!/bin/sh\necho local-ai-ok\n").expect("write ollama stub");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&bin).expect("stat").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&bin, perms).expect("chmod");
    }
    bin
}

#[test]
fn v7_f100_and_moat_batch2_contracts_are_behavior_proven() {
    let _guard = test_env_lock();
    let tmp = temp_root("f100_moat_batch2");
    let root = tmp.path();
    let state_root = root.join("local").join("state");
    std::env::set_var("PROTHEUS_CORE_STATE_ROOT", &state_root);

    write_text(
        root,
        "client/runtime/config/scale_readiness_program_policy.json",
        r#"{
  "budgets": {
    "max_p95_latency_ms": 250,
    "max_p99_latency_ms": 450,
    "max_cost_per_user_usd": 0.25
  }
}"#,
    );
    write_text(
        root,
        "local/state/ops/top1_assurance/latest.json",
        r#"{"ok":true,"proven_ratio":0.5}"#,
    );
    write_text(
        root,
        "local/state/ops/f100_reliability_certification/latest.json",
        r#"{"ok":true,"tier":"gold"}"#,
    );
    write_text(
        root,
        "proofs/layer0/core_formal_coverage_map.json",
        r#"{
  "schema_id": "core_formal_coverage_map",
  "schema_version": "1.0",
  "surfaces": [
    {"id":"core/layer0/ops::directive_kernel","status":"proven"},
    {"id":"core/layer2/execution::scheduler","status":"proven"}
  ]
}"#,
    );
    write_text(
        root,
        "local/state/artifacts/nightly_fuzz_chaos_report_2026-03-16.json",
        r#"{
  "ok": true,
  "summary": {
    "fuzz_failures": 0,
    "chaos_failures": 0
  }
}"#,
    );

    let ollama_bin = install_ollama_stub(root);
    std::env::set_var("PROTHEUS_LOCAL_AI_BIN", &ollama_bin);

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "zero-trust-profile".to_string(),
                "--strict=1".to_string(),
                "--issuer=https://issuer.enterprise.local".to_string(),
                "--cmek-key=kms://customer/protheus/main".to_string(),
                "--private-link=aws-privatelink".to_string(),
            ],
        ),
        0
    );
    let zero_latest = read_json(&latest_path(root));
    assert_claim(&zero_latest, "V7-F100-002.3");
    let replay_hash = zero_latest
        .get("receipt_hash")
        .and_then(Value::as_str)
        .expect("receipt hash")
        .to_string();

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "ops-bridge".to_string(),
                "--strict=1".to_string(),
                "--providers=datadog,splunk,servicenow,jira".to_string(),
            ],
        ),
        0
    );
    assert_claim(&read_json(&latest_path(root)), "V7-F100-002.4");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "scale-ha-certify".to_string(),
                "--strict=1".to_string(),
                "--regions=3".to_string(),
                "--airgap-agents=10000".to_string(),
                "--cold-start-ms=80".to_string(),
            ],
        ),
        0
    );
    assert_claim(&read_json(&latest_path(root)), "V7-F100-002.5");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "deploy-modules".to_string(),
                "--strict=1".to_string(),
                "--profile=enterprise".to_string(),
            ],
        ),
        0
    );
    assert_claim(&read_json(&latest_path(root)), "V7-F100-002.6");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "adoption-bootstrap".to_string(),
                "--strict=1".to_string(),
                "--profile=enterprise".to_string(),
            ],
        ),
        0
    );
    assert_claim(&read_json(&latest_path(root)), "V7-F100-002.8");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "replay".to_string(),
                format!("--receipt-hash={replay_hash}"),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    assert_claim(&read_json(&latest_path(root)), "V7-MOAT-002.1");

    assert_eq!(enterprise_hardening::run(root, &["explore".to_string()]), 0);
    assert_claim(&read_json(&latest_path(root)), "V7-MOAT-002.2");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "ai".to_string(),
                "--strict=1".to_string(),
                "--model=ollama/llama3.2:latest".to_string(),
                "--prompt=hello".to_string(),
                "--local-only=1".to_string(),
            ],
        ),
        0
    );
    assert_claim(&read_json(&latest_path(root)), "V7-MOAT-002.3");

    let peer_root = root.join("peer");
    write_text(
        &peer_root,
        "core/local/state/ops/mock/history.jsonl",
        "{\"receipt_hash\":\"peerhash\",\"ts\":\"2026-03-14T00:00:00Z\",\"ok\":true}\n",
    );
    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "sync".to_string(),
                format!("--peer-roots={}", peer_root.display()),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    assert_claim(&read_json(&latest_path(root)), "V7-MOAT-002.4");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "energy-cert".to_string(),
                "--strict=1".to_string(),
                "--agents=100".to_string(),
                "--idle-watts=0.2".to_string(),
                "--task-watts=0.3".to_string(),
            ],
        ),
        0
    );
    assert_claim(&read_json(&latest_path(root)), "V7-MOAT-002.5");

    write_text(
        root,
        "fixtures/openfang.json",
        r#"{
  "agents": [{"name": "alpha"}],
  "tasks": [{"name": "ship"}],
  "workflows": [{"name": "main"}],
  "tools": [{"name": "git"}]
}"#,
    );
    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "migrate-ecosystem".to_string(),
                "--strict=1".to_string(),
                "--from=openfang".to_string(),
                format!(
                    "--payload-file={}",
                    root.join("fixtures/openfang.json").display()
                ),
            ],
        ),
        0
    );
    assert_claim(&read_json(&latest_path(root)), "V7-MOAT-002.6");

    write_text(
        root,
        "fixtures/agent_os.json",
        r#"{
  "agents": [{"name": "delta"}],
  "flows": [{"name": "triage"}],
  "capabilities": [{"name": "jira"}],
  "receipts": [{"receipt_hash": "legacy-agent-os"}]
}"#,
    );
    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "migrate-ecosystem".to_string(),
                "--strict=1".to_string(),
                "--from=agent-os".to_string(),
                format!(
                    "--payload-file={}",
                    root.join("fixtures/agent_os.json").display()
                ),
            ],
        ),
        0
    );
    assert_claim(&read_json(&latest_path(root)), "V7-MOAT-002.6");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "chaos-run".to_string(),
                "--strict=1".to_string(),
                "--agents=1".to_string(),
                "--attacks=prompt-injection".to_string(),
            ],
        ),
        0
    );
    assert_claim(&read_json(&latest_path(root)), "V7-MOAT-002.7");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "chaos-run".to_string(),
                "--strict=1".to_string(),
                "--suite=isolate".to_string(),
                "--agents=8".to_string(),
            ],
        ),
        0
    );
    assert_claim(&read_json(&latest_path(root)), "V7-CANYON-003.2");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "assistant-mode".to_string(),
                "--strict=1".to_string(),
                "--topic=first-run".to_string(),
                "--hand=starter-hand".to_string(),
                format!("--workspace={}", root.display()),
            ],
        ),
        0
    );
    assert_claim(&read_json(&latest_path(root)), "V7-MOAT-003.2");

    assert_eq!(
        enterprise_hardening::run(root, &["super-gate".to_string(), "--strict=1".to_string()]),
        0
    );
    let super_gate = read_json(&latest_path(root));
    assert_eq!(
        super_gate
            .pointer("/gate/formal/scheduler_proven")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        super_gate
            .pointer("/gate/fuzz_chaos/report_ok")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&super_gate, "V7-F100-002.7");

    std::env::remove_var("PROTHEUS_CORE_STATE_ROOT");
    std::env::remove_var("PROTHEUS_LOCAL_AI_BIN");
}
