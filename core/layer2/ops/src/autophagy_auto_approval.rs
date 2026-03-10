// Layer ownership: core/layer2/ops (authoritative)
// SPDX-License-Identifier: Apache-2.0
use crate::deterministic_receipt_hash;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_POLICY_PATH: &str = "client/runtime/config/autophagy_auto_approval_policy.json";
const DEFAULT_STATE_PATH: &str = "state/autonomy/autophagy_auto_approval/state.json";
const DEFAULT_LATEST_PATH: &str = "state/autonomy/autophagy_auto_approval/latest.json";
const DEFAULT_RECEIPTS_PATH: &str = "state/autonomy/autophagy_auto_approval/receipts.jsonl";
const DEFAULT_REGRETS_PATH: &str = "state/autonomy/autophagy_auto_approval/regrets.jsonl";

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops autophagy-auto-approval evaluate --proposal-json=<json>|--proposal-file=<path> [--apply=1|0] [--policy=<path>] [--state-path=<path>] [--latest-path=<path>] [--receipts-path=<path>] [--regrets-path=<path>]",
    "  protheus-ops autophagy-auto-approval monitor --proposal-id=<id> [--drift=<float>] [--yield-drop=<float>] [--apply=1|0] [--policy=<path>] [--state-path=<path>] [--latest-path=<path>] [--receipts-path=<path>] [--regrets-path=<path>]",
    "  protheus-ops autophagy-auto-approval commit --proposal-id=<id> [--reason=<text>] [--policy=<path>] [--state-path=<path>] [--latest-path=<path>] [--receipts-path=<path>] [--regrets-path=<path>]",
    "  protheus-ops autophagy-auto-approval rollback --proposal-id=<id> [--reason=<text>] [--policy=<path>] [--state-path=<path>] [--latest-path=<path>] [--receipts-path=<path>] [--regrets-path=<path>]",
    "  protheus-ops autophagy-auto-approval status [--policy=<path>] [--state-path=<path>]",
];

#[derive(Clone, Debug)]
struct Policy {
    enabled: bool,
    min_confidence: f64,
    min_historical_success_rate: f64,
    max_impact_score: f64,
    excluded_types: Vec<String>,
    auto_rollback_on_degradation: bool,
    max_drift_delta: f64,
    max_yield_drop: f64,
    rollback_window_minutes: i64,
    regret_issue_label: String,
    state_path: PathBuf,
    latest_path: PathBuf,
    receipts_path: PathBuf,
    regrets_path: PathBuf,
}

#[derive(Clone, Debug)]
struct ProposalSummary {
    id: String,
    title: String,
    proposal_type: String,
    confidence: f64,
    historical_success_rate: f64,
    impact_score: f64,
    raw: Value,
}

fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn usage() {
    for line in USAGE {
        println!("{line}");
    }
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let pref = format!("--{key}=");
    let key_long = format!("--{key}");
    let mut i = 0usize;
    while i < argv.len() {
        let token = argv[i].trim();
        if let Some(v) = token.strip_prefix(&pref) {
            return Some(v.to_string());
        }
        if token == key_long && i + 1 < argv.len() {
            return Some(argv[i + 1].clone());
        }
        i += 1;
    }
    None
}

fn parse_bool(raw: Option<&str>, fallback: bool) -> bool {
    let Some(v) = raw else {
        return fallback;
    };
    match v.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn parse_f64(raw: Option<&str>) -> Option<f64> {
    raw.and_then(|v| v.trim().parse::<f64>().ok())
}

fn resolve_path(root: &Path, raw: Option<String>, fallback: &Path) -> PathBuf {
    let path = raw
        .map(PathBuf::from)
        .unwrap_or_else(|| fallback.to_path_buf());
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("missing_parent_for_path:{}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("create_dir_all_failed:{e}"))
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    fs::write(
        path,
        serde_json::to_vec_pretty(value).map_err(|e| format!("encode_json_failed:{e}"))?,
    )
    .map_err(|e| format!("write_json_failed:{e}"))
}

fn append_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let mut existing = fs::read_to_string(path).unwrap_or_default();
    existing.push_str(
        &serde_json::to_string(value).map_err(|e| format!("encode_jsonl_failed:{e}"))?,
    );
    existing.push('\n');
    fs::write(path, existing).map_err(|e| format!("write_jsonl_failed:{e}"))
}

fn array_from<'a>(object: &'a mut Map<String, Value>, key: &str) -> &'a mut Vec<Value> {
    let value = object
        .entry(key.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !value.is_array() {
        *value = Value::Array(Vec::new());
    }
    value.as_array_mut().expect("array")
}

