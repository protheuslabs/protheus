// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{
    binary_blob_runtime, directive_kernel, intelligence_nexus, network_protocol, organism_layer,
};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn env_guard() -> std::sync::MutexGuard<'static, ()> {
    env_lock().lock().unwrap_or_else(|poison| poison.into_inner())
}

fn temp_root(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("protheus_v8_runtime_proof_{name}_{nonce}"));
    fs::create_dir_all(&root).expect("mkdir");
    root
}

// Registry used by CI gates to verify that V8 "done" status cannot bypass runtime proofs.
const V8_PROOF_IDS: &[&str] = &[
    "V8-BINARY-BLOB-001.1",
    "V8-BINARY-BLOB-001.2",
    "V8-BINARY-BLOB-001.3",
    "V8-BINARY-BLOB-001.4",
    "V8-BINARY-BLOB-001.5",
    "V8-BINARY-BLOB-001.6",
    "V8-DIRECTIVES-001.1",
    "V8-DIRECTIVES-001.2",
    "V8-DIRECTIVES-001.3",
    "V8-DIRECTIVES-001.4",
    "V8-DIRECTIVES-001.5",
    "V8-RSI-IGNITION-001",
    "V8-RSI-IGNITION-002",
    "V8-RSI-IGNITION-003",
    "V8-RSI-IGNITION-004",
    "V8-ORGANISM-001.1",
    "V8-ORGANISM-001.2",
    "V8-ORGANISM-001.3",
    "V8-ORGANISM-001.4",
    "V8-ORGANISM-001.5",
    "V8-ORGANISM-001.6",
    "V8-ORGANISM-001.7",
    "V8-ORGANISM-001.8",
    "V8-NETWORK-002.1",
    "V8-NETWORK-002.2",
    "V8-NETWORK-002.3",
    "V8-NETWORK-002.4",
    "V8-NETWORK-002.5",
    "V8-CLIENT-003.1",
    "V8-CLIENT-003.2",
    "V8-CLIENT-003.3",
    "V8-CLIENT-003.4",
    "V8-CLIENT-003.5",
];

#[test]
fn v8_runtime_proof_registry_is_non_empty() {
    assert!(V8_PROOF_IDS.len() >= 30);
}

fn core_state_root(root: &Path) -> PathBuf {
    root.join("core").join("local").join("state")
}

fn latest(scope: &str, root: &Path) -> Value {
    let path = core_state_root(root)
        .join("ops")
        .join(scope)
        .join("latest.json");
    let raw = fs::read_to_string(path).expect("latest json");
    serde_json::from_str(&raw).expect("latest parse")
}

fn allow(root: &Path, directive: &str) {
    std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "test-sign-key");
    std::env::set_var("BINARY_BLOB_VAULT_SIGNING_KEY", "blob-test-sign-key");
    let exit = directive_kernel::run(
        root,
        &[
            "prime-sign".to_string(),
            format!("--directive={directive}"),
            "--signer=tester".to_string(),
        ],
    );
    assert_eq!(exit, 0);
}

