// SPDX-License-Identifier: Apache-2.0
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use snap::raw::{Decoder, Encoder};
use std::fmt::{Display, Formatter};

pub const MANIFEST: &[u8] = include_bytes!("manifest.blob");
pub const MOCK_MEMORY_STATE_BLOB: &[u8] = include_bytes!("blobs/mock_memory_state.blob");
pub const MOCK_EXECUTION_POLICY_BLOB: &[u8] = include_bytes!("blobs/mock_execution_policy.blob");
pub const SOUL_CONTRACT_BLOB: &[u8] = include_bytes!("blobs/soul_contract.blob");

pub const MOCK_MEMORY_STATE_ID: &str = "mock_memory_state";
pub const MOCK_EXECUTION_POLICY_ID: &str = "mock_execution_policy";
pub const SOUL_CONTRACT_ID: &str = "soul_contract_snippet";
pub const BLOB_VERSION: u32 = 1;

const MANIFEST_SIGNING_KEY: &str = "blob-test-signing-key-v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlobManifest {
    pub id: String,
    pub hash: String,
    pub version: u32,
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FoldedBlob {
    id: String,
    version: u32,
    payload: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MockMemoryState {
    pub user_id: String,
    pub recall_count: u32,
    pub decay_curve: Vec<f32>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MockExecutionPolicy {
    pub deterministic_receipts: bool,
    pub max_parallel_workflows: u16,
    pub retry_budget: u8,
    pub canary_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SoulContractSnippet {
    pub covenant_version: String,
    pub clauses: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct FoldedDemoBlob {
    pub id: String,
    pub compressed_bytes: Vec<u8>,
    pub hash: String,
}

#[derive(Debug, Clone)]
pub struct DemoBundle {
    pub blobs: Vec<FoldedDemoBlob>,
    pub manifest: Vec<BlobManifest>,
    pub manifest_bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub enum BlobError {
    InvalidBlobId,
    UnknownBlob(String),
    MissingManifestEntry(String),
    MissingSignature(String),
    SignatureMismatch {
        id: String,
        expected: String,
        actual: String,
    },
    HashMismatch {
        scope: &'static str,
        expected: String,
        actual: String,
    },
    IdMismatch {
        expected: String,
        actual: String,
    },
    UnsupportedVersion {
        id: String,
        version: u32,
    },
    SerializeFailed(String),
    DeserializeFailed(String),
    CompressFailed(String),
    DecompressFailed(String),
    ManifestEncodeFailed(String),
    ManifestDecodeFailed(String),
}

impl Display for BlobError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            BlobError::InvalidBlobId => write!(f, "blob_id_required"),
            BlobError::UnknownBlob(blob_id) => write!(f, "unknown_blob_id:{blob_id}"),
            BlobError::MissingManifestEntry(blob_id) => {
                write!(f, "manifest_missing_blob:{blob_id}")
            }
            BlobError::MissingSignature(blob_id) => {
                write!(f, "manifest_missing_signature:{blob_id}")
            }
            BlobError::SignatureMismatch {
                id,
                expected,
                actual,
            } => write!(
                f,
                "manifest_signature_mismatch id={id} expected={expected} actual={actual}"
            ),
            BlobError::HashMismatch {
                scope,
                expected,
                actual,
            } => write!(
                f,
                "blob_hash_mismatch scope={scope} expected={expected} actual={actual}"
            ),
            BlobError::IdMismatch { expected, actual } => {
                write!(f, "blob_id_mismatch expected={expected} actual={actual}")
            }
            BlobError::UnsupportedVersion { id, version } => {
                write!(f, "unsupported_blob_version id={id} version={version}")
            }
            BlobError::SerializeFailed(msg) => write!(f, "serialize_failed:{msg}"),
            BlobError::DeserializeFailed(msg) => write!(f, "deserialize_failed:{msg}"),
            BlobError::CompressFailed(msg) => write!(f, "compress_failed:{msg}"),
            BlobError::DecompressFailed(msg) => write!(f, "decompress_failed:{msg}"),
            BlobError::ManifestEncodeFailed(msg) => write!(f, "manifest_encode_failed:{msg}"),
            BlobError::ManifestDecodeFailed(msg) => write!(f, "manifest_decode_failed:{msg}"),
        }
    }
}

impl std::error::Error for BlobError {}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub fn fold_blob<T: Serialize>(data: &T, blob_id: &str) -> Result<(Vec<u8>, String), BlobError> {
    if blob_id.trim().is_empty() {
        return Err(BlobError::InvalidBlobId);
    }

    let payload =
        bincode::serialize(data).map_err(|e| BlobError::SerializeFailed(e.to_string()))?;
    let folded = FoldedBlob {
        id: blob_id.to_string(),
        version: BLOB_VERSION,
        payload,
    };
    let encoded =
        bincode::serialize(&folded).map_err(|e| BlobError::SerializeFailed(e.to_string()))?;
    let compressed = Encoder::new()
        .compress_vec(&encoded)
        .map_err(|e| BlobError::CompressFailed(e.to_string()))?;
    let hash = sha256_hex(&compressed);
    Ok((compressed, hash))
}

pub fn generate_manifest(blobs: &[(&str, &[u8])]) -> Vec<BlobManifest> {
    blobs
        .iter()
        .map(|(blob_id, blob_bytes)| {
            let hash = sha256_hex(blob_bytes);
            let signature = manifest_signature(blob_id, &hash, BLOB_VERSION);
            BlobManifest {
                id: (*blob_id).to_string(),
                hash,
                version: BLOB_VERSION,
                signature: Some(signature),
            }
        })
        .collect()
}

pub fn encode_manifest(entries: &[BlobManifest]) -> Result<Vec<u8>, BlobError> {
    bincode::serialize(entries).map_err(|e| BlobError::ManifestEncodeFailed(e.to_string()))
}

pub fn decode_manifest(bytes: &[u8]) -> Result<Vec<BlobManifest>, BlobError> {
    bincode::deserialize(bytes).map_err(|e| BlobError::ManifestDecodeFailed(e.to_string()))
}

pub fn load_manifest() -> Result<Vec<BlobManifest>, BlobError> {
    decode_manifest(MANIFEST)
}

pub fn unfold_blob(blob_id: &str, expected_hash: &str) -> Result<Vec<u8>, BlobError> {
    let manifest = load_manifest()?;
    let entry = manifest
        .iter()
        .find(|entry| entry.id == blob_id)
        .ok_or_else(|| BlobError::MissingManifestEntry(blob_id.to_string()))?;

    verify_manifest_entry(entry)?;

    if !entry.hash.eq_ignore_ascii_case(expected_hash) {
        return Err(BlobError::HashMismatch {
            scope: "expected_vs_manifest",
            expected: entry.hash.clone(),
            actual: expected_hash.to_string(),
        });
    }

    let blob_bytes =
        blob_bytes_by_id(blob_id).ok_or_else(|| BlobError::UnknownBlob(blob_id.to_string()))?;
    let actual_hash = sha256_hex(blob_bytes);
    if !actual_hash.eq_ignore_ascii_case(&entry.hash) {
        return Err(BlobError::HashMismatch {
            scope: "blob_vs_manifest",
            expected: entry.hash.clone(),
            actual: actual_hash,
        });
    }

    let decompressed = Decoder::new()
        .decompress_vec(blob_bytes)
        .map_err(|e| BlobError::DecompressFailed(e.to_string()))?;
    let folded: FoldedBlob = bincode::deserialize(&decompressed)
        .map_err(|e| BlobError::DeserializeFailed(e.to_string()))?;

    if folded.id != blob_id {
        return Err(BlobError::IdMismatch {
            expected: blob_id.to_string(),
            actual: folded.id,
        });
    }
    if folded.version != BLOB_VERSION {
        return Err(BlobError::UnsupportedVersion {
            id: blob_id.to_string(),
            version: folded.version,
        });
    }

    Ok(folded.payload)
}

pub fn unfold_blob_typed<T: DeserializeOwned>(
    blob_id: &str,
    expected_hash: &str,
) -> Result<T, BlobError> {
    let payload = unfold_blob(blob_id, expected_hash)?;
    bincode::deserialize(&payload).map_err(|e| BlobError::DeserializeFailed(e.to_string()))
}

pub fn blob_bytes_by_id(blob_id: &str) -> Option<&'static [u8]> {
    match blob_id {
        MOCK_MEMORY_STATE_ID => Some(MOCK_MEMORY_STATE_BLOB),
        MOCK_EXECUTION_POLICY_ID => Some(MOCK_EXECUTION_POLICY_BLOB),
        SOUL_CONTRACT_ID => Some(SOUL_CONTRACT_BLOB),
        _ => None,
    }
}

pub fn demo_blob_ids() -> [&'static str; 3] {
    [
        MOCK_MEMORY_STATE_ID,
        MOCK_EXECUTION_POLICY_ID,
        SOUL_CONTRACT_ID,
    ]
}

pub fn demo_blob_path(blob_id: &str) -> Option<&'static str> {
    match blob_id {
        MOCK_MEMORY_STATE_ID => Some("src/blobs/mock_memory_state.blob"),
        MOCK_EXECUTION_POLICY_ID => Some("src/blobs/mock_execution_policy.blob"),
        SOUL_CONTRACT_ID => Some("src/blobs/soul_contract.blob"),
        _ => None,
    }
}

