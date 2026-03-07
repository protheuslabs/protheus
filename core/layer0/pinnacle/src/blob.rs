// SPDX-License-Identifier: Apache-2.0
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::{Display, Formatter};

pub const PINNACLE_PROFILE_BLOB_ID: &str = "pinnacle_merge_profile";
pub const PINNACLE_PROFILE_BLOB: &[u8] = include_bytes!("blobs/pinnacle_merge_profile.blob");
pub const MANIFEST_BLOB: &[u8] = include_bytes!("blobs/manifest.blob");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PinnacleMergeProfile {
    pub profile_id: String,
    pub convergence_floor_pct: f64,
    pub conflict_penalty_pct: f64,
    pub unsigned_penalty_pct: f64,
    pub deterministic_tie_breaker: String,
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
    EncodeFailed(String),
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
            BlobError::EncodeFailed(msg) => write!(f, "blob_encode_failed:{msg}"),
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
    let payload = serde_json::to_vec(value).map_err(|e| BlobError::EncodeFailed(e.to_string()))?;
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

pub fn load_embedded_pinnacle_profile() -> Result<PinnacleMergeProfile, BlobError> {
    let manifest = decode_manifest(MANIFEST_BLOB)?;
    let entry = manifest
        .iter()
        .find(|v| v.id == PINNACLE_PROFILE_BLOB_ID)
        .ok_or_else(|| BlobError::BlobNotFound(PINNACLE_PROFILE_BLOB_ID.to_string()))?;
    unfold_blob(PINNACLE_PROFILE_BLOB, &entry.hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_profile_verifies() {
        let profile = load_embedded_pinnacle_profile().expect("profile");
        assert!(profile.convergence_floor_pct > 0.0);
    }

    #[test]
    fn fold_and_unfold_round_trip() {
        let profile = PinnacleMergeProfile {
            profile_id: "test".to_string(),
            convergence_floor_pct: 70.0,
            conflict_penalty_pct: 12.0,
            unsigned_penalty_pct: 4.0,
            deterministic_tie_breaker: "sha256_payload".to_string(),
        };
        let (blob, hash) = fold_blob(&profile, PINNACLE_PROFILE_BLOB_ID).expect("fold");
        let restored: PinnacleMergeProfile = unfold_blob(&blob, &hash).expect("unfold");
        assert_eq!(profile, restored);
    }
}
