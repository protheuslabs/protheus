use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_root(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("protheus_rsi_ignition_{name}_{nonce}"));
    fs::create_dir_all(&root).expect("mkdir");
    root
}

fn allow(root: &Path, directive: &str) {
    std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "test-sign-key");
    assert_eq!(
        crate::directive_kernel::run(
            root,
            &[
                "prime-sign".to_string(),
                format!("--directive={directive}"),
                "--signer=tester".to_string(),
            ]
        ),
        0
    );
}

#[test]
fn ignite_requires_directive_gate() {
    let root = temp_root("gate");
    let exit = run(
        &root,
        &[
            "ignite".to_string(),
            "--proposal=unsafe".to_string(),
            "--apply=1".to_string(),
        ],
    );
    assert_eq!(exit, 2);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn ignite_mutates_when_allowed() {
    let root = temp_root("allowed");
    allow(&root, "allow:rsi:ignite");
    allow(&root, "allow:blob:mutate");
    allow(&root, "allow:blob_mutate");
    let exit = run(
        &root,
        &[
            "ignite".to_string(),
            "--proposal=safe".to_string(),
            "--module=conduit".to_string(),
            "--apply=1".to_string(),
            "--canary-pass=1".to_string(),
            "--sim-regression=0.001".to_string(),
        ],
    );
    assert_eq!(exit, 0);
    let state = read_json(&loop_state_path(&root)).expect("state");
    assert!(
        state
            .get("merge_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            >= 1
    );
    let latest = read_json(&latest_path(&root)).expect("latest");
    assert_eq!(
        latest
            .get("token_reward")
            .and_then(|v| v.get("attempted"))
            .and_then(Value::as_bool),
        Some(false)
    );
    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn swarm_skips_reward_when_tokenomics_gate_missing() {
    let root = temp_root("swarm_no_tokenomics");
    allow(&root, "allow:rsi:swarm");
    let exit = run(
        &root,
        &[
            "swarm".to_string(),
            "--nodes=5".to_string(),
            "--share-rate=0.5".to_string(),
            "--apply=1".to_string(),
        ],
    );
    assert_eq!(exit, 0);
    let latest = read_json(&latest_path(&root)).expect("latest");
    assert_eq!(
        latest
            .get("swarm_reward")
            .and_then(|v| v.get("attempted"))
            .and_then(Value::as_bool),
        Some(false)
    );
    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn evolve_apply_writes_proactive_state() {
    let root = temp_root("evolve");
    allow(&root, "allow:rsi:evolve");
    let exit = run(
        &root,
        &[
            "evolve".to_string(),
            "--insight=more stable route".to_string(),
            "--module=conduit".to_string(),
            "--apply=1".to_string(),
            "--ignite-apply=0".to_string(),
        ],
    );
    assert_eq!(exit, 0);
    let state = read_json(&loop_state_path(&root)).expect("state");
    assert!(
        state
            .get("proactive_evolution_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            >= 1
    );
    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    let _ = fs::remove_dir_all(root);
}
