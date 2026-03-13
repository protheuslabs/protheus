use super::*;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_root(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("protheus_intelligence_nexus_{name}_{nonce}"));
    fs::create_dir_all(&root).expect("mkdir");
    root
}

fn allow(root: &Path, directive: &str) {
    std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "test-sign-key");
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
fn add_key_does_not_persist_raw_secret() {
    let root = temp_root("add_key");
    allow(&root, "allow:keys:add");
    std::env::set_var(VAULT_KEY_ENV, "vault-secret");
    std::env::set_var("TEST_NEXUS_KEY", "sk-test-super-secret-key");
    let exit = run(
        &root,
        &[
            "add-key".to_string(),
            "--provider=openai".to_string(),
            "--key-env=TEST_NEXUS_KEY".to_string(),
        ],
    );
    assert_eq!(exit, 0);
    let ledger_raw = fs::read_to_string(ledger_path(&root)).expect("ledger");
    assert!(!ledger_raw.contains("sk-test-super-secret-key"));
    assert!(ledger_raw.contains("masked_key"));
    std::env::remove_var("TEST_NEXUS_KEY");
    std::env::remove_var(VAULT_KEY_ENV);
    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rotate_and_revoke_key_lifecycle_is_receipted() {
    let root = temp_root("rotate_revoke");
    allow(&root, "allow:keys:add");
    allow(&root, "allow:keys:rotate");
    allow(&root, "allow:keys:revoke");
    std::env::set_var(VAULT_KEY_ENV, "vault-secret");
    std::env::set_var("TEST_KEY_OLD", "sk-old-abcdef0123456789");
    std::env::set_var("TEST_KEY_NEW", "sk-new-abcdef0123456790");

    assert_eq!(
        run(
            &root,
            &[
                "add-key".to_string(),
                "--provider=openai".to_string(),
                "--key-env=TEST_KEY_OLD".to_string(),
            ],
        ),
        0
    );

    let before = read_json(&ledger_path(&root)).expect("ledger");
    let old_fingerprint = before
        .get("providers")
        .and_then(Value::as_object)
        .and_then(|m| m.get("openai"))
        .and_then(|v| v.get("fingerprint"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    assert!(!old_fingerprint.is_empty());

    assert_eq!(
        run(
            &root,
            &[
                "rotate-key".to_string(),
                "--provider=openai".to_string(),
                "--key-env=TEST_KEY_NEW".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );

    let after_rotate = read_json(&ledger_path(&root)).expect("ledger");
    let new_fingerprint = after_rotate
        .get("providers")
        .and_then(Value::as_object)
        .and_then(|m| m.get("openai"))
        .and_then(|v| v.get("fingerprint"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    assert_ne!(new_fingerprint, old_fingerprint);
    assert_eq!(
        after_rotate
            .get("providers")
            .and_then(Value::as_object)
            .and_then(|m| m.get("openai"))
            .and_then(|v| v.get("rotated_from"))
            .and_then(Value::as_str),
        Some(old_fingerprint.as_str())
    );

    assert_eq!(
        run(
            &root,
            &[
                "revoke-key".to_string(),
                "--provider=openai".to_string(),
                "--reason=rotation_complete".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );

    let after_revoke = read_json(&ledger_path(&root)).expect("ledger");
    assert!(after_revoke
        .get("providers")
        .and_then(Value::as_object)
        .and_then(|m| m.get("openai"))
        .is_none());
    let ledger_raw = fs::read_to_string(ledger_path(&root)).expect("ledger raw");
    assert!(!ledger_raw.contains("sk-old-abcdef0123456789"));
    assert!(!ledger_raw.contains("sk-new-abcdef0123456790"));
    let key_events = after_revoke
        .get("key_events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert!(key_events.len() >= 3);

    std::env::remove_var("TEST_KEY_OLD");
    std::env::remove_var("TEST_KEY_NEW");
    std::env::remove_var(VAULT_KEY_ENV);
    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn buy_credits_nexus_debits_network_balance() {
    let root = temp_root("buy_nexus");
    allow(&root, "allow:tokenomics");
    allow(&root, "allow:credits:buy");
    assert_eq!(
        crate::network_protocol::run(
            &root,
            &[
                "reward".to_string(),
                "--agent=shadow:alpha".to_string(),
                "--amount=500".to_string(),
                "--reason=tokenomics".to_string(),
            ]
        ),
        0
    );
    assert_eq!(
        run(
            &root,
            &[
                "buy-credits".to_string(),
                "--provider=openai".to_string(),
                "--amount=120".to_string(),
                "--rail=nexus".to_string(),
                "--actor=shadow:alpha".to_string(),
                "--spend-limit=200".to_string(),
                "--apply=1".to_string(),
            ]
        ),
        0
    );
    let net_ledger_path = crate::core_state_root(&root)
        .join("ops")
        .join("network_protocol")
        .join("ledger.json");
    let net = read_json(&net_ledger_path).expect("net");
    let bal = net
        .get("balances")
        .and_then(Value::as_object)
        .and_then(|m| m.get("shadow:alpha"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    assert!((bal - 380.0).abs() < f64::EPSILON);
    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn autobuy_apply_executes_purchase_when_below_threshold() {
    let root = temp_root("autobuy");
    allow(&root, "allow:tokenomics");
    allow(&root, "allow:credits:buy");
    assert_eq!(
        crate::network_protocol::run(
            &root,
            &[
                "reward".to_string(),
                "--agent=organism:global".to_string(),
                "--amount=600".to_string(),
                "--reason=tokenomics".to_string(),
            ]
        ),
        0
    );
    assert_eq!(
        run(
            &root,
            &[
                "autobuy-evaluate".to_string(),
                "--provider=anthropic".to_string(),
                "--current=40".to_string(),
                "--threshold=100".to_string(),
                "--refill=150".to_string(),
                "--daily-cap=300".to_string(),
                "--apply=1".to_string(),
            ]
        ),
        0
    );
    let ledger = read_json(&ledger_path(&root)).expect("ledger");
    let history = ledger
        .get("purchase_history")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert!(!history.is_empty());
    let last = ledger.get("last_autobuy").cloned().unwrap_or(Value::Null);
    assert_eq!(
        last.get("decision").and_then(Value::as_str),
        Some("buy_now")
    );
    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn workspace_view_emits_credit_health_cards_with_remaining_bars() {
    let root = temp_root("workspace_view");
    allow(&root, "allow:credits:*");
    assert_eq!(
        run(
            &root,
            &[
                "credits-status".to_string(),
                "--provider=openai".to_string(),
                "--credits=120".to_string(),
                "--burn-rate-per-day=20".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        run(
            &root,
            &[
                "credits-status".to_string(),
                "--provider=anthropic".to_string(),
                "--credits=10".to_string(),
                "--burn-rate-per-day=30".to_string(),
            ],
        ),
        0
    );
    assert_eq!(run(&root, &["workspace-view".to_string()]), 0);

    let latest = read_json(&latest_path(&root)).expect("latest");
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("intelligence_nexus_workspace_view")
    );
    let cards = latest
        .get("cards")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert!(cards.len() >= 2);
    assert!(cards.iter().all(|row| row
        .get("remaining_bar")
        .and_then(Value::as_str)
        .map(|bar| bar.len() == 20)
        .unwrap_or(false)));
    assert!(cards.iter().any(|row| {
        row.get("provider").and_then(Value::as_str) == Some("anthropic")
            && row.get("health").and_then(Value::as_str) == Some("critical")
    }));
    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    let _ = fs::remove_dir_all(root);
}