pub fn sample_memory_state() -> MockMemoryState {
    MockMemoryState {
        user_id: "jay".to_string(),
        recall_count: 82,
        decay_curve: vec![1.0, 0.92, 0.81, 0.73, 0.64],
        notes: vec![
            "Ebbinghaus-adjusted scheduling active".to_string(),
            "CRDT delta compaction every 15m".to_string(),
        ],
    }
}

pub fn sample_execution_policy() -> MockExecutionPolicy {
    MockExecutionPolicy {
        deterministic_receipts: true,
        max_parallel_workflows: 6,
        retry_budget: 2,
        canary_enabled: true,
    }
}

pub fn sample_soul_contract_snippet() -> SoulContractSnippet {
    SoulContractSnippet {
        covenant_version: "v1.3".to_string(),
        clauses: vec![
            "alignment_invariant: fail_closed".to_string(),
            "human_approval_required: destructive_ops".to_string(),
            "receipts_mandatory: all_mutations".to_string(),
        ],
    }
}

pub fn build_demo_bundle() -> Result<DemoBundle, BlobError> {
    let (memory_blob, memory_hash) = fold_blob(&sample_memory_state(), MOCK_MEMORY_STATE_ID)?;
    let (policy_blob, policy_hash) =
        fold_blob(&sample_execution_policy(), MOCK_EXECUTION_POLICY_ID)?;
    let (soul_blob, soul_hash) = fold_blob(&sample_soul_contract_snippet(), SOUL_CONTRACT_ID)?;

    let blobs = vec![
        FoldedDemoBlob {
            id: MOCK_MEMORY_STATE_ID.to_string(),
            compressed_bytes: memory_blob,
            hash: memory_hash,
        },
        FoldedDemoBlob {
            id: MOCK_EXECUTION_POLICY_ID.to_string(),
            compressed_bytes: policy_blob,
            hash: policy_hash,
        },
        FoldedDemoBlob {
            id: SOUL_CONTRACT_ID.to_string(),
            compressed_bytes: soul_blob,
            hash: soul_hash,
        },
    ];

    let manifest_inputs: Vec<(&str, &[u8])> = blobs
        .iter()
        .map(|blob| (blob.id.as_str(), blob.compressed_bytes.as_slice()))
        .collect();
    let manifest = generate_manifest(&manifest_inputs);
    let manifest_bytes = encode_manifest(&manifest)?;

    Ok(DemoBundle {
        blobs,
        manifest,
        manifest_bytes,
    })
}

