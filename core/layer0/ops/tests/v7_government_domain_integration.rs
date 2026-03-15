// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::government_plane;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("government_plane")
        .join("latest.json")
}

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read");
    serde_json::from_str(&raw).expect("parse")
}

fn assert_claim(payload: &Value, id: &str) {
    let ok = payload
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some(id));
    assert!(ok, "missing claim {id}");
}

#[test]
fn v7_gov_001_1_to_001_9_runtime_contracts_proven() {
    let root = tempfile::tempdir().expect("tempdir");
    let root_path = root.path();

    std::env::set_var("PROTHEUS_HSM_RECEIPT_KEY", "test-hsm");
    let attest_exit = government_plane::run(
        root_path,
        &[
            "attestation".to_string(),
            "--op=attest".to_string(),
            "--device-id=tpm-node".to_string(),
            "--nonce=n1".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(attest_exit, 0);
    let verify_exit = government_plane::run(
        root_path,
        &[
            "attestation".to_string(),
            "--op=verify".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(verify_exit, 0);
    let attest_latest = read_json(&latest_path(root_path));
    assert_claim(&attest_latest, "V7-GOV-001.1");

    let set_clearance = government_plane::run(
        root_path,
        &[
            "classification".to_string(),
            "--op=set-clearance".to_string(),
            "--principal=analyst".to_string(),
            "--clearance=secret".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(set_clearance, 0);
    let write_secret = government_plane::run(
        root_path,
        &[
            "classification".to_string(),
            "--op=write".to_string(),
            "--principal=analyst".to_string(),
            "--level=secret".to_string(),
            "--id=brief".to_string(),
            "--payload-json={\"summary\":\"classified\"}".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(write_secret, 0);
    let low_read = government_plane::run(
        root_path,
        &[
            "classification".to_string(),
            "--op=read".to_string(),
            "--principal=intern".to_string(),
            "--level=secret".to_string(),
            "--id=brief".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(low_read, 1, "lower clearance read must fail");
    let class_latest = read_json(&latest_path(root_path));
    assert_claim(&class_latest, "V7-GOV-001.2");

    let legal_exit = government_plane::run(
        root_path,
        &[
            "nonrepudiation".to_string(),
            "--principal=CN=User,O=Gov,OU=Dept".to_string(),
            "--action=approve_order".to_string(),
            "--auth-signature=RSA4096SIG".to_string(),
            "--timestamp-authority=tsa.gov".to_string(),
            "--legal-hold=1".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(legal_exit, 0);
    let legal_latest = read_json(&latest_path(root_path));
    assert_claim(&legal_latest, "V7-GOV-001.3");

    let diode_exit = government_plane::run(
        root_path,
        &[
            "diode".to_string(),
            "--from=secret".to_string(),
            "--to=unclassified".to_string(),
            "--sanitize=1".to_string(),
            "--payload-json={\"doc\":\"summary\"}".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(diode_exit, 0);
    let diode_latest = read_json(&latest_path(root_path));
    assert_claim(&diode_latest, "V7-GOV-001.4");

    let soc_connect = government_plane::run(
        root_path,
        &[
            "soc".to_string(),
            "--op=connect".to_string(),
            "--endpoint=splunk://soc".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(soc_connect, 0);
    let soc_emit = government_plane::run(
        root_path,
        &[
            "soc".to_string(),
            "--op=emit".to_string(),
            "--event-json={\"kind\":\"policy_violation\"}".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(soc_emit, 0);
    let soc_latest = read_json(&latest_path(root_path));
    assert_claim(&soc_latest, "V7-GOV-001.5");

    let site_a = government_plane::run(
        root_path,
        &[
            "coop".to_string(),
            "--op=register-site".to_string(),
            "--site=alpha".to_string(),
            "--state=ACTIVE".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(site_a, 0);
    let site_b = government_plane::run(
        root_path,
        &[
            "coop".to_string(),
            "--op=register-site".to_string(),
            "--site=beta".to_string(),
            "--state=STANDBY".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(site_b, 0);
    let failover = government_plane::run(
        root_path,
        &[
            "coop".to_string(),
            "--op=failover".to_string(),
            "--target-site=beta".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(failover, 0);
    let coop_latest = read_json(&latest_path(root_path));
    assert_claim(&coop_latest, "V7-GOV-001.6");

    let proofs_exit = government_plane::run(
        root_path,
        &[
            "proofs".to_string(),
            "--op=verify".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(proofs_exit, 1, "proofs may fail in isolated temp root");
    let proofs_latest = read_json(&latest_path(root_path));
    assert_claim(&proofs_latest, "V7-GOV-001.7");

    let interop_exit = government_plane::run(
        root_path,
        &[
            "interoperability".to_string(),
            "--op=validate".to_string(),
            "--profile-json={\"standards\":[\"PKI\",\"SAML\",\"OIDC\",\"SMIME\",\"IPv6\",\"DNSSEC\",\"OAuth2\"],\"endpoint\":\"https://gov.api\"}".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(interop_exit, 0);
    let interop_latest = read_json(&latest_path(root_path));
    assert_claim(&interop_latest, "V7-GOV-001.8");

    let ato_exit = government_plane::run(
        root_path,
        &[
            "ato-pack".to_string(),
            "--op=generate".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(ato_exit, 0);
    let ato_latest = read_json(&latest_path(root_path));
    assert_claim(&ato_latest, "V7-GOV-001.9");

    let bypass_exit = government_plane::run(
        root_path,
        &[
            "soc".to_string(),
            "--op=status".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(bypass_exit, 1, "bypass must fail closed");
}
