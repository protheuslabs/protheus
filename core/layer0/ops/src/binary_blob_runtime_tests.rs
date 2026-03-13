use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_root(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("protheus_blob_runtime_{name}_{nonce}"));
    fs::create_dir_all(&root).expect("mkdir");
    root
}

fn allow(root: &Path, directive: &str) {
    std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "test-sign-key");
    std::env::set_var("BINARY_BLOB_VAULT_SIGNING_KEY", "blob-test-sign-key");
    let exit = crate::directive_kernel::run(
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
fn settle_writes_blob_and_load_verifies_hashes() {
    std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "test-sign-key");
    let root = temp_root("settle");
    allow(&root, "allow:blob:*");
    allow(&root, "allow:blob_mutate");

    let module_path = root.join("module.rs");
    fs::write(&module_path, "fn a() { 1 + 1; }\n").expect("write");
    assert_eq!(
        run(
            &root,
            &[
                "settle".to_string(),
                "--module=demo".to_string(),
                format!("--module-path={}", module_path.display()),
                "--mode=modular".to_string(),
                "--apply=1".to_string()
            ]
        ),
        0
    );

    assert_eq!(
        run(&root, &["load".to_string(), "--module=demo".to_string()]),
        0
    );
    assert_eq!(run(&root, &["vault-status".to_string()]), 0);
    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    std::env::remove_var("BINARY_BLOB_VAULT_SIGNING_KEY");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn load_fails_when_blob_is_tampered() {
    std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "test-sign-key");
    let root = temp_root("tamper");
    allow(&root, "allow:blob:*");
    allow(&root, "allow:blob_mutate");
    let module_path = root.join("module.rs");
    fs::write(&module_path, "fn trusted() -> u64 { 7 }\n").expect("write");
    assert_eq!(
        run(
            &root,
            &[
                "settle".to_string(),
                "--module=demo".to_string(),
                format!("--module-path={}", module_path.display()),
                "--apply=1".to_string()
            ]
        ),
        0
    );
    assert_eq!(
        run(&root, &["load".to_string(), "--module=demo".to_string()]),
        0
    );

    let active = load_active_map(&root);
    let blob_path = active
        .get("demo")
        .and_then(|v| v.get("blob_path"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .expect("blob path");
    fs::write(&blob_path, "tampered-by-test").expect("tamper");

    assert_eq!(
        run(&root, &["load".to_string(), "--module=demo".to_string()]),
        2
    );
    let latest = read_json(&crate::v8_kernel::latest_path(
        &root,
        STATE_ENV,
        STATE_SCOPE,
    ))
    .expect("latest");
    assert_eq!(
        latest.get("error").and_then(Value::as_str),
        Some("blob_hash_mismatch")
    );
    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    std::env::remove_var("BINARY_BLOB_VAULT_SIGNING_KEY");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn settle_is_fail_closed_when_directive_gate_denies() {
    std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "test-sign-key");
    let root = temp_root("gate_deny");
    // No allow:blob:settle rule on purpose.
    let module_path = root.join("module.rs");
    fs::write(&module_path, "fn gated() -> bool { true }\n").expect("write");
    assert_eq!(
        run(
            &root,
            &[
                "settle".to_string(),
                "--module=demo".to_string(),
                format!("--module-path={}", module_path.display()),
                "--apply=1".to_string()
            ]
        ),
        2
    );
    let latest = read_json(&crate::v8_kernel::latest_path(
        &root,
        STATE_ENV,
        STATE_SCOPE,
    ))
    .expect("latest");
    assert_eq!(
        latest.get("error").and_then(Value::as_str),
        Some("directive_gate_denied")
    );
    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    std::env::remove_var("BINARY_BLOB_VAULT_SIGNING_KEY");
    let _ = fs::remove_dir_all(root);
}
