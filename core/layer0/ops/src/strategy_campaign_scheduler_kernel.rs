// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};

fn usage() {
    println!("strategy-campaign-scheduler-kernel commands:");
    println!("  protheus-ops strategy-campaign-scheduler-kernel normalize-campaigns --payload-base64=<json>");
    println!("  protheus-ops strategy-campaign-scheduler-kernel annotate-priority --payload-base64=<json>");
    println!("  protheus-ops strategy-campaign-scheduler-kernel build-decomposition-plans --payload-base64=<json>");
}

fn cli_receipt(kind: &str, payload: Value) -> Value {
    let ts = now_iso();
    let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(true);
    let mut out = json!({
        "ok": ok,
        "type": kind,
        "ts": ts,
        "date": ts[..10].to_string(),
        "payload": payload,
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn cli_error(kind: &str, error: &str) -> Value {
    let ts = now_iso();
    let mut out = json!({
        "ok": false,
        "type": kind,
        "ts": ts,
        "date": ts[..10].to_string(),
        "error": error,
        "fail_closed": true,
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn payload_json(argv: &[String]) -> Result<Value, String> {
    if let Some(raw) = lane_utils::parse_flag(argv, "payload", false) {
        return serde_json::from_str::<Value>(&raw)
            .map_err(|err| format!("strategy_campaign_scheduler_kernel_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("strategy_campaign_scheduler_kernel_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("strategy_campaign_scheduler_kernel_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("strategy_campaign_scheduler_kernel_payload_decode_failed:{err}"));
    }
    Ok(json!({}))
}

fn payload_obj<'a>(value: &'a Value) -> &'a Map<String, Value> {
    value.as_object().unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        EMPTY.get_or_init(Map::new)
    })
}

fn as_object<'a>(value: Option<&'a Value>) -> Option<&'a Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn as_array<'a>(value: Option<&'a Value>) -> &'a Vec<Value> {
    value.and_then(Value::as_array).unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<Vec<Value>> = std::sync::OnceLock::new();
        EMPTY.get_or_init(Vec::new)
    })
}

fn as_str(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(v)) => v.trim().to_string(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string().trim_matches('"').trim().to_string(),
    }
}

fn clean_text(value: Option<&Value>, max_len: usize) -> String {
    let mut out = as_str(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if out.len() > max_len {
        out.truncate(max_len);
    }
    out
}

fn as_lower(value: Option<&Value>, max_len: usize) -> String {
    clean_text(value, max_len).to_ascii_lowercase()
}

fn as_i64(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(v)) => v.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn as_string_array_lower(value: Option<&Value>) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for row in as_array(value) {
        let token = as_lower(Some(row), 120);
        if token.is_empty() || !seen.insert(token.clone()) {
            continue;
        }
        out.push(token);
    }
    out
}

#[derive(Clone, Debug)]
struct Phase {
    raw: Value,
    id: String,
    name: String,
    objective_id: String,
    order: i64,
    priority: i64,
    proposal_types: Vec<String>,
    source_eyes: Vec<String>,
    tags: Vec<String>,
}

#[derive(Clone, Debug)]
struct Campaign {
    raw: Value,
    id: String,
    name: String,
    objective_id: String,
    priority: i64,
    proposal_types: Vec<String>,
    source_eyes: Vec<String>,
    tags: Vec<String>,
    phases: Vec<Phase>,
}

fn campaign_cmp(a: &Campaign, b: &Campaign) -> std::cmp::Ordering {
    a.priority.cmp(&b.priority).then_with(|| a.id.cmp(&b.id))
}

fn phase_cmp(a: &Phase, b: &Phase) -> std::cmp::Ordering {
    a.order
        .cmp(&b.order)
        .then_with(|| b.priority.cmp(&a.priority))
        .then_with(|| a.id.cmp(&b.id))
}

fn normalize_campaigns(strategy: &Value) -> Vec<Campaign> {
    let mut campaigns = Vec::new();
    let rows = strategy
        .get("campaigns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for row in rows {
        let Some(obj) = row.as_object() else {
            continue;
        };
        if as_lower(obj.get("status"), 40) != "active" {
            continue;
        }
        let mut phases = Vec::new();
        for phase_row in as_array(obj.get("phases")).iter().cloned() {
            let Some(phase_obj) = phase_row.as_object() else {
                continue;
            };
            if as_lower(phase_obj.get("status"), 40) != "active" {
                continue;
            }
            let phase = Phase {
                raw: phase_row.clone(),
                id: as_lower(phase_obj.get("id"), 120),
                name: clean_text(phase_obj.get("name"), 260),
                objective_id: clean_text(phase_obj.get("objective_id"), 160),
                order: as_i64(phase_obj.get("order")).unwrap_or(99),
                priority: as_i64(phase_obj.get("priority")).unwrap_or(0),
                proposal_types: as_string_array_lower(phase_obj.get("proposal_types")),
                source_eyes: as_string_array_lower(phase_obj.get("source_eyes")),
                tags: as_string_array_lower(phase_obj.get("tags")),
            };
            if !phase.id.is_empty() {
                phases.push(phase);
            }
        }
        phases.sort_by(phase_cmp);
        let campaign = Campaign {
            raw: row.clone(),
            id: as_lower(obj.get("id"), 120),
            name: clean_text(obj.get("name"), 260),
            objective_id: clean_text(obj.get("objective_id"), 160),
            priority: as_i64(obj.get("priority")).unwrap_or(50),
            proposal_types: as_string_array_lower(obj.get("proposal_types")),
            source_eyes: as_string_array_lower(obj.get("source_eyes")),
            tags: as_string_array_lower(obj.get("tags")),
            phases,
        };
        if !campaign.id.is_empty() && !campaign.phases.is_empty() {
            campaigns.push(campaign);
        }
    }
    campaigns.sort_by(campaign_cmp);
    campaigns
}

fn campaigns_as_value(campaigns: &[Campaign]) -> Value {
    Value::Array(
        campaigns
            .iter()
            .map(|campaign| {
                let Some(obj) = campaign.raw.as_object() else {
                    return Value::Null;
                };
                let mut out = obj.clone();
                out.insert("id".to_string(), Value::String(campaign.id.clone()));
                out.insert("name".to_string(), Value::String(campaign.name.clone()));
                out.insert(
                    "objective_id".to_string(),
                    if campaign.objective_id.is_empty() {
                        Value::Null
                    } else {
                        Value::String(campaign.objective_id.clone())
                    },
                );
                out.insert("priority".to_string(), Value::from(campaign.priority));
                out.insert("proposal_types".to_string(), json!(campaign.proposal_types));
                out.insert("source_eyes".to_string(), json!(campaign.source_eyes));
                out.insert("tags".to_string(), json!(campaign.tags));
                out.insert(
                    "phases".to_string(),
                    Value::Array(
                        campaign
                            .phases
                            .iter()
                            .map(|phase| {
                                let Some(phase_obj) = phase.raw.as_object() else {
                                    return Value::Null;
                                };
                                let mut next = phase_obj.clone();
                                next.insert("id".to_string(), Value::String(phase.id.clone()));
                                next.insert("name".to_string(), Value::String(phase.name.clone()));
                                next.insert(
                                    "objective_id".to_string(),
                                    if phase.objective_id.is_empty() {
                                        Value::Null
                                    } else {
                                        Value::String(phase.objective_id.clone())
                                    },
                                );
                                next.insert("order".to_string(), Value::from(phase.order));
                                next.insert("priority".to_string(), Value::from(phase.priority));
                                next.insert("proposal_types".to_string(), json!(phase.proposal_types));
                                next.insert("source_eyes".to_string(), json!(phase.source_eyes));
                                next.insert("tags".to_string(), json!(phase.tags));
                                Value::Object(next)
                            })
                            .collect(),
                    ),
                );
                Value::Object(out)
            })
            .collect(),
    )
}

fn candidate_objective_id(candidate: &Value) -> String {
    let parts = [
        candidate.pointer("/objective_binding/objective_id"),
        candidate.pointer("/directive_pulse/objective_id"),
        candidate.pointer("/proposal/meta/objective_id"),
        candidate.pointer("/proposal/meta/directive_objective_id"),
        candidate.pointer("/proposal/action_spec/objective_id"),
    ];
    for value in parts {
        let token = clean_text(value, 160);
        if !token.is_empty() {
            return token;
        }
    }
    String::new()
}

fn candidate_type(candidate: &Value) -> String {
    as_lower(candidate.pointer("/proposal/type"), 120)
}

fn candidate_source_eye(candidate: &Value) -> String {
    as_lower(candidate.pointer("/proposal/meta/source_eye"), 120)
}

fn candidate_tag_set(candidate: &Value) -> BTreeSet<String> {
    let mut tags = BTreeSet::new();
    for row in as_string_array_lower(candidate.pointer("/proposal/tags")) {
        tags.insert(row);
    }
    for row in as_string_array_lower(candidate.pointer("/proposal/meta/tags")) {
        tags.insert(row);
    }
    tags
}

fn has_any_overlap(required: &[String], values: &BTreeSet<String>) -> bool {
    if required.is_empty() {
        return true;
    }
    required.iter().any(|row| values.contains(row))
}

fn is_filter_match(required: &[String], value: &str) -> bool {
    required.is_empty() || required.iter().any(|row| row == value)
}

fn is_phase_preferred_filter_match(campaign_required: &[String], phase_required: &[String], value: &str) -> bool {
    if !phase_required.is_empty() {
        return is_filter_match(phase_required, value);
    }
    is_filter_match(campaign_required, value)
}

fn score_match(campaign: &Campaign, phase: &Phase, candidate: &Value) -> Option<Value> {
    let objective_id = candidate_objective_id(candidate);
    let proposal_type = candidate_type(candidate);
    let source_eye = candidate_source_eye(candidate);
    let tags = candidate_tag_set(candidate);

    if !campaign.objective_id.is_empty() && objective_id != campaign.objective_id {
        return None;
    }
    if !phase.objective_id.is_empty() && objective_id != phase.objective_id {
        return None;
    }
    if !is_phase_preferred_filter_match(&campaign.proposal_types, &phase.proposal_types, &proposal_type) {
        return None;
    }
    if !is_filter_match(&campaign.source_eyes, &source_eye) {
        return None;
    }
    if !is_filter_match(&phase.source_eyes, &source_eye) {
        return None;
    }
    if !has_any_overlap(&campaign.tags, &tags) {
        return None;
    }
    if !has_any_overlap(&phase.tags, &tags) {
        return None;
    }

    let tag_overlap = tags
        .iter()
        .filter(|tag| campaign.tags.contains(tag) || phase.tags.contains(tag))
        .count() as i64;

    let mut score = 0_i64;
    score += (120 - campaign.priority).max(0);
    score += (80 - (phase.order * 5)).max(0);
    score += phase.priority;
    if !campaign.objective_id.is_empty() && !objective_id.is_empty() {
        score += 35;
    }
    if !phase.objective_id.is_empty() && !objective_id.is_empty() {
        score += 20;
    }
    if !campaign.proposal_types.is_empty() {
        score += 18;
    }
    if !phase.proposal_types.is_empty() {
        score += 14;
    }
    if !campaign.source_eyes.is_empty() || !phase.source_eyes.is_empty() {
        score += 10;
    }
    score += (tag_overlap * 4).min(20);

    Some(json!({
        "matched": true,
        "score": score,
        "campaign_id": campaign.id,
        "campaign_name": if campaign.name.is_empty() { campaign.id.clone() } else { campaign.name.clone() },
        "campaign_priority": campaign.priority,
        "phase_id": phase.id,
        "phase_name": if phase.name.is_empty() { phase.id.clone() } else { phase.name.clone() },
        "phase_order": phase.order,
        "phase_priority": phase.priority,
        "objective_id": if objective_id.is_empty() {
            if !campaign.objective_id.is_empty() {
                campaign.objective_id.clone()
            } else {
                phase.objective_id.clone()
            }
        } else {
            objective_id
        }
    }))
}

fn best_campaign_match(candidate: &Value, campaigns: &[Campaign]) -> Option<Value> {
    let mut best: Option<Value> = None;
    for campaign in campaigns {
        for phase in &campaign.phases {
            let Some(next) = score_match(campaign, phase, candidate) else {
                continue;
            };
            let next_score = next.get("score").and_then(Value::as_i64).unwrap_or(0);
            let best_score = best
                .as_ref()
                .and_then(|row| row.get("score"))
                .and_then(Value::as_i64)
                .unwrap_or(i64::MIN);
            if best.is_none() || next_score > best_score {
                best = Some(next);
            }
        }
    }
    best
}

fn annotate_campaign_priority(candidates: &[Value], strategy: &Value) -> Value {
    let campaigns = normalize_campaigns(strategy);
    if campaigns.is_empty() {
        let annotated = candidates
            .iter()
            .map(|candidate| {
                let mut next = candidate.as_object().cloned().unwrap_or_default();
                next.insert("campaign_match".to_string(), Value::Null);
                next.insert("campaign_sort_bucket".to_string(), Value::from(0));
                next.insert("campaign_sort_score".to_string(), Value::from(0));
                Value::Object(next)
            })
            .collect::<Vec<_>>();
        return json!({
            "summary": {
                "enabled": false,
                "campaign_count": 0,
                "matched_count": 0
            },
            "candidates": annotated
        });
    }

    let mut matched_count = 0_i64;
    let mut matched_by_campaign = BTreeMap::<String, i64>::new();
    let annotated = candidates
        .iter()
        .map(|candidate| {
            let mut next = candidate.as_object().cloned().unwrap_or_default();
            if let Some(found) = best_campaign_match(candidate, &campaigns) {
                matched_count += 1;
                if let Some(campaign_id) = found.get("campaign_id").and_then(Value::as_str) {
                    *matched_by_campaign.entry(campaign_id.to_string()).or_insert(0) += 1;
                }
                next.insert("campaign_match".to_string(), found.clone());
                next.insert("campaign_sort_bucket".to_string(), Value::from(1));
                next.insert(
                    "campaign_sort_score".to_string(),
                    Value::from(found.get("score").and_then(Value::as_i64).unwrap_or(0)),
                );
            } else {
                next.insert("campaign_match".to_string(), Value::Null);
                next.insert("campaign_sort_bucket".to_string(), Value::from(0));
                next.insert("campaign_sort_score".to_string(), Value::from(0));
            }
            Value::Object(next)
        })
        .collect::<Vec<_>>();
    json!({
        "summary": {
            "enabled": true,
            "campaign_count": campaigns.len(),
            "matched_count": matched_count,
            "unmatched_count": (candidates.len() as i64 - matched_count).max(0),
            "matched_by_campaign": matched_by_campaign
        },
        "candidates": annotated
    })
}

fn proposal_status_lower(proposal: &Value) -> String {
    as_lower(proposal.get("status").or_else(|| proposal.get("state")), 80)
}

fn is_terminal_proposal_status(status: &str) -> bool {
    matches!(
        status,
        "resolved"
            | "done"
            | "closed"
            | "shipped"
            | "no_change"
            | "reverted"
            | "rejected"
            | "filtered"
            | "superseded"
            | "archived"
            | "dropped"
    )
}

fn sanitize_token(raw: &str, fallback: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in raw.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
        if out.len() >= 28 {
            break;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

fn campaign_seed_key(campaign: &Campaign, phase: &Phase, proposal_type: &str, objective_id: &str) -> String {
    format!(
        "{}|{}|{}|{}",
        sanitize_token(&campaign.id, "campaign"),
        sanitize_token(&phase.id, "phase"),
        sanitize_token(proposal_type, "proposal"),
        sanitize_token(objective_id, "objective")
    )
}

fn campaign_seed_id(seed_key: &str) -> String {
    let compact = sanitize_token(&seed_key.replace('|', "-"), "seed");
    format!("CAMP-{}", compact[..compact.len().min(52)].to_ascii_uppercase())
}

fn existing_campaign_seed_keys(proposals: &[Value]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for proposal in proposals {
        let key = as_lower(proposal.pointer("/meta/campaign_seed_key"), 240);
        if !key.is_empty() {
            out.insert(key);
        }
    }
    out
}

fn open_proposal_type_counts(proposals: &[Value]) -> BTreeMap<String, i64> {
    let mut counts = BTreeMap::new();
    for proposal in proposals {
        if is_terminal_proposal_status(&proposal_status_lower(proposal)) {
            continue;
        }
        let proposal_type = as_lower(proposal.get("type"), 120);
        if proposal_type.is_empty() {
            continue;
        }
        *counts.entry(proposal_type).or_insert(0) += 1;
    }
    counts
}

fn build_campaign_decomposition_plans(proposals: &[Value], strategy: &Value, opts: &Map<String, Value>) -> Value {
    let campaigns = normalize_campaigns(strategy);
    let min_open_per_type = as_i64(opts.get("min_open_per_type")).unwrap_or(1).max(1);
    let max_additions = as_i64(opts.get("max_additions")).unwrap_or(0).max(0);
    let default_objective_id = clean_text(opts.get("default_objective_id"), 160);
    let default_risk = {
        let token = as_lower(opts.get("default_risk"), 40);
        if token.is_empty() { "low".to_string() } else { token }
    };
    let default_impact = {
        let token = as_lower(opts.get("default_impact"), 40);
        if token.is_empty() { "medium".to_string() } else { token }
    };
    if campaigns.is_empty() || max_additions == 0 {
        return json!({
            "enabled": !campaigns.is_empty(),
            "additions": [],
            "campaign_count": campaigns.len(),
            "min_open_per_type": min_open_per_type,
            "max_additions": max_additions
        });
    }

    let mut existing_ids = proposals
        .iter()
        .filter_map(|proposal| proposal.get("id").and_then(Value::as_str))
        .map(|row| row.to_string())
        .collect::<BTreeSet<_>>();
    let mut existing_keys = existing_campaign_seed_keys(proposals);
    let mut open_counts = open_proposal_type_counts(proposals);
    let mut additions = Vec::new();

    'campaigns: for campaign in campaigns {
        for phase in &campaign.phases {
            let objective_id = if !phase.objective_id.is_empty() {
                phase.objective_id.clone()
            } else if !campaign.objective_id.is_empty() {
                campaign.objective_id.clone()
            } else {
                default_objective_id.clone()
            };
            for proposal_type in &phase.proposal_types {
                if additions.len() as i64 >= max_additions {
                    break 'campaigns;
                }
                let open = *open_counts.get(proposal_type).unwrap_or(&0);
                if open >= min_open_per_type {
                    continue;
                }
                let seed_key = campaign_seed_key(&campaign, phase, proposal_type, if objective_id.is_empty() { "objective" } else { &objective_id });
                if existing_keys.contains(&seed_key) {
                    continue;
                }
                let id = campaign_seed_id(&seed_key);
                if existing_ids.contains(&id) {
                    continue;
                }

                let campaign_name = if campaign.name.is_empty() {
                    campaign.id.clone()
                } else {
                    campaign.name.clone()
                };
                let phase_name = if phase.name.is_empty() {
                    phase.id.clone()
                } else {
                    phase.name.clone()
                };
                let objective_clause = if objective_id.is_empty() {
                    String::new()
                } else {
                    format!(" objective {objective_id}")
                };
                let task = format!(
                    "Create one bounded, deterministic action for campaign \"{campaign_name}\" phase \"{phase_name}\" proposal type \"{proposal_type}\" aligned to{objective_clause}. Use low-risk reversible steps with explicit verification and rollback."
                );
                let verify = json!([
                    "Route execution plan succeeds in dry-run",
                    "Success criteria include measurable checks",
                    "Rollback path remains available"
                ]);
                additions.push(json!({
                    "id": id,
                    "type": proposal_type,
                    "title": format!("[Campaign] {campaign_name} :: {phase_name} :: {proposal_type}"),
                    "summary": format!("Campaign decomposition seed for {campaign_name}/{phase_name} ({proposal_type})."),
                    "expected_impact": default_impact,
                    "risk": default_risk,
                    "validation": verify,
                    "suggested_next_command": format!("node systems/routing/route_execute.js --task=\"{task}\" --tokens_est=650 --repeats_14d=1 --errors_30d=0 --dry-run"),
                    "action_spec": {
                        "version": 1,
                        "objective": format!("Generate concrete {proposal_type} action for campaign {campaign_name}/{phase_name}"),
                        "objective_id": if objective_id.is_empty() { Value::Null } else { Value::String(objective_id.clone()) },
                        "next_command": format!("node systems/routing/route_execute.js --task=\"{task}\" --tokens_est=650 --repeats_14d=1 --errors_30d=0 --dry-run"),
                        "verify": verify,
                        "rollback": "Drop generated campaign seed proposal if verification fails"
                    },
                    "meta": {
                        "source_eye": "strategy_campaign",
                        "campaign_generated": true,
                        "campaign_id": campaign.id,
                        "campaign_name": campaign_name,
                        "campaign_priority": campaign.priority,
                        "campaign_phase_id": phase.id,
                        "campaign_phase_name": phase_name,
                        "campaign_phase_order": phase.order,
                        "campaign_seed_key": seed_key,
                        "objective_id": if objective_id.is_empty() { Value::Null } else { Value::String(objective_id.clone()) },
                        "directive_objective_id": if objective_id.is_empty() { Value::Null } else { Value::String(objective_id.clone()) },
                        "generated_at": now_iso()
                    }
                }));
                existing_ids.insert(id);
                existing_keys.insert(seed_key);
                open_counts.insert(proposal_type.clone(), open + 1);
            }
        }
    }

    json!({
        "enabled": true,
        "additions": additions,
        "campaign_count": normalize_campaigns(strategy).len(),
        "min_open_per_type": min_open_per_type,
        "max_additions": max_additions
    })
}

fn run_command(command: &str, payload: &Map<String, Value>) -> Result<Value, String> {
    match command {
        "normalize-campaigns" => {
            let strategy = payload.get("strategy").cloned().unwrap_or_else(|| json!({}));
            Ok(json!({
                "ok": true,
                "campaigns": campaigns_as_value(&normalize_campaigns(&strategy))
            }))
        }
        "annotate-priority" => {
            let strategy = payload.get("strategy").cloned().unwrap_or_else(|| json!({}));
            let candidates = as_array(payload.get("candidates")).iter().cloned().collect::<Vec<_>>();
            let out = annotate_campaign_priority(&candidates, &strategy);
            Ok(json!({
                "ok": true,
                "summary": out.get("summary").cloned().unwrap_or_else(|| json!({})),
                "candidates": out.get("candidates").cloned().unwrap_or_else(|| json!([]))
            }))
        }
        "build-decomposition-plans" => {
            let strategy = payload.get("strategy").cloned().unwrap_or_else(|| json!({}));
            let proposals = as_array(payload.get("proposals")).iter().cloned().collect::<Vec<_>>();
            let opts = as_object(payload.get("opts")).cloned().unwrap_or_default();
            let out = build_campaign_decomposition_plans(&proposals, &strategy, &opts);
            Ok(json!({
                "ok": true,
                "plan": out
            }))
        }
        _ => Err("strategy_campaign_scheduler_kernel_unknown_command".to_string()),
    }
}

pub fn run(_root: &std::path::Path, argv: &[String]) -> i32 {
    let Some(command) = argv.first().map(|v| v.as_str()) else {
        usage();
        return 1;
    };
    if matches!(command, "help" | "--help" | "-h") {
        usage();
        return 0;
    }
    let payload = match payload_json(argv) {
        Ok(value) => value,
        Err(err) => {
            print_json_line(&cli_error("strategy_campaign_scheduler_kernel", &err));
            return 1;
        }
    };
    let payload = payload_obj(&payload).clone();
    match run_command(command, &payload) {
        Ok(out) => {
            print_json_line(&cli_receipt("strategy_campaign_scheduler_kernel", out));
            0
        }
        Err(err) => {
            print_json_line(&cli_error("strategy_campaign_scheduler_kernel", &err));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_campaigns_filters_inactive_and_sorts_phases() {
        let strategy = json!({
            "campaigns": [
                {
                    "id": "Campaign-A",
                    "status": "active",
                    "priority": 20,
                    "phases": [
                        {"id": "phase-b", "status": "active", "order": 2, "priority": 1},
                        {"id": "phase-a", "status": "active", "order": 1, "priority": 2},
                        {"id": "phase-z", "status": "paused", "order": 0}
                    ]
                },
                {
                    "id": "Campaign-B",
                    "status": "paused",
                    "phases": [{"id": "phase-x", "status": "active"}]
                }
            ]
        });
        let campaigns = normalize_campaigns(&strategy);
        assert_eq!(campaigns.len(), 1);
        assert_eq!(campaigns[0].phases.len(), 2);
        assert_eq!(campaigns[0].phases[0].id, "phase-a");
    }

    #[test]
    fn decomposition_respects_existing_seed_and_open_counts() {
        let strategy = json!({
            "campaigns": [{
                "id": "Campaign-A",
                "status": "active",
                "priority": 20,
                "objective_id": "OBJ-1",
                "phases": [{
                    "id": "phase-a",
                    "status": "active",
                    "proposal_types": ["fix"]
                }]
            }]
        });
        let proposals = vec![json!({
            "id": "CAMP-CAMPAIGN-A-PHASE-A-FIX-OBJ-1",
            "type": "fix",
            "meta": {
                "campaign_seed_key": "campaign-a|phase-a|fix|obj-1"
            }
        })];
        let out = build_campaign_decomposition_plans(
            &proposals,
            &strategy,
            payload_obj(&json!({"max_additions": 1, "min_open_per_type": 1}))
        );
        assert_eq!(
            out.get("additions").and_then(Value::as_array).map(|rows| rows.len()),
            Some(0)
        );
    }

    #[test]
    fn annotate_priority_prefers_phase_specific_proposal_type_filter() {
        let strategy = json!({
            "campaigns": [{
                "id": "Objective Flow",
                "name": "Objective Flow",
                "status": "active",
                "priority": 20,
                "objective_id": "OBJ-1",
                "proposal_types": ["strategy"],
                "phases": [{
                    "id": "stabilize",
                    "name": "stabilize",
                    "status": "active",
                    "order": 1,
                    "priority": 10,
                    "proposal_types": ["infrastructure_outage"],
                    "source_eyes": ["health"],
                    "tags": ["ops"]
                }]
            }]
        });
        let candidates = vec![json!({
            "proposal": {
                "type": "infrastructure_outage",
                "meta": { "source_eye": "health", "objective_id": "OBJ-1", "tags": ["ops"] },
                "tags": ["ops"]
            }
        })];
        let out = annotate_campaign_priority(&candidates, &strategy);
        assert_eq!(out.pointer("/summary/matched_count").and_then(Value::as_i64), Some(1));
        assert_eq!(
            out.pointer("/candidates/0/campaign_match/campaign_id").and_then(Value::as_str),
            Some("objective flow")
        );
    }
}