#[test]
fn directive_and_blob_policy_hash_binding_is_runtime_enforced() {
    let _guard = env_guard();
    let root = temp_root("directive_blob");
    allow(&root, "allow:blob:*");
    allow(&root, "allow:blob_mutate");
    let module_path = root.join("demo_module.rs");
    fs::write(&module_path, "pub fn v() -> u64 { 42 }\n").expect("write module");
    assert_eq!(
        binary_blob_runtime::run(
            &root,
            &[
                "settle".to_string(),
                "--module=demo".to_string(),
                format!("--module-path={}", module_path.display()),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        binary_blob_runtime::run(&root, &["load".to_string(), "--module=demo".to_string()]),
        0
    );
    assert_eq!(
        binary_blob_runtime::run(&root, &["vault-status".to_string()]),
        0
    );

    // Policy changed after settle => load must fail closed.
    allow(&root, "deny:blob_mutate");
    assert_eq!(
        binary_blob_runtime::run(&root, &["load".to_string(), "--module=demo".to_string()]),
        2
    );
    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    std::env::remove_var("BINARY_BLOB_VAULT_SIGNING_KEY");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn network_protocol_emits_state_roots_and_enforces_strict_zk_verification() {
    let _guard = env_guard();
    let root = temp_root("network");
    allow(&root, "allow:tokenomics");
    assert_eq!(
        network_protocol::run(
            &root,
            &[
                "stake".to_string(),
                "--action=reward".to_string(),
                "--agent=shadow:alpha".to_string(),
                "--amount=25".to_string(),
                "--reason=tokenomics".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        network_protocol::run(
            &root,
            &[
                "merkle-root".to_string(),
                "--account=shadow:alpha".to_string(),
                "--proof=1".to_string(),
            ],
        ),
        0
    );
    let merkle_latest = latest("network_protocol", &root);
    assert!(
        merkle_latest
            .get("global_merkle_root")
            .and_then(Value::as_str)
            .unwrap_or("")
            .len()
            > 8
    );
    assert_eq!(
        network_protocol::run(
            &root,
            &[
                "zk-claim".to_string(),
                "--claim-id=claim:test".to_string(),
                "--commitment=abc".to_string(),
                "--challenge=deadbeef".to_string(),
                "--public-input=p".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        2
    );
    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn intelligence_nexus_buy_credits_debits_nexus_balance() {
    let _guard = env_guard();
    let root = temp_root("nexus_buy");
    allow(&root, "allow:keys:add");
    allow(&root, "allow:credits:*");
    allow(&root, "allow:credits:status");
    allow(&root, "allow:credits:buy");
    allow(&root, "allow:tokenomics");
    std::env::set_var("INTELLIGENCE_NEXUS_VAULT_KEY", "vault-key");
    std::env::set_var("TEST_PROVIDER_KEY", "sk-test-abcdef0123456789");

    assert_eq!(
        intelligence_nexus::run(
            &root,
            &[
                "add-key".to_string(),
                "--provider=openai".to_string(),
                "--key-env=TEST_PROVIDER_KEY".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        intelligence_nexus::run(
            &root,
            &[
                "credits-status".to_string(),
                "--provider=openai".to_string(),
                "--credits=100".to_string(),
                "--burn-rate-per-day=10".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        intelligence_nexus::run(&root, &["workspace-view".to_string()]),
        0
    );
    assert_eq!(
        network_protocol::run(
            &root,
            &[
                "reward".to_string(),
                "--action=reward".to_string(),
                "--agent=shadow:alpha".to_string(),
                "--amount=500".to_string(),
                "--reason=tokenomics".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        intelligence_nexus::run(
            &root,
            &[
                "buy-credits".to_string(),
                "--provider=openai".to_string(),
                "--amount=75".to_string(),
                "--rail=nexus".to_string(),
                "--actor=shadow:alpha".to_string(),
                "--spend-limit=100".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    let net_ledger_path = core_state_root(&root)
        .join("ops")
        .join("network_protocol")
        .join("ledger.json");
    let net_ledger: Value =
        serde_json::from_str(&fs::read_to_string(net_ledger_path).expect("net ledger"))
            .expect("json");
    let balance = net_ledger
        .get("balances")
        .and_then(Value::as_object)
        .and_then(|m| m.get("shadow:alpha"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    assert!((balance - 425.0).abs() < f64::EPSILON);

    std::env::remove_var("TEST_PROVIDER_KEY");
    std::env::remove_var("INTELLIGENCE_NEXUS_VAULT_KEY");
    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    std::env::remove_var("BINARY_BLOB_VAULT_SIGNING_KEY");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rsi_and_organism_mutation_paths_execute_with_runtime_state_changes() {
    let _guard = env_guard();
    let root = temp_root("organism_rsi");
    allow(&root, "allow:rsi:ignite");
    allow(&root, "allow:rsi:evolve");
    allow(&root, "allow:rsi:swarm");
    allow(&root, "allow:blob:mutate");
    allow(&root, "allow:blob_mutate");
    allow(&root, "allow:organism:ignite");
    allow(&root, "allow:organism:dream");
    allow(&root, "allow:organism:homeostasis");
    allow(&root, "allow:organism:crystallize");
    allow(&root, "allow:organism:symbiosis");
    allow(&root, "allow:organism:mutate");
    allow(&root, "allow:organism:sensory");
    allow(&root, "allow:organism:narrative");

    assert_eq!(
        organism_layer::run(&root, &["ignite".to_string(), "--apply=1".to_string()]),
        0
    );
    assert_eq!(
        organism_layer::run(
            &root,
            &[
                "dream".to_string(),
                "--idle-hours=8".to_string(),
                "--experiments=5".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        organism_layer::run(
            &root,
            &[
                "homeostasis".to_string(),
                "--apply=1".to_string(),
                "--coherence=0.77".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        organism_layer::run(
            &root,
            &[
                "crystallize".to_string(),
                "--persona=default".to_string(),
                "--delta=more playful but precise".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        organism_layer::run(
            &root,
            &[
                "symbiosis".to_string(),
                "--nodes=9".to_string(),
                "--memory-share=0.61".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        organism_layer::run(
            &root,
            &[
                "sensory".to_string(),
                "--pain=0.2".to_string(),
                "--pleasure=0.8".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        organism_layer::run(
            &root,
            &[
                "narrative".to_string(),
                "--summary=Today I became 0.7% more coherent.".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        organism_layer::run(
            &root,
            &[
                "mutate".to_string(),
                "--proposal=try cache-compaction mutation".to_string(),
                "--module=conduit".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );

    let organism_state_path = core_state_root(&root)
        .join("ops")
        .join("organism_layer")
        .join("organism_state.json");
    let organism_state: Value =
        serde_json::from_str(&fs::read_to_string(organism_state_path).expect("organism state"))
            .expect("json");
    assert_eq!(
        organism_state.get("active").and_then(Value::as_bool),
        Some(true)
    );
    let dream_rows = fs::read_to_string(
        core_state_root(&root)
            .join("ops")
            .join("organism_layer")
            .join("dream_log.jsonl"),
    )
    .expect("dream log")
    .lines()
    .count();
    let narrative_rows = fs::read_to_string(
        core_state_root(&root)
            .join("ops")
            .join("organism_layer")
            .join("narrative_log.jsonl"),
    )
    .expect("narrative log")
    .lines()
    .count();
    assert!(dream_rows >= 1);
    assert!(narrative_rows >= 1);

    let rsi_loop_path = core_state_root(&root)
        .join("ops")
        .join("rsi_ignition")
        .join("loop_state.json");
    let rsi_loop: Value =
        serde_json::from_str(&fs::read_to_string(rsi_loop_path).expect("rsi loop")).expect("json");
    assert!(
        rsi_loop
            .get("proactive_evolution_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            >= 1
    );

    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    std::env::remove_var("BINARY_BLOB_VAULT_SIGNING_KEY");
    let _ = fs::remove_dir_all(root);
}
