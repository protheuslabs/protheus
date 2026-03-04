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

pub fn compute_trit_vector_from_input(input: &TritVectorFromInputInput) -> TritVectorFromInputOutput {
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
        "Treat drift above tolerance as a hard stop and require rollback-ready proof before apply.".to_string()
    } else if target == "identity" || impact == "high" || impact == "critical" {
        "Use strict reversible slices with explicit receipts before any live apply.".to_string()
    } else {
        "Keep the smallest reversible path and preserve fail-closed controls before mutation.".to_string()
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

    let divergence = parse_number_like(payload.and_then(|row| row.get("max_divergence"))).unwrap_or(0.0);
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
        && confidences
            .iter()
            .fold(f64::INFINITY, |acc, n| acc.min(*n))
            < min_confidence
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

fn decode_input<T>(payload: &Value, key: &str) -> Result<T, String>
where
    T: for<'de> Deserialize<'de> + Default,
{
    let value = payload
        .get(key)
        .cloned()
        .unwrap_or_else(|| json!({}));
    serde_json::from_value(value).map_err(|e| format!("inversion_decode_{key}_failed:{e}"))
}

pub fn run_inversion_json(payload_json: &str) -> Result<String, String> {
    let payload: Value =
        serde_json::from_str(payload_json).map_err(|e| format!("inversion_payload_parse_failed:{e}"))?;
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
        let input: TritVectorFromInputInput = decode_input(&payload, "trit_vector_from_input_input")?;
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

        let parsed = compute_parse_system_internal_permission(&ParseSystemInternalPermissionInput {
            markdown: Some("- system_internal: {enabled: true, sources: [memory, loops]}".to_string()),
        });
        assert_eq!(
            parsed,
            ParseSystemInternalPermissionOutput {
                enabled: true,
                sources: vec!["memory".to_string(), "loops".to_string()]
            }
        );

        let rules = compute_parse_soul_token_data_pass_rules(&ParseSoulTokenDataPassRulesInput {
            markdown: Some("## Data Pass Rules\n- allow-system-internal-passed-data\n- Non Runtime".to_string()),
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
        assert!(flags.flags.contains(&"keyword:disable_covenant".to_string()));
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
}
