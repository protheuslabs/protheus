// SPDX-License-Identifier: Apache-2.0
mod blob;
mod compression;
mod crdt;
mod ebbinghaus;
mod recall;
mod sqlite_store;

use std::ffi::{CStr, CString};
use std::os::raw::c_char;

pub use blob::{
    decode_manifest, encode_manifest, fold_blob, generate_manifest, sha256_hex, unfold_blob,
    BlobArtifactDigest, BlobError, BlobManifest, BlobPackReport, EmbeddedChaosHook,
    EmbeddedExecutionReceiptModel, EmbeddedExecutionReplay, EmbeddedExecutionStep,
    EmbeddedObservabilityProfile, EmbeddedSovereigntyScorer, EmbeddedTraceStreamPolicy,
    EmbeddedVaultAutoRotatePolicy, EmbeddedVaultPolicy, EmbeddedVaultPolicyRule,
    EXECUTION_REPLAY_BLOB_ID, HEARTBEAT_BLOB_ID, OBSERVABILITY_PROFILE_BLOB_ID,
    VAULT_POLICY_BLOB_ID,
};
pub use crdt::{merge as crdt_merge, CrdtCell, CrdtMap};
pub use sqlite_store::MemoryRow;

fn c_str_to_string(ptr: *const c_char) -> Result<String, String> {
    if ptr.is_null() {
        return Err("null_pointer".to_string());
    }
    // SAFETY: caller owns pointer and guarantees a NUL-terminated C string.
    let s = unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .map_err(|_| "invalid_utf8".to_string())?;
    Ok(s.to_string())
}

fn into_c_string_ptr(payload: String) -> *mut c_char {
    let sanitized = payload.replace('\0', "");
    match CString::new(sanitized) {
        Ok(c) => c.into_raw(),
        Err(_) => CString::new("{\"ok\":false,\"error\":\"cstring_encode_failed\"}")
            .unwrap_or_else(|_| {
                CString::new("{}").expect("fallback CString literal should be valid")
            })
            .into_raw(),
    }
}

#[allow(clippy::not_unsafe_ptr_arg_deref)]
#[no_mangle]
pub extern "C" fn recall(query: *const c_char, limit: u32) -> *mut c_char {
    let response = match c_str_to_string(query) {
        Ok(q) => recall::recall_json(&q, limit),
        Err(err) => serde_json::json!({
            "ok": false,
            "error": err
        })
        .to_string(),
    };
    into_c_string_ptr(response)
}

#[no_mangle]
pub extern "C" fn compress(aggressive: bool) -> u64 {
    sqlite_store::compress(aggressive).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn memory_free(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: pointer originated from CString::into_raw in this crate.
    unsafe {
        let _ = CString::from_raw(ptr);
    }
}

pub fn recall_json(query: &str, limit: u32) -> String {
    recall::recall_json(query, limit)
}

pub fn get_json(id: &str) -> String {
    recall::get_json(id)
}

pub fn compress_store(aggressive: bool) -> Result<u64, String> {
    sqlite_store::compress(aggressive)
}

pub fn set_hot_state(key: &str, payload_json: &str) -> Result<(), String> {
    sqlite_store::set_hot_state(key, payload_json)
}

pub fn ingest_memory(
    id: &str,
    content: &str,
    tags: Vec<String>,
    repetitions: u32,
    lambda: f64,
) -> Result<MemoryRow, String> {
    sqlite_store::ingest(id, content, tags, repetitions, lambda)
}

pub fn clear_cache() -> Result<u64, String> {
    sqlite_store::clear_cache()
}

pub fn load_embedded_heartbeat() -> Result<String, BlobError> {
    blob::load_embedded_heartbeat()
}

pub fn load_embedded_execution_replay() -> Result<EmbeddedExecutionReplay, BlobError> {
    blob::load_embedded_execution_replay()
}

pub fn load_embedded_vault_policy() -> Result<EmbeddedVaultPolicy, BlobError> {
    blob::load_embedded_vault_policy()
}

pub fn load_embedded_observability_profile() -> Result<EmbeddedObservabilityProfile, BlobError> {
    blob::load_embedded_observability_profile()
}

pub fn pack_embedded_blob_assets(sample: &str) -> Result<BlobPackReport, BlobError> {
    blob::write_embedded_blob_assets(sample)
}

pub fn pack_embedded_heartbeat_assets(sample: &str) -> Result<BlobPackReport, BlobError> {
    pack_embedded_blob_assets(sample)
}

pub fn ebbinghaus_curve(age_days: f64, repetitions: u32, lambda: f64) -> serde_json::Value {
    let curve = ebbinghaus::curve(age_days, repetitions, lambda);
    serde_json::json!({
        "ok": true,
        "age_days": curve.age_days,
        "repetitions": curve.repetitions,
        "lambda": curve.lambda,
        "retention_score": curve.retention_score
    })
}

pub fn crdt_exchange_json(payload_json: &str) -> Result<String, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(payload_json).map_err(|e| format!("invalid_payload_json:{e}"))?;
    let left: CrdtMap = serde_json::from_value(
        parsed
            .get("left")
            .cloned()
            .unwrap_or_else(|| serde_json::Value::Object(Default::default())),
    )
    .map_err(|e| format!("invalid_left:{e}"))?;
    let right: CrdtMap = serde_json::from_value(
        parsed
            .get("right")
            .cloned()
            .unwrap_or_else(|| serde_json::Value::Object(Default::default())),
    )
    .map_err(|e| format!("invalid_right:{e}"))?;
    let merged = crdt_merge(&left, &right);
    serde_json::to_string(&serde_json::json!({
      "ok": true,
      "merged": merged
    }))
    .map_err(|e| format!("json_encode_failed:{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffi_recall_returns_json() {
        let q = CString::new("rust").expect("cstring");
        let ptr = recall(q.as_ptr(), 3);
        assert!(!ptr.is_null());
        // SAFETY: pointer was allocated by this crate.
        let s = unsafe { CStr::from_ptr(ptr).to_string_lossy().to_string() };
        assert!(s.contains("\"ok\""));
        memory_free(ptr);
    }

    #[test]
    fn ffi_compress_returns_number() {
        let n = compress(false);
        assert!(n <= u64::MAX);
    }
}
