// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{directive_kernel, network_protocol};
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

fn latest(root: &Path) -> Value {
    let path = root
        .join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("network_protocol")
        .join("latest.json");
    let raw = fs::read_to_string(path).expect("read latest");
    serde_json::from_str(&raw).expect("decode latest")
}

fn assert_claim(payload: &Value, claim_id: &str) {
    let ok = payload
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some(claim_id));
    assert!(ok, "missing claim {claim_id} payload={payload}");
}

fn allow(root: &Path, directive: &str) {
    assert_eq!(
        directive_kernel::run(
            root,
            &[
                "prime-sign".to_string(),
                format!("--directive={directive}"),
                "--signer=v7-network".to_string(),
            ],
        ),
        0
    );
}

#[test]
fn v7_network_001_1_to_001_4_are_behavior_proven() {
    let _guard = env_guard();
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();
    std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "v7-network-signing-key");

    allow(root, "allow:tokenomics");
    allow(root, "allow:network-rsi");

    assert_eq!(
        network_protocol::run(
            root,
            &[
                "contribution".to_string(),
                "--agent=shadow:alpha".to_string(),
                "--contribution-type=breakthrough".to_string(),
                "--score=0.88".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    let contribution = latest(root);
    assert_eq!(
        contribution.get("type").and_then(Value::as_str),
        Some("network_protocol_contribution")
    );
    assert_claim(&contribution, "V7-NETWORK-001.1");
    assert!(contribution
        .pointer("/event/reward")
        .and_then(Value::as_f64)
        .map(|v| v > 0.0)
        .unwrap_or(false));

    assert_eq!(
        network_protocol::run(
            root,
            &[
                "consensus".to_string(),
                "--op=append".to_string(),
                "--receipt-hash=aaa111".to_string(),
                "--causality-hash=bbb222".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        network_protocol::run(
            root,
            &[
                "consensus".to_string(),
                "--op=append".to_string(),
                "--receipt-hash=ccc333".to_string(),
                "--causality-hash=ddd444".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    let consensus_ok = latest(root);
    assert_eq!(
        consensus_ok.get("type").and_then(Value::as_str),
        Some("network_protocol_consensus")
    );
    assert_claim(&consensus_ok, "V7-NETWORK-001.2");

    let consensus_path = root
        .join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("network_protocol")
        .join("consensus_ledger.jsonl");
    let raw = fs::read_to_string(&consensus_path).expect("read consensus");
    let mut rows = raw
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("row"))
        .collect::<Vec<_>>();
    rows[1]["previous_hash"] = Value::String("tampered".to_string());
    let body = rows
        .iter()
        .map(|row| serde_json::to_string(row).expect("encode row"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(&consensus_path, body).expect("write tampered consensus");
    assert_eq!(
        network_protocol::run(
            root,
            &[
                "consensus".to_string(),
                "--op=verify".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        2
    );
    let consensus_bad = latest(root);
    assert_eq!(consensus_bad.get("ok").and_then(Value::as_bool), Some(false));
    assert_claim(&consensus_bad, "V7-NETWORK-001.2");

    assert_eq!(
        network_protocol::run(
            root,
            &[
                "rsi-boundary".to_string(),
                "--stage=growth".to_string(),
                "--action=promote".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        2
    );
    let rsi_denied = latest(root);
    assert_eq!(rsi_denied.get("ok").and_then(Value::as_bool), Some(false));
    assert_claim(&rsi_denied, "V7-NETWORK-001.3");

    assert_eq!(
        network_protocol::run(
            root,
            &[
                "rsi-boundary".to_string(),
                "--stage=growth".to_string(),
                "--action=promote".to_string(),
                "--oversight-approval=1".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    let rsi_allowed = latest(root);
    assert_eq!(rsi_allowed.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&rsi_allowed, "V7-NETWORK-001.3");

    assert_eq!(
        network_protocol::run(
            root,
            &[
                "join-hyperspace".to_string(),
                "--node=alpha".to_string(),
                "--admission-token=alpha-token-123".to_string(),
                "--stake=42".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    let joined = latest(root);
    assert_claim(&joined, "V7-NETWORK-001.4");

    assert_eq!(
        network_protocol::run(
            root,
            &[
                "governance-vote".to_string(),
                "--proposal=prop-1".to_string(),
                "--voter=alpha".to_string(),
                "--vote=approve".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    let voted = latest(root);
    assert_eq!(
        voted.get("type").and_then(Value::as_str),
        Some("network_protocol_governance_vote")
    );
    assert_claim(&voted, "V7-NETWORK-001.4");

    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
}
