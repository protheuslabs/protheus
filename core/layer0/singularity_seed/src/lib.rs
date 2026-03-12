// SPDX-License-Identifier: Apache-2.0
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use snap::raw::{Decoder, Encoder};
use std::collections::HashMap;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};

const BLOB_VERSION: u32 = 1;
const MANIFEST_SIGNING_KEY: &str = "singularity-seed-manifest-signing-key-v1";
const DRIFT_FAIL_CLOSED_THRESHOLD_PCT: f64 = 2.0;

pub const AUTOGENESIS_LOOP_ID: &str = "autogenesis_loop";
pub const DUAL_BRAIN_LOOP_ID: &str = "dual_brain_loop";
pub const RED_LEGION_LOOP_ID: &str = "red_legion_loop";
pub const BLOB_MORPHING_LOOP_ID: &str = "blob_morphing_loop";

pub const LOOP_IDS: [&str; 4] = [
    AUTOGENESIS_LOOP_ID,
    DUAL_BRAIN_LOOP_ID,
    RED_LEGION_LOOP_ID,
    BLOB_MORPHING_LOOP_ID,
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlobManifestEntry {
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LoopState {
    pub loop_id: String,
    pub generation: u32,
    pub quality_score: f64,
    pub drift_pct: f64,
    pub last_mutation: String,
    pub insights: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LoopCycleOutcome {
    pub loop_id: String,
    pub previous_generation: u32,
    pub next_generation: u32,
    pub drift_pct: f64,
    pub frozen_hash: String,
    pub evolved_hash: String,
    pub unfolded_hash: String,
    pub unfolded_match: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CycleReport {
    pub ok: bool,
    pub fail_closed: bool,
    pub max_drift_pct: f64,
    pub threshold_pct: f64,
    pub sovereignty_index: f64,
    pub cycle_id: String,
    pub status: String,
    pub reasons: Vec<String>,
    pub manifest_path: String,
    pub outcomes: Vec<LoopCycleOutcome>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DriftOverride {
    pub loop_id: String,
    pub drift_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct CycleRequest {
    #[serde(default)]
    pub drift_overrides: Vec<DriftOverride>,
}

#[derive(Debug, Clone)]
pub enum SeedError {
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
    InvalidRequest(String),
}

impl Display for SeedError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            SeedError::InvalidBlobId => write!(f, "blob_id_required"),
            SeedError::UnknownBlob(blob_id) => write!(f, "unknown_blob_id:{blob_id}"),
            SeedError::MissingManifestEntry(blob_id) => {
                write!(f, "manifest_missing_blob:{blob_id}")
            }
            SeedError::MissingSignature(blob_id) => {
                write!(f, "manifest_missing_signature:{blob_id}")
            }
            SeedError::SignatureMismatch {
                id,
                expected,
                actual,
            } => write!(
                f,
                "manifest_signature_mismatch id={id} expected={expected} actual={actual}"
            ),
            SeedError::HashMismatch {
                scope,
                expected,
                actual,
            } => write!(
                f,
                "blob_hash_mismatch scope={scope} expected={expected} actual={actual}"
            ),
            SeedError::IdMismatch { expected, actual } => {
                write!(f, "blob_id_mismatch expected={expected} actual={actual}")
            }
            SeedError::UnsupportedVersion { id, version } => {
                write!(f, "unsupported_blob_version id={id} version={version}")
            }
            SeedError::SerializeFailed(msg) => write!(f, "serialize_failed:{msg}"),
            SeedError::DeserializeFailed(msg) => write!(f, "deserialize_failed:{msg}"),
            SeedError::CompressFailed(msg) => write!(f, "compress_failed:{msg}"),
            SeedError::DecompressFailed(msg) => write!(f, "decompress_failed:{msg}"),
            SeedError::ManifestEncodeFailed(msg) => write!(f, "manifest_encode_failed:{msg}"),
            SeedError::ManifestDecodeFailed(msg) => write!(f, "manifest_decode_failed:{msg}"),
            SeedError::IoFailed(msg) => write!(f, "io_failed:{msg}"),
            SeedError::InvalidRequest(msg) => write!(f, "invalid_request:{msg}"),
        }
    }
}

impl std::error::Error for SeedError {}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn manifest_signature(id: &str, hash: &str, version: u32) -> String {
    let payload = format!("{id}:{hash}:{version}:{MANIFEST_SIGNING_KEY}");
    sha256_hex(payload.as_bytes())
}

fn verify_manifest_entry(entry: &BlobManifestEntry) -> Result<(), SeedError> {
    let actual = entry
        .signature
        .as_ref()
        .ok_or_else(|| SeedError::MissingSignature(entry.id.clone()))?;
    let expected = manifest_signature(&entry.id, &entry.hash, entry.version);
    if !actual.eq_ignore_ascii_case(&expected) {
        return Err(SeedError::SignatureMismatch {
            id: entry.id.clone(),
            expected,
            actual: actual.clone(),
        });
    }
    Ok(())
}

pub fn fold_blob<T: Serialize>(data: &T, blob_id: &str) -> Result<(Vec<u8>, String), SeedError> {
    if blob_id.trim().is_empty() {
        return Err(SeedError::InvalidBlobId);
    }
    let payload =
        bincode::serialize(data).map_err(|err| SeedError::SerializeFailed(err.to_string()))?;
    let folded = FoldedBlob {
        id: blob_id.to_string(),
        version: BLOB_VERSION,
        payload,
    };
    let encoded =
        bincode::serialize(&folded).map_err(|err| SeedError::SerializeFailed(err.to_string()))?;
    let compressed = Encoder::new()
        .compress_vec(&encoded)
        .map_err(|err| SeedError::CompressFailed(err.to_string()))?;
    let hash = sha256_hex(&compressed);
    Ok((compressed, hash))
}

pub fn generate_manifest(blobs: &[(&str, &[u8])]) -> Vec<BlobManifestEntry> {
    blobs
        .iter()
        .map(|(blob_id, blob_bytes)| {
            let hash = sha256_hex(blob_bytes);
            BlobManifestEntry {
                id: (*blob_id).to_string(),
                hash: hash.clone(),
                version: BLOB_VERSION,
                signature: Some(manifest_signature(blob_id, &hash, BLOB_VERSION)),
            }
        })
        .collect()
}

pub fn encode_manifest(entries: &[BlobManifestEntry]) -> Result<Vec<u8>, SeedError> {
    bincode::serialize(entries).map_err(|err| SeedError::ManifestEncodeFailed(err.to_string()))
}

pub fn decode_manifest(bytes: &[u8]) -> Result<Vec<BlobManifestEntry>, SeedError> {
    bincode::deserialize(bytes).map_err(|err| SeedError::ManifestDecodeFailed(err.to_string()))
}

pub fn unfold_blob_typed<T: DeserializeOwned>(
    blob_id: &str,
    expected_hash: &str,
    blob_bytes: &[u8],
    manifest: &[BlobManifestEntry],
) -> Result<T, SeedError> {
    let entry = manifest
        .iter()
        .find(|entry| entry.id == blob_id)
        .ok_or_else(|| SeedError::MissingManifestEntry(blob_id.to_string()))?;

    verify_manifest_entry(entry)?;

    if !entry.hash.eq_ignore_ascii_case(expected_hash) {
        return Err(SeedError::HashMismatch {
            scope: "expected_vs_manifest",
            expected: entry.hash.clone(),
            actual: expected_hash.to_string(),
        });
    }

    let actual_hash = sha256_hex(blob_bytes);
    if !actual_hash.eq_ignore_ascii_case(&entry.hash) {
        return Err(SeedError::HashMismatch {
            scope: "blob_vs_manifest",
            expected: entry.hash.clone(),
            actual: actual_hash,
        });
    }

    let decompressed = Decoder::new()
        .decompress_vec(blob_bytes)
        .map_err(|err| SeedError::DecompressFailed(err.to_string()))?;
    let folded: FoldedBlob = bincode::deserialize(&decompressed)
        .map_err(|err| SeedError::DeserializeFailed(err.to_string()))?;

    if folded.id != blob_id {
        return Err(SeedError::IdMismatch {
            expected: blob_id.to_string(),
            actual: folded.id,
        });
    }

    if folded.version != BLOB_VERSION {
        return Err(SeedError::UnsupportedVersion {
            id: blob_id.to_string(),
            version: folded.version,
        });
    }

    bincode::deserialize(&folded.payload)
        .map_err(|err| SeedError::DeserializeFailed(err.to_string()))
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn blob_root() -> PathBuf {
    if let Ok(explicit) = std::env::var("PROTHEUS_SINGULARITY_BLOB_DIR") {
        if !explicit.trim().is_empty() {
            return PathBuf::from(explicit);
        }
    }
    repo_root().join("client/runtime/systems/singularity_seed/blobs")
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join("manifest.blob")
}

fn loop_blob_path(root: &Path, loop_id: &str) -> PathBuf {
    root.join(format!("{loop_id}.blob"))
}

fn default_states() -> Vec<LoopState> {
    vec![
        LoopState {
            loop_id: AUTOGENESIS_LOOP_ID.to_string(),
            generation: 1,
            quality_score: 72.0,
            drift_pct: 1.1,
            last_mutation: "bootstrap_seed".to_string(),
            insights: vec![
                "spawn candidates ranked by quality receipts".to_string(),
                "promote only after deterministic replay".to_string(),
            ],
        },
        LoopState {
            loop_id: DUAL_BRAIN_LOOP_ID.to_string(),
            generation: 1,
            quality_score: 75.0,
            drift_pct: 0.9,
            last_mutation: "bootstrap_seed".to_string(),
            insights: vec![
                "human feedback weights loop reward model".to_string(),
                "symbiosis checkpoints protect intent fidelity".to_string(),
            ],
        },
        LoopState {
            loop_id: RED_LEGION_LOOP_ID.to_string(),
            generation: 1,
            quality_score: 70.0,
            drift_pct: 1.4,
            last_mutation: "bootstrap_seed".to_string(),
            insights: vec![
                "chaos inversion catches weak assumptions".to_string(),
                "2pct drift line triggers sovereignty scrutiny".to_string(),
            ],
        },
        LoopState {
            loop_id: BLOB_MORPHING_LOOP_ID.to_string(),
            generation: 1,
            quality_score: 73.5,
            drift_pct: 0.8,
            last_mutation: "bootstrap_seed".to_string(),
            insights: vec![
                "freeze evolve unfold parity enforced".to_string(),
                "manifest signatures gate blob mutation".to_string(),
            ],
        },
    ]
}

fn evolution_profile(loop_id: &str) -> (f64, f64) {
    match loop_id {
        AUTOGENESIS_LOOP_ID => (1.2, 0.65),
        DUAL_BRAIN_LOOP_ID => (0.9, 0.55),
        RED_LEGION_LOOP_ID => (1.4, 0.8),
        BLOB_MORPHING_LOOP_ID => (1.0, 0.6),
        _ => (0.5, 0.5),
    }
}

fn evolve_state(state: &LoopState) -> LoopState {
    let (quality_gain, drift_decay) = evolution_profile(&state.loop_id);
    let evolved_quality = (state.quality_score + quality_gain).clamp(0.0, 100.0);
    let evolved_drift = (state.drift_pct * drift_decay).clamp(0.0, 5.0);

    let mut insights = state.insights.clone();
    insights.push(format!(
        "generation_{}: quality+{:.2} drift->{:.3}",
        state.generation + 1,
        quality_gain,
        evolved_drift
    ));

    LoopState {
        loop_id: state.loop_id.clone(),
        generation: state.generation + 1,
        quality_score: round3(evolved_quality),
        drift_pct: round3(evolved_drift),
        last_mutation: "evolved_by_singularity_seed_orchestrator".to_string(),
        insights,
    }
}

fn apply_drift_overrides(states: &mut [LoopState], overrides: &[DriftOverride]) {
    for override_item in overrides {
        if let Some(state) = states
            .iter_mut()
            .find(|state| state.loop_id == override_item.loop_id)
        {
            state.drift_pct = round3(override_item.drift_pct.max(0.0));
            state.insights.push(format!(
                "override_applied: drift_pct={:.3}",
                state.drift_pct
            ));
        }
    }
}

fn ensure_blob_root(root: &Path) -> Result<(), SeedError> {
    std::fs::create_dir_all(root).map_err(|err| SeedError::IoFailed(err.to_string()))
}

fn freeze_states(states: &[LoopState], root: &Path) -> Result<Vec<BlobManifestEntry>, SeedError> {
    ensure_blob_root(root)?;

    let mut blob_storage: Vec<(String, Vec<u8>)> = Vec::new();
    for loop_id in LOOP_IDS {
        let state = states
            .iter()
            .find(|row| row.loop_id == loop_id)
            .ok_or_else(|| SeedError::UnknownBlob(loop_id.to_string()))?;
        let (blob_bytes, _) = fold_blob(state, loop_id)?;
        std::fs::write(loop_blob_path(root, loop_id), &blob_bytes)
            .map_err(|err| SeedError::IoFailed(err.to_string()))?;
        blob_storage.push((loop_id.to_string(), blob_bytes));
    }

    let manifest_refs = blob_storage
        .iter()
        .map(|(id, bytes)| (id.as_str(), bytes.as_slice()))
        .collect::<Vec<_>>();
    let manifest = generate_manifest(&manifest_refs);
    let manifest_bytes = encode_manifest(&manifest)?;
    std::fs::write(manifest_path(root), &manifest_bytes)
        .map_err(|err| SeedError::IoFailed(err.to_string()))?;

    Ok(manifest)
}

fn load_states(root: &Path) -> Result<(Vec<LoopState>, Vec<BlobManifestEntry>), SeedError> {
    let manifest_raw =
        std::fs::read(manifest_path(root)).map_err(|err| SeedError::IoFailed(err.to_string()))?;
    let manifest = decode_manifest(&manifest_raw)?;

    let mut loaded = Vec::new();
    for loop_id in LOOP_IDS {
        let entry = manifest
            .iter()
            .find(|row| row.id == loop_id)
            .ok_or_else(|| SeedError::MissingManifestEntry(loop_id.to_string()))?;

        let blob_bytes = std::fs::read(loop_blob_path(root, loop_id))
            .map_err(|err| SeedError::IoFailed(err.to_string()))?;

        let state: LoopState = unfold_blob_typed(loop_id, &entry.hash, &blob_bytes, &manifest)?;
        loaded.push(state);
    }

    Ok((loaded, manifest))
}

fn ensure_materialized(root: &Path) -> Result<(), SeedError> {
    let manifest_exists = manifest_path(root).exists();
    let all_blobs_exist = LOOP_IDS
        .iter()
        .all(|loop_id| loop_blob_path(root, loop_id).exists());

    if manifest_exists && all_blobs_exist {
        return Ok(());
    }

    let defaults = default_states();
    freeze_states(&defaults, root)?;
    Ok(())
}

pub fn freeze_seed() -> Result<CycleReport, SeedError> {
    let root = blob_root();
    ensure_blob_root(&root)?;
    let states = default_states();
    let manifest = freeze_states(&states, &root)?;

    let outcomes = manifest
        .iter()
        .map(|entry| LoopCycleOutcome {
            loop_id: entry.id.clone(),
            previous_generation: 0,
            next_generation: 1,
            drift_pct: states
                .iter()
                .find(|s| s.loop_id == entry.id)
                .map(|s| s.drift_pct)
                .unwrap_or(0.0),
            frozen_hash: entry.hash.clone(),
            evolved_hash: entry.hash.clone(),
            unfolded_hash: entry.hash.clone(),
            unfolded_match: true,
        })
        .collect::<Vec<_>>();

    Ok(CycleReport {
        ok: true,
        fail_closed: false,
        max_drift_pct: states
            .iter()
            .map(|row| row.drift_pct)
            .fold(0.0_f64, f64::max),
        threshold_pct: DRIFT_FAIL_CLOSED_THRESHOLD_PCT,
        sovereignty_index: 75.0,
        cycle_id: "seed_freeze_bootstrap".to_string(),
        status: "seeded".to_string(),
        reasons: vec![],
        manifest_path: manifest_path(&root).display().to_string(),
        outcomes,
    })
}

pub fn run_guarded_cycle(request: &CycleRequest) -> Result<CycleReport, SeedError> {
    let root = blob_root();
    ensure_materialized(&root)?;

    let (previous_states, previous_manifest) = load_states(&root)?;

    let mut evolved_states = previous_states.iter().map(evolve_state).collect::<Vec<_>>();
    apply_drift_overrides(&mut evolved_states, &request.drift_overrides);

    let evolved_manifest = freeze_states(&evolved_states, &root)?;
    let (unfolded_states, unfolded_manifest) = load_states(&root)?;

    let previous_state_map = previous_states
        .iter()
        .map(|row| (row.loop_id.clone(), row.clone()))
        .collect::<HashMap<_, _>>();
    let evolved_state_map = evolved_states
        .iter()
        .map(|row| (row.loop_id.clone(), row.clone()))
        .collect::<HashMap<_, _>>();
    let unfolded_state_map = unfolded_states
        .iter()
        .map(|row| (row.loop_id.clone(), row.clone()))
        .collect::<HashMap<_, _>>();

    let previous_hash_map = previous_manifest
        .iter()
        .map(|row| (row.id.clone(), row.hash.clone()))
        .collect::<HashMap<_, _>>();
    let evolved_hash_map = evolved_manifest
        .iter()
        .map(|row| (row.id.clone(), row.hash.clone()))
        .collect::<HashMap<_, _>>();
    let unfolded_hash_map = unfolded_manifest
        .iter()
        .map(|row| (row.id.clone(), row.hash.clone()))
        .collect::<HashMap<_, _>>();

    let mut outcomes = Vec::new();
    let mut reasons = Vec::new();
    let mut max_drift_pct = 0.0_f64;

    for loop_id in LOOP_IDS {
        let prev = previous_state_map
            .get(loop_id)
            .ok_or_else(|| SeedError::UnknownBlob(loop_id.to_string()))?;
        let evolved = evolved_state_map
            .get(loop_id)
            .ok_or_else(|| SeedError::UnknownBlob(loop_id.to_string()))?;
        let unfolded = unfolded_state_map
            .get(loop_id)
            .ok_or_else(|| SeedError::UnknownBlob(loop_id.to_string()))?;

        let unfolded_match = unfolded.generation == evolved.generation
            && (unfolded.quality_score - evolved.quality_score).abs() < 0.0001
            && (unfolded.drift_pct - evolved.drift_pct).abs() < 0.0001;

        max_drift_pct = max_drift_pct.max(unfolded.drift_pct);
        if unfolded.drift_pct > DRIFT_FAIL_CLOSED_THRESHOLD_PCT {
            reasons.push(format!(
                "drift_threshold_exceeded:{}={:.3}%",
                loop_id, unfolded.drift_pct
            ));
        }
        if !unfolded_match {
            reasons.push(format!("unfold_mismatch:{loop_id}"));
        }

        outcomes.push(LoopCycleOutcome {
            loop_id: loop_id.to_string(),
            previous_generation: prev.generation,
            next_generation: unfolded.generation,
            drift_pct: round3(unfolded.drift_pct),
            frozen_hash: previous_hash_map
                .get(loop_id)
                .cloned()
                .unwrap_or_else(|| "unknown".to_string()),
            evolved_hash: evolved_hash_map
                .get(loop_id)
                .cloned()
                .unwrap_or_else(|| "unknown".to_string()),
            unfolded_hash: unfolded_hash_map
                .get(loop_id)
                .cloned()
                .unwrap_or_else(|| "unknown".to_string()),
            unfolded_match,
        });
    }

    let fail_closed = max_drift_pct > DRIFT_FAIL_CLOSED_THRESHOLD_PCT;
    let avg_quality = unfolded_states
        .iter()
        .map(|row| row.quality_score)
        .sum::<f64>()
        / unfolded_states.len().max(1) as f64;
    let sovereignty_index = {
        let drift_penalty = max_drift_pct * 12.5;
        let fail_penalty = if fail_closed { 18.0 } else { 0.0 };
        round3((avg_quality - drift_penalty - fail_penalty).clamp(0.0, 100.0))
    };

    let cycle_digest = sha256_hex(
        serde_json::to_string(&outcomes)
            .unwrap_or_else(|_| "[]".to_string())
            .as_bytes(),
    );

    let status = if fail_closed {
        "fail_closed".to_string()
    } else {
        "stable".to_string()
    };

    Ok(CycleReport {
        ok: !fail_closed,
        fail_closed,
        max_drift_pct: round3(max_drift_pct),
        threshold_pct: DRIFT_FAIL_CLOSED_THRESHOLD_PCT,
        sovereignty_index,
        cycle_id: format!("ssc-{}", &cycle_digest[..16]),
        status,
        reasons,
        manifest_path: manifest_path(&root).display().to_string(),
        outcomes,
    })
}

pub fn run_guarded_cycle_json(request_json: &str) -> Result<String, SeedError> {
    let request: CycleRequest = if request_json.trim().is_empty() {
        CycleRequest::default()
    } else {
        serde_json::from_str(request_json)
            .map_err(|err| SeedError::InvalidRequest(format!("request_parse_failed:{err}")))?
    };

    let report = run_guarded_cycle(&request)?;
    serde_json::to_string(&report).map_err(|err| SeedError::SerializeFailed(err.to_string()))
}

pub fn show_seed_state_json() -> Result<String, SeedError> {
    let root = blob_root();
    ensure_materialized(&root)?;
    let (states, manifest) = load_states(&root)?;

    let payload = serde_json::json!({
      "ok": true,
      "blob_root": root.display().to_string(),
      "manifest_path": manifest_path(&root).display().to_string(),
      "manifest": manifest,
      "states": states
    });
    serde_json::to_string(&payload).map_err(|err| SeedError::SerializeFailed(err.to_string()))
}

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn run_guarded_cycle_wasm(request_json: &str) -> String {
    match run_guarded_cycle_json(request_json) {
        Ok(payload) => payload,
        Err(err) => serde_json::json!({ "ok": false, "error": err.to_string() }).to_string(),
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn show_seed_state_wasm() -> String {
    match show_seed_state_json() {
        Ok(payload) => payload,
        Err(err) => serde_json::json!({ "ok": false, "error": err.to_string() }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    };

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn temp_blob_root() -> PathBuf {
        let counter = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "protheus-singularity-seed-test-{}-{}",
            std::process::id(),
            counter
        ));
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn cycle_runs_and_advances_generation() {
        let _lock = ENV_LOCK.lock().expect("lock env");
        let root = temp_blob_root();
        std::env::set_var("PROTHEUS_SINGULARITY_BLOB_DIR", root.display().to_string());

        let report = run_guarded_cycle(&CycleRequest::default()).expect("cycle should run");
        assert!(report.ok);
        assert!(!report.fail_closed);
        assert_eq!(report.outcomes.len(), 4);
        assert!(report.outcomes.iter().all(|row| row.next_generation >= 2));

        std::env::remove_var("PROTHEUS_SINGULARITY_BLOB_DIR");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cycle_fail_closed_when_drift_exceeds_threshold() {
        let _lock = ENV_LOCK.lock().expect("lock env");
        let root = temp_blob_root();
        std::env::set_var("PROTHEUS_SINGULARITY_BLOB_DIR", root.display().to_string());

        let request = CycleRequest {
            drift_overrides: vec![DriftOverride {
                loop_id: RED_LEGION_LOOP_ID.to_string(),
                drift_pct: 2.4,
            }],
        };
        let report = run_guarded_cycle(&request).expect("cycle should run");
        assert!(!report.ok);
        assert!(report.fail_closed);
        assert!(report.max_drift_pct > DRIFT_FAIL_CLOSED_THRESHOLD_PCT);

        std::env::remove_var("PROTHEUS_SINGULARITY_BLOB_DIR");
        let _ = std::fs::remove_dir_all(root);
    }
}
