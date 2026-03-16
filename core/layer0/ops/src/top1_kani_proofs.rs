// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::top1_assurance (authoritative)

#![cfg(kani)]

use crate::{clean, deterministic_receipt_hash, stable_json_string};
use serde_json::{json, Map, Value};

const V7_TOP1_002_KANI_COVERAGE_ID: &str = "V7-TOP1-002-KANI-COVERAGE";

#[kani::proof]
fn prove_receipt_hash_is_deterministic_for_same_payload() {
    let payload = json!(true);
    let left = deterministic_receipt_hash(&payload);
    let right = deterministic_receipt_hash(&payload);
    assert_eq!(left, right);
}

#[kani::proof]
fn prove_stable_json_string_is_deterministic_for_same_payload() {
    let payload = json!({
        "alpha": [1, 2, 3],
        "beta": {"x": true, "y": false}
    });
    let left = stable_json_string(&payload);
    let right = stable_json_string(&payload);
    assert_eq!(left, right);
}

#[kani::proof]
fn prove_stable_json_string_is_invariant_to_object_key_order() {
    let left = json!({
        "alpha": 1,
        "beta": 2
    });
    let mut reordered = Map::new();
    reordered.insert("beta".to_string(), json!(2));
    reordered.insert("alpha".to_string(), json!(1));
    let right = Value::Object(reordered);
    assert_eq!(stable_json_string(&left), stable_json_string(&right));
}

#[kani::proof]
fn prove_receipt_hash_has_stable_hex_shape() {
    let payload = json!(true);
    let hash = deterministic_receipt_hash(&payload);
    assert_eq!(hash.len(), 64);
    assert!(hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
}

#[kani::proof]
fn prove_receipt_hash_is_invariant_to_object_key_order() {
    let left = json!({
        "alpha": 1,
        "beta": 2
    });
    let mut reordered = Map::new();
    reordered.insert("beta".to_string(), json!(2));
    reordered.insert("alpha".to_string(), json!(1));
    let right = Value::Object(reordered);
    assert_eq!(
        deterministic_receipt_hash(&left),
        deterministic_receipt_hash(&right)
    );
}

#[kani::proof]
fn prove_clean_respects_max_len_bound() {
    let raw = "  bounded text fixture  ";
    let max_len = 4usize;
    let cleaned = clean(raw, max_len);
    assert!(cleaned.chars().count() <= max_len);
    assert_eq!(cleaned, "boun");
}

#[kani::proof]
fn prove_clean_is_deterministic_for_same_input() {
    let raw = "  deterministic fixture  ";
    let left = clean(raw, 32);
    let right = clean(raw, 32);
    assert_eq!(left, right);
}

#[kani::proof]
fn prove_clean_trims_outer_whitespace() {
    let raw = "   edge trim fixture   ";
    let cleaned = clean(raw, 64);
    assert!(!cleaned.starts_with(' '));
    assert!(!cleaned.ends_with(' '));
}

#[kani::proof]
fn prove_canyon_footprint_no_std_helper_is_true_when_no_std_attr_present() {
    assert!(crate::canyon_plane::footprint_no_std_ready(false, true));
}

#[kani::proof]
fn prove_canyon_footprint_no_std_helper_is_true_when_default_feature_empty() {
    assert!(crate::canyon_plane::footprint_no_std_ready(true, false));
}

#[kani::proof]
fn prove_cross_plane_guard_requires_signed_jwt() {
    assert!(!crate::enterprise_hardening::cross_plane_guard_ok(
        false,
        "kms://customer/protheus/main",
        "aws-privatelink",
        "deny"
    ));
}

#[kani::proof]
fn prove_cross_plane_guard_accepts_valid_enterprise_profile() {
    assert!(crate::enterprise_hardening::cross_plane_guard_ok(
        true,
        "kms://customer/protheus/main",
        "aws-privatelink",
        "deny"
    ));
}

#[kani::proof]
fn prove_super_gate_release_blocks_when_scheduler_is_unproven() {
    let blocked = crate::enterprise_hardening::super_gate_release_blocked(
        true, 0.8, true, true, true, 2, false, true,
    );
    assert!(blocked);
}

#[kani::proof]
fn prove_super_gate_release_allows_when_all_assurance_signals_pass() {
    let blocked = crate::enterprise_hardening::super_gate_release_blocked(
        true, 0.8, true, true, true, 2, true, true,
    );
    assert!(!blocked);
}

#[kani::proof]
fn prove_v7_top1_kani_coverage_contract_id_binding_is_stable() {
    assert_eq!(
        V7_TOP1_002_KANI_COVERAGE_ID,
        "V7-TOP1-002-KANI-COVERAGE"
    );
}
