// SPDX-License-Identifier: Apache-2.0
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use snap::raw::{Decoder, Encoder};
use std::fmt::{Display, Formatter};

pub const HEARTBEAT_BLOB_ID: &str = "heartbeat_sample";
pub const EXECUTION_REPLAY_BLOB_ID: &str = "execution_replay";
pub const VAULT_POLICY_BLOB_ID: &str = "vault_policy";
pub const OBSERVABILITY_PROFILE_BLOB_ID: &str = "observability_profile";
pub const BLOB_VERSION: u32 = 1;

pub const HEARTBEAT_BLOB: &[u8] = include_bytes!("blobs/heartbeat_sample.blob");
pub const EXECUTION_REPLAY_BLOB: &[u8] = include_bytes!("blobs/execution_replay.blob");
pub const VAULT_POLICY_BLOB: &[u8] = include_bytes!("blobs/vault_policy.blob");
pub const OBSERVABILITY_PROFILE_BLOB: &[u8] = include_bytes!("blobs/observability_profile.blob");
pub const BLOB_MANIFEST: &[u8] = include_bytes!("blobs/manifest.blob");

const MANIFEST_SIGNING_KEY: &str = "memory-blob-signing-key-v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlobManifest {
    pub id: String,
    pub hash: String,
    pub version: u32,
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct FoldedBlob {
    id: String,
    version: u32,
    payload: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlobArtifactDigest {
    pub id: String,
    pub path: String,
    pub bytes: usize,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlobPackReport {
    pub manifest_path: String,
    pub manifest_bytes: usize,
    pub artifacts: Vec<BlobArtifactDigest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmbeddedExecutionStep {
    pub id: String,
    pub kind: String,
    pub action: String,
    pub command: String,
    pub pause_after: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmbeddedExecutionReceiptModel {
    pub deterministic: bool,
    pub replayable: bool,
    pub digest_algorithm: String,
    pub status_cycle: Vec<String>,
    pub state_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmbeddedExecutionReplay {
    pub engine_version: String,
    pub workflow_id: String,
    pub deterministic_seed: String,
    pub pause_resume_contract: Vec<String>,
    pub steps: Vec<EmbeddedExecutionStep>,
    pub receipt_model: EmbeddedExecutionReceiptModel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmbeddedVaultPolicyRule {
    pub id: String,
    pub objective: String,
    pub zk_requirement: String,
    pub fhe_requirement: String,
    pub severity: String,
    pub fail_closed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmbeddedVaultAutoRotatePolicy {
    pub enabled: bool,
    pub rotate_after_hours: u32,
    pub max_key_age_hours: u32,
    pub grace_window_minutes: u32,
    pub quorum_required: u8,
    pub emergency_rotate_on_tamper: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmbeddedVaultPolicy {
    pub policy_id: String,
    pub version: u32,
    pub key_domain: String,
    pub cryptographic_profile: String,
    pub attestation_chain: Vec<String>,
    pub auto_rotate: EmbeddedVaultAutoRotatePolicy,
    pub rules: Vec<EmbeddedVaultPolicyRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmbeddedTraceStreamPolicy {
    pub trace_window_ms: u32,
    pub max_events_per_window: u32,
    pub min_sampling_rate_pct: u8,
    pub redact_fields: Vec<String>,
    pub require_signature: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmbeddedSovereigntyScorer {
    pub integrity_weight_pct: u8,
    pub continuity_weight_pct: u8,
    pub reliability_weight_pct: u8,
    pub chaos_penalty_pct: u8,
    pub fail_closed_threshold_pct: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmbeddedChaosHook {
    pub id: String,
    pub condition: String,
    pub action: String,
    pub severity: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmbeddedObservabilityProfile {
    pub profile_id: String,
    pub version: u32,
    pub red_legion_trace_channels: Vec<String>,
    pub allowed_emitters: Vec<String>,
    pub stream_policy: EmbeddedTraceStreamPolicy,
    pub sovereignty_scorer: EmbeddedSovereigntyScorer,
    pub chaos_hooks: Vec<EmbeddedChaosHook>,
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
    IoFailed(String),
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
            BlobError::IoFailed(msg) => write!(f, "io_failed:{msg}"),
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

pub fn load_embedded_heartbeat() -> Result<String, BlobError> {
    let manifest = decode_manifest(BLOB_MANIFEST)?;
    let hash = manifest_hash_for(&manifest, HEARTBEAT_BLOB_ID)?;
    unfold_blob_typed(HEARTBEAT_BLOB_ID, &hash)
}

pub fn load_embedded_execution_replay() -> Result<EmbeddedExecutionReplay, BlobError> {
    let manifest = decode_manifest(BLOB_MANIFEST)?;
    let hash = manifest_hash_for(&manifest, EXECUTION_REPLAY_BLOB_ID)?;
    unfold_blob_typed(EXECUTION_REPLAY_BLOB_ID, &hash)
}

pub fn load_embedded_vault_policy() -> Result<EmbeddedVaultPolicy, BlobError> {
    let manifest = decode_manifest(BLOB_MANIFEST)?;
    let hash = manifest_hash_for(&manifest, VAULT_POLICY_BLOB_ID)?;
    unfold_blob_typed(VAULT_POLICY_BLOB_ID, &hash)
}

pub fn load_embedded_observability_profile() -> Result<EmbeddedObservabilityProfile, BlobError> {
    let manifest = decode_manifest(BLOB_MANIFEST)?;
    let hash = manifest_hash_for(&manifest, OBSERVABILITY_PROFILE_BLOB_ID)?;
    unfold_blob_typed(OBSERVABILITY_PROFILE_BLOB_ID, &hash)
}

pub fn unfold_blob(blob_id: &str, expected_hash: &str) -> Result<Vec<u8>, BlobError> {
    let manifest = decode_manifest(BLOB_MANIFEST)?;
    let blob_bytes =
        embedded_blob_by_id(blob_id).ok_or_else(|| BlobError::UnknownBlob(blob_id.to_string()))?;
    unfold_blob_from_parts(blob_id, expected_hash, blob_bytes, &manifest)
}

pub fn unfold_blob_from_parts(
    blob_id: &str,
    expected_hash: &str,
    blob_bytes: &[u8],
    manifest: &[BlobManifest],
) -> Result<Vec<u8>, BlobError> {
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

#[cfg(not(target_arch = "wasm32"))]
pub fn default_heartbeat_sample() -> String {
    "Read HEARTBEAT.md if it exists. Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.".to_string()
}

#[cfg(not(target_arch = "wasm32"))]
pub fn default_execution_replay_sample() -> EmbeddedExecutionReplay {
    EmbeddedExecutionReplay {
        engine_version: "execution_core_v0.1.0".to_string(),
        workflow_id: "execution_replay_canary".to_string(),
        deterministic_seed: "phase2_seed".to_string(),
        pause_resume_contract: vec![
            "cursor_monotonic".to_string(),
            "digest_sha256_indexed_events".to_string(),
            "replay_drift_zero".to_string(),
            "pause_requires_explicit_step_flag".to_string(),
        ],
        steps: vec![
            EmbeddedExecutionStep {
                id: "collect".to_string(),
                kind: "task".to_string(),
                action: "collect_data".to_string(),
                command: "collect --source=eyes".to_string(),
                pause_after: false,
            },
            EmbeddedExecutionStep {
                id: "score".to_string(),
                kind: "task".to_string(),
                action: "score".to_string(),
                command: "score --strategy=deterministic".to_string(),
                pause_after: true,
            },
            EmbeddedExecutionStep {
                id: "ship".to_string(),
                kind: "task".to_string(),
                action: "ship".to_string(),
                command: "ship --mode=canary".to_string(),
                pause_after: false,
            },
        ],
        receipt_model: EmbeddedExecutionReceiptModel {
            deterministic: true,
            replayable: true,
            digest_algorithm: "sha256(index:event|)".to_string(),
            status_cycle: vec![
                "running".to_string(),
                "paused".to_string(),
                "completed".to_string(),
            ],
            state_fields: vec![
                "cursor".to_string(),
                "paused".to_string(),
                "completed".to_string(),
                "last_step_id".to_string(),
                "processed_step_ids".to_string(),
                "processed_events".to_string(),
                "digest".to_string(),
            ],
        },
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn default_vault_policy_sample() -> EmbeddedVaultPolicy {
    EmbeddedVaultPolicy {
        policy_id: "vault_policy_primary".to_string(),
        version: 1,
        key_domain: "protheus_runtime_vault".to_string(),
        cryptographic_profile: "fhe_bfv+zkp_groth16".to_string(),
        attestation_chain: vec![
            "hsm_root_attestation".to_string(),
            "runtime_measurement_attestation".to_string(),
            "operator_dual_control_attestation".to_string(),
        ],
        auto_rotate: EmbeddedVaultAutoRotatePolicy {
            enabled: true,
            rotate_after_hours: 24,
            max_key_age_hours: 72,
            grace_window_minutes: 20,
            quorum_required: 2,
            emergency_rotate_on_tamper: true,
        },
        rules: vec![
            EmbeddedVaultPolicyRule {
                id: "vault.zk.required".to_string(),
                objective: "Every seal/unseal request carries non-interactive zero-knowledge proof."
                    .to_string(),
                zk_requirement: "proof_required_for_key_open".to_string(),
                fhe_requirement: "ciphertext_only_in_compute_lane".to_string(),
                severity: "critical".to_string(),
                fail_closed: true,
            },
            EmbeddedVaultPolicyRule {
                id: "vault.fhe.policy".to_string(),
                objective: "Homomorphic operations remain bounded and deterministic."
                    .to_string(),
                zk_requirement: "proof_links_ciphertext_to_policy".to_string(),
                fhe_requirement: "noise_budget_min_threshold".to_string(),
                severity: "high".to_string(),
                fail_closed: true,
            },
            EmbeddedVaultPolicyRule {
                id: "vault.rotation.window".to_string(),
                objective:
                    "Automatic key rotation executes before max age or immediately after tamper signal."
                        .to_string(),
                zk_requirement: "proof_of_previous_key_revocation".to_string(),
                fhe_requirement: "reencrypt_on_rotate".to_string(),
                severity: "critical".to_string(),
                fail_closed: true,
            },
            EmbeddedVaultPolicyRule {
                id: "vault.audit.trace".to_string(),
                objective: "Every key event emits signed immutable receipt.".to_string(),
                zk_requirement: "proof_receipt_binding".to_string(),
                fhe_requirement: "receipt_contains_ciphertext_digest".to_string(),
                severity: "medium".to_string(),
                fail_closed: true,
            },
        ],
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn default_observability_profile_sample() -> EmbeddedObservabilityProfile {
    EmbeddedObservabilityProfile {
        profile_id: "observability_profile_primary".to_string(),
        version: 1,
        red_legion_trace_channels: vec![
            "runtime.guardrails".to_string(),
            "lane.integrity".to_string(),
            "chaos.replay".to_string(),
            "sovereignty.index".to_string(),
        ],
        allowed_emitters: vec![
            "client/systems/observability".to_string(),
            "client/systems/red_legion".to_string(),
            "client/systems/security".to_string(),
            "core/layer1/observability".to_string(),
        ],
        stream_policy: EmbeddedTraceStreamPolicy {
            trace_window_ms: 1000,
            max_events_per_window: 1024,
            min_sampling_rate_pct: 25,
            redact_fields: vec![
                "secret".to_string(),
                "token".to_string(),
                "private_key".to_string(),
                "api_key".to_string(),
            ],
            require_signature: true,
        },
        sovereignty_scorer: EmbeddedSovereigntyScorer {
            integrity_weight_pct: 45,
            continuity_weight_pct: 25,
            reliability_weight_pct: 20,
            chaos_penalty_pct: 10,
            fail_closed_threshold_pct: 60,
        },
        chaos_hooks: vec![
            EmbeddedChaosHook {
                id: "hook.fail_closed.on_tamper".to_string(),
                condition: "event.severity == critical && event.tag == tamper".to_string(),
                action: "trip_fail_closed".to_string(),
                severity: "critical".to_string(),
                enabled: true,
            },
            EmbeddedChaosHook {
                id: "hook.rate_limit.on_storm".to_string(),
                condition: "window.events > max_events_per_window".to_string(),
                action: "drop_low_priority".to_string(),
                severity: "high".to_string(),
                enabled: true,
            },
            EmbeddedChaosHook {
                id: "hook.score_penalty.on_drift".to_string(),
                condition: "replay.drift > 0".to_string(),
                action: "apply_chaos_penalty".to_string(),
                severity: "medium".to_string(),
                enabled: true,
            },
        ],
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn write_embedded_blob_assets(heartbeat_sample: &str) -> Result<BlobPackReport, BlobError> {
    let heartbeat_payload = if heartbeat_sample.trim().is_empty() {
        default_heartbeat_sample()
    } else {
        heartbeat_sample.to_string()
    };
    let execution_payload = default_execution_replay_sample();
    let vault_policy_payload = default_vault_policy_sample();
    let observability_payload = default_observability_profile_sample();

    let (heartbeat_blob, heartbeat_hash) = fold_blob(&heartbeat_payload, HEARTBEAT_BLOB_ID)?;
    let (execution_blob, execution_hash) = fold_blob(&execution_payload, EXECUTION_REPLAY_BLOB_ID)?;
    let (vault_policy_blob, vault_policy_hash) =
        fold_blob(&vault_policy_payload, VAULT_POLICY_BLOB_ID)?;
    let (observability_blob, observability_hash) =
        fold_blob(&observability_payload, OBSERVABILITY_PROFILE_BLOB_ID)?;
    let manifest = generate_manifest(&[
        (HEARTBEAT_BLOB_ID, heartbeat_blob.as_slice()),
        (EXECUTION_REPLAY_BLOB_ID, execution_blob.as_slice()),
        (VAULT_POLICY_BLOB_ID, vault_policy_blob.as_slice()),
        (OBSERVABILITY_PROFILE_BLOB_ID, observability_blob.as_slice()),
    ]);
    let manifest_bytes = encode_manifest(&manifest)?;

    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let heartbeat_path = root.join("src/blobs/heartbeat_sample.blob");
    let execution_path = root.join("src/blobs/execution_replay.blob");
    let vault_policy_path = root.join("src/blobs/vault_policy.blob");
    let observability_path = root.join("src/blobs/observability_profile.blob");
    let manifest_path = root.join("src/blobs/manifest.blob");

    if let Some(parent) = heartbeat_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| BlobError::IoFailed(e.to_string()))?;
    }

    std::fs::write(&heartbeat_path, &heartbeat_blob)
        .map_err(|e| BlobError::IoFailed(e.to_string()))?;
    std::fs::write(&execution_path, &execution_blob)
        .map_err(|e| BlobError::IoFailed(e.to_string()))?;
    std::fs::write(&vault_policy_path, &vault_policy_blob)
        .map_err(|e| BlobError::IoFailed(e.to_string()))?;
    std::fs::write(&observability_path, &observability_blob)
        .map_err(|e| BlobError::IoFailed(e.to_string()))?;
    std::fs::write(&manifest_path, &manifest_bytes)
        .map_err(|e| BlobError::IoFailed(e.to_string()))?;

    Ok(BlobPackReport {
        manifest_path: manifest_path.display().to_string(),
        manifest_bytes: manifest_bytes.len(),
        artifacts: vec![
            BlobArtifactDigest {
                id: HEARTBEAT_BLOB_ID.to_string(),
                path: heartbeat_path.display().to_string(),
                bytes: heartbeat_blob.len(),
                hash: heartbeat_hash,
            },
            BlobArtifactDigest {
                id: EXECUTION_REPLAY_BLOB_ID.to_string(),
                path: execution_path.display().to_string(),
                bytes: execution_blob.len(),
                hash: execution_hash,
            },
            BlobArtifactDigest {
                id: VAULT_POLICY_BLOB_ID.to_string(),
                path: vault_policy_path.display().to_string(),
                bytes: vault_policy_blob.len(),
                hash: vault_policy_hash,
            },
            BlobArtifactDigest {
                id: OBSERVABILITY_PROFILE_BLOB_ID.to_string(),
                path: observability_path.display().to_string(),
                bytes: observability_blob.len(),
                hash: observability_hash,
            },
        ],
    })
}

#[cfg(target_arch = "wasm32")]
pub fn write_embedded_blob_assets(_heartbeat_sample: &str) -> Result<BlobPackReport, BlobError> {
    Err(BlobError::IoFailed(
        "write_embedded_blob_assets_unavailable_on_wasm".to_string(),
    ))
}

fn embedded_blob_by_id(blob_id: &str) -> Option<&'static [u8]> {
    match blob_id {
        HEARTBEAT_BLOB_ID => Some(HEARTBEAT_BLOB),
        EXECUTION_REPLAY_BLOB_ID => Some(EXECUTION_REPLAY_BLOB),
        VAULT_POLICY_BLOB_ID => Some(VAULT_POLICY_BLOB),
        OBSERVABILITY_PROFILE_BLOB_ID => Some(OBSERVABILITY_PROFILE_BLOB),
        _ => None,
    }
}

fn manifest_hash_for(manifest: &[BlobManifest], blob_id: &str) -> Result<String, BlobError> {
    manifest
        .iter()
        .find(|entry| entry.id == blob_id)
        .map(|entry| entry.hash.clone())
        .ok_or_else(|| BlobError::MissingManifestEntry(blob_id.to_string()))
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
    fn fold_embed_unfold_mock_heartbeat_parity() {
        let input = "# HEARTBEAT\\n- check inbox\\n- ship artifacts".to_string();
        let (blob, hash) = fold_blob(&input, HEARTBEAT_BLOB_ID).expect("fold should succeed");
        let manifest = generate_manifest(&[(HEARTBEAT_BLOB_ID, blob.as_slice())]);
        let payload = unfold_blob_from_parts(HEARTBEAT_BLOB_ID, &hash, &blob, &manifest)
            .expect("unfold should succeed");
        let decoded: String = bincode::deserialize(&payload).expect("decode should succeed");
        assert_eq!(decoded, input);
    }

    #[test]
    fn fold_embed_unfold_execution_replay_parity() {
        let input = default_execution_replay_sample();
        let (blob, hash) =
            fold_blob(&input, EXECUTION_REPLAY_BLOB_ID).expect("fold should succeed");
        let manifest = generate_manifest(&[(EXECUTION_REPLAY_BLOB_ID, blob.as_slice())]);
        let payload = unfold_blob_from_parts(EXECUTION_REPLAY_BLOB_ID, &hash, &blob, &manifest)
            .expect("unfold should succeed");
        let decoded: EmbeddedExecutionReplay =
            bincode::deserialize(&payload).expect("decode should succeed");
        assert_eq!(decoded, input);
    }

    #[test]
    fn fold_embed_unfold_vault_policy_parity() {
        let input = default_vault_policy_sample();
        let (blob, hash) = fold_blob(&input, VAULT_POLICY_BLOB_ID).expect("fold should succeed");
        let manifest = generate_manifest(&[(VAULT_POLICY_BLOB_ID, blob.as_slice())]);
        let payload = unfold_blob_from_parts(VAULT_POLICY_BLOB_ID, &hash, &blob, &manifest)
            .expect("unfold should succeed");
        let decoded: EmbeddedVaultPolicy =
            bincode::deserialize(&payload).expect("decode should succeed");
        assert_eq!(decoded, input);
    }

    #[test]
    fn fold_embed_unfold_observability_profile_parity() {
        let input = default_observability_profile_sample();
        let (blob, hash) =
            fold_blob(&input, OBSERVABILITY_PROFILE_BLOB_ID).expect("fold should succeed");
        let manifest = generate_manifest(&[(OBSERVABILITY_PROFILE_BLOB_ID, blob.as_slice())]);
        let payload =
            unfold_blob_from_parts(OBSERVABILITY_PROFILE_BLOB_ID, &hash, &blob, &manifest)
                .expect("unfold should succeed");
        let decoded: EmbeddedObservabilityProfile =
            bincode::deserialize(&payload).expect("decode should succeed");
        assert_eq!(decoded, input);
    }

    #[test]
    fn embedded_blobs_load() {
        let heartbeat = load_embedded_heartbeat().expect("embedded heartbeat should load");
        assert!(!heartbeat.trim().is_empty());
        let replay =
            load_embedded_execution_replay().expect("embedded execution replay should load");
        assert_eq!(replay.workflow_id, "execution_replay_canary");
        assert!(replay.steps.len() >= 3);
        let vault_policy = load_embedded_vault_policy().expect("embedded vault policy should load");
        assert_eq!(vault_policy.policy_id, "vault_policy_primary");
        assert!(!vault_policy.rules.is_empty());
        let observability = load_embedded_observability_profile()
            .expect("embedded observability profile should load");
        assert_eq!(observability.profile_id, "observability_profile_primary");
        assert!(!observability.chaos_hooks.is_empty());
    }
}
