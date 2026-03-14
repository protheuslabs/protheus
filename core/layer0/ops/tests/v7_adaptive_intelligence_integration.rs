use protheus_ops_core::adaptive_intelligence;
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
        .join("adaptive_intelligence")
        .join("latest.json")
}

fn runtime_state_path(root: &Path) -> PathBuf {
    core_state_root(root)
        .join("ops")
        .join("adaptive_intelligence")
        .join("runtime_state.json")
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
    fs::write(
        &bin,
        "#!/bin/sh\nmodel=\"$2\"\nif echo \"$model\" | grep -q qwen; then\n  echo \"creative-angle:explore\ncreative-bridge:novel\"\nelse\n  echo \"logical-step:plan\nlogical-check:verify\"\nfi\n",
    )
    .expect("write ollama stub");
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
fn v7_adaptive_intelligence_dual_runtime_connector_and_degradation_are_behavior_proven() {
    let _guard = test_env_lock();
    let tmp = temp_root("adaptive_intelligence_dual");
    let root = tmp.path();
    let state_root = root.join("state");
    std::env::set_var("PROTHEUS_CORE_STATE_ROOT", &state_root);
    let ollama_bin = install_ollama_stub(root);
    std::env::set_var("PROTHEUS_LOCAL_AI_BIN", &ollama_bin);

    write_text(
        root,
        "client/runtime/local/state/memory/conversation_eye/nodes.jsonl",
        "{\"text\":\"Operator wants reliable deployment evidence\"}\n{\"text\":\"Need bounded rollout and replay\"}\n",
    );
    write_text(
        root,
        "state/ops/organism_layer/dream_log.jsonl",
        "{\"insight\":\"Prefer smaller reversible actions first\"}\n{\"insight\":\"Novel path: combine audit replay with rollout proofs\"}\n",
    );

    assert_eq!(
        adaptive_intelligence::run(
            root,
            &[
                "propose".to_string(),
                "--prompt=prepare an adaptive plan".to_string(),
                "--persona=operator".to_string(),
                "--logical-bias=precise checklist".to_string(),
                "--creative-bias=novel hypotheses".to_string(),
                "--vram-gb=16".to_string(),
                "--ram-gb=32".to_string(),
                "--cpu-cores=8".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    let latest = read_json(&latest_path(root));
    assert_eq!(latest["mode"], "dual");
    assert!(latest["proposal"]["creative"].is_object());
    assert!(
        latest["proposal"]["connector"]["proposal_count"]
            .as_u64()
            .unwrap_or(0)
            >= 1
    );
    assert_claim(&latest, "V7-ADAPTIVE-001.1");
    assert_claim(&latest, "V7-ADAPTIVE-001.3");
    assert_claim(&latest, "V7-ADAPTIVE-001.4");
    assert_claim(&latest, "V7-ADAPTIVE-001.5");

    assert_eq!(
        adaptive_intelligence::run(
            root,
            &[
                "prioritize".to_string(),
                "--vram-gb=1".to_string(),
                "--ram-gb=2".to_string(),
                "--cpu-cores=2".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    let degraded = read_json(&latest_path(root));
    assert_eq!(degraded["resources"]["mode"], "tiny_logical_only");
    assert_claim(&degraded, "V7-ADAPTIVE-001.4");

    assert_eq!(
        adaptive_intelligence::run(
            root,
            &[
                "propose".to_string(),
                "--prompt=attempt unsafe route".to_string(),
                "--bypass=1".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        1
    );
    let denied = read_json(&latest_path(root));
    assert_eq!(denied["ok"], false);
    assert_eq!(denied["errors"][0], "conduit_bypass_rejected");
}

#[test]
fn v7_adaptive_intelligence_shadow_training_and_human_only_graduation_are_proven() {
    let _guard = test_env_lock();
    let tmp = temp_root("adaptive_intelligence_train");
    let root = tmp.path();
    let state_root = root.join("state");
    std::env::set_var("PROTHEUS_CORE_STATE_ROOT", &state_root);

    write_text(
        root,
        "client/runtime/local/state/memory/conversation_eye/nodes.jsonl",
        "{\"text\":\"Deploy local-only model router\"}\n{\"text\":\"Need deterministic connector receipts\"}\n{\"text\":\"Operator prefers precise runbooks\"}\n",
    );
    write_text(
        root,
        "state/ops/organism_layer/dream_log.jsonl",
        "{\"insight\":\"Blend shadow-training with nightly reflection\"}\n{\"insight\":\"Use logical-first degradation on small hardware\"}\n",
    );

    assert_eq!(
        adaptive_intelligence::run(
            root,
            &[
                "shadow-train".to_string(),
                "--cycles=16".to_string(),
                "--vram-gb=16".to_string(),
                "--ram-gb=32".to_string(),
                "--cpu-cores=8".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    let trained = read_json(&latest_path(root));
    assert_claim(&trained, "V7-ADAPTIVE-001.2");
    assert!(
        trained["specialization"]["logical_score_pct"]
            .as_f64()
            .unwrap_or(0.0)
            >= 85.0
    );

    assert_eq!(
        adaptive_intelligence::run(
            root,
            &[
                "graduate".to_string(),
                "--model=logical".to_string(),
                "--approvers=alice".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        1
    );
    let denied = read_json(&latest_path(root));
    assert_eq!(denied["ok"], false);
    assert!(denied["errors"].as_array().unwrap().len() >= 2);

    assert_eq!(
        adaptive_intelligence::run(
            root,
            &[
                "graduate".to_string(),
                "--model=logical".to_string(),
                "--human-only=1".to_string(),
                "--approvers=alice,bob".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    let graduated = read_json(&latest_path(root));
    assert_eq!(graduated["graduated"], true);
    assert_claim(&graduated, "V7-ADAPTIVE-001.6");

    let runtime = read_json(&runtime_state_path(root));
    assert_eq!(runtime["logical"]["graduated"], true);
}
