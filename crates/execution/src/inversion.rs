use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeImpactInput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeImpactOutput {
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeModeInput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeModeOutput {
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeTargetInput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeTargetOutput {
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeResultInput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeResultOutput {
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ObjectiveIdValidInput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ObjectiveIdValidOutput {
    pub valid: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct TritVectorFromInputInput {
    #[serde(default)]
    pub trit_vector: Option<Vec<Value>>,
    #[serde(default)]
    pub trit_vector_csv: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TritVectorFromInputOutput {
    pub vector: Vec<i32>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct JaccardSimilarityInput {
    #[serde(default)]
    pub left_tokens: Vec<String>,
    #[serde(default)]
    pub right_tokens: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct JaccardSimilarityOutput {
    pub similarity: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct TritSimilarityInput {
    #[serde(default)]
    pub query_vector: Vec<Value>,
    #[serde(default)]
    pub entry_trit: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TritSimilarityOutput {
    pub similarity: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CertaintyThresholdInput {
    #[serde(default)]
    pub thresholds: Option<Value>,
    #[serde(default)]
    pub band: Option<String>,
    #[serde(default)]
    pub impact: Option<String>,
    #[serde(default)]
    pub allow_zero_for_legendary_critical: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CertaintyThresholdOutput {
    pub threshold: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct MaxTargetRankInput {
    #[serde(default)]
    pub maturity_max_target_rank_by_band: Option<Value>,
    #[serde(default)]
    pub impact_max_target_rank: Option<Value>,
    #[serde(default)]
    pub maturity_band: Option<String>,
    #[serde(default)]
    pub impact: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MaxTargetRankOutput {
    pub rank: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CreativePenaltyInput {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub preferred_creative_lane_ids: Vec<String>,
    #[serde(default)]
    pub non_creative_certainty_penalty: Option<f64>,
    #[serde(default)]
    pub selected_lane: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CreativePenaltyOutput {
    pub creative_lane_preferred: bool,
    pub selected_lane: Option<String>,
    pub preferred_lanes: Vec<String>,
    pub penalty: f64,
    pub applied: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ExtractBulletsInput {
    #[serde(default)]
    pub markdown: Option<String>,
    #[serde(default)]
    pub max_items: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ExtractBulletsOutput {
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ExtractListItemsInput {
    #[serde(default)]
    pub markdown: Option<String>,
    #[serde(default)]
    pub max_items: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ExtractListItemsOutput {
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ParseSystemInternalPermissionInput {
    #[serde(default)]
    pub markdown: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ParseSystemInternalPermissionOutput {
    pub enabled: bool,
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ParseSoulTokenDataPassRulesInput {
    #[serde(default)]
    pub markdown: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ParseSoulTokenDataPassRulesOutput {
    pub rules: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct EnsureSystemPassedSectionInput {
    #[serde(default)]
    pub feed_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EnsureSystemPassedSectionOutput {
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SystemPassedPayloadHashInput {
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub payload: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SystemPassedPayloadHashOutput {
    pub hash: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct BuildLensPositionInput {
    #[serde(default)]
    pub objective: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub impact: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BuildLensPositionOutput {
    pub position: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct BuildConclaveProposalSummaryInput {
    #[serde(default)]
    pub objective: Option<String>,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub impact: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BuildConclaveProposalSummaryOutput {
    pub summary: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ConclaveHighRiskFlagsInput {
    #[serde(default)]
    pub payload: Option<Value>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub max_divergence: Option<f64>,
    #[serde(default)]
    pub min_confidence: Option<f64>,
    #[serde(default)]
    pub high_risk_keywords: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ConclaveHighRiskFlagsOutput {
    pub flags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct TokenizeTextInput {
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub max_tokens: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TokenizeTextOutput {
    pub tokens: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeListInput {
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub max_len: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeListOutput {
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeTextListInput {
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub max_len: Option<i64>,
    #[serde(default)]
    pub max_items: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeTextListOutput {
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ParseJsonFromStdoutInput {
    #[serde(default)]
    pub raw: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ParseJsonFromStdoutOutput {
    pub parsed: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ParseArgsInput {
    #[serde(default)]
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ParseArgsOutput {
    pub args: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LibraryMatchScoreInput {
    #[serde(default)]
    pub query_signature_tokens: Vec<String>,
    #[serde(default)]
    pub query_trit_vector: Vec<Value>,
    #[serde(default)]
    pub query_target: Option<String>,
    #[serde(default)]
    pub row_signature_tokens: Vec<String>,
    #[serde(default)]
    pub row_outcome_trit: Option<i64>,
    #[serde(default)]
    pub row_target: Option<String>,
    #[serde(default)]
    pub token_weight: Option<f64>,
    #[serde(default)]
    pub trit_weight: Option<f64>,
    #[serde(default)]
    pub target_weight: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LibraryMatchScoreOutput {
    pub score: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct KnownFailurePressureInput {
    #[serde(default)]
    pub candidates: Vec<Value>,
    #[serde(default)]
    pub failed_repetition_similarity_block: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct KnownFailurePressureOutput {
    pub fail_count: i64,
    pub hard_block: bool,
    pub max_similarity: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct HasSignalTermMatchInput {
    #[serde(default)]
    pub haystack: Option<String>,
    #[serde(default)]
    pub token_set: Vec<String>,
    #[serde(default)]
    pub term: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HasSignalTermMatchOutput {
    pub matched: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CountAxiomSignalGroupsInput {
    #[serde(default)]
    pub action_terms: Vec<String>,
    #[serde(default)]
    pub subject_terms: Vec<String>,
    #[serde(default)]
    pub object_terms: Vec<String>,
    #[serde(default)]
    pub min_signal_groups: Option<i64>,
    #[serde(default)]
    pub haystack: Option<String>,
    #[serde(default)]
    pub token_set: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CountAxiomSignalGroupsOutput {
    pub configured_groups: i64,
    pub matched_groups: i64,
    pub required_groups: i64,
    pub pass: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct EffectiveFirstNHumanVetoUsesInput {
    #[serde(default)]
    pub first_live_uses_require_human_veto: Option<Value>,
    #[serde(default)]
    pub minimum_first_live_uses_require_human_veto: Option<Value>,
    #[serde(default)]
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EffectiveFirstNHumanVetoUsesOutput {
    pub uses: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeBandMapInput {
    #[serde(default)]
    pub raw: Option<Value>,
    #[serde(default)]
    pub base: Option<Value>,
    #[serde(default)]
    pub lo: Option<f64>,
    #[serde(default)]
    pub hi: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NormalizeBandMapOutput {
    pub novice: f64,
    pub developing: f64,
    pub mature: f64,
    pub seasoned: f64,
    pub legendary: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeImpactMapInput {
    #[serde(default)]
    pub raw: Option<Value>,
    #[serde(default)]
    pub base: Option<Value>,
    #[serde(default)]
    pub lo: Option<f64>,
    #[serde(default)]
    pub hi: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NormalizeImpactMapOutput {
    pub low: f64,
    pub medium: f64,
    pub high: f64,
    pub critical: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeTargetMapInput {
    #[serde(default)]
    pub raw: Option<Value>,
    #[serde(default)]
    pub base: Option<Value>,
    #[serde(default)]
    pub lo: Option<f64>,
    #[serde(default)]
    pub hi: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NormalizeTargetMapOutput {
    pub tactical: f64,
    pub belief: f64,
    pub identity: f64,
    pub directive: f64,
    pub constitution: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeTargetPolicyInput {
    #[serde(default)]
    pub raw: Option<Value>,
    #[serde(default)]
    pub base: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeTargetPolicyOutput {
    pub rank: i64,
    pub live_enabled: bool,
    pub test_enabled: bool,
    pub require_human_veto_live: bool,
    pub min_shadow_hours: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct WindowDaysForTargetInput {
    #[serde(default)]
    pub window_map: Option<Value>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub fallback: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WindowDaysForTargetOutput {
    pub days: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct TierRetentionDaysInput {
    #[serde(default)]
    pub policy: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TierRetentionDaysOutput {
    pub days: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InversionCandidateRow {
    pub id: String,
    pub filters: Vec<String>,
    pub source: String,
    pub probability: f64,
    pub rationale: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ParseCandidateListFromLlmPayloadInput {
    #[serde(default)]
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ParseCandidateListFromLlmPayloadOutput {
    pub candidates: Vec<InversionCandidateRow>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct HeuristicFilterCandidatesInput {
    #[serde(default)]
    pub objective: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HeuristicFilterCandidatesOutput {
    pub candidates: Vec<InversionCandidateRow>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ScoreTrialInput {
    #[serde(default)]
    pub decision: Option<Value>,
    #[serde(default)]
    pub candidate: Option<Value>,
    #[serde(default)]
    pub trial_cfg: Option<Value>,
    #[serde(default)]
    pub runtime_probe_pass: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ScoreTrialOutput {
    pub score: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct MutateTrialCandidatesInput {
    #[serde(default)]
    pub rows: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MutateTrialCandidatesOutput {
    pub rows: Vec<Value>,
}

fn normalize_token(raw: &str, max_len: usize) -> String {
    let collapsed = raw
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_lowercase();
    collapsed.chars().take(max_len).collect::<String>()
}

pub fn compute_normalize_impact(input: &NormalizeImpactInput) -> NormalizeImpactOutput {
    let raw = normalize_token(input.value.as_deref().unwrap_or("medium"), 24);
    let value = match raw.as_str() {
        "low" | "medium" | "high" | "critical" => raw,
        _ => "medium".to_string(),
    };
    NormalizeImpactOutput { value }
}

pub fn compute_normalize_mode(input: &NormalizeModeInput) -> NormalizeModeOutput {
    let raw = normalize_token(input.value.as_deref().unwrap_or("live"), 16);
    let value = if raw == "test" {
        "test".to_string()
    } else {
        "live".to_string()
    };
    NormalizeModeOutput { value }
}

pub fn compute_normalize_target(input: &NormalizeTargetInput) -> NormalizeTargetOutput {
    let raw = normalize_token(input.value.as_deref().unwrap_or("tactical"), 24);
    let value = match raw.as_str() {
        "tactical" | "belief" | "identity" | "directive" | "constitution" => raw,
        _ => "tactical".to_string(),
    };
    NormalizeTargetOutput { value }
}

pub fn compute_normalize_result(input: &NormalizeResultInput) -> NormalizeResultOutput {
    let raw = normalize_token(input.value.as_deref().unwrap_or(""), 24);
    let value = match raw.as_str() {
        "success" | "neutral" | "fail" | "destructive" => raw,
        _ => String::new(),
    };
    NormalizeResultOutput { value }
}

fn is_valid_objective_id(raw: &str) -> bool {
    if raw.len() < 6 || raw.len() > 140 {
        return false;
    }
    let bytes = raw.as_bytes();
    let first = bytes[0] as char;
    let last = bytes[bytes.len() - 1] as char;
    if !first.is_ascii_alphanumeric() || !last.is_ascii_alphanumeric() {
        return false;
    }
    if bytes.len() < 2 {
        return false;
    }
    for ch in &bytes[1..(bytes.len() - 1)] {
        let c = *ch as char;
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == ':' || c == '-' {
            continue;
        }
        return false;
    }
    true
}

pub fn compute_objective_id_valid(input: &ObjectiveIdValidInput) -> ObjectiveIdValidOutput {
    let raw = input.value.as_deref().unwrap_or("").trim();
    ObjectiveIdValidOutput {
        valid: is_valid_objective_id(raw),
    }
}

fn normalize_trit_value(value: &Value) -> i32 {
    if let Some(n) = value.as_f64() {
        if n > 0.0 {
            return 1;
        }
        if n < 0.0 {
            return -1;
        }
        return 0;
    }
    if let Some(b) = value.as_bool() {
        return if b { 1 } else { 0 };
    }
    if let Some(text) = value.as_str() {
        let parsed = text.trim().parse::<f64>().ok().unwrap_or(0.0);
        if parsed > 0.0 {
            return 1;
        }
        if parsed < 0.0 {
            return -1;
        }
    }
    0
}

pub fn compute_trit_vector_from_input(
    input: &TritVectorFromInputInput,
) -> TritVectorFromInputOutput {
    if let Some(vec) = &input.trit_vector {
        let out = vec.iter().map(normalize_trit_value).collect::<Vec<_>>();
        return TritVectorFromInputOutput { vector: out };
    }
    let raw = input.trit_vector_csv.as_deref().unwrap_or("").trim();
    if raw.is_empty() {
        return TritVectorFromInputOutput { vector: Vec::new() };
    }
    let out = raw
        .split(',')
        .map(|token| {
            let parsed = token.trim().parse::<f64>().ok().unwrap_or(0.0);
            if parsed > 0.0 {
                1
            } else if parsed < 0.0 {
                -1
            } else {
                0
            }
        })
        .collect::<Vec<_>>();
    TritVectorFromInputOutput { vector: out }
}

pub fn compute_jaccard_similarity(input: &JaccardSimilarityInput) -> JaccardSimilarityOutput {
    let left = input
        .left_tokens
        .iter()
        .map(|token| token.trim())
        .filter(|token| !token.is_empty())
        .map(|token| token.to_string())
        .collect::<BTreeSet<_>>();
    let right = input
        .right_tokens
        .iter()
        .map(|token| token.trim())
        .filter(|token| !token.is_empty())
        .map(|token| token.to_string())
        .collect::<BTreeSet<_>>();
    if left.is_empty() && right.is_empty() {
        return JaccardSimilarityOutput { similarity: 1.0 };
    }
    if left.is_empty() || right.is_empty() {
        return JaccardSimilarityOutput { similarity: 0.0 };
    }
    let inter = left.intersection(&right).count() as f64;
    let union = left.union(&right).count() as f64;
    let similarity = if union > 0.0 { inter / union } else { 0.0 };
    JaccardSimilarityOutput { similarity }
}

fn majority_trit(values: &[Value]) -> i32 {
    if values.is_empty() {
        return 0;
    }
    let mut pain = 0;
    let mut unknown = 0;
    let mut ok = 0;
    for value in values {
        let trit = normalize_trit_value(value);
        if trit < 0 {
            pain += 1;
        } else if trit > 0 {
            ok += 1;
        } else {
            unknown += 1;
        }
    }
    if pain > ok && pain > unknown {
        -1
    } else if ok > pain && ok > unknown {
        1
    } else {
        0
    }
}

pub fn compute_trit_similarity(input: &TritSimilarityInput) -> TritSimilarityOutput {
    let trit = normalize_trit_value(input.entry_trit.as_ref().unwrap_or(&Value::Null));
    if input.query_vector.is_empty() {
        return TritSimilarityOutput {
            similarity: if trit == 0 { 1.0 } else { 0.5 },
        };
    }
    let majority = majority_trit(&input.query_vector);
    let similarity = if majority == trit {
        1.0
    } else if majority == 0 || trit == 0 {
        0.6
    } else {
        0.0
    };
    TritSimilarityOutput { similarity }
}

fn clamp_number(value: f64, lo: f64, hi: f64) -> f64 {
    value.max(lo).min(hi)
}

fn read_number_key(value: Option<&Value>, key: &str, fallback: f64) -> f64 {
    let Some(map) = value.and_then(|v| v.as_object()) else {
        return fallback;
    };
    map.get(key)
        .and_then(|v| v.as_f64())
        .map(|n| clamp_number(n, 0.0, 1.0))
        .unwrap_or(fallback)
}

pub fn compute_certainty_threshold(input: &CertaintyThresholdInput) -> CertaintyThresholdOutput {
    let thresholds = input.thresholds.as_ref().and_then(|v| v.as_object());
    let band = normalize_token(input.band.as_deref().unwrap_or("novice"), 24);
    let impact = normalize_token(input.impact.as_deref().unwrap_or("medium"), 24);
    let by_band = thresholds
        .and_then(|rows| rows.get(&band))
        .filter(|v| v.is_object())
        .or_else(|| thresholds.and_then(|rows| rows.get("novice")));
    let mut threshold = read_number_key(by_band, &impact, 1.0);
    if input.allow_zero_for_legendary_critical.unwrap_or(false)
        && band == "legendary"
        && impact == "critical"
    {
        threshold = 0.0;
    }
    CertaintyThresholdOutput { threshold }
}

fn read_rank_key(value: Option<&Value>, key: &str, fallback: i64) -> i64 {
    let Some(map) = value.and_then(|v| v.as_object()) else {
        return fallback;
    };
    map.get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|n| n.round() as i64)))
        .unwrap_or(fallback)
}

pub fn compute_max_target_rank(input: &MaxTargetRankInput) -> MaxTargetRankOutput {
    let band = normalize_token(input.maturity_band.as_deref().unwrap_or("novice"), 24);
    let impact = normalize_token(input.impact.as_deref().unwrap_or("medium"), 24);
    let maturity_rank = read_rank_key(input.maturity_max_target_rank_by_band.as_ref(), &band, 1);
    let impact_rank = read_rank_key(input.impact_max_target_rank.as_ref(), &impact, 1);
    let rank = maturity_rank.min(impact_rank).max(1);
    MaxTargetRankOutput { rank }
}

fn clean_text_runtime(raw: &str, max_len: usize) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .chars()
        .take(max_len)
        .collect::<String>()
}

fn normalize_token_runtime(raw: &str, max_len: usize) -> String {
    let src = clean_text_runtime(raw, max_len).to_lowercase();
    let mut out = String::new();
    let mut prev_underscore = false;
    for ch in src.chars() {
        let keep = ch.is_ascii_lowercase()
            || ch.is_ascii_digit()
            || ch == '_'
            || ch == '.'
            || ch == ':'
            || ch == '-';
        if keep {
            out.push(ch);
            prev_underscore = false;
        } else if !prev_underscore {
            out.push('_');
            prev_underscore = true;
        }
    }
    out.trim_matches('_').to_string()
}

fn parse_number_like(value: Option<&Value>) -> Option<f64> {
    let Some(v) = value else {
        return None;
    };
    if let Some(n) = v.as_f64() {
        return Some(n);
    }
    if let Some(s) = v.as_str() {
        return s.trim().parse::<f64>().ok();
    }
    if let Some(b) = v.as_bool() {
        return Some(if b { 1.0 } else { 0.0 });
    }
    None
}

fn value_to_string(value: Option<&Value>) -> String {
    let Some(v) = value else {
        return String::new();
    };
    if let Some(s) = v.as_str() {
        return s.to_string();
    }
    if v.is_null() {
        return String::new();
    }
    v.to_string()
}

fn push_unique(values: &mut Vec<String>, next: String) {
    if !values.iter().any(|item| item == &next) {
        values.push(next);
    }
}

fn round6(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

fn js_truthy(value: Option<&Value>) -> bool {
    let Some(v) = value else {
        return false;
    };
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n
            .as_f64()
            .map(|x| x != 0.0 && x.is_finite())
            .unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Array(arr) => !arr.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

fn js_or_number(value: Option<&Value>, fallback: f64) -> f64 {
    let Some(v) = value else {
        return fallback;
    };
    if !js_truthy(Some(v)) {
        return fallback;
    }
    parse_number_like(Some(v)).unwrap_or(fallback)
}

fn to_bool_like(value: Option<&Value>, fallback: bool) -> bool {
    let Some(v) = value else {
        return fallback;
    };
    let raw = match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => {
            if *b {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        _ => v.to_string(),
    }
    .trim()
    .to_lowercase();
    if ["1", "true", "yes", "on"].contains(&raw.as_str()) {
        return true;
    }
    if ["0", "false", "no", "off"].contains(&raw.as_str()) {
        return false;
    }
    fallback
}

fn clamp_int_value(value: Option<&Value>, lo: i64, hi: i64, fallback: i64) -> i64 {
    let parsed = parse_number_like(value).unwrap_or(fallback as f64).floor() as i64;
    parsed.clamp(lo, hi)
}

fn map_number_key(map_value: Option<&Value>, key: &str, lo: f64, hi: f64, fallback: f64) -> f64 {
    let v = map_value
        .and_then(|v| v.as_object())
        .and_then(|m| m.get(key))
        .and_then(|row| parse_number_like(Some(row)))
        .unwrap_or(fallback);
    clamp_number(v, lo, hi)
}

fn map_int_key(map_value: Option<&Value>, key: &str, lo: i64, hi: i64, fallback: i64) -> i64 {
    clamp_int_value(
        map_value
            .and_then(|v| v.as_object())
            .and_then(|m| m.get(key)),
        lo,
        hi,
        fallback,
    )
}

fn map_bool_key(map_value: Option<&Value>, key: &str, fallback: bool) -> bool {
    to_bool_like(
        map_value
            .and_then(|v| v.as_object())
            .and_then(|m| m.get(key)),
        fallback,
    )
}

fn normalize_target_for_key(target: &str) -> String {
    compute_normalize_target(&NormalizeTargetInput {
        value: Some(target.to_string()),
    })
    .value
}

fn number_path(root: Option<&Value>, path: &[&str], fallback: f64) -> f64 {
    let mut cursor = root;
    for key in path {
        cursor = cursor.and_then(|v| v.as_object()).and_then(|m| m.get(*key));
    }
    parse_number_like(cursor).unwrap_or(fallback)
}

fn value_path<'a>(root: Option<&'a Value>, path: &[&str]) -> Option<&'a Value> {
    let mut cursor = root;
    for key in path {
        cursor = cursor.and_then(|v| v.as_object()).and_then(|m| m.get(*key));
    }
    cursor
}

fn stable_id_runtime(seed: &str, prefix: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("{}_{}", prefix, &digest[..16])
}

pub fn compute_normalize_band_map(input: &NormalizeBandMapInput) -> NormalizeBandMapOutput {
    let lo = input.lo.unwrap_or(0.0);
    let hi = input.hi.unwrap_or(1.0);
    let base = input.base.as_ref();
    let raw = input.raw.as_ref();
    NormalizeBandMapOutput {
        novice: map_number_key(
            raw,
            "novice",
            lo,
            hi,
            map_number_key(base, "novice", lo, hi, lo),
        ),
        developing: map_number_key(
            raw,
            "developing",
            lo,
            hi,
            map_number_key(base, "developing", lo, hi, lo),
        ),
        mature: map_number_key(
            raw,
            "mature",
            lo,
            hi,
            map_number_key(base, "mature", lo, hi, lo),
        ),
        seasoned: map_number_key(
            raw,
            "seasoned",
            lo,
            hi,
            map_number_key(base, "seasoned", lo, hi, lo),
        ),
        legendary: map_number_key(
            raw,
            "legendary",
            lo,
            hi,
            map_number_key(base, "legendary", lo, hi, lo),
        ),
    }
}

pub fn compute_normalize_impact_map(input: &NormalizeImpactMapInput) -> NormalizeImpactMapOutput {
    let lo = input.lo.unwrap_or(0.0);
    let hi = input.hi.unwrap_or(1.0);
    let base = input.base.as_ref();
    let raw = input.raw.as_ref();
    NormalizeImpactMapOutput {
        low: map_number_key(raw, "low", lo, hi, map_number_key(base, "low", lo, hi, lo)),
        medium: map_number_key(
            raw,
            "medium",
            lo,
            hi,
            map_number_key(base, "medium", lo, hi, lo),
        ),
        high: map_number_key(
            raw,
            "high",
            lo,
            hi,
            map_number_key(base, "high", lo, hi, lo),
        ),
        critical: map_number_key(
            raw,
            "critical",
            lo,
            hi,
            map_number_key(base, "critical", lo, hi, lo),
        ),
    }
}

pub fn compute_normalize_target_map(input: &NormalizeTargetMapInput) -> NormalizeTargetMapOutput {
    let lo = input.lo.unwrap_or(0.0);
    let hi = input.hi.unwrap_or(1.0);
    let base = input.base.as_ref();
    let raw = input.raw.as_ref();
    NormalizeTargetMapOutput {
        tactical: map_number_key(
            raw,
            "tactical",
            lo,
            hi,
            map_number_key(base, "tactical", lo, hi, lo),
        ),
        belief: map_number_key(
            raw,
            "belief",
            lo,
            hi,
            map_number_key(base, "belief", lo, hi, lo),
        ),
        identity: map_number_key(
            raw,
            "identity",
            lo,
            hi,
            map_number_key(base, "identity", lo, hi, lo),
        ),
        directive: map_number_key(
            raw,
            "directive",
            lo,
            hi,
            map_number_key(base, "directive", lo, hi, lo),
        ),
        constitution: map_number_key(
            raw,
            "constitution",
            lo,
            hi,
            map_number_key(base, "constitution", lo, hi, lo),
        ),
    }
}

pub fn compute_normalize_target_policy(
    input: &NormalizeTargetPolicyInput,
) -> NormalizeTargetPolicyOutput {
    let raw = input.raw.as_ref();
    let base = input.base.as_ref();
    NormalizeTargetPolicyOutput {
        rank: map_int_key(raw, "rank", 1, 10, map_int_key(base, "rank", 1, 10, 1)),
        live_enabled: map_bool_key(
            raw,
            "live_enabled",
            map_bool_key(base, "live_enabled", false),
        ),
        test_enabled: map_bool_key(
            raw,
            "test_enabled",
            map_bool_key(base, "test_enabled", true),
        ),
        require_human_veto_live: map_bool_key(
            raw,
            "require_human_veto_live",
            map_bool_key(base, "require_human_veto_live", false),
        ),
        min_shadow_hours: map_int_key(
            raw,
            "min_shadow_hours",
            0,
            24 * 365,
            map_int_key(base, "min_shadow_hours", 0, 24 * 365, 0),
        ),
    }
}

pub fn compute_window_days_for_target(
    input: &WindowDaysForTargetInput,
) -> WindowDaysForTargetOutput {
    let target = normalize_target_for_key(input.target.as_deref().unwrap_or("tactical"));
    let fallback = input.fallback.unwrap_or(90).clamp(1, 3650);
    let days = map_int_key(input.window_map.as_ref(), &target, 1, 3650, fallback);
    WindowDaysForTargetOutput { days }
}

pub fn compute_tier_retention_days(input: &TierRetentionDaysInput) -> TierRetentionDaysOutput {
    let policy = input.policy.as_ref();
    let transition = value_path(policy, &["tier_transition", "window_days_by_target"])
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let transition_min = value_path(
        policy,
        &["tier_transition", "minimum_window_days_by_target"],
    )
    .and_then(|v| v.as_object())
    .cloned()
    .unwrap_or_default();
    let shadow = value_path(policy, &["shadow_pass_gate", "window_days_by_target"])
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let mut all = Vec::new();
    for map in [transition, transition_min, shadow] {
        for value in map.values() {
            all.push(clamp_int_value(Some(value), 1, 3650, 1));
        }
    }
    let mut max_days = 365i64;
    for days in all {
        if days > max_days {
            max_days = days;
        }
    }
    if max_days < 30 {
        max_days = 30;
    }
    TierRetentionDaysOutput { days: max_days }
}

pub fn compute_parse_candidate_list_from_llm_payload(
    input: &ParseCandidateListFromLlmPayloadInput,
) -> ParseCandidateListFromLlmPayloadOutput {
    let rows = match input.payload.as_ref() {
        Some(Value::Array(arr)) => arr.clone(),
        Some(Value::Object(obj)) => obj
            .get("candidates")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    let mut out = Vec::new();
    for (idx, row) in rows.iter().enumerate() {
        let row_obj = row.as_object();
        let filters_src = row_obj
            .and_then(|obj| obj.get("filters"))
            .cloned()
            .or_else(|| row_obj.and_then(|obj| obj.get("filter_stack")).cloned())
            .or_else(|| row_obj.and_then(|obj| obj.get("filterStack")).cloned())
            .unwrap_or_else(|| Value::String(String::new()));
        let mut filters = compute_normalize_list(&NormalizeListInput {
            value: Some(filters_src),
            max_len: Some(120),
        })
        .items;
        filters.truncate(8);
        if filters.is_empty() {
            continue;
        }
        let fallback_id = format!("llm_{}", idx + 1);
        let id_raw = row_obj
            .and_then(|obj| obj.get("id"))
            .map(|v| value_to_string(Some(v)))
            .unwrap_or_else(|| fallback_id.clone());
        let id = {
            let token = normalize_token_runtime(&id_raw, 80);
            if token.is_empty() {
                fallback_id.clone()
            } else {
                token
            }
        };
        let probability = round6(clamp_number(
            parse_number_like(row_obj.and_then(|obj| obj.get("probability"))).unwrap_or(0.55),
            0.0,
            1.0,
        ));
        let rationale = clean_text_runtime(
            &row_obj
                .and_then(|obj| obj.get("rationale"))
                .or_else(|| row_obj.and_then(|obj| obj.get("reason")))
                .map(|v| value_to_string(Some(v)))
                .unwrap_or_default(),
            220,
        );
        out.push(InversionCandidateRow {
            id,
            filters,
            source: "right_brain_llm".to_string(),
            probability,
            rationale,
        });
    }
    ParseCandidateListFromLlmPayloadOutput { candidates: out }
}

pub fn compute_heuristic_filter_candidates(
    input: &HeuristicFilterCandidatesInput,
) -> HeuristicFilterCandidatesOutput {
    let objective = input.objective.as_deref().unwrap_or("");
    let tags = compute_tokenize_text(&TokenizeTextInput {
        value: Some(objective.to_string()),
        max_tokens: Some(64),
    })
    .tokens;
    let has_tag = |needle: &str| tags.iter().any(|tag| tag == needle);
    let mut base: Vec<Vec<String>> = vec![
        vec![
            "assumption_inversion".to_string(),
            "constraint_reframe".to_string(),
        ],
        vec!["resource_rebalance".to_string(), "path_split".to_string()],
        vec![
            "goal_decomposition".to_string(),
            "fallback_pathing".to_string(),
        ],
        vec![
            "evidence_intensification".to_string(),
            "risk_guard_compaction".to_string(),
        ],
        vec![
            "time_horizon_reframe".to_string(),
            "bounded_parallel_probe".to_string(),
        ],
        vec![
            "negative_space_scan".to_string(),
            "safe_counterfactual".to_string(),
        ],
    ];
    if has_tag("budget") || has_tag("cost") {
        base.push(vec![
            "cost_lane_swap".to_string(),
            "constraint_reframe".to_string(),
        ]);
    }
    if has_tag("yield") || has_tag("quality") {
        base.push(vec![
            "yield_reframe".to_string(),
            "verification_gate".to_string(),
        ]);
    }
    if has_tag("drift") {
        base.push(vec![
            "drift_anchor".to_string(),
            "identity_guard".to_string(),
        ]);
    }
    let mut out = Vec::new();
    for (idx, filters) in base.iter().enumerate() {
        let mut normalized = compute_normalize_list(&NormalizeListInput {
            value: Some(Value::Array(
                filters
                    .iter()
                    .map(|row| Value::String(row.clone()))
                    .collect::<Vec<_>>(),
            )),
            max_len: Some(120),
        })
        .items;
        normalized.truncate(8);
        let probability = round6(clamp_number(0.42 + (idx as f64 * 0.03), 0.0, 1.0));
        out.push(InversionCandidateRow {
            id: format!("heur_{}", idx + 1),
            filters: normalized,
            source: "heuristic".to_string(),
            probability,
            rationale: "heuristic seed".to_string(),
        });
    }
    HeuristicFilterCandidatesOutput { candidates: out }
}

pub fn compute_score_trial(input: &ScoreTrialInput) -> ScoreTrialOutput {
    let decision = input.decision.as_ref();
    let candidate = input.candidate.as_ref();
    let trial_cfg = input.trial_cfg.as_ref();
    let weights = value_path(trial_cfg, &["score_weights"]);
    let w_allowed = js_or_number(value_path(weights, &["decision_allowed"]), 0.35);
    let w_attractor = js_or_number(value_path(weights, &["attractor"]), 0.2);
    let w_certainty = js_or_number(value_path(weights, &["certainty_margin"]), 0.15);
    let w_library = js_or_number(value_path(weights, &["library_similarity"]), 0.1);
    let w_probe = js_or_number(value_path(weights, &["runtime_probe"]), 0.2);
    let weight_total = (w_allowed + w_attractor + w_certainty + w_library + w_probe).max(0.0001);
    let certainty_margin = clamp_number(
        number_path(decision, &["input", "effective_certainty"], 0.0)
            - number_path(decision, &["gating", "required_certainty"], 0.0),
        -1.0,
        1.0,
    );
    let certainty_score = if certainty_margin <= 0.0 {
        0.0
    } else {
        clamp_number(certainty_margin, 0.0, 1.0)
    };
    let allowed_score = if js_truthy(value_path(decision, &["allowed"])) {
        1.0
    } else {
        0.0
    };
    let attractor_score = number_path(decision, &["attractor", "score"], 0.0);
    let library_score = number_path(candidate, &["score_hint"], 0.0);
    let probe_score = if input.runtime_probe_pass.unwrap_or(false) {
        1.0
    } else {
        0.0
    };
    let score = ((allowed_score * w_allowed)
        + (attractor_score * w_attractor)
        + (certainty_score * w_certainty)
        + (library_score * w_library)
        + (probe_score * w_probe))
        / weight_total;
    ScoreTrialOutput {
        score: round6(clamp_number(score, 0.0, 1.0)),
    }
}

pub fn compute_mutate_trial_candidates(
    input: &MutateTrialCandidatesInput,
) -> MutateTrialCandidatesOutput {
    let mutation_stack = [
        "constraint_reframe",
        "goal_decomposition",
        "fallback_pathing",
        "risk_guard_compaction",
    ];
    let mut out = Vec::new();
    let mut idx = 0usize;
    for row in &input.rows {
        let row_obj = row.as_object();
        let mut filters = compute_normalize_list(&NormalizeListInput {
            value: row_obj
                .and_then(|obj| obj.get("filters"))
                .cloned()
                .or_else(|| Some(json!([]))),
            max_len: Some(120),
        })
        .items;
        let extra = mutation_stack[idx % mutation_stack.len()].to_string();
        idx += 1;
        filters.push(extra);
        let mut merged = compute_normalize_list(&NormalizeListInput {
            value: Some(Value::Array(
                filters.into_iter().map(Value::String).collect::<Vec<_>>(),
            )),
            max_len: Some(120),
        })
        .items;
        merged.truncate(8);

        let fallback_seed = if row.is_null() {
            "{}".to_string()
        } else {
            serde_json::to_string(row).unwrap_or_else(|_| "{}".to_string())
        };
        let id_prefix = row_obj
            .and_then(|obj| obj.get("id"))
            .map(|v| value_to_string(Some(v)))
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| stable_id_runtime(&fallback_seed, "mut"));
        let source_prefix = row_obj
            .and_then(|obj| obj.get("source"))
            .map(|v| value_to_string(Some(v)))
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "trial".to_string());
        let probability = round6(clamp_number(
            js_or_number(row_obj.and_then(|obj| obj.get("probability")), 0.4) * 0.92,
            0.0,
            1.0,
        ));
        let score_hint = round6(clamp_number(
            parse_number_like(row_obj.and_then(|obj| obj.get("score_hint"))).unwrap_or(0.0) * 0.94,
            0.0,
            1.0,
        ));

        let mut next = row_obj.cloned().unwrap_or_default();
        next.insert(
            "id".to_string(),
            Value::String(format!("{id_prefix}_m{idx}")),
        );
        next.insert(
            "filters".to_string(),
            Value::Array(
                merged
                    .iter()
                    .map(|row| Value::String(row.clone()))
                    .collect::<Vec<_>>(),
            ),
        );
        next.insert(
            "source".to_string(),
            Value::String(format!("{source_prefix}_mutated")),
        );
        next.insert("probability".to_string(), json!(probability));
        next.insert("score_hint".to_string(), json!(score_hint));
        out.push(Value::Object(next));
    }
    MutateTrialCandidatesOutput { rows: out }
}

pub fn compute_creative_penalty(input: &CreativePenaltyInput) -> CreativePenaltyOutput {
    let preferred = input
        .preferred_creative_lane_ids
        .iter()
        .map(|row| normalize_token_runtime(row, 120))
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>();
    let selected_lane = input
        .selected_lane
        .as_deref()
        .map(|v| v.to_string())
        .filter(|v| !v.is_empty());
    if input.enabled.unwrap_or(false) != true {
        return CreativePenaltyOutput {
            creative_lane_preferred: false,
            selected_lane,
            preferred_lanes: preferred,
            penalty: 0.0,
            applied: false,
        };
    }
    let Some(selected) = selected_lane.clone() else {
        return CreativePenaltyOutput {
            creative_lane_preferred: false,
            selected_lane: None,
            preferred_lanes: preferred,
            penalty: 0.0,
            applied: false,
        };
    };
    let is_preferred = preferred.iter().any(|row| row == &selected);
    let penalty = if is_preferred {
        0.0
    } else {
        input.non_creative_certainty_penalty.unwrap_or(0.0)
    };
    let penalty = clamp_number(penalty, 0.0, 0.5);
    let penalty = (penalty * 1_000_000.0).round() / 1_000_000.0;
    CreativePenaltyOutput {
        creative_lane_preferred: is_preferred,
        selected_lane: Some(selected),
        preferred_lanes: preferred,
        penalty,
        applied: penalty > 0.0,
    }
}

pub fn compute_extract_bullets(input: &ExtractBulletsInput) -> ExtractBulletsOutput {
    let max_items = input.max_items.unwrap_or(4).max(0) as usize;
    let markdown = input.markdown.as_deref().unwrap_or("");
    let mut out = Vec::new();
    let bullet_re = Regex::new(r"^[-*]\s+(.+)$").expect("valid bullet regex");
    let ordered_re = Regex::new(r"^\d+\.\s+(.+)$").expect("valid ordered regex");
    for line in markdown.lines() {
        let trimmed = line.trim();
        let capture = bullet_re
            .captures(trimmed)
            .or_else(|| ordered_re.captures(trimmed));
        let Some(cap) = capture else {
            continue;
        };
        let item = clean_text_runtime(cap.get(1).map(|m| m.as_str()).unwrap_or(""), 220);
        if item.is_empty() {
            continue;
        }
        out.push(item);
        if out.len() >= max_items {
            break;
        }
    }
    ExtractBulletsOutput { items: out }
}

pub fn compute_extract_list_items(input: &ExtractListItemsInput) -> ExtractListItemsOutput {
    let max_items = input.max_items.unwrap_or(8).max(0) as usize;
    let markdown = input.markdown.as_deref().unwrap_or("");
    let mut out = Vec::new();
    let bullet_re = Regex::new(r"^[-*]\s+(.+)$").expect("valid list regex");
    for line in markdown.lines() {
        let trimmed = line.trim();
        let Some(cap) = bullet_re.captures(trimmed) else {
            continue;
        };
        let item = clean_text_runtime(cap.get(1).map(|m| m.as_str()).unwrap_or(""), 160);
        if item.is_empty() {
            continue;
        }
        out.push(item);
        if out.len() >= max_items {
            break;
        }
    }
    ExtractListItemsOutput { items: out }
}

pub fn compute_parse_system_internal_permission(
    input: &ParseSystemInternalPermissionInput,
) -> ParseSystemInternalPermissionOutput {
    let markdown = input.markdown.as_deref().unwrap_or("");
    let permission_re = Regex::new(
        r"(?i)^-+\s*system_internal\s*:\s*\{\s*enabled:\s*(true|false)\s*,\s*sources:\s*\[([^\]]*)\]\s*\}\s*$",
    )
    .expect("valid system_internal regex");
    for line in markdown.lines() {
        let trimmed = line.trim();
        let Some(cap) = permission_re.captures(trimmed) else {
            continue;
        };
        let enabled = cap
            .get(1)
            .map(|m| m.as_str().to_lowercase() == "true")
            .unwrap_or(false);
        let sources = cap
            .get(2)
            .map(|m| {
                m.as_str()
                    .split(',')
                    .map(|row| normalize_token_runtime(row, 40))
                    .filter(|row| !row.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        return ParseSystemInternalPermissionOutput { enabled, sources };
    }
    ParseSystemInternalPermissionOutput {
        enabled: false,
        sources: Vec::new(),
    }
}

pub fn compute_parse_soul_token_data_pass_rules(
    input: &ParseSoulTokenDataPassRulesInput,
) -> ParseSoulTokenDataPassRulesOutput {
    let markdown = input.markdown.as_deref().unwrap_or("");
    let section = markdown.split("## Data Pass Rules").nth(1).unwrap_or("");
    let list = compute_extract_list_items(&ExtractListItemsInput {
        markdown: Some(section.to_string()),
        max_items: Some(12),
    });
    let rules = list
        .items
        .iter()
        .map(|row| normalize_token_runtime(row, 80))
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>();
    ParseSoulTokenDataPassRulesOutput { rules }
}

pub fn compute_ensure_system_passed_section(
    input: &EnsureSystemPassedSectionInput,
) -> EnsureSystemPassedSectionOutput {
    let body = input
        .feed_text
        .as_deref()
        .unwrap_or("")
        .trim_end_matches(|c: char| c.is_whitespace())
        .to_string();
    if body.contains("\n## System Passed") {
        return EnsureSystemPassedSectionOutput { text: body };
    }
    let text = vec![
        body,
        String::new(),
        "## System Passed".to_string(),
        String::new(),
        "Hash-verified system payloads pushed from internal sources (memory, loops, analytics)."
            .to_string(),
        "Entries are JSON payload records with deterministic hash verification.".to_string(),
        String::new(),
    ]
    .join("\n");
    EnsureSystemPassedSectionOutput { text }
}

pub fn compute_system_passed_payload_hash(
    input: &SystemPassedPayloadHashInput,
) -> SystemPassedPayloadHashOutput {
    let source = normalize_token_runtime(input.source.as_deref().unwrap_or(""), 80);
    let tags = input.tags.join(",");
    let payload = clean_text_runtime(input.payload.as_deref().unwrap_or(""), 2000);
    let seed = format!("v1|{source}|{tags}|{payload}");
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let hash = hex::encode(hasher.finalize());
    SystemPassedPayloadHashOutput { hash }
}

pub fn compute_build_lens_position(input: &BuildLensPositionInput) -> BuildLensPositionOutput {
    let objective = input.objective.as_deref().unwrap_or("");
    let lower = objective.to_lowercase();
    let target = input.target.as_deref().unwrap_or("");
    let impact = input.impact.as_deref().unwrap_or("");
    let position = if lower.contains("memory") && lower.contains("security") {
        "Preserve memory determinism sequencing while keeping security fail-closed at dispatch boundaries.".to_string()
    } else if lower.contains("drift") {
        "Treat drift above tolerance as a hard stop and require rollback-ready proof before apply."
            .to_string()
    } else if target == "identity" || impact == "high" || impact == "critical" {
        "Use strict reversible slices with explicit receipts before any live apply.".to_string()
    } else {
        "Keep the smallest reversible path and preserve fail-closed controls before mutation."
            .to_string()
    };
    BuildLensPositionOutput { position }
}

pub fn compute_build_conclave_proposal_summary(
    input: &BuildConclaveProposalSummaryInput,
) -> BuildConclaveProposalSummaryOutput {
    let mut parts = Vec::new();
    for (value, max_len) in [
        (input.objective.as_deref().unwrap_or(""), 320usize),
        (input.objective_id.as_deref().unwrap_or(""), 120usize),
        (input.target.as_deref().unwrap_or(""), 40usize),
        (input.impact.as_deref().unwrap_or(""), 40usize),
        (input.mode.as_deref().unwrap_or(""), 24usize),
    ] {
        let clean = clean_text_runtime(value, max_len);
        if !clean.is_empty() {
            parts.push(clean);
        }
    }
    let summary = if parts.is_empty() {
        "inversion_self_modification_request".to_string()
    } else {
        parts.join(" | ")
    };
    BuildConclaveProposalSummaryOutput { summary }
}

pub fn compute_conclave_high_risk_flags(
    input: &ConclaveHighRiskFlagsInput,
) -> ConclaveHighRiskFlagsOutput {
    let payload = input.payload.as_ref().and_then(|v| v.as_object());
    let max_divergence = input.max_divergence.unwrap_or(0.45);
    let min_confidence = input.min_confidence.unwrap_or(0.6);
    let mut flags: Vec<String> = Vec::new();

    let winner = clean_text_runtime(
        &value_to_string(payload.and_then(|row| row.get("winner"))),
        120,
    );
    if payload.is_none()
        || payload
            .and_then(|row| row.get("ok"))
            .and_then(|v| v.as_bool())
            != Some(true)
        || winner.is_empty()
    {
        push_unique(&mut flags, "no_consensus".to_string());
    }

    let divergence =
        parse_number_like(payload.and_then(|row| row.get("max_divergence"))).unwrap_or(0.0);
    if !divergence.is_finite() || divergence > max_divergence {
        push_unique(&mut flags, "high_divergence".to_string());
    }

    let persona_outputs = payload
        .and_then(|row| row.get("persona_outputs"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let confidences = persona_outputs
        .iter()
        .filter_map(|row| row.as_object())
        .filter_map(|row| parse_number_like(row.get("confidence")))
        .filter(|n| n.is_finite())
        .collect::<Vec<_>>();
    if !confidences.is_empty()
        && confidences.iter().fold(f64::INFINITY, |acc, n| acc.min(*n)) < min_confidence
    {
        push_unique(&mut flags, "low_confidence".to_string());
    }

    let mut corpus_rows = vec![
        clean_text_runtime(input.query.as_deref().unwrap_or(""), 2400),
        clean_text_runtime(input.summary.as_deref().unwrap_or(""), 1200),
        clean_text_runtime(
            &value_to_string(payload.and_then(|row| row.get("suggested_resolution"))),
            1600,
        ),
    ];
    for row in &persona_outputs {
        if let Some(map) = row.as_object() {
            corpus_rows.push(clean_text_runtime(
                &value_to_string(map.get("recommendation")),
                1200,
            ));
            if let Some(reasoning) = map.get("reasoning").and_then(|v| v.as_array()) {
                for reason in reasoning {
                    corpus_rows.push(clean_text_runtime(&value_to_string(Some(reason)), 240));
                }
            }
        }
    }
    let corpus = corpus_rows.join("\n").to_lowercase();
    for keyword in &input.high_risk_keywords {
        if keyword.is_empty() {
            continue;
        }
        if corpus.contains(&keyword.to_lowercase()) {
            let token = normalize_token_runtime(keyword, 80);
            let flag = if token.is_empty() {
                "keyword:risk".to_string()
            } else {
                format!("keyword:{token}")
            };
            push_unique(&mut flags, flag);
        }
    }

    ConclaveHighRiskFlagsOutput { flags }
}

fn dedupe_preserve_order(values: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        if value.is_empty() {
            continue;
        }
        if !out.iter().any(|existing| existing == &value) {
            out.push(value);
        }
    }
    out
}

fn value_to_csv_list(value: Option<&Value>) -> Vec<String> {
    let Some(v) = value else {
        return Vec::new();
    };
    if let Some(arr) = v.as_array() {
        return arr
            .iter()
            .map(|row| value_to_string(Some(row)))
            .collect::<Vec<_>>();
    }
    value_to_string(Some(v))
        .split(',')
        .map(|row| row.to_string())
        .collect::<Vec<_>>()
}

pub fn compute_tokenize_text(input: &TokenizeTextInput) -> TokenizeTextOutput {
    let max_tokens = input.max_tokens.unwrap_or(64).clamp(0, 256) as usize;
    let text = clean_text_runtime(input.value.as_deref().unwrap_or(""), 1200).to_lowercase();
    let raw = text
        .chars()
        .map(|ch| {
            if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
                ch
            } else {
                ' '
            }
        })
        .collect::<String>();
    let tokens = dedupe_preserve_order(
        raw.split(' ')
            .map(|row| row.trim())
            .filter(|row| row.len() >= 3)
            .map(|row| row.to_string())
            .collect::<Vec<_>>(),
    )
    .into_iter()
    .take(max_tokens)
    .collect::<Vec<_>>();
    TokenizeTextOutput { tokens }
}

pub fn compute_normalize_list(input: &NormalizeListInput) -> NormalizeListOutput {
    let max_len = input.max_len.unwrap_or(80).clamp(1, 400) as usize;
    let mut values = value_to_csv_list(input.value.as_ref())
        .iter()
        .map(|row| normalize_token_runtime(row, max_len))
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>();
    values = dedupe_preserve_order(values);
    values.truncate(64);
    NormalizeListOutput { items: values }
}

pub fn compute_normalize_text_list(input: &NormalizeTextListInput) -> NormalizeTextListOutput {
    let max_len = input.max_len.unwrap_or(180).clamp(1, 2000) as usize;
    let max_items = input.max_items.unwrap_or(64).clamp(0, 1024) as usize;
    let mut out = Vec::new();
    for row in value_to_csv_list(input.value.as_ref()) {
        let next = clean_text_runtime(&row, max_len);
        if next.is_empty() {
            continue;
        }
        if out.iter().any(|existing| existing == &next) {
            continue;
        }
        out.push(next);
        if out.len() >= max_items {
            break;
        }
    }
    NormalizeTextListOutput { items: out }
}

pub fn compute_parse_json_from_stdout(
    input: &ParseJsonFromStdoutInput,
) -> ParseJsonFromStdoutOutput {
    let text = input.raw.as_deref().unwrap_or("").trim();
    if text.is_empty() {
        return ParseJsonFromStdoutOutput { parsed: None };
    }
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return ParseJsonFromStdoutOutput {
            parsed: Some(value),
        };
    }
    let lines = text
        .split('\n')
        .map(|row| row.trim())
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>();
    for line in lines.iter().rev() {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            return ParseJsonFromStdoutOutput {
                parsed: Some(value),
            };
        }
    }
    ParseJsonFromStdoutOutput { parsed: None }
}

pub fn compute_parse_args(input: &ParseArgsInput) -> ParseArgsOutput {
    let mut positional = Vec::new();
    let mut map = serde_json::Map::new();
    let argv = &input.argv;
    let mut idx = 0usize;
    while idx < argv.len() {
        let tok = argv[idx].clone();
        if !tok.starts_with("--") {
            positional.push(tok);
            idx += 1;
            continue;
        }
        if let Some(eq) = tok.find('=') {
            let key = tok.chars().skip(2).take(eq - 2).collect::<String>();
            let value = tok.chars().skip(eq + 1).collect::<String>();
            map.insert(key, Value::String(value));
            idx += 1;
            continue;
        }
        let key = tok.chars().skip(2).collect::<String>();
        if idx + 1 < argv.len() && !argv[idx + 1].starts_with("--") {
            map.insert(key, Value::String(argv[idx + 1].clone()));
            idx += 2;
            continue;
        }
        map.insert(key, Value::Bool(true));
        idx += 1;
    }
    map.insert(
        "_".to_string(),
        Value::Array(
            positional
                .into_iter()
                .map(Value::String)
                .collect::<Vec<_>>(),
        ),
    );
    ParseArgsOutput {
        args: Value::Object(map),
    }
}

pub fn compute_library_match_score(input: &LibraryMatchScoreInput) -> LibraryMatchScoreOutput {
    let token_score = compute_jaccard_similarity(&JaccardSimilarityInput {
        left_tokens: input.query_signature_tokens.clone(),
        right_tokens: input.row_signature_tokens.clone(),
    })
    .similarity;
    let trit_score = compute_trit_similarity(&TritSimilarityInput {
        query_vector: input.query_trit_vector.clone(),
        entry_trit: Some(Value::from(input.row_outcome_trit.unwrap_or(0))),
    })
    .similarity;
    let query_target = input.query_target.as_deref().unwrap_or("");
    let row_target = input.row_target.as_deref().unwrap_or("");
    let target_score = if query_target == row_target { 1.0 } else { 0.0 };
    let token_weight = input.token_weight.unwrap_or(0.0);
    let trit_weight = input.trit_weight.unwrap_or(0.0);
    let target_weight = input.target_weight.unwrap_or(0.0);
    let total_weight = (token_weight + trit_weight + target_weight).max(0.0001);
    let score = ((token_score * token_weight)
        + (trit_score * trit_weight)
        + (target_score * target_weight))
        / total_weight;
    let score = clamp_number(score, 0.0, 1.0);
    let score = (score * 1_000_000.0).round() / 1_000_000.0;
    LibraryMatchScoreOutput { score }
}

pub fn compute_known_failure_pressure(
    input: &KnownFailurePressureInput,
) -> KnownFailurePressureOutput {
    let block_similarity = input.failed_repetition_similarity_block.unwrap_or(0.72);
    let mut fail_count = 0i64;
    let mut hard_block = false;
    let mut max_similarity = 0.0f64;
    for candidate in &input.candidates {
        let row = candidate
            .as_object()
            .and_then(|obj| obj.get("row"))
            .and_then(|v| v.as_object());
        let similarity =
            parse_number_like(candidate.as_object().and_then(|obj| obj.get("similarity")))
                .unwrap_or(0.0);
        if let Some(row_obj) = row {
            let outcome = parse_number_like(row_obj.get("outcome_trit")).unwrap_or(0.0);
            if outcome < 0.0 {
                fail_count += 1;
                if similarity >= block_similarity {
                    hard_block = true;
                }
                if similarity > max_similarity {
                    max_similarity = similarity;
                }
            }
        }
    }
    let max_similarity = (max_similarity * 1_000_000.0).round() / 1_000_000.0;
    KnownFailurePressureOutput {
        fail_count,
        hard_block,
        max_similarity,
    }
}

pub fn compute_has_signal_term_match(input: &HasSignalTermMatchInput) -> HasSignalTermMatchOutput {
    let haystack = input.haystack.as_deref().unwrap_or("");
    let token_set = input
        .token_set
        .iter()
        .map(|row| row.to_string())
        .collect::<BTreeSet<_>>();
    let term = clean_text_runtime(input.term.as_deref().unwrap_or(""), 200).to_lowercase();
    if term.is_empty() {
        return HasSignalTermMatchOutput { matched: false };
    }
    let words = term
        .split_whitespace()
        .map(|row| regex::escape(row))
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>();
    if words.is_empty() {
        return HasSignalTermMatchOutput { matched: false };
    }
    let phrase_re = Regex::new(&format!(r"\b{}\b", words.join(r"\s+"))).ok();
    if let Some(re) = phrase_re {
        if re.is_match(haystack) {
            return HasSignalTermMatchOutput { matched: true };
        }
    }
    let parts = term.split_whitespace().collect::<Vec<_>>();
    if parts.len() == 1 {
        return HasSignalTermMatchOutput {
            matched: token_set.contains(parts[0]),
        };
    }
    HasSignalTermMatchOutput {
        matched: parts.iter().all(|part| token_set.contains(*part)),
    }
}

pub fn compute_count_axiom_signal_groups(
    input: &CountAxiomSignalGroupsInput,
) -> CountAxiomSignalGroupsOutput {
    let normalize_terms = |rows: &Vec<String>| -> Vec<String> {
        rows.iter()
            .map(|row| clean_text_runtime(row, 200).to_lowercase())
            .filter(|row| !row.is_empty())
            .take(32)
            .collect::<Vec<_>>()
    };
    let groups = vec![
        normalize_terms(&input.action_terms),
        normalize_terms(&input.subject_terms),
        normalize_terms(&input.object_terms),
    ];
    let haystack = input.haystack.as_deref().unwrap_or("");
    let token_set = input
        .token_set
        .iter()
        .map(|row| row.to_string())
        .collect::<Vec<_>>();
    let mut matched = 0i64;
    let configured = groups.iter().filter(|terms| !terms.is_empty()).count() as i64;
    for terms in &groups {
        if terms.is_empty() {
            continue;
        }
        let hit = terms.iter().any(|term| {
            compute_has_signal_term_match(&HasSignalTermMatchInput {
                haystack: Some(haystack.to_string()),
                token_set: token_set.clone(),
                term: Some(term.to_string()),
            })
            .matched
        });
        if hit {
            matched += 1;
        }
    }
    let required_default = configured;
    let required = input
        .min_signal_groups
        .unwrap_or(required_default)
        .clamp(0, 3);
    CountAxiomSignalGroupsOutput {
        configured_groups: configured,
        matched_groups: matched,
        required_groups: required,
        pass: matched >= required,
    }
}

pub fn compute_effective_first_n_human_veto_uses(
    input: &EffectiveFirstNHumanVetoUsesInput,
) -> EffectiveFirstNHumanVetoUsesOutput {
    let key = normalize_token(input.target.as_deref().unwrap_or("tactical"), 24);
    let configured =
        read_rank_key(input.first_live_uses_require_human_veto.as_ref(), &key, 0).clamp(0, 100_000);
    let minimum = read_rank_key(
        input.minimum_first_live_uses_require_human_veto.as_ref(),
        &key,
        0,
    )
    .clamp(0, 100_000);
    EffectiveFirstNHumanVetoUsesOutput {
        uses: configured.max(minimum),
    }
}

fn decode_input<T>(payload: &Value, key: &str) -> Result<T, String>
where
    T: for<'de> Deserialize<'de> + Default,
{
    let value = payload.get(key).cloned().unwrap_or_else(|| json!({}));
    serde_json::from_value(value).map_err(|e| format!("inversion_decode_{key}_failed:{e}"))
}

pub fn run_inversion_json(payload_json: &str) -> Result<String, String> {
    let payload: Value = serde_json::from_str(payload_json)
        .map_err(|e| format!("inversion_payload_parse_failed:{e}"))?;
    let mode = payload
        .get("mode")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default();
    if mode.is_empty() {
        return Err("inversion_mode_missing".to_string());
    }
    if mode == "normalize_impact" {
        let input: NormalizeImpactInput = decode_input(&payload, "normalize_impact_input")?;
        let out = compute_normalize_impact(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_impact",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_impact_failed:{e}"));
    }
    if mode == "normalize_mode" {
        let input: NormalizeModeInput = decode_input(&payload, "normalize_mode_input")?;
        let out = compute_normalize_mode(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_mode",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_mode_failed:{e}"));
    }
    if mode == "normalize_target" {
        let input: NormalizeTargetInput = decode_input(&payload, "normalize_target_input")?;
        let out = compute_normalize_target(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_target",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_target_failed:{e}"));
    }
    if mode == "normalize_result" {
        let input: NormalizeResultInput = decode_input(&payload, "normalize_result_input")?;
        let out = compute_normalize_result(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_result",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_result_failed:{e}"));
    }
    if mode == "objective_id_valid" {
        let input: ObjectiveIdValidInput = decode_input(&payload, "objective_id_valid_input")?;
        let out = compute_objective_id_valid(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "objective_id_valid",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_objective_id_valid_failed:{e}"));
    }
    if mode == "trit_vector_from_input" {
        let input: TritVectorFromInputInput =
            decode_input(&payload, "trit_vector_from_input_input")?;
        let out = compute_trit_vector_from_input(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "trit_vector_from_input",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_trit_vector_from_input_failed:{e}"));
    }
    if mode == "jaccard_similarity" {
        let input: JaccardSimilarityInput = decode_input(&payload, "jaccard_similarity_input")?;
        let out = compute_jaccard_similarity(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "jaccard_similarity",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_jaccard_similarity_failed:{e}"));
    }
    if mode == "trit_similarity" {
        let input: TritSimilarityInput = decode_input(&payload, "trit_similarity_input")?;
        let out = compute_trit_similarity(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "trit_similarity",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_trit_similarity_failed:{e}"));
    }
    if mode == "certainty_threshold" {
        let input: CertaintyThresholdInput = decode_input(&payload, "certainty_threshold_input")?;
        let out = compute_certainty_threshold(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "certainty_threshold",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_certainty_threshold_failed:{e}"));
    }
    if mode == "max_target_rank" {
        let input: MaxTargetRankInput = decode_input(&payload, "max_target_rank_input")?;
        let out = compute_max_target_rank(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "max_target_rank",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_max_target_rank_failed:{e}"));
    }
    if mode == "creative_penalty" {
        let input: CreativePenaltyInput = decode_input(&payload, "creative_penalty_input")?;
        let out = compute_creative_penalty(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "creative_penalty",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_creative_penalty_failed:{e}"));
    }
    if mode == "extract_bullets" {
        let input: ExtractBulletsInput = decode_input(&payload, "extract_bullets_input")?;
        let out = compute_extract_bullets(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "extract_bullets",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_extract_bullets_failed:{e}"));
    }
    if mode == "extract_list_items" {
        let input: ExtractListItemsInput = decode_input(&payload, "extract_list_items_input")?;
        let out = compute_extract_list_items(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "extract_list_items",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_extract_list_items_failed:{e}"));
    }
    if mode == "parse_system_internal_permission" {
        let input: ParseSystemInternalPermissionInput =
            decode_input(&payload, "parse_system_internal_permission_input")?;
        let out = compute_parse_system_internal_permission(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "parse_system_internal_permission",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_parse_system_internal_permission_failed:{e}"));
    }
    if mode == "parse_soul_token_data_pass_rules" {
        let input: ParseSoulTokenDataPassRulesInput =
            decode_input(&payload, "parse_soul_token_data_pass_rules_input")?;
        let out = compute_parse_soul_token_data_pass_rules(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "parse_soul_token_data_pass_rules",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_parse_soul_token_data_pass_rules_failed:{e}"));
    }
    if mode == "ensure_system_passed_section" {
        let input: EnsureSystemPassedSectionInput =
            decode_input(&payload, "ensure_system_passed_section_input")?;
        let out = compute_ensure_system_passed_section(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "ensure_system_passed_section",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_ensure_system_passed_section_failed:{e}"));
    }
    if mode == "system_passed_payload_hash" {
        let input: SystemPassedPayloadHashInput =
            decode_input(&payload, "system_passed_payload_hash_input")?;
        let out = compute_system_passed_payload_hash(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "system_passed_payload_hash",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_system_passed_payload_hash_failed:{e}"));
    }
    if mode == "build_lens_position" {
        let input: BuildLensPositionInput = decode_input(&payload, "build_lens_position_input")?;
        let out = compute_build_lens_position(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "build_lens_position",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_build_lens_position_failed:{e}"));
    }
    if mode == "build_conclave_proposal_summary" {
        let input: BuildConclaveProposalSummaryInput =
            decode_input(&payload, "build_conclave_proposal_summary_input")?;
        let out = compute_build_conclave_proposal_summary(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "build_conclave_proposal_summary",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_build_conclave_proposal_summary_failed:{e}"));
    }
    if mode == "conclave_high_risk_flags" {
        let input: ConclaveHighRiskFlagsInput =
            decode_input(&payload, "conclave_high_risk_flags_input")?;
        let out = compute_conclave_high_risk_flags(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "conclave_high_risk_flags",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_conclave_high_risk_flags_failed:{e}"));
    }
    if mode == "tokenize_text" {
        let input: TokenizeTextInput = decode_input(&payload, "tokenize_text_input")?;
        let out = compute_tokenize_text(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "tokenize_text",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_tokenize_text_failed:{e}"));
    }
    if mode == "normalize_list" {
        let input: NormalizeListInput = decode_input(&payload, "normalize_list_input")?;
        let out = compute_normalize_list(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_list",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_list_failed:{e}"));
    }
    if mode == "normalize_text_list" {
        let input: NormalizeTextListInput = decode_input(&payload, "normalize_text_list_input")?;
        let out = compute_normalize_text_list(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_text_list",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_text_list_failed:{e}"));
    }
    if mode == "parse_json_from_stdout" {
        let input: ParseJsonFromStdoutInput =
            decode_input(&payload, "parse_json_from_stdout_input")?;
        let out = compute_parse_json_from_stdout(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "parse_json_from_stdout",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_parse_json_from_stdout_failed:{e}"));
    }
    if mode == "parse_args" {
        let input: ParseArgsInput = decode_input(&payload, "parse_args_input")?;
        let out = compute_parse_args(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "parse_args",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_parse_args_failed:{e}"));
    }
    if mode == "library_match_score" {
        let input: LibraryMatchScoreInput = decode_input(&payload, "library_match_score_input")?;
        let out = compute_library_match_score(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "library_match_score",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_library_match_score_failed:{e}"));
    }
    if mode == "known_failure_pressure" {
        let input: KnownFailurePressureInput =
            decode_input(&payload, "known_failure_pressure_input")?;
        let out = compute_known_failure_pressure(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "known_failure_pressure",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_known_failure_pressure_failed:{e}"));
    }
    if mode == "has_signal_term_match" {
        let input: HasSignalTermMatchInput = decode_input(&payload, "has_signal_term_match_input")?;
        let out = compute_has_signal_term_match(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "has_signal_term_match",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_has_signal_term_match_failed:{e}"));
    }
    if mode == "count_axiom_signal_groups" {
        let input: CountAxiomSignalGroupsInput =
            decode_input(&payload, "count_axiom_signal_groups_input")?;
        let out = compute_count_axiom_signal_groups(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "count_axiom_signal_groups",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_count_axiom_signal_groups_failed:{e}"));
    }
    if mode == "effective_first_n_human_veto_uses" {
        let input: EffectiveFirstNHumanVetoUsesInput =
            decode_input(&payload, "effective_first_n_human_veto_uses_input")?;
        let out = compute_effective_first_n_human_veto_uses(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "effective_first_n_human_veto_uses",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_effective_first_n_human_veto_uses_failed:{e}"));
    }
    if mode == "normalize_band_map" {
        let input: NormalizeBandMapInput = decode_input(&payload, "normalize_band_map_input")?;
        let out = compute_normalize_band_map(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_band_map",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_band_map_failed:{e}"));
    }
    if mode == "normalize_impact_map" {
        let input: NormalizeImpactMapInput = decode_input(&payload, "normalize_impact_map_input")?;
        let out = compute_normalize_impact_map(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_impact_map",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_impact_map_failed:{e}"));
    }
    if mode == "normalize_target_map" {
        let input: NormalizeTargetMapInput = decode_input(&payload, "normalize_target_map_input")?;
        let out = compute_normalize_target_map(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_target_map",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_target_map_failed:{e}"));
    }
    if mode == "normalize_target_policy" {
        let input: NormalizeTargetPolicyInput =
            decode_input(&payload, "normalize_target_policy_input")?;
        let out = compute_normalize_target_policy(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_target_policy",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_target_policy_failed:{e}"));
    }
    if mode == "window_days_for_target" {
        let input: WindowDaysForTargetInput =
            decode_input(&payload, "window_days_for_target_input")?;
        let out = compute_window_days_for_target(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "window_days_for_target",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_window_days_for_target_failed:{e}"));
    }
    if mode == "tier_retention_days" {
        let input: TierRetentionDaysInput = decode_input(&payload, "tier_retention_days_input")?;
        let out = compute_tier_retention_days(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "tier_retention_days",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_tier_retention_days_failed:{e}"));
    }
    if mode == "parse_candidate_list_from_llm_payload" {
        let input: ParseCandidateListFromLlmPayloadInput =
            decode_input(&payload, "parse_candidate_list_from_llm_payload_input")?;
        let out = compute_parse_candidate_list_from_llm_payload(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "parse_candidate_list_from_llm_payload",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_parse_candidate_list_from_llm_payload_failed:{e}"));
    }
    if mode == "heuristic_filter_candidates" {
        let input: HeuristicFilterCandidatesInput =
            decode_input(&payload, "heuristic_filter_candidates_input")?;
        let out = compute_heuristic_filter_candidates(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "heuristic_filter_candidates",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_heuristic_filter_candidates_failed:{e}"));
    }
    if mode == "score_trial" {
        let input: ScoreTrialInput = decode_input(&payload, "score_trial_input")?;
        let out = compute_score_trial(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "score_trial",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_score_trial_failed:{e}"));
    }
    if mode == "mutate_trial_candidates" {
        let input: MutateTrialCandidatesInput =
            decode_input(&payload, "mutate_trial_candidates_input")?;
        let out = compute_mutate_trial_candidates(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "mutate_trial_candidates",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_mutate_trial_candidates_failed:{e}"));
    }
    Err(format!("inversion_mode_unsupported:{mode}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_impact_matches_expected_set() {
        assert_eq!(
            compute_normalize_impact(&NormalizeImpactInput {
                value: Some("CRITICAL".to_string())
            }),
            NormalizeImpactOutput {
                value: "critical".to_string()
            }
        );
        assert_eq!(
            compute_normalize_impact(&NormalizeImpactInput {
                value: Some("unknown".to_string())
            }),
            NormalizeImpactOutput {
                value: "medium".to_string()
            }
        );
    }

    #[test]
    fn normalize_mode_defaults_live() {
        assert_eq!(
            compute_normalize_mode(&NormalizeModeInput {
                value: Some("test".to_string())
            }),
            NormalizeModeOutput {
                value: "test".to_string()
            }
        );
        assert_eq!(
            compute_normalize_mode(&NormalizeModeInput {
                value: Some("prod".to_string())
            }),
            NormalizeModeOutput {
                value: "live".to_string()
            }
        );
    }

    #[test]
    fn normalize_target_enforces_known_targets() {
        assert_eq!(
            compute_normalize_target(&NormalizeTargetInput {
                value: Some("directive".to_string())
            }),
            NormalizeTargetOutput {
                value: "directive".to_string()
            }
        );
        assert_eq!(
            compute_normalize_target(&NormalizeTargetInput {
                value: Some("unknown".to_string())
            }),
            NormalizeTargetOutput {
                value: "tactical".to_string()
            }
        );
    }

    #[test]
    fn normalize_result_enforces_expected_results() {
        assert_eq!(
            compute_normalize_result(&NormalizeResultInput {
                value: Some("SUCCESS".to_string())
            }),
            NormalizeResultOutput {
                value: "success".to_string()
            }
        );
        assert_eq!(
            compute_normalize_result(&NormalizeResultInput {
                value: Some("maybe".to_string())
            }),
            NormalizeResultOutput {
                value: String::new()
            }
        );
    }

    #[test]
    fn inversion_json_mode_routes() {
        let payload = json!({
            "mode": "normalize_target",
            "normalize_target_input": { "value": "belief" }
        });
        let out = run_inversion_json(&payload.to_string()).expect("inversion normalize_target");
        assert!(out.contains("\"mode\":\"normalize_target\""));
        assert!(out.contains("\"value\":\"belief\""));
    }

    #[test]
    fn objective_id_validation_matches_expected_pattern() {
        let valid = compute_objective_id_valid(&ObjectiveIdValidInput {
            value: Some("T1_objective-alpha".to_string()),
        });
        assert!(valid.valid);
        let invalid = compute_objective_id_valid(&ObjectiveIdValidInput {
            value: Some("bad".to_string()),
        });
        assert!(!invalid.valid);
    }

    #[test]
    fn trit_vector_from_input_normalizes_numeric_tokens() {
        let out = compute_trit_vector_from_input(&TritVectorFromInputInput {
            trit_vector: Some(vec![json!(-2), json!(0), json!(3)]),
            trit_vector_csv: None,
        });
        assert_eq!(out.vector, vec![-1, 0, 1]);
    }

    #[test]
    fn jaccard_similarity_matches_overlap_ratio() {
        let out = compute_jaccard_similarity(&JaccardSimilarityInput {
            left_tokens: vec!["a".to_string(), "b".to_string()],
            right_tokens: vec!["b".to_string(), "c".to_string()],
        });
        assert!((out.similarity - (1.0 / 3.0)).abs() < 1e-9);
    }

    #[test]
    fn trit_similarity_matches_ts_contract() {
        let equal = compute_trit_similarity(&TritSimilarityInput {
            query_vector: vec![json!(1), json!(1), json!(0)],
            entry_trit: Some(json!(1)),
        });
        assert!((equal.similarity - 1.0).abs() < 1e-9);
        let neutral_mix = compute_trit_similarity(&TritSimilarityInput {
            query_vector: vec![json!(0), json!(0)],
            entry_trit: Some(json!(1)),
        });
        assert!((neutral_mix.similarity - 0.6).abs() < 1e-9);
    }

    #[test]
    fn certainty_threshold_reads_band_and_impact() {
        let out = compute_certainty_threshold(&CertaintyThresholdInput {
            thresholds: Some(json!({
                "novice": { "medium": 0.7 },
                "legendary": { "critical": 0.2 }
            })),
            band: Some("legendary".to_string()),
            impact: Some("critical".to_string()),
            allow_zero_for_legendary_critical: Some(true),
        });
        assert!((out.threshold - 0.0).abs() < 1e-9);
    }

    #[test]
    fn max_target_rank_respects_minimum_one() {
        let out = compute_max_target_rank(&MaxTargetRankInput {
            maturity_max_target_rank_by_band: Some(json!({ "mature": 4 })),
            impact_max_target_rank: Some(json!({ "high": 2 })),
            maturity_band: Some("mature".to_string()),
            impact: Some("high".to_string()),
        });
        assert_eq!(out.rank, 2);
    }

    #[test]
    fn extractors_and_permission_parsers_match_contract() {
        let bullets = compute_extract_bullets(&ExtractBulletsInput {
            markdown: Some("- a\n2. b\nnope".to_string()),
            max_items: Some(4),
        });
        assert_eq!(bullets.items, vec!["a".to_string(), "b".to_string()]);

        let list = compute_extract_list_items(&ExtractListItemsInput {
            markdown: Some("- one\n- two\n3. no".to_string()),
            max_items: Some(8),
        });
        assert_eq!(list.items, vec!["one".to_string(), "two".to_string()]);

        let parsed =
            compute_parse_system_internal_permission(&ParseSystemInternalPermissionInput {
                markdown: Some(
                    "- system_internal: {enabled: true, sources: [memory, loops]}".to_string(),
                ),
            });
        assert_eq!(
            parsed,
            ParseSystemInternalPermissionOutput {
                enabled: true,
                sources: vec!["memory".to_string(), "loops".to_string()]
            }
        );

        let rules = compute_parse_soul_token_data_pass_rules(&ParseSoulTokenDataPassRulesInput {
            markdown: Some(
                "## Data Pass Rules\n- allow-system-internal-passed-data\n- Non Runtime"
                    .to_string(),
            ),
        });
        assert_eq!(
            rules.rules,
            vec![
                "allow-system-internal-passed-data".to_string(),
                "non_runtime".to_string()
            ]
        );
    }

    #[test]
    fn system_passed_helpers_are_deterministic() {
        let ensured = compute_ensure_system_passed_section(&EnsureSystemPassedSectionInput {
            feed_text: Some("# Feed".to_string()),
        });
        assert!(ensured.text.contains("## System Passed"));

        let hash = compute_system_passed_payload_hash(&SystemPassedPayloadHashInput {
            source: Some("loop.inversion".to_string()),
            tags: vec!["loops".to_string(), "drift_alert".to_string()],
            payload: Some("drift=0.05".to_string()),
        });
        assert_eq!(hash.hash.len(), 64);
    }

    #[test]
    fn conclave_summary_and_flags_match_expectations() {
        let summary = compute_build_conclave_proposal_summary(&BuildConclaveProposalSummaryInput {
            objective: Some("Improve memory safety".to_string()),
            objective_id: Some("T1_abc".to_string()),
            target: Some("identity".to_string()),
            impact: Some("high".to_string()),
            mode: Some("live".to_string()),
        });
        assert!(summary.summary.contains("Improve memory safety"));

        let position = compute_build_lens_position(&BuildLensPositionInput {
            objective: Some("memory and security flow".to_string()),
            target: Some("tactical".to_string()),
            impact: Some("medium".to_string()),
        });
        assert!(position.position.contains("security fail-closed"));

        let flags = compute_conclave_high_risk_flags(&ConclaveHighRiskFlagsInput {
            payload: Some(json!({
                "ok": true,
                "winner": "vikram",
                "max_divergence": 0.9,
                "persona_outputs": [{ "confidence": 0.4, "recommendation": "disable covenant" }]
            })),
            query: Some("test".to_string()),
            summary: Some("skip parity".to_string()),
            max_divergence: Some(0.45),
            min_confidence: Some(0.6),
            high_risk_keywords: vec!["disable covenant".to_string(), "skip parity".to_string()],
        });
        assert!(flags.flags.contains(&"high_divergence".to_string()));
        assert!(flags.flags.contains(&"low_confidence".to_string()));
        assert!(flags
            .flags
            .contains(&"keyword:disable_covenant".to_string()));
        assert!(flags.flags.contains(&"keyword:skip_parity".to_string()));
    }

    #[test]
    fn creative_penalty_enforces_bounds() {
        let out = compute_creative_penalty(&CreativePenaltyInput {
            enabled: Some(true),
            preferred_creative_lane_ids: vec!["creative_lane".to_string()],
            non_creative_certainty_penalty: Some(0.7),
            selected_lane: Some("other_lane".to_string()),
        });
        assert!(!out.creative_lane_preferred);
        assert!(out.applied);
        assert!((out.penalty - 0.5).abs() < 1e-9);
    }

    #[test]
    fn parser_and_tokenizer_helpers_match_contract() {
        let tokens = compute_tokenize_text(&TokenizeTextInput {
            value: Some("Alpha alpha beta, gamma!".to_string()),
            max_tokens: Some(64),
        });
        assert_eq!(
            tokens.tokens,
            vec!["alpha".to_string(), "beta".to_string(), "gamma".to_string()]
        );

        let norm_list = compute_normalize_list(&NormalizeListInput {
            value: Some(json!(["A B", "a-b", "c"])),
            max_len: Some(80),
        });
        assert_eq!(
            norm_list.items,
            vec!["a_b".to_string(), "a-b".to_string(), "c".to_string()]
        );

        let text_list = compute_normalize_text_list(&NormalizeTextListInput {
            value: Some(json!(" one , two , one ")),
            max_len: Some(180),
            max_items: Some(64),
        });
        assert_eq!(text_list.items, vec!["one".to_string(), "two".to_string()]);

        let parsed = compute_parse_json_from_stdout(&ParseJsonFromStdoutInput {
            raw: Some("noise\n{\"ok\":true}".to_string()),
        });
        assert_eq!(parsed.parsed, Some(json!({"ok": true})));

        let args = compute_parse_args(&ParseArgsInput {
            argv: vec![
                "--mode=test".to_string(),
                "--target".to_string(),
                "belief".to_string(),
                "run".to_string(),
            ],
        });
        assert_eq!(args.args["mode"], json!("test"));
        assert_eq!(args.args["target"], json!("belief"));
        assert_eq!(args.args["_"], json!(["run"]));
    }

    #[test]
    fn scoring_and_signal_helpers_match_contract() {
        let score = compute_library_match_score(&LibraryMatchScoreInput {
            query_signature_tokens: vec!["alpha".to_string(), "beta".to_string()],
            query_trit_vector: vec![json!(1), json!(1)],
            query_target: Some("identity".to_string()),
            row_signature_tokens: vec!["beta".to_string(), "gamma".to_string()],
            row_outcome_trit: Some(1),
            row_target: Some("identity".to_string()),
            token_weight: Some(0.5),
            trit_weight: Some(0.3),
            target_weight: Some(0.2),
        });
        assert!((score.score - 0.666667).abs() < 1e-6);

        let pressure = compute_known_failure_pressure(&KnownFailurePressureInput {
            failed_repetition_similarity_block: Some(0.72),
            candidates: vec![
                json!({"row":{"outcome_trit":-1},"similarity":0.9}),
                json!({"row":{"outcome_trit":0},"similarity":0.8}),
            ],
        });
        assert_eq!(pressure.fail_count, 1);
        assert!(pressure.hard_block);

        let has_term = compute_has_signal_term_match(&HasSignalTermMatchInput {
            haystack: Some("optimize memory safety gate".to_string()),
            token_set: vec![
                "optimize".to_string(),
                "memory".to_string(),
                "safety".to_string(),
            ],
            term: Some("memory safety".to_string()),
        });
        assert!(has_term.matched);

        let groups = compute_count_axiom_signal_groups(&CountAxiomSignalGroupsInput {
            action_terms: vec!["optimize".to_string()],
            subject_terms: vec!["memory safety".to_string()],
            object_terms: vec!["gate".to_string()],
            min_signal_groups: Some(2),
            haystack: Some("optimize memory safety gate".to_string()),
            token_set: vec![
                "optimize".to_string(),
                "memory".to_string(),
                "safety".to_string(),
                "gate".to_string(),
            ],
        });
        assert_eq!(groups.configured_groups, 3);
        assert_eq!(groups.matched_groups, 3);
        assert!(groups.pass);

        let veto = compute_effective_first_n_human_veto_uses(&EffectiveFirstNHumanVetoUsesInput {
            first_live_uses_require_human_veto: Some(json!({"identity": 2})),
            minimum_first_live_uses_require_human_veto: Some(json!({"identity": 5})),
            target: Some("identity".to_string()),
        });
        assert_eq!(veto.uses, 5);
    }

    #[test]
    fn tree_and_trial_helpers_match_contract() {
        let band = compute_normalize_band_map(&NormalizeBandMapInput {
            raw: Some(json!({"novice": 0.7, "mature": -1})),
            base: Some(
                json!({"novice": 0.4, "developing": 0.5, "mature": 0.6, "seasoned": 0.7, "legendary": 0.8}),
            ),
            lo: Some(0.0),
            hi: Some(1.0),
        });
        assert!((band.novice - 0.7).abs() < 1e-9);
        assert!((band.mature - 0.0).abs() < 1e-9);

        let impact = compute_normalize_impact_map(&NormalizeImpactMapInput {
            raw: Some(json!({"critical": 1.5})),
            base: Some(json!({"low": 0.2, "medium": 0.4, "high": 0.6, "critical": 0.8})),
            lo: Some(0.0),
            hi: Some(1.0),
        });
        assert!((impact.critical - 1.0).abs() < 1e-9);

        let target_map = compute_normalize_target_map(&NormalizeTargetMapInput {
            raw: Some(json!({"identity": 0.9})),
            base: Some(
                json!({"tactical": 0.1, "belief": 0.2, "identity": 0.3, "directive": 0.4, "constitution": 0.5}),
            ),
            lo: Some(0.0),
            hi: Some(1.0),
        });
        assert!((target_map.identity - 0.9).abs() < 1e-9);

        let target_policy = compute_normalize_target_policy(&NormalizeTargetPolicyInput {
            raw: Some(
                json!({"rank": 12, "live_enabled": "yes", "test_enabled": "off", "require_human_veto_live": "1", "min_shadow_hours": 3}),
            ),
            base: Some(
                json!({"rank": 2, "live_enabled": false, "test_enabled": true, "require_human_veto_live": false, "min_shadow_hours": 1}),
            ),
        });
        assert_eq!(target_policy.rank, 10);
        assert!(target_policy.live_enabled);
        assert!(!target_policy.test_enabled);
        assert!(target_policy.require_human_veto_live);
        assert_eq!(target_policy.min_shadow_hours, 3);

        let retention = compute_tier_retention_days(&TierRetentionDaysInput {
            policy: Some(json!({
                "tier_transition": { "window_days_by_target": { "tactical": 60 }, "minimum_window_days_by_target": { "identity": 120 } },
                "shadow_pass_gate": { "window_days_by_target": { "belief": 45 } }
            })),
        });
        assert_eq!(retention.days, 365);

        let window = compute_window_days_for_target(&WindowDaysForTargetInput {
            window_map: Some(json!({"identity": 30})),
            target: Some("identity".to_string()),
            fallback: Some(90),
        });
        assert_eq!(window.days, 30);

        let parsed = compute_parse_candidate_list_from_llm_payload(
            &ParseCandidateListFromLlmPayloadInput {
                payload: Some(json!({
                    "candidates": [
                        { "id": "c1", "filters": ["risk_guard_compaction", "fallback_pathing"], "probability": 0.8, "rationale": "ok" },
                        { "id": "c2", "filters": [], "probability": 0.4, "rationale": "skip" }
                    ]
                })),
            },
        );
        assert_eq!(parsed.candidates.len(), 1);
        assert_eq!(parsed.candidates[0].id, "c1");

        let heuristic = compute_heuristic_filter_candidates(&HeuristicFilterCandidatesInput {
            objective: Some("reduce budget drift".to_string()),
        });
        assert!(heuristic.candidates.len() >= 7);

        let score = compute_score_trial(&ScoreTrialInput {
            decision: Some(json!({
                "allowed": true,
                "attractor": { "score": 0.7 },
                "input": { "effective_certainty": 0.9 },
                "gating": { "required_certainty": 0.5 }
            })),
            candidate: Some(json!({ "score_hint": 0.8 })),
            trial_cfg: Some(json!({
                "score_weights": {
                    "decision_allowed": 0.35,
                    "attractor": 0.2,
                    "certainty_margin": 0.15,
                    "library_similarity": 0.1,
                    "runtime_probe": 0.2
                }
            })),
            runtime_probe_pass: Some(true),
        });
        assert!(score.score > 0.8);

        let mutated = compute_mutate_trial_candidates(&MutateTrialCandidatesInput {
            rows: vec![
                json!({"id":"n1","filters":["constraint_reframe"],"source":"heuristic","probability":0.5,"score_hint":0.4}),
            ],
        });
        assert_eq!(mutated.rows.len(), 1);
        let row = mutated.rows[0].as_object().expect("mutated row object");
        assert!(row
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .contains("_m1"));
        assert!(row
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .contains("_mutated"));
    }
}
