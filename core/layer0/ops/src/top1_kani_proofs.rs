// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::top1_assurance (authoritative)

#![cfg(kani)]

use crate::{clean, deterministic_receipt_hash};
use serde_json::json;

#[kani::proof]
fn prove_receipt_hash_is_deterministic_for_same_payload() {
    let payload = json!(true);
    let left = deterministic_receipt_hash(&payload);
    let right = deterministic_receipt_hash(&payload);
    assert_eq!(left, right);
}

#[kani::proof]
fn prove_receipt_hash_has_stable_hex_shape() {
    let payload = json!(true);
    let hash = deterministic_receipt_hash(&payload);
    assert_eq!(hash.len(), 64);
    assert!(hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
}

#[kani::proof]
fn prove_clean_respects_max_len_bound() {
    let raw = "  bounded text fixture  ";
    let max_len = 4usize;
    let cleaned = clean(raw, max_len);
    assert!(cleaned.chars().count() <= max_len);
    assert_eq!(cleaned, "boun");
}
