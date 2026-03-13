// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{directive_kernel, enterprise_hardening, network_protocol, organism_layer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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

fn assert_claim(payload: &Value, claim_id: &str) {
    assert_eq!(
        payload
            .get("claim_evidence")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .any(|row| row.get("id").and_then(Value::as_str) == Some(claim_id))
            }),
        Some(true),
        "missing claim_evidence id={claim_id} payload={payload}"
    );
}

fn allow(root: &Path, directive: &str) {
    assert_eq!(
        directive_kernel::run(
            root,
            &[
                "prime-sign".to_string(),
                format!("--directive={directive}"),
                "--signer=batch25".to_string(),
            ],
        ),
        0
    );
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("mkdir");
    }
    fs::write(
        path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(value).expect("encode policy")
        ),
    )
    .expect("write json");
}

#[test]
fn v8_batch25_organism_network_and_enterprise_contracts_are_behavior_proven() {
    let _guard = env_guard();
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();

    std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "batch25-signing-key");
    std::env::set_var("ORGANISM_CRYSTAL_SIGNING_KEY", "batch25-crystal-key");

    allow(root, "allow:organism:ignite");
    allow(root, "allow:organism:sensory");
    allow(root, "allow:organism:narrative");
    allow(root, "allow:tokenomics");

    assert_eq!(
        organism_layer::run(
            root,
            &[
                "ignite".to_string(),
                "--apply=1".to_string(),
                "--idle-hours=7".to_string(),
                "--experiments=5".to_string(),
            ],
        ),
        0
    );
    assert_claim(&latest("organism_layer", root), "V8-ORGANISM-001.8");

    assert_eq!(
        organism_layer::run(
            root,
            &[
                "sensory".to_string(),
                "--pain=0.32".to_string(),
                "--pleasure=0.61".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_claim(&latest("organism_layer", root), "V8-ORGANISM-001.6");

    assert_eq!(
        organism_layer::run(
            root,
            &[
                "narrative".to_string(),
                "--summary=Today I became 0.7% more coherent.".to_string(),
                "--coherence=0.807".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_claim(&latest("organism_layer", root), "V8-ORGANISM-001.7");

    assert_eq!(
        network_protocol::run(
            root,
            &[
                "ignite-bitcoin".to_string(),
                "--seed=batch25".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_claim(
        &latest("network_protocol", root),
        "V8-NETWORK-002.5",
    );

    assert_eq!(
        network_protocol::run(
            root,
            &[
                "stake".to_string(),
                "--action=reward".to_string(),
                "--agent=shadow:alpha".to_string(),
                "--amount=25".to_string(),
                "--reason=useful_intelligence".to_string(),
            ],
        ),
        0
    );
    assert_claim(
        &latest("network_protocol", root),
        "V8-NETWORK-002.1",
    );

    assert_eq!(
        network_protocol::run(
            root,
            &[
                "merkle-root".to_string(),
                "--account=shadow:alpha".to_string(),
                "--proof=1".to_string(),
            ],
        ),
        0
    );
    assert_claim(
        &latest("network_protocol", root),
        "V8-NETWORK-002.2",
    );

    assert_eq!(
        network_protocol::run(
            root,
            &[
                "emission".to_string(),
                "--height=210000".to_string(),
                "--halving-interval=210000".to_string(),
                "--initial-issuance=50".to_string(),
            ],
        ),
        0
    );
    assert_claim(
        &latest("network_protocol", root),
        "V8-NETWORK-002.3",
    );

    let commitment = "abcd1234";
    let public_input = "directive-compliant";
    let challenge = sha256_hex(&format!("{commitment}:{public_input}"));
    assert_eq!(
        network_protocol::run(
            root,
            &[
                "zk-claim".to_string(),
                "--claim-id=claim:batch25".to_string(),
                format!("--commitment={commitment}"),
                format!("--challenge={challenge}"),
                format!("--public-input={public_input}"),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    assert_claim(
        &latest("network_protocol", root),
        "V8-NETWORK-002.4",
    );

    assert_eq!(network_protocol::run(root, &["dashboard".to_string()]), 0);
    assert_claim(
        &latest("network_protocol", root),
        "V8-NETWORK-002.5",
    );

    write_json(
        &root.join("client/runtime/config/enterprise_controls_policy.json"),
        &json!({
            "controls": [
                {
                    "id": "ent_control_01",
                    "title": "SRS exists",
                    "type": "path_exists",
                    "path": "client/runtime/config/enterprise_controls_policy.json"
                }
            ]
        }),
    );
    write_json(
        &root.join("client/runtime/config/identity_federation_policy.json"),
        &json!({
            "providers": {
                "okta": {
                    "issuer_prefix": "https://okta.example.com/",
                    "allowed_scopes": ["openid", "profile", "protheus.read"],
                    "allowed_roles": ["operator", "admin"],
                    "scim_enabled": true
                }
            }
        }),
    );
    write_json(
        &root.join("client/runtime/config/enterprise_access_policy.json"),
        &json!({
            "operations": {
                "deploy.release": { "allowed_roles": ["operator"], "require_mfa": true, "tenant_scoped": true }
            }
        }),
    );
    write_json(
        &root.join("client/runtime/config/abac_policy_plane.json"),
        &json!({
            "policies": [
                { "id": "abac-1", "subject": "role:operator", "action": "deploy", "resource": "release:*", "effect": "allow" }
            ]
        }),
    );
    write_json(
        &root.join("client/runtime/config/siem_bridge_policy.json"),
        &json!({
            "latest_export_path": "state/observability/siem_bridge/latest_export.json"
        }),
    );
    write_json(
        &root.join("client/runtime/config/scale_readiness_program_policy.json"),
        &json!({
            "budgets": {
                "max_cost_per_user_usd": 0.50,
                "max_p95_latency_ms": 20.0,
                "max_p99_latency_ms": 40.0
            }
        }),
    );

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "export-compliance".to_string(),
                "--profile=auditor".to_string(),
                "--strict=1".to_string(),
                "--policy=client/runtime/config/enterprise_controls_policy.json".to_string(),
            ],
        ),
        0
    );
    let enterprise_latest = latest("enterprise_hardening", root);
    assert_claim(&enterprise_latest, "V7-ENTERPRISE-001.1");
    let bundle_path = enterprise_latest
        .get("bundle_path")
        .and_then(Value::as_str)
        .expect("bundle path");
    assert!(root.join(bundle_path).exists());

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "identity-surface".to_string(),
                "--provider=okta".to_string(),
                "--token-issuer=https://okta.example.com/issuer".to_string(),
                "--scopes=openid,profile,protheus.read".to_string(),
                "--roles=operator".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    assert_claim(&latest("enterprise_hardening", root), "V7-ENTERPRISE-001.2");

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "certify-scale".to_string(),
                "--target-nodes=2048".to_string(),
                "--samples=40".to_string(),
                "--strict=1".to_string(),
                "--scale-policy=client/runtime/config/scale_readiness_program_policy.json"
                    .to_string(),
            ],
        ),
        1
    );
    let strict_fail_latest = latest("enterprise_hardening", root);
    assert_eq!(
        strict_fail_latest.get("ok").and_then(Value::as_bool),
        Some(false)
    );
    let strict_errors = strict_fail_latest
        .get("errors")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    assert!(
        strict_errors
            .iter()
            .any(|row| row == "strict_target_nodes_below_10000"),
        "strict certify-scale should enforce 10k target minimum"
    );

    assert_eq!(
        enterprise_hardening::run(
            root,
            &[
                "certify-scale".to_string(),
                "--target-nodes=10000".to_string(),
                "--samples=80".to_string(),
                "--strict=1".to_string(),
                "--scale-policy=client/runtime/config/scale_readiness_program_policy.json"
                    .to_string(),
            ],
        ),
        0
    );
    let latest = latest("enterprise_hardening", root);
    assert_claim(&latest, "V7-ENTERPRISE-001.3");
    let cert_path = latest
        .get("certificate_path")
        .and_then(Value::as_str)
        .expect("cert path");
    assert!(root.join(cert_path).exists());
    let whitepaper_path = latest
        .get("whitepaper_path")
        .and_then(Value::as_str)
        .expect("whitepaper path");
    assert!(root.join(whitepaper_path).exists());

    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    std::env::remove_var("ORGANISM_CRYSTAL_SIGNING_KEY");
}
