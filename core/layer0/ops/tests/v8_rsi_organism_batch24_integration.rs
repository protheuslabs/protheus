// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{directive_kernel, organism_layer, rsi_ignition};
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn env_guard() -> std::sync::MutexGuard<'static, ()> {
    env_lock()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read json");
    serde_json::from_str(&raw).expect("decode json")
}

fn latest(scope: &str, root: &Path) -> Value {
    read_json(
        &root
            .join("core")
            .join("local")
            .join("state")
            .join("ops")
            .join(scope)
            .join("latest.json"),
    )
}

fn jsonl_count(path: &Path) -> usize {
    fs::read_to_string(path)
        .ok()
        .map(|raw| raw.lines().filter(|line| !line.trim().is_empty()).count())
        .unwrap_or(0)
}

fn assert_claim(latest: &Value, id: &str) {
    assert_eq!(
        latest
            .get("claim_evidence")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .any(|row| row.get("id").and_then(Value::as_str) == Some(id))
            }),
        Some(true),
        "missing claim_evidence id={id} in latest={latest}"
    );
}

fn allow(root: &Path, directive: &str) {
    assert_eq!(
        directive_kernel::run(
            root,
            &[
                "prime-sign".to_string(),
                format!("--directive={directive}"),
                "--signer=tester".to_string(),
            ],
        ),
        0
    );
}

#[test]
fn v8_batch24_directive_dashboard_migration_surface_is_core_authoritative() {
    let _guard = env_guard();
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();
    std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "batch24-signing-key");

    let legacy_path = root
        .join("docs")
        .join("workspace")
        .join("AGENT-CONSTITUTION.md");
    fs::create_dir_all(legacy_path.parent().expect("parent")).expect("mkdir");
    fs::write(&legacy_path, "- allow:organism:*\n- deny:rsi:unsafe\n").expect("write legacy");

    assert_eq!(
        directive_kernel::run(root, &["migrate".to_string(), "--apply=1".to_string()]),
        0
    );
    assert_eq!(directive_kernel::run(root, &["dashboard".to_string()]), 0);
    let latest = latest("directive_kernel", root);
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("directive_kernel_dashboard")
    );
    assert_eq!(
        latest
            .get("dashboard")
            .and_then(|v| v.get("hierarchy"))
            .and_then(|v| v.get("prime_count"))
            .and_then(Value::as_u64)
            .map(|v| v >= 1),
        Some(true)
    );
    assert_claim(&latest, "V8-DIRECTIVES-001.5");

    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
}

#[test]
fn v8_batch24_rsi_ignition_writes_recursive_metacognitive_and_proactive_artifacts() {
    let _guard = env_guard();
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();
    std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "batch24-signing-key");
    std::env::set_var("BINARY_BLOB_VAULT_SIGNING_KEY", "batch24-blob-key");

    allow(root, "allow:rsi:ignite:conduit");
    allow(root, "allow:rsi:swarm");
    allow(root, "allow:rsi:evolve:conduit");
    allow(root, "allow:blob:mutate");
    allow(root, "allow:blob_mutate:*");

    assert_eq!(
        rsi_ignition::run(
            root,
            &[
                "ignite".to_string(),
                "--proposal=stabilize planner".to_string(),
                "--module=conduit".to_string(),
                "--apply=1".to_string(),
                "--canary-pass=1".to_string(),
                "--sim-regression=0.001".to_string(),
            ],
        ),
        0
    );
    assert_claim(&latest("rsi_ignition", root), "V8-RSI-IGNITION-001");

    assert_eq!(rsi_ignition::run(root, &["reflect".to_string()]), 0);
    assert_claim(&latest("rsi_ignition", root), "V8-RSI-IGNITION-002");

    assert_eq!(
        rsi_ignition::run(
            root,
            &[
                "swarm".to_string(),
                "--nodes=6".to_string(),
                "--share-rate=0.62".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_claim(&latest("rsi_ignition", root), "V8-RSI-IGNITION-003");

    assert_eq!(
        rsi_ignition::run(
            root,
            &[
                "evolve".to_string(),
                "--insight=night loop found lower drift route".to_string(),
                "--module=conduit".to_string(),
                "--apply=1".to_string(),
                "--ignite-apply=0".to_string(),
                "--night-cycle=1".to_string(),
            ],
        ),
        0
    );
    assert_claim(&latest("rsi_ignition", root), "V8-RSI-IGNITION-004");

    assert!(jsonl_count(&root.join("core/local/state/ops/rsi_ignition/recursive_loop.jsonl")) >= 1);
    assert!(
        jsonl_count(&root.join("core/local/state/ops/rsi_ignition/metacognition_journal.jsonl"))
            >= 1
    );
    assert!(
        jsonl_count(&root.join("core/local/state/ops/rsi_ignition/network_symbiosis.jsonl")) >= 1
    );
    assert!(
        jsonl_count(&root.join("core/local/state/ops/rsi_ignition/proactive_evolution.jsonl")) >= 1
    );

    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    std::env::remove_var("BINARY_BLOB_VAULT_SIGNING_KEY");
}

#[test]
fn v8_batch24_organism_dream_homeostasis_personality_symbiosis_and_mutation_emit_claims() {
    let _guard = env_guard();
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();
    std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "batch24-signing-key");
    std::env::set_var("BINARY_BLOB_VAULT_SIGNING_KEY", "batch24-blob-key");
    std::env::set_var("ORGANISM_CRYSTAL_SIGNING_KEY", "batch24-crystal-key");

    allow(root, "allow:organism:dream");
    allow(root, "allow:organism:homeostasis");
    allow(root, "allow:organism:crystallize");
    allow(root, "allow:organism:symbiosis");
    allow(root, "allow:organism:mutate");
    allow(root, "allow:rsi:ignite:conduit");
    allow(root, "allow:rsi:swarm");
    allow(root, "allow:blob:mutate");
    allow(root, "allow:blob_mutate:*");

    assert_eq!(
        organism_layer::run(
            root,
            &[
                "dream".to_string(),
                "--idle-hours=7".to_string(),
                "--experiments=4".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_claim(&latest("organism_layer", root), "V8-ORGANISM-001.1");

    assert_eq!(
        organism_layer::run(
            root,
            &[
                "homeostasis".to_string(),
                "--coherence=0.79".to_string(),
                "--metabolism=0.55".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_claim(&latest("organism_layer", root), "V8-ORGANISM-001.2");

    assert_eq!(
        organism_layer::run(
            root,
            &[
                "crystallize".to_string(),
                "--persona=default".to_string(),
                "--delta=more concise and coherent".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_claim(&latest("organism_layer", root), "V8-ORGANISM-001.3");

    assert_eq!(
        organism_layer::run(
            root,
            &[
                "symbiosis".to_string(),
                "--nodes=8".to_string(),
                "--memory-share=0.63".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_claim(&latest("organism_layer", root), "V8-ORGANISM-001.4");

    assert_eq!(
        organism_layer::run(
            root,
            &[
                "mutate".to_string(),
                "--proposal=proactive eureka route".to_string(),
                "--module=conduit".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    let latest = latest("organism_layer", root);
    assert_claim(&latest, "V8-ORGANISM-001.5");
    assert_eq!(
        latest
            .get("directive_gate_evaluation")
            .and_then(|v| v.get("allowed"))
            .and_then(Value::as_bool),
        Some(true)
    );

    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    std::env::remove_var("BINARY_BLOB_VAULT_SIGNING_KEY");
    std::env::remove_var("ORGANISM_CRYSTAL_SIGNING_KEY");
}