fn manifest_signature(id: &str, hash: &str, version: u32) -> String {
    let to_sign = format!("{id}:{hash}:{version}:{MANIFEST_SIGNING_KEY}");
    sha256_hex(to_sign.as_bytes())
}

fn verify_manifest_entry(entry: &BlobManifest) -> Result<(), BlobError> {
    let actual = entry
        .signature
        .as_ref()
        .ok_or_else(|| BlobError::MissingSignature(entry.id.clone()))?;
    let expected = manifest_signature(&entry.id, &entry.hash, entry.version);
    if !actual.eq_ignore_ascii_case(&expected) {
        return Err(BlobError::SignatureMismatch {
            id: entry.id.clone(),
            expected,
            actual: actual.clone(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fold_blob_generates_hash_for_compressed_payload() {
        let (blob, hash) = fold_blob(&sample_memory_state(), MOCK_MEMORY_STATE_ID)
            .expect("fold_blob should succeed");
        assert!(!blob.is_empty());
        assert_eq!(hash, sha256_hex(&blob));
    }

    #[test]
    fn generate_manifest_adds_signatures() {
        let bundle = build_demo_bundle().expect("bundle creation should succeed");
        assert_eq!(bundle.manifest.len(), 3);
        for entry in bundle.manifest {
            verify_manifest_entry(&entry).expect("signature should verify");
        }
    }

    #[test]
    fn embedded_manifest_unfolds_all_demo_blobs() {
        let manifest = load_manifest().expect("embedded manifest should decode");
        assert!(
            !manifest.is_empty(),
            "embedded manifest should contain at least one entry"
        );

        for entry in manifest {
            let payload = unfold_blob(&entry.id, &entry.hash).expect("unfold should succeed");
            assert!(
                !payload.is_empty(),
                "payload should not be empty for {}",
                entry.id
            );
        }
    }

    #[test]
    fn unfold_typed_round_trip_for_memory_blob() {
        let manifest = load_manifest().expect("manifest decode should succeed");
        let memory_entry = manifest
            .iter()
            .find(|entry| entry.id == MOCK_MEMORY_STATE_ID)
            .expect("memory blob should be in manifest");

        let decoded: MockMemoryState = unfold_blob_typed(&memory_entry.id, &memory_entry.hash)
            .expect("typed unfold should succeed");
        assert_eq!(decoded, sample_memory_state());
    }
}