fn value_string(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn value_f64(value: Option<&Value>, fallback: f64) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(fallback)
}

fn stable_proposal_id(proposal: &Value) -> String {
    let title = proposal
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("proposal");
    let kind = proposal
        .get("type")
        .or_else(|| proposal.get("kind"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("generic");
    let seed = json!({
        "title": title,
        "proposal_type": kind,
        "payload": proposal
    });
    deterministic_receipt_hash(&seed)[..16].to_string()
}

fn load_policy(root: &Path, argv: &[String]) -> Policy {
    let policy_path = resolve_path(
        root,
        parse_flag(argv, "policy"),
        Path::new(DEFAULT_POLICY_PATH),
    );
    let raw = read_json(&policy_path).unwrap_or_else(|| json!({}));
    let auto = raw
        .get("auto_approval")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let degradation = auto
        .get("degradation_threshold")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let paths = raw
        .get("paths")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let state_path = resolve_path(
        root,
        parse_flag(argv, "state-path")
            .or_else(|| paths.get("state_path").and_then(Value::as_str).map(str::to_string)),
        Path::new(DEFAULT_STATE_PATH),
    );
    let latest_path = resolve_path(
        root,
        parse_flag(argv, "latest-path")
            .or_else(|| paths.get("latest_path").and_then(Value::as_str).map(str::to_string)),
        Path::new(DEFAULT_LATEST_PATH),
    );
    let receipts_path = resolve_path(
        root,
        parse_flag(argv, "receipts-path")
            .or_else(|| paths.get("receipts_path").and_then(Value::as_str).map(str::to_string)),
        Path::new(DEFAULT_RECEIPTS_PATH),
    );
    let regrets_path = resolve_path(
        root,
        parse_flag(argv, "regrets-path")
            .or_else(|| paths.get("regrets_path").and_then(Value::as_str).map(str::to_string)),
        Path::new(DEFAULT_REGRETS_PATH),
    );

    Policy {
        enabled: raw.get("enabled").and_then(Value::as_bool).unwrap_or(true)
            && auto.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        min_confidence: auto
            .get("min_confidence")
            .and_then(Value::as_f64)
            .unwrap_or(0.85),
        min_historical_success_rate: auto
            .get("min_historical_success_rate")
            .and_then(Value::as_f64)
            .unwrap_or(0.90),
        max_impact_score: auto
            .get("max_impact_score")
            .and_then(Value::as_f64)
            .unwrap_or(50.0),
        excluded_types: auto
            .get("excluded_types")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(Value::as_str)
                    .map(|v| v.trim().to_ascii_lowercase())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        auto_rollback_on_degradation: auto
            .get("auto_rollback_on_degradation")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        max_drift_delta: degradation
            .get("max_drift_delta")
            .and_then(Value::as_f64)
            .unwrap_or(0.01),
        max_yield_drop: degradation
            .get("max_yield_drop")
            .and_then(Value::as_f64)
            .unwrap_or(0.05),
        rollback_window_minutes: auto
            .get("rollback_window_minutes")
            .and_then(Value::as_i64)
            .unwrap_or(30)
            .clamp(1, 10080),
        regret_issue_label: auto
            .get("regret_issue_label")
            .and_then(Value::as_str)
            .unwrap_or("auto_approval_regret")
            .to_string(),
        state_path,
        latest_path,
        receipts_path,
        regrets_path,
    }
}

fn load_state(state_path: &Path) -> Value {
    read_json(state_path).unwrap_or_else(|| {
        json!({
            "version": "1.0",
            "pending_commit": [],
            "committed": [],
            "rolled_back": []
        })
    })
}

fn store_state(policy: &Policy, state: &Value) -> Result<(), String> {
    write_json(&policy.state_path, state)
}

fn parse_proposal(argv: &[String]) -> Result<Value, String> {
    if let Some(raw) = parse_flag(argv, "proposal-json") {
        return serde_json::from_str::<Value>(&raw)
            .map_err(|e| format!("proposal_json_parse_failed:{e}"));
    }
    if let Some(file) = parse_flag(argv, "proposal-file") {
        let raw = fs::read_to_string(file).map_err(|e| format!("proposal_file_read_failed:{e}"))?;
        return serde_json::from_str::<Value>(&raw)
            .map_err(|e| format!("proposal_file_parse_failed:{e}"));
    }
    Err("missing_proposal_payload".to_string())
}

fn proposal_summary(proposal: &Value) -> ProposalSummary {
    let id = proposal
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| stable_proposal_id(proposal));
    ProposalSummary {
        id,
        title: value_string(proposal.get("title"), "Untitled proposal"),
        proposal_type: value_string(
            proposal
                .get("proposal_type")
                .or_else(|| proposal.get("type"))
                .or_else(|| proposal.get("kind")),
            "generic",
        )
        .to_ascii_lowercase(),
        confidence: value_f64(proposal.get("confidence"), 0.0),
        historical_success_rate: value_f64(
            proposal
                .get("historical_success_rate")
                .or_else(|| proposal.get("historical_success")),
            0.0,
        ),
        impact_score: value_f64(proposal.get("impact_score"), 100.0),
        raw: proposal.clone(),
    }
}

fn evaluate_proposal(policy: &Policy, proposal: &ProposalSummary) -> (bool, Vec<String>) {
    let mut reasons = Vec::new();
    if !policy.enabled {
        reasons.push("auto_approval_disabled".to_string());
    }
    if policy
        .excluded_types
        .iter()
        .any(|entry| entry == &proposal.proposal_type)
    {
        reasons.push(format!("excluded_type:{}", proposal.proposal_type));
    }
    if proposal.confidence < policy.min_confidence {
        reasons.push(format!(
            "confidence_below_floor:{:.3}<{:.3}",
            proposal.confidence, policy.min_confidence
        ));
    }
    if proposal.historical_success_rate < policy.min_historical_success_rate {
        reasons.push(format!(
            "historical_success_below_floor:{:.3}<{:.3}",
            proposal.historical_success_rate, policy.min_historical_success_rate
        ));
    }
    if proposal.impact_score > policy.max_impact_score {
        reasons.push(format!(
            "impact_score_above_cap:{:.3}>{:.3}",
            proposal.impact_score, policy.max_impact_score
        ));
    }
    (reasons.is_empty(), reasons)
}

fn remove_entry(rows: &mut Vec<Value>, proposal_id: &str) -> Option<Value> {
    let idx = rows.iter().position(|row| {
        row.get("proposal")
            .and_then(Value::as_object)
            .and_then(|proposal| proposal.get("id"))
            .and_then(Value::as_str)
            == Some(proposal_id)
    })?;
    Some(rows.remove(idx))
}

fn insert_pending(state: &mut Value, pending: Value) {
    let object = state.as_object_mut().expect("state object");
    let rows = array_from(object, "pending_commit");
    let proposal_id = pending
        .get("proposal")
        .and_then(Value::as_object)
        .and_then(|proposal| proposal.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if !proposal_id.is_empty() {
        rows.retain(|row| {
            row.get("proposal")
                .and_then(Value::as_object)
                .and_then(|proposal| proposal.get("id"))
                .and_then(Value::as_str)
                != Some(proposal_id)
        });
    }
    rows.push(pending);
}

fn base_receipt(kind: &str, command: &str, policy: &Policy) -> Value {
    json!({
        "ok": true,
        "type": kind,
        "authority": "core/layer2/ops",
        "command": command,
        "state_path": policy.state_path.to_string_lossy(),
        "latest_path": policy.latest_path.to_string_lossy(),
        "receipts_path": policy.receipts_path.to_string_lossy(),
        "regrets_path": policy.regrets_path.to_string_lossy(),
        "ts_epoch_ms": now_epoch_ms()
    })
}

fn finalize_receipt(policy: &Policy, receipt: &mut Value) -> Result<(), String> {
    receipt["receipt_hash"] = Value::String(deterministic_receipt_hash(receipt));
    write_json(&policy.latest_path, receipt)?;
    append_jsonl(&policy.receipts_path, receipt)?;
    Ok(())
}

fn status_receipt(policy: &Policy) -> Result<Value, String> {
    let state = load_state(&policy.state_path);
    let pending = state
        .get("pending_commit")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let committed = state
        .get("committed")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let rolled_back = state
        .get("rolled_back")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let now = now_epoch_ms();
    let overdue_pending = pending
        .iter()
        .filter(|row| {
            row.get("rollback_deadline_epoch_ms")
                .and_then(Value::as_i64)
                .map(|deadline| deadline <= now)
                .unwrap_or(false)
        })
        .count();
    let mut out = base_receipt("autophagy_auto_approval_status", "status", policy);
    out["policy"] = json!({
        "enabled": policy.enabled,
        "min_confidence": policy.min_confidence,
        "min_historical_success_rate": policy.min_historical_success_rate,
        "max_impact_score": policy.max_impact_score,
        "excluded_types": policy.excluded_types,
        "rollback_window_minutes": policy.rollback_window_minutes,
        "auto_rollback_on_degradation": policy.auto_rollback_on_degradation,
        "degradation_threshold": {
            "max_drift_delta": policy.max_drift_delta,
            "max_yield_drop": policy.max_yield_drop
        }
    });
    out["summary"] = json!({
        "pending_commit": pending.len(),
        "committed": committed.len(),
        "rolled_back": rolled_back.len(),
        "overdue_pending": overdue_pending
    });
    out["pending_commit"] = Value::Array(pending);
    out["committed"] = Value::Array(committed);
    out["rolled_back"] = Value::Array(rolled_back);
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    Ok(out)
}

fn evaluate_command(root: &Path, argv: &[String], policy: &Policy) -> Result<Value, String> {
    let proposal = parse_proposal(argv)?;
    let summary = proposal_summary(&proposal);
    let apply = parse_bool(parse_flag(argv, "apply").as_deref(), false);
    let (eligible, reasons) = evaluate_proposal(policy, &summary);
    let decision = if eligible {
        if apply {
            "auto_execute_pending_commit"
        } else {
            "auto_approve_eligible"
        }
    } else {
        "human_review_required"
    };

    let mut receipt = base_receipt("autophagy_auto_approval_evaluation", "evaluate", policy);
    receipt["root"] = Value::String(root.to_string_lossy().to_string());
    receipt["proposal"] = json!({
        "id": summary.id,
        "title": summary.title,
        "proposal_type": summary.proposal_type,
        "confidence": summary.confidence,
        "historical_success_rate": summary.historical_success_rate,
        "impact_score": summary.impact_score
    });
    receipt["decision"] = Value::String(decision.to_string());
    receipt["eligible"] = Value::Bool(eligible);
    receipt["apply"] = Value::Bool(apply);
    receipt["decision_reasons"] = Value::Array(reasons.iter().map(|v| Value::String(v.clone())).collect());
    receipt["claim_evidence"] = json!([
        {
            "id": "confidence_gated_auto_approval",
            "claim": "high_confidence_bounded_proposals_can_auto_execute_with_rollback_window",
            "evidence": {
                "eligible": eligible,
                "apply": apply,
                "rollback_window_minutes": policy.rollback_window_minutes
            }
        }
    ]);

    if eligible && apply {
        let mut state = load_state(&policy.state_path);
        let now = now_epoch_ms();
        let pending = json!({
            "proposal": {
                "id": summary.id,
                "title": summary.title,
                "proposal_type": summary.proposal_type,
                "confidence": summary.confidence,
                "historical_success_rate": summary.historical_success_rate,
                "impact_score": summary.impact_score,
                "raw": summary.raw
            },
            "approved_at_epoch_ms": now,
            "rollback_deadline_epoch_ms": now + (policy.rollback_window_minutes * 60 * 1000),
            "state": "pending_commit"
        });
        insert_pending(&mut state, pending.clone());
        state["last_decision"] = receipt.clone();
        state["updated_at_epoch_ms"] = json!(now);
        store_state(policy, &state)?;
        receipt["pending_record"] = pending;
    }

    finalize_receipt(policy, &mut receipt)?;
    Ok(receipt)
}

fn rollback_from_state(
    state: &mut Value,
    policy: &Policy,
    proposal_id: &str,
    trigger: &str,
    reason: &str,
    drift: Option<f64>,
    yield_drop: Option<f64>,
) -> Result<Value, String> {
    let object = state.as_object_mut().ok_or_else(|| "invalid_state_object".to_string())?;
    let pending_rows = array_from(object, "pending_commit");
    let pending = remove_entry(pending_rows, proposal_id)
        .ok_or_else(|| format!("proposal_not_pending:{proposal_id}"))?;
    let rolled_back_rows = array_from(object, "rolled_back");
    let now = now_epoch_ms();
    let regret = json!({
        "proposal_id": proposal_id,
        "label": policy.regret_issue_label,
        "reason": reason,
        "trigger": trigger,
        "remediation_path": format!("review/{proposal_id}"),
        "ts_epoch_ms": now
    });
    let rolled = json!({
        "proposal": pending.get("proposal").cloned().unwrap_or_else(|| json!({"id": proposal_id})),
        "rolled_back_at_epoch_ms": now,
        "trigger": trigger,
        "reason": reason,
        "drift": drift,
        "yield_drop": yield_drop,
        "regret": regret
    });
    rolled_back_rows.push(rolled.clone());
    state["updated_at_epoch_ms"] = json!(now);
    append_jsonl(&policy.regrets_path, &regret)?;

    let mut receipt = base_receipt("autophagy_auto_approval_rollback", "rollback", policy);
    receipt["proposal_id"] = Value::String(proposal_id.to_string());
    receipt["trigger"] = Value::String(trigger.to_string());
    receipt["reason"] = Value::String(reason.to_string());
    receipt["drift"] = drift.map(Value::from).unwrap_or(Value::Null);
    receipt["yield_drop"] = yield_drop.map(Value::from).unwrap_or(Value::Null);
    receipt["regret_issue"] = regret;
    receipt["rolled_back_record"] = rolled;
    finalize_receipt(policy, &mut receipt)?;
    Ok(receipt)
}

fn monitor_command(argv: &[String], policy: &Policy) -> Result<Value, String> {
    let proposal_id =
        parse_flag(argv, "proposal-id").ok_or_else(|| "missing_proposal_id".to_string())?;
    let apply = parse_bool(parse_flag(argv, "apply").as_deref(), false);
    let drift = parse_f64(parse_flag(argv, "drift").as_deref());
    let yield_drop = parse_f64(parse_flag(argv, "yield-drop").as_deref());
    let now = now_epoch_ms();
    let mut state = load_state(&policy.state_path);

    let pending = state
        .get("pending_commit")
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter().find(|row| {
                row.get("proposal")
                    .and_then(Value::as_object)
                    .and_then(|proposal| proposal.get("id"))
                    .and_then(Value::as_str)
                    == Some(proposal_id.as_str())
            })
        })
        .cloned()
        .ok_or_else(|| format!("proposal_not_pending:{proposal_id}"))?;

    let deadline = pending
        .get("rollback_deadline_epoch_ms")
        .and_then(Value::as_i64)
        .unwrap_or(now);
    let drift_breach = drift
        .map(|value| value > policy.max_drift_delta)
        .unwrap_or(false);
    let yield_breach = yield_drop
        .map(|value| value > policy.max_yield_drop)
        .unwrap_or(false);
    let expired = now >= deadline;
    let trigger = if drift_breach || yield_breach {
        "degradation_threshold_breach"
    } else if expired {
        "rollback_window_expired"
    } else {
        "healthy_pending"
    };
    let should_rollback =
        policy.auto_rollback_on_degradation && (drift_breach || yield_breach || expired);

    if apply && should_rollback {
        let reason = if drift_breach || yield_breach {
            "degradation_detected"
        } else {
            "rollback_window_expired_without_commit"
        };
        let receipt = rollback_from_state(
            &mut state,
            policy,
            &proposal_id,
            trigger,
            reason,
            drift,
            yield_drop,
        )?;
        store_state(policy, &state)?;
        return Ok(receipt);
    }

    let mut receipt = base_receipt("autophagy_auto_approval_monitor", "monitor", policy);
    receipt["proposal_id"] = Value::String(proposal_id);
    receipt["drift"] = drift.map(Value::from).unwrap_or(Value::Null);
    receipt["yield_drop"] = yield_drop.map(Value::from).unwrap_or(Value::Null);
    receipt["rollback_deadline_epoch_ms"] = json!(deadline);
    receipt["expired"] = Value::Bool(expired);
    receipt["should_rollback"] = Value::Bool(should_rollback);
    receipt["trigger"] = Value::String(trigger.to_string());
    finalize_receipt(policy, &mut receipt)?;
    Ok(receipt)
}

