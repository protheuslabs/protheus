use chrono::{SecondsFormat, TimeZone, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

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

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeIsoEventsInput {
    #[serde(default)]
    pub src: Vec<Value>,
    #[serde(default)]
    pub max_rows: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeIsoEventsOutput {
    pub events: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ExpandLegacyCountToEventsInput {
    #[serde(default)]
    pub count: Option<Value>,
    #[serde(default)]
    pub ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ExpandLegacyCountToEventsOutput {
    pub events: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeTierEventMapInput {
    #[serde(default)]
    pub src: Option<Value>,
    #[serde(default)]
    pub fallback: Option<Value>,
    #[serde(default)]
    pub legacy_counts: Option<Value>,
    #[serde(default)]
    pub legacy_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeTierEventMapOutput {
    pub map: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct DefaultTierScopeInput {
    #[serde(default)]
    pub legacy: Option<Value>,
    #[serde(default)]
    pub legacy_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DefaultTierScopeOutput {
    pub scope: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeTierScopeInput {
    #[serde(default)]
    pub scope: Option<Value>,
    #[serde(default)]
    pub legacy: Option<Value>,
    #[serde(default)]
    pub legacy_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeTierScopeOutput {
    pub scope: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct DefaultTierGovernanceStateInput {
    #[serde(default)]
    pub policy_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DefaultTierGovernanceStateOutput {
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CloneTierScopeInput {
    #[serde(default)]
    pub scope: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CloneTierScopeOutput {
    pub scope: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct PruneTierScopeEventsInput {
    #[serde(default)]
    pub scope: Option<Value>,
    #[serde(default)]
    pub retention_days: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PruneTierScopeEventsOutput {
    pub scope: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CountTierEventsInput {
    #[serde(default)]
    pub scope: Option<Value>,
    #[serde(default)]
    pub metric: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub window_days: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CountTierEventsOutput {
    pub count: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct EffectiveWindowDaysForTargetInput {
    #[serde(default)]
    pub window_map: Option<Value>,
    #[serde(default)]
    pub minimum_window_map: Option<Value>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub fallback: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EffectiveWindowDaysForTargetOutput {
    pub days: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ToDateInput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ToDateOutput {
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ParseTsMsInput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ParseTsMsOutput {
    pub ts_ms: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AddMinutesInput {
    #[serde(default)]
    pub iso_ts: Option<String>,
    #[serde(default)]
    pub minutes: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AddMinutesOutput {
    pub iso_ts: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ClampIntInput {
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub lo: Option<i64>,
    #[serde(default)]
    pub hi: Option<i64>,
    #[serde(default)]
    pub fallback: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ClampIntOutput {
    pub value: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ClampNumberInput {
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub lo: Option<f64>,
    #[serde(default)]
    pub hi: Option<f64>,
    #[serde(default)]
    pub fallback: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClampNumberOutput {
    pub value: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ToBoolInput {
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub fallback: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ToBoolOutput {
    pub value: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CleanTextInput {
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub max_len: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CleanTextOutput {
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeTokenInput {
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub max_len: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeTokenOutput {
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeWordTokenInput {
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub max_len: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeWordTokenOutput {
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct BandToIndexInput {
    #[serde(default)]
    pub band: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BandToIndexOutput {
    pub index: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct EscapeRegexInput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EscapeRegexOutput {
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct PatternToWordRegexInput {
    #[serde(default)]
    pub pattern: Option<String>,
    #[serde(default)]
    pub max_len: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PatternToWordRegexOutput {
    pub source: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct StableIdInput {
    #[serde(default)]
    pub seed: Option<String>,
    #[serde(default)]
    pub prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StableIdOutput {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct RelPathInput {
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default)]
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RelPathOutput {
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeAxiomPatternInput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeAxiomPatternOutput {
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeAxiomSignalTermsInput {
    #[serde(default)]
    pub terms: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeAxiomSignalTermsOutput {
    pub terms: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeObserverIdInput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeObserverIdOutput {
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ExtractNumericInput {
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ExtractNumericOutput {
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct PickFirstNumericInput {
    #[serde(default)]
    pub candidates: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PickFirstNumericOutput {
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SafeRelPathInput {
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default)]
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SafeRelPathOutput {
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NowIsoInput {}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NowIsoOutput {
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct DefaultTierEventMapInput {}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DefaultTierEventMapOutput {
    pub map: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CoerceTierEventMapInput {
    #[serde(default)]
    pub map: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CoerceTierEventMapOutput {
    pub map: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GetTierScopeInput {
    #[serde(default)]
    pub state: Option<Value>,
    #[serde(default)]
    pub policy_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GetTierScopeOutput {
    pub state: Value,
    pub scope: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LoadTierGovernanceStateInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub policy_version: Option<String>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LoadTierGovernanceStateOutput {
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SaveTierGovernanceStateInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub state: Option<Value>,
    #[serde(default)]
    pub policy_version: Option<String>,
    #[serde(default)]
    pub retention_days: Option<i64>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SaveTierGovernanceStateOutput {
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct PushTierEventInput {
    #[serde(default)]
    pub scope_map: Option<Value>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PushTierEventOutput {
    pub map: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AddTierEventInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub policy: Option<Value>,
    #[serde(default)]
    pub metric: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub ts: Option<String>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AddTierEventOutput {
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct IncrementLiveApplyAttemptInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub policy: Option<Value>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IncrementLiveApplyAttemptOutput {
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct IncrementLiveApplySuccessInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub policy: Option<Value>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IncrementLiveApplySuccessOutput {
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct IncrementLiveApplySafeAbortInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub policy: Option<Value>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IncrementLiveApplySafeAbortOutput {
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct UpdateShadowTrialCountersInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub policy: Option<Value>,
    #[serde(default)]
    pub session: Option<Value>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub destructive: Option<bool>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UpdateShadowTrialCountersOutput {
    pub state: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct DefaultHarnessStateInput {}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DefaultHarnessStateOutput {
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct DefaultFirstPrincipleLockStateInput {}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DefaultFirstPrincipleLockStateOutput {
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct DefaultMaturityStateInput {}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DefaultMaturityStateOutput {
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct PrincipleKeyForSessionInput {
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub objective: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PrincipleKeyForSessionOutput {
    pub key: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeObjectiveArgInput {
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeObjectiveArgOutput {
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct MaturityBandOrderInput {}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MaturityBandOrderOutput {
    pub bands: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CurrentRuntimeModeInput {
    #[serde(default)]
    pub env_mode: Option<String>,
    #[serde(default)]
    pub args_mode: Option<String>,
    #[serde(default)]
    pub policy_runtime_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CurrentRuntimeModeOutput {
    pub mode: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ReadDriftFromStateFileInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ReadDriftFromStateFileOutput {
    pub value: f64,
    pub source: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ResolveLensGateDriftInput {
    #[serde(default)]
    pub arg_candidates: Vec<Value>,
    #[serde(default)]
    pub probe_path: Option<String>,
    #[serde(default)]
    pub probe_source: Option<String>,
    #[serde(default)]
    pub probe_payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ResolveLensGateDriftOutput {
    pub value: f64,
    pub source: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ResolveParityConfidenceInput {
    #[serde(default)]
    pub arg_candidates: Vec<Value>,
    #[serde(default)]
    pub path_hint: Option<String>,
    #[serde(default)]
    pub path_source: Option<String>,
    #[serde(default)]
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ResolveParityConfidenceOutput {
    pub value: f64,
    pub source: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ComputeAttractorScoreInput {
    #[serde(default)]
    pub attractor: Option<Value>,
    #[serde(default)]
    pub objective: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub external_signals_count: Option<Value>,
    #[serde(default)]
    pub evidence_count: Option<Value>,
    #[serde(default)]
    pub effective_certainty: Option<Value>,
    #[serde(default)]
    pub trit: Option<Value>,
    #[serde(default)]
    pub impact: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ComputeAttractorScoreOutput {
    pub enabled: bool,
    pub score: f64,
    pub required: f64,
    pub pass: bool,
    pub components: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct BuildOutputInterfacesInput {
    #[serde(default)]
    pub outputs: Option<Value>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub sandbox_verified: Option<Value>,
    #[serde(default)]
    pub explicit_code_proposal_emit: Option<Value>,
    #[serde(default)]
    pub channel_payloads: Option<Value>,
    #[serde(default)]
    pub base_payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BuildOutputInterfacesOutput {
    pub default_channel: String,
    pub active_channel: Option<String>,
    pub channels: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct BuildCodeChangeProposalDraftInput {
    #[serde(default)]
    pub base: Option<Value>,
    #[serde(default)]
    pub args: Option<Value>,
    #[serde(default)]
    pub opts: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BuildCodeChangeProposalDraftOutput {
    pub proposal: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeLibraryRowInput {
    #[serde(default)]
    pub row: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NormalizeLibraryRowOutput {
    pub row: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct EnsureDirInput {
    #[serde(default)]
    pub dir_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EnsureDirOutput {
    pub ok: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ReadJsonInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub fallback: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ReadJsonOutput {
    pub value: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ReadJsonlInput {
    #[serde(default)]
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ReadJsonlOutput {
    pub rows: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct WriteJsonAtomicInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WriteJsonAtomicOutput {
    pub ok: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AppendJsonlInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub row: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AppendJsonlOutput {
    pub ok: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ReadTextInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub fallback: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReadTextOutput {
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LatestJsonFileInDirInput {
    #[serde(default)]
    pub dir_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LatestJsonFileInDirOutput {
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeOutputChannelInput {
    #[serde(default)]
    pub base_out: Option<Value>,
    #[serde(default)]
    pub src_out: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeOutputChannelOutput {
    pub enabled: bool,
    pub live_enabled: bool,
    pub test_enabled: bool,
    pub require_sandbox_verification: bool,
    pub require_explicit_emit: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeRepoPathInput {
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub fallback: Option<String>,
    #[serde(default)]
    pub root: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NormalizeRepoPathOutput {
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct RuntimePathsInput {
    #[serde(default)]
    pub policy_path: Option<String>,
    #[serde(default)]
    pub inversion_state_dir_env: Option<String>,
    #[serde(default)]
    pub dual_brain_policy_path_env: Option<String>,
    #[serde(default)]
    pub default_state_dir: Option<String>,
    #[serde(default)]
    pub root: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RuntimePathsOutput {
    pub paths: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeAxiomListInput {
    #[serde(default)]
    pub raw_axioms: Option<Value>,
    #[serde(default)]
    pub base_axioms: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NormalizeAxiomListOutput {
    pub axioms: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NormalizeHarnessSuiteInput {
    #[serde(default)]
    pub raw_suite: Option<Value>,
    #[serde(default)]
    pub base_suite: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NormalizeHarnessSuiteOutput {
    pub suite: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LoadHarnessStateInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LoadHarnessStateOutput {
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SaveHarnessStateInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub state: Option<Value>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SaveHarnessStateOutput {
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LoadFirstPrincipleLockStateInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LoadFirstPrincipleLockStateOutput {
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SaveFirstPrincipleLockStateInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub state: Option<Value>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SaveFirstPrincipleLockStateOutput {
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CheckFirstPrincipleDowngradeInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub policy: Option<Value>,
    #[serde(default)]
    pub session: Option<Value>,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CheckFirstPrincipleDowngradeOutput {
    pub allowed: bool,
    pub reason: Option<String>,
    pub key: String,
    pub lock_state: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct UpsertFirstPrincipleLockInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub session: Option<Value>,
    #[serde(default)]
    pub principle: Option<Value>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UpsertFirstPrincipleLockOutput {
    pub state: Value,
    pub key: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LoadObserverApprovalsInput {
    #[serde(default)]
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LoadObserverApprovalsOutput {
    pub rows: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AppendObserverApprovalInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub observer_id: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AppendObserverApprovalOutput {
    pub row: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CountObserverApprovalsInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub window_days: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CountObserverApprovalsOutput {
    pub count: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct EnsureCorrespondenceFileInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub header: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EnsureCorrespondenceFileOutput {
    pub ok: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LoadMaturityStateInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub policy: Option<Value>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LoadMaturityStateOutput {
    pub state: Value,
    pub computed: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SaveMaturityStateInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub policy: Option<Value>,
    #[serde(default)]
    pub state: Option<Value>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SaveMaturityStateOutput {
    pub state: Value,
    pub computed: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LoadActiveSessionsInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LoadActiveSessionsOutput {
    pub store: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SaveActiveSessionsInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub store: Option<Value>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SaveActiveSessionsOutput {
    pub store: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct EmitEventInput {
    #[serde(default)]
    pub events_dir: Option<String>,
    #[serde(default)]
    pub date_str: Option<String>,
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub payload: Option<Value>,
    #[serde(default)]
    pub emit_events: Option<bool>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EmitEventOutput {
    pub emitted: bool,
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AppendPersonaLensGateReceiptInput {
    #[serde(default)]
    pub state_dir: Option<String>,
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default)]
    pub cfg_receipts_path: Option<String>,
    #[serde(default)]
    pub payload: Option<Value>,
    #[serde(default)]
    pub decision: Option<Value>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AppendPersonaLensGateReceiptOutput {
    pub rel_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AppendConclaveCorrespondenceInput {
    #[serde(default)]
    pub correspondence_path: Option<String>,
    #[serde(default)]
    pub row: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AppendConclaveCorrespondenceOutput {
    pub ok: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct PersistDecisionInput {
    #[serde(default)]
    pub latest_path: Option<String>,
    #[serde(default)]
    pub history_path: Option<String>,
    #[serde(default)]
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PersistDecisionOutput {
    pub ok: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct PersistInterfaceEnvelopeInput {
    #[serde(default)]
    pub latest_path: Option<String>,
    #[serde(default)]
    pub history_path: Option<String>,
    #[serde(default)]
    pub envelope: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PersistInterfaceEnvelopeOutput {
    pub ok: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct TrimLibraryInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub max_entries: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TrimLibraryOutput {
    pub rows: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct DetectImmutableAxiomViolationInput {
    #[serde(default)]
    pub policy: Option<Value>,
    #[serde(default)]
    pub decision_input: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DetectImmutableAxiomViolationOutput {
    pub hits: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ComputeMaturityScoreInput {
    #[serde(default)]
    pub state: Option<Value>,
    #[serde(default)]
    pub policy: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ComputeMaturityScoreOutput {
    pub score: f64,
    pub band: String,
    pub pass_rate: f64,
    pub non_destructive_rate: f64,
    pub experience: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SelectLibraryCandidatesInput {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub policy: Option<Value>,
    #[serde(default)]
    pub query: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SelectLibraryCandidatesOutput {
    pub candidates: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ParseLaneDecisionInput {
    #[serde(default)]
    pub args: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ParseLaneDecisionOutput {
    pub selected_lane: String,
    pub source: String,
    pub route: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SweepExpiredSessionsInput {
    #[serde(default)]
    pub paths: Option<Value>,
    #[serde(default)]
    pub policy: Option<Value>,
    #[serde(default)]
    pub date_str: Option<String>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SweepExpiredSessionsOutput {
    pub expired_count: i64,
    pub sessions: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LoadImpossibilitySignalsInput {
    #[serde(default)]
    pub policy: Option<Value>,
    #[serde(default)]
    pub date_str: Option<String>,
    #[serde(default)]
    pub root: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LoadImpossibilitySignalsOutput {
    pub signals: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct EvaluateImpossibilityTriggerInput {
    #[serde(default)]
    pub policy: Option<Value>,
    #[serde(default)]
    pub signals: Option<Value>,
    #[serde(default)]
    pub force: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EvaluateImpossibilityTriggerOutput {
    pub triggered: bool,
    pub forced: bool,
    pub enabled: bool,
    pub score: f64,
    pub threshold: f64,
    pub signal_count: i64,
    pub min_signal_count: i64,
    pub reasons: Vec<String>,
    pub components: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ExtractFirstPrincipleInput {
    #[serde(default)]
    pub policy: Option<Value>,
    #[serde(default)]
    pub session: Option<Value>,
    #[serde(default)]
    pub args: Option<Value>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ExtractFirstPrincipleOutput {
    pub principle: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ExtractFailureClusterPrincipleInput {
    #[serde(default)]
    pub paths: Option<Value>,
    #[serde(default)]
    pub policy: Option<Value>,
    #[serde(default)]
    pub session: Option<Value>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ExtractFailureClusterPrincipleOutput {
    pub principle: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct PersistFirstPrincipleInput {
    #[serde(default)]
    pub paths: Option<Value>,
    #[serde(default)]
    pub session: Option<Value>,
    #[serde(default)]
    pub principle: Option<Value>,
    #[serde(default)]
    pub now_iso: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PersistFirstPrincipleOutput {
    pub principle: Value,
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
    let v = value?;
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

fn normalize_slashes(value: &str) -> String {
    value.replace('\\', "/")
}

fn split_path_components(value: &str) -> (String, Vec<String>) {
    let normalized = normalize_slashes(value.trim());
    let mut prefix = String::new();
    let mut cursor = normalized.as_str();

    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        prefix = normalized[..2].to_lowercase();
        cursor = &normalized[2..];
    } else if let Some(stripped) = normalized.strip_prefix('/') {
        prefix = "/".to_string();
        cursor = stripped;
    }

    let mut parts: Vec<String> = Vec::new();
    for raw in cursor.split('/') {
        if raw.is_empty() || raw == "." {
            continue;
        }
        if raw == ".." {
            if !parts.is_empty() && parts.last().map(|last| last != "..").unwrap_or(false) {
                parts.pop();
            } else if prefix.is_empty() {
                parts.push("..".to_string());
            }
            continue;
        }
        parts.push(raw.to_string());
    }
    (prefix, parts)
}

fn rel_path_runtime(root: &str, file_path: &str) -> String {
    let root_clean = root.trim();
    let file_clean = file_path.trim();
    if file_clean.is_empty() {
        return String::new();
    }
    let normalized_file = normalize_slashes(file_clean);
    if root_clean.is_empty() {
        return normalized_file;
    }

    let (root_prefix, root_parts) = split_path_components(root_clean);
    let (file_prefix, file_parts) = split_path_components(file_clean);
    if root_prefix != file_prefix {
        return normalized_file;
    }

    let mut common = 0usize;
    while common < root_parts.len() && common < file_parts.len() {
        if root_parts[common] != file_parts[common] {
            break;
        }
        common += 1;
    }

    let mut out: Vec<String> = Vec::new();
    for _ in common..root_parts.len() {
        out.push("..".to_string());
    }
    for part in file_parts.iter().skip(common) {
        out.push(part.to_string());
    }

    out.join("/")
}

fn js_number_for_extract(value: Option<&Value>) -> Option<f64> {
    let v = value?;
    match v {
        Value::Null => Some(0.0),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return Some(0.0);
            }
            trimmed.parse::<f64>().ok()
        }
        _ => None,
    }
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

const TIER_TARGETS: [&str; 5] = [
    "tactical",
    "belief",
    "identity",
    "directive",
    "constitution",
];
const TIER_METRICS: [&str; 5] = [
    "live_apply_attempts",
    "live_apply_successes",
    "live_apply_safe_aborts",
    "shadow_passes",
    "shadow_critical_failures",
];

fn now_iso_runtime() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_ts_ms_runtime(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

fn array_to_string_rows(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .map(|row| value_to_string(Some(row)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn default_tier_event_map_value() -> Value {
    json!({
        "tactical": [],
        "belief": [],
        "identity": [],
        "directive": [],
        "constitution": []
    })
}

pub fn compute_normalize_iso_events(input: &NormalizeIsoEventsInput) -> NormalizeIsoEventsOutput {
    let max_rows = input.max_rows.unwrap_or(10000).clamp(1, 100000) as usize;
    let mut out = input
        .src
        .iter()
        .map(|row| value_to_string(Some(row)).trim().to_string())
        .filter(|row| parse_ts_ms_runtime(row) > 0)
        .collect::<Vec<_>>();
    if out.len() > max_rows {
        out = out[(out.len() - max_rows)..].to_vec();
    }
    out.sort_by_key(|row| parse_ts_ms_runtime(row));
    let mut dedup = Vec::new();
    for row in out {
        if !dedup.iter().any(|existing| existing == &row) {
            dedup.push(row);
        }
    }
    NormalizeIsoEventsOutput { events: dedup }
}

pub fn compute_expand_legacy_count_to_events(
    input: &ExpandLegacyCountToEventsInput,
) -> ExpandLegacyCountToEventsOutput {
    let n = clamp_int_value(input.count.as_ref(), 0, 4096, 0);
    if n <= 0 {
        return ExpandLegacyCountToEventsOutput { events: Vec::new() };
    }
    let ts = input.ts.clone().unwrap_or_else(now_iso_runtime);
    ExpandLegacyCountToEventsOutput {
        events: (0..n).map(|_| ts.clone()).collect::<Vec<_>>(),
    }
}

fn normalize_tier_event_map_value(
    src: Option<&Value>,
    fallback: Option<&Value>,
    legacy_counts: Option<&Value>,
    legacy_ts: &str,
) -> Value {
    let mut out = serde_json::Map::new();
    for target in TIER_TARGETS {
        let src_rows = src
            .and_then(|v| v.as_object())
            .and_then(|m| m.get(target))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if !src_rows.is_empty() {
            let normalized = compute_normalize_iso_events(&NormalizeIsoEventsInput {
                src: src_rows,
                max_rows: Some(10000),
            });
            out.insert(
                target.to_string(),
                Value::Array(
                    normalized
                        .events
                        .into_iter()
                        .map(Value::String)
                        .collect::<Vec<_>>(),
                ),
            );
            continue;
        }

        let legacy_count = legacy_counts
            .and_then(|v| v.as_object())
            .and_then(|m| m.get(target))
            .cloned();
        if legacy_count.is_some() {
            let legacy = compute_expand_legacy_count_to_events(&ExpandLegacyCountToEventsInput {
                count: legacy_count,
                ts: Some(legacy_ts.to_string()),
            });
            if !legacy.events.is_empty() {
                out.insert(
                    target.to_string(),
                    Value::Array(
                        legacy
                            .events
                            .into_iter()
                            .map(Value::String)
                            .collect::<Vec<_>>(),
                    ),
                );
                continue;
            }
        }

        let fallback_rows = array_to_string_rows(
            fallback
                .and_then(|v| v.as_object())
                .and_then(|m| m.get(target)),
        );
        out.insert(
            target.to_string(),
            Value::Array(
                fallback_rows
                    .into_iter()
                    .map(Value::String)
                    .collect::<Vec<_>>(),
            ),
        );
    }
    Value::Object(out)
}

pub fn compute_normalize_tier_event_map(
    input: &NormalizeTierEventMapInput,
) -> NormalizeTierEventMapOutput {
    let legacy_ts = input.legacy_ts.clone().unwrap_or_else(now_iso_runtime);
    NormalizeTierEventMapOutput {
        map: normalize_tier_event_map_value(
            input.src.as_ref(),
            input.fallback.as_ref(),
            input.legacy_counts.as_ref(),
            &legacy_ts,
        ),
    }
}

fn default_tier_scope_value(legacy: Option<&Value>, legacy_ts: &str) -> Value {
    let live_apply_attempts = normalize_tier_event_map_value(
        Some(&json!({})),
        Some(&default_tier_event_map_value()),
        legacy
            .and_then(|v| v.as_object())
            .and_then(|m| m.get("live_apply_attempts"))
            .or_else(|| {
                legacy
                    .and_then(|v| v.as_object())
                    .and_then(|m| m.get("live_apply_counts"))
            }),
        legacy_ts,
    );
    let live_apply_successes = normalize_tier_event_map_value(
        Some(&json!({})),
        Some(&default_tier_event_map_value()),
        legacy
            .and_then(|v| v.as_object())
            .and_then(|m| m.get("live_apply_successes"))
            .or_else(|| {
                legacy
                    .and_then(|v| v.as_object())
                    .and_then(|m| m.get("live_apply_counts"))
            }),
        legacy_ts,
    );
    let live_apply_safe_aborts = normalize_tier_event_map_value(
        Some(&json!({})),
        Some(&default_tier_event_map_value()),
        legacy
            .and_then(|v| v.as_object())
            .and_then(|m| m.get("live_apply_safe_aborts")),
        legacy_ts,
    );
    let shadow_passes = normalize_tier_event_map_value(
        Some(&json!({})),
        Some(&default_tier_event_map_value()),
        legacy
            .and_then(|v| v.as_object())
            .and_then(|m| m.get("shadow_passes"))
            .or_else(|| {
                legacy
                    .and_then(|v| v.as_object())
                    .and_then(|m| m.get("shadow_pass_counts"))
            }),
        legacy_ts,
    );
    let shadow_critical_failures = normalize_tier_event_map_value(
        Some(&json!({})),
        Some(&default_tier_event_map_value()),
        legacy
            .and_then(|v| v.as_object())
            .and_then(|m| m.get("shadow_critical_failures")),
        legacy_ts,
    );
    json!({
        "live_apply_attempts": live_apply_attempts,
        "live_apply_successes": live_apply_successes,
        "live_apply_safe_aborts": live_apply_safe_aborts,
        "shadow_passes": shadow_passes,
        "shadow_critical_failures": shadow_critical_failures
    })
}

pub fn compute_default_tier_scope(input: &DefaultTierScopeInput) -> DefaultTierScopeOutput {
    let legacy_ts = input.legacy_ts.clone().unwrap_or_else(now_iso_runtime);
    DefaultTierScopeOutput {
        scope: default_tier_scope_value(input.legacy.as_ref(), &legacy_ts),
    }
}

fn normalize_tier_scope_value(
    scope: Option<&Value>,
    legacy: Option<&Value>,
    legacy_ts: &str,
) -> Value {
    let src = scope
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let fallback = default_tier_scope_value(legacy, legacy_ts);
    json!({
        "live_apply_attempts": normalize_tier_event_map_value(src.get("live_apply_attempts"), value_path(Some(&fallback), &["live_apply_attempts"]), None, legacy_ts),
        "live_apply_successes": normalize_tier_event_map_value(src.get("live_apply_successes"), value_path(Some(&fallback), &["live_apply_successes"]), None, legacy_ts),
        "live_apply_safe_aborts": normalize_tier_event_map_value(src.get("live_apply_safe_aborts"), value_path(Some(&fallback), &["live_apply_safe_aborts"]), None, legacy_ts),
        "shadow_passes": normalize_tier_event_map_value(src.get("shadow_passes"), value_path(Some(&fallback), &["shadow_passes"]), None, legacy_ts),
        "shadow_critical_failures": normalize_tier_event_map_value(src.get("shadow_critical_failures"), value_path(Some(&fallback), &["shadow_critical_failures"]), None, legacy_ts)
    })
}

pub fn compute_normalize_tier_scope(input: &NormalizeTierScopeInput) -> NormalizeTierScopeOutput {
    let legacy_ts = input.legacy_ts.clone().unwrap_or_else(now_iso_runtime);
    NormalizeTierScopeOutput {
        scope: normalize_tier_scope_value(input.scope.as_ref(), input.legacy.as_ref(), &legacy_ts),
    }
}

pub fn compute_default_tier_governance_state(
    input: &DefaultTierGovernanceStateInput,
) -> DefaultTierGovernanceStateOutput {
    let version = clean_text_runtime(input.policy_version.as_deref().unwrap_or("1.0"), 24);
    let safe_version = if version.is_empty() {
        "1.0".to_string()
    } else {
        version
    };
    let scope = default_tier_scope_value(None, &now_iso_runtime());
    DefaultTierGovernanceStateOutput {
        state: json!({
            "schema_id": "inversion_tier_governance_state",
            "schema_version": "1.0",
            "active_policy_version": safe_version,
            "updated_at": now_iso_runtime(),
            "scopes": {
                safe_version.clone(): scope
            }
        }),
    }
}

pub fn compute_clone_tier_scope(input: &CloneTierScopeInput) -> CloneTierScopeOutput {
    CloneTierScopeOutput {
        scope: normalize_tier_scope_value(input.scope.as_ref(), None, &now_iso_runtime()),
    }
}

pub fn compute_prune_tier_scope_events(
    input: &PruneTierScopeEventsInput,
) -> PruneTierScopeEventsOutput {
    let retention_days = input.retention_days.unwrap_or(365).clamp(1, 3650);
    let mut out = normalize_tier_scope_value(input.scope.as_ref(), None, &now_iso_runtime());
    let keep_cutoff = Utc::now().timestamp_millis() - (retention_days * 24 * 60 * 60 * 1000);
    for metric in TIER_METRICS {
        let mut map = out
            .as_object()
            .and_then(|obj| obj.get(metric))
            .cloned()
            .unwrap_or_else(default_tier_event_map_value);
        for target in TIER_TARGETS {
            let rows = map
                .as_object()
                .and_then(|m| m.get(target))
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let filtered = rows
                .iter()
                .map(|row| value_to_string(Some(row)))
                .filter(|row| parse_ts_ms_runtime(row) >= keep_cutoff)
                .collect::<Vec<_>>();
            let kept = if filtered.len() > 10000 {
                filtered[(filtered.len() - 10000)..].to_vec()
            } else {
                filtered
            };
            if let Some(map_obj) = map.as_object_mut() {
                map_obj.insert(
                    target.to_string(),
                    Value::Array(kept.into_iter().map(Value::String).collect::<Vec<_>>()),
                );
            }
        }
        if let Some(obj) = out.as_object_mut() {
            obj.insert(metric.to_string(), map);
        }
    }
    PruneTierScopeEventsOutput { scope: out }
}

pub fn compute_count_tier_events(input: &CountTierEventsInput) -> CountTierEventsOutput {
    let metric = clean_text_runtime(input.metric.as_deref().unwrap_or(""), 80);
    let target = normalize_target_for_key(input.target.as_deref().unwrap_or("tactical"));
    let map = input
        .scope
        .as_ref()
        .and_then(|scope| scope.as_object())
        .and_then(|scope| scope.get(&metric))
        .cloned()
        .unwrap_or_else(default_tier_event_map_value);
    let rows = map
        .as_object()
        .and_then(|m| m.get(&target))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let window_days = input.window_days.unwrap_or(90).clamp(1, 3650);
    let cutoff = Utc::now().timestamp_millis() - (window_days * 24 * 60 * 60 * 1000);
    let count = rows
        .iter()
        .filter(|row| parse_ts_ms_runtime(&value_to_string(Some(row))) >= cutoff)
        .count() as i64;
    CountTierEventsOutput { count }
}

pub fn compute_effective_window_days_for_target(
    input: &EffectiveWindowDaysForTargetInput,
) -> EffectiveWindowDaysForTargetOutput {
    let configured = compute_window_days_for_target(&WindowDaysForTargetInput {
        window_map: input.window_map.clone(),
        target: input.target.clone(),
        fallback: input.fallback,
    })
    .days;
    let minimum = compute_window_days_for_target(&WindowDaysForTargetInput {
        window_map: input.minimum_window_map.clone(),
        target: input.target.clone(),
        fallback: Some(1),
    })
    .days;
    EffectiveWindowDaysForTargetOutput {
        days: configured.max(minimum),
    }
}

pub fn compute_to_date(input: &ToDateInput) -> ToDateOutput {
    let raw = input.value.as_deref().unwrap_or("").trim().to_string();
    let valid = Regex::new(r"^\d{4}-\d{2}-\d{2}$")
        .ok()
        .map(|re| re.is_match(&raw))
        .unwrap_or(false);
    if valid {
        return ToDateOutput { value: raw };
    }
    ToDateOutput {
        value: now_iso_runtime().chars().take(10).collect::<String>(),
    }
}

pub fn compute_parse_ts_ms(input: &ParseTsMsInput) -> ParseTsMsOutput {
    ParseTsMsOutput {
        ts_ms: parse_ts_ms_runtime(input.value.as_deref().unwrap_or("")),
    }
}

pub fn compute_add_minutes(input: &AddMinutesInput) -> AddMinutesOutput {
    let base = parse_ts_ms_runtime(input.iso_ts.as_deref().unwrap_or(""));
    if base <= 0 {
        return AddMinutesOutput { iso_ts: None };
    }
    let minutes = input.minutes.unwrap_or(0.0).max(0.0);
    let out_ms = base + (minutes * 60.0 * 1000.0) as i64;
    let out = Utc
        .timestamp_millis_opt(out_ms)
        .single()
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true).to_string());
    AddMinutesOutput { iso_ts: out }
}

pub fn compute_clamp_int(input: &ClampIntInput) -> ClampIntOutput {
    let lo = input.lo.unwrap_or(i64::MIN);
    let hi = input.hi.unwrap_or(i64::MAX);
    let fallback = input.fallback.unwrap_or(0);
    ClampIntOutput {
        value: clamp_int_value(input.value.as_ref(), lo, hi, fallback),
    }
}

pub fn compute_clamp_number(input: &ClampNumberInput) -> ClampNumberOutput {
    let lo = input.lo.unwrap_or(f64::NEG_INFINITY);
    let hi = input.hi.unwrap_or(f64::INFINITY);
    let fallback = input.fallback.unwrap_or(0.0);
    let value = parse_number_like(input.value.as_ref()).unwrap_or(fallback);
    ClampNumberOutput {
        value: clamp_number(value, lo, hi),
    }
}

pub fn compute_to_bool(input: &ToBoolInput) -> ToBoolOutput {
    ToBoolOutput {
        value: to_bool_like(input.value.as_ref(), input.fallback.unwrap_or(false)),
    }
}

pub fn compute_clean_text(input: &CleanTextInput) -> CleanTextOutput {
    let max_len = input.max_len.unwrap_or(240).clamp(0, 10000) as usize;
    CleanTextOutput {
        value: clean_text_runtime(input.value.as_deref().unwrap_or(""), max_len),
    }
}

pub fn compute_normalize_token(input: &NormalizeTokenInput) -> NormalizeTokenOutput {
    let max_len = input.max_len.unwrap_or(80).clamp(1, 10000) as usize;
    NormalizeTokenOutput {
        value: normalize_token_runtime(input.value.as_deref().unwrap_or(""), max_len),
    }
}

pub fn compute_normalize_word_token(input: &NormalizeWordTokenInput) -> NormalizeWordTokenOutput {
    let max_len = input.max_len.unwrap_or(80).clamp(1, 10000) as usize;
    let src = clean_text_runtime(input.value.as_deref().unwrap_or(""), max_len).to_lowercase();
    let mut out = String::new();
    let mut prev_underscore = false;
    for ch in src.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            prev_underscore = false;
        } else if !prev_underscore {
            out.push('_');
            prev_underscore = true;
        }
    }
    NormalizeWordTokenOutput {
        value: out.trim_matches('_').to_string(),
    }
}

pub fn compute_band_to_index(input: &BandToIndexInput) -> BandToIndexOutput {
    let b = compute_normalize_token(&NormalizeTokenInput {
        value: input.band.clone(),
        max_len: Some(24),
    })
    .value;
    let index = if b == "novice" {
        0
    } else if b == "developing" {
        1
    } else if b == "mature" {
        2
    } else if b == "seasoned" {
        3
    } else {
        4
    };
    BandToIndexOutput { index }
}

pub fn compute_escape_regex(input: &EscapeRegexInput) -> EscapeRegexOutput {
    EscapeRegexOutput {
        value: regex::escape(input.value.as_deref().unwrap_or("")),
    }
}

pub fn compute_pattern_to_word_regex(input: &PatternToWordRegexInput) -> PatternToWordRegexOutput {
    let max_len = input.max_len.unwrap_or(200).clamp(1, 10000) as usize;
    let raw = clean_text_runtime(input.pattern.as_deref().unwrap_or(""), max_len);
    if raw.is_empty() {
        return PatternToWordRegexOutput { source: None };
    }
    let words = raw
        .split_whitespace()
        .map(regex::escape)
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>();
    if words.is_empty() {
        return PatternToWordRegexOutput { source: None };
    }
    PatternToWordRegexOutput {
        source: Some(format!("\\b{}\\b", words.join("\\s+"))),
    }
}

pub fn compute_stable_id(input: &StableIdInput) -> StableIdOutput {
    let seed = input.seed.as_deref().unwrap_or("");
    let prefix = clean_text_runtime(input.prefix.as_deref().unwrap_or("inv"), 80);
    let safe_prefix = if prefix.is_empty() {
        "inv".to_string()
    } else {
        prefix
    };
    StableIdOutput {
        id: stable_id_runtime(seed, &safe_prefix),
    }
}

pub fn compute_rel_path(input: &RelPathInput) -> RelPathOutput {
    RelPathOutput {
        value: rel_path_runtime(
            input.root.as_deref().unwrap_or(""),
            input.file_path.as_deref().unwrap_or(""),
        ),
    }
}

pub fn compute_normalize_axiom_pattern(
    input: &NormalizeAxiomPatternInput,
) -> NormalizeAxiomPatternOutput {
    NormalizeAxiomPatternOutput {
        value: clean_text_runtime(input.value.as_deref().unwrap_or(""), 200).to_lowercase(),
    }
}

pub fn compute_normalize_axiom_signal_terms(
    input: &NormalizeAxiomSignalTermsInput,
) -> NormalizeAxiomSignalTermsOutput {
    let mut out = input
        .terms
        .iter()
        .map(|row| {
            compute_normalize_axiom_pattern(&NormalizeAxiomPatternInput {
                value: Some(value_to_string(Some(row))),
            })
            .value
        })
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>();
    out.truncate(32);
    NormalizeAxiomSignalTermsOutput { terms: out }
}

pub fn compute_normalize_observer_id(
    input: &NormalizeObserverIdInput,
) -> NormalizeObserverIdOutput {
    NormalizeObserverIdOutput {
        value: normalize_token_runtime(input.value.as_deref().unwrap_or(""), 120),
    }
}

pub fn compute_extract_numeric(input: &ExtractNumericInput) -> ExtractNumericOutput {
    let value = js_number_for_extract(Some(&input.value))
        .filter(|n| n.is_finite());
    ExtractNumericOutput { value }
}

pub fn compute_pick_first_numeric(input: &PickFirstNumericInput) -> PickFirstNumericOutput {
    for candidate in &input.candidates {
        let out = compute_extract_numeric(&ExtractNumericInput {
            value: candidate.clone(),
        });
        if out.value.is_some() {
            return PickFirstNumericOutput { value: out.value };
        }
    }
    PickFirstNumericOutput { value: None }
}

pub fn compute_safe_rel_path(input: &SafeRelPathInput) -> SafeRelPathOutput {
    let rel = rel_path_runtime(
        input.root.as_deref().unwrap_or(""),
        input.file_path.as_deref().unwrap_or(""),
    );
    let value = if rel.is_empty() || rel.starts_with("..") {
        normalize_slashes(input.file_path.as_deref().unwrap_or(""))
    } else {
        rel
    };
    SafeRelPathOutput { value }
}

pub fn compute_now_iso(_input: &NowIsoInput) -> NowIsoOutput {
    NowIsoOutput {
        value: now_iso_runtime(),
    }
}

pub fn compute_default_tier_event_map(
    _input: &DefaultTierEventMapInput,
) -> DefaultTierEventMapOutput {
    DefaultTierEventMapOutput {
        map: default_tier_event_map_value(),
    }
}

pub fn compute_coerce_tier_event_map(input: &CoerceTierEventMapInput) -> CoerceTierEventMapOutput {
    let src = input.map.as_ref().and_then(|v| v.as_object()).cloned();
    let mut map = serde_json::Map::new();
    for target in TIER_TARGETS {
        let rows = src
            .as_ref()
            .and_then(|obj| obj.get(target))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|row| value_to_string(Some(row)))
            .collect::<Vec<_>>();
        map.insert(
            target.to_string(),
            Value::Array(rows.into_iter().map(Value::String).collect::<Vec<_>>()),
        );
    }
    CoerceTierEventMapOutput {
        map: Value::Object(map),
    }
}

pub fn compute_get_tier_scope(input: &GetTierScopeInput) -> GetTierScopeOutput {
    let safe_version = clean_text_runtime(input.policy_version.as_deref().unwrap_or("1.0"), 24);
    let policy_version = if safe_version.is_empty() {
        "1.0".to_string()
    } else {
        safe_version
    };
    let mut state = input
        .state
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let mut scopes = state
        .get("scopes")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    if !scopes
        .get(&policy_version)
        .map(|v| v.is_object())
        .unwrap_or(false)
    {
        scopes.insert(
            policy_version.clone(),
            compute_default_tier_scope(&DefaultTierScopeInput::default()).scope,
        );
    }
    let scope = scopes
        .get(&policy_version)
        .cloned()
        .unwrap_or_else(|| compute_default_tier_scope(&DefaultTierScopeInput::default()).scope);
    state.insert("scopes".to_string(), Value::Object(scopes));
    GetTierScopeOutput {
        state: Value::Object(state),
        scope,
    }
}

pub fn compute_load_tier_governance_state(
    input: &LoadTierGovernanceStateInput,
) -> LoadTierGovernanceStateOutput {
    let now_iso = input.now_iso.clone().unwrap_or_else(now_iso_runtime);
    let safe_version = clean_text_runtime(input.policy_version.as_deref().unwrap_or("1.0"), 24);
    let policy_version = if safe_version.is_empty() {
        "1.0".to_string()
    } else {
        safe_version
    };
    let src = compute_read_json(&ReadJsonInput {
        file_path: input.file_path.clone(),
        fallback: Some(Value::Null),
    })
    .value;
    let payload = src.as_object();
    let updated_at = {
        let value = value_to_string(payload.and_then(|m| m.get("updated_at")));
        if value.is_empty() {
            now_iso.clone()
        } else {
            value
        }
    };
    let legacy_scope = compute_default_tier_scope(&DefaultTierScopeInput {
        legacy: Some(json!({
            "live_apply_counts": payload.and_then(|m| m.get("live_apply_counts")).cloned().unwrap_or_else(|| json!({})),
            "shadow_pass_counts": payload.and_then(|m| m.get("shadow_pass_counts")).cloned().unwrap_or_else(|| json!({})),
            "live_apply_safe_aborts": payload.and_then(|m| m.get("live_apply_safe_aborts")).cloned().unwrap_or_else(|| json!({})),
            "shadow_critical_failures": payload.and_then(|m| m.get("shadow_critical_failures")).cloned().unwrap_or_else(|| json!({}))
        })),
        legacy_ts: Some(updated_at.clone()),
    })
    .scope;
    let scopes_src = payload
        .and_then(|m| m.get("scopes"))
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let mut scopes = serde_json::Map::new();
    for (version, scope) in scopes_src {
        scopes.insert(
            version.to_string(),
            compute_normalize_tier_scope(&NormalizeTierScopeInput {
                scope: Some(scope),
                legacy: None,
                legacy_ts: Some(updated_at.clone()),
            })
            .scope,
        );
    }
    if !scopes
        .get(&policy_version)
        .map(|v| v.is_object())
        .unwrap_or(false)
    {
        scopes.insert(
            policy_version.clone(),
            compute_normalize_tier_scope(&NormalizeTierScopeInput {
                scope: Some(legacy_scope),
                legacy: None,
                legacy_ts: Some(updated_at.clone()),
            })
            .scope,
        );
    }
    let mut out = serde_json::Map::new();
    out.insert(
        "schema_id".to_string(),
        Value::String("inversion_tier_governance_state".to_string()),
    );
    out.insert(
        "schema_version".to_string(),
        Value::String("1.0".to_string()),
    );
    out.insert(
        "active_policy_version".to_string(),
        Value::String(policy_version.clone()),
    );
    out.insert("updated_at".to_string(), Value::String(updated_at));
    out.insert("scopes".to_string(), Value::Object(scopes));

    let got = compute_get_tier_scope(&GetTierScopeInput {
        state: Some(Value::Object(out)),
        policy_version: Some(policy_version),
    });
    let mut state_out = got.state.as_object().cloned().unwrap_or_default();
    state_out.insert("active_scope".to_string(), got.scope);
    LoadTierGovernanceStateOutput {
        state: Value::Object(state_out),
    }
}

pub fn compute_save_tier_governance_state(
    input: &SaveTierGovernanceStateInput,
) -> SaveTierGovernanceStateOutput {
    let now_iso = input.now_iso.clone().unwrap_or_else(now_iso_runtime);
    let safe_version = clean_text_runtime(input.policy_version.as_deref().unwrap_or("1.0"), 24);
    let policy_version = if safe_version.is_empty() {
        "1.0".to_string()
    } else {
        safe_version
    };
    let retention_days = input.retention_days.unwrap_or(365).clamp(1, 3650);
    let src = input
        .state
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let scopes_src = src
        .get("scopes")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let mut scopes = serde_json::Map::new();
    for (version, scope) in scopes_src {
        scopes.insert(
            version.to_string(),
            compute_prune_tier_scope_events(&PruneTierScopeEventsInput {
                scope: Some(scope),
                retention_days: Some(retention_days),
            })
            .scope,
        );
    }
    if !scopes
        .get(&policy_version)
        .map(|v| v.is_object())
        .unwrap_or(false)
    {
        scopes.insert(
            policy_version.clone(),
            compute_default_tier_scope(&DefaultTierScopeInput::default()).scope,
        );
    }
    let out = json!({
        "schema_id": "inversion_tier_governance_state",
        "schema_version": "1.0",
        "active_policy_version": policy_version,
        "updated_at": now_iso,
        "scopes": scopes
    });
    let _ = compute_write_json_atomic(&WriteJsonAtomicInput {
        file_path: input.file_path.clone(),
        value: Some(out.clone()),
    });
    let active_policy = value_to_string(value_path(Some(&out), &["active_policy_version"]));
    let got = compute_get_tier_scope(&GetTierScopeInput {
        state: Some(out),
        policy_version: Some(active_policy),
    });
    let mut state_out = got.state.as_object().cloned().unwrap_or_default();
    state_out.insert("active_scope".to_string(), got.scope);
    SaveTierGovernanceStateOutput {
        state: Value::Object(state_out),
    }
}

pub fn compute_push_tier_event(input: &PushTierEventInput) -> PushTierEventOutput {
    let mut map = input
        .scope_map
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let target = compute_normalize_target(&NormalizeTargetInput {
        value: input.target.clone(),
    })
    .value;
    let mut rows = map
        .get(&target)
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    rows.push(Value::String(
        input.ts.clone().unwrap_or_else(now_iso_runtime),
    ));
    let normalized = compute_normalize_iso_events(&NormalizeIsoEventsInput {
        src: rows,
        max_rows: Some(10000),
    })
    .events;
    map.insert(
        target,
        Value::Array(normalized.into_iter().map(Value::String).collect::<Vec<_>>()),
    );
    PushTierEventOutput {
        map: Value::Object(map),
    }
}

pub fn compute_add_tier_event(input: &AddTierEventInput) -> AddTierEventOutput {
    let now_iso = input.now_iso.clone().unwrap_or_else(now_iso_runtime);
    let policy = input.policy.as_ref();
    let policy_version = {
        let value = clean_text_runtime(
            value_path(policy, &["version"])
                .and_then(|v| v.as_str())
                .unwrap_or("1.0"),
            24,
        );
        if value.is_empty() {
            "1.0".to_string()
        } else {
            value
        }
    };
    let mut state = compute_load_tier_governance_state(&LoadTierGovernanceStateInput {
        file_path: input.file_path.clone(),
        policy_version: Some(policy_version.clone()),
        now_iso: Some(now_iso.clone()),
    })
    .state;
    let got_scope = compute_get_tier_scope(&GetTierScopeInput {
        state: Some(state.clone()),
        policy_version: Some(policy_version.clone()),
    });
    state = got_scope.state;
    let mut scope = got_scope.scope;

    let metric = clean_text_runtime(input.metric.as_deref().unwrap_or(""), 80);
    if matches!(
        metric.as_str(),
        "live_apply_attempts"
            | "live_apply_successes"
            | "live_apply_safe_aborts"
            | "shadow_passes"
            | "shadow_critical_failures"
    ) {
        let map_src = value_path(Some(&scope), &[metric.as_str()])
            .cloned()
            .unwrap_or_else(default_tier_event_map_value);
        let pushed = compute_push_tier_event(&PushTierEventInput {
            scope_map: Some(map_src),
            target: input.target.clone(),
            ts: Some(input.ts.clone().unwrap_or_else(|| now_iso.clone())),
        })
        .map;
        if let Some(scope_obj) = scope.as_object_mut() {
            scope_obj.insert(metric, pushed);
        }
    }

    let mut state_obj = state.as_object().cloned().unwrap_or_default();
    let mut scopes = state_obj
        .get("scopes")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    scopes.insert(policy_version.clone(), scope);
    state_obj.insert("scopes".to_string(), Value::Object(scopes));

    let retention_days = compute_tier_retention_days(&TierRetentionDaysInput {
        policy: input.policy.clone(),
    })
    .days;
    let saved = compute_save_tier_governance_state(&SaveTierGovernanceStateInput {
        file_path: input.file_path.clone(),
        state: Some(Value::Object(state_obj)),
        policy_version: Some(policy_version),
        retention_days: Some(retention_days),
        now_iso: Some(now_iso),
    });
    AddTierEventOutput { state: saved.state }
}

pub fn compute_increment_live_apply_attempt(
    input: &IncrementLiveApplyAttemptInput,
) -> IncrementLiveApplyAttemptOutput {
    let out = compute_add_tier_event(&AddTierEventInput {
        file_path: input.file_path.clone(),
        policy: input.policy.clone(),
        metric: Some("live_apply_attempts".to_string()),
        target: input.target.clone(),
        ts: Some(input.now_iso.clone().unwrap_or_else(now_iso_runtime)),
        now_iso: input.now_iso.clone(),
    });
    IncrementLiveApplyAttemptOutput { state: out.state }
}

pub fn compute_increment_live_apply_success(
    input: &IncrementLiveApplySuccessInput,
) -> IncrementLiveApplySuccessOutput {
    let out = compute_add_tier_event(&AddTierEventInput {
        file_path: input.file_path.clone(),
        policy: input.policy.clone(),
        metric: Some("live_apply_successes".to_string()),
        target: input.target.clone(),
        ts: Some(input.now_iso.clone().unwrap_or_else(now_iso_runtime)),
        now_iso: input.now_iso.clone(),
    });
    IncrementLiveApplySuccessOutput { state: out.state }
}

pub fn compute_increment_live_apply_safe_abort(
    input: &IncrementLiveApplySafeAbortInput,
) -> IncrementLiveApplySafeAbortOutput {
    let out = compute_add_tier_event(&AddTierEventInput {
        file_path: input.file_path.clone(),
        policy: input.policy.clone(),
        metric: Some("live_apply_safe_aborts".to_string()),
        target: input.target.clone(),
        ts: Some(input.now_iso.clone().unwrap_or_else(now_iso_runtime)),
        now_iso: input.now_iso.clone(),
    });
    IncrementLiveApplySafeAbortOutput { state: out.state }
}

pub fn compute_update_shadow_trial_counters(
    input: &UpdateShadowTrialCountersInput,
) -> UpdateShadowTrialCountersOutput {
    let session = input
        .session
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let mode = compute_normalize_mode(&NormalizeModeInput {
        value: Some(value_to_string(session.get("mode"))),
    })
    .value;
    let apply_requested = to_bool_like(session.get("apply_requested"), false);
    let is_shadow_trial = mode == "test" || !apply_requested;
    if !is_shadow_trial {
        return UpdateShadowTrialCountersOutput { state: None };
    }
    let target = compute_normalize_target(&NormalizeTargetInput {
        value: Some(value_to_string(session.get("target"))),
    })
    .value;
    let result = compute_normalize_result(&NormalizeResultInput {
        value: input.result.clone(),
    })
    .value;
    let now_iso = input.now_iso.clone().unwrap_or_else(now_iso_runtime);
    let mut state = compute_load_tier_governance_state(&LoadTierGovernanceStateInput {
        file_path: input.file_path.clone(),
        policy_version: Some(clean_text_runtime(
            value_path(input.policy.as_ref(), &["version"])
                .and_then(|v| v.as_str())
                .unwrap_or("1.0"),
            24,
        )),
        now_iso: Some(now_iso.clone()),
    })
    .state;
    if result == "success" {
        state = compute_add_tier_event(&AddTierEventInput {
            file_path: input.file_path.clone(),
            policy: input.policy.clone(),
            metric: Some("shadow_passes".to_string()),
            target: Some(target.clone()),
            ts: Some(now_iso.clone()),
            now_iso: Some(now_iso.clone()),
        })
        .state;
    }
    if input.destructive == Some(true) || result == "destructive" {
        state = compute_add_tier_event(&AddTierEventInput {
            file_path: input.file_path.clone(),
            policy: input.policy.clone(),
            metric: Some("shadow_critical_failures".to_string()),
            target: Some(target),
            ts: Some(now_iso.clone()),
            now_iso: Some(now_iso),
        })
        .state;
    }
    UpdateShadowTrialCountersOutput { state: Some(state) }
}

pub fn compute_default_harness_state(
    _input: &DefaultHarnessStateInput,
) -> DefaultHarnessStateOutput {
    DefaultHarnessStateOutput {
        state: json!({
            "schema_id": "inversion_maturity_harness_state",
            "schema_version": "1.0",
            "updated_at": now_iso_runtime(),
            "last_run_ts": Value::Null,
            "cursor": 0
        }),
    }
}

pub fn compute_default_first_principle_lock_state(
    _input: &DefaultFirstPrincipleLockStateInput,
) -> DefaultFirstPrincipleLockStateOutput {
    DefaultFirstPrincipleLockStateOutput {
        state: json!({
            "schema_id": "inversion_first_principle_lock_state",
            "schema_version": "1.0",
            "updated_at": now_iso_runtime(),
            "locks": {}
        }),
    }
}

pub fn compute_default_maturity_state(
    _input: &DefaultMaturityStateInput,
) -> DefaultMaturityStateOutput {
    DefaultMaturityStateOutput {
        state: json!({
            "schema_id": "inversion_maturity_state",
            "schema_version": "1.0",
            "updated_at": now_iso_runtime(),
            "stats": {
                "total_tests": 0,
                "passed_tests": 0,
                "failed_tests": 0,
                "safe_failures": 0,
                "destructive_failures": 0
            },
            "recent_tests": [],
            "score": 0,
            "band": "novice"
        }),
    }
}

pub fn compute_principle_key_for_session(
    input: &PrincipleKeyForSessionInput,
) -> PrincipleKeyForSessionOutput {
    let objective_part = clean_text_runtime(
        input
            .objective_id
            .as_deref()
            .or(input.objective.as_deref())
            .unwrap_or(""),
        240,
    )
    .to_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(objective_part.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let key = format!(
        "{}::{}",
        compute_normalize_target(&NormalizeTargetInput {
            value: Some(input.target.clone().unwrap_or_else(|| "tactical".to_string())),
        })
        .value,
        &digest[..16]
    );
    PrincipleKeyForSessionOutput { key }
}

pub fn compute_check_first_principle_downgrade(
    input: &CheckFirstPrincipleDowngradeInput,
) -> CheckFirstPrincipleDowngradeOutput {
    let session = input
        .session
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let key = compute_principle_key_for_session(&PrincipleKeyForSessionInput {
        objective_id: session
            .get("objective_id")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        objective: session
            .get("objective")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        target: session
            .get("target")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
    })
    .key;
    let anti = value_path(input.policy.as_ref(), &["first_principles", "anti_downgrade"])
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    if !to_bool_like(anti.get("enabled"), false) {
        return CheckFirstPrincipleDowngradeOutput {
            allowed: true,
            reason: None,
            key,
            lock_state: None,
        };
    }

    let lock_state = compute_load_first_principle_lock_state(&LoadFirstPrincipleLockStateInput {
        file_path: input.file_path.clone(),
        now_iso: input.now_iso.clone(),
    })
    .state;
    let existing = value_path(Some(&lock_state), &["locks", key.as_str()]).and_then(|v| v.as_object());
    if existing.is_none() {
        return CheckFirstPrincipleDowngradeOutput {
            allowed: true,
            reason: None,
            key,
            lock_state: Some(lock_state),
        };
    }
    let existing_obj = existing.cloned().unwrap_or_default();

    let existing_band = compute_normalize_token(&NormalizeTokenInput {
        value: Some(value_to_string(existing_obj.get("maturity_band"))),
        max_len: Some(24),
    })
    .value;
    let session_band = compute_normalize_token(&NormalizeTokenInput {
        value: Some(value_to_string(session.get("maturity_band"))),
        max_len: Some(24),
    })
    .value;
    let existing_idx = compute_band_to_index(&BandToIndexInput {
        band: Some(if existing_band.is_empty() {
            "novice".to_string()
        } else {
            existing_band
        }),
    })
    .index;
    let session_idx = compute_band_to_index(&BandToIndexInput {
        band: Some(if session_band.is_empty() {
            "novice".to_string()
        } else {
            session_band
        }),
    })
    .index;

    if to_bool_like(anti.get("require_same_or_higher_maturity"), false) && session_idx < existing_idx
    {
        return CheckFirstPrincipleDowngradeOutput {
            allowed: false,
            reason: Some("first_principle_downgrade_blocked_lower_maturity".to_string()),
            key,
            lock_state: Some(lock_state),
        };
    }

    if to_bool_like(anti.get("prevent_lower_confidence_same_band"), false)
        && session_idx == existing_idx
    {
        let floor_ratio = compute_clamp_number(&ClampNumberInput {
            value: anti.get("same_band_confidence_floor_ratio").cloned(),
            lo: Some(0.1),
            hi: Some(1.0),
            fallback: Some(0.92),
        })
        .value;
        let existing_confidence = js_number_for_extract(existing_obj.get("confidence")).unwrap_or(0.0);
        let floor = existing_confidence * floor_ratio;
        let confidence = if input.confidence.unwrap_or(0.0).is_finite() {
            input.confidence.unwrap_or(0.0)
        } else {
            0.0
        };
        if confidence < floor {
            return CheckFirstPrincipleDowngradeOutput {
                allowed: false,
                reason: Some("first_principle_downgrade_blocked_lower_confidence".to_string()),
                key,
                lock_state: Some(lock_state),
            };
        }
    }

    CheckFirstPrincipleDowngradeOutput {
        allowed: true,
        reason: None,
        key,
        lock_state: Some(lock_state),
    }
}

pub fn compute_upsert_first_principle_lock(
    input: &UpsertFirstPrincipleLockInput,
) -> UpsertFirstPrincipleLockOutput {
    let now_iso = input.now_iso.clone().unwrap_or_else(now_iso_runtime);
    let session = input
        .session
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let principle = input
        .principle
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let key = compute_principle_key_for_session(&PrincipleKeyForSessionInput {
        objective_id: session
            .get("objective_id")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        objective: session
            .get("objective")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        target: session
            .get("target")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
    })
    .key;

    let mut lock_state = compute_load_first_principle_lock_state(&LoadFirstPrincipleLockStateInput {
        file_path: input.file_path.clone(),
        now_iso: Some(now_iso.clone()),
    })
    .state;

    let existing = value_path(Some(&lock_state), &["locks", key.as_str()])
        .and_then(|v| v.as_object())
        .cloned();
    let next_band = compute_normalize_token(&NormalizeTokenInput {
        value: Some(value_to_string(session.get("maturity_band"))),
        max_len: Some(24),
    })
    .value;
    let next_band = if next_band.is_empty() {
        "novice".to_string()
    } else {
        next_band
    };
    let next_idx = compute_band_to_index(&BandToIndexInput {
        band: Some(next_band.clone()),
    })
    .index;

    let confidence_raw = js_number_for_extract(principle.get("confidence")).unwrap_or(0.0);
    let confidence = if confidence_raw.is_finite() {
        confidence_raw
    } else {
        0.0
    };
    let prev_idx = existing
        .as_ref()
        .map(|row| {
            compute_band_to_index(&BandToIndexInput {
                band: Some(value_to_string(row.get("maturity_band"))),
            })
            .index
        })
        .unwrap_or(-1);
    let merged_band = if prev_idx > next_idx {
        compute_normalize_token(&NormalizeTokenInput {
            value: Some(
                existing
                    .as_ref()
                    .and_then(|row| row.get("maturity_band"))
                    .map(|v| value_to_string(Some(v)))
                    .unwrap_or_else(|| next_band.clone()),
            ),
            max_len: Some(24),
        })
        .value
    } else {
        next_band.clone()
    };
    let existing_confidence = existing
        .as_ref()
        .and_then(|row| js_number_for_extract(row.get("confidence")))
        .unwrap_or(0.0);
    let merged_confidence = existing_confidence.max(confidence);
    let clamped_confidence = compute_clamp_number(&ClampNumberInput {
        value: Some(json!(merged_confidence)),
        lo: Some(0.0),
        hi: Some(1.0),
        fallback: Some(0.0),
    })
    .value;
    let rounded_confidence = (clamped_confidence * 1_000_000.0).round() / 1_000_000.0;

    let lock_row = json!({
        "key": key.clone(),
        "principle_id": clean_text_runtime(
            principle.get("id").and_then(|v| v.as_str()).unwrap_or(""),
            120
        ),
        "maturity_band": if merged_band.is_empty() { "novice".to_string() } else { merged_band },
        "confidence": rounded_confidence,
        "ts": now_iso.clone()
    });
    if lock_state.get("locks").and_then(|v| v.as_object()).is_none() {
        if let Some(obj) = lock_state.as_object_mut() {
            obj.insert("locks".to_string(), json!({}));
        }
    }
    if let Some(locks) = lock_state.get_mut("locks").and_then(|v| v.as_object_mut()) {
        locks.insert(key.clone(), lock_row);
    }
    let saved = compute_save_first_principle_lock_state(&SaveFirstPrincipleLockStateInput {
        file_path: input.file_path.clone(),
        state: Some(lock_state),
        now_iso: Some(now_iso),
    });
    UpsertFirstPrincipleLockOutput {
        state: saved.state,
        key,
    }
}

pub fn compute_normalize_objective_arg(
    input: &NormalizeObjectiveArgInput,
) -> NormalizeObjectiveArgOutput {
    NormalizeObjectiveArgOutput {
        value: clean_text_runtime(input.value.as_deref().unwrap_or(""), 420),
    }
}

pub fn compute_maturity_band_order(_input: &MaturityBandOrderInput) -> MaturityBandOrderOutput {
    MaturityBandOrderOutput {
        bands: vec![
            "novice".to_string(),
            "developing".to_string(),
            "mature".to_string(),
            "seasoned".to_string(),
            "legendary".to_string(),
        ],
    }
}

pub fn compute_current_runtime_mode(input: &CurrentRuntimeModeInput) -> CurrentRuntimeModeOutput {
    let env_mode = compute_normalize_mode(&NormalizeModeInput {
        value: input.env_mode.clone(),
    })
    .value;
    if input
        .env_mode
        .as_deref()
        .map(|row| !row.is_empty())
        .unwrap_or(false)
    {
        return CurrentRuntimeModeOutput { mode: env_mode };
    }
    let args_mode = compute_normalize_mode(&NormalizeModeInput {
        value: input.args_mode.clone(),
    })
    .value;
    if input.args_mode.is_some() {
        return CurrentRuntimeModeOutput { mode: args_mode };
    }
    let mode = compute_normalize_mode(&NormalizeModeInput {
        value: input.policy_runtime_mode.clone(),
    })
    .value;
    CurrentRuntimeModeOutput { mode }
}

pub fn compute_read_drift_from_state_file(
    input: &ReadDriftFromStateFileInput,
) -> ReadDriftFromStateFileOutput {
    let payload = input.payload.as_ref().and_then(|v| v.as_object());
    let source = clean_text_runtime(
        input
            .source_path
            .as_deref()
            .filter(|row| !row.is_empty())
            .or(input.file_path.as_deref())
            .unwrap_or("none"),
        260,
    );
    if payload.is_none() {
        return ReadDriftFromStateFileOutput { value: 0.0, source };
    }
    let payload_value = input.payload.as_ref();
    let value = [
        value_path(payload_value, &["drift_rate"]),
        value_path(payload_value, &["predicted_drift"]),
        value_path(payload_value, &["effective_drift_rate"]),
        value_path(payload_value, &["checks_effective", "drift_rate", "value"]),
        value_path(payload_value, &["checks", "drift_rate", "value"]),
        value_path(payload_value, &["last_decision", "drift_rate"]),
        value_path(payload_value, &["last_decision", "effective_drift_rate"]),
        value_path(
            payload_value,
            &["last_decision", "checks_effective", "drift_rate", "value"],
        ),
    ]
    .iter()
    .find_map(|row| parse_number_like(*row))
    .unwrap_or(0.0);
    ReadDriftFromStateFileOutput {
        value: round6(clamp_number(value, 0.0, 1.0)),
        source,
    }
}

pub fn compute_resolve_lens_gate_drift(
    input: &ResolveLensGateDriftInput,
) -> ResolveLensGateDriftOutput {
    let arg_value = input
        .arg_candidates
        .iter()
        .find_map(|row| compute_extract_numeric(&ExtractNumericInput { value: row.clone() }).value);
    if let Some(value) = arg_value {
        return ResolveLensGateDriftOutput {
            value: round6(clamp_number(value, 0.0, 1.0)),
            source: "arg".to_string(),
        };
    }
    let probe_path = input.probe_path.clone().unwrap_or_default();
    if probe_path.is_empty() {
        return ResolveLensGateDriftOutput {
            value: 0.0,
            source: "none".to_string(),
        };
    }
    let out = compute_read_drift_from_state_file(&ReadDriftFromStateFileInput {
        file_path: Some(probe_path),
        source_path: input.probe_source.clone(),
        payload: input.probe_payload.clone(),
    });
    ResolveLensGateDriftOutput {
        value: out.value,
        source: out.source,
    }
}

pub fn compute_resolve_parity_confidence(
    input: &ResolveParityConfidenceInput,
) -> ResolveParityConfidenceOutput {
    let arg_value = input
        .arg_candidates
        .iter()
        .find_map(|row| compute_extract_numeric(&ExtractNumericInput { value: row.clone() }).value);
    if let Some(value) = arg_value {
        return ResolveParityConfidenceOutput {
            value: round6(clamp_number(value, 0.0, 1.0)),
            source: "arg".to_string(),
        };
    }
    let path_hint = input.path_hint.clone().unwrap_or_default();
    if path_hint.is_empty() {
        return ResolveParityConfidenceOutput {
            value: 0.0,
            source: "none".to_string(),
        };
    }
    let payload = input.payload.as_ref().and_then(|v| v.as_object());
    if payload.is_none() {
        return ResolveParityConfidenceOutput {
            value: 0.0,
            source: clean_text_runtime(
                input
                    .path_source
                    .as_deref()
                    .filter(|row| !row.is_empty())
                    .unwrap_or(&path_hint),
                260,
            ),
        };
    }
    let payload_value = input.payload.as_ref();
    let value = [
        value_path(payload_value, &["confidence"]),
        value_path(payload_value, &["parity_confidence"]),
        value_path(payload_value, &["pass_rate"]),
        value_path(payload_value, &["score"]),
    ]
    .iter()
    .find_map(|row| parse_number_like(*row))
    .unwrap_or(0.0);
    ResolveParityConfidenceOutput {
        value: round6(clamp_number(value, 0.0, 1.0)),
        source: clean_text_runtime(
            input
                .path_source
                .as_deref()
                .filter(|row| !row.is_empty())
                .unwrap_or(&path_hint),
            260,
        ),
    }
}

pub fn compute_attractor_score(input: &ComputeAttractorScoreInput) -> ComputeAttractorScoreOutput {
    let attractor_enabled = map_bool_key(input.attractor.as_ref(), "enabled", false);
    if !attractor_enabled {
        return ComputeAttractorScoreOutput {
            enabled: false,
            score: 1.0,
            required: 0.0,
            pass: true,
            components: json!({}),
        };
    }

    let objective_text = clean_text_runtime(input.objective.as_deref().unwrap_or(""), 600);
    let signature_text = clean_text_runtime(input.signature.as_deref().unwrap_or(""), 600);
    let joined = format!("{} {}", objective_text, signature_text).to_lowercase();
    let token_rows = clean_text_runtime(&joined, 1600)
        .split_whitespace()
        .map(|row| row.trim().to_lowercase())
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>();
    let token_set = compute_tokenize_text(&TokenizeTextInput {
        value: Some(joined.clone()),
        max_tokens: None,
    })
    .tokens;

    let constraint_markers = [
        Regex::new(r"(?i)\bmust\b").expect("valid constraint regex"),
        Regex::new(r"(?i)\bwithin\b").expect("valid constraint regex"),
        Regex::new(r"(?i)\bby\s+\d").expect("valid constraint regex"),
        Regex::new(r"(?i)\bunder\b").expect("valid constraint regex"),
        Regex::new(r"(?i)\blimit\b").expect("valid constraint regex"),
        Regex::new(r"(?i)\bno more than\b").expect("valid constraint regex"),
        Regex::new(r"(?i)\bat most\b").expect("valid constraint regex"),
        Regex::new(r"(?i)\bcap\b").expect("valid constraint regex"),
        Regex::new(r"(?i)\brequire(?:s|d)?\b").expect("valid constraint regex"),
    ];
    let measurable_markers = [
        Regex::new(r"[%$]").expect("valid measurable regex"),
        Regex::new(r"(?i)\bms\b").expect("valid measurable regex"),
        Regex::new(r"(?i)\bseconds?\b").expect("valid measurable regex"),
        Regex::new(r"(?i)\bminutes?\b").expect("valid measurable regex"),
        Regex::new(r"(?i)\bhours?\b").expect("valid measurable regex"),
        Regex::new(r"(?i)\bdays?\b").expect("valid measurable regex"),
        Regex::new(r"(?i)\bdollars?\b").expect("valid measurable regex"),
        Regex::new(r"(?i)\brevenue\b").expect("valid measurable regex"),
        Regex::new(r"(?i)\byield\b").expect("valid measurable regex"),
        Regex::new(r"(?i)\bdrift\b").expect("valid measurable regex"),
        Regex::new(r"(?i)\blatency\b").expect("valid measurable regex"),
        Regex::new(r"(?i)\bthroughput\b").expect("valid measurable regex"),
        Regex::new(r"(?i)\berror(?:_rate| rate)?\b").expect("valid measurable regex"),
        Regex::new(r"(?i)\baccuracy\b").expect("valid measurable regex"),
    ];
    let comparison_markers = [
        Regex::new(r">=?\s*\d").expect("valid comparison regex"),
        Regex::new(r"<=?\s*\d").expect("valid comparison regex"),
        Regex::new(r"(?i)\b(?:reduce|increase|improve|decrease|raise|lower)\b")
            .expect("valid comparison regex"),
    ];
    let external_markers = [
        Regex::new(r"(?i)https?://").expect("valid external regex"),
        Regex::new(r"(?i)\bgithub\b").expect("valid external regex"),
        Regex::new(r"(?i)\bupwork\b").expect("valid external regex"),
        Regex::new(r"(?i)\breddit\b").expect("valid external regex"),
        Regex::new(r"(?i)\bmarket\b").expect("valid external regex"),
        Regex::new(r"(?i)\bcustomer\b").expect("valid external regex"),
        Regex::new(r"(?i)\busers?\b").expect("valid external regex"),
        Regex::new(r"(?i)\bapi\b").expect("valid external regex"),
        Regex::new(r"(?i)\bweb\b").expect("valid external regex"),
        Regex::new(r"(?i)\bexternal\b").expect("valid external regex"),
    ];

    let number_markers = token_set.iter().filter(|tok| tok.chars().any(|ch| ch.is_ascii_digit())).count()
        as f64;
    let constraint_hits = constraint_markers
        .iter()
        .filter(|re| re.is_match(&joined))
        .count() as f64;
    let measurable_hits = measurable_markers
        .iter()
        .filter(|re| re.is_match(&joined))
        .count() as f64;
    let comparison_hits = comparison_markers
        .iter()
        .filter(|re| re.is_match(&joined))
        .count() as f64;
    let external_hits = external_markers
        .iter()
        .filter(|re| re.is_match(&joined))
        .count() as f64;

    let external_signals_count =
        clamp_int_value(input.external_signals_count.as_ref(), 0, 100000, 0) as f64;
    let evidence_count = clamp_int_value(input.evidence_count.as_ref(), 0, 100000, 0) as f64;
    let word_count = (token_rows.len() as i64).clamp(0, 4000);
    let lexical_diversity = if word_count > 0 {
        clamp_number(token_set.len() as f64 / (word_count.max(1) as f64), 0.0, 1.0)
    } else {
        0.0
    };

    let verbosity_cfg = input
        .attractor
        .as_ref()
        .and_then(|v| v.as_object())
        .and_then(|m| m.get("verbosity"));
    let soft_word_cap = clamp_int_value(
        verbosity_cfg
            .and_then(|v| v.as_object())
            .and_then(|m| m.get("soft_word_cap")),
        8,
        1000,
        70,
    );
    let hard_word_cap = clamp_int_value(
        verbosity_cfg
            .and_then(|v| v.as_object())
            .and_then(|m| m.get("hard_word_cap")),
        soft_word_cap + 1,
        2000,
        180,
    );
    let low_diversity_floor = clamp_number(
        parse_number_like(
            verbosity_cfg
                .and_then(|v| v.as_object())
                .and_then(|m| m.get("low_diversity_floor")),
        )
        .unwrap_or(0.28),
        0.05,
        0.95,
    );

    let constraint_evidence =
        clamp_number((constraint_hits * 0.55 + number_markers.min(3.0) * 0.45) / 4.0, 0.0, 1.0);
    let measurable_evidence =
        clamp_number((measurable_hits * 0.6 + comparison_hits * 0.4) / 4.0, 0.0, 1.0);
    let external_grounding = clamp_number(
        (external_hits * 0.6 + external_signals_count.min(4.0) * 0.4) / 3.0,
        0.0,
        1.0,
    );
    let evidence_backing = clamp_number(
        (constraint_hits * 0.2)
            + (measurable_hits * 0.2)
            + (external_hits * 0.15)
            + (comparison_hits * 0.1)
            + (evidence_count.min(5.0) * 0.35),
        0.0,
        1.0,
    );
    let specificity = round6(clamp_number(
        (constraint_evidence * 0.4) + (measurable_evidence * 0.35) + (external_grounding * 0.25),
        0.0,
        1.0,
    ));

    let verbosity_over = if word_count > soft_word_cap {
        clamp_number(
            (word_count - soft_word_cap) as f64 / ((hard_word_cap - soft_word_cap).max(1) as f64),
            0.0,
            1.0,
        )
    } else {
        0.0
    };
    let low_diversity_penalty = if lexical_diversity < low_diversity_floor {
        clamp_number(
            (low_diversity_floor - lexical_diversity) / low_diversity_floor.max(0.01),
            0.0,
            1.0,
        )
    } else {
        0.0
    };
    let weak_evidence_penalty = 1.0
        - clamp_number(
            (constraint_evidence * 0.4)
                + (measurable_evidence * 0.3)
                + (external_grounding * 0.2)
                + (evidence_backing * 0.1),
            0.0,
            1.0,
        );
    let verbosity_penalty = round6(clamp_number(
        (verbosity_over * weak_evidence_penalty * 0.75) + (low_diversity_penalty * 0.25),
        0.0,
        1.0,
    ));

    let objective_specificity_weight =
        js_or_number(value_path(input.attractor.as_ref(), &["weights", "objective_specificity"]), 0.0);
    let evidence_backing_weight =
        js_or_number(value_path(input.attractor.as_ref(), &["weights", "evidence_backing"]), 0.0);
    let constraint_weight = if value_path(input.attractor.as_ref(), &["weights", "constraint_evidence"])
        .is_some()
    {
        parse_number_like(value_path(input.attractor.as_ref(), &["weights", "constraint_evidence"]))
            .unwrap_or(0.0)
    } else {
        objective_specificity_weight * 0.4
    };
    let measurable_weight = if value_path(input.attractor.as_ref(), &["weights", "measurable_outcome"])
        .is_some()
    {
        parse_number_like(value_path(input.attractor.as_ref(), &["weights", "measurable_outcome"]))
            .unwrap_or(0.0)
    } else {
        objective_specificity_weight * 0.35
    };
    let external_weight = if value_path(input.attractor.as_ref(), &["weights", "external_grounding"])
        .is_some()
    {
        parse_number_like(value_path(input.attractor.as_ref(), &["weights", "external_grounding"]))
            .unwrap_or(0.0)
    } else {
        objective_specificity_weight * 0.25
    };
    let certainty_weight = js_or_number(value_path(input.attractor.as_ref(), &["weights", "certainty"]), 0.0);
    let trit_alignment_weight =
        js_or_number(value_path(input.attractor.as_ref(), &["weights", "trit_alignment"]), 0.0);
    let impact_alignment_weight =
        js_or_number(value_path(input.attractor.as_ref(), &["weights", "impact_alignment"]), 0.0);
    let positive_weight_total = (objective_specificity_weight
        + evidence_backing_weight
        + constraint_weight
        + measurable_weight
        + external_weight
        + certainty_weight
        + trit_alignment_weight
        + impact_alignment_weight)
        .max(0.0001);
    let verbosity_penalty_weight =
        js_or_number(value_path(input.attractor.as_ref(), &["weights", "verbosity_penalty"]), 0.0);

    let certainty = clamp_number(parse_number_like(input.effective_certainty.as_ref()).unwrap_or(0.0), 0.0, 1.0);
    let trit = clamp_int_value(input.trit.as_ref(), -1, 1, 0);
    let trit_alignment = if trit == 1 {
        1.0
    } else if trit == 0 {
        0.6
    } else {
        0.15
    };
    let impact = compute_normalize_impact(&NormalizeImpactInput {
        value: input.impact.clone(),
    })
    .value;
    let impact_factor = if impact == "critical" {
        1.0
    } else if impact == "high" {
        0.85
    } else if impact == "medium" {
        0.7
    } else {
        0.55
    };

    let positive_score = ((specificity * objective_specificity_weight)
        + (evidence_backing * evidence_backing_weight)
        + (constraint_evidence * constraint_weight)
        + (measurable_evidence * measurable_weight)
        + (external_grounding * external_weight)
        + (certainty * certainty_weight)
        + (trit_alignment * trit_alignment_weight)
        + (impact_factor * impact_alignment_weight))
        / positive_weight_total;
    let score = clamp_number(
        positive_score - (verbosity_penalty * verbosity_penalty_weight),
        0.0,
        1.0,
    );

    let target = normalize_target_for_key(input.target.as_deref().unwrap_or("tactical"));
    let required = clamp_number(
        parse_number_like(
            input.attractor
                .as_ref()
                .and_then(|v| v.as_object())
                .and_then(|m| m.get("min_alignment_by_target"))
                .and_then(|v| v.as_object())
                .and_then(|m| m.get(&target)),
        )
        .unwrap_or(0.0),
        0.0,
        1.0,
    );
    let score_rounded = round6(clamp_number(score, 0.0, 1.0));
    let required_rounded = round6(required);
    ComputeAttractorScoreOutput {
        enabled: true,
        score: score_rounded,
        required: required_rounded,
        pass: score_rounded >= required_rounded,
        components: json!({
            "objective_specificity": round6(specificity),
            "evidence_backing": round6(evidence_backing),
            "constraint_evidence": round6(constraint_evidence),
            "measurable_outcome": round6(measurable_evidence),
            "external_grounding": round6(external_grounding),
            "certainty": round6(certainty),
            "trit_alignment": round6(trit_alignment),
            "impact_alignment": round6(impact_factor),
            "verbosity_penalty": round6(verbosity_penalty),
            "lexical_diversity": round6(lexical_diversity),
            "word_count": word_count
        }),
    }
}

pub fn compute_build_output_interfaces(
    input: &BuildOutputInterfacesInput,
) -> BuildOutputInterfacesOutput {
    let outputs = input.outputs.as_ref().and_then(|v| v.as_object());
    let mode = compute_normalize_mode(&NormalizeModeInput {
        value: input.mode.clone(),
    })
    .value;
    let sandbox_verified = to_bool_like(input.sandbox_verified.as_ref(), false);
    let explicit_code_proposal_emit = to_bool_like(input.explicit_code_proposal_emit.as_ref(), false);
    let channel_payloads = input.channel_payloads.as_ref().and_then(|v| v.as_object());
    let base_payload = input.base_payload.clone().unwrap_or_else(|| json!({}));
    let channel_names = [
        "belief_update",
        "strategy_hint",
        "workflow_hint",
        "code_change_proposal",
    ];

    let mut channels = serde_json::Map::new();
    for name in channel_names {
        let cfg = outputs.and_then(|m| m.get(name));
        let cfg_enabled = map_bool_key(cfg, "enabled", false);
        let test_enabled = map_bool_key(cfg, "test_enabled", false);
        let live_enabled = map_bool_key(cfg, "live_enabled", false);
        let require_sandbox = map_bool_key(cfg, "require_sandbox_verification", false);
        let require_explicit_emit = map_bool_key(cfg, "require_explicit_emit", false);

        let gate_mode = if mode == "test" {
            test_enabled
        } else {
            live_enabled
        };
        let gate_sandbox = if require_sandbox {
            sandbox_verified
        } else {
            true
        };
        let gate_explicit = if require_explicit_emit {
            if name == "code_change_proposal" {
                explicit_code_proposal_emit
            } else {
                true
            }
        } else {
            true
        };
        let enabled = cfg_enabled && gate_mode && gate_sandbox && gate_explicit;

        let mut reasons = Vec::<Value>::new();
        if !cfg_enabled {
            reasons.push(json!("channel_disabled"));
        }
        if !gate_mode {
            reasons.push(json!(if mode == "test" {
                "test_mode_disabled"
            } else {
                "live_mode_disabled"
            }));
        }
        if !gate_sandbox {
            reasons.push(json!("sandbox_verification_required"));
        }
        if !gate_explicit {
            reasons.push(json!("explicit_emit_required"));
        }

        let payload = if enabled {
            let candidate = channel_payloads.and_then(|m| m.get(name));
            if js_truthy(candidate) {
                candidate.cloned().unwrap_or_else(|| base_payload.clone())
            } else {
                base_payload.clone()
            }
        } else {
            Value::Null
        };

        channels.insert(
            name.to_string(),
            json!({
                "enabled": enabled,
                "gated_reasons": reasons,
                "payload": payload
            }),
        );
    }

    let default_channel = normalize_token_runtime(
        outputs
            .and_then(|m| m.get("default_channel"))
            .and_then(|v| v.as_str())
            .unwrap_or("strategy_hint"),
        64,
    );
    let default_channel = if default_channel.is_empty() {
        "strategy_hint".to_string()
    } else {
        default_channel
    };
    let active_channel = if channels
        .get(&default_channel)
        .and_then(|v| v.as_object())
        .and_then(|m| m.get("enabled"))
        .and_then(|v| v.as_bool())
        == Some(true)
    {
        Some(default_channel.clone())
    } else {
        channel_names
            .iter()
            .find(|name| {
                channels
                    .get(**name)
                    .and_then(|v| v.as_object())
                    .and_then(|m| m.get("enabled"))
                    .and_then(|v| v.as_bool())
                    == Some(true)
            })
            .map(|name| (*name).to_string())
    };

    BuildOutputInterfacesOutput {
        default_channel,
        active_channel,
        channels: Value::Object(channels),
    }
}

pub fn compute_build_code_change_proposal_draft(
    input: &BuildCodeChangeProposalDraftInput,
) -> BuildCodeChangeProposalDraftOutput {
    let base = input.base.as_ref().and_then(|v| v.as_object());
    let args = input.args.as_ref().and_then(|v| v.as_object());
    let opts = input.opts.as_ref().and_then(|v| v.as_object());

    let read_text = |root: Option<&serde_json::Map<String, Value>>, keys: &[&str], max_len: usize| {
        keys.iter()
            .find_map(|key| root.and_then(|m| m.get(*key)).map(|v| value_to_string(Some(v))))
            .map(|value| clean_text_runtime(&value, max_len))
            .unwrap_or_default()
    };
    let read_value = |root: Option<&serde_json::Map<String, Value>>, keys: &[&str]| {
        keys.iter()
            .find_map(|key| root.and_then(|m| m.get(*key)))
            .cloned()
    };

    let objective = clean_text_runtime(
        &value_to_string(base.and_then(|m| m.get("objective"))),
        260,
    );
    let objective_id = clean_text_runtime(
        &value_to_string(base.and_then(|m| m.get("objective_id"))),
        140,
    );
    let objective_id_value = if objective_id.is_empty() {
        Value::Null
    } else {
        Value::String(objective_id.clone())
    };

    let title = {
        let explicit = read_text(args, &["code_change_title", "code-change-title"], 180);
        if !explicit.is_empty() {
            explicit
        } else {
            clean_text_runtime(
                &format!(
                    "Inversion-driven code-change proposal: {}",
                    if objective.is_empty() {
                        "unknown objective"
                    } else {
                        &objective
                    }
                ),
                180,
            )
        }
    };
    let summary = {
        let explicit = read_text(args, &["code_change_summary", "code-change-summary"], 420);
        if !explicit.is_empty() {
            explicit
        } else {
            clean_text_runtime(
                &format!(
                    "Use guarded inversion outputs to propose a reversible code change for objective \"{}\".",
                    if objective.is_empty() {
                        "unknown"
                    } else {
                        &objective
                    }
                ),
                420,
            )
        }
    };
    let proposed_files = compute_normalize_text_list(&NormalizeTextListInput {
        value: read_value(args, &["code_change_files", "code-change-files"]),
        max_len: Some(220),
        max_items: Some(32),
    })
    .items;
    let proposed_tests = compute_normalize_text_list(&NormalizeTextListInput {
        value: read_value(args, &["code_change_tests", "code-change-tests"]),
        max_len: Some(220),
        max_items: Some(32),
    })
    .items;

    let ts = {
        let value = clean_text_runtime(&value_to_string(base.and_then(|m| m.get("ts"))), 64);
        if value.is_empty() {
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        } else {
            value
        }
    };
    let risk_note = {
        let value = read_text(args, &["code_change_risk", "code-change-risk"], 320);
        if value.is_empty() {
            Value::Null
        } else {
            Value::String(value)
        }
    };
    let proposal_id_seed = format!(
        "{}|{}|{}",
        if objective_id.is_empty() {
            objective.as_str()
        } else {
            objective_id.as_str()
        },
        title,
        ts
    );
    let proposal_id = stable_id_runtime(&proposal_id_seed, "icp");
    let mode = {
        let value = clean_text_runtime(&value_to_string(base.and_then(|m| m.get("mode"))), 24);
        if value.is_empty() {
            "test".to_string()
        } else {
            value
        }
    };
    let shadow_mode = to_bool_like(base.and_then(|m| m.get("shadow_mode")), true);
    let impact = compute_normalize_impact(&NormalizeImpactInput {
        value: Some(value_to_string(base.and_then(|m| m.get("impact")))),
    })
    .value;
    let target = compute_normalize_target(&NormalizeTargetInput {
        value: Some(value_to_string(base.and_then(|m| m.get("target")))),
    })
    .value;
    let certainty = round6(clamp_number(
        parse_number_like(base.and_then(|m| m.get("certainty"))).unwrap_or(0.0),
        0.0,
        1.0,
    ));
    let maturity_band = {
        let value = clean_text_runtime(
            &value_to_string(base.and_then(|m| m.get("maturity_band"))),
            24,
        );
        if value.is_empty() {
            "novice".to_string()
        } else {
            value
        }
    };
    let reasons = base
        .and_then(|m| m.get("reasons"))
        .and_then(|v| v.as_array())
        .map(|rows| rows.iter().take(8).cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let session_id_value = {
        let value = clean_text_runtime(&value_to_string(opts.and_then(|m| m.get("session_id"))), 120);
        if value.is_empty() {
            Value::Null
        } else {
            Value::String(value)
        }
    };
    let sandbox_verified = to_bool_like(opts.and_then(|m| m.get("sandbox_verified")), false);

    BuildCodeChangeProposalDraftOutput {
        proposal: json!({
            "proposal_id": proposal_id,
            "ts": ts,
            "type": "code_change_proposal",
            "source": "inversion_controller",
            "mode": mode,
            "shadow_mode": shadow_mode,
            "status": "proposal_only",
            "title": title,
            "summary": summary,
            "objective": objective,
            "objective_id": objective_id_value,
            "impact": impact,
            "target": target,
            "certainty": certainty,
            "maturity_band": maturity_band,
            "reasons": reasons,
            "session_id": session_id_value,
            "sandbox_verified": sandbox_verified,
            "proposed_files": proposed_files,
            "proposed_tests": proposed_tests,
            "risk_note": risk_note,
            "governance": {
                "require_mirror_simulation": true,
                "require_human_approval": true,
                "live_apply_locked": true
            }
        }),
    }
}

pub fn compute_normalize_library_row(input: &NormalizeLibraryRowInput) -> NormalizeLibraryRowOutput {
    let src = input.row.as_ref().and_then(|v| v.as_object());

    let id = clean_text_runtime(&value_to_string(src.and_then(|m| m.get("id"))), 80);
    let ts = clean_text_runtime(&value_to_string(src.and_then(|m| m.get("ts"))), 40);
    let objective = clean_text_runtime(&value_to_string(src.and_then(|m| m.get("objective"))), 280);
    let objective_id =
        clean_text_runtime(&value_to_string(src.and_then(|m| m.get("objective_id"))), 120);
    let signature = clean_text_runtime(&value_to_string(src.and_then(|m| m.get("signature"))), 240);

    let signature_tokens = if let Some(tokens) = src
        .and_then(|m| m.get("signature_tokens"))
        .and_then(|v| v.as_array())
    {
        tokens
            .iter()
            .map(|row| {
                compute_normalize_word_token(&NormalizeWordTokenInput {
                    value: Some(value_to_string(Some(row))),
                    max_len: Some(40),
                })
                .value
            })
            .filter(|row| !row.is_empty())
            .take(64)
            .collect::<Vec<_>>()
    } else {
        compute_tokenize_text(&TokenizeTextInput {
            value: Some(if !signature.is_empty() {
                signature.clone()
            } else {
                objective.clone()
            }),
            max_tokens: None,
        })
        .tokens
    };

    let target = compute_normalize_target(&NormalizeTargetInput {
        value: Some(value_to_string(src.and_then(|m| m.get("target")))),
    })
    .value;
    let impact = compute_normalize_impact(&NormalizeImpactInput {
        value: Some(value_to_string(src.and_then(|m| m.get("impact")))),
    })
    .value;
    let certainty = clamp_number(
        parse_number_like(src.and_then(|m| m.get("certainty"))).unwrap_or(0.0),
        0.0,
        1.0,
    );
    let filter_stack_input = src
        .and_then(|m| m.get("filter_stack"))
        .cloned()
        .or_else(|| src.and_then(|m| m.get("filters")).cloned())
        .unwrap_or_else(|| json!([]));
    let filter_stack = compute_normalize_list(&NormalizeListInput {
        value: Some(filter_stack_input),
        max_len: Some(120),
    })
    .items;
    let outcome_trit = (normalize_trit_value(
        src.and_then(|m| m.get("outcome_trit"))
            .unwrap_or(&Value::Null),
    ))
    .clamp(-1, 1);
    let result = compute_normalize_result(&NormalizeResultInput {
        value: Some(value_to_string(src.and_then(|m| m.get("result")))),
    })
    .value;
    let maturity_band = compute_normalize_token(&NormalizeTokenInput {
        value: Some(value_to_string(src.and_then(|m| m.get("maturity_band")))),
        max_len: Some(24),
    })
    .value;
    let principle_id = {
        let v = clean_text_runtime(&value_to_string(src.and_then(|m| m.get("principle_id"))), 80);
        if v.is_empty() {
            Value::Null
        } else {
            Value::String(v)
        }
    };
    let session_id = {
        let v = clean_text_runtime(&value_to_string(src.and_then(|m| m.get("session_id"))), 80);
        if v.is_empty() {
            Value::Null
        } else {
            Value::String(v)
        }
    };

    NormalizeLibraryRowOutput {
        row: json!({
            "id": id,
            "ts": ts,
            "objective": objective,
            "objective_id": objective_id,
            "signature": signature,
            "signature_tokens": signature_tokens,
            "target": target,
            "impact": impact,
            "certainty": certainty,
            "filter_stack": filter_stack,
            "outcome_trit": outcome_trit,
            "result": result,
            "maturity_band": maturity_band,
            "principle_id": principle_id,
            "session_id": session_id
        }),
    }
}

pub fn compute_ensure_dir(input: &EnsureDirInput) -> EnsureDirOutput {
    let dir = input.dir_path.as_deref().unwrap_or("").trim();
    if dir.is_empty() {
        return EnsureDirOutput { ok: true };
    }
    let _ = fs::create_dir_all(dir);
    EnsureDirOutput { ok: true }
}

pub fn compute_read_json(input: &ReadJsonInput) -> ReadJsonOutput {
    let fallback = input.fallback.clone().unwrap_or(Value::Null);
    let file_path = input.file_path.as_deref().unwrap_or("").trim();
    if file_path.is_empty() {
        return ReadJsonOutput { value: fallback };
    }
    let path = Path::new(file_path);
    if !path.exists() {
        return ReadJsonOutput { value: fallback };
    }
    let text = match fs::read_to_string(path) {
        Ok(v) => v,
        Err(_) => return ReadJsonOutput { value: fallback },
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => {
            if v.is_null() {
                ReadJsonOutput { value: fallback }
            } else {
                ReadJsonOutput { value: v }
            }
        }
        Err(_) => ReadJsonOutput { value: fallback },
    }
}

pub fn compute_read_jsonl(input: &ReadJsonlInput) -> ReadJsonlOutput {
    let file_path = input.file_path.as_deref().unwrap_or("").trim();
    if file_path.is_empty() {
        return ReadJsonlOutput { rows: Vec::new() };
    }
    let path = Path::new(file_path);
    if !path.exists() {
        return ReadJsonlOutput { rows: Vec::new() };
    }
    let text = match fs::read_to_string(path) {
        Ok(v) => v,
        Err(_) => return ReadJsonlOutput { rows: Vec::new() },
    };
    let rows = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|row| row.is_object())
        .collect::<Vec<_>>();
    ReadJsonlOutput { rows }
}

pub fn compute_write_json_atomic(input: &WriteJsonAtomicInput) -> WriteJsonAtomicOutput {
    let file_path = input.file_path.as_deref().unwrap_or("").trim();
    if file_path.is_empty() {
        return WriteJsonAtomicOutput { ok: true };
    }
    let value = input.value.clone().unwrap_or(Value::Null);
    let path = Path::new(file_path);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp_path = format!(
        "{}.tmp-{}-{}",
        file_path,
        chrono::Utc::now().timestamp_millis(),
        std::process::id()
    );
    let payload = format!(
        "{}\n",
        serde_json::to_string_pretty(&value).unwrap_or_else(|_| "null".to_string())
    );
    let _ = fs::write(&tmp_path, payload);
    let _ = fs::rename(&tmp_path, file_path);
    WriteJsonAtomicOutput { ok: true }
}

pub fn compute_append_jsonl(input: &AppendJsonlInput) -> AppendJsonlOutput {
    let file_path = input.file_path.as_deref().unwrap_or("").trim();
    if file_path.is_empty() {
        return AppendJsonlOutput { ok: true };
    }
    let row = input.row.clone().unwrap_or(Value::Null);
    let path = Path::new(file_path);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let line = format!(
        "{}\n",
        serde_json::to_string(&row).unwrap_or_else(|_| "null".to_string())
    );
    let mut opts = fs::OpenOptions::new();
    opts.create(true).append(true);
    if let Ok(mut file) = opts.open(path) {
        let _ = std::io::Write::write_all(&mut file, line.as_bytes());
    }
    AppendJsonlOutput { ok: true }
}

pub fn compute_read_text(input: &ReadTextInput) -> ReadTextOutput {
    let fallback = input.fallback.clone().unwrap_or_default();
    let file_path = input.file_path.as_deref().unwrap_or("").trim();
    if file_path.is_empty() {
        return ReadTextOutput { text: fallback };
    }
    let path = Path::new(file_path);
    if !path.exists() {
        return ReadTextOutput { text: fallback };
    }
    let text = fs::read_to_string(path).unwrap_or_else(|_| fallback.clone());
    ReadTextOutput { text }
}

pub fn compute_latest_json_file_in_dir(
    input: &LatestJsonFileInDirInput,
) -> LatestJsonFileInDirOutput {
    let dir = input.dir_path.as_deref().unwrap_or("").trim();
    if dir.is_empty() {
        return LatestJsonFileInDirOutput { file_path: None };
    }
    let dir_path = Path::new(dir);
    if !dir_path.exists() {
        return LatestJsonFileInDirOutput { file_path: None };
    }
    let mut latest_path: Option<PathBuf> = None;
    let mut latest_millis: i128 = i128::MIN;
    if let Ok(entries) = fs::read_dir(dir_path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let Ok(modified) = meta.modified() else {
                continue;
            };
            let Ok(elapsed) = modified.elapsed() else {
                continue;
            };
            let score = -(elapsed.as_millis() as i128);
            if score > latest_millis {
                latest_millis = score;
                latest_path = Some(p);
            }
        }
    }
    LatestJsonFileInDirOutput {
        file_path: latest_path.map(|p| p.to_string_lossy().to_string()),
    }
}

pub fn compute_normalize_output_channel(
    input: &NormalizeOutputChannelInput,
) -> NormalizeOutputChannelOutput {
    let base = input.base_out.as_ref();
    let src = input.src_out.as_ref();
    NormalizeOutputChannelOutput {
        enabled: to_bool_like(
            src.and_then(|v| v.as_object()).and_then(|m| m.get("enabled")),
            map_bool_key(base, "enabled", false),
        ),
        live_enabled: to_bool_like(
            src.and_then(|v| v.as_object()).and_then(|m| m.get("live_enabled")),
            map_bool_key(base, "live_enabled", false),
        ),
        test_enabled: to_bool_like(
            src.and_then(|v| v.as_object()).and_then(|m| m.get("test_enabled")),
            map_bool_key(base, "test_enabled", false),
        ),
        require_sandbox_verification: to_bool_like(
            src.and_then(|v| v.as_object())
                .and_then(|m| m.get("require_sandbox_verification")),
            map_bool_key(base, "require_sandbox_verification", false),
        ),
        require_explicit_emit: to_bool_like(
            src.and_then(|v| v.as_object())
                .and_then(|m| m.get("require_explicit_emit")),
            map_bool_key(base, "require_explicit_emit", false),
        ),
    }
}

pub fn compute_normalize_repo_path(input: &NormalizeRepoPathInput) -> NormalizeRepoPathOutput {
    let fallback = input.fallback.as_deref().unwrap_or("").to_string();
    let raw = clean_text_runtime(input.value.as_deref().unwrap_or(""), 420);
    if raw.is_empty() {
        return NormalizeRepoPathOutput { path: fallback };
    }
    let path = Path::new(&raw);
    if path.is_absolute() {
        return NormalizeRepoPathOutput {
            path: raw.to_string(),
        };
    }
    let root = input.root.as_deref().unwrap_or("");
    let joined = Path::new(root).join(raw);
    NormalizeRepoPathOutput {
        path: joined.to_string_lossy().to_string(),
    }
}

pub fn compute_runtime_paths(input: &RuntimePathsInput) -> RuntimePathsOutput {
    let root = input.root.as_deref().unwrap_or("");
    let default_state_dir = input.default_state_dir.as_deref().unwrap_or("");
    let policy_path = input.policy_path.as_deref().unwrap_or("").to_string();
    let state_dir = {
        let env = input
            .inversion_state_dir_env
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();
        if env.is_empty() {
            default_state_dir.to_string()
        } else if Path::new(&env).is_absolute() {
            env
        } else {
            Path::new(root).join(env).to_string_lossy().to_string()
        }
    };
    let dual_brain_policy_path = {
        let env = input
            .dual_brain_policy_path_env
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();
        if env.is_empty() {
            Path::new(root)
                .join("config")
                .join("dual_brain_policy.json")
                .to_string_lossy()
                .to_string()
        } else if Path::new(&env).is_absolute() {
            env
        } else {
            Path::new(root).join(env).to_string_lossy().to_string()
        }
    };

    let mk = |parts: &[&str]| -> String {
        let mut p = PathBuf::from(&state_dir);
        for part in parts {
            p = p.join(part);
        }
        p.to_string_lossy().to_string()
    };

    RuntimePathsOutput {
        paths: json!({
            "policy_path": policy_path,
            "state_dir": state_dir,
            "latest_path": mk(&["latest.json"]),
            "history_path": mk(&["history.jsonl"]),
            "maturity_path": mk(&["maturity.json"]),
            "tier_governance_path": mk(&["tier_governance.json"]),
            "observer_approvals_path": mk(&["observer_approvals.jsonl"]),
            "harness_state_path": mk(&["maturity_harness.json"]),
            "active_sessions_path": mk(&["active_sessions.json"]),
            "library_path": mk(&["library.jsonl"]),
            "receipts_path": mk(&["receipts.jsonl"]),
            "first_principles_dir": mk(&["first_principles"]),
            "first_principles_latest_path": mk(&["first_principles", "latest.json"]),
            "first_principles_history_path": mk(&["first_principles", "history.jsonl"]),
            "first_principles_lock_path": mk(&["first_principles", "lock_state.json"]),
            "code_change_proposals_dir": mk(&["code_change_proposals"]),
            "code_change_proposals_latest_path": mk(&["code_change_proposals", "latest.json"]),
            "code_change_proposals_history_path": mk(&["code_change_proposals", "history.jsonl"]),
            "organ_dir": mk(&["organ"]),
            "organ_latest_path": mk(&["organ", "latest.json"]),
            "organ_history_path": mk(&["organ", "history.jsonl"]),
            "tree_latest_path": mk(&["tree", "latest.json"]),
            "tree_history_path": mk(&["tree", "history.jsonl"]),
            "interfaces_dir": mk(&["interfaces"]),
            "interfaces_latest_path": mk(&["interfaces", "latest.json"]),
            "interfaces_history_path": mk(&["interfaces", "history.jsonl"]),
            "events_dir": mk(&["events"]),
            "dual_brain_policy_path": dual_brain_policy_path
        }),
    }
}

pub fn compute_normalize_axiom_list(input: &NormalizeAxiomListInput) -> NormalizeAxiomListOutput {
    let src = input
        .raw_axioms
        .as_ref()
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let fallback = input
        .base_axioms
        .as_ref()
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let rows = if src.is_empty() { fallback } else { src };
    let mut out = Vec::new();
    for row in rows {
        let item = row.as_object();
        let id = normalize_token_runtime(&value_to_string(item.and_then(|m| m.get("id"))), 80);
        let patterns = item
            .and_then(|m| m.get("patterns"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|x| clean_text_runtime(&value_to_string(Some(x)), 140).to_lowercase())
                    .filter(|x| !x.is_empty())
                    .take(20)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let regex = item
            .and_then(|m| m.get("regex"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|x| clean_text_runtime(&value_to_string(Some(x)), 220))
                    .filter(|x| !x.is_empty())
                    .take(20)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let intent_tags = compute_normalize_list(&NormalizeListInput {
            value: item.and_then(|m| m.get("intent_tags")).cloned(),
            max_len: Some(80),
        })
        .items
        .into_iter()
        .take(24)
        .collect::<Vec<_>>();

        let signals = item
            .and_then(|m| m.get("signals"))
            .and_then(|v| v.as_object());
        let action_terms = signals
            .and_then(|m| m.get("action_terms"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|x| clean_text_runtime(&value_to_string(Some(x)), 80).to_lowercase())
                    .filter(|x| !x.is_empty())
                    .take(24)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let subject_terms = signals
            .and_then(|m| m.get("subject_terms"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|x| clean_text_runtime(&value_to_string(Some(x)), 80).to_lowercase())
                    .filter(|x| !x.is_empty())
                    .take(24)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let object_terms = signals
            .and_then(|m| m.get("object_terms"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|x| clean_text_runtime(&value_to_string(Some(x)), 80).to_lowercase())
                    .filter(|x| !x.is_empty())
                    .take(24)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let default_groups = (if !action_terms.is_empty() { 1 } else { 0 })
            + (if !subject_terms.is_empty() { 1 } else { 0 })
            + (if !object_terms.is_empty() { 1 } else { 0 });
        let min_signal_groups = parse_number_like(item.and_then(|m| m.get("min_signal_groups")))
            .unwrap_or(default_groups as f64)
            .floor() as i64;
        let min_signal_groups = min_signal_groups.clamp(0, 3);

        let semantic_req = item
            .and_then(|m| m.get("semantic_requirements"))
            .and_then(|v| v.as_object());
        let semantic_actions = compute_normalize_list(&NormalizeListInput {
            value: semantic_req.and_then(|m| m.get("actions")).cloned(),
            max_len: Some(80),
        })
        .items
        .into_iter()
        .take(24)
        .collect::<Vec<_>>();
        let semantic_subjects = compute_normalize_list(&NormalizeListInput {
            value: semantic_req.and_then(|m| m.get("subjects")).cloned(),
            max_len: Some(80),
        })
        .items
        .into_iter()
        .take(24)
        .collect::<Vec<_>>();
        let semantic_objects = compute_normalize_list(&NormalizeListInput {
            value: semantic_req.and_then(|m| m.get("objects")).cloned(),
            max_len: Some(80),
        })
        .items
        .into_iter()
        .take(24)
        .collect::<Vec<_>>();
        let has_semantic_requirements =
            !semantic_actions.is_empty() || !semantic_subjects.is_empty() || !semantic_objects.is_empty();

        if id.is_empty()
            || (patterns.is_empty()
                && regex.is_empty()
                && intent_tags.is_empty()
                && !has_semantic_requirements)
        {
            continue;
        }

        out.push(json!({
            "id": id,
            "patterns": patterns,
            "regex": regex,
            "intent_tags": intent_tags,
            "signals": {
                "action_terms": action_terms,
                "subject_terms": subject_terms,
                "object_terms": object_terms
            },
            "min_signal_groups": min_signal_groups,
            "semantic_requirements": {
                "actions": semantic_actions,
                "subjects": semantic_subjects,
                "objects": semantic_objects
            }
        }));
    }
    NormalizeAxiomListOutput { axioms: out }
}

pub fn compute_normalize_harness_suite(
    input: &NormalizeHarnessSuiteInput,
) -> NormalizeHarnessSuiteOutput {
    let src = input
        .raw_suite
        .as_ref()
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let fallback = input
        .base_suite
        .as_ref()
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let rows = if src.is_empty() { fallback } else { src };
    let mut out = Vec::new();
    for (idx, row) in rows.iter().enumerate() {
        let item = row.as_object();
        let default_id = format!("imh_{}", idx + 1);
        let id_raw = value_to_string(item.and_then(|m| m.get("id")));
        let mut id = normalize_token_runtime(
            if id_raw.is_empty() {
                default_id.as_str()
            } else {
                id_raw.as_str()
            },
            80,
        );
        if id.is_empty() {
            id = default_id;
        }
        let objective = clean_text_runtime(&value_to_string(item.and_then(|m| m.get("objective"))), 280);
        if objective.is_empty() {
            continue;
        }
        let impact = compute_normalize_impact(&NormalizeImpactInput {
            value: Some(value_to_string(item.and_then(|m| m.get("impact")))),
        })
        .value;
        let target = compute_normalize_target(&NormalizeTargetInput {
            value: Some(value_to_string(item.and_then(|m| m.get("target")))),
        })
        .value;
        let mut difficulty = normalize_token_runtime(
            &value_to_string(item.and_then(|m| m.get("difficulty"))),
            24,
        );
        if difficulty.is_empty() {
            difficulty = "medium".to_string();
        }
        out.push(json!({
            "id": id,
            "objective": objective,
            "impact": impact,
            "target": target,
            "difficulty": difficulty
        }));
    }
    NormalizeHarnessSuiteOutput { suite: out }
}

pub fn compute_load_harness_state(input: &LoadHarnessStateInput) -> LoadHarnessStateOutput {
    let now_iso = input.now_iso.clone().unwrap_or_else(now_iso_runtime);
    let src = compute_read_json(&ReadJsonInput {
        file_path: input.file_path.clone(),
        fallback: Some(Value::Null),
    })
    .value;
    let row = src.as_object();
    let updated_at = {
        let value = value_to_string(row.and_then(|m| m.get("updated_at")));
        if value.is_empty() { now_iso.clone() } else { value }
    };
    let last_run_ts = {
        let value = value_to_string(row.and_then(|m| m.get("last_run_ts")));
        if value.is_empty() { Value::Null } else { Value::String(value) }
    };
    let cursor = parse_number_like(row.and_then(|m| m.get("cursor")))
        .unwrap_or(0.0)
        .floor() as i64;
    LoadHarnessStateOutput {
        state: json!({
            "schema_id": "inversion_maturity_harness_state",
            "schema_version": "1.0",
            "updated_at": updated_at,
            "last_run_ts": last_run_ts,
            "cursor": cursor.clamp(0, 1_000_000)
        }),
    }
}

pub fn compute_save_harness_state(input: &SaveHarnessStateInput) -> SaveHarnessStateOutput {
    let now_iso = input.now_iso.clone().unwrap_or_else(now_iso_runtime);
    let src = input.state.as_ref().and_then(|v| v.as_object());
    let last_run_ts = {
        let value = value_to_string(src.and_then(|m| m.get("last_run_ts")));
        if value.is_empty() { Value::Null } else { Value::String(value) }
    };
    let cursor = parse_number_like(src.and_then(|m| m.get("cursor")))
        .unwrap_or(0.0)
        .floor() as i64;
    let out = json!({
        "schema_id": "inversion_maturity_harness_state",
        "schema_version": "1.0",
        "updated_at": now_iso,
        "last_run_ts": last_run_ts,
        "cursor": cursor.clamp(0, 1_000_000)
    });
    let _ = compute_write_json_atomic(&WriteJsonAtomicInput {
        file_path: input.file_path.clone(),
        value: Some(out.clone()),
    });
    SaveHarnessStateOutput { state: out }
}

pub fn compute_load_first_principle_lock_state(
    input: &LoadFirstPrincipleLockStateInput,
) -> LoadFirstPrincipleLockStateOutput {
    let now_iso = input.now_iso.clone().unwrap_or_else(now_iso_runtime);
    let src = compute_read_json(&ReadJsonInput {
        file_path: input.file_path.clone(),
        fallback: Some(Value::Null),
    })
    .value;
    let row = src.as_object();
    let updated_at = {
        let value = value_to_string(row.and_then(|m| m.get("updated_at")));
        if value.is_empty() { now_iso.clone() } else { value }
    };
    let locks = row
        .and_then(|m| m.get("locks"))
        .and_then(|v| v.as_object())
        .map(|m| Value::Object(m.clone()))
        .unwrap_or_else(|| json!({}));
    LoadFirstPrincipleLockStateOutput {
        state: json!({
            "schema_id": "inversion_first_principle_lock_state",
            "schema_version": "1.0",
            "updated_at": updated_at,
            "locks": locks
        }),
    }
}

pub fn compute_save_first_principle_lock_state(
    input: &SaveFirstPrincipleLockStateInput,
) -> SaveFirstPrincipleLockStateOutput {
    let now_iso = input.now_iso.clone().unwrap_or_else(now_iso_runtime);
    let src = input.state.as_ref().and_then(|v| v.as_object());
    let locks = src
        .and_then(|m| m.get("locks"))
        .and_then(|v| v.as_object())
        .map(|m| Value::Object(m.clone()))
        .unwrap_or_else(|| json!({}));
    let out = json!({
        "schema_id": "inversion_first_principle_lock_state",
        "schema_version": "1.0",
        "updated_at": now_iso,
        "locks": locks
    });
    let _ = compute_write_json_atomic(&WriteJsonAtomicInput {
        file_path: input.file_path.clone(),
        value: Some(out.clone()),
    });
    SaveFirstPrincipleLockStateOutput { state: out }
}

pub fn compute_load_observer_approvals(
    input: &LoadObserverApprovalsInput,
) -> LoadObserverApprovalsOutput {
    let rows = compute_read_jsonl(&ReadJsonlInput {
        file_path: input.file_path.clone(),
    })
    .rows
    .into_iter()
    .filter_map(|row| {
        let item = row.as_object()?;
        let ts = clean_text_runtime(&value_to_string(item.get("ts")), 64);
        let target = compute_normalize_target(&NormalizeTargetInput {
            value: Some(value_to_string(item.get("target"))),
        })
        .value;
        let observer_id = compute_normalize_observer_id(&NormalizeObserverIdInput {
            value: Some(
                if item.get("observer_id").is_some() {
                    value_to_string(item.get("observer_id"))
                } else {
                    value_to_string(item.get("observerId"))
                },
            ),
        })
        .value;
        let note = clean_text_runtime(&value_to_string(item.get("note")), 280);
        if ts.is_empty() || observer_id.is_empty() {
            return None;
        }
        Some(json!({
            "ts": ts,
            "target": target,
            "observer_id": observer_id,
            "note": note
        }))
    })
    .collect::<Vec<_>>();
    LoadObserverApprovalsOutput { rows }
}

pub fn compute_append_observer_approval(
    input: &AppendObserverApprovalInput,
) -> AppendObserverApprovalOutput {
    let row = json!({
        "ts": input.now_iso.clone().unwrap_or_else(now_iso_runtime),
        "type": "inversion_live_graduation_observer_approval",
        "target": compute_normalize_target(&NormalizeTargetInput {
            value: input.target.clone()
        }).value,
        "observer_id": compute_normalize_observer_id(&NormalizeObserverIdInput {
            value: input.observer_id.clone()
        }).value,
        "note": clean_text_runtime(input.note.as_deref().unwrap_or(""), 280)
    });
    let _ = compute_append_jsonl(&AppendJsonlInput {
        file_path: input.file_path.clone(),
        row: Some(row.clone()),
    });
    AppendObserverApprovalOutput { row }
}

pub fn compute_count_observer_approvals(
    input: &CountObserverApprovalsInput,
) -> CountObserverApprovalsOutput {
    let window_days = parse_number_like(input.window_days.as_ref())
        .unwrap_or(90.0)
        .floor() as i64;
    let window_days = window_days.clamp(1, 3650);
    let cutoff = Utc::now().timestamp_millis() - (window_days * 24 * 60 * 60 * 1000);
    let target = compute_normalize_target(&NormalizeTargetInput {
        value: input.target.clone(),
    })
    .value;
    let rows = compute_load_observer_approvals(&LoadObserverApprovalsInput {
        file_path: input.file_path.clone(),
    })
    .rows;
    let mut seen: HashSet<String> = HashSet::new();
    for row in rows {
        let item = row.as_object();
        let row_target = compute_normalize_target(&NormalizeTargetInput {
            value: Some(value_to_string(item.and_then(|m| m.get("target")))),
        })
        .value;
        if row_target != target {
            continue;
        }
        let ts = value_to_string(item.and_then(|m| m.get("ts")));
        if parse_ts_ms_runtime(&ts) < cutoff {
            continue;
        }
        let observer_id = compute_normalize_observer_id(&NormalizeObserverIdInput {
            value: Some(value_to_string(item.and_then(|m| m.get("observer_id")))),
        })
        .value;
        if observer_id.is_empty() {
            continue;
        }
        seen.insert(observer_id);
    }
    CountObserverApprovalsOutput {
        count: seen.len() as i64,
    }
}

pub fn compute_ensure_correspondence_file(
    input: &EnsureCorrespondenceFileInput,
) -> EnsureCorrespondenceFileOutput {
    let file_path = input.file_path.as_deref().unwrap_or("").trim();
    if file_path.is_empty() {
        return EnsureCorrespondenceFileOutput { ok: true };
    }
    let path = Path::new(file_path);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if path.exists() {
        return EnsureCorrespondenceFileOutput { ok: true };
    }
    let header = input
        .header
        .clone()
        .unwrap_or_else(|| "# Shadow Conclave Correspondence\n\n".to_string());
    let _ = fs::write(path, header);
    EnsureCorrespondenceFileOutput { ok: true }
}

fn compute_maturity_score_runtime(state: &Value, policy: &Value) -> Value {
    let stats = state
        .as_object()
        .and_then(|m| m.get("stats"))
        .and_then(|v| v.as_object());
    let maturity = policy
        .as_object()
        .and_then(|m| m.get("maturity"))
        .and_then(|v| v.as_object());
    let weights = maturity
        .and_then(|m| m.get("score_weights"))
        .and_then(|v| v.as_object());
    let bands = maturity
        .and_then(|m| m.get("bands"))
        .and_then(|v| v.as_object());

    let total = parse_number_like(stats.and_then(|m| m.get("total_tests")))
        .unwrap_or(0.0)
        .max(0.0);
    let passed = parse_number_like(stats.and_then(|m| m.get("passed_tests")))
        .unwrap_or(0.0)
        .max(0.0);
    let destructive = parse_number_like(stats.and_then(|m| m.get("destructive_failures")))
        .unwrap_or(0.0)
        .max(0.0);
    let non_destructive_rate = if total > 0.0 {
        ((total - destructive) / total).max(0.0)
    } else {
        1.0
    };
    let pass_rate = if total > 0.0 {
        (passed / total).max(0.0)
    } else {
        0.0
    };
    let target_test_count = parse_number_like(maturity.and_then(|m| m.get("target_test_count")))
        .unwrap_or(40.0)
        .max(1.0);
    let experience = (total / target_test_count).min(1.0);

    let weight_pass = parse_number_like(weights.and_then(|m| m.get("pass_rate"))).unwrap_or(0.0);
    let weight_non_destructive =
        parse_number_like(weights.and_then(|m| m.get("non_destructive_rate"))).unwrap_or(0.0);
    let weight_experience =
        parse_number_like(weights.and_then(|m| m.get("experience"))).unwrap_or(0.0);
    let weight_total = (weight_pass + weight_non_destructive + weight_experience).max(0.0001);
    let score = clamp_number(
        ((pass_rate * weight_pass)
            + (non_destructive_rate * weight_non_destructive)
            + (experience * weight_experience))
            / weight_total,
        0.0,
        1.0,
    );

    let novice = parse_number_like(bands.and_then(|m| m.get("novice"))).unwrap_or(0.25);
    let developing = parse_number_like(bands.and_then(|m| m.get("developing"))).unwrap_or(0.45);
    let mature = parse_number_like(bands.and_then(|m| m.get("mature"))).unwrap_or(0.65);
    let seasoned = parse_number_like(bands.and_then(|m| m.get("seasoned"))).unwrap_or(0.82);
    let band = if score < novice {
        "novice"
    } else if score < developing {
        "developing"
    } else if score < mature {
        "mature"
    } else if score < seasoned {
        "seasoned"
    } else {
        "legendary"
    };
    json!({
        "score": (score * 1_000_000.0).round() / 1_000_000.0,
        "band": band,
        "pass_rate": (pass_rate * 1_000_000.0).round() / 1_000_000.0,
        "non_destructive_rate": (non_destructive_rate * 1_000_000.0).round() / 1_000_000.0,
        "experience": (experience * 1_000_000.0).round() / 1_000_000.0
    })
}

pub fn compute_load_maturity_state(input: &LoadMaturityStateInput) -> LoadMaturityStateOutput {
    let now_iso = input.now_iso.clone().unwrap_or_else(now_iso_runtime);
    let src = compute_read_json(&ReadJsonInput {
        file_path: input.file_path.clone(),
        fallback: Some(Value::Null),
    })
    .value;
    let policy = input.policy.clone().unwrap_or_else(|| json!({}));
    let mut state = if src.is_object() {
        src
    } else {
        compute_default_maturity_state(&DefaultMaturityStateInput {}).state
    };
    if !state.is_object() {
        state = compute_default_maturity_state(&DefaultMaturityStateInput {}).state;
    }
    let computed = compute_maturity_score_runtime(&state, &policy);
    if let Some(obj) = state.as_object_mut() {
        let updated_at_value = {
            let value = value_to_string(obj.get("updated_at"))
                .chars()
                .take(64)
                .collect::<String>();
            if value.is_empty() { now_iso.clone() } else { value }
        };
        obj.insert(
            "updated_at".to_string(),
            Value::String(updated_at_value),
        );
        obj.insert(
            "score".to_string(),
            computed.get("score").cloned().unwrap_or_else(|| json!(0)),
        );
        obj.insert(
            "band".to_string(),
            computed
                .get("band")
                .cloned()
                .unwrap_or_else(|| json!("novice")),
        );
    }
    LoadMaturityStateOutput { state, computed }
}

pub fn compute_save_maturity_state(input: &SaveMaturityStateInput) -> SaveMaturityStateOutput {
    let now_iso = input.now_iso.clone().unwrap_or_else(now_iso_runtime);
    let mut state = if input.state.as_ref().map(|v| v.is_object()).unwrap_or(false) {
        input.state.clone().unwrap_or_else(|| json!({}))
    } else {
        compute_default_maturity_state(&DefaultMaturityStateInput {}).state
    };
    let policy = input.policy.clone().unwrap_or_else(|| json!({}));
    let computed = compute_maturity_score_runtime(&state, &policy);
    if let Some(obj) = state.as_object_mut() {
        obj.insert("updated_at".to_string(), Value::String(now_iso));
        obj.insert(
            "score".to_string(),
            computed.get("score").cloned().unwrap_or_else(|| json!(0)),
        );
        obj.insert(
            "band".to_string(),
            computed
                .get("band")
                .cloned()
                .unwrap_or_else(|| json!("novice")),
        );
    }
    let _ = compute_write_json_atomic(&WriteJsonAtomicInput {
        file_path: input.file_path.clone(),
        value: Some(state.clone()),
    });
    SaveMaturityStateOutput { state, computed }
}

pub fn compute_load_active_sessions(input: &LoadActiveSessionsInput) -> LoadActiveSessionsOutput {
    let now_iso = input.now_iso.clone().unwrap_or_else(now_iso_runtime);
    let payload = compute_read_json(&ReadJsonInput {
        file_path: input.file_path.clone(),
        fallback: Some(Value::Null),
    })
    .value;
    let sessions = payload
        .as_object()
        .and_then(|m| m.get("sessions"))
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .filter(|row| row.is_object())
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let updated_at = {
        let value = value_to_string(payload.as_object().and_then(|m| m.get("updated_at")));
        if value.is_empty() {
            now_iso
        } else {
            clean_text_runtime(&value, 64)
        }
    };
    LoadActiveSessionsOutput {
        store: json!({
            "schema_id": "inversion_active_sessions",
            "schema_version": "1.0",
            "updated_at": updated_at,
            "sessions": sessions
        }),
    }
}

pub fn compute_save_active_sessions(input: &SaveActiveSessionsInput) -> SaveActiveSessionsOutput {
    let now_iso = input.now_iso.clone().unwrap_or_else(now_iso_runtime);
    let sessions = input
        .store
        .as_ref()
        .and_then(|v| v.as_object())
        .and_then(|m| m.get("sessions"))
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .filter(|row| row.is_object())
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let out = json!({
        "schema_id": "inversion_active_sessions",
        "schema_version": "1.0",
        "updated_at": now_iso,
        "sessions": sessions
    });
    let _ = compute_write_json_atomic(&WriteJsonAtomicInput {
        file_path: input.file_path.clone(),
        value: Some(out.clone()),
    });
    SaveActiveSessionsOutput { store: out }
}

pub fn compute_emit_event(input: &EmitEventInput) -> EmitEventOutput {
    if !input.emit_events.unwrap_or(false) {
        return EmitEventOutput {
            emitted: false,
            file_path: None,
        };
    }
    let events_dir = input.events_dir.as_deref().unwrap_or("").trim();
    let date_str = clean_text_runtime(input.date_str.as_deref().unwrap_or(""), 32);
    if events_dir.is_empty() || date_str.is_empty() {
        return EmitEventOutput {
            emitted: false,
            file_path: None,
        };
    }
    let fp = Path::new(events_dir).join(format!("{date_str}.jsonl"));
    let event = {
        let token = normalize_token_runtime(input.event_type.as_deref().unwrap_or(""), 64);
        if token.is_empty() {
            "unknown".to_string()
        } else {
            token
        }
    };
    let row = json!({
        "ts": input.now_iso.clone().unwrap_or_else(now_iso_runtime),
        "type": "inversion_event",
        "event": event,
        "payload": input.payload.clone().unwrap_or_else(|| json!({}))
    });
    let _ = compute_append_jsonl(&AppendJsonlInput {
        file_path: Some(fp.to_string_lossy().to_string()),
        row: Some(row),
    });
    EmitEventOutput {
        emitted: true,
        file_path: Some(fp.to_string_lossy().to_string()),
    }
}

pub fn compute_append_persona_lens_gate_receipt(
    input: &AppendPersonaLensGateReceiptInput,
) -> AppendPersonaLensGateReceiptOutput {
    let payload = input.payload.as_ref().and_then(|v| v.as_object());
    if !to_bool_like(payload.and_then(|m| m.get("enabled")), false) {
        return AppendPersonaLensGateReceiptOutput { rel_path: None };
    }
    let mut target_path = clean_text_runtime(input.cfg_receipts_path.as_deref().unwrap_or(""), 420);
    if target_path.is_empty() {
        let state_dir = clean_text_runtime(input.state_dir.as_deref().unwrap_or(""), 420);
        target_path = Path::new(&state_dir)
            .join("lens_gate_receipts.jsonl")
            .to_string_lossy()
            .to_string();
    }
    let decision = input.decision.as_ref().and_then(|v| v.as_object());
    let feed_push = payload
        .and_then(|m| m.get("feed_push"))
        .and_then(|v| v.as_object());
    let persona_id = {
        let value = clean_text_runtime(&value_to_string(payload.and_then(|m| m.get("persona_id"))), 120);
        if value.is_empty() {
            Value::Null
        } else {
            Value::String(value)
        }
    };
    let mode = {
        let value = clean_text_runtime(&value_to_string(payload.and_then(|m| m.get("mode"))), 24);
        if value.is_empty() {
            "auto".to_string()
        } else {
            value
        }
    };
    let effective_mode = {
        let value = clean_text_runtime(
            &value_to_string(payload.and_then(|m| m.get("effective_mode"))),
            24,
        );
        if value.is_empty() {
            "shadow".to_string()
        } else {
            value
        }
    };
    let status = {
        let value = clean_text_runtime(&value_to_string(payload.and_then(|m| m.get("status"))), 32);
        if value.is_empty() {
            "unknown".to_string()
        } else {
            value
        }
    };
    let reasons = payload
        .and_then(|m| m.get("reasons"))
        .and_then(|v| v.as_array())
        .map(|rows| rows.iter().take(8).cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let feed_push_value = if let Some(feed) = feed_push {
        let reason = {
            let value = clean_text_runtime(&value_to_string(feed.get("reason")), 120);
            if value.is_empty() {
                Value::Null
            } else {
                Value::String(value)
            }
        };
        let feed_path = {
            let value = clean_text_runtime(&value_to_string(feed.get("feed_path")), 220);
            if value.is_empty() {
                Value::Null
            } else {
                Value::String(value)
            }
        };
        let receipts_path = {
            let value = clean_text_runtime(&value_to_string(feed.get("receipts_path")), 220);
            if value.is_empty() {
                Value::Null
            } else {
                Value::String(value)
            }
        };
        let entry_hash = {
            let value = clean_text_runtime(&value_to_string(feed.get("entry_hash")), 120);
            if value.is_empty() {
                Value::Null
            } else {
                Value::String(value)
            }
        };
        json!({
            "pushed": to_bool_like(feed.get("pushed"), false),
            "reason": reason,
            "feed_path": feed_path,
            "receipts_path": receipts_path,
            "entry_hash": entry_hash
        })
    } else {
        Value::Null
    };
    let objective = {
        let value = clean_text_runtime(
            &value_to_string(
                decision
                    .and_then(|m| m.get("input"))
                    .and_then(|v| v.as_object())
                    .and_then(|m| m.get("objective")),
            ),
            260,
        );
        if value.is_empty() {
            Value::Null
        } else {
            Value::String(value)
        }
    };
    let target = {
        let value = clean_text_runtime(
            &value_to_string(
                decision
                    .and_then(|m| m.get("input"))
                    .and_then(|v| v.as_object())
                    .and_then(|m| m.get("target")),
            ),
            40,
        );
        if value.is_empty() {
            Value::Null
        } else {
            Value::String(value)
        }
    };
    let impact = {
        let value = clean_text_runtime(
            &value_to_string(
                decision
                    .and_then(|m| m.get("input"))
                    .and_then(|v| v.as_object())
                    .and_then(|m| m.get("impact")),
            ),
            40,
        );
        if value.is_empty() {
            Value::Null
        } else {
            Value::String(value)
        }
    };
    let row = json!({
        "ts": input.now_iso.clone().unwrap_or_else(now_iso_runtime),
        "type": "inversion_persona_lens_gate",
        "persona_id": persona_id,
        "mode": mode,
        "effective_mode": effective_mode,
        "status": status,
        "fail_closed": to_bool_like(payload.and_then(|m| m.get("fail_closed")), false),
        "drift_rate": parse_number_like(payload.and_then(|m| m.get("drift_rate"))).unwrap_or(0.0),
        "drift_threshold": parse_number_like(payload.and_then(|m| m.get("drift_threshold"))).unwrap_or(0.02),
        "parity_confidence": parse_number_like(payload.and_then(|m| m.get("parity_confidence"))).unwrap_or(0.0),
        "parity_confident": to_bool_like(payload.and_then(|m| m.get("parity_confident")), false),
        "reasons": reasons,
        "feed_push": feed_push_value,
        "objective": objective,
        "target": target,
        "impact": impact,
        "allowed": to_bool_like(decision.and_then(|m| m.get("allowed")), false)
    });
    let _ = compute_append_jsonl(&AppendJsonlInput {
        file_path: Some(target_path.clone()),
        row: Some(row),
    });
    let rel_path = {
        let root = clean_text_runtime(input.root.as_deref().unwrap_or(""), 420);
        if !root.is_empty() {
            let root_path = Path::new(&root);
            let target = Path::new(&target_path);
            if let Ok(rel) = target.strip_prefix(root_path) {
                rel.to_string_lossy().to_string()
            } else {
                target_path.clone()
            }
        } else {
            target_path.clone()
        }
    };
    AppendPersonaLensGateReceiptOutput {
        rel_path: Some(rel_path),
    }
}

pub fn compute_append_conclave_correspondence(
    input: &AppendConclaveCorrespondenceInput,
) -> AppendConclaveCorrespondenceOutput {
    let correspondence_path = input.correspondence_path.as_deref().unwrap_or("").trim();
    if correspondence_path.is_empty() {
        return AppendConclaveCorrespondenceOutput { ok: true };
    }
    let _ = compute_ensure_correspondence_file(&EnsureCorrespondenceFileInput {
        file_path: Some(correspondence_path.to_string()),
        header: Some("# Shadow Conclave Correspondence\n\n".to_string()),
    });
    let row = input.row.as_ref().and_then(|v| v.as_object());
    let high_risk_flags = row
        .and_then(|m| m.get("high_risk_flags"))
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .map(|r| clean_text_runtime(&value_to_string(Some(r)), 120))
                .filter(|r| !r.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let review_payload = row
        .and_then(|m| m.get("review_payload"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let entry = [
        format!(
            "## {} - Re: Inversion Shadow Conclave Review ({})",
            clean_text_runtime(&value_to_string(row.and_then(|m| m.get("ts"))), 64),
            {
                let value = clean_text_runtime(
                    &value_to_string(row.and_then(|m| m.get("session_or_step"))),
                    120,
                );
                if value.is_empty() {
                    "unknown".to_string()
                } else {
                    value
                }
            }
        ),
        format!(
            "- Decision: {}",
            if to_bool_like(row.and_then(|m| m.get("pass")), false) {
                "approved"
            } else {
                "escalated_to_monarch"
            }
        ),
        format!(
            "- Winner: {}",
            {
                let value = clean_text_runtime(&value_to_string(row.and_then(|m| m.get("winner"))), 120);
                if value.is_empty() {
                    "none".to_string()
                } else {
                    value
                }
            }
        ),
        format!(
            "- Arbitration rule: {}",
            {
                let value =
                    clean_text_runtime(&value_to_string(row.and_then(|m| m.get("arbitration_rule"))), 160);
                if value.is_empty() {
                    "unknown".to_string()
                } else {
                    value
                }
            }
        ),
        format!(
            "- High-risk flags: {}",
            if high_risk_flags.is_empty() {
                "none".to_string()
            } else {
                high_risk_flags.join(", ")
            }
        ),
        format!(
            "- Query: {}",
            {
                let value = clean_text_runtime(&value_to_string(row.and_then(|m| m.get("query"))), 1800);
                if value.is_empty() {
                    "n/a".to_string()
                } else {
                    value
                }
            }
        ),
        format!(
            "- Proposal summary: {}",
            {
                let value =
                    clean_text_runtime(&value_to_string(row.and_then(|m| m.get("proposal_summary"))), 1400);
                if value.is_empty() {
                    "n/a".to_string()
                } else {
                    value
                }
            }
        ),
        format!(
            "- Receipt: {}",
            {
                let value = clean_text_runtime(&value_to_string(row.and_then(|m| m.get("receipt_path"))), 260);
                if value.is_empty() {
                    "n/a".to_string()
                } else {
                    value
                }
            }
        ),
        String::new(),
        "```json".to_string(),
        serde_json::to_string_pretty(&review_payload).unwrap_or_else(|_| "{}".to_string()),
        "```".to_string(),
        String::new(),
    ]
    .join("\n");
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(Path::new(correspondence_path))
    {
        let _ = std::io::Write::write_all(&mut file, format!("{entry}\n").as_bytes());
    }
    AppendConclaveCorrespondenceOutput { ok: true }
}

pub fn compute_persist_decision(input: &PersistDecisionInput) -> PersistDecisionOutput {
    let payload = input.payload.clone().unwrap_or_else(|| json!({}));
    let _ = compute_write_json_atomic(&WriteJsonAtomicInput {
        file_path: input.latest_path.clone(),
        value: Some(payload.clone()),
    });
    let _ = compute_append_jsonl(&AppendJsonlInput {
        file_path: input.history_path.clone(),
        row: Some(payload),
    });
    PersistDecisionOutput { ok: true }
}

pub fn compute_persist_interface_envelope(
    input: &PersistInterfaceEnvelopeInput,
) -> PersistInterfaceEnvelopeOutput {
    let envelope = input.envelope.clone().unwrap_or_else(|| json!({}));
    let _ = compute_write_json_atomic(&WriteJsonAtomicInput {
        file_path: input.latest_path.clone(),
        value: Some(envelope.clone()),
    });
    let _ = compute_append_jsonl(&AppendJsonlInput {
        file_path: input.history_path.clone(),
        row: Some(envelope),
    });
    PersistInterfaceEnvelopeOutput { ok: true }
}

pub fn compute_trim_library(input: &TrimLibraryInput) -> TrimLibraryOutput {
    let rows = compute_read_jsonl(&ReadJsonlInput {
        file_path: input.file_path.clone(),
    })
    .rows
    .into_iter()
    .map(|row| {
        let mut normalized = compute_normalize_library_row(&NormalizeLibraryRowInput { row: Some(row) }).row;
        if let Some(obj) = normalized.as_object_mut() {
            let maturity_band = value_to_string(obj.get("maturity_band"));
            if maturity_band.is_empty() {
                obj.insert("maturity_band".to_string(), Value::String("novice".to_string()));
            }
        }
        normalized
    })
    .collect::<Vec<_>>();
    let cap = parse_number_like(input.max_entries.as_ref())
        .unwrap_or(4000.0)
        .floor() as i64;
    let cap = cap.max(100) as usize;
    if rows.len() <= cap {
        return TrimLibraryOutput { rows };
    }
    let mut sorted = rows;
    sorted.sort_by(|a, b| {
        let a_ts = value_to_string(a.as_object().and_then(|m| m.get("ts")));
        let b_ts = value_to_string(b.as_object().and_then(|m| m.get("ts")));
        a_ts.cmp(&b_ts)
    });
    let keep = sorted.split_off(sorted.len().saturating_sub(cap));
    let path = input.file_path.as_deref().unwrap_or("").trim();
    if !path.is_empty() {
        let payload = keep
            .iter()
            .map(|row| serde_json::to_string(row).unwrap_or_else(|_| "null".to_string()))
            .collect::<Vec<_>>()
            .join("\n");
        let _ = fs::write(path, format!("{payload}\n"));
    }
    TrimLibraryOutput { rows: keep }
}

pub fn compute_detect_immutable_axiom_violation(
    input: &DetectImmutableAxiomViolationInput,
) -> DetectImmutableAxiomViolationOutput {
    let axioms_policy = value_path(input.policy.as_ref(), &["immutable_axioms"])
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    if !to_bool_like(axioms_policy.get("enabled"), false) {
        return DetectImmutableAxiomViolationOutput { hits: Vec::new() };
    }
    let rows = axioms_policy
        .get("axioms")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if rows.is_empty() {
        return DetectImmutableAxiomViolationOutput { hits: Vec::new() };
    }
    let decision = input
        .decision_input
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let objective = clean_text_runtime(&value_to_string(decision.get("objective")), 500);
    let signature = clean_text_runtime(&value_to_string(decision.get("signature")), 500);
    let filters = decision
        .get("filters")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|row| clean_text_runtime(&value_to_string(Some(row)), 120))
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>();
    let haystack = clean_text_runtime(
        &[objective.clone(), signature.clone(), filters.join(" ")]
            .join(" ")
            .to_lowercase(),
        2400,
    );
    let token_set = compute_tokenize_text(&TokenizeTextInput {
        value: Some(haystack.clone()),
        max_tokens: Some(64),
    })
    .tokens;
    let intent_tags = compute_normalize_list(&NormalizeListInput {
        value: Some(
            decision
                .get("intent_tags")
                .cloned()
                .unwrap_or(Value::Array(vec![])),
        ),
        max_len: Some(80),
    })
    .items;

    let mut hits = Vec::new();
    for axiom in rows {
        let Some(axiom_obj) = axiom.as_object() else {
            continue;
        };
        let id = compute_normalize_token(&NormalizeTokenInput {
            value: Some(value_to_string(axiom_obj.get("id"))),
            max_len: Some(80),
        })
        .value;
        if id.is_empty() {
            continue;
        }
        let patterns = axiom_obj
            .get("patterns")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|row| {
                compute_normalize_axiom_pattern(&NormalizeAxiomPatternInput {
                    value: Some(value_to_string(Some(row))),
                })
                .value
            })
            .filter(|row| !row.is_empty())
            .collect::<Vec<_>>();
        let mut pattern_matched = false;
        for pattern in patterns {
            let source = compute_pattern_to_word_regex(&PatternToWordRegexInput {
                pattern: Some(pattern),
                max_len: Some(220),
            })
            .source;
            let Some(source) = source else {
                continue;
            };
            let Ok(re) = Regex::new(&source) else {
                continue;
            };
            if re.is_match(&haystack) {
                pattern_matched = true;
                break;
            }
        }

        let regex_rules = axiom_obj
            .get("regex")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|row| clean_text_runtime(&value_to_string(Some(row)), 220))
            .filter(|row| !row.is_empty())
            .collect::<Vec<_>>();
        let regex_matched = regex_rules.iter().any(|rule| {
            Regex::new(rule)
                .ok()
                .map(|re| re.is_match(&haystack))
                .unwrap_or(false)
        });

        let tag_rules = compute_normalize_list(&NormalizeListInput {
            value: Some(
                axiom_obj
                    .get("intent_tags")
                    .cloned()
                    .unwrap_or(Value::Array(vec![])),
            ),
            max_len: Some(80),
        })
        .items;
        let tag_matched = tag_rules.iter().any(|tag| intent_tags.iter().any(|it| it == tag));

        let signal_cfg = axiom_obj
            .get("signals")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        let signal_groups = compute_count_axiom_signal_groups(&CountAxiomSignalGroupsInput {
            action_terms: compute_normalize_axiom_signal_terms(&NormalizeAxiomSignalTermsInput {
                terms: signal_cfg
                    .get("action_terms")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default(),
            })
            .terms,
            subject_terms: compute_normalize_axiom_signal_terms(&NormalizeAxiomSignalTermsInput {
                terms: signal_cfg
                    .get("subject_terms")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default(),
            })
            .terms,
            object_terms: compute_normalize_axiom_signal_terms(&NormalizeAxiomSignalTermsInput {
                terms: signal_cfg
                    .get("object_terms")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default(),
            })
            .terms,
            min_signal_groups: axiom_obj.get("min_signal_groups").and_then(|v| v.as_i64()),
            haystack: Some(haystack.clone()),
            token_set: token_set.clone(),
        });
        let structured_signal_configured = signal_groups.configured_groups > 0;
        let structured_pattern_match = pattern_matched
            && (!structured_signal_configured || signal_groups.pass);
        if tag_matched || regex_matched || structured_pattern_match {
            hits.push(id);
        }
    }
    hits.sort();
    hits.dedup();
    DetectImmutableAxiomViolationOutput { hits }
}

pub fn compute_maturity_score(input: &ComputeMaturityScoreInput) -> ComputeMaturityScoreOutput {
    let state = input
        .state
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let policy = input
        .policy
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let stats = state
        .get("stats")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let total = js_number_for_extract(stats.get("total_tests"))
        .unwrap_or(0.0)
        .max(0.0);
    let passed = js_number_for_extract(stats.get("passed_tests"))
        .unwrap_or(0.0)
        .max(0.0);
    let destructive = js_number_for_extract(stats.get("destructive_failures"))
        .unwrap_or(0.0)
        .max(0.0);
    let non_destructive_rate = if total > 0.0 {
        ((total - destructive) / total).max(0.0)
    } else {
        1.0
    };
    let pass_rate = if total > 0.0 {
        (passed / total).max(0.0)
    } else {
        0.0
    };
    let target_test_count = js_number_for_extract(value_path(Some(&Value::Object(policy.clone())), &["maturity", "target_test_count"]))
        .unwrap_or(40.0)
        .max(1.0);
    let experience = (total / target_test_count).min(1.0);
    let weights = value_path(Some(&Value::Object(policy.clone())), &["maturity", "score_weights"])
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let w_pass = js_number_for_extract(weights.get("pass_rate")).unwrap_or(0.0);
    let w_non = js_number_for_extract(weights.get("non_destructive_rate")).unwrap_or(0.0);
    let w_exp = js_number_for_extract(weights.get("experience")).unwrap_or(0.0);
    let weight_total = (w_pass + w_non + w_exp).max(0.0001);
    let score = ((pass_rate * w_pass) + (non_destructive_rate * w_non) + (experience * w_exp))
        / weight_total;
    let s = clamp_number(score, 0.0, 1.0);
    let bands = value_path(Some(&Value::Object(policy.clone())), &["maturity", "bands"])
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let novice = js_number_for_extract(bands.get("novice")).unwrap_or(0.25);
    let developing = js_number_for_extract(bands.get("developing")).unwrap_or(0.45);
    let mature = js_number_for_extract(bands.get("mature")).unwrap_or(0.65);
    let seasoned = js_number_for_extract(bands.get("seasoned")).unwrap_or(0.82);
    let band = if s < novice {
        "novice".to_string()
    } else if s < developing {
        "developing".to_string()
    } else if s < mature {
        "mature".to_string()
    } else if s < seasoned {
        "seasoned".to_string()
    } else {
        "legendary".to_string()
    };
    ComputeMaturityScoreOutput {
        score: (s * 1_000_000.0).round() / 1_000_000.0,
        band,
        pass_rate: (pass_rate * 1_000_000.0).round() / 1_000_000.0,
        non_destructive_rate: (non_destructive_rate * 1_000_000.0).round() / 1_000_000.0,
        experience: (experience * 1_000_000.0).round() / 1_000_000.0,
    }
}

pub fn compute_select_library_candidates(
    input: &SelectLibraryCandidatesInput,
) -> SelectLibraryCandidatesOutput {
    let policy = input.policy.clone().unwrap_or_else(|| json!({}));
    let query = input.query.as_ref().and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let rows = compute_read_jsonl(&ReadJsonlInput {
        file_path: input.file_path.clone(),
    })
    .rows
    .into_iter()
    .map(|row| compute_normalize_library_row(&NormalizeLibraryRowInput { row: Some(row) }).row)
    .collect::<Vec<_>>();
    let min_similarity = js_number_for_extract(value_path(Some(&policy), &["library", "min_similarity_for_reuse"]))
        .unwrap_or(0.35);
    let mut scored = rows
        .into_iter()
        .map(|row| {
            let similarity = compute_library_match_score(&LibraryMatchScoreInput {
                query_signature_tokens: query
                    .get("signature_tokens")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|v| value_to_string(Some(v)))
                    .collect::<Vec<_>>(),
                query_trit_vector: query
                    .get("trit_vector")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default(),
                query_target: query.get("target").and_then(|v| v.as_str()).map(|v| v.to_string()),
                row_signature_tokens: row
                    .as_object()
                    .and_then(|m| m.get("signature_tokens"))
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|v| value_to_string(Some(v)))
                    .collect::<Vec<_>>(),
                row_outcome_trit: row
                    .as_object()
                    .and_then(|m| m.get("outcome_trit"))
                    .and_then(|v| v.as_i64()),
                row_target: row
                    .as_object()
                    .and_then(|m| m.get("target"))
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string()),
                token_weight: value_path(Some(&policy), &["library", "token_weight"]).and_then(|v| v.as_f64()),
                trit_weight: value_path(Some(&policy), &["library", "trit_weight"]).and_then(|v| v.as_f64()),
                target_weight: value_path(Some(&policy), &["library", "target_weight"]).and_then(|v| v.as_f64()),
            })
            .score;
            let base_certainty = clamp_number(
                js_number_for_extract(row.as_object().and_then(|m| m.get("certainty"))).unwrap_or(0.0),
                0.0,
                1.0,
            );
            let outcome_trit = normalize_trit_value(
                row.as_object()
                    .and_then(|m| m.get("outcome_trit"))
                    .unwrap_or(&Value::Null),
            );
            let confidence_multiplier = if outcome_trit == 1 {
                1.0
            } else if outcome_trit == 0 {
                0.9
            } else {
                0.6
            };
            let candidate_certainty = clamp_number(base_certainty * confidence_multiplier, 0.0, 1.0);
            json!({
                "row": row,
                "similarity": (similarity * 1_000_000.0).round() / 1_000_000.0,
                "candidate_certainty": (candidate_certainty * 1_000_000.0).round() / 1_000_000.0
            })
        })
        .filter(|entry| {
            js_number_for_extract(entry.as_object().and_then(|m| m.get("similarity")))
                .unwrap_or(0.0)
                >= min_similarity
        })
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| {
        let a_sim = js_number_for_extract(a.as_object().and_then(|m| m.get("similarity"))).unwrap_or(0.0);
        let b_sim = js_number_for_extract(b.as_object().and_then(|m| m.get("similarity"))).unwrap_or(0.0);
        if (b_sim - a_sim).abs() > f64::EPSILON {
            return b_sim.partial_cmp(&a_sim).unwrap_or(std::cmp::Ordering::Equal);
        }
        let a_cert =
            js_number_for_extract(a.as_object().and_then(|m| m.get("candidate_certainty"))).unwrap_or(0.0);
        let b_cert =
            js_number_for_extract(b.as_object().and_then(|m| m.get("candidate_certainty"))).unwrap_or(0.0);
        if (b_cert - a_cert).abs() > f64::EPSILON {
            return b_cert.partial_cmp(&a_cert).unwrap_or(std::cmp::Ordering::Equal);
        }
        let a_ts = value_to_string(
            a.as_object()
                .and_then(|m| m.get("row"))
                .and_then(|v| v.as_object())
                .and_then(|m| m.get("ts")),
        );
        let b_ts = value_to_string(
            b.as_object()
                .and_then(|m| m.get("row"))
                .and_then(|v| v.as_object())
                .and_then(|m| m.get("ts")),
        );
        b_ts.cmp(&a_ts)
    });
    SelectLibraryCandidatesOutput { candidates: scored }
}

pub fn compute_parse_lane_decision(input: &ParseLaneDecisionInput) -> ParseLaneDecisionOutput {
    let args = input
        .args
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let lane_raw = {
        let candidates = [
            value_to_string(args.get("brain_lane")),
            value_to_string(args.get("brain-lane")),
            value_to_string(args.get("generation_lane")),
            value_to_string(args.get("generation-lane")),
        ];
        candidates
            .into_iter()
            .find(|v| !v.trim().is_empty())
            .unwrap_or_default()
    };
    let lane = compute_normalize_token(&NormalizeTokenInput {
        value: Some(lane_raw),
        max_len: Some(120),
    })
    .value;
    if !lane.is_empty() {
        return ParseLaneDecisionOutput {
            selected_lane: lane,
            source: "arg".to_string(),
            route: None,
        };
    }
    ParseLaneDecisionOutput {
        selected_lane: String::new(),
        source: "none".to_string(),
        route: None,
    }
}

pub fn compute_sweep_expired_sessions(
    input: &SweepExpiredSessionsInput,
) -> SweepExpiredSessionsOutput {
    let paths = input
        .paths
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let policy = input.policy.clone().unwrap_or_else(|| json!({}));
    let date_str = clean_text_runtime(input.date_str.as_deref().unwrap_or(""), 32);
    let now_iso = input.now_iso.clone().unwrap_or_else(now_iso_runtime);
    let now_ms = parse_ts_ms_runtime(&now_iso);
    let store = compute_load_active_sessions(&LoadActiveSessionsInput {
        file_path: paths
            .get("active_sessions_path")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        now_iso: Some(now_iso.clone()),
    })
    .store;
    let sessions = store
        .get("sessions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut expired = Vec::new();
    let mut keep = Vec::new();
    for session in sessions {
        let expires_ms = parse_ts_ms_runtime(&value_to_string(
            session.as_object().and_then(|m| m.get("expires_at")),
        ));
        if expires_ms > 0 && expires_ms <= now_ms {
            expired.push(session);
        } else {
            keep.push(session);
        }
    }
    if expired.is_empty() {
        return SweepExpiredSessionsOutput {
            expired_count: 0,
            sessions: keep,
        };
    }
    let _ = compute_save_active_sessions(&SaveActiveSessionsInput {
        file_path: paths
            .get("active_sessions_path")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        store: Some(json!({ "sessions": keep.clone() })),
        now_iso: Some(now_iso.clone()),
    });
    for session in expired {
        let session_obj = session.as_object().cloned().unwrap_or_default();
        let row = json!({
            "ts": now_iso.clone(),
            "type": "inversion_auto_revert",
            "reason": "session_timeout",
            "session_id": clean_text_runtime(&value_to_string(session_obj.get("session_id")), 80),
            "objective": clean_text_runtime(&value_to_string(session_obj.get("objective")), 220),
            "target": compute_normalize_target(&NormalizeTargetInput {
                value: Some(value_to_string(session_obj.get("target")))
            }).value,
            "outcome_trit": 0,
            "result": "neutral",
            "certainty": js_number_for_extract(session_obj.get("certainty")).unwrap_or(0.0)
        });
        let _ = compute_append_jsonl(&AppendJsonlInput {
            file_path: paths
                .get("receipts_path")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
            row: Some(row.clone()),
        });
        let objective = value_to_string(session_obj.get("objective"));
        let signature = {
            let sig = value_to_string(session_obj.get("signature"));
            if sig.is_empty() {
                objective.clone()
            } else {
                sig
            }
        };
        let id_seed = format!(
            "{}|{}|timeout",
            value_to_string(row.as_object().and_then(|m| m.get("session_id"))),
            now_iso
        );
        let library_target = compute_normalize_target(&NormalizeTargetInput {
            value: Some(value_to_string(row.as_object().and_then(|m| m.get("target")))),
        })
        .value;
        let library_impact = compute_normalize_impact(&NormalizeImpactInput {
            value: Some(value_to_string(session_obj.get("impact"))),
        })
        .value;
        let library_certainty = {
            let certainty =
                js_number_for_extract(row.as_object().and_then(|m| m.get("certainty"))).unwrap_or(0.0);
            (clamp_number(certainty, 0.0, 1.0) * 1_000_000.0).round() / 1_000_000.0
        };
        let library_filter_stack = compute_normalize_list(&NormalizeListInput {
            value: Some(
                session_obj
                    .get("filter_stack")
                    .cloned()
                    .unwrap_or(Value::Array(vec![])),
            ),
            max_len: Some(120),
        })
        .items;
        let library_maturity_band = compute_normalize_token(&NormalizeTokenInput {
            value: Some(value_to_string(session_obj.get("maturity_band"))),
            max_len: Some(24),
        })
        .value;
        let library_session_id = clean_text_runtime(
            &value_to_string(row.as_object().and_then(|m| m.get("session_id"))),
            80,
        );
        let _ = compute_append_jsonl(&AppendJsonlInput {
            file_path: paths
                .get("library_path")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
            row: Some(json!({
                "id": stable_id_runtime(&id_seed, "ifl"),
                "ts": now_iso.clone(),
                "objective": clean_text_runtime(&objective, 240),
                "objective_id": clean_text_runtime(&value_to_string(session_obj.get("objective_id")), 120),
                "signature": clean_text_runtime(&signature, 240),
                "signature_tokens": compute_tokenize_text(&TokenizeTextInput { value: Some(signature), max_tokens: Some(64) }).tokens,
                "target": library_target,
                "impact": library_impact,
                "certainty": library_certainty,
                "filter_stack": library_filter_stack,
                "outcome_trit": 0,
                "result": "neutral",
                "maturity_band": library_maturity_band,
                "session_id": library_session_id
            })),
        });
        if to_bool_like(value_path(Some(&policy), &["telemetry", "emit_events"]), false) {
            let _ = compute_emit_event(&EmitEventInput {
                events_dir: paths
                    .get("events_dir")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string()),
                date_str: Some(date_str.clone()),
                event_type: Some("session_auto_revert".to_string()),
                payload: Some(row),
                emit_events: Some(true),
                now_iso: Some(now_iso.clone()),
            });
        }
    }
    let _ = compute_trim_library(&TrimLibraryInput {
        file_path: paths
            .get("library_path")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        max_entries: value_path(Some(&policy), &["library", "max_entries"]).cloned(),
    });
    SweepExpiredSessionsOutput {
        expired_count: (store
            .get("sessions")
            .and_then(|v| v.as_array())
            .map(|rows| rows.len())
            .unwrap_or(0)
            .saturating_sub(keep.len())) as i64,
        sessions: keep,
    }
}

pub fn compute_load_impossibility_signals(
    input: &LoadImpossibilitySignalsInput,
) -> LoadImpossibilitySignalsOutput {
    let policy = input.policy.clone().unwrap_or_else(|| json!({}));
    let date_str = clean_text_runtime(input.date_str.as_deref().unwrap_or(""), 32);
    let root = input.root.clone().unwrap_or_default();
    let paths_cfg = value_path(Some(&policy), &["organ", "trigger_detection", "paths"])
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let resolve_path = |raw: Option<&Value>| -> String {
        let p = clean_text_runtime(&value_to_string(raw), 420);
        if p.is_empty() {
            return String::new();
        }
        if Path::new(&p).is_absolute() || root.is_empty() {
            p
        } else {
            Path::new(&root).join(p).to_string_lossy().to_string()
        }
    };
    let regime_path = resolve_path(paths_cfg.get("regime_latest_path"));
    let mirror_path = resolve_path(paths_cfg.get("mirror_latest_path"));
    let simulation_dir = resolve_path(paths_cfg.get("simulation_dir"));
    let red_team_dir = resolve_path(paths_cfg.get("red_team_runs_dir"));
    let drift_governor_path = resolve_path(paths_cfg.get("drift_governor_path"));

    let regime = compute_read_json(&ReadJsonInput {
        file_path: Some(regime_path.clone()),
        fallback: Some(Value::Null),
    })
    .value;
    let mirror = compute_read_json(&ReadJsonInput {
        file_path: Some(mirror_path.clone()),
        fallback: Some(Value::Null),
    })
    .value;
    let simulation_by_date = if simulation_dir.is_empty() || date_str.is_empty() {
        String::new()
    } else {
        Path::new(&simulation_dir)
            .join(format!("{date_str}.json"))
            .to_string_lossy()
            .to_string()
    };
    let simulation_path = if !simulation_by_date.is_empty() && Path::new(&simulation_by_date).exists() {
        simulation_by_date
    } else {
        compute_latest_json_file_in_dir(&LatestJsonFileInDirInput {
            dir_path: Some(simulation_dir.clone()),
        })
        .file_path
        .unwrap_or_default()
    };
    let simulation = compute_read_json(&ReadJsonInput {
        file_path: Some(simulation_path.clone()),
        fallback: Some(Value::Null),
    })
    .value;
    let red_team_path = compute_latest_json_file_in_dir(&LatestJsonFileInDirInput {
        dir_path: Some(red_team_dir.clone()),
    })
    .file_path
    .unwrap_or_default();
    let red_team = compute_read_json(&ReadJsonInput {
        file_path: Some(red_team_path.clone()),
        fallback: Some(Value::Null),
    })
    .value;
    let drift_governor = compute_read_json(&ReadJsonInput {
        file_path: Some(drift_governor_path.clone()),
        fallback: Some(Value::Null),
    })
    .value;
    let trit_from_regime = normalize_trit_value(
        value_path(Some(&regime), &["context", "trit", "trit"]).unwrap_or(&Value::Null),
    );
    let trit_from_drift = normalize_trit_value(
        value_path(
            Some(&drift_governor),
            &["last_decision", "trit_shadow", "belief", "trit"],
        )
        .unwrap_or(&Value::Null),
    );
    let trit = if trit_from_regime != 0 {
        trit_from_regime
    } else {
        trit_from_drift
    };
    let trit_label = if trit > 0 {
        "ok"
    } else if trit < 0 {
        "pain"
    } else {
        "unknown"
    };
    let regime_name = clean_text_runtime(
        &value_to_string(value_path(Some(&regime), &["selected_regime"])),
        64,
    )
    .to_lowercase();
    let constrained_re = Regex::new("(constrained|emergency|defensive|degraded|critical)").unwrap();
    let mirror_reasons = value_path(Some(&mirror), &["reasons"])
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|x| clean_text_runtime(&value_to_string(Some(x)), 120))
        .filter(|x| !x.is_empty())
        .take(8)
        .collect::<Vec<_>>();
    let rel = |p: &str| -> Option<String> {
        if p.is_empty() {
            return None;
        }
        if root.is_empty() {
            return Some(p.to_string());
        }
        let v = rel_path_runtime(&root, p);
        if v.is_empty() || v.starts_with("..") {
            Some(p.to_string())
        } else {
            Some(v)
        }
    };

    LoadImpossibilitySignalsOutput {
        signals: json!({
            "regime": {
                "path": rel(&regime_path),
                "selected_regime": if regime_name.is_empty() { "unknown".to_string() } else { regime_name.clone() },
                "confidence": clamp_number(js_number_for_extract(value_path(Some(&regime), &["candidate_confidence"])).unwrap_or(0.0), 0.0, 1.0),
                "constrained": constrained_re.is_match(&regime_name)
            },
            "mirror": {
                "path": rel(&mirror_path),
                "pressure_score": clamp_number(js_number_for_extract(value_path(Some(&mirror), &["pressure_score"])).unwrap_or(0.0), 0.0, 1.0),
                "confidence": clamp_number(js_number_for_extract(value_path(Some(&mirror), &["confidence"])).unwrap_or(0.0), 0.0, 1.0),
                "reasons": mirror_reasons
            },
            "simulation": {
                "path": rel(&simulation_path),
                "predicted_drift": clamp_number(js_number_for_extract(value_path(Some(&simulation), &["checks_effective", "drift_rate", "value"])).unwrap_or(0.0), 0.0, 1.0),
                "predicted_yield": clamp_number(js_number_for_extract(value_path(Some(&simulation), &["checks_effective", "yield_rate", "value"])).unwrap_or(0.0), 0.0, 1.0)
            },
            "red_team": {
                "path": rel(&red_team_path),
                "critical_fail_cases": clamp_int_value(value_path(Some(&red_team), &["summary", "critical_fail_cases"]), 0, 100000, 0),
                "pass_cases": clamp_int_value(value_path(Some(&red_team), &["summary", "pass_cases"]), 0, 100000, 0),
                "fail_cases": clamp_int_value(value_path(Some(&red_team), &["summary", "fail_cases"]), 0, 100000, 0)
            },
            "trit": {
                "value": trit,
                "label": trit_label
            }
        }),
    }
}

pub fn compute_evaluate_impossibility_trigger(
    input: &EvaluateImpossibilityTriggerInput,
) -> EvaluateImpossibilityTriggerOutput {
    let policy = input.policy.clone().unwrap_or_else(|| json!({}));
    let signals = input
        .signals
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let cfg = value_path(Some(&policy), &["organ", "trigger_detection"])
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let force = input.force.unwrap_or(false);
    let threshold = clamp_number(
        js_number_for_extract(cfg.get("min_impossibility_score")).unwrap_or(0.58),
        0.0,
        1.0,
    );
    let min_signal_count = clamp_int_value(cfg.get("min_signal_count"), 1, 12, 2);
    let enabled = to_bool_like(cfg.get("enabled"), false);
    if !enabled && !force {
        return EvaluateImpossibilityTriggerOutput {
            triggered: false,
            forced: false,
            enabled: false,
            score: 0.0,
            threshold: (threshold * 1_000_000.0).round() / 1_000_000.0,
            signal_count: 0,
            min_signal_count,
            reasons: vec!["trigger_detection_disabled".to_string()],
            components: json!({}),
        };
    }
    let weights = cfg
        .get("weights")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let thresholds = cfg
        .get("thresholds")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let trit = normalize_trit_value(
        value_path(Some(&Value::Object(signals.clone())), &["trit", "value"]).unwrap_or(&Value::Null),
    );
    let trit_pain_signal = if trit < 0 {
        1.0
    } else if trit == 0 {
        0.5
    } else {
        0.0
    };
    let mirror_pressure = clamp_number(
        js_number_for_extract(value_path(Some(&Value::Object(signals.clone())), &["mirror", "pressure_score"])).unwrap_or(0.0),
        0.0,
        1.0,
    );
    let predicted_drift = clamp_number(
        js_number_for_extract(value_path(Some(&Value::Object(signals.clone())), &["simulation", "predicted_drift"])).unwrap_or(0.0),
        0.0,
        1.0,
    );
    let predicted_yield = clamp_number(
        js_number_for_extract(value_path(Some(&Value::Object(signals.clone())), &["simulation", "predicted_yield"])).unwrap_or(0.0),
        0.0,
        1.0,
    );
    let drift_warn = clamp_number(
        js_number_for_extract(thresholds.get("predicted_drift_warn")).unwrap_or(0.03),
        0.0,
        1.0,
    );
    let yield_warn = clamp_number(
        js_number_for_extract(thresholds.get("predicted_yield_warn")).unwrap_or(0.68),
        0.0,
        1.0,
    );
    let drift_score = if predicted_drift <= drift_warn {
        0.0
    } else {
        clamp_number((predicted_drift - drift_warn) / (1.0 - drift_warn).max(0.0001), 0.0, 1.0)
    };
    let yield_gap_score = if predicted_yield >= yield_warn {
        0.0
    } else {
        clamp_number((yield_warn - predicted_yield) / yield_warn.max(0.0001), 0.0, 1.0)
    };
    let red_team_critical = if clamp_int_value(
        value_path(Some(&Value::Object(signals.clone())), &["red_team", "critical_fail_cases"]),
        0,
        100000,
        0,
    ) > 0
    {
        1.0
    } else {
        0.0
    };
    let regime_constrained = if to_bool_like(
        value_path(Some(&Value::Object(signals.clone())), &["regime", "constrained"]),
        false,
    ) {
        1.0
    } else {
        0.0
    };
    let w_trit = js_number_for_extract(weights.get("trit_pain")).unwrap_or(0.2);
    let w_mirror = js_number_for_extract(weights.get("mirror_pressure")).unwrap_or(0.2);
    let w_drift = js_number_for_extract(weights.get("predicted_drift")).unwrap_or(0.18);
    let w_yield = js_number_for_extract(weights.get("predicted_yield_gap")).unwrap_or(0.18);
    let w_red = js_number_for_extract(weights.get("red_team_critical")).unwrap_or(0.14);
    let w_regime = js_number_for_extract(weights.get("regime_constrained")).unwrap_or(0.1);
    let weight_total = (w_trit + w_mirror + w_drift + w_yield + w_red + w_regime).max(0.0001);
    let score = clamp_number(
        ((trit_pain_signal * w_trit)
            + (mirror_pressure * w_mirror)
            + (drift_score * w_drift)
            + (yield_gap_score * w_yield)
            + (red_team_critical * w_red)
            + (regime_constrained * w_regime))
            / weight_total,
        0.0,
        1.0,
    );
    let signal_count = [trit_pain_signal, mirror_pressure, drift_score, yield_gap_score, red_team_critical, regime_constrained]
        .iter()
        .map(|v| if *v > 0.0 { 1 } else { 0 })
        .sum::<i32>() as i64;
    let mut reasons = Vec::new();
    if force {
        reasons.push("forced".to_string());
    }
    if trit_pain_signal > 0.0 {
        reasons.push("trit_pain_or_uncertain".to_string());
    }
    if mirror_pressure > 0.0 {
        reasons.push("mirror_pressure_signal".to_string());
    }
    if drift_score > 0.0 {
        reasons.push("predicted_drift_above_warn".to_string());
    }
    if yield_gap_score > 0.0 {
        reasons.push("predicted_yield_below_warn".to_string());
    }
    if red_team_critical > 0.0 {
        reasons.push("red_team_critical_present".to_string());
    }
    if regime_constrained > 0.0 {
        reasons.push("regime_constrained".to_string());
    }
    let triggered = force || (score >= threshold && signal_count >= min_signal_count);
    EvaluateImpossibilityTriggerOutput {
        triggered,
        forced: force,
        enabled,
        score: (score * 1_000_000.0).round() / 1_000_000.0,
        threshold: (threshold * 1_000_000.0).round() / 1_000_000.0,
        signal_count,
        min_signal_count,
        reasons: reasons.into_iter().take(12).collect::<Vec<_>>(),
        components: json!({
            "trit_pain": (trit_pain_signal * 1_000_000.0).round() / 1_000_000.0,
            "mirror_pressure": (mirror_pressure * 1_000_000.0).round() / 1_000_000.0,
            "predicted_drift": (drift_score * 1_000_000.0).round() / 1_000_000.0,
            "predicted_yield_gap": (yield_gap_score * 1_000_000.0).round() / 1_000_000.0,
            "red_team_critical": red_team_critical,
            "regime_constrained": regime_constrained
        }),
    }
}

pub fn compute_extract_first_principle(input: &ExtractFirstPrincipleInput) -> ExtractFirstPrincipleOutput {
    let policy = input.policy.as_ref();
    if value_path(policy, &["first_principles", "enabled"])
        .map(|v| !to_bool_like(Some(v), false))
        .unwrap_or(false)
    {
        return ExtractFirstPrincipleOutput { principle: None };
    }
    if clean_text_runtime(input.result.as_deref().unwrap_or(""), 24) != "success" {
        return ExtractFirstPrincipleOutput { principle: None };
    }
    let session = input
        .session
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let args = input
        .args
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let principle_text = clean_text_runtime(
        &value_to_string(args.get("principle").or_else(|| args.get("first-principle"))),
        360,
    );
    let auto_extract = to_bool_like(
        value_path(policy, &["first_principles", "auto_extract_on_success"]),
        false,
    );
    let text = if !principle_text.is_empty() {
        principle_text
    } else if auto_extract {
        let objective = clean_text_runtime(&value_to_string(session.get("objective")), 180);
        let filters = compute_normalize_list(&NormalizeListInput {
            value: Some(
                session
                    .get("filter_stack")
                    .cloned()
                    .unwrap_or(Value::Array(vec![])),
            ),
            max_len: Some(120),
        })
        .items
        .join(", ");
        let target = compute_normalize_target(&NormalizeTargetInput {
            value: Some(value_to_string(session.get("target"))),
        })
        .value;
        clean_text_runtime(
            &format!(
                "For {}, use inversion filters ({}) with a guarded {} lane, then revert to baseline paradigm.",
                if objective.is_empty() {
                    "objective".to_string()
                } else {
                    objective
                },
                if filters.is_empty() {
                    "none".to_string()
                } else {
                    filters
                },
                target
            ),
            360,
        )
    } else {
        String::new()
    };
    if text.is_empty() {
        return ExtractFirstPrincipleOutput { principle: None };
    }
    let certainty = clamp_number(js_number_for_extract(session.get("certainty")).unwrap_or(0.0), 0.0, 1.0);
    let confidence = clamp_number(
        (certainty * 0.7)
            + if value_to_string(session.get("fallback_entry_id")).is_empty() {
                0.05
            } else {
                0.15
            },
        0.0,
        1.0,
    );
    let max_bonus = js_number_for_extract(value_path(policy, &["first_principles", "max_strategy_bonus"]))
        .unwrap_or(0.12);
    let now_iso = input.now_iso.clone().unwrap_or_else(now_iso_runtime);
    let id_seed = format!("{}|{}", value_to_string(session.get("session_id")), text);
    let objective_id_value = {
        let v = clean_text_runtime(&value_to_string(session.get("objective_id")), 140);
        if v.is_empty() {
            Value::Null
        } else {
            Value::String(v)
        }
    };
    let suggested_bonus = {
        let bonus = clamp_number(confidence * max_bonus, 0.0, max_bonus.max(0.0));
        (bonus * 1_000_000.0).round() / 1_000_000.0
    };
    let principle = json!({
        "id": stable_id_runtime(&id_seed, "ifp"),
        "ts": now_iso.clone(),
        "source": "inversion_controller",
        "objective": clean_text_runtime(&value_to_string(session.get("objective")), 240),
        "objective_id": objective_id_value,
        "statement": text,
        "target": compute_normalize_target(&NormalizeTargetInput { value: Some(value_to_string(session.get("target"))) }).value,
        "confidence": (confidence * 1_000_000.0).round() / 1_000_000.0,
        "strategy_feedback": {
            "enabled": true,
            "suggested_bonus": suggested_bonus
        },
        "session_id": clean_text_runtime(&value_to_string(session.get("session_id")), 80)
    });
    ExtractFirstPrincipleOutput {
        principle: Some(principle),
    }
}

pub fn compute_extract_failure_cluster_principle(
    input: &ExtractFailureClusterPrincipleInput,
) -> ExtractFailureClusterPrincipleOutput {
    let policy = input.policy.clone().unwrap_or_else(|| json!({}));
    if !to_bool_like(value_path(Some(&policy), &["first_principles", "enabled"]), false) {
        return ExtractFailureClusterPrincipleOutput { principle: None };
    }
    if !to_bool_like(
        value_path(Some(&policy), &["first_principles", "allow_failure_cluster_extraction"]),
        false,
    ) {
        return ExtractFailureClusterPrincipleOutput { principle: None };
    }
    let session = input
        .session
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let signature_tokens = {
        let from_session = session
            .get("signature_tokens")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|v| value_to_string(Some(v)))
            .collect::<Vec<_>>();
        if from_session.is_empty() {
            compute_tokenize_text(&TokenizeTextInput {
                value: Some({
                    let sig = value_to_string(session.get("signature"));
                    if sig.is_empty() {
                        value_to_string(session.get("objective"))
                    } else {
                        sig
                    }
                }),
                max_tokens: Some(64),
            })
            .tokens
        } else {
            from_session
        }
    };
    let query = json!({
        "signature_tokens": signature_tokens,
        "trit_vector": [-1],
        "target": compute_normalize_target(&NormalizeTargetInput {
            value: Some(value_to_string(session.get("target")))
        }).value
    });
    let candidates = compute_select_library_candidates(&SelectLibraryCandidatesInput {
        file_path: input
            .paths
            .as_ref()
            .and_then(|v| v.as_object())
            .and_then(|m| m.get("library_path"))
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        policy: Some(policy.clone()),
        query: Some(query),
    })
    .candidates
    .into_iter()
    .filter(|entry| {
        normalize_trit_value(
            value_path(Some(entry), &["row", "outcome_trit"]).unwrap_or(&Value::Null),
        ) < 0
    })
    .collect::<Vec<_>>();
    let cluster_min = js_number_for_extract(value_path(Some(&policy), &["first_principles", "failure_cluster_min"]))
        .unwrap_or(4.0) as usize;
    if candidates.len() < cluster_min {
        return ExtractFailureClusterPrincipleOutput { principle: None };
    }
    let avg_similarity = {
        let total = candidates
            .iter()
            .map(|row| {
                js_number_for_extract(value_path(Some(row), &["similarity"])).unwrap_or(0.0)
            })
            .sum::<f64>();
        total / (candidates.len() as f64).max(1.0)
    };
    let confidence = clamp_number(
        (((candidates.len() as f64) / ((cluster_min + 3) as f64)).min(1.0) * 0.6)
            + (avg_similarity * 0.4),
        0.0,
        1.0,
    );
    let now_iso = input.now_iso.clone().unwrap_or_else(now_iso_runtime);
    let signature_or_objective = {
        let sig = value_to_string(session.get("signature"));
        if sig.is_empty() {
            value_to_string(session.get("objective"))
        } else {
            sig
        }
    };
    let id_seed = format!(
        "{}|failure_cluster|{}",
        value_to_string(session.get("session_id")),
        signature_or_objective
    );
    let objective = clean_text_runtime(&value_to_string(session.get("objective")), 240);
    let filter_stack = compute_normalize_list(&NormalizeListInput {
        value: Some(
            session
                .get("filter_stack")
                .cloned()
                .unwrap_or(Value::Array(vec![])),
        ),
        max_len: Some(120),
    })
    .items
    .join(", ");
    let objective_id_value = {
        let v = clean_text_runtime(&value_to_string(session.get("objective_id")), 140);
        if v.is_empty() {
            Value::Null
        } else {
            Value::String(v)
        }
    };
    let objective_for_statement = objective.clone();
    let statement = clean_text_runtime(
        &format!(
            "Avoid repeating inversion filter stack ({}) for objective \"{}\" without introducing a materially different paradigm shift.",
            if filter_stack.is_empty() { "none".to_string() } else { filter_stack },
            if objective_for_statement.is_empty() { "unknown".to_string() } else { objective_for_statement }
        ),
        360
    );
    let principle = json!({
        "id": stable_id_runtime(&id_seed, "ifp"),
        "ts": now_iso,
        "source": "inversion_controller_failure_cluster",
        "objective": objective,
        "objective_id": objective_id_value,
        "statement": statement,
        "target": compute_normalize_target(&NormalizeTargetInput {
            value: Some(value_to_string(session.get("target")))
        }).value,
        "confidence": (confidence * 1_000_000.0).round() / 1_000_000.0,
        "polarity": -1,
        "failure_cluster_count": candidates.len(),
        "strategy_feedback": {
            "enabled": true,
            "suggested_bonus": 0
        },
        "session_id": clean_text_runtime(&value_to_string(session.get("session_id")), 80)
    });
    ExtractFailureClusterPrincipleOutput {
        principle: Some(principle),
    }
}

pub fn compute_persist_first_principle(
    input: &PersistFirstPrincipleInput,
) -> PersistFirstPrincipleOutput {
    let paths = input
        .paths
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let principle = input.principle.clone().unwrap_or_else(|| json!({}));
    let _ = compute_write_json_atomic(&WriteJsonAtomicInput {
        file_path: paths
            .get("first_principles_latest_path")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        value: Some(principle.clone()),
    });
    let _ = compute_append_jsonl(&AppendJsonlInput {
        file_path: paths
            .get("first_principles_history_path")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        row: Some(principle.clone()),
    });
    let _ = compute_upsert_first_principle_lock(&UpsertFirstPrincipleLockInput {
        file_path: paths
            .get("first_principles_lock_path")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        session: input.session.clone(),
        principle: Some(principle.clone()),
        now_iso: input.now_iso.clone(),
    });
    PersistFirstPrincipleOutput { principle }
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
    if !input.enabled.unwrap_or(false) {
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
    let text = [
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
        .map(regex::escape)
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
    if mode == "parse_lane_decision" {
        let input: ParseLaneDecisionInput = decode_input(&payload, "parse_lane_decision_input")?;
        let out = compute_parse_lane_decision(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "parse_lane_decision",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_parse_lane_decision_failed:{e}"));
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
    if mode == "select_library_candidates" {
        let input: SelectLibraryCandidatesInput =
            decode_input(&payload, "select_library_candidates_input")?;
        let out = compute_select_library_candidates(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "select_library_candidates",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_select_library_candidates_failed:{e}"));
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
    if mode == "normalize_iso_events" {
        let input: NormalizeIsoEventsInput = decode_input(&payload, "normalize_iso_events_input")?;
        let out = compute_normalize_iso_events(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_iso_events",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_iso_events_failed:{e}"));
    }
    if mode == "expand_legacy_count_to_events" {
        let input: ExpandLegacyCountToEventsInput =
            decode_input(&payload, "expand_legacy_count_to_events_input")?;
        let out = compute_expand_legacy_count_to_events(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "expand_legacy_count_to_events",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_expand_legacy_count_to_events_failed:{e}"));
    }
    if mode == "normalize_tier_event_map" {
        let input: NormalizeTierEventMapInput =
            decode_input(&payload, "normalize_tier_event_map_input")?;
        let out = compute_normalize_tier_event_map(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_tier_event_map",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_tier_event_map_failed:{e}"));
    }
    if mode == "default_tier_scope" {
        let input: DefaultTierScopeInput = decode_input(&payload, "default_tier_scope_input")?;
        let out = compute_default_tier_scope(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "default_tier_scope",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_default_tier_scope_failed:{e}"));
    }
    if mode == "normalize_tier_scope" {
        let input: NormalizeTierScopeInput = decode_input(&payload, "normalize_tier_scope_input")?;
        let out = compute_normalize_tier_scope(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_tier_scope",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_tier_scope_failed:{e}"));
    }
    if mode == "default_tier_governance_state" {
        let input: DefaultTierGovernanceStateInput =
            decode_input(&payload, "default_tier_governance_state_input")?;
        let out = compute_default_tier_governance_state(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "default_tier_governance_state",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_default_tier_governance_state_failed:{e}"));
    }
    if mode == "clone_tier_scope" {
        let input: CloneTierScopeInput = decode_input(&payload, "clone_tier_scope_input")?;
        let out = compute_clone_tier_scope(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "clone_tier_scope",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_clone_tier_scope_failed:{e}"));
    }
    if mode == "prune_tier_scope_events" {
        let input: PruneTierScopeEventsInput =
            decode_input(&payload, "prune_tier_scope_events_input")?;
        let out = compute_prune_tier_scope_events(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "prune_tier_scope_events",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_prune_tier_scope_events_failed:{e}"));
    }
    if mode == "load_tier_governance_state" {
        let input: LoadTierGovernanceStateInput =
            decode_input(&payload, "load_tier_governance_state_input")?;
        let out = compute_load_tier_governance_state(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "load_tier_governance_state",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_load_tier_governance_state_failed:{e}"));
    }
    if mode == "save_tier_governance_state" {
        let input: SaveTierGovernanceStateInput =
            decode_input(&payload, "save_tier_governance_state_input")?;
        let out = compute_save_tier_governance_state(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "save_tier_governance_state",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_save_tier_governance_state_failed:{e}"));
    }
    if mode == "push_tier_event" {
        let input: PushTierEventInput = decode_input(&payload, "push_tier_event_input")?;
        let out = compute_push_tier_event(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "push_tier_event",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_push_tier_event_failed:{e}"));
    }
    if mode == "add_tier_event" {
        let input: AddTierEventInput = decode_input(&payload, "add_tier_event_input")?;
        let out = compute_add_tier_event(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "add_tier_event",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_add_tier_event_failed:{e}"));
    }
    if mode == "increment_live_apply_attempt" {
        let input: IncrementLiveApplyAttemptInput =
            decode_input(&payload, "increment_live_apply_attempt_input")?;
        let out = compute_increment_live_apply_attempt(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "increment_live_apply_attempt",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_increment_live_apply_attempt_failed:{e}"));
    }
    if mode == "increment_live_apply_success" {
        let input: IncrementLiveApplySuccessInput =
            decode_input(&payload, "increment_live_apply_success_input")?;
        let out = compute_increment_live_apply_success(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "increment_live_apply_success",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_increment_live_apply_success_failed:{e}"));
    }
    if mode == "increment_live_apply_safe_abort" {
        let input: IncrementLiveApplySafeAbortInput =
            decode_input(&payload, "increment_live_apply_safe_abort_input")?;
        let out = compute_increment_live_apply_safe_abort(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "increment_live_apply_safe_abort",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_increment_live_apply_safe_abort_failed:{e}"));
    }
    if mode == "update_shadow_trial_counters" {
        let input: UpdateShadowTrialCountersInput =
            decode_input(&payload, "update_shadow_trial_counters_input")?;
        let out = compute_update_shadow_trial_counters(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "update_shadow_trial_counters",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_update_shadow_trial_counters_failed:{e}"));
    }
    if mode == "count_tier_events" {
        let input: CountTierEventsInput = decode_input(&payload, "count_tier_events_input")?;
        let out = compute_count_tier_events(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "count_tier_events",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_count_tier_events_failed:{e}"));
    }
    if mode == "effective_window_days_for_target" {
        let input: EffectiveWindowDaysForTargetInput =
            decode_input(&payload, "effective_window_days_for_target_input")?;
        let out = compute_effective_window_days_for_target(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "effective_window_days_for_target",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_effective_window_days_for_target_failed:{e}"));
    }
    if mode == "to_date" {
        let input: ToDateInput = decode_input(&payload, "to_date_input")?;
        let out = compute_to_date(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "to_date",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_to_date_failed:{e}"));
    }
    if mode == "parse_ts_ms" {
        let input: ParseTsMsInput = decode_input(&payload, "parse_ts_ms_input")?;
        let out = compute_parse_ts_ms(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "parse_ts_ms",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_parse_ts_ms_failed:{e}"));
    }
    if mode == "add_minutes" {
        let input: AddMinutesInput = decode_input(&payload, "add_minutes_input")?;
        let out = compute_add_minutes(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "add_minutes",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_add_minutes_failed:{e}"));
    }
    if mode == "clamp_int" {
        let input: ClampIntInput = decode_input(&payload, "clamp_int_input")?;
        let out = compute_clamp_int(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "clamp_int",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_clamp_int_failed:{e}"));
    }
    if mode == "clamp_number" {
        let input: ClampNumberInput = decode_input(&payload, "clamp_number_input")?;
        let out = compute_clamp_number(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "clamp_number",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_clamp_number_failed:{e}"));
    }
    if mode == "to_bool" {
        let input: ToBoolInput = decode_input(&payload, "to_bool_input")?;
        let out = compute_to_bool(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "to_bool",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_to_bool_failed:{e}"));
    }
    if mode == "clean_text" {
        let input: CleanTextInput = decode_input(&payload, "clean_text_input")?;
        let out = compute_clean_text(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "clean_text",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_clean_text_failed:{e}"));
    }
    if mode == "normalize_token" {
        let input: NormalizeTokenInput = decode_input(&payload, "normalize_token_input")?;
        let out = compute_normalize_token(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_token",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_token_failed:{e}"));
    }
    if mode == "normalize_word_token" {
        let input: NormalizeWordTokenInput = decode_input(&payload, "normalize_word_token_input")?;
        let out = compute_normalize_word_token(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_word_token",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_word_token_failed:{e}"));
    }
    if mode == "band_to_index" {
        let input: BandToIndexInput = decode_input(&payload, "band_to_index_input")?;
        let out = compute_band_to_index(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "band_to_index",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_band_to_index_failed:{e}"));
    }
    if mode == "escape_regex" {
        let input: EscapeRegexInput = decode_input(&payload, "escape_regex_input")?;
        let out = compute_escape_regex(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "escape_regex",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_escape_regex_failed:{e}"));
    }
    if mode == "pattern_to_word_regex" {
        let input: PatternToWordRegexInput = decode_input(&payload, "pattern_to_word_regex_input")?;
        let out = compute_pattern_to_word_regex(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "pattern_to_word_regex",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_pattern_to_word_regex_failed:{e}"));
    }
    if mode == "stable_id" {
        let input: StableIdInput = decode_input(&payload, "stable_id_input")?;
        let out = compute_stable_id(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "stable_id",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_stable_id_failed:{e}"));
    }
    if mode == "rel_path" {
        let input: RelPathInput = decode_input(&payload, "rel_path_input")?;
        let out = compute_rel_path(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "rel_path",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_rel_path_failed:{e}"));
    }
    if mode == "normalize_axiom_pattern" {
        let input: NormalizeAxiomPatternInput = decode_input(&payload, "normalize_axiom_pattern_input")?;
        let out = compute_normalize_axiom_pattern(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_axiom_pattern",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_axiom_pattern_failed:{e}"));
    }
    if mode == "normalize_axiom_signal_terms" {
        let input: NormalizeAxiomSignalTermsInput = decode_input(&payload, "normalize_axiom_signal_terms_input")?;
        let out = compute_normalize_axiom_signal_terms(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_axiom_signal_terms",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_axiom_signal_terms_failed:{e}"));
    }
    if mode == "normalize_observer_id" {
        let input: NormalizeObserverIdInput = decode_input(&payload, "normalize_observer_id_input")?;
        let out = compute_normalize_observer_id(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_observer_id",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_observer_id_failed:{e}"));
    }
    if mode == "extract_numeric" {
        let input: ExtractNumericInput = decode_input(&payload, "extract_numeric_input")?;
        let out = compute_extract_numeric(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "extract_numeric",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_extract_numeric_failed:{e}"));
    }
    if mode == "pick_first_numeric" {
        let input: PickFirstNumericInput = decode_input(&payload, "pick_first_numeric_input")?;
        let out = compute_pick_first_numeric(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "pick_first_numeric",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_pick_first_numeric_failed:{e}"));
    }
    if mode == "safe_rel_path" {
        let input: SafeRelPathInput = decode_input(&payload, "safe_rel_path_input")?;
        let out = compute_safe_rel_path(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "safe_rel_path",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_safe_rel_path_failed:{e}"));
    }
    if mode == "now_iso" {
        let input: NowIsoInput = decode_input(&payload, "now_iso_input")?;
        let out = compute_now_iso(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "now_iso",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_now_iso_failed:{e}"));
    }
    if mode == "default_tier_event_map" {
        let input: DefaultTierEventMapInput = decode_input(&payload, "default_tier_event_map_input")?;
        let out = compute_default_tier_event_map(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "default_tier_event_map",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_default_tier_event_map_failed:{e}"));
    }
    if mode == "coerce_tier_event_map" {
        let input: CoerceTierEventMapInput = decode_input(&payload, "coerce_tier_event_map_input")?;
        let out = compute_coerce_tier_event_map(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "coerce_tier_event_map",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_coerce_tier_event_map_failed:{e}"));
    }
    if mode == "get_tier_scope" {
        let input: GetTierScopeInput = decode_input(&payload, "get_tier_scope_input")?;
        let out = compute_get_tier_scope(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "get_tier_scope",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_get_tier_scope_failed:{e}"));
    }
    if mode == "default_harness_state" {
        let input: DefaultHarnessStateInput = decode_input(&payload, "default_harness_state_input")?;
        let out = compute_default_harness_state(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "default_harness_state",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_default_harness_state_failed:{e}"));
    }
    if mode == "default_first_principle_lock_state" {
        let input: DefaultFirstPrincipleLockStateInput =
            decode_input(&payload, "default_first_principle_lock_state_input")?;
        let out = compute_default_first_principle_lock_state(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "default_first_principle_lock_state",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_default_first_principle_lock_state_failed:{e}"));
    }
    if mode == "default_maturity_state" {
        let input: DefaultMaturityStateInput = decode_input(&payload, "default_maturity_state_input")?;
        let out = compute_default_maturity_state(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "default_maturity_state",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_default_maturity_state_failed:{e}"));
    }
    if mode == "principle_key_for_session" {
        let input: PrincipleKeyForSessionInput = decode_input(&payload, "principle_key_for_session_input")?;
        let out = compute_principle_key_for_session(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "principle_key_for_session",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_principle_key_for_session_failed:{e}"));
    }
    if mode == "normalize_objective_arg" {
        let input: NormalizeObjectiveArgInput = decode_input(&payload, "normalize_objective_arg_input")?;
        let out = compute_normalize_objective_arg(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_objective_arg",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_objective_arg_failed:{e}"));
    }
    if mode == "maturity_band_order" {
        let input: MaturityBandOrderInput = decode_input(&payload, "maturity_band_order_input")?;
        let out = compute_maturity_band_order(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "maturity_band_order",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_maturity_band_order_failed:{e}"));
    }
    if mode == "current_runtime_mode" {
        let input: CurrentRuntimeModeInput = decode_input(&payload, "current_runtime_mode_input")?;
        let out = compute_current_runtime_mode(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "current_runtime_mode",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_current_runtime_mode_failed:{e}"));
    }
    if mode == "read_drift_from_state_file" {
        let input: ReadDriftFromStateFileInput =
            decode_input(&payload, "read_drift_from_state_file_input")?;
        let out = compute_read_drift_from_state_file(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "read_drift_from_state_file",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_read_drift_from_state_file_failed:{e}"));
    }
    if mode == "resolve_lens_gate_drift" {
        let input: ResolveLensGateDriftInput =
            decode_input(&payload, "resolve_lens_gate_drift_input")?;
        let out = compute_resolve_lens_gate_drift(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "resolve_lens_gate_drift",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_resolve_lens_gate_drift_failed:{e}"));
    }
    if mode == "resolve_parity_confidence" {
        let input: ResolveParityConfidenceInput =
            decode_input(&payload, "resolve_parity_confidence_input")?;
        let out = compute_resolve_parity_confidence(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "resolve_parity_confidence",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_resolve_parity_confidence_failed:{e}"));
    }
    if mode == "compute_attractor_score" {
        let input: ComputeAttractorScoreInput =
            decode_input(&payload, "compute_attractor_score_input")?;
        let out = compute_attractor_score(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "compute_attractor_score",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_compute_attractor_score_failed:{e}"));
    }
    if mode == "detect_immutable_axiom_violation" {
        let input: DetectImmutableAxiomViolationInput =
            decode_input(&payload, "detect_immutable_axiom_violation_input")?;
        let out = compute_detect_immutable_axiom_violation(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "detect_immutable_axiom_violation",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_detect_immutable_axiom_violation_failed:{e}"));
    }
    if mode == "compute_maturity_score" {
        let input: ComputeMaturityScoreInput =
            decode_input(&payload, "compute_maturity_score_input")?;
        let out = compute_maturity_score(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "compute_maturity_score",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_compute_maturity_score_failed:{e}"));
    }
    if mode == "build_output_interfaces" {
        let input: BuildOutputInterfacesInput =
            decode_input(&payload, "build_output_interfaces_input")?;
        let out = compute_build_output_interfaces(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "build_output_interfaces",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_build_output_interfaces_failed:{e}"));
    }
    if mode == "build_code_change_proposal_draft" {
        let input: BuildCodeChangeProposalDraftInput =
            decode_input(&payload, "build_code_change_proposal_draft_input")?;
        let out = compute_build_code_change_proposal_draft(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "build_code_change_proposal_draft",
            "payload": out.proposal
        }))
        .map_err(|e| format!("inversion_encode_build_code_change_proposal_draft_failed:{e}"));
    }
    if mode == "normalize_library_row" {
        let input: NormalizeLibraryRowInput =
            decode_input(&payload, "normalize_library_row_input")?;
        let out = compute_normalize_library_row(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_library_row",
            "payload": out.row
        }))
        .map_err(|e| format!("inversion_encode_normalize_library_row_failed:{e}"));
    }
    if mode == "ensure_dir" {
        let input: EnsureDirInput = decode_input(&payload, "ensure_dir_input")?;
        let out = compute_ensure_dir(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "ensure_dir",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_ensure_dir_failed:{e}"));
    }
    if mode == "read_json" {
        let input: ReadJsonInput = decode_input(&payload, "read_json_input")?;
        let out = compute_read_json(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "read_json",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_read_json_failed:{e}"));
    }
    if mode == "read_jsonl" {
        let input: ReadJsonlInput = decode_input(&payload, "read_jsonl_input")?;
        let out = compute_read_jsonl(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "read_jsonl",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_read_jsonl_failed:{e}"));
    }
    if mode == "write_json_atomic" {
        let input: WriteJsonAtomicInput = decode_input(&payload, "write_json_atomic_input")?;
        let out = compute_write_json_atomic(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "write_json_atomic",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_write_json_atomic_failed:{e}"));
    }
    if mode == "append_jsonl" {
        let input: AppendJsonlInput = decode_input(&payload, "append_jsonl_input")?;
        let out = compute_append_jsonl(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "append_jsonl",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_append_jsonl_failed:{e}"));
    }
    if mode == "read_text" {
        let input: ReadTextInput = decode_input(&payload, "read_text_input")?;
        let out = compute_read_text(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "read_text",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_read_text_failed:{e}"));
    }
    if mode == "latest_json_file_in_dir" {
        let input: LatestJsonFileInDirInput =
            decode_input(&payload, "latest_json_file_in_dir_input")?;
        let out = compute_latest_json_file_in_dir(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "latest_json_file_in_dir",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_latest_json_file_in_dir_failed:{e}"));
    }
    if mode == "normalize_output_channel" {
        let input: NormalizeOutputChannelInput =
            decode_input(&payload, "normalize_output_channel_input")?;
        let out = compute_normalize_output_channel(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_output_channel",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_output_channel_failed:{e}"));
    }
    if mode == "normalize_repo_path" {
        let input: NormalizeRepoPathInput = decode_input(&payload, "normalize_repo_path_input")?;
        let out = compute_normalize_repo_path(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_repo_path",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_repo_path_failed:{e}"));
    }
    if mode == "runtime_paths" {
        let input: RuntimePathsInput = decode_input(&payload, "runtime_paths_input")?;
        let out = compute_runtime_paths(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "runtime_paths",
            "payload": out.paths
        }))
        .map_err(|e| format!("inversion_encode_runtime_paths_failed:{e}"));
    }
    if mode == "normalize_axiom_list" {
        let input: NormalizeAxiomListInput = decode_input(&payload, "normalize_axiom_list_input")?;
        let out = compute_normalize_axiom_list(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_axiom_list",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_axiom_list_failed:{e}"));
    }
    if mode == "normalize_harness_suite" {
        let input: NormalizeHarnessSuiteInput = decode_input(&payload, "normalize_harness_suite_input")?;
        let out = compute_normalize_harness_suite(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "normalize_harness_suite",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_normalize_harness_suite_failed:{e}"));
    }
    if mode == "load_harness_state" {
        let input: LoadHarnessStateInput = decode_input(&payload, "load_harness_state_input")?;
        let out = compute_load_harness_state(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "load_harness_state",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_load_harness_state_failed:{e}"));
    }
    if mode == "save_harness_state" {
        let input: SaveHarnessStateInput = decode_input(&payload, "save_harness_state_input")?;
        let out = compute_save_harness_state(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "save_harness_state",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_save_harness_state_failed:{e}"));
    }
    if mode == "load_first_principle_lock_state" {
        let input: LoadFirstPrincipleLockStateInput =
            decode_input(&payload, "load_first_principle_lock_state_input")?;
        let out = compute_load_first_principle_lock_state(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "load_first_principle_lock_state",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_load_first_principle_lock_state_failed:{e}"));
    }
    if mode == "save_first_principle_lock_state" {
        let input: SaveFirstPrincipleLockStateInput =
            decode_input(&payload, "save_first_principle_lock_state_input")?;
        let out = compute_save_first_principle_lock_state(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "save_first_principle_lock_state",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_save_first_principle_lock_state_failed:{e}"));
    }
    if mode == "check_first_principle_downgrade" {
        let input: CheckFirstPrincipleDowngradeInput =
            decode_input(&payload, "check_first_principle_downgrade_input")?;
        let out = compute_check_first_principle_downgrade(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "check_first_principle_downgrade",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_check_first_principle_downgrade_failed:{e}"));
    }
    if mode == "upsert_first_principle_lock" {
        let input: UpsertFirstPrincipleLockInput =
            decode_input(&payload, "upsert_first_principle_lock_input")?;
        let out = compute_upsert_first_principle_lock(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "upsert_first_principle_lock",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_upsert_first_principle_lock_failed:{e}"));
    }
    if mode == "load_observer_approvals" {
        let input: LoadObserverApprovalsInput =
            decode_input(&payload, "load_observer_approvals_input")?;
        let out = compute_load_observer_approvals(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "load_observer_approvals",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_load_observer_approvals_failed:{e}"));
    }
    if mode == "append_observer_approval" {
        let input: AppendObserverApprovalInput =
            decode_input(&payload, "append_observer_approval_input")?;
        let out = compute_append_observer_approval(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "append_observer_approval",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_append_observer_approval_failed:{e}"));
    }
    if mode == "count_observer_approvals" {
        let input: CountObserverApprovalsInput =
            decode_input(&payload, "count_observer_approvals_input")?;
        let out = compute_count_observer_approvals(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "count_observer_approvals",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_count_observer_approvals_failed:{e}"));
    }
    if mode == "ensure_correspondence_file" {
        let input: EnsureCorrespondenceFileInput =
            decode_input(&payload, "ensure_correspondence_file_input")?;
        let out = compute_ensure_correspondence_file(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "ensure_correspondence_file",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_ensure_correspondence_file_failed:{e}"));
    }
    if mode == "load_maturity_state" {
        let input: LoadMaturityStateInput = decode_input(&payload, "load_maturity_state_input")?;
        let out = compute_load_maturity_state(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "load_maturity_state",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_load_maturity_state_failed:{e}"));
    }
    if mode == "save_maturity_state" {
        let input: SaveMaturityStateInput = decode_input(&payload, "save_maturity_state_input")?;
        let out = compute_save_maturity_state(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "save_maturity_state",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_save_maturity_state_failed:{e}"));
    }
    if mode == "load_active_sessions" {
        let input: LoadActiveSessionsInput = decode_input(&payload, "load_active_sessions_input")?;
        let out = compute_load_active_sessions(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "load_active_sessions",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_load_active_sessions_failed:{e}"));
    }
    if mode == "save_active_sessions" {
        let input: SaveActiveSessionsInput = decode_input(&payload, "save_active_sessions_input")?;
        let out = compute_save_active_sessions(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "save_active_sessions",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_save_active_sessions_failed:{e}"));
    }
    if mode == "sweep_expired_sessions" {
        let input: SweepExpiredSessionsInput =
            decode_input(&payload, "sweep_expired_sessions_input")?;
        let out = compute_sweep_expired_sessions(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "sweep_expired_sessions",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_sweep_expired_sessions_failed:{e}"));
    }
    if mode == "emit_event" {
        let input: EmitEventInput = decode_input(&payload, "emit_event_input")?;
        let out = compute_emit_event(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "emit_event",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_emit_event_failed:{e}"));
    }
    if mode == "append_persona_lens_gate_receipt" {
        let input: AppendPersonaLensGateReceiptInput =
            decode_input(&payload, "append_persona_lens_gate_receipt_input")?;
        let out = compute_append_persona_lens_gate_receipt(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "append_persona_lens_gate_receipt",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_append_persona_lens_gate_receipt_failed:{e}"));
    }
    if mode == "append_conclave_correspondence" {
        let input: AppendConclaveCorrespondenceInput =
            decode_input(&payload, "append_conclave_correspondence_input")?;
        let out = compute_append_conclave_correspondence(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "append_conclave_correspondence",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_append_conclave_correspondence_failed:{e}"));
    }
    if mode == "persist_decision" {
        let input: PersistDecisionInput = decode_input(&payload, "persist_decision_input")?;
        let out = compute_persist_decision(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "persist_decision",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_persist_decision_failed:{e}"));
    }
    if mode == "persist_interface_envelope" {
        let input: PersistInterfaceEnvelopeInput =
            decode_input(&payload, "persist_interface_envelope_input")?;
        let out = compute_persist_interface_envelope(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "persist_interface_envelope",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_persist_interface_envelope_failed:{e}"));
    }
    if mode == "trim_library" {
        let input: TrimLibraryInput = decode_input(&payload, "trim_library_input")?;
        let out = compute_trim_library(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "trim_library",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_trim_library_failed:{e}"));
    }
    if mode == "load_impossibility_signals" {
        let input: LoadImpossibilitySignalsInput =
            decode_input(&payload, "load_impossibility_signals_input")?;
        let out = compute_load_impossibility_signals(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "load_impossibility_signals",
            "payload": out.signals
        }))
        .map_err(|e| format!("inversion_encode_load_impossibility_signals_failed:{e}"));
    }
    if mode == "evaluate_impossibility_trigger" {
        let input: EvaluateImpossibilityTriggerInput =
            decode_input(&payload, "evaluate_impossibility_trigger_input")?;
        let out = compute_evaluate_impossibility_trigger(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "evaluate_impossibility_trigger",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_evaluate_impossibility_trigger_failed:{e}"));
    }
    if mode == "extract_first_principle" {
        let input: ExtractFirstPrincipleInput =
            decode_input(&payload, "extract_first_principle_input")?;
        let out = compute_extract_first_principle(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "extract_first_principle",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_extract_first_principle_failed:{e}"));
    }
    if mode == "extract_failure_cluster_principle" {
        let input: ExtractFailureClusterPrincipleInput =
            decode_input(&payload, "extract_failure_cluster_principle_input")?;
        let out = compute_extract_failure_cluster_principle(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "extract_failure_cluster_principle",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_extract_failure_cluster_principle_failed:{e}"));
    }
    if mode == "persist_first_principle" {
        let input: PersistFirstPrincipleInput =
            decode_input(&payload, "persist_first_principle_input")?;
        let out = compute_persist_first_principle(&input);
        return serde_json::to_string(&json!({
            "ok": true,
            "mode": "persist_first_principle",
            "payload": out
        }))
        .map_err(|e| format!("inversion_encode_persist_first_principle_failed:{e}"));
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
    fn inversion_json_get_tier_scope_routes_with_constitution_bucket() {
        let payload = json!({
            "mode": "get_tier_scope",
            "get_tier_scope_input": {
                "state": { "scopes": {} },
                "policy_version": "1.0"
            }
        });
        let out = run_inversion_json(&payload.to_string()).expect("inversion get_tier_scope");
        assert!(out.contains("\"mode\":\"get_tier_scope\""));
        assert!(out.contains("\"constitution\":[]"));
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

    #[test]
    fn tier_scope_helpers_match_contract() {
        let iso = compute_normalize_iso_events(&NormalizeIsoEventsInput {
            src: vec![
                json!("2026-03-04T00:00:00.000Z"),
                json!("bad"),
                json!("2026-03-03T00:00:00.000Z"),
            ],
            max_rows: Some(10000),
        });
        assert_eq!(iso.events.len(), 2);

        let legacy = compute_expand_legacy_count_to_events(&ExpandLegacyCountToEventsInput {
            count: Some(json!(3)),
            ts: Some("2026-03-04T00:00:00.000Z".to_string()),
        });
        assert_eq!(legacy.events.len(), 3);

        let map = compute_normalize_tier_event_map(&NormalizeTierEventMapInput {
            src: Some(json!({"tactical":["2026-03-01T00:00:00.000Z"]})),
            fallback: Some(default_tier_event_map_value()),
            legacy_counts: Some(json!({"belief": 2})),
            legacy_ts: Some("2026-03-04T00:00:00.000Z".to_string()),
        });
        assert!(map.map["tactical"].is_array());
        assert!(map.map["belief"].is_array());

        let scope = compute_default_tier_scope(&DefaultTierScopeInput {
            legacy: Some(json!({"live_apply_counts": {"tactical": 1}})),
            legacy_ts: Some("2026-03-04T00:00:00.000Z".to_string()),
        });
        assert!(scope.scope["live_apply_attempts"]["tactical"].is_array());

        let norm_scope = compute_normalize_tier_scope(&NormalizeTierScopeInput {
            scope: Some(json!({"shadow_passes": {"identity": ["2026-03-04T00:00:00.000Z"]}})),
            legacy: Some(json!({})),
            legacy_ts: Some("2026-03-04T00:00:00.000Z".to_string()),
        });
        assert!(norm_scope.scope["shadow_passes"]["identity"].is_array());

        let state = compute_default_tier_governance_state(&DefaultTierGovernanceStateInput {
            policy_version: Some("1.2".to_string()),
        });
        assert_eq!(
            state.state["schema_id"],
            json!("inversion_tier_governance_state")
        );

        let cloned = compute_clone_tier_scope(&CloneTierScopeInput {
            scope: Some(norm_scope.scope.clone()),
        });
        assert!(cloned.scope["shadow_passes"]["identity"].is_array());

        let pruned = compute_prune_tier_scope_events(&PruneTierScopeEventsInput {
            scope: Some(json!({
                "live_apply_attempts": {"tactical":["2000-01-01T00:00:00.000Z","2026-03-04T00:00:00.000Z"]},
                "live_apply_successes": default_tier_event_map_value(),
                "live_apply_safe_aborts": default_tier_event_map_value(),
                "shadow_passes": default_tier_event_map_value(),
                "shadow_critical_failures": default_tier_event_map_value()
            })),
            retention_days: Some(365),
        });
        assert!(pruned.scope["live_apply_attempts"]["tactical"].is_array());

        let count = compute_count_tier_events(&CountTierEventsInput {
            scope: Some(pruned.scope.clone()),
            metric: Some("live_apply_attempts".to_string()),
            target: Some("tactical".to_string()),
            window_days: Some(3650),
        });
        assert!(count.count >= 0);

        let effective =
            compute_effective_window_days_for_target(&EffectiveWindowDaysForTargetInput {
                window_map: Some(json!({"identity": 30})),
                minimum_window_map: Some(json!({"identity": 45})),
                target: Some("identity".to_string()),
                fallback: Some(90),
            });
        assert_eq!(effective.days, 45);
    }

    #[test]
    fn foundational_scalar_helpers_match_contract() {
        let date = compute_to_date(&ToDateInput {
            value: Some("2026-03-04".to_string()),
        });
        assert_eq!(date.value, "2026-03-04".to_string());

        let ts = compute_parse_ts_ms(&ParseTsMsInput {
            value: Some("2026-03-04T00:00:00.000Z".to_string()),
        });
        assert!(ts.ts_ms > 0);

        let plus = compute_add_minutes(&AddMinutesInput {
            iso_ts: Some("2026-03-04T00:00:00.000Z".to_string()),
            minutes: Some(15.0),
        });
        assert!(plus
            .iso_ts
            .as_deref()
            .unwrap_or("")
            .contains("2026-03-04T00:15:00"));

        let ci = compute_clamp_int(&ClampIntInput {
            value: Some(json!(12)),
            lo: Some(0),
            hi: Some(10),
            fallback: Some(3),
        });
        assert_eq!(ci.value, 10);

        let cn = compute_clamp_number(&ClampNumberInput {
            value: Some(json!(1.7)),
            lo: Some(0.0),
            hi: Some(1.0),
            fallback: Some(0.5),
        });
        assert!((cn.value - 1.0).abs() < 1e-9);

        let b = compute_to_bool(&ToBoolInput {
            value: Some(json!("yes")),
            fallback: Some(false),
        });
        assert!(b.value);

        let clean = compute_clean_text(&CleanTextInput {
            value: Some("  a   b  ".to_string()),
            max_len: Some(16),
        });
        assert_eq!(clean.value, "a b".to_string());

        let token = compute_normalize_token(&NormalizeTokenInput {
            value: Some("A B+C".to_string()),
            max_len: Some(80),
        });
        assert_eq!(token.value, "a_b_c".to_string());

        let word = compute_normalize_word_token(&NormalizeWordTokenInput {
            value: Some("A B+C".to_string()),
            max_len: Some(80),
        });
        assert_eq!(word.value, "a_b_c".to_string());

        let band = compute_band_to_index(&BandToIndexInput {
            band: Some("seasoned".to_string()),
        });
        assert_eq!(band.index, 3);
    }

    #[test]
    fn helper_primitives_batch6_match_contract() {
        let escaped = compute_escape_regex(&EscapeRegexInput {
            value: Some("a+b?c".to_string()),
        });
        assert_eq!(escaped.value, "a\\+b\\?c".to_string());

        let pattern = compute_pattern_to_word_regex(&PatternToWordRegexInput {
            pattern: Some("risk guard".to_string()),
            max_len: Some(200),
        });
        assert_eq!(pattern.source, Some("\\brisk\\s+guard\\b".to_string()));

        let stable = compute_stable_id(&StableIdInput {
            seed: Some("seed".to_string()),
            prefix: Some("inv".to_string()),
        });
        assert!(stable.id.starts_with("inv_"));

        let rel = compute_rel_path(&RelPathInput {
            root: Some("/tmp/root".to_string()),
            file_path: Some("/tmp/root/state/a.json".to_string()),
        });
        assert_eq!(rel.value, "state/a.json".to_string());

        let axiom = compute_normalize_axiom_pattern(&NormalizeAxiomPatternInput {
            value: Some("  Risk   Guard  ".to_string()),
        });
        assert_eq!(axiom.value, "risk guard".to_string());

        let terms = compute_normalize_axiom_signal_terms(&NormalizeAxiomSignalTermsInput {
            terms: vec![json!(" Risk "), json!("Guard"), json!("")],
        });
        assert_eq!(terms.terms, vec!["risk".to_string(), "guard".to_string()]);

        let observer = compute_normalize_observer_id(&NormalizeObserverIdInput {
            value: Some("Observer 01".to_string()),
        });
        assert_eq!(observer.value, "observer_01".to_string());

        let num = compute_extract_numeric(&ExtractNumericInput {
            value: json!("2.5"),
        });
        assert_eq!(num.value, Some(2.5));

        let first = compute_pick_first_numeric(&PickFirstNumericInput {
            candidates: vec![json!(""), json!("x"), json!(7.0)],
        });
        assert_eq!(first.value, Some(0.0));

        let safe = compute_safe_rel_path(&SafeRelPathInput {
            root: Some("/tmp/root".to_string()),
            file_path: Some("/tmp/other/a.json".to_string()),
        });
        assert_eq!(safe.value, "/tmp/other/a.json".to_string());
    }

    #[test]
    fn helper_primitives_batch7_match_contract() {
        let now = compute_now_iso(&NowIsoInput::default());
        assert!(now.value.contains('T'));

        let default_map = compute_default_tier_event_map(&DefaultTierEventMapInput::default());
        assert!(default_map.map["tactical"].is_array());

        let coerced = compute_coerce_tier_event_map(&CoerceTierEventMapInput {
            map: Some(json!({"tactical":[1, "x"], "belief":["y"]})),
        });
        assert_eq!(coerced.map["tactical"][0], json!("1"));

        let got = compute_get_tier_scope(&GetTierScopeInput {
            state: Some(json!({"scopes": {}})),
            policy_version: Some("2.0".to_string()),
        });
        assert!(got.state["scopes"]["2.0"].is_object());
        assert!(got.scope.is_object());
        for metric in [
            "live_apply_attempts",
            "live_apply_successes",
            "live_apply_safe_aborts",
            "shadow_passes",
            "shadow_critical_failures",
        ] {
            assert!(
                got.scope
                    .get(metric)
                    .and_then(|v| v.get("constitution"))
                    .and_then(Value::as_array)
                    .is_some(),
                "missing constitution bucket for metric {metric}"
            );
        }

        let harness = compute_default_harness_state(&DefaultHarnessStateInput::default());
        assert_eq!(harness.state["schema_id"], json!("inversion_maturity_harness_state"));

        let lock = compute_default_first_principle_lock_state(
            &DefaultFirstPrincipleLockStateInput::default(),
        );
        assert_eq!(lock.state["schema_id"], json!("inversion_first_principle_lock_state"));

        let maturity = compute_default_maturity_state(&DefaultMaturityStateInput::default());
        assert_eq!(maturity.state["band"], json!("novice"));

        let key = compute_principle_key_for_session(&PrincipleKeyForSessionInput {
            objective_id: Some("BL-209".to_string()),
            objective: Some("fallback".to_string()),
            target: Some("directive".to_string()),
        });
        assert!(key.key.starts_with("directive::"));
        assert_eq!(key.key.len(), "directive::".len() + 16);

        let objective = compute_normalize_objective_arg(&NormalizeObjectiveArgInput {
            value: Some("  ship   lane  ".to_string()),
        });
        assert_eq!(objective.value, "ship lane".to_string());

        let order = compute_maturity_band_order(&MaturityBandOrderInput::default());
        assert_eq!(
            order.bands,
            vec![
                "novice".to_string(),
                "developing".to_string(),
                "mature".to_string(),
                "seasoned".to_string(),
                "legendary".to_string()
            ]
        );

        let mode = compute_current_runtime_mode(&CurrentRuntimeModeInput {
            env_mode: Some("".to_string()),
            args_mode: Some("test".to_string()),
            policy_runtime_mode: Some("live".to_string()),
        });
        assert_eq!(mode.mode, "test".to_string());
    }

    #[test]
    fn helper_primitives_batch8_match_contract() {
        let drift = compute_read_drift_from_state_file(&ReadDriftFromStateFileInput {
            file_path: Some("/tmp/state.json".to_string()),
            source_path: Some("state.json".to_string()),
            payload: Some(json!({"drift_rate": 0.1234567})),
        });
        assert_eq!(drift.value, 0.123457);
        assert_eq!(drift.source, "state.json".to_string());

        let resolved = compute_resolve_lens_gate_drift(&ResolveLensGateDriftInput {
            arg_candidates: vec![json!(null), json!(""), json!("0.2")],
            probe_path: Some("/tmp/state.json".to_string()),
            probe_source: Some("state.json".to_string()),
            probe_payload: Some(json!({"drift_rate": 0.8})),
        });
        assert_eq!(resolved.value, 0.0);
        assert_eq!(resolved.source, "arg".to_string());

        let parity = compute_resolve_parity_confidence(&ResolveParityConfidenceInput {
            arg_candidates: vec![],
            path_hint: Some("/tmp/parity.json".to_string()),
            path_source: Some("parity.json".to_string()),
            payload: Some(json!({"pass_rate": 0.7777777})),
        });
        assert_eq!(parity.value, 0.777778);
        assert_eq!(parity.source, "parity.json".to_string());
    }

    #[test]
    fn helper_primitives_batch9_match_contract() {
        let disabled = compute_attractor_score(&ComputeAttractorScoreInput {
            attractor: Some(json!({"enabled": false})),
            objective: Some("ship safely".to_string()),
            signature: Some("gate first".to_string()),
            ..Default::default()
        });
        assert!(!disabled.enabled);
        assert_eq!(disabled.score, 1.0);
        assert_eq!(disabled.required, 0.0);
        assert!(disabled.pass);
        assert_eq!(disabled.components, json!({}));

        let enabled = compute_attractor_score(&ComputeAttractorScoreInput {
            attractor: Some(json!({
                "enabled": true,
                "weights": {
                    "objective_specificity": 0.3,
                    "evidence_backing": 0.2,
                    "constraint_evidence": 0.15,
                    "measurable_outcome": 0.1,
                    "external_grounding": 0.05,
                    "certainty": 0.1,
                    "trit_alignment": 0.05,
                    "impact_alignment": 0.05,
                    "verbosity_penalty": 0.15
                },
                "verbosity": {
                    "soft_word_cap": 18,
                    "hard_word_cap": 80,
                    "low_diversity_floor": 0.22
                },
                "min_alignment_by_target": {
                    "directive": 0.2
                }
            })),
            objective: Some("Must reduce drift below 2% within 7 days with measurable latency impact."
                .to_string()),
            signature: Some(
                "Use github telemetry and external api evidence to improve throughput by 20%.".to_string(),
            ),
            external_signals_count: Some(json!(3)),
            evidence_count: Some(json!(4)),
            effective_certainty: Some(json!(0.9)),
            trit: Some(json!(1)),
            impact: Some("high".to_string()),
            target: Some("directive".to_string()),
        });
        assert!(enabled.enabled);
        assert!(enabled.score >= 0.0 && enabled.score <= 1.0);
        assert!(enabled.required >= 0.0 && enabled.required <= 1.0);
        assert!(enabled.components.as_object().is_some());
        let word_count = enabled
            .components
            .as_object()
            .and_then(|m| m.get("word_count"))
            .and_then(|v| v.as_i64())
            .unwrap_or(-1);
        assert!(word_count >= 0);
    }

    #[test]
    fn helper_primitives_batch10_match_contract() {
        let out = compute_build_output_interfaces(&BuildOutputInterfacesInput {
            outputs: Some(json!({
                "default_channel": "strategy_hint",
                "belief_update": { "enabled": true, "test_enabled": true, "live_enabled": false, "require_sandbox_verification": false, "require_explicit_emit": false },
                "strategy_hint": { "enabled": true, "test_enabled": true, "live_enabled": true, "require_sandbox_verification": false, "require_explicit_emit": false },
                "workflow_hint": { "enabled": false, "test_enabled": true, "live_enabled": true, "require_sandbox_verification": false, "require_explicit_emit": false },
                "code_change_proposal": { "enabled": true, "test_enabled": true, "live_enabled": true, "require_sandbox_verification": true, "require_explicit_emit": true }
            })),
            mode: Some("test".to_string()),
            sandbox_verified: Some(json!(false)),
            explicit_code_proposal_emit: Some(json!(false)),
            channel_payloads: Some(json!({
                "strategy_hint": { "hint": "x" }
            })),
            base_payload: Some(json!({ "base": true })),
        });

        assert_eq!(out.default_channel, "strategy_hint".to_string());
        assert_eq!(out.active_channel, Some("strategy_hint".to_string()));
        let channels = out.channels.as_object().expect("channels object");
        assert_eq!(channels.len(), 4);
        let proposal = channels
            .get("code_change_proposal")
            .and_then(|v| v.as_object())
            .expect("proposal object");
        assert!(
            !proposal
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true)
        );
        assert!(proposal
            .get("gated_reasons")
            .and_then(|v| v.as_array())
            .map(|rows| rows.iter().any(|row| row.as_str() == Some("sandbox_verification_required")))
            .unwrap_or(false));
    }

    #[test]
    fn helper_primitives_batch11_match_contract() {
        let out = compute_build_code_change_proposal_draft(&BuildCodeChangeProposalDraftInput {
            base: Some(json!({
                "objective": "Harden inversion lane",
                "objective_id": "BL-214",
                "ts": "2026-03-04T00:00:00.000Z",
                "mode": "test",
                "impact": "high",
                "target": "directive",
                "certainty": 0.7333333,
                "maturity_band": "developing",
                "reasons": ["one", "two"],
                "shadow_mode": true
            })),
            args: Some(json!({
                "code_change_title": "Migrate proposal draft builder",
                "code_change_summary": "Rust-first proposal generation with parity fallback.",
                "code_change_files": ["systems/autonomy/inversion_controller.ts"],
                "code_change_tests": ["memory/tools/tests/inversion_helper_batch11_rust_parity.test.js"],
                "code_change_risk": "low"
            })),
            opts: Some(json!({
                "session_id": "ivs_123",
                "sandbox_verified": true
            })),
        });
        let proposal = out.proposal.as_object().expect("proposal object");
        assert_eq!(
            proposal
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            "code_change_proposal"
        );
        assert!(proposal
            .get("proposal_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .starts_with("icp_"));
        assert!(
            proposal
                .get("sandbox_verified")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        );
    }

    #[test]
    fn helper_primitives_batch12_match_contract() {
        let out = compute_normalize_library_row(&NormalizeLibraryRowInput {
            row: Some(json!({
                "id": " abc ",
                "ts": "2026-03-04T00:00:00.000Z",
                "objective": " Ship lane ",
                "objective_id": " BL-215 ",
                "signature": "  reduce drift safely ",
                "target": "directive",
                "impact": "high",
                "certainty": 1.2,
                "filter_stack": ["risk_guard", "  "],
                "outcome_trit": 2,
                "result": "OK",
                "maturity_band": "Developing",
                "principle_id": " p1 ",
                "session_id": " s1 "
            })),
        });
        let row = out.row.as_object().expect("row object");
        assert_eq!(row.get("id").and_then(|v| v.as_str()).unwrap_or(""), "abc");
        assert_eq!(row.get("target").and_then(|v| v.as_str()).unwrap_or(""), "directive");
        assert_eq!(row.get("impact").and_then(|v| v.as_str()).unwrap_or(""), "high");
        assert_eq!(row.get("outcome_trit").and_then(|v| v.as_i64()).unwrap_or(0), 1);
    }

    #[test]
    fn helper_primitives_batch13_match_contract() {
        let temp_root = std::env::temp_dir().join("inv_batch13");
        let _ = fs::remove_dir_all(&temp_root);
        let _ = fs::create_dir_all(&temp_root);
        let state_dir = temp_root.join("state");
        let _ = compute_ensure_dir(&EnsureDirInput {
            dir_path: Some(state_dir.to_string_lossy().to_string()),
        });
        assert!(state_dir.exists());

        let json_path = state_dir.join("x.json");
        let _ = compute_write_json_atomic(&WriteJsonAtomicInput {
            file_path: Some(json_path.to_string_lossy().to_string()),
            value: Some(json!({"a": 1})),
        });
        let read_json = compute_read_json(&ReadJsonInput {
            file_path: Some(json_path.to_string_lossy().to_string()),
            fallback: Some(json!({})),
        });
        assert_eq!(read_json.value, json!({"a": 1}));

        let jsonl_path = state_dir.join("x.jsonl");
        let _ = compute_append_jsonl(&AppendJsonlInput {
            file_path: Some(jsonl_path.to_string_lossy().to_string()),
            row: Some(json!({"k": "v"})),
        });
        let read_jsonl = compute_read_jsonl(&ReadJsonlInput {
            file_path: Some(jsonl_path.to_string_lossy().to_string()),
        });
        assert_eq!(read_jsonl.rows.len(), 1);

        let read_text = compute_read_text(&ReadTextInput {
            file_path: Some(json_path.to_string_lossy().to_string()),
            fallback: Some("fallback".to_string()),
        });
        assert!(read_text.text.contains("\"a\""));

        let latest = compute_latest_json_file_in_dir(&LatestJsonFileInDirInput {
            dir_path: Some(state_dir.to_string_lossy().to_string()),
        });
        assert!(latest.file_path.is_some());

        let out_channel = compute_normalize_output_channel(&NormalizeOutputChannelInput {
            base_out: Some(json!({"enabled": false, "test_enabled": true})),
            src_out: Some(json!({"enabled": true})),
        });
        assert!(out_channel.enabled);
        assert!(out_channel.test_enabled);

        let normalized_repo = compute_normalize_repo_path(&NormalizeRepoPathInput {
            value: Some("config/x.json".to_string()),
            fallback: Some("/tmp/fallback.json".to_string()),
            root: Some("/tmp/root".to_string()),
        });
        assert!(normalized_repo.path.contains("/tmp/root"));

        let paths = compute_runtime_paths(&RuntimePathsInput {
            policy_path: Some("/tmp/policy.json".to_string()),
            inversion_state_dir_env: Some("/tmp/state-root".to_string()),
            dual_brain_policy_path_env: Some("/tmp/dual.json".to_string()),
            default_state_dir: Some("/tmp/default-state".to_string()),
            root: Some("/tmp/root".to_string()),
        });
        assert_eq!(
            paths
                .paths
                .as_object()
                .and_then(|m| m.get("state_dir"))
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            "/tmp/state-root"
        );
    }

    #[test]
    fn helper_primitives_batch14_match_contract() {
        let out_axioms = compute_normalize_axiom_list(&NormalizeAxiomListInput {
            raw_axioms: Some(json!([
                {
                    "id": " A1 ",
                    "patterns": [" Do no harm ", ""],
                    "regex": ["^never\\s+harm"],
                    "intent_tags": [" safety ", "guard"],
                    "signals": {
                        "action_terms": ["harm"],
                        "subject_terms": ["operator"],
                        "object_terms": ["user"]
                    },
                    "min_signal_groups": 2,
                    "semantic_requirements": {
                        "actions": ["protect"],
                        "subjects": ["human"],
                        "objects": ["safety"]
                    }
                }
            ])),
            base_axioms: Some(json!([])),
        });
        assert_eq!(out_axioms.axioms.len(), 1);
        let axiom = out_axioms.axioms[0].as_object().expect("axiom object");
        assert_eq!(axiom.get("id").and_then(|v| v.as_str()).unwrap_or(""), "a1");

        let out_suite = compute_normalize_harness_suite(&NormalizeHarnessSuiteInput {
            raw_suite: Some(json!([
                {
                    "id": " HX-1 ",
                    "objective": " validate lane ",
                    "impact": "critical",
                    "target": "directive",
                    "difficulty": "hard"
                }
            ])),
            base_suite: Some(json!([])),
        });
        assert_eq!(out_suite.suite.len(), 1);
        let row = out_suite.suite[0].as_object().expect("suite row");
        assert_eq!(row.get("id").and_then(|v| v.as_str()).unwrap_or(""), "hx-1");
        assert_eq!(
            row.get("target").and_then(|v| v.as_str()).unwrap_or(""),
            "directive"
        );

        let temp_root = std::env::temp_dir().join("inv_batch14");
        let _ = fs::remove_dir_all(&temp_root);
        let _ = fs::create_dir_all(&temp_root);
        let harness_path = temp_root.join("harness.json");
        let first_principles_path = temp_root.join("lock_state.json");
        let approvals_path = temp_root.join("observer_approvals.jsonl");
        let correspondence_path = temp_root.join("correspondence.md");

        let saved_harness = compute_save_harness_state(&SaveHarnessStateInput {
            file_path: Some(harness_path.to_string_lossy().to_string()),
            state: Some(json!({"last_run_ts":"2026-03-04T00:00:00.000Z","cursor":7})),
            now_iso: Some("2026-03-04T12:00:00.000Z".to_string()),
        });
        assert_eq!(
            saved_harness
                .state
                .as_object()
                .and_then(|m| m.get("cursor"))
                .and_then(|v| v.as_i64())
                .unwrap_or(-1),
            7
        );
        let loaded_harness = compute_load_harness_state(&LoadHarnessStateInput {
            file_path: Some(harness_path.to_string_lossy().to_string()),
            now_iso: Some("2026-03-04T12:00:00.000Z".to_string()),
        });
        assert_eq!(
            loaded_harness
                .state
                .as_object()
                .and_then(|m| m.get("cursor"))
                .and_then(|v| v.as_i64())
                .unwrap_or(-1),
            7
        );

        let saved_lock = compute_save_first_principle_lock_state(&SaveFirstPrincipleLockStateInput {
            file_path: Some(first_principles_path.to_string_lossy().to_string()),
            state: Some(json!({"locks":{"k":{"confidence":0.9}}})),
            now_iso: Some("2026-03-04T12:01:00.000Z".to_string()),
        });
        assert!(saved_lock
            .state
            .as_object()
            .and_then(|m| m.get("locks"))
            .and_then(|v| v.as_object())
            .is_some());
        let loaded_lock = compute_load_first_principle_lock_state(&LoadFirstPrincipleLockStateInput {
            file_path: Some(first_principles_path.to_string_lossy().to_string()),
            now_iso: Some("2026-03-04T12:02:00.000Z".to_string()),
        });
        assert!(loaded_lock
            .state
            .as_object()
            .and_then(|m| m.get("locks"))
            .and_then(|v| v.as_object())
            .is_some());

        let _ = compute_append_observer_approval(&AppendObserverApprovalInput {
            file_path: Some(approvals_path.to_string_lossy().to_string()),
            target: Some("belief".to_string()),
            observer_id: Some("observer_a".to_string()),
            note: Some("first".to_string()),
            now_iso: Some("2026-03-04T12:00:00.000Z".to_string()),
        });
        let _ = compute_append_observer_approval(&AppendObserverApprovalInput {
            file_path: Some(approvals_path.to_string_lossy().to_string()),
            target: Some("belief".to_string()),
            observer_id: Some("observer_a".to_string()),
            note: Some("duplicate".to_string()),
            now_iso: Some("2026-03-04T12:05:00.000Z".to_string()),
        });
        let loaded_observers = compute_load_observer_approvals(&LoadObserverApprovalsInput {
            file_path: Some(approvals_path.to_string_lossy().to_string()),
        });
        assert_eq!(loaded_observers.rows.len(), 2);
        let observer_count = compute_count_observer_approvals(&CountObserverApprovalsInput {
            file_path: Some(approvals_path.to_string_lossy().to_string()),
            target: Some("belief".to_string()),
            window_days: Some(json!(365)),
        });
        assert_eq!(observer_count.count, 1);

        let ensured = compute_ensure_correspondence_file(&EnsureCorrespondenceFileInput {
            file_path: Some(correspondence_path.to_string_lossy().to_string()),
            header: Some("# Shadow Conclave Correspondence\n\n".to_string()),
        });
        assert!(ensured.ok);
        assert!(correspondence_path.exists());
    }

    #[test]
    fn helper_primitives_batch15_match_contract() {
        let temp_root = std::env::temp_dir().join("inv_batch15");
        let _ = fs::remove_dir_all(&temp_root);
        let _ = fs::create_dir_all(&temp_root);
        let maturity_path = temp_root.join("maturity.json");
        let sessions_path = temp_root.join("active_sessions.json");
        let events_dir = temp_root.join("events");
        let receipts_path = temp_root.join("lens_gate_receipts.jsonl");
        let correspondence_path = temp_root.join("correspondence.md");
        let latest_path = temp_root.join("latest.json");
        let history_path = temp_root.join("history.jsonl");
        let interfaces_latest_path = temp_root.join("interfaces_latest.json");
        let interfaces_history_path = temp_root.join("interfaces_history.jsonl");
        let library_path = temp_root.join("library.jsonl");

        let policy = json!({
            "maturity": {
                "target_test_count": 40,
                "score_weights": {
                    "pass_rate": 0.5,
                    "non_destructive_rate": 0.3,
                    "experience": 0.2
                },
                "bands": {
                    "novice": 0.25,
                    "developing": 0.45,
                    "mature": 0.65,
                    "seasoned": 0.82
                }
            }
        });

        let saved_maturity = compute_save_maturity_state(&SaveMaturityStateInput {
            file_path: Some(maturity_path.to_string_lossy().to_string()),
            policy: Some(policy.clone()),
            state: Some(json!({
                "stats": {
                    "total_tests": 20,
                    "passed_tests": 15,
                    "destructive_failures": 1
                }
            })),
            now_iso: Some("2026-03-04T12:00:00.000Z".to_string()),
        });
        assert!(saved_maturity.computed.get("score").is_some());
        let loaded_maturity = compute_load_maturity_state(&LoadMaturityStateInput {
            file_path: Some(maturity_path.to_string_lossy().to_string()),
            policy: Some(policy.clone()),
            now_iso: Some("2026-03-04T12:01:00.000Z".to_string()),
        });
        assert!(loaded_maturity.state.get("band").is_some());

        let saved_sessions = compute_save_active_sessions(&SaveActiveSessionsInput {
            file_path: Some(sessions_path.to_string_lossy().to_string()),
            store: Some(json!({"sessions":[{"session_id":"s1"},{"session_id":"s2"}]})),
            now_iso: Some("2026-03-04T12:02:00.000Z".to_string()),
        });
        assert_eq!(
            saved_sessions
                .store
                .as_object()
                .and_then(|m| m.get("sessions"))
                .and_then(|v| v.as_array())
                .map(|rows| rows.len())
                .unwrap_or(0),
            2
        );
        let loaded_sessions = compute_load_active_sessions(&LoadActiveSessionsInput {
            file_path: Some(sessions_path.to_string_lossy().to_string()),
            now_iso: Some("2026-03-04T12:03:00.000Z".to_string()),
        });
        assert_eq!(
            loaded_sessions
                .store
                .as_object()
                .and_then(|m| m.get("sessions"))
                .and_then(|v| v.as_array())
                .map(|rows| rows.len())
                .unwrap_or(0),
            2
        );

        let emitted = compute_emit_event(&EmitEventInput {
            events_dir: Some(events_dir.to_string_lossy().to_string()),
            date_str: Some("2026-03-04".to_string()),
            event_type: Some("lane_selection".to_string()),
            payload: Some(json!({"ok": true})),
            emit_events: Some(true),
            now_iso: Some("2026-03-04T12:04:00.000Z".to_string()),
        });
        assert!(emitted.emitted);

        let receipt = compute_append_persona_lens_gate_receipt(&AppendPersonaLensGateReceiptInput {
            state_dir: Some(temp_root.to_string_lossy().to_string()),
            root: Some(temp_root.to_string_lossy().to_string()),
            cfg_receipts_path: Some(receipts_path.to_string_lossy().to_string()),
            payload: Some(json!({
                "enabled": true,
                "persona_id": "vikram",
                "mode": "auto",
                "effective_mode": "enforce",
                "status": "enforced",
                "fail_closed": false,
                "drift_rate": 0.01,
                "drift_threshold": 0.02,
                "parity_confidence": 0.9,
                "parity_confident": true,
                "reasons": ["ok"]
            })),
            decision: Some(json!({
                "allowed": true,
                "input": {"objective":"x","target":"belief","impact":"high"}
            })),
            now_iso: Some("2026-03-04T12:05:00.000Z".to_string()),
        });
        assert!(receipt.rel_path.is_some());
        let receipt_again = compute_append_persona_lens_gate_receipt(
            &AppendPersonaLensGateReceiptInput {
                state_dir: Some(temp_root.to_string_lossy().to_string()),
                root: Some(temp_root.to_string_lossy().to_string()),
                cfg_receipts_path: Some(receipts_path.to_string_lossy().to_string()),
                payload: Some(json!({
                    "enabled": true,
                    "persona_id": "vikram",
                    "mode": "auto",
                    "effective_mode": "enforce",
                    "status": "enforced",
                    "fail_closed": false,
                    "drift_rate": 0.01,
                    "drift_threshold": 0.02,
                    "parity_confidence": 0.9,
                    "parity_confident": true,
                    "reasons": ["ok"]
                })),
                decision: Some(json!({
                    "allowed": true,
                    "input": {"objective":"x","target":"belief","impact":"high"}
                })),
                now_iso: Some("2026-03-04T12:05:00.000Z".to_string()),
            },
        );
        assert_eq!(receipt.rel_path, receipt_again.rel_path);
        let receipts_raw = fs::read_to_string(&receipts_path).expect("read persona lens receipts");
        let rows = receipts_raw
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>();
        assert!(rows.len() >= 2);
        assert_eq!(rows[rows.len() - 1], rows[rows.len() - 2]);
        let parsed: Value =
            serde_json::from_str(rows[rows.len() - 1]).expect("parse persona lens receipt");
        assert_eq!(parsed.get("target").and_then(Value::as_str), Some("belief"));
        assert_eq!(
            parsed.get("type").and_then(Value::as_str),
            Some("inversion_persona_lens_gate")
        );

        let conclave = compute_append_conclave_correspondence(&AppendConclaveCorrespondenceInput {
            correspondence_path: Some(correspondence_path.to_string_lossy().to_string()),
            row: Some(json!({
                "ts": "2026-03-04T12:06:00.000Z",
                "session_or_step": "step-1",
                "pass": true,
                "winner": "vikram",
                "arbitration_rule": "safety_first",
                "high_risk_flags": ["none"],
                "query": "q",
                "proposal_summary": "s",
                "receipt_path": "r",
                "review_payload": {"ok": true}
            })),
        });
        assert!(conclave.ok);
        assert!(correspondence_path.exists());

        let persisted = compute_persist_decision(&PersistDecisionInput {
            latest_path: Some(latest_path.to_string_lossy().to_string()),
            history_path: Some(history_path.to_string_lossy().to_string()),
            payload: Some(json!({"decision":"x"})),
        });
        assert!(persisted.ok);

        let persisted_env = compute_persist_interface_envelope(&PersistInterfaceEnvelopeInput {
            latest_path: Some(interfaces_latest_path.to_string_lossy().to_string()),
            history_path: Some(interfaces_history_path.to_string_lossy().to_string()),
            envelope: Some(json!({"envelope":"x"})),
        });
        assert!(persisted_env.ok);

        let _ = compute_append_jsonl(&AppendJsonlInput {
            file_path: Some(library_path.to_string_lossy().to_string()),
            row: Some(json!({"id":"a","ts":"2026-03-04T00:00:00.000Z","objective":"one"})),
        });
        let _ = compute_append_jsonl(&AppendJsonlInput {
            file_path: Some(library_path.to_string_lossy().to_string()),
            row: Some(json!({"id":"b","ts":"2026-03-04T00:01:00.000Z","objective":"two"})),
        });
        let _ = compute_append_jsonl(&AppendJsonlInput {
            file_path: Some(library_path.to_string_lossy().to_string()),
            row: Some(json!({"id":"c","ts":"2026-03-04T00:02:00.000Z","objective":"three"})),
        });
        let trimmed = compute_trim_library(&TrimLibraryInput {
            file_path: Some(library_path.to_string_lossy().to_string()),
            max_entries: Some(json!(2)),
        });
        assert_eq!(trimmed.rows.len(), 3);
    }

    #[test]
    fn helper_primitives_batch16_match_contract() {
        let temp_root = std::env::temp_dir().join("inv_batch16");
        let _ = fs::remove_dir_all(&temp_root);
        let _ = fs::create_dir_all(temp_root.join("first_principles"));
        let tier_path = temp_root.join("tier_governance.json");
        let lock_path = temp_root.join("first_principles").join("lock_state.json");

        let base_state = json!({
            "schema_id": "inversion_tier_governance_state",
            "schema_version": "1.0",
            "active_policy_version": "1.7",
            "scopes": {
                "1.7": {
                    "live_apply_attempts": {"tactical": ["2026-03-04T00:00:00.000Z"]},
                    "live_apply_successes": {"tactical": []},
                    "live_apply_safe_aborts": {"tactical": []},
                    "shadow_passes": {"tactical": []},
                    "shadow_critical_failures": {"tactical": []}
                }
            }
        });
        let policy = json!({
            "version": "1.7",
            "tier_transition": {
                "window_days_by_target": {"tactical": 45, "directive": 90},
                "minimum_window_days_by_target": {"tactical": 30, "directive": 60}
            },
            "shadow_pass_gate": {
                "window_days_by_target": {"tactical": 60, "directive": 120}
            },
            "first_principles": {
                "anti_downgrade": {
                    "enabled": true,
                    "require_same_or_higher_maturity": true,
                    "prevent_lower_confidence_same_band": true,
                    "same_band_confidence_floor_ratio": 0.92
                }
            }
        });

        let saved = compute_save_tier_governance_state(&SaveTierGovernanceStateInput {
            file_path: Some(tier_path.to_string_lossy().to_string()),
            state: Some(base_state),
            policy_version: Some("1.7".to_string()),
            retention_days: Some(3650),
            now_iso: Some("2026-03-04T12:00:00.000Z".to_string()),
        });
        assert_eq!(
            value_path(Some(&saved.state), &["active_policy_version"])
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            "1.7"
        );
        let loaded = compute_load_tier_governance_state(&LoadTierGovernanceStateInput {
            file_path: Some(tier_path.to_string_lossy().to_string()),
            policy_version: Some("1.7".to_string()),
            now_iso: Some("2026-03-04T12:01:00.000Z".to_string()),
        });
        assert!(value_path(Some(&loaded.state), &["active_scope"]).is_some());

        let pushed = compute_push_tier_event(&PushTierEventInput {
            scope_map: Some(json!({"tactical": []})),
            target: Some("directive".to_string()),
            ts: Some("2026-03-04T12:00:00.000Z".to_string()),
        });
        assert_eq!(
            pushed
                .map
                .as_object()
                .and_then(|m| m.get("directive"))
                .and_then(|v| v.as_array())
                .map(|rows| rows.len())
                .unwrap_or(0),
            1
        );

        let added = compute_add_tier_event(&AddTierEventInput {
            file_path: Some(tier_path.to_string_lossy().to_string()),
            policy: Some(policy.clone()),
            metric: Some("live_apply_attempts".to_string()),
            target: Some("belief".to_string()),
            ts: Some("2026-03-04T12:00:00.000Z".to_string()),
            now_iso: Some("2026-03-04T12:00:00.000Z".to_string()),
        });
        assert!(
            value_path(
                Some(&added.state),
                &["scopes", "1.7", "live_apply_attempts", "belief"]
            )
            .and_then(|v| v.as_array())
            .map(|rows| !rows.is_empty())
            .unwrap_or(false)
        );

        let inc_attempt = compute_increment_live_apply_attempt(&IncrementLiveApplyAttemptInput {
            file_path: Some(tier_path.to_string_lossy().to_string()),
            policy: Some(policy.clone()),
            target: Some("identity".to_string()),
            now_iso: Some("2026-03-04T12:02:00.000Z".to_string()),
        });
        assert!(
            value_path(
                Some(&inc_attempt.state),
                &["scopes", "1.7", "live_apply_attempts", "identity"]
            )
            .and_then(|v| v.as_array())
            .map(|rows| !rows.is_empty())
            .unwrap_or(false)
        );

        let inc_success = compute_increment_live_apply_success(&IncrementLiveApplySuccessInput {
            file_path: Some(tier_path.to_string_lossy().to_string()),
            policy: Some(policy.clone()),
            target: Some("identity".to_string()),
            now_iso: Some("2026-03-04T12:03:00.000Z".to_string()),
        });
        assert!(
            value_path(
                Some(&inc_success.state),
                &["scopes", "1.7", "live_apply_successes", "identity"]
            )
            .and_then(|v| v.as_array())
            .map(|rows| !rows.is_empty())
            .unwrap_or(false)
        );

        let inc_abort = compute_increment_live_apply_safe_abort(&IncrementLiveApplySafeAbortInput {
            file_path: Some(tier_path.to_string_lossy().to_string()),
            policy: Some(policy.clone()),
            target: Some("identity".to_string()),
            now_iso: Some("2026-03-04T12:04:00.000Z".to_string()),
        });
        assert!(
            value_path(
                Some(&inc_abort.state),
                &["scopes", "1.7", "live_apply_safe_aborts", "identity"]
            )
            .and_then(|v| v.as_array())
            .map(|rows| !rows.is_empty())
            .unwrap_or(false)
        );

        let shadow = compute_update_shadow_trial_counters(&UpdateShadowTrialCountersInput {
            file_path: Some(tier_path.to_string_lossy().to_string()),
            policy: Some(policy.clone()),
            session: Some(json!({"mode":"test","apply_requested": false,"target":"directive"})),
            result: Some("success".to_string()),
            destructive: Some(false),
            now_iso: Some("2026-03-04T12:05:00.000Z".to_string()),
        });
        assert!(shadow.state.is_some());

        let upsert = compute_upsert_first_principle_lock(&UpsertFirstPrincipleLockInput {
            file_path: Some(lock_path.to_string_lossy().to_string()),
            session: Some(json!({
                "objective_id":"BL-246",
                "objective":"Guard principle quality",
                "target":"directive",
                "maturity_band":"mature"
            })),
            principle: Some(json!({"id":"fp_guard","confidence":0.91})),
            now_iso: Some("2026-03-04T12:06:00.000Z".to_string()),
        });
        assert!(value_path(Some(&upsert.state), &["locks", upsert.key.as_str()]).is_some());

        let check = compute_check_first_principle_downgrade(&CheckFirstPrincipleDowngradeInput {
            file_path: Some(lock_path.to_string_lossy().to_string()),
            policy: Some(policy),
            session: Some(json!({
                "objective_id":"BL-246",
                "objective":"Guard principle quality",
                "target":"directive",
                "maturity_band":"developing"
            })),
            confidence: Some(0.5),
            now_iso: Some("2026-03-04T12:07:00.000Z".to_string()),
        });
        assert!(!check.allowed);
        assert_eq!(
            check.reason.as_deref().unwrap_or(""),
            "first_principle_downgrade_blocked_lower_maturity"
        );
    }

    #[test]
    fn helper_primitives_batch17_match_contract() {
        let temp_root = std::env::temp_dir().join("inv_batch17");
        let _ = fs::remove_dir_all(&temp_root);
        let _ = fs::create_dir_all(temp_root.join("events"));
        let _ = fs::create_dir_all(temp_root.join("simulation"));
        let _ = fs::create_dir_all(temp_root.join("red_team"));

        let library_path = temp_root.join("library.jsonl");
        let receipts_path = temp_root.join("receipts.jsonl");
        let active_sessions_path = temp_root.join("active_sessions.json");
        let fp_latest_path = temp_root.join("first_principles_latest.json");
        let fp_history_path = temp_root.join("first_principles_history.jsonl");
        let fp_lock_path = temp_root.join("first_principles_lock.json");

        let _ = compute_append_jsonl(&AppendJsonlInput {
            file_path: Some(library_path.to_string_lossy().to_string()),
            row: Some(json!({
                "id":"a1",
                "ts":"2026-03-04T00:00:00.000Z",
                "objective":"Reduce drift safely",
                "objective_id":"BL-263",
                "signature":"drift guard stable",
                "signature_tokens":["drift","guard","stable"],
                "target":"directive",
                "impact":"high",
                "certainty":0.9,
                "filter_stack":["drift_guard"],
                "outcome_trit":-1,
                "result":"fail",
                "maturity_band":"developing"
            })),
        });
        let _ = compute_append_jsonl(&AppendJsonlInput {
            file_path: Some(library_path.to_string_lossy().to_string()),
            row: Some(json!({
                "id":"a2",
                "ts":"2026-03-04T00:10:00.000Z",
                "objective":"Reduce drift safely",
                "objective_id":"BL-263",
                "signature":"drift guard stable",
                "signature_tokens":["drift","guard","stable"],
                "target":"directive",
                "impact":"high",
                "certainty":0.88,
                "filter_stack":["drift_guard","identity_guard"],
                "outcome_trit":-1,
                "result":"fail",
                "maturity_band":"developing"
            })),
        });
        let _ = compute_append_jsonl(&AppendJsonlInput {
            file_path: Some(library_path.to_string_lossy().to_string()),
            row: Some(json!({
                "id":"a3",
                "ts":"2026-03-04T00:20:00.000Z",
                "objective":"Reduce drift safely",
                "objective_id":"BL-263",
                "signature":"drift guard stable",
                "signature_tokens":["drift","guard","stable"],
                "target":"directive",
                "impact":"high",
                "certainty":0.86,
                "filter_stack":["drift_guard","fallback_pathing"],
                "outcome_trit":-1,
                "result":"fail",
                "maturity_band":"developing"
            })),
        });
        let _ = compute_append_jsonl(&AppendJsonlInput {
            file_path: Some(library_path.to_string_lossy().to_string()),
            row: Some(json!({
                "id":"a4",
                "ts":"2026-03-04T00:30:00.000Z",
                "objective":"Reduce drift safely",
                "objective_id":"BL-263",
                "signature":"drift guard stable",
                "signature_tokens":["drift","guard","stable"],
                "target":"directive",
                "impact":"high",
                "certainty":0.84,
                "filter_stack":["drift_guard","constraint_reframe"],
                "outcome_trit":-1,
                "result":"fail",
                "maturity_band":"developing"
            })),
        });
        let _ = compute_append_jsonl(&AppendJsonlInput {
            file_path: Some(library_path.to_string_lossy().to_string()),
            row: Some(json!({
                "id":"ok1",
                "ts":"2026-03-04T01:00:00.000Z",
                "objective":"Ship safely",
                "signature":"safe lane pass",
                "signature_tokens":["safe","lane","pass"],
                "target":"directive",
                "impact":"high",
                "certainty":0.92,
                "filter_stack":["safe_path"],
                "outcome_trit":1,
                "result":"success",
                "maturity_band":"mature"
            })),
        });

        let detect = compute_detect_immutable_axiom_violation(&DetectImmutableAxiomViolationInput {
            policy: Some(json!({
                "immutable_axioms": {
                    "enabled": true,
                    "axioms": [{
                        "id":"safety_guard",
                        "patterns":["drift guard"],
                        "regex":["drift\\s+guard"],
                        "intent_tags":["safety"],
                        "signals":{"action_terms":["drift"],"subject_terms":["guard"],"object_terms":[]},
                        "min_signal_groups": 1
                    }]
                }
            })),
            decision_input: Some(json!({
                "objective":"Need drift guard policy",
                "signature":"drift guard now",
                "filters":["constraint_reframe"],
                "intent_tags":["safety"]
            })),
        });
        assert_eq!(detect.hits, vec!["safety_guard".to_string()]);

        let maturity = compute_maturity_score(&ComputeMaturityScoreInput {
            state: Some(json!({
                "stats": {
                    "total_tests": 20,
                    "passed_tests": 15,
                    "destructive_failures": 2
                }
            })),
            policy: Some(json!({
                "maturity": {
                    "target_test_count": 40,
                    "score_weights": {"pass_rate":0.5,"non_destructive_rate":0.3,"experience":0.2},
                    "bands": {"novice":0.25,"developing":0.45,"mature":0.65,"seasoned":0.82}
                }
            })),
        });
        assert_eq!(maturity.band, "seasoned".to_string());
        assert!((maturity.score - 0.745).abs() < 0.000001);

        let candidates = compute_select_library_candidates(&SelectLibraryCandidatesInput {
            policy: Some(json!({
                "library": {
                    "min_similarity_for_reuse": 0.2,
                    "token_weight": 0.6,
                    "trit_weight": 0.3,
                    "target_weight": 0.1
                }
            })),
            query: Some(json!({
                "signature_tokens":["drift","guard","stable"],
                "trit_vector":[-1],
                "target":"directive"
            })),
            file_path: Some(library_path.to_string_lossy().to_string()),
        });
        assert!(!candidates.candidates.is_empty());

        let lane = compute_parse_lane_decision(&ParseLaneDecisionInput {
            args: Some(json!({"brain_lane":"right"})),
        });
        assert_eq!(lane.selected_lane, "right".to_string());
        assert_eq!(lane.source, "arg".to_string());

        let now = now_iso_runtime();
        let expired_at = "2000-01-01T00:00:00.000Z".to_string();
        let live_at = "2999-01-01T00:00:00.000Z".to_string();
        let _ = compute_save_active_sessions(&SaveActiveSessionsInput {
            file_path: Some(active_sessions_path.to_string_lossy().to_string()),
            store: Some(json!({
                "sessions":[
                    {"session_id":"exp","objective":"old","signature":"old sig","target":"directive","impact":"high","certainty":0.5,"expires_at": expired_at},
                    {"session_id":"live","objective":"new","signature":"new sig","target":"directive","impact":"high","certainty":0.6,"expires_at": live_at}
                ]
            })),
            now_iso: Some(now.clone()),
        });
        let sweep = compute_sweep_expired_sessions(&SweepExpiredSessionsInput {
            paths: Some(json!({
                "active_sessions_path": active_sessions_path.to_string_lossy().to_string(),
                "receipts_path": receipts_path.to_string_lossy().to_string(),
                "library_path": library_path.to_string_lossy().to_string(),
                "events_dir": temp_root.join("events").to_string_lossy().to_string()
            })),
            policy: Some(json!({"telemetry":{"emit_events":false},"library":{"max_entries":200}})),
            date_str: Some("2026-03-04".to_string()),
            now_iso: Some(now.clone()),
        });
        assert_eq!(sweep.expired_count, 1);
        assert_eq!(sweep.sessions.len(), 1);

        let _ = fs::write(
            temp_root.join("regime.json"),
            serde_json::to_string(&json!({
                "selected_regime":"constrained",
                "candidate_confidence":0.8,
                "context":{"trit":{"trit":-1}}
            }))
            .unwrap_or_else(|_| "{}".to_string()),
        );
        let _ = fs::write(
            temp_root.join("mirror.json"),
            serde_json::to_string(&json!({"pressure_score":0.7,"confidence":0.75,"reasons":["pressure","drift"]}))
                .unwrap_or_else(|_| "{}".to_string()),
        );
        let _ = fs::write(
            temp_root.join("drift_governor.json"),
            serde_json::to_string(&json!({"last_decision":{"trit_shadow":{"belief":{"trit":-1}}}}))
                .unwrap_or_else(|_| "{}".to_string()),
        );
        let _ = fs::write(
            temp_root.join("simulation").join("2026-03-04.json"),
            serde_json::to_string(&json!({"checks_effective":{"drift_rate":{"value":0.09},"yield_rate":{"value":0.4}}}))
                .unwrap_or_else(|_| "{}".to_string()),
        );
        let _ = fs::write(
            temp_root.join("red_team").join("latest.json"),
            serde_json::to_string(&json!({"summary":{"critical_fail_cases":2,"pass_cases":1,"fail_cases":3}}))
                .unwrap_or_else(|_| "{}".to_string()),
        );

        let signals = compute_load_impossibility_signals(&LoadImpossibilitySignalsInput {
            policy: Some(json!({
                "organ": {
                    "trigger_detection": {
                        "paths": {
                            "regime_latest_path":"regime.json",
                            "mirror_latest_path":"mirror.json",
                            "simulation_dir":"simulation",
                            "red_team_runs_dir":"red_team",
                            "drift_governor_path":"drift_governor.json"
                        }
                    }
                }
            })),
            date_str: Some("2026-03-04".to_string()),
            root: Some(temp_root.to_string_lossy().to_string()),
        });
        assert_eq!(
            value_path(Some(&signals.signals), &["trit", "value"])
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            -1
        );

        let trigger = compute_evaluate_impossibility_trigger(&EvaluateImpossibilityTriggerInput {
            policy: Some(json!({
                "organ": {
                    "trigger_detection": {
                        "enabled": true,
                        "min_impossibility_score": 0.58,
                        "min_signal_count": 2,
                        "thresholds": {"predicted_drift_warn":0.03,"predicted_yield_warn":0.68},
                        "weights": {
                            "trit_pain":0.2,
                            "mirror_pressure":0.2,
                            "predicted_drift":0.18,
                            "predicted_yield_gap":0.18,
                            "red_team_critical":0.14,
                            "regime_constrained":0.1
                        }
                    }
                }
            })),
            signals: Some(signals.signals.clone()),
            force: Some(false),
        });
        assert!(trigger.triggered);
        assert!(trigger.signal_count >= 2);

        let fp_policy = json!({
            "first_principles": {
                "enabled": true,
                "auto_extract_on_success": true,
                "max_strategy_bonus": 0.12,
                "allow_failure_cluster_extraction": true,
                "failure_cluster_min": 4
            },
            "library": {
                "min_similarity_for_reuse": 0.2,
                "token_weight": 0.6,
                "trit_weight": 0.3,
                "target_weight": 0.1
            }
        });
        let session = json!({
            "session_id":"sfp",
            "objective":"Reduce drift safely",
            "objective_id":"BL-263",
            "target":"directive",
            "certainty":0.8,
            "filter_stack":["drift_guard"],
            "signature":"drift guard stable",
            "signature_tokens":["drift","guard","stable"]
        });
        let first_principle = compute_extract_first_principle(&ExtractFirstPrincipleInput {
            policy: Some(fp_policy.clone()),
            session: Some(session.clone()),
            args: Some(json!({})),
            result: Some("success".to_string()),
            now_iso: Some(now_iso_runtime()),
        });
        assert!(first_principle.principle.is_some());

        let failure_principle = compute_extract_failure_cluster_principle(&ExtractFailureClusterPrincipleInput {
            paths: Some(json!({"library_path": library_path.to_string_lossy().to_string()})),
            policy: Some(fp_policy),
            session: Some(session.clone()),
            now_iso: Some(now_iso_runtime()),
        });
        assert!(failure_principle.principle.is_some());

        let persisted = compute_persist_first_principle(&PersistFirstPrincipleInput {
            paths: Some(json!({
                "first_principles_latest_path": fp_latest_path.to_string_lossy().to_string(),
                "first_principles_history_path": fp_history_path.to_string_lossy().to_string(),
                "first_principles_lock_path": fp_lock_path.to_string_lossy().to_string()
            })),
            session: Some(session),
            principle: first_principle.principle.clone(),
            now_iso: Some(now_iso_runtime()),
        });
        assert!(persisted.principle.is_object());
        assert!(fp_latest_path.exists());
    }
}
