// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::finance_plane;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("finance_plane")
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
fn v7_bank_001_1_to_001_10_runtime_contracts_proven() {
    let root = tempfile::tempdir().expect("tempdir");
    let root_path = root.path();

    let tx_exit = finance_plane::run(
        root_path,
        &[
            "transaction".to_string(),
            "--op=post".to_string(),
            "--tx-id=tx1".to_string(),
            "--amount=1250.75".to_string(),
            "--currency=USD".to_string(),
            "--debit=acct_cash".to_string(),
            "--credit=acct_sales".to_string(),
            "--rail=ach".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(tx_exit, 0);
    let tx_latest = read_json(&latest_path(root_path));
    assert_claim(&tx_latest, "V7-BANK-001.1");

    let model_register = finance_plane::run(
        root_path,
        &[
            "model-governance".to_string(),
            "--op=register".to_string(),
            "--model-id=loan_default".to_string(),
            "--version=v3".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(model_register, 0);
    let model_validate = finance_plane::run(
        root_path,
        &[
            "model-governance".to_string(),
            "--op=validate".to_string(),
            "--model-id=loan_default".to_string(),
            "--version=v3".to_string(),
            "--evidence-json={\"auc\":0.82}".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(model_validate, 0);
    let model_latest = read_json(&latest_path(root_path));
    assert_claim(&model_latest, "V7-BANK-001.2");

    let aml_exit = finance_plane::run(
        root_path,
        &[
            "aml".to_string(),
            "--op=monitor".to_string(),
            "--customer=c1".to_string(),
            "--amount=10500".to_string(),
            "--jurisdiction=high-risk-eu".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(aml_exit, 0);
    let aml_latest = read_json(&latest_path(root_path));
    assert_claim(&aml_latest, "V7-BANK-001.3");

    let kyc_exit = finance_plane::run(
        root_path,
        &[
            "kyc".to_string(),
            "--op=onboard".to_string(),
            "--customer=c1".to_string(),
            "--risk=high".to_string(),
            "--pii-json={\"name\":\"Jane Doe\",\"dob\":\"1990-01-01\"}".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(kyc_exit, 0);
    let kyc_latest = read_json(&latest_path(root_path));
    assert_claim(&kyc_latest, "V7-BANK-001.4");

    let eye_exit = finance_plane::run(
        root_path,
        &[
            "finance-eye".to_string(),
            "--op=ingest".to_string(),
            "--symbol=BTCUSD".to_string(),
            "--price=72000".to_string(),
            "--position=0.5".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(eye_exit, 0);
    let eye_latest = read_json(&latest_path(root_path));
    assert_claim(&eye_latest, "V7-BANK-001.5");

    let risk_exit = finance_plane::run(
        root_path,
        &[
            "risk-warehouse".to_string(),
            "--op=aggregate".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(risk_exit, 0);
    let risk_latest = read_json(&latest_path(root_path));
    assert_claim(&risk_latest, "V7-BANK-001.6");

    let wallet_create = finance_plane::run(
        root_path,
        &[
            "custody".to_string(),
            "--op=create-wallet".to_string(),
            "--wallet=hot-main".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(wallet_create, 0);
    let custody_latest = read_json(&latest_path(root_path));
    assert_claim(&custody_latest, "V7-BANK-001.7");

    let zt_issue = finance_plane::run(
        root_path,
        &[
            "zero-trust".to_string(),
            "--op=issue-grant".to_string(),
            "--principal=svc-risk".to_string(),
            "--service=risk-api".to_string(),
            "--mtls-fingerprint=abc123".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(zt_issue, 0);
    let zt_verify = finance_plane::run(
        root_path,
        &[
            "zero-trust".to_string(),
            "--op=verify".to_string(),
            "--principal=svc-risk".to_string(),
            "--service=risk-api".to_string(),
            "--mtls-fingerprint=abc123".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(zt_verify, 0);
    let zt_latest = read_json(&latest_path(root_path));
    assert_claim(&zt_latest, "V7-BANK-001.8");

    let az_a = finance_plane::run(
        root_path,
        &[
            "availability".to_string(),
            "--op=register-zone".to_string(),
            "--zone=az-a".to_string(),
            "--state=ACTIVE".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(az_a, 0);
    let az_b = finance_plane::run(
        root_path,
        &[
            "availability".to_string(),
            "--op=register-zone".to_string(),
            "--zone=az-b".to_string(),
            "--state=STANDBY".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(az_b, 0);
    let failover = finance_plane::run(
        root_path,
        &[
            "availability".to_string(),
            "--op=failover".to_string(),
            "--target-zone=az-b".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(failover, 0);
    let az_latest = read_json(&latest_path(root_path));
    assert_claim(&az_latest, "V7-BANK-001.9");

    let report_exit = finance_plane::run(
        root_path,
        &[
            "regulatory-report".to_string(),
            "--op=generate".to_string(),
            "--report=SAR".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(report_exit, 0);
    let report_latest = read_json(&latest_path(root_path));
    assert_claim(&report_latest, "V7-BANK-001.10");

    let bypass_exit = finance_plane::run(
        root_path,
        &[
            "transaction".to_string(),
            "--op=status".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(bypass_exit, 1, "bypass must fail closed");
}
