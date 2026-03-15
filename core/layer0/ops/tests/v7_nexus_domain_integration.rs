// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::nexus_plane;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("nexus_plane")
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
fn v7_nexus_001_1_to_001_7_runtime_contracts_proven() {
    let root = tempfile::tempdir().expect("tempdir");
    let root_path = root.path();

    let package_exit = nexus_plane::run(
        root_path,
        &[
            "package-domain".to_string(),
            "--domain=finance".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(package_exit, 0);
    let package_latest = read_json(&latest_path(root_path));
    assert_claim(&package_latest, "V7-NEXUS-001.1");

    let bridge_exit = nexus_plane::run(
        root_path,
        &[
            "bridge".to_string(),
            "--from-domain=finance".to_string(),
            "--to-domain=government".to_string(),
            "--payload-json={\"event\":\"payment\"}".to_string(),
            "--legal-contract-id=contract-77".to_string(),
            "--sanitize=1".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(bridge_exit, 0);
    let bridge_latest = read_json(&latest_path(root_path));
    assert_claim(&bridge_latest, "V7-NEXUS-001.2");

    let insurance_exit = nexus_plane::run(
        root_path,
        &[
            "insurance".to_string(),
            "--op=quote".to_string(),
            "--risk-json={\"risk_score\":0.3,\"compliance_score\":0.9}".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(insurance_exit, 0);
    let insurance_latest = read_json(&latest_path(root_path));
    assert_claim(&insurance_latest, "V7-NEXUS-001.3");

    let human_exit = nexus_plane::run(
        root_path,
        &[
            "human-boundary".to_string(),
            "--op=authorize".to_string(),
            "--action=deploy_critical".to_string(),
            "--human-a=SIG_A".to_string(),
            "--human-b=SIG_B".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(human_exit, 0);
    let human_latest = read_json(&latest_path(root_path));
    assert_claim(&human_latest, "V7-NEXUS-001.4");

    let receipt_v2_exit = nexus_plane::run(
        root_path,
        &[
            "receipt-v2".to_string(),
            "--op=validate".to_string(),
            "--receipt-json={\"domain\":\"finance\",\"classifications\":[\"CUI\"],\"authorization\":{\"principal\":\"u\"},\"compliance\":{\"controls\":[\"x\"]},\"insurance\":{\"coverage\":\"approved\"}}".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(receipt_v2_exit, 0);
    let receipt_latest = read_json(&latest_path(root_path));
    assert_claim(&receipt_latest, "V7-NEXUS-001.5");

    let merkle_exit = nexus_plane::run(
        root_path,
        &[
            "merkle-forest".to_string(),
            "--op=build".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(merkle_exit, 0);
    let merkle_latest = read_json(&latest_path(root_path));
    assert_claim(&merkle_latest, "V7-NEXUS-001.6");

    let ledger_append = nexus_plane::run(
        root_path,
        &[
            "compliance-ledger".to_string(),
            "--op=append".to_string(),
            "--chain-id=chain-1".to_string(),
            "--entry-json={\"from\":\"finance\",\"to\":\"government\",\"result\":\"ok\"}"
                .to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(ledger_append, 0);
    let ledger_latest = read_json(&latest_path(root_path));
    assert_claim(&ledger_latest, "V7-NEXUS-001.7");

    let bypass_exit = nexus_plane::run(
        root_path,
        &[
            "bridge".to_string(),
            "--from-domain=finance".to_string(),
            "--to-domain=government".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(bypass_exit, 1, "bypass must fail closed");
}
