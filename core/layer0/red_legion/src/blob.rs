// SPDX-License-Identifier: Apache-2.0
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::{Display, Formatter};

pub const RED_LEGION_DOCTRINE_BLOB_ID: &str = "red_legion_doctrine";
pub const RED_LEGION_DOCTRINE_BLOB: &[u8] = include_bytes!("blobs/red_legion_doctrine.blob");
pub const MANIFEST_BLOB: &[u8] = include_bytes!("blobs/manifest.blob");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RedLegionDoctrine {
    pub doctrine_id: String,
    pub min_sovereignty_pct: f64,
    pub max_telemetry_overhead_ms: f64,
    pub max_battery_pct_24h: f64,
    pub fail_closed_on_violation: bool,
    pub max_drift_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlobManifest {
    pub id: String,
    pub hash: String,
    pub version: u32,
}

#[derive(Debug, Clone)]
pub enum BlobError {
    ManifestDecodeFailed(String),
    BlobNotFound(String),
    HashMismatch { expected: String, actual: String },
    DecodeFailed(String),
}

impl Display for BlobError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            BlobError::ManifestDecodeFailed(msg) => write!(f, "manifest_decode_failed:{msg}"),
            BlobError::BlobNotFound(id) => write!(f, "blob_not_found:{id}"),
            BlobError::HashMismatch { expected, actual } => {
                write!(f, "blob_hash_mismatch expected={expected} actual={actual}")
            }
            BlobError::DecodeFailed(msg) => write!(f, "blob_decode_failed:{msg}"),
        }
    }
}

impl std::error::Error for BlobError {}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub fn fold_blob<T: Serialize>(value: &T, _blob_id: &str) -> Result<(Vec<u8>, String), BlobError> {
    let payload = serde_json::to_vec(value).map_err(|e| BlobError::DecodeFailed(e.to_string()))?;
    let hash = sha256_hex(&payload);
    Ok((payload, hash))
}

pub fn generate_manifest(blobs: &[(&str, &[u8])]) -> Vec<BlobManifest> {
    blobs
        .iter()
        .map(|(id, bytes)| BlobManifest {
            id: (*id).to_string(),
            hash: sha256_hex(bytes),
            version: 1,
        })
        .collect()
}

pub fn decode_manifest(bytes: &[u8]) -> Result<Vec<BlobManifest>, BlobError> {
    serde_json::from_slice(bytes).map_err(|e| BlobError::ManifestDecodeFailed(e.to_string()))
}

pub fn unfold_blob<T: DeserializeOwned>(bytes: &[u8], expected_hash: &str) -> Result<T, BlobError> {
    let actual = sha256_hex(bytes);
    if !actual.eq_ignore_ascii_case(expected_hash) {
        return Err(BlobError::HashMismatch {
            expected: expected_hash.to_string(),
            actual,
        });
    }
    serde_json::from_slice(bytes).map_err(|e| BlobError::DecodeFailed(e.to_string()))
}

pub fn load_embedded_red_legion_doctrine() -> Result<RedLegionDoctrine, BlobError> {
    let manifest = decode_manifest(MANIFEST_BLOB)?;
    let entry = manifest
        .iter()
        .find(|v| v.id == RED_LEGION_DOCTRINE_BLOB_ID)
        .ok_or_else(|| BlobError::BlobNotFound(RED_LEGION_DOCTRINE_BLOB_ID.to_string()))?;
    unfold_blob(RED_LEGION_DOCTRINE_BLOB, &entry.hash)
}
