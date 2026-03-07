// SPDX-License-Identifier: Apache-2.0
mod blob;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

pub use blob::{
    decode_manifest, fold_blob, generate_manifest, load_embedded_pinnacle_profile, sha256_hex,
    unfold_blob, BlobError, BlobManifest, PinnacleMergeProfile, PINNACLE_PROFILE_BLOB_ID,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CrdtValue {
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub vector_clock: BTreeMap<String, u64>,
    #[serde(default)]
    pub signed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CrdtDelta {
    #[serde(default)]
    pub node_id: String,
    #[serde(default)]
    pub changes: BTreeMap<String, CrdtValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MergeConflict {
    pub key: String,
    pub left_clock: BTreeMap<String, u64>,
    pub right_clock: BTreeMap<String, u64>,
    pub resolver: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MergeResult {
    pub merged: BTreeMap<String, CrdtValue>,
    pub conflicts: Vec<MergeConflict>,
    pub convergence_score_pct: f64,
    pub sovereignty_index_pct: f64,
    pub digest: String,
    pub profile_id: String,
}

fn vector_clock_cmp(left: &BTreeMap<String, u64>, right: &BTreeMap<String, u64>) -> Ordering {
    let keys: BTreeSet<String> = left
        .keys()
        .chain(right.keys())
        .map(|k| k.to_string())
        .collect();

    let mut left_gt = false;
    let mut right_gt = false;

    for key in keys {
        let l = left.get(&key).copied().unwrap_or(0);
        let r = right.get(&key).copied().unwrap_or(0);
        if l > r {
            left_gt = true;
        }
        if r > l {
            right_gt = true;
        }
    }

    match (left_gt, right_gt) {
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        _ => Ordering::Equal,
    }
}

fn deterministic_hash_key(key: &str, value: &CrdtValue) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    hasher.update(
        serde_json::to_string(&value.payload)
            .unwrap_or_else(|_| "null".to_string())
            .as_bytes(),
    );
    for (k, v) in &value.vector_clock {
        hasher.update(format!("{}:{}", k, v).as_bytes());
    }
    hasher.update(value.signed.to_string().as_bytes());
    hex::encode(hasher.finalize())
}

fn merge_value(
    key: &str,
    left: &CrdtValue,
    right: &CrdtValue,
    conflicts: &mut Vec<MergeConflict>,
) -> CrdtValue {
    match vector_clock_cmp(&left.vector_clock, &right.vector_clock) {
        Ordering::Greater => left.clone(),
        Ordering::Less => right.clone(),
        Ordering::Equal => {
            let left_h = deterministic_hash_key(key, left);
            let right_h = deterministic_hash_key(key, right);
            if left_h >= right_h {
                conflicts.push(MergeConflict {
                    key: key.to_string(),
                    left_clock: left.vector_clock.clone(),
                    right_clock: right.vector_clock.clone(),
                    resolver: "deterministic_hash_tie_break_left".to_string(),
                });
                left.clone()
            } else {
                conflicts.push(MergeConflict {
                    key: key.to_string(),
                    left_clock: left.vector_clock.clone(),
                    right_clock: right.vector_clock.clone(),
                    resolver: "deterministic_hash_tie_break_right".to_string(),
                });
                right.clone()
            }
        }
    }
}

fn compute_scores(
    merged: &BTreeMap<String, CrdtValue>,
    conflicts: &[MergeConflict],
    profile: &PinnacleMergeProfile,
) -> (f64, f64) {
    let total = merged.len().max(1) as f64;
    let conflict_rate = conflicts.len() as f64 / total;
    let unsigned_count = merged.values().filter(|v| !v.signed).count() as f64;
    let unsigned_rate = unsigned_count / total;

    let convergence = (100.0 - (conflict_rate * 100.0)).clamp(0.0, 100.0);
    let sovereignty = (convergence
        - (conflict_rate * profile.conflict_penalty_pct)
        - (unsigned_rate * profile.unsigned_penalty_pct * 10.0))
        .clamp(0.0, 100.0);

    (
        (convergence * 1000.0).round() / 1000.0,
        (sovereignty * 1000.0).round() / 1000.0,
    )
}

fn digest_merge(merged: &BTreeMap<String, CrdtValue>, conflicts: &[MergeConflict]) -> String {
    let mut lines = Vec::new();
    for (k, v) in merged {
        lines.push(format!(
            "{}:{}:{}",
            k,
            serde_json::to_string(&v.payload).unwrap_or_else(|_| "null".to_string()),
            serde_json::to_string(&v.vector_clock).unwrap_or_else(|_| "{}".to_string())
        ));
    }
    for c in conflicts {
        lines.push(format!("conflict:{}:{}", c.key, c.resolver));
    }
    let mut hasher = Sha256::new();
    for (idx, line) in lines.iter().enumerate() {
        hasher.update(format!("{}:{}|", idx, line).as_bytes());
    }
    hex::encode(hasher.finalize())
}

pub fn merge_delta(left_json: &str, right_json: &str) -> Result<MergeResult, String> {
    let left: CrdtDelta =
        serde_json::from_str(left_json).map_err(|e| format!("left_parse_failed:{e}"))?;
    let right: CrdtDelta =
        serde_json::from_str(right_json).map_err(|e| format!("right_parse_failed:{e}"))?;
    let profile = load_embedded_pinnacle_profile().map_err(|e| e.to_string())?;

    let mut merged = BTreeMap::<String, CrdtValue>::new();
    let mut conflicts = Vec::<MergeConflict>::new();

    let keys: BTreeSet<String> = left
        .changes
        .keys()
        .chain(right.changes.keys())
        .map(|k| k.to_string())
        .collect();

    for key in keys {
        let lv = left.changes.get(&key);
        let rv = right.changes.get(&key);
        let merged_value = match (lv, rv) {
            (Some(l), Some(r)) => merge_value(&key, l, r, &mut conflicts),
            (Some(l), None) => l.clone(),
            (None, Some(r)) => r.clone(),
            (None, None) => continue,
        };
        merged.insert(key, merged_value);
    }

    let (convergence_score_pct, sovereignty_index_pct) =
        compute_scores(&merged, &conflicts, &profile);
    let digest = digest_merge(&merged, &conflicts);

    Ok(MergeResult {
        merged,
        conflicts,
        convergence_score_pct,
        sovereignty_index_pct,
        digest,
        profile_id: profile.profile_id,
    })
}

pub fn get_sovereignty_index(left_json: &str, right_json: &str) -> Result<f64, String> {
    merge_delta(left_json, right_json).map(|v| v.sovereignty_index_pct)
}

pub fn merge_delta_json(left_json: &str, right_json: &str) -> Result<String, String> {
    let merged = merge_delta(left_json, right_json)?;
    serde_json::to_string(&merged).map_err(|e| format!("merge_encode_failed:{e}"))
}

#[no_mangle]
pub extern "C" fn merge_delta_ffi(
    left_json_ptr: *const c_char,
    right_json_ptr: *const c_char,
) -> *mut c_char {
    let left_json = if left_json_ptr.is_null() {
        "{}".to_string()
    } else {
        unsafe { CStr::from_ptr(left_json_ptr) }
            .to_str()
            .unwrap_or("{}")
            .to_string()
    };
    let right_json = if right_json_ptr.is_null() {
        "{}".to_string()
    } else {
        unsafe { CStr::from_ptr(right_json_ptr) }
            .to_str()
            .unwrap_or("{}")
            .to_string()
    };
    let payload = match merge_delta_json(&left_json, &right_json) {
        Ok(v) => v,
        Err(err) => serde_json::json!({ "ok": false, "error": err }).to_string(),
    };
    CString::new(payload)
        .map(|v| v.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn get_sovereignty_index_ffi(
    left_json_ptr: *const c_char,
    right_json_ptr: *const c_char,
) -> f64 {
    let left_json = if left_json_ptr.is_null() {
        "{}".to_string()
    } else {
        unsafe { CStr::from_ptr(left_json_ptr) }
            .to_str()
            .unwrap_or("{}")
            .to_string()
    };
    let right_json = if right_json_ptr.is_null() {
        "{}".to_string()
    } else {
        unsafe { CStr::from_ptr(right_json_ptr) }
            .to_str()
            .unwrap_or("{}")
            .to_string()
    };
    get_sovereignty_index(&left_json, &right_json).unwrap_or(0.0)
}

#[no_mangle]
pub extern "C" fn pinnacle_free(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        let _ = CString::from_raw(ptr);
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn merge_delta_wasm(left_json: &str, right_json: &str) -> String {
    match merge_delta_json(left_json, right_json) {
        Ok(v) => v,
        Err(err) => serde_json::json!({ "ok": false, "error": err }).to_string(),
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn get_sovereignty_index_wasm(left_json: &str, right_json: &str) -> f64 {
    get_sovereignty_index(left_json, right_json).unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delta(node_id: &str, key: &str, value: i64, clock_a: u64, signed: bool) -> String {
        serde_json::json!({
            "node_id": node_id,
            "changes": {
                key: {
                    "payload": value,
                    "vector_clock": { node_id: clock_a },
                    "signed": signed
                }
            }
        })
        .to_string()
    }

    #[test]
    fn merge_prefers_newer_clock() {
        let left = delta("a", "x", 1, 1, true);
        let right = delta("a", "x", 2, 2, true);
        let merged = merge_delta(&left, &right).expect("merge");
        assert_eq!(
            merged.merged.get("x").unwrap().payload,
            serde_json::json!(2)
        );
        assert!(merged.sovereignty_index_pct > 0.0);
    }

    #[test]
    fn merge_conflict_penalizes_index() {
        let left = serde_json::json!({
            "node_id": "a",
            "changes": {
                "x": {
                    "payload": 1,
                    "vector_clock": { "a": 2 },
                    "signed": true
                }
            }
        })
        .to_string();
        let right = serde_json::json!({
            "node_id": "b",
            "changes": {
                "x": {
                    "payload": 2,
                    "vector_clock": { "b": 2 },
                    "signed": false
                }
            }
        })
        .to_string();
        let merged = merge_delta(&left, &right).expect("merge");
        assert!(!merged.conflicts.is_empty());
        assert!(merged.sovereignty_index_pct < 100.0);
    }

    #[test]
    fn index_api_returns_number() {
        let left = delta("a", "x", 1, 1, true);
        let right = delta("a", "x", 1, 1, true);
        let idx = get_sovereignty_index(&left, &right).expect("index");
        assert!(idx >= 0.0);
    }

    #[test]
    fn ffi_merge_and_free_path() {
        let left = CString::new(delta("a", "x", 1, 1, true)).unwrap();
        let right = CString::new(delta("b", "x", 2, 2, true)).unwrap();
        let out_ptr = merge_delta_ffi(left.as_ptr(), right.as_ptr());
        assert!(!out_ptr.is_null());
        let out_text = unsafe { CStr::from_ptr(out_ptr) }
            .to_str()
            .unwrap()
            .to_string();
        pinnacle_free(out_ptr);
        let parsed: serde_json::Value = serde_json::from_str(&out_text).unwrap();
        assert!(parsed.get("merged").is_some());
        let idx = get_sovereignty_index_ffi(left.as_ptr(), right.as_ptr());
        assert!(idx >= 0.0);
    }
}
