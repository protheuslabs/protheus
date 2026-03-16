// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{business_plane, enterprise_hardening, nexus_plane, security_plane};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read json");
    serde_json::from_str(&raw).expect("parse json")
}

fn claim_present(payload: &Value, id: &str) -> bool {
    payload
        .get("claim_evidence")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter().any(|row| {
                row.get("id")
                    .and_then(Value::as_str)
                    .map(|value| value == id)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn latest_path(root: &Path, plane: &str) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join(plane)
        .join("latest.json")
}

#[test]
fn e2e_cross_plane_contract_flow_is_receipted_and_fail_closed() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path();

    let business_exit = business_plane::run(
        root,
        &[
            "taxonomy".to_string(),
            "--business-context=SUB_A".to_string(),
            "--topic=q2_launch".to_string(),
            "--tier=tag2".to_string(),
            "--interaction-count=22".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(business_exit, 0);
    let business_latest = read_json(&latest_path(root, "business_plane"));
    assert!(claim_present(&business_latest, "V7-BUSINESS-001.1"));

    let nexus_exit = nexus_plane::run(
        root,
        &[
            "bridge".to_string(),
            "--from-domain=finance".to_string(),
            "--to-domain=government".to_string(),
            "--payload-json={\"event\":\"invoice\"}".to_string(),
            "--legal-contract-id=contract-88".to_string(),
            "--sanitize=1".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(nexus_exit, 0);
    let nexus_latest = read_json(&latest_path(root, "nexus_plane"));
    assert!(claim_present(&nexus_latest, "V7-NEXUS-001.2"));

    let scan_exit = security_plane::run(
        root,
        &[
            "scan".to_string(),
            "--prompt=weekly status report".to_string(),
            "--tool-input=read summary".to_string(),
            "--mcp=mcp://read-only/status".to_string(),
            "--critical-threshold=0".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(scan_exit, 0);
    let security_latest = read_json(&latest_path(root, "security_plane"));
    assert!(claim_present(&security_latest, "V6-SEC-010"));

    let sentinel_exit = security_plane::run(
        root,
        &[
            "blast-radius-sentinel".to_string(),
            "record".to_string(),
            "--action=read".to_string(),
            "--target=public_dashboard".to_string(),
            "--credential=0".to_string(),
            "--network=0".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(sentinel_exit, 0);
    let sentinel_latest = read_json(&latest_path(root, "security_plane"));
    assert!(claim_present(&sentinel_latest, "V6-SEC-012"));

    let profile_exit = enterprise_hardening::run(
        root,
        &[
            "zero-trust-profile".to_string(),
            "--issuer=https://issuer.enterprise.local".to_string(),
            "--cmek-key=kms://customer/main".to_string(),
            "--private-link=aws-privatelink".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(profile_exit, 0);

    let bridge_exit = enterprise_hardening::run(
        root,
        &[
            "ops-bridge".to_string(),
            "--providers=datadog,splunk".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(bridge_exit, 0);

    let enterprise_latest = read_json(&latest_path(root, "enterprise_hardening"));
    assert!(claim_present(&enterprise_latest, "V7-F100-002.3"));
    assert!(claim_present(&enterprise_latest, "V7-F100-002.4"));
    assert_eq!(
        enterprise_latest
            .pointer("/cross_plane_jwt_guard/guard_ok")
            .and_then(Value::as_bool),
        Some(true)
    );
}
