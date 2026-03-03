use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecomposePolicy {
    #[serde(default = "default_max_depth")]
    pub max_depth: usize,
    #[serde(default = "default_max_micro_tasks")]
    pub max_micro_tasks: usize,
    #[serde(default = "default_max_words_per_leaf")]
    pub max_words_per_leaf: usize,
    #[serde(default = "default_min_minutes")]
    pub min_minutes: usize,
    #[serde(default = "default_max_minutes")]
    pub max_minutes: usize,
    #[serde(default = "default_max_groups")]
    pub max_groups: usize,
    #[serde(default = "default_lane")]
    pub default_lane: String,
    #[serde(default = "default_storm_lane")]
    pub storm_lane: String,
    #[serde(default)]
    pub human_lane_keywords: Vec<String>,
    #[serde(default)]
    pub autonomous_lane_keywords: Vec<String>,
    #[serde(default = "default_min_storm_share")]
    pub min_storm_share: f64,
}

impl Default for DecomposePolicy {
    fn default() -> Self {
        Self {
            max_depth: default_max_depth(),
            max_micro_tasks: default_max_micro_tasks(),
            max_words_per_leaf: default_max_words_per_leaf(),
            min_minutes: default_min_minutes(),
            max_minutes: default_max_minutes(),
            max_groups: default_max_groups(),
            default_lane: default_lane(),
            storm_lane: default_storm_lane(),
            human_lane_keywords: Vec::new(),
            autonomous_lane_keywords: Vec::new(),
            min_storm_share: default_min_storm_share(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DecomposeRequest {
    #[serde(default)]
    pub run_id: String,
    #[serde(default)]
    pub goal_id: String,
    #[serde(default)]
    pub goal_text: String,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub creator_id: Option<String>,
    #[serde(default)]
    pub policy: DecomposePolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Capability {
    pub capability_id: String,
    pub adapter_kind: String,
    pub source_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BaseTask {
    pub micro_task_id: String,
    pub goal_id: String,
    pub objective_id: Option<String>,
    pub parent_id: Option<String>,
    pub depth: usize,
    pub index: usize,
    pub title: String,
    pub task_text: String,
    pub estimated_minutes: usize,
    pub success_criteria: Vec<String>,
    pub required_capability: String,
    pub profile_id: String,
    pub capability: Capability,
    pub suggested_lane: String,
    pub parallel_group: usize,
    pub parallel_priority: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecomposeResponse {
    pub ok: bool,
    pub tasks: Vec<BaseTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComposePolicy {
    #[serde(default = "default_min_minutes")]
    pub min_minutes: usize,
    #[serde(default = "default_max_minutes")]
    pub max_minutes: usize,
    #[serde(default = "default_max_groups")]
    pub max_groups: usize,
    #[serde(default = "default_lane")]
    pub default_lane: String,
    #[serde(default = "default_storm_lane")]
    pub storm_lane: String,
}

impl Default for ComposePolicy {
    fn default() -> Self {
        Self {
            min_minutes: default_min_minutes(),
            max_minutes: default_max_minutes(),
            max_groups: default_max_groups(),
            default_lane: default_lane(),
            storm_lane: default_storm_lane(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ComposeRequest {
    #[serde(default)]
    pub run_id: String,
    #[serde(default)]
    pub goal_id: String,
    #[serde(default)]
    pub goal_text: String,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub creator_id: Option<String>,
    #[serde(default)]
    pub policy: ComposePolicy,
    #[serde(default)]
    pub tasks: Vec<BaseTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComposeResponse {
    pub ok: bool,
    pub tasks: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TaskSummaryRequest {
    #[serde(default)]
    pub tasks: Vec<Value>,
    #[serde(default)]
    pub shadow_only: bool,
    #[serde(default)]
    pub apply_executed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSummaryResponse {
    pub ok: bool,
    pub summary: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DispatchSummaryRequest {
    #[serde(default)]
    pub rows: Vec<Value>,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchSummaryResponse {
    pub ok: bool,
    pub summary: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QueueRowsRequest {
    #[serde(default)]
    pub run_id: String,
    #[serde(default)]
    pub goal_id: String,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub shadow_only: bool,
    #[serde(default)]
    pub passport_id: Option<String>,
    #[serde(default = "default_storm_lane")]
    pub storm_lane: String,
    #[serde(default)]
    pub tasks: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueRowsResponse {
    pub ok: bool,
    pub weaver: Vec<Value>,
    pub storm: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DispatchRowsRequest {
    #[serde(default)]
    pub run_id: String,
    #[serde(default)]
    pub goal_id: String,
    #[serde(default)]
    pub objective_id: Option<String>,
    #[serde(default)]
    pub shadow_only: bool,
    #[serde(default)]
    pub apply_executed: bool,
    #[serde(default)]
    pub passport_id: Option<String>,
    #[serde(default = "default_storm_lane")]
    pub storm_lane: String,
    #[serde(default = "default_autonomous_executor")]
    pub autonomous_executor: String,
    #[serde(default = "default_storm_executor")]
    pub storm_executor: String,
    #[serde(default)]
    pub tasks: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchRowsResponse {
    pub ok: bool,
    pub rows: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GovernanceApplyPolicy {
    #[serde(default = "default_lane")]
    pub default_lane: String,
    #[serde(default = "default_storm_lane")]
    pub storm_lane: String,
    #[serde(default = "default_min_storm_share")]
    pub min_storm_share: f64,
    #[serde(default = "default_block_on_constitution_deny")]
    pub block_on_constitution_deny: bool,
}

impl Default for GovernanceApplyPolicy {
    fn default() -> Self {
        Self {
            default_lane: default_lane(),
            storm_lane: default_storm_lane(),
            min_storm_share: default_min_storm_share(),
            block_on_constitution_deny: default_block_on_constitution_deny(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GovernanceApplyRequest {
    #[serde(default)]
    pub policy: GovernanceApplyPolicy,
    #[serde(default)]
    pub rows: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GovernanceApplyResponse {
    pub ok: bool,
    pub tasks: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DirectiveGateRequest {
    #[serde(default)]
    pub task_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectiveGateResponse {
    pub ok: bool,
    pub decision: String,
    pub risk: String,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HeroicGateRequest {
    #[serde(default)]
    pub task_text: String,
    #[serde(default)]
    pub block_on_destructive: bool,
    #[serde(default)]
    pub purified_row: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeroicGateResponse {
    pub ok: bool,
    pub classification: String,
    pub decision: String,
    pub blocked: bool,
    pub reason_codes: Vec<String>,
}

#[derive(Debug, Clone)]
struct Segment {
    text: String,
    depth: usize,
    parent_id: Option<String>,
}

fn default_max_depth() -> usize {
    4
}
fn default_max_micro_tasks() -> usize {
    96
}
fn default_max_words_per_leaf() -> usize {
    18
}
fn default_min_minutes() -> usize {
    1
}
fn default_max_minutes() -> usize {
    5
}
fn default_max_groups() -> usize {
    8
}
fn default_lane() -> String {
    "autonomous_micro_agent".to_string()
}
fn default_storm_lane() -> String {
    "storm_human_lane".to_string()
}
fn default_autonomous_executor() -> String {
    "universal_execution_primitive".to_string()
}
fn default_storm_executor() -> String {
    "storm_human_lane".to_string()
}
fn default_min_storm_share() -> f64 {
    0.15
}
fn default_block_on_constitution_deny() -> bool {
    true
}

fn clean_text(raw: &str, max_len: usize) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_ws = false;
    for ch in raw.chars() {
        if ch.is_whitespace() {
            if !last_ws {
                out.push(' ');
                last_ws = true;
            }
        } else {
            out.push(ch);
            last_ws = false;
        }
    }
    let trimmed = out.trim();
    trimmed.chars().take(max_len).collect::<String>()
}

fn normalize_token(raw: &str, max_len: usize) -> String {
    let cleaned = clean_text(raw, max_len).to_lowercase();
    let mut out = String::with_capacity(cleaned.len());
    let mut last_underscore = false;
    for ch in cleaned.chars() {
        let allowed = ch.is_ascii_lowercase()
            || ch.is_ascii_digit()
            || ch == '_'
            || ch == '.'
            || ch == ':'
            || ch == '/'
            || ch == '-';
        if allowed {
            if ch == '_' {
                if !last_underscore {
                    out.push(ch);
                }
                last_underscore = true;
            } else {
                out.push(ch);
                last_underscore = false;
            }
        } else if !last_underscore {
            out.push('_');
            last_underscore = true;
        }
    }
    out.trim_matches('_').to_string()
}

fn sha16(seed: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let hex = hex::encode(hasher.finalize());
    hex.chars().take(16).collect()
}

fn word_count(text: &str) -> usize {
    text.split_whitespace().count()
}

fn split_candidates(text: &str) -> Vec<String> {
    let punct_re = Regex::new(r"[\n;]+").expect("valid punct regex");
    let connector_re =
        Regex::new(r"(?i)\b(?:and then|then|and|after|before|while|plus|also|with)\b")
            .expect("valid connector regex");

    let punct: Vec<String> = punct_re
        .split(text)
        .map(|row| clean_text(row, 800))
        .filter(|row| !row.is_empty())
        .collect();
    let rows = if punct.is_empty() {
        vec![text.to_string()]
    } else {
        punct
    };

    let mut out: Vec<String> = Vec::new();
    for row in rows {
        let split: Vec<String> = connector_re
            .split(row.as_str())
            .map(|part| clean_text(part, 600))
            .filter(|part| !part.is_empty())
            .collect();
        if split.len() > 1 {
            out.extend(split);
        } else if !row.is_empty() {
            out.push(row);
        }
    }
    out
}

fn recursive_decompose(
    text: &str,
    depth: usize,
    policy: &DecomposePolicy,
    parent: Option<String>,
) -> Vec<Segment> {
    let trimmed = clean_text(text, 1200);
    if trimmed.is_empty() {
        return Vec::new();
    }
    let words = word_count(trimmed.as_str());
    if depth >= policy.max_depth || words <= policy.max_words_per_leaf {
        return vec![Segment {
            text: trimmed,
            depth,
            parent_id: parent,
        }];
    }

    let candidates: Vec<String> = split_candidates(trimmed.as_str())
        .into_iter()
        .map(|row| clean_text(row.as_str(), 1000))
        .filter(|row| !row.is_empty() && row != &trimmed)
        .collect();
    if candidates.is_empty() {
        return vec![Segment {
            text: trimmed,
            depth,
            parent_id: parent,
        }];
    }

    let current_id = format!(
        "seg_{}",
        sha16(
            format!(
                "{}|{}",
                depth,
                trimmed.chars().take(120).collect::<String>()
            )
            .as_str()
        )
    );
    let mut out: Vec<Segment> = Vec::new();
    for candidate in candidates {
        out.extend(recursive_decompose(
            candidate.as_str(),
            depth + 1,
            policy,
            Some(current_id.clone()),
        ));
    }
    if out.is_empty() {
        vec![Segment {
            text: trimmed,
            depth,
            parent_id: parent,
        }]
    } else {
        out
    }
}

fn dedupe_segments(rows: Vec<Segment>, max_items: usize) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for row in rows {
        let key = normalize_token(row.text.as_str(), 220);
        if key.is_empty() || seen.contains(key.as_str()) {
            continue;
        }
        seen.insert(key);
        out.push(row);
        if out.len() >= max_items {
            break;
        }
    }
    out
}

fn estimate_minutes(text: &str, policy: &DecomposePolicy) -> usize {
    let words = word_count(text);
    let mut minutes = 1;
    if words > 8 {
        minutes = 2;
    }
    if words > 14 {
        minutes = 3;
    }
    if words > 24 {
        minutes = 4;
    }
    if words > 34 {
        minutes = 5;
    }
    minutes.clamp(policy.min_minutes, policy.max_minutes)
}

fn infer_capability(text: &str) -> Capability {
    let lower = text.to_lowercase();
    if Regex::new(r"\b(email|slack|discord|message|notify|outreach)\b")
        .expect("valid regex")
        .is_match(lower.as_str())
    {
        return Capability {
            capability_id: "comms_message".to_string(),
            adapter_kind: "email_message".to_string(),
            source_type: "comms".to_string(),
        };
    }
    if Regex::new(r"\b(browser|web|site|ui|form|click|navigate)\b")
        .expect("valid regex")
        .is_match(lower.as_str())
    {
        return Capability {
            capability_id: "browser_task".to_string(),
            adapter_kind: "browser_task".to_string(),
            source_type: "web_ui".to_string(),
        };
    }
    if Regex::new(r"\b(api|http|endpoint|request|json|graphql|webhook)\b")
        .expect("valid regex")
        .is_match(lower.as_str())
    {
        return Capability {
            capability_id: "api_request".to_string(),
            adapter_kind: "http_request".to_string(),
            source_type: "api".to_string(),
        };
    }
    if Regex::new(r"\b(file|document|write|save|edit|patch|code)\b")
        .expect("valid regex")
        .is_match(lower.as_str())
    {
        return Capability {
            capability_id: "filesystem_task".to_string(),
            adapter_kind: "filesystem_task".to_string(),
            source_type: "filesystem".to_string(),
        };
    }
    if Regex::new(r"\b(test|verify|assert|validate|check)\b")
        .expect("valid regex")
        .is_match(lower.as_str())
    {
        return Capability {
            capability_id: "quality_check".to_string(),
            adapter_kind: "shell_task".to_string(),
            source_type: "analysis".to_string(),
        };
    }
    if Regex::new(r"\b(research|analyze|summarize|read|investigate)\b")
        .expect("valid regex")
        .is_match(lower.as_str())
    {
        return Capability {
            capability_id: "analysis_task".to_string(),
            adapter_kind: "shell_task".to_string(),
            source_type: "analysis".to_string(),
        };
    }
    Capability {
        capability_id: "general_task".to_string(),
        adapter_kind: "shell_task".to_string(),
        source_type: "analysis".to_string(),
    }
}

fn title_for_task(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().take(9).collect();
    if words.is_empty() {
        return "Micro Task".to_string();
    }
    let joined = words.join(" ");
    let mut chars = joined.chars();
    if let Some(first) = chars.next() {
        first.to_uppercase().collect::<String>() + chars.as_str()
    } else {
        "Micro Task".to_string()
    }
}

fn success_criteria(text: &str) -> Vec<String> {
    vec![
        format!("Execute: {}", clean_text(text, 180)),
        "Capture a receipt and link outcome to objective context.".to_string(),
    ]
}

fn normalize_keyword_rows(rows: &[String]) -> Vec<String> {
    rows.iter()
        .map(|row| normalize_token(row.as_str(), 80))
        .filter(|row| !row.is_empty())
        .collect()
}

fn lane_for_task(task_text: &str, policy: &DecomposePolicy) -> String {
    let lower = normalize_token(task_text, 500);
    let human_hits = normalize_keyword_rows(&policy.human_lane_keywords)
        .iter()
        .filter(|kw| lower.contains(kw.as_str()))
        .count();
    let auto_hits = normalize_keyword_rows(&policy.autonomous_lane_keywords)
        .iter()
        .filter(|kw| lower.contains(kw.as_str()))
        .count();
    if human_hits > auto_hits {
        policy.storm_lane.clone()
    } else {
        policy.default_lane.clone()
    }
}

fn normalize_capability(raw: &Capability) -> Capability {
    let capability_id = normalize_token(raw.capability_id.as_str(), 80);
    let adapter_kind = normalize_token(raw.adapter_kind.as_str(), 80);
    let source_type = normalize_token(raw.source_type.as_str(), 80);
    Capability {
        capability_id: if capability_id.is_empty() {
            "general_task".to_string()
        } else {
            capability_id
        },
        adapter_kind: if adapter_kind.is_empty() {
            "shell_task".to_string()
        } else {
            adapter_kind
        },
        source_type: if source_type.is_empty() {
            "analysis".to_string()
        } else {
            source_type
        },
    }
}

pub fn compose_micro_tasks(req: &ComposeRequest) -> Vec<Value> {
    let run_id = if req.run_id.trim().is_empty() {
        format!(
            "tdp_compose_{}",
            sha16(format!("{}|{}", req.goal_id, req.goal_text).as_str())
        )
    } else {
        req.run_id.trim().to_string()
    };
    let max_groups = req.policy.max_groups.max(1);
    let default_lane = {
        let lane = normalize_token(req.policy.default_lane.as_str(), 80);
        if lane.is_empty() {
            "autonomous_micro_agent".to_string()
        } else {
            lane
        }
    };

    req.tasks
        .iter()
        .enumerate()
        .filter_map(|(i, base)| {
            let task_text = clean_text(base.task_text.as_str(), 1000);
            if task_text.is_empty() {
                return None;
            }

            let micro_task_id = {
                let normalized = normalize_token(base.micro_task_id.as_str(), 120);
                if normalized.is_empty() {
                    format!(
                        "mt_{}",
                        sha16(format!("{}|{}|{}", run_id, i, task_text).as_str())
                    )
                } else {
                    normalized
                }
            };
            let profile_id = {
                let normalized = normalize_token(base.profile_id.as_str(), 120);
                if normalized.is_empty() {
                    format!(
                        "task_micro_{}",
                        sha16(format!("{}|{}", req.goal_id, micro_task_id).as_str())
                    )
                } else {
                    normalized
                }
            };
            let capability = normalize_capability(&base.capability);
            let suggested_lane = {
                let lane = normalize_token(base.suggested_lane.as_str(), 80);
                if lane.is_empty() {
                    default_lane.clone()
                } else {
                    lane
                }
            };
            let minutes = base
                .estimated_minutes
                .clamp(req.policy.min_minutes.max(1), req.policy.max_minutes.max(1));
            let success_criteria = if base.success_criteria.is_empty() {
                success_criteria(task_text.as_str())
            } else {
                base.success_criteria
                    .iter()
                    .map(|row| clean_text(row.as_str(), 220))
                    .filter(|row| !row.is_empty())
                    .collect::<Vec<String>>()
            };
            let parallel_priority = if base.parallel_priority.is_finite() {
                (base.parallel_priority * 10_000f64).round() / 10_000f64
            } else {
                (1f64 / minutes.max(1) as f64 * 10_000f64).round() / 10_000f64
            };
            let title = {
                let normalized = clean_text(base.title.as_str(), 220);
                if normalized.is_empty() {
                    title_for_task(task_text.as_str())
                } else {
                    normalized
                }
            };
            let objective_id = req.objective_id.clone();
            let creator_id = req.creator_id.clone();
            Some(json!({
                "micro_task_id": micro_task_id,
                "goal_id": req.goal_id,
                "objective_id": objective_id,
                "parent_id": base.parent_id,
                "depth": base.depth,
                "index": base.index,
                "title": title,
                "task_text": task_text,
                "estimated_minutes": minutes,
                "success_criteria": success_criteria,
                "required_capability": capability.capability_id,
                "profile_id": profile_id,
                "capability": capability,
                "route": {
                    "lane": suggested_lane,
                    "parallel_group": base.parallel_group.min(max_groups.saturating_sub(1)),
                    "parallel_priority": parallel_priority,
                    "blocked": false,
                    "requires_manual_review": false
                },
                "profile": {
                    "schema_id": "task_micro_profile",
                    "schema_version": "1.0",
                    "profile_id": profile_id,
                    "source": {
                        "source_type": capability.source_type,
                        "capability_id": capability.capability_id,
                        "objective_id": objective_id,
                        "origin_lane": "task_decomposition_primitive"
                    },
                    "intent": {
                        "id": "micro_task_execute",
                        "description": task_text,
                        "success_criteria": success_criteria
                    },
                    "execution": {
                        "adapter_kind": capability.adapter_kind,
                        "estimated_minutes": minutes,
                        "dry_run_default": true
                    },
                    "routing": {
                        "preferred_lane": suggested_lane,
                        "requires_manual_review": false
                    },
                    "provenance": {
                        "confidence": 0.92,
                        "evidence": {
                            "decomposition_depth": base.depth,
                            "heroic_echo_decision": "allow",
                            "constitution_decision": "ALLOW"
                        }
                    },
                    "governance": {
                        "heroic_echo": {
                            "classification": "normal",
                            "decision": "allow",
                            "reason_codes": []
                        },
                        "constitution": {
                            "decision": "ALLOW",
                            "risk": "low",
                            "reasons": []
                        }
                    },
                    "attribution": {
                        "source_goal_id": req.goal_id,
                        "source_goal_hash": sha16(req.goal_text.as_str()),
                        "creator_id": creator_id,
                        "influence_score": 1,
                        "lineage": [req.goal_id, micro_task_id]
                    },
                    "duality": {
                        "enabled": false,
                        "score_trit": 0,
                        "score_label": "unknown",
                        "zero_point_harmony_potential": 0,
                        "recommended_adjustment": Value::Null,
                        "indicator": {
                            "subtle_hint": "duality_signal_pending"
                        }
                    }
                },
                "governance": {
                    "blocked": false,
                    "block_reasons": [],
                    "heroic_echo": {
                        "classification": "normal",
                        "decision": "allow",
                        "blocked": false,
                        "reason_codes": []
                    },
                    "constitution": {
                        "decision": "ALLOW",
                        "risk": "low",
                        "reasons": []
                    }
                },
                "duality": {
                    "enabled": false,
                    "score_trit": 0,
                    "score_label": "unknown",
                    "zero_point_harmony_potential": 0,
                    "recommended_adjustment": Value::Null,
                    "indicator": {
                        "subtle_hint": "duality_signal_pending"
                    }
                }
            }))
        })
        .collect()
}

pub fn decompose_goal(req: &DecomposeRequest) -> Vec<BaseTask> {
    let run_id = if req.run_id.trim().is_empty() {
        format!(
            "tdp_{}",
            sha16(format!("{}|{}", req.goal_id, req.goal_text).as_str())
        )
    } else {
        req.run_id.trim().to_string()
    };
    let max_items = req.policy.max_micro_tasks.max(1);
    let segments = dedupe_segments(
        recursive_decompose(req.goal_text.as_str(), 0, &req.policy, None),
        max_items,
    );

    let mut tasks: Vec<BaseTask> = Vec::new();
    for (i, seg) in segments.into_iter().enumerate() {
        let task_text = clean_text(seg.text.as_str(), 1000);
        if task_text.is_empty() {
            continue;
        }
        let micro_task_id = format!(
            "mt_{}",
            sha16(format!("{}|{}|{}", run_id, i, task_text).as_str())
        );
        let capability = infer_capability(task_text.as_str());
        let minutes = estimate_minutes(task_text.as_str(), &req.policy);
        let profile_id = format!(
            "task_micro_{}",
            sha16(format!("{}|{}", req.goal_id, micro_task_id).as_str())
        );
        let lane = lane_for_task(task_text.as_str(), &req.policy);
        tasks.push(BaseTask {
            micro_task_id,
            goal_id: req.goal_id.clone(),
            objective_id: req.objective_id.clone(),
            parent_id: seg.parent_id,
            depth: seg.depth,
            index: i,
            title: title_for_task(task_text.as_str()),
            task_text: task_text.clone(),
            estimated_minutes: minutes,
            success_criteria: success_criteria(task_text.as_str()),
            required_capability: capability.capability_id.clone(),
            profile_id,
            capability,
            suggested_lane: lane,
            parallel_group: i % req.policy.max_groups.max(1),
            parallel_priority: 1f64 / (minutes.max(1) as f64),
        });
    }

    let human_count = tasks
        .iter()
        .filter(|task| task.suggested_lane == req.policy.storm_lane)
        .count();
    let human_share = if tasks.is_empty() {
        0f64
    } else {
        human_count as f64 / tasks.len() as f64
    };
    if tasks.len() > 2 && human_share < req.policy.min_storm_share {
        if let Some(first) = tasks.first_mut() {
            first.suggested_lane = req.policy.storm_lane.clone();
        }
    }

    tasks
}

pub fn decompose_goal_json(payload: &str) -> Result<String, String> {
    let req = serde_json::from_str::<DecomposeRequest>(payload)
        .map_err(|err| format!("decompose_payload_parse_failed:{}", err))?;
    let resp = DecomposeResponse {
        ok: true,
        tasks: decompose_goal(&req),
    };
    serde_json::to_string(&resp)
        .map_err(|err| format!("decompose_payload_serialize_failed:{}", err))
}

pub fn compose_micro_tasks_json(payload: &str) -> Result<String, String> {
    let req = serde_json::from_str::<ComposeRequest>(payload)
        .map_err(|err| format!("compose_payload_parse_failed:{}", err))?;
    let resp = ComposeResponse {
        ok: true,
        tasks: compose_micro_tasks(&req),
    };
    serde_json::to_string(&resp).map_err(|err| format!("compose_payload_serialize_failed:{}", err))
}

pub fn summarize_tasks(tasks: &[Value], shadow_only: bool, apply_executed: bool) -> Value {
    let mut lane_breakdown: BTreeMap<String, u64> = BTreeMap::new();
    let mut ready = 0u64;
    let mut blocked = 0u64;
    let mut manual_review = 0u64;
    let mut autonomous_lane = 0u64;
    let mut storm_lane = 0u64;

    for task in tasks {
        let route = task.get("route").and_then(|v| v.as_object());
        let governance = task.get("governance").and_then(|v| v.as_object());

        let lane = route
            .and_then(|row| row.get("lane"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let is_blocked = governance
            .and_then(|row| row.get("blocked"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let is_manual = route
            .and_then(|row| row.get("requires_manual_review"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        *lane_breakdown.entry(lane.clone()).or_insert(0) += 1;
        if is_blocked {
            blocked += 1;
        } else {
            ready += 1;
        }
        if is_manual {
            manual_review += 1;
        }
        if lane == "autonomous_micro_agent" {
            autonomous_lane += 1;
        }
        if lane == "storm_human_lane" {
            storm_lane += 1;
        }
    }

    json!({
        "total_micro_tasks": tasks.len(),
        "ready": ready,
        "blocked": blocked,
        "manual_review": manual_review,
        "autonomous_lane": autonomous_lane,
        "storm_lane": storm_lane,
        "lane_breakdown": lane_breakdown,
        "shadow_only": shadow_only,
        "apply_executed": apply_executed
    })
}

pub fn summarize_tasks_json(payload: &str) -> Result<String, String> {
    let req = serde_json::from_str::<TaskSummaryRequest>(payload)
        .map_err(|err| format!("task_summary_payload_parse_failed:{}", err))?;
    let resp = TaskSummaryResponse {
        ok: true,
        summary: summarize_tasks(&req.tasks, req.shadow_only, req.apply_executed),
    };
    serde_json::to_string(&resp)
        .map_err(|err| format!("task_summary_payload_serialize_failed:{}", err))
}

pub fn summarize_dispatch(rows: &[Value], enabled: bool) -> Value {
    let mut queued = 0u64;
    let mut executed = 0u64;
    let mut failed = 0u64;
    let mut blocked = 0u64;

    for row in rows {
        let status = row
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        match status {
            "queued" => queued += 1,
            "executed" => executed += 1,
            "failed" => failed += 1,
            "blocked" => blocked += 1,
            _ => {}
        }
    }

    json!({
        "enabled": enabled,
        "total": rows.len(),
        "queued": queued,
        "executed": executed,
        "failed": failed,
        "blocked": blocked
    })
}

pub fn summarize_dispatch_json(payload: &str) -> Result<String, String> {
    let req = serde_json::from_str::<DispatchSummaryRequest>(payload)
        .map_err(|err| format!("dispatch_summary_payload_parse_failed:{}", err))?;
    let resp = DispatchSummaryResponse {
        ok: true,
        summary: summarize_dispatch(&req.rows, req.enabled),
    };
    serde_json::to_string(&resp)
        .map_err(|err| format!("dispatch_summary_payload_serialize_failed:{}", err))
}

fn duality_indicator_for_task(task: &Value) -> Value {
    task.get("duality")
        .and_then(|row| row.get("indicator"))
        .cloned()
        .unwrap_or_else(|| json!({ "subtle_hint": "duality_signal_absent" }))
}

fn attribution_for_task(task: &Value) -> Value {
    task.get("profile")
        .and_then(|row| row.get("attribution"))
        .cloned()
        .unwrap_or_else(|| json!({}))
}

pub fn build_queue_rows(req: &QueueRowsRequest) -> (Vec<Value>, Vec<Value>) {
    let mut weaver: Vec<Value> = Vec::new();
    let mut storm: Vec<Value> = Vec::new();

    for task in &req.tasks {
        let route = task.get("route").and_then(|v| v.as_object());
        let lane = route
            .and_then(|row| row.get("lane"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let blocked = route
            .and_then(|row| row.get("blocked"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let manual = route
            .and_then(|row| row.get("requires_manual_review"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let parallel_group = route
            .and_then(|row| row.get("parallel_group"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let parallel_priority = route
            .and_then(|row| row.get("parallel_priority"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);

        let weaver_row = json!({
            "type": "task_micro_route_candidate",
            "run_id": req.run_id,
            "goal_id": req.goal_id,
            "objective_id": req.objective_id,
            "micro_task_id": task.get("micro_task_id").cloned().unwrap_or(Value::Null),
            "profile_id": task.get("profile_id").cloned().unwrap_or(Value::Null),
            "lane": lane,
            "parallel_group": parallel_group,
            "parallel_priority": parallel_priority,
            "blocked": blocked,
            "requires_manual_review": manual,
            "shadow_only": req.shadow_only,
            "passport_id": req.passport_id,
            "duality_indicator": duality_indicator_for_task(task),
            "attribution": attribution_for_task(task)
        });
        weaver.push(weaver_row);

        if lane == req.storm_lane && !blocked {
            let storm_row = json!({
                "type": "storm_micro_task_offer",
                "run_id": req.run_id,
                "goal_id": req.goal_id,
                "objective_id": req.objective_id,
                "micro_task_id": task.get("micro_task_id").cloned().unwrap_or(Value::Null),
                "title": task.get("title").cloned().unwrap_or(Value::Null),
                "task_text": task.get("task_text").cloned().unwrap_or(Value::Null),
                "estimated_minutes": task.get("estimated_minutes").cloned().unwrap_or(Value::Null),
                "success_criteria": task.get("success_criteria").cloned().unwrap_or_else(|| json!([])),
                "profile_id": task.get("profile_id").cloned().unwrap_or(Value::Null),
                "shadow_only": req.shadow_only,
                "passport_id": req.passport_id,
                "duality_indicator": duality_indicator_for_task(task)
            });
            storm.push(storm_row);
        }
    }

    (weaver, storm)
}

pub fn queue_rows_json(payload: &str) -> Result<String, String> {
    let req = serde_json::from_str::<QueueRowsRequest>(payload)
        .map_err(|err| format!("queue_rows_payload_parse_failed:{}", err))?;
    let (weaver, storm) = build_queue_rows(&req);
    let resp = QueueRowsResponse {
        ok: true,
        weaver,
        storm,
    };
    serde_json::to_string(&resp)
        .map_err(|err| format!("queue_rows_payload_serialize_failed:{}", err))
}

pub fn build_dispatch_rows(req: &DispatchRowsRequest) -> Vec<Value> {
    let storm_lane = {
        let lane = normalize_token(req.storm_lane.as_str(), 80);
        if lane.is_empty() {
            default_storm_lane()
        } else {
            lane
        }
    };
    let autonomous_executor = {
        let executor = normalize_token(req.autonomous_executor.as_str(), 80);
        if executor.is_empty() {
            default_autonomous_executor()
        } else {
            executor
        }
    };
    let storm_executor = {
        let executor = normalize_token(req.storm_executor.as_str(), 80);
        if executor.is_empty() {
            default_storm_executor()
        } else {
            executor
        }
    };

    req.tasks
        .iter()
        .map(|task| {
            let route = task.get("route").and_then(|v| v.as_object());
            let governance = task.get("governance").and_then(|v| v.as_object());
            let lane = {
                let normalized = normalize_token(
                    route
                        .and_then(|row| row.get("lane"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown"),
                    80,
                );
                if normalized.is_empty() {
                    "unknown".to_string()
                } else {
                    normalized
                }
            };
            let blocked = governance
                .and_then(|row| row.get("blocked"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let executor = if lane == storm_lane {
                storm_executor.clone()
            } else {
                autonomous_executor.clone()
            };

            json!({
                "type": "task_micro_execution_dispatch",
                "run_id": req.run_id,
                "goal_id": req.goal_id,
                "objective_id": req.objective_id,
                "micro_task_id": task.get("micro_task_id").cloned().unwrap_or(Value::Null),
                "profile_id": task.get("profile_id").cloned().unwrap_or(Value::Null),
                "lane": lane,
                "executor": executor,
                "blocked": blocked,
                "shadow_only": req.shadow_only,
                "apply_executed": req.apply_executed,
                "status": if blocked { "blocked" } else { "queued" },
                "passport_id": req.passport_id
            })
        })
        .collect()
}

pub fn dispatch_rows_json(payload: &str) -> Result<String, String> {
    let req = serde_json::from_str::<DispatchRowsRequest>(payload)
        .map_err(|err| format!("dispatch_rows_payload_parse_failed:{}", err))?;
    let resp = DispatchRowsResponse {
        ok: true,
        rows: build_dispatch_rows(&req),
    };
    serde_json::to_string(&resp)
        .map_err(|err| format!("dispatch_rows_payload_serialize_failed:{}", err))
}

fn contains_any(source: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| source.contains(needle))
}

fn is_trust_registry_modification(task_lower: &str) -> bool {
    let trust_targets = [
        "trust_registry",
        "trust registry",
        "trust_add",
        "trust_remove",
        "memory/tools/trust_add.js",
        "memory/trust/registry.json",
        "registry.json",
        "registry hashes",
        "trust registry hashes",
    ];
    let mutation_verbs = [
        "edit", "modify", "update", "patch", "delete", "remove", "tamper", "change",
    ];
    contains_any(task_lower, &trust_targets) && contains_any(task_lower, &mutation_verbs)
}

fn set_manual(decision: &mut String) {
    if decision != "DENY" {
        *decision = "MANUAL".to_string();
    }
}

pub fn evaluate_directive_gate(task_text: &str) -> DirectiveGateResponse {
    let task = task_text.trim();
    if task.is_empty() {
        return DirectiveGateResponse {
            ok: true,
            decision: "DENY".to_string(),
            risk: "high".to_string(),
            reasons: vec!["Task must be a non-empty string".to_string()],
        };
    }

    let mut reasons: Vec<String> = Vec::new();
    let mut decision = "ALLOW".to_string();
    let mut risk = "low".to_string();
    let task_lower = task.to_ascii_lowercase();

    let deny_patterns = [
        (
            "bypass gate",
            r"\b(bypass.*gate|disable.*gate|skip.*gate)\b",
        ),
        (
            "disable log",
            r"\b(disable.*log|stop.*log|suppress.*event|remove.*audit)\b",
        ),
        (
            "tamper trust",
            r"\b(tamper|modify|edit|delete)\b.*\b(trust|hash|registry)\b",
        ),
        (
            "modify gate",
            r"\b(modify|edit|delete)\b.*\b(directive_gate)\b",
        ),
    ];
    for (label, pattern) in deny_patterns {
        if Regex::new(pattern)
            .ok()
            .map(|regex| regex.is_match(task))
            .unwrap_or(false)
        {
            reasons.push(format!("T0 violation: {} detected", label));
            decision = "DENY".to_string();
            risk = "high".to_string();
        }
    }
    if is_trust_registry_modification(&task_lower) {
        reasons.push("T0 violation: trust registry modification detected".to_string());
        decision = "DENY".to_string();
        risk = "high".to_string();
    }

    let high_risk_patterns = [
        (
            "High-risk: process execution detected",
            "high",
            r"\b(child_process|exec|execsync|spawn|fork|execfile)\b",
        ),
        (
            "High-risk: shell execution detected",
            "high",
            r"\b(shell|bash|sh\s|cmd\.exe|powershell)\b",
        ),
        (
            "High-risk: credentials/token access detected",
            "high",
            r"\.openclaw[\/\\]credentials|\/credentials[\/\\]|token|api[_-]?key|secret|password",
        ),
        (
            "High-risk: network/API call detected",
            "medium",
            r"\b(http|https|fetch|axios|request|curl|wget|net\.|tls\.|socket)\b",
        ),
        (
            "High-risk: git remote operation detected",
            "high",
            r"\b(git\s+(push|force|reset|rebase|merge)|push\s+to|push\s+--|origin|publish|deploy)\b",
        ),
        (
            "High-risk: cron/system config modification detected",
            "high",
            r"\b(cron|crontab|systemd|service|daemon)\b",
        ),
        (
            "High-risk: revenue/financial action detected",
            "high",
            r"\b(payment|billing|subscription|charge|refund|account.*money|revenue)\b",
        ),
        (
            "High-risk: governance/security tooling modification detected",
            "high",
            r"\b(trust[_-]?|verify[_-]?hash|tamper|bypass|disable.*log|registry.*hash)\b",
        ),
        (
            "High-risk: governance/security tooling modification detected",
            "high",
            r"\b(trust_add|trust_remove|trust_registry|registry\.json)\b",
        ),
    ];
    for (message, severity, pattern) in high_risk_patterns {
        if Regex::new(pattern)
            .ok()
            .map(|regex| regex.is_match(task))
            .unwrap_or(false)
        {
            reasons.push(message.to_string());
            risk = severity.to_string();
            set_manual(&mut decision);
        }
    }

    let path_regex = Regex::new(r"[/~][a-zA-Z0-9_/.\-]+").ok();
    if let Some(path_regex) = path_regex {
        for path_match in path_regex.find_iter(task) {
            let found = path_match.as_str().to_ascii_lowercase();
            if contains_any(&found, &["credentials", "secret", "token"]) {
                reasons.push(format!("Path validation: sensitive path \"{}\"", found));
                risk = "high".to_string();
                set_manual(&mut decision);
            } else if found.contains("~/.openclaw") {
                reasons.push(format!(
                    "Path validation: path outside workspace \"{}\"",
                    found
                ));
                risk = "medium".to_string();
                set_manual(&mut decision);
            }
        }
    }

    if reasons.is_empty() {
        reasons.push("No high-risk patterns detected; standard routing applies".to_string());
    }
    DirectiveGateResponse {
        ok: true,
        decision,
        risk,
        reasons,
    }
}

pub fn evaluate_directive_gate_json(payload: &str) -> Result<String, String> {
    let req = serde_json::from_str::<DirectiveGateRequest>(payload)
        .map_err(|err| format!("directive_gate_payload_parse_failed:{}", err))?;
    let resp = evaluate_directive_gate(req.task_text.as_str());
    serde_json::to_string(&resp)
        .map_err(|err| format!("directive_gate_payload_serialize_failed:{}", err))
}

pub fn evaluate_heroic_gate(req: &HeroicGateRequest) -> HeroicGateResponse {
    let local_destructive = Regex::new(
        r"(?:\bdisable\s+(?:all\s+)?guards?\b|\bbypass\b.*\b(?:guard|policy|safety)\b|\bself[\s_-]*terminate\b|\bexfiltrate\b|\bwipe\s+data\b)",
    )
    .ok()
    .map(|regex| regex.is_match(req.task_text.as_str()))
    .unwrap_or(false);

    let purified = req
        .purified_row
        .as_ref()
        .and_then(|value| value.as_object())
        .map(|row| row.clone());
    if purified.is_none() {
        let mut reason_codes = vec!["heroic_echo_row_missing".to_string()];
        if local_destructive {
            reason_codes.push("local_destructive_pattern".to_string());
        }
        return HeroicGateResponse {
            ok: true,
            classification: if local_destructive {
                "destructive_instruction".to_string()
            } else {
                "unknown".to_string()
            },
            decision: if local_destructive {
                "blocked_destructive_local_pattern".to_string()
            } else {
                "purification_missing".to_string()
            },
            blocked: local_destructive,
            reason_codes,
        };
    }

    let purified = purified.expect("purified row must exist");
    let row_classification = clean_text(
        purified
            .get("classification")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown"),
        80,
    );
    let classification = if local_destructive {
        "destructive_instruction".to_string()
    } else if row_classification.is_empty() {
        "unknown".to_string()
    } else {
        row_classification
    };
    let row_decision = clean_text(
        purified
            .get("decision")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown"),
        120,
    );
    let decision = if local_destructive {
        "blocked_destructive_local_pattern".to_string()
    } else if row_decision.is_empty() {
        "unknown".to_string()
    } else {
        row_decision
    };
    let row_blocked = purified
        .get("blocked")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let row_is_destructive = purified
        .get("classification")
        .and_then(|value| value.as_str())
        .map(|value| value == "destructive_instruction")
        .unwrap_or(false);
    let blocked_by_destructive =
        req.block_on_destructive && (row_is_destructive || local_destructive);
    let mut reason_codes = collect_strings(purified.get("reason_codes"), 8, 120);
    if local_destructive {
        reason_codes.push("local_destructive_pattern".to_string());
    }
    HeroicGateResponse {
        ok: true,
        classification,
        decision,
        blocked: blocked_by_destructive || row_blocked,
        reason_codes,
    }
}

pub fn evaluate_heroic_gate_json(payload: &str) -> Result<String, String> {
    let req = serde_json::from_str::<HeroicGateRequest>(payload)
        .map_err(|err| format!("heroic_gate_payload_parse_failed:{}", err))?;
    let resp = evaluate_heroic_gate(&req);
    serde_json::to_string(&resp)
        .map_err(|err| format!("heroic_gate_payload_serialize_failed:{}", err))
}

fn ensure_object(value: &mut Value) -> &mut serde_json::Map<String, Value> {
    if !value.is_object() {
        *value = json!({});
    }
    value.as_object_mut().expect("value should be object")
}

fn collect_strings(value: Option<&Value>, max_items: usize, max_len: usize) -> Vec<String> {
    value
        .and_then(|row| row.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.as_str())
                .map(|row| clean_text(row, max_len))
                .filter(|row| !row.is_empty())
                .take(max_items)
                .collect::<Vec<String>>()
        })
        .unwrap_or_default()
}

fn numeric_or_zero(value: Option<&Value>) -> f64 {
    value
        .and_then(|row| row.as_f64().or_else(|| row.as_i64().map(|v| v as f64)))
        .unwrap_or(0.0)
}

pub fn apply_governance(req: &GovernanceApplyRequest) -> Vec<Value> {
    let storm_lane = {
        let lane = normalize_token(req.policy.storm_lane.as_str(), 80);
        if lane.is_empty() {
            default_storm_lane()
        } else {
            lane
        }
    };
    let default_lane = {
        let lane = normalize_token(req.policy.default_lane.as_str(), 80);
        if lane.is_empty() {
            default_lane()
        } else {
            lane
        }
    };
    let min_storm_share = req.policy.min_storm_share.clamp(0.0, 1.0);
    let mut tasks: Vec<Value> = Vec::new();

    for row in &req.rows {
        let source_task = row.get("task").cloned().unwrap_or(Value::Null);
        if !source_task.is_object() {
            continue;
        }
        let mut task = source_task;
        let task_text = clean_text(
            task.get("task_text").and_then(|v| v.as_str()).unwrap_or(""),
            1000,
        );
        if task_text.is_empty() {
            continue;
        }

        let heroic = row.get("heroic").cloned().unwrap_or_else(|| json!({}));
        let heroic_classification = {
            let value = clean_text(
                heroic
                    .get("classification")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown"),
                80,
            );
            if value.is_empty() {
                "unknown".to_string()
            } else {
                value
            }
        };
        let heroic_decision = {
            let value = clean_text(
                heroic
                    .get("decision")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown"),
                80,
            );
            if value.is_empty() {
                "unknown".to_string()
            } else {
                value
            }
        };
        let heroic_blocked = heroic
            .get("blocked")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let heroic_reason_codes = collect_strings(heroic.get("reason_codes"), 8, 120);

        let constitution = row
            .get("constitution")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let constitution_decision = {
            let value = clean_text(
                constitution
                    .get("decision")
                    .and_then(|v| v.as_str())
                    .unwrap_or("ALLOW"),
                40,
            );
            if value.is_empty() {
                "ALLOW".to_string()
            } else {
                value
            }
        };
        let constitution_risk = {
            let value = clean_text(
                constitution
                    .get("risk")
                    .and_then(|v| v.as_str())
                    .unwrap_or("low"),
                40,
            );
            if value.is_empty() {
                "low".to_string()
            } else {
                value
            }
        };
        let constitution_reasons = collect_strings(constitution.get("reasons"), 8, 120);

        let suggested_lane = {
            let row_lane = row
                .get("suggested_lane")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let task_lane = task
                .get("route")
                .and_then(|v| v.as_object())
                .and_then(|route| route.get("lane"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let candidate = if row_lane.trim().is_empty() {
                task_lane
            } else {
                row_lane
            };
            let normalized = normalize_token(candidate, 80);
            if normalized.is_empty() {
                default_lane.clone()
            } else {
                normalized
            }
        };
        let lane = if constitution_decision == "MANUAL" {
            storm_lane.clone()
        } else {
            suggested_lane
        };
        let blocked_by_constitution =
            req.policy.block_on_constitution_deny && constitution_decision == "DENY";
        let blocked = heroic_blocked || blocked_by_constitution;
        let requires_manual_review = constitution_decision == "MANUAL" || lane == storm_lane;

        let duality = row.get("duality").cloned().unwrap_or_else(|| json!({}));
        let duality_indicator = duality
            .get("indicator")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({ "subtle_hint": "duality_signal_absent" }));
        let duality_score_label = {
            let value = clean_text(
                duality
                    .get("score_label")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown"),
                40,
            );
            if value.is_empty() {
                "unknown".to_string()
            } else {
                value
            }
        };
        let recommended_adjustment = {
            let value = clean_text(
                duality
                    .get("recommended_adjustment")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
                120,
            );
            if value.is_empty() {
                Value::Null
            } else {
                Value::String(value)
            }
        };
        let duality_block = json!({
            "enabled": duality.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
            "score_trit": numeric_or_zero(duality.get("score_trit")),
            "score_label": duality_score_label,
            "zero_point_harmony_potential": numeric_or_zero(duality.get("zero_point_harmony_potential")),
            "recommended_adjustment": recommended_adjustment,
            "indicator": duality_indicator
        });

        let block_reasons = {
            let mut reasons: Vec<String> = Vec::new();
            if heroic_blocked {
                reasons.push("heroic_echo_blocked".to_string());
            }
            if blocked_by_constitution {
                reasons.push("constitution_denied".to_string());
            }
            reasons
        };

        {
            let task_obj = ensure_object(&mut task);
            let route = ensure_object(task_obj.entry("route").or_insert_with(|| json!({})));
            route.insert("lane".to_string(), Value::String(lane.clone()));
            route.insert("blocked".to_string(), Value::Bool(blocked));
            route.insert(
                "requires_manual_review".to_string(),
                Value::Bool(requires_manual_review),
            );

            task_obj.insert(
                "governance".to_string(),
                json!({
                    "blocked": blocked,
                    "block_reasons": block_reasons,
                    "heroic_echo": {
                        "classification": heroic_classification,
                        "decision": heroic_decision,
                        "blocked": heroic_blocked,
                        "reason_codes": heroic_reason_codes
                    },
                    "constitution": {
                        "decision": constitution_decision,
                        "risk": constitution_risk,
                        "reasons": constitution_reasons
                    }
                }),
            );
            task_obj.insert("duality".to_string(), duality_block.clone());

            let profile = ensure_object(task_obj.entry("profile").or_insert_with(|| json!({})));
            let routing = ensure_object(profile.entry("routing").or_insert_with(|| json!({})));
            routing.insert("preferred_lane".to_string(), Value::String(lane.clone()));
            routing.insert(
                "requires_manual_review".to_string(),
                Value::Bool(requires_manual_review),
            );

            let provenance =
                ensure_object(profile.entry("provenance").or_insert_with(|| json!({})));
            provenance.insert(
                "confidence".to_string(),
                Value::from(if blocked { 0.55 } else { 0.92 }),
            );
            let evidence = ensure_object(provenance.entry("evidence").or_insert_with(|| json!({})));
            evidence.insert(
                "heroic_echo_decision".to_string(),
                Value::String(heroic_decision.clone()),
            );
            evidence.insert(
                "constitution_decision".to_string(),
                Value::String(constitution_decision.clone()),
            );

            profile.insert(
                "governance".to_string(),
                json!({
                    "heroic_echo": {
                        "classification": heroic_classification,
                        "decision": heroic_decision,
                        "reason_codes": heroic_reason_codes
                    },
                    "constitution": {
                        "decision": constitution_decision,
                        "risk": constitution_risk,
                        "reasons": constitution_reasons
                    }
                }),
            );
            profile.insert("duality".to_string(), duality_block);
        }

        tasks.push(task);
    }

    let storm_count = tasks
        .iter()
        .filter(|task| {
            task.get("route")
                .and_then(|v| v.as_object())
                .and_then(|route| route.get("lane"))
                .and_then(|v| v.as_str())
                .map(|lane| lane == storm_lane)
                .unwrap_or(false)
        })
        .count();
    let storm_share = if tasks.is_empty() {
        0.0
    } else {
        storm_count as f64 / tasks.len() as f64
    };
    if tasks.len() > 2 && storm_share < min_storm_share {
        if let Some(task) = tasks.iter_mut().find(|task| {
            task.get("governance")
                .and_then(|v| v.as_object())
                .and_then(|governance| governance.get("constitution"))
                .and_then(|v| v.as_object())
                .and_then(|constitution| constitution.get("decision"))
                .and_then(|v| v.as_str())
                .map(|decision| decision != "DENY")
                .unwrap_or(true)
        }) {
            let task_obj = ensure_object(task);
            let route = ensure_object(task_obj.entry("route").or_insert_with(|| json!({})));
            route.insert("lane".to_string(), Value::String(storm_lane.clone()));
            route.insert("requires_manual_review".to_string(), Value::Bool(true));

            let profile = ensure_object(task_obj.entry("profile").or_insert_with(|| json!({})));
            let routing = ensure_object(profile.entry("routing").or_insert_with(|| json!({})));
            routing.insert(
                "preferred_lane".to_string(),
                Value::String(storm_lane.clone()),
            );
            routing.insert("requires_manual_review".to_string(), Value::Bool(true));
        }
    }

    tasks
}

pub fn apply_governance_json(payload: &str) -> Result<String, String> {
    let req = serde_json::from_str::<GovernanceApplyRequest>(payload)
        .map_err(|err| format!("apply_governance_payload_parse_failed:{}", err))?;
    let resp = GovernanceApplyResponse {
        ok: true,
        tasks: apply_governance(&req),
    };
    serde_json::to_string(&resp)
        .map_err(|err| format!("apply_governance_payload_serialize_failed:{}", err))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decompose_generates_micro_tasks() {
        let req = DecomposeRequest {
            run_id: "tdp_test".to_string(),
            goal_id: "goal_test".to_string(),
            goal_text: "Design a creative onboarding campaign and test API endpoint health checks then summarize findings".to_string(),
            objective_id: Some("obj_test".to_string()),
            creator_id: None,
            policy: DecomposePolicy {
                human_lane_keywords: vec!["creative".to_string(), "design".to_string()],
                autonomous_lane_keywords: vec!["test".to_string(), "api".to_string()],
                ..DecomposePolicy::default()
            },
        };
        let out = decompose_goal(&req);
        assert!(!out.is_empty());
        assert!(out.iter().all(|row| !row.micro_task_id.is_empty()));
        assert!(out.iter().all(|row| !row.profile_id.is_empty()));
    }

    #[test]
    fn compose_materializes_profiles_and_routes() {
        let req = ComposeRequest {
            run_id: "tdp_compose_test".to_string(),
            goal_id: "goal_compose".to_string(),
            goal_text: "Build and verify rollout checklist".to_string(),
            objective_id: Some("obj_compose".to_string()),
            creator_id: Some("jay".to_string()),
            policy: ComposePolicy::default(),
            tasks: vec![BaseTask {
                micro_task_id: "mt_a".to_string(),
                goal_id: "goal_compose".to_string(),
                objective_id: Some("obj_compose".to_string()),
                parent_id: None,
                depth: 0,
                index: 0,
                title: "Verify checklist".to_string(),
                task_text: "Verify checklist integrity and publish summary".to_string(),
                estimated_minutes: 3,
                success_criteria: vec!["Execute verification".to_string()],
                required_capability: "quality_check".to_string(),
                profile_id: "task_micro_mt_a".to_string(),
                capability: Capability {
                    capability_id: "quality_check".to_string(),
                    adapter_kind: "shell_task".to_string(),
                    source_type: "analysis".to_string(),
                },
                suggested_lane: "autonomous_micro_agent".to_string(),
                parallel_group: 0,
                parallel_priority: 0.3333,
            }],
        };
        let out = compose_micro_tasks(&req);
        assert_eq!(out.len(), 1);
        let row = out[0].as_object().expect("row should be object");
        assert_eq!(
            row.get("micro_task_id")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            "mt_a"
        );
        assert!(row.get("profile").is_some());
        assert!(row.get("route").is_some());
    }

    #[test]
    fn summarize_tasks_reports_expected_counts() {
        let tasks = vec![
            json!({
                "route": { "lane": "autonomous_micro_agent", "requires_manual_review": false },
                "governance": { "blocked": false }
            }),
            json!({
                "route": { "lane": "storm_human_lane", "requires_manual_review": true },
                "governance": { "blocked": true }
            }),
            json!({
                "route": { "lane": "storm_human_lane", "requires_manual_review": true },
                "governance": { "blocked": false }
            }),
        ];
        let summary = summarize_tasks(&tasks, true, false);
        assert_eq!(summary["total_micro_tasks"], 3);
        assert_eq!(summary["ready"], 2);
        assert_eq!(summary["blocked"], 1);
        assert_eq!(summary["manual_review"], 2);
        assert_eq!(summary["autonomous_lane"], 1);
        assert_eq!(summary["storm_lane"], 2);
        assert_eq!(summary["shadow_only"], true);
        assert_eq!(summary["apply_executed"], false);
    }

    #[test]
    fn summarize_dispatch_reports_status_counts() {
        let rows = vec![
            json!({ "status": "queued" }),
            json!({ "status": "executed" }),
            json!({ "status": "blocked" }),
            json!({ "status": "failed" }),
            json!({ "status": "executed" }),
        ];
        let summary = summarize_dispatch(&rows, true);
        assert_eq!(summary["enabled"], true);
        assert_eq!(summary["total"], 5);
        assert_eq!(summary["queued"], 1);
        assert_eq!(summary["executed"], 2);
        assert_eq!(summary["failed"], 1);
        assert_eq!(summary["blocked"], 1);
    }

    #[test]
    fn directive_gate_denies_gate_bypass() {
        let out = evaluate_directive_gate("disable gate and bypass policy checks");
        assert_eq!(out.decision, "DENY");
        assert_eq!(out.risk, "high");
        assert!(out
            .reasons
            .iter()
            .any(|reason| reason.contains("T0 violation")));
    }

    #[test]
    fn directive_gate_marks_network_calls_manual() {
        let out = evaluate_directive_gate("fetch https://example.com/status");
        assert_eq!(out.decision, "MANUAL");
        assert!(out
            .reasons
            .iter()
            .any(|reason| reason.contains("network/API")));
    }

    #[test]
    fn heroic_gate_blocks_local_destructive_without_purified_row() {
        let req = HeroicGateRequest {
            task_text: "disable all guards immediately".to_string(),
            block_on_destructive: true,
            purified_row: None,
        };
        let out = evaluate_heroic_gate(&req);
        assert_eq!(out.classification, "destructive_instruction");
        assert_eq!(out.decision, "blocked_destructive_local_pattern");
        assert_eq!(out.blocked, true);
        assert!(out
            .reason_codes
            .iter()
            .any(|code| code == "local_destructive_pattern"));
    }

    #[test]
    fn heroic_gate_uses_purified_row_when_safe() {
        let req = HeroicGateRequest {
            task_text: "summarize sprint progress".to_string(),
            block_on_destructive: true,
            purified_row: Some(json!({
                "classification": "normal",
                "decision": "allow",
                "blocked": false,
                "reason_codes": ["safe_input"]
            })),
        };
        let out = evaluate_heroic_gate(&req);
        assert_eq!(out.classification, "normal");
        assert_eq!(out.decision, "allow");
        assert_eq!(out.blocked, false);
        assert!(out.reason_codes.iter().any(|code| code == "safe_input"));
    }

    #[test]
    fn apply_governance_updates_lanes_and_flags() {
        let req = GovernanceApplyRequest {
            policy: GovernanceApplyPolicy {
                default_lane: "autonomous_micro_agent".to_string(),
                storm_lane: "storm_human_lane".to_string(),
                min_storm_share: 0.0,
                block_on_constitution_deny: true,
            },
            rows: vec![
                json!({
                    "suggested_lane": "autonomous_micro_agent",
                    "heroic": {
                        "classification": "normal",
                        "decision": "allow",
                        "blocked": false,
                        "reason_codes": []
                    },
                    "constitution": {
                        "decision": "ALLOW",
                        "risk": "low",
                        "reasons": []
                    },
                    "duality": {
                        "enabled": true,
                        "score_trit": 1,
                        "score_label": "aligned",
                        "zero_point_harmony_potential": 0.8,
                        "recommended_adjustment": "none",
                        "indicator": { "subtle_hint": "ok" }
                    },
                    "task": {
                        "micro_task_id": "mt_1",
                        "task_text": "verify rollout safety",
                        "route": { "lane": "autonomous_micro_agent", "parallel_group": 0, "parallel_priority": 0.5 },
                        "profile": {
                            "routing": {},
                            "provenance": { "evidence": { "decomposition_depth": 0 } }
                        }
                    }
                }),
                json!({
                    "suggested_lane": "autonomous_micro_agent",
                    "heroic": {
                        "classification": "normal",
                        "decision": "allow",
                        "blocked": false,
                        "reason_codes": []
                    },
                    "constitution": {
                        "decision": "MANUAL",
                        "risk": "medium",
                        "reasons": ["human_judgment"]
                    },
                    "duality": {},
                    "task": {
                        "micro_task_id": "mt_2",
                        "task_text": "design campaign direction",
                        "route": { "lane": "autonomous_micro_agent", "parallel_group": 1, "parallel_priority": 0.4 },
                        "profile": {
                            "routing": {},
                            "provenance": { "evidence": { "decomposition_depth": 0 } }
                        }
                    }
                }),
            ],
        };
        let tasks = apply_governance(&req);
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0]["route"]["lane"], "autonomous_micro_agent");
        assert_eq!(tasks[0]["governance"]["blocked"], false);
        assert_eq!(
            tasks[0]["profile"]["routing"]["requires_manual_review"],
            false
        );
        assert_eq!(tasks[0]["duality"]["score_label"], "aligned");

        assert_eq!(tasks[1]["route"]["lane"], "storm_human_lane");
        assert_eq!(tasks[1]["route"]["requires_manual_review"], true);
        assert_eq!(tasks[1]["governance"]["constitution"]["decision"], "MANUAL");
    }

    #[test]
    fn apply_governance_enforces_min_storm_share() {
        let req = GovernanceApplyRequest {
            policy: GovernanceApplyPolicy {
                min_storm_share: 0.34,
                ..GovernanceApplyPolicy::default()
            },
            rows: vec![
                json!({
                    "suggested_lane": "autonomous_micro_agent",
                    "heroic": { "blocked": false },
                    "constitution": { "decision": "ALLOW", "risk": "low", "reasons": [] },
                    "duality": {},
                    "task": { "micro_task_id": "mt_a", "task_text": "a", "route": { "lane": "autonomous_micro_agent" }, "profile": { "routing": {} } }
                }),
                json!({
                    "suggested_lane": "autonomous_micro_agent",
                    "heroic": { "blocked": false },
                    "constitution": { "decision": "ALLOW", "risk": "low", "reasons": [] },
                    "duality": {},
                    "task": { "micro_task_id": "mt_b", "task_text": "b", "route": { "lane": "autonomous_micro_agent" }, "profile": { "routing": {} } }
                }),
                json!({
                    "suggested_lane": "autonomous_micro_agent",
                    "heroic": { "blocked": false },
                    "constitution": { "decision": "ALLOW", "risk": "low", "reasons": [] },
                    "duality": {},
                    "task": { "micro_task_id": "mt_c", "task_text": "c", "route": { "lane": "autonomous_micro_agent" }, "profile": { "routing": {} } }
                }),
            ],
        };
        let tasks = apply_governance(&req);
        let storm_count = tasks
            .iter()
            .filter(|task| task["route"]["lane"] == "storm_human_lane")
            .count();
        assert!(storm_count >= 1);
    }

    #[test]
    fn build_queue_rows_emits_weaver_and_storm_shapes() {
        let req = QueueRowsRequest {
            run_id: "run_a".to_string(),
            goal_id: "goal_a".to_string(),
            objective_id: Some("obj_a".to_string()),
            shadow_only: true,
            passport_id: Some("passport_a".to_string()),
            storm_lane: "storm_human_lane".to_string(),
            tasks: vec![
                json!({
                    "micro_task_id": "mt_1",
                    "profile_id": "p_1",
                    "title": "Task One",
                    "task_text": "Do task one",
                    "estimated_minutes": 2,
                    "success_criteria": ["A"],
                    "route": {
                        "lane": "autonomous_micro_agent",
                        "parallel_group": 0,
                        "parallel_priority": 0.5,
                        "blocked": false,
                        "requires_manual_review": false
                    },
                    "duality": { "indicator": { "subtle_hint": "ok" } },
                    "profile": { "attribution": { "source_goal_id": "goal_a" } }
                }),
                json!({
                    "micro_task_id": "mt_2",
                    "profile_id": "p_2",
                    "title": "Task Two",
                    "task_text": "Do task two",
                    "estimated_minutes": 3,
                    "success_criteria": ["B"],
                    "route": {
                        "lane": "storm_human_lane",
                        "parallel_group": 1,
                        "parallel_priority": 0.3,
                        "blocked": false,
                        "requires_manual_review": true
                    }
                }),
            ],
        };
        let (weaver, storm) = build_queue_rows(&req);
        assert_eq!(weaver.len(), 2);
        assert_eq!(storm.len(), 1);
        assert_eq!(weaver[0]["type"], "task_micro_route_candidate");
        assert_eq!(storm[0]["type"], "storm_micro_task_offer");
        assert_eq!(storm[0]["micro_task_id"], "mt_2");
    }

    #[test]
    fn build_dispatch_rows_emits_executor_and_status() {
        let req = DispatchRowsRequest {
            run_id: "run_dispatch".to_string(),
            goal_id: "goal_dispatch".to_string(),
            objective_id: Some("obj_dispatch".to_string()),
            shadow_only: false,
            apply_executed: true,
            passport_id: Some("passport_dispatch".to_string()),
            storm_lane: "storm_human_lane".to_string(),
            autonomous_executor: "universal_execution_primitive".to_string(),
            storm_executor: "storm_human_lane".to_string(),
            tasks: vec![
                json!({
                    "micro_task_id": "mt_a",
                    "profile_id": "p_a",
                    "route": { "lane": "autonomous_micro_agent" },
                    "governance": { "blocked": false }
                }),
                json!({
                    "micro_task_id": "mt_b",
                    "profile_id": "p_b",
                    "route": { "lane": "storm_human_lane" },
                    "governance": { "blocked": true }
                }),
            ],
        };
        let rows = build_dispatch_rows(&req);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["executor"], "universal_execution_primitive");
        assert_eq!(rows[0]["status"], "queued");
        assert_eq!(rows[1]["executor"], "storm_human_lane");
        assert_eq!(rows[1]["status"], "blocked");
    }
}