fn commit_command(argv: &[String], policy: &Policy) -> Result<Value, String> {
    let proposal_id =
        parse_flag(argv, "proposal-id").ok_or_else(|| "missing_proposal_id".to_string())?;
    let reason = parse_flag(argv, "reason").unwrap_or_else(|| "human_confirmed".to_string());
    let mut state = load_state(&policy.state_path);
    let object = state
        .as_object_mut()
        .ok_or_else(|| "invalid_state_object".to_string())?;
    let pending_rows = array_from(object, "pending_commit");
    let pending = remove_entry(pending_rows, &proposal_id)
        .ok_or_else(|| format!("proposal_not_pending:{proposal_id}"))?;
    let committed_rows = array_from(object, "committed");
    let committed = json!({
        "proposal": pending.get("proposal").cloned().unwrap_or_else(|| json!({"id": proposal_id})),
        "committed_at_epoch_ms": now_epoch_ms(),
        "reason": reason
    });
    committed_rows.push(committed.clone());
    state["updated_at_epoch_ms"] = json!(now_epoch_ms());
    store_state(policy, &state)?;

    let mut receipt = base_receipt("autophagy_auto_approval_commit", "commit", policy);
    receipt["proposal_id"] = Value::String(proposal_id);
    receipt["reason"] = Value::String(reason);
    receipt["committed_record"] = committed;
    finalize_receipt(policy, &mut receipt)?;
    Ok(receipt)
}

