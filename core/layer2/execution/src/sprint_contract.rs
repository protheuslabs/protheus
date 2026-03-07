// SPDX-License-Identifier: Apache-2.0
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize, Default)]
struct ContractTaskInput {
    id: Option<String>,
    title: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct ContractPlanInput {
    batch_mode: Option<bool>,
    tasks: Option<Vec<ContractTaskInput>>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct SprintContractInput {
    sprint_id: Option<String>,
    batch_id: Option<String>,
    requested_status: Option<String>,
    approval_recorded: Option<bool>,
    enforcer_active: Option<bool>,
    preamble_text: Option<String>,
    accepted_preamble: Option<String>,
    proof_refs: Option<Vec<String>>,
    blockers: Option<Vec<String>>,
    strict: Option<bool>,
    apply: Option<bool>,
    policy_path: Option<String>,
    plan: Option<ContractPlanInput>,
}

#[derive(Debug, Clone, Serialize)]
struct ContractTask {
    id: String,
    title: String,
    status: String,
}

#[derive(Debug, Clone, Serialize)]
struct SprintContractOutput {
    schema_id: String,
    schema_version: String,
    #[serde(rename = "type")]
    type_name: String,
    ts: String,
    ok: bool,
    sprint_id: String,
    batch_id: Option<String>,
    requested_status: String,
    effective_status: String,
    approval_recorded: bool,
    enforcer: Value,
    checks: BTreeMap<String, bool>,
    violations: Vec<String>,
    task_summary: Value,
    tasks: Vec<ContractTask>,
    proof_refs: Vec<String>,
    blockers: Vec<String>,
    policy_path: String,
    audit_id: String,
    strict: bool,
    apply: bool,
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("unix_ms:{}", now.as_millis())
}

fn clean_text(v: &str, max_len: usize) -> String {
    let compact = v.split_whitespace().collect::<Vec<&str>>().join(" ");
    compact.chars().take(max_len).collect::<String>()
}

fn normalize_token(v: &str, max_len: usize) -> String {
    let cleaned = clean_text(v, max_len).to_lowercase();
    let mut out = String::new();
    let mut prev_underscore = false;
    for ch in cleaned.chars() {
        let keep = ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '/' | '-');
        let normalized = if keep { ch } else { '_' };
        if normalized == '_' {
            if prev_underscore {
                continue;
            }
            prev_underscore = true;
            out.push('_');
        } else {
            prev_underscore = false;
            out.push(normalized);
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    trimmed.chars().take(max_len).collect::<String>()
}

fn normalize_status(v: &str) -> String {
    let token = normalize_token(v, 40);
    if token == "done" {
        return "completed".to_string();
    }
    if token.is_empty() {
        "in_progress".to_string()
    } else {
        token
    }
}

fn normalize_list(input: Option<Vec<String>>) -> Vec<String> {
    input
        .unwrap_or_default()
        .into_iter()
        .map(|v| clean_text(&v, 320))
        .filter(|v| !v.is_empty())
        .collect()
}

fn stable_hash(seed: &str, len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let hex = hex::encode(hasher.finalize());
    hex.chars().take(len).collect::<String>()
}

fn validate_order(tasks: &[ContractTask]) -> bool {
    let mut first_non_completed_seen = false;
    for task in tasks {
        let is_completed = task.status == "completed";
        if !is_completed {
            first_non_completed_seen = true;
        }
        if is_completed && first_non_completed_seen {
            return false;
        }
    }
    true
}

fn summarize_tasks(tasks: &[ContractTask]) -> Value {
    let mut by_status: Map<String, Value> = Map::new();
    for task in tasks {
        let current = by_status
            .get(task.status.as_str())
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        by_status.insert(task.status.clone(), json!(current + 1));
    }
    json!({
        "total": tasks.len(),
        "by_status": by_status
    })
}

pub fn run_sprint_contract_json(payload: &str) -> Result<String, String> {
    let parsed: SprintContractInput =
        serde_json::from_str(payload).map_err(|e| format!("payload_parse_failed:{e}"))?;

    let sprint_id = clean_text(
        parsed.sprint_id.as_deref().unwrap_or("V6-RUST50-CONF-002"),
        80,
    );
    let batch_id = normalize_token(parsed.batch_id.as_deref().unwrap_or(""), 120);
    let requested_status = normalize_token(
        parsed.requested_status.as_deref().unwrap_or("in_progress"),
        40,
    );
    let approval_recorded = parsed.approval_recorded.unwrap_or(false);
    let enforcer_active = parsed.enforcer_active.unwrap_or(false);
    let preamble_text = clean_text(parsed.preamble_text.as_deref().unwrap_or(""), 220);
    let accepted_preamble = clean_text(
        parsed
            .accepted_preamble
            .as_deref()
            .unwrap_or("ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST."),
        220,
    );
    let strict = parsed.strict.unwrap_or(true);
    let apply = parsed.apply.unwrap_or(true);
    let proof_refs = normalize_list(parsed.proof_refs);
    let blockers = normalize_list(parsed.blockers);
    let policy_path = clean_text(parsed.policy_path.as_deref().unwrap_or(""), 320);

    let plan = parsed.plan.unwrap_or_default();
    let plan_batch_mode = plan.batch_mode.unwrap_or(true);
    let tasks = plan
        .tasks
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(idx, task)| {
            let id_raw = task.id.clone();
            let title_raw = task.title.clone();
            let status_raw = task.status.clone();
            let id_seed = id_raw.unwrap_or_else(|| format!("task_{}", idx + 1));
            ContractTask {
                id: {
                    let token = normalize_token(&id_seed, 100);
                    if token.is_empty() {
                        format!("task_{}", idx + 1)
                    } else {
                        token
                    }
                },
                title: clean_text(title_raw.as_deref().unwrap_or(&id_seed), 200),
                status: normalize_status(status_raw.as_deref().unwrap_or("in_progress")),
            }
        })
        .collect::<Vec<ContractTask>>();

    let mut checks = BTreeMap::new();
    checks.insert(
        "enforcer_preamble_ack".to_string(),
        enforcer_active && preamble_text == accepted_preamble,
    );
    checks.insert("batch_id_present".to_string(), !batch_id.is_empty());
    checks.insert("single_batch_mode".to_string(), plan_batch_mode);
    checks.insert("ordered_execution".to_string(), validate_order(&tasks));
    checks.insert(
        "no_skip".to_string(),
        !tasks.is_empty() && !tasks.iter().any(|task| task.status == "skipped"),
    );
    checks.insert("audit_artifact_ready".to_string(), true);

    let all_completed = !tasks.is_empty() && tasks.iter().all(|task| task.status == "completed");
    let no_premature_done = requested_status != "done"
        || (all_completed && blockers.is_empty() && !proof_refs.is_empty() && approval_recorded);
    checks.insert("no_premature_done".to_string(), no_premature_done);

    let violations = checks
        .iter()
        .filter_map(|(k, v)| if !v { Some(k.clone()) } else { None })
        .collect::<Vec<String>>();
    let ok = violations.is_empty();
    let effective_status = if ok {
        if requested_status == "done" {
            "DONE_READY_FOR_HUMAN_AUDIT".to_string()
        } else {
            "IN_PROGRESS".to_string()
        }
    } else {
        "PAUSED".to_string()
    };

    let audit_seed = format!(
        "{}|{}|{}|{}|{}|{}",
        sprint_id,
        batch_id,
        requested_status,
        tasks.len(),
        violations.join(","),
        proof_refs.join(",")
    );
    let audit_id = format!("audit_{}", stable_hash(&audit_seed, 20));

    let output = SprintContractOutput {
        schema_id: "rust50_sprint_contract_audit".to_string(),
        schema_version: "1.0".to_string(),
        type_name: "rust50_sprint_contract".to_string(),
        ts: now_iso(),
        ok,
        sprint_id,
        batch_id: if batch_id.is_empty() {
            None
        } else {
            Some(batch_id)
        },
        requested_status: if requested_status.is_empty() {
            "in_progress".to_string()
        } else {
            requested_status
        },
        effective_status,
        approval_recorded,
        enforcer: json!({
            "active": enforcer_active,
            "preamble_expected": accepted_preamble,
            "preamble_provided": preamble_text
        }),
        checks,
        violations,
        task_summary: summarize_tasks(&tasks),
        tasks,
        proof_refs,
        blockers,
        policy_path,
        audit_id,
        strict,
        apply,
    };

    serde_json::to_string(&output).map_err(|e| format!("output_serialize_failed:{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_fails_without_enforcer_ack() {
        let payload = json!({
            "sprint_id": "V6-RUST50-CONF-002",
            "batch_id": "batch_a",
            "requested_status": "in_progress",
            "enforcer_active": false,
            "preamble_text": "ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST.",
            "accepted_preamble": "ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST.",
            "plan": {
                "batch_mode": true,
                "tasks": [
                    {"id": "t1", "status": "completed"},
                    {"id": "t2", "status": "in_progress"}
                ]
            }
        })
        .to_string();
        let out: Value =
            serde_json::from_str(&run_sprint_contract_json(&payload).unwrap()).unwrap();
        assert_eq!(out["ok"], Value::Bool(false));
        assert!(out["violations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str() == Some("enforcer_preamble_ack")));
    }

    #[test]
    fn done_requires_approval_and_proof_refs() {
        let payload = json!({
            "sprint_id": "V6-RUST50-CONF-002",
            "batch_id": "batch_done",
            "requested_status": "done",
            "enforcer_active": true,
            "approval_recorded": true,
            "preamble_text": "ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST.",
            "accepted_preamble": "ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST.",
            "proof_refs": ["diff://x", "build://x", "test://x"],
            "plan": {
                "batch_mode": true,
                "tasks": [
                    {"id": "t1", "status": "completed"},
                    {"id": "t2", "status": "completed"}
                ]
            }
        })
        .to_string();
        let out: Value =
            serde_json::from_str(&run_sprint_contract_json(&payload).unwrap()).unwrap();
        assert_eq!(out["ok"], Value::Bool(true));
        assert_eq!(
            out["effective_status"],
            Value::String("DONE_READY_FOR_HUMAN_AUDIT".to_string())
        );
    }
}