fn rollback_command(argv: &[String], policy: &Policy) -> Result<Value, String> {
    let proposal_id =
        parse_flag(argv, "proposal-id").ok_or_else(|| "missing_proposal_id".to_string())?;
    let reason = parse_flag(argv, "reason").unwrap_or_else(|| "manual_rollback".to_string());
    let mut state = load_state(&policy.state_path);
    let receipt = rollback_from_state(
        &mut state,
        policy,
        &proposal_id,
        "manual_rollback",
        &reason,
        parse_f64(parse_flag(argv, "drift").as_deref()),
        parse_f64(parse_flag(argv, "yield-drop").as_deref()),
    )?;
    store_state(policy, &state)?;
    Ok(receipt)
}

fn cli_error(command: &str, error: &str) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "autophagy_auto_approval_cli_error",
        "authority": "core/layer2/ops",
        "command": command,
        "error": error,
        "ts_epoch_ms": now_epoch_ms()
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let command = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    let policy = load_policy(root, argv);
    let result = match command.as_str() {
        "evaluate" => evaluate_command(root, argv, &policy),
        "monitor" => monitor_command(argv, &policy),
        "commit" => commit_command(argv, &policy),
        "rollback" => rollback_command(argv, &policy),
        "status" => status_receipt(&policy),
        _ => Err("unknown_command".to_string()),
    };

    match result {
        Ok(receipt) => {
            print_json_line(&receipt);
            if receipt.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                0
            } else {
                1
            }
        }
        Err(error) => {
            print_json_line(&cli_error(&command, &error));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn temp_root(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "protheus_autophagy_auto_approval_{name}_{}",
            now_epoch_ms()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(path.join("client/runtime/config")).expect("config dir");
        path
    }

    fn write_policy(root: &Path) {
        let path = root.join("client/runtime/config/autophagy_auto_approval_policy.json");
        let policy = json!({
            "enabled": true,
            "auto_approval": {
                "enabled": true,
                "min_confidence": 0.85,
                "min_historical_success_rate": 0.90,
                "max_impact_score": 50,
                "excluded_types": ["safety_critical", "budget_hold"],
                "auto_rollback_on_degradation": true,
                "rollback_window_minutes": 1,
                "regret_issue_label": "auto_approval_regret",
                "degradation_threshold": {
                    "max_drift_delta": 0.01,
                    "max_yield_drop": 0.05
                }
            }
        });
        write_json(&path, &policy).expect("write policy");
    }

    #[test]
    fn evaluate_apply_creates_pending_commit_record() {
        let root = temp_root("evaluate");
        write_policy(&root);
        let args = vec![
            "evaluate".to_string(),
            "--apply=1".to_string(),
            "--proposal-json={\"id\":\"p1\",\"title\":\"Fix drift\",\"type\":\"ops_remediation\",\"confidence\":0.91,\"historical_success_rate\":0.94,\"impact_score\":18}".to_string(),
        ];
        assert_eq!(run(&root, &args), 0);
        let state = load_state(&root.join(DEFAULT_STATE_PATH));
        assert_eq!(
            state["pending_commit"].as_array().map(|rows| rows.len()),
            Some(1)
        );
    }

    #[test]
    fn excluded_type_requires_human_review() {
        let root = temp_root("excluded");
        write_policy(&root);
        let args = vec![
            "evaluate".to_string(),
            "--proposal-json={\"id\":\"p2\",\"title\":\"Touch safety\",\"type\":\"safety_critical\",\"confidence\":0.99,\"historical_success_rate\":0.99,\"impact_score\":1}".to_string(),
        ];
        let exit = run(&root, &args);
        assert_eq!(exit, 0);
        let latest = read_json(&root.join(DEFAULT_LATEST_PATH)).expect("latest");
        assert_eq!(
            latest.get("decision").and_then(Value::as_str),
            Some("human_review_required")
        );
    }

    #[test]
    fn monitor_can_auto_rollback_on_degradation() {
        let root = temp_root("monitor");
        write_policy(&root);
        let eval_args = vec![
            "evaluate".to_string(),
            "--apply=1".to_string(),
            "--proposal-json={\"id\":\"p3\",\"title\":\"Optimize batch\",\"type\":\"ops_remediation\",\"confidence\":0.92,\"historical_success_rate\":0.95,\"impact_score\":14}".to_string(),
        ];
        assert_eq!(run(&root, &eval_args), 0);
        let monitor_args = vec![
            "monitor".to_string(),
            "--proposal-id=p3".to_string(),
            "--drift=0.02".to_string(),
            "--yield-drop=0.00".to_string(),
            "--apply=1".to_string(),
        ];
        assert_eq!(run(&root, &monitor_args), 0);
        let state = load_state(&root.join(DEFAULT_STATE_PATH));
        assert_eq!(
            state["pending_commit"].as_array().map(|rows| rows.len()),
            Some(0)
        );
        assert_eq!(
            state["rolled_back"].as_array().map(|rows| rows.len()),
            Some(1)
        );
    }

    #[test]
    fn commit_moves_pending_into_committed() {
        let root = temp_root("commit");
        write_policy(&root);
        let eval_args = vec![
            "evaluate".to_string(),
            "--apply=1".to_string(),
            "--proposal-json={\"id\":\"p4\",\"title\":\"Refresh docs\",\"type\":\"documentation\",\"confidence\":0.95,\"historical_success_rate\":0.97,\"impact_score\":7}".to_string(),
        ];
        assert_eq!(run(&root, &eval_args), 0);
        std::thread::sleep(Duration::from_millis(5));
        let commit_args = vec![
            "commit".to_string(),
            "--proposal-id=p4".to_string(),
            "--reason=operator_confirmed".to_string(),
        ];
        assert_eq!(run(&root, &commit_args), 0);
        let state = load_state(&root.join(DEFAULT_STATE_PATH));
        assert_eq!(
            state["pending_commit"].as_array().map(|rows| rows.len()),
            Some(0)
        );
        assert_eq!(
            state["committed"].as_array().map(|rows| rows.len()),
            Some(1)
        );
    }
}
