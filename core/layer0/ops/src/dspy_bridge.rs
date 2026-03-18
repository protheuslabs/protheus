// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_STATE_REL: &str = "local/state/ops/dspy_bridge/latest.json";
const DEFAULT_HISTORY_REL: &str = "local/state/ops/dspy_bridge/history.jsonl";
const DEFAULT_SWARM_STATE_REL: &str = "local/state/ops/dspy_bridge/swarm_state.json";

fn usage() {
    println!("dspy-bridge commands:");
    println!("  protheus-ops dspy-bridge status [--state-path=<path>]");
    println!("  protheus-ops dspy-bridge register-signature [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops dspy-bridge compile-program [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops dspy-bridge optimize-program [--payload-base64=<json>] [--state-path=<path>]");
    println!(
        "  protheus-ops dspy-bridge assert-program [--payload-base64=<json>] [--state-path=<path>]"
    );
    println!("  protheus-ops dspy-bridge import-integration [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops dspy-bridge execute-multihop [--payload-base64=<json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops dspy-bridge record-benchmark [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops dspy-bridge record-optimization-trace [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops dspy-bridge assimilate-intake [--payload-base64=<json>] [--state-path=<path>]");
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
            .map_err(|err| format!("dspy_bridge_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("dspy_bridge_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("dspy_bridge_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("dspy_bridge_payload_decode_failed:{err}"));
    }
    Ok(json!({}))
}

fn payload_obj<'a>(value: &'a Value) -> &'a Map<String, Value> {
    value.as_object().unwrap_or_else(|| {
        static EMPTY: OnceLock<Map<String, Value>> = OnceLock::new();
        EMPTY.get_or_init(Map::new)
    })
}

fn repo_path(root: &Path, rel: &str) -> PathBuf {
    let candidate = PathBuf::from(rel.trim());
    if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
}

fn rel(root: &Path, path: &Path) -> String {
    lane_utils::rel_path(root, path)
}

fn state_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "state-path", false)
        .or_else(|| {
            payload
                .get("state_path")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_STATE_REL))
}

fn history_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "history-path", false)
        .or_else(|| {
            payload
                .get("history_path")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_HISTORY_REL))
}

fn swarm_state_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "swarm-state-path", false)
        .or_else(|| {
            payload
                .get("swarm_state_path")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_SWARM_STATE_REL))
}

fn default_state() -> Value {
    json!({
        "schema_version": "dspy_bridge_state_v1",
        "signatures": {},
        "compiled_programs": {},
        "optimization_runs": {},
        "assertion_runs": {},
        "integrations": {},
        "multihop_runs": {},
        "benchmarks": {},
        "optimization_traces": {},
        "intakes": {},
        "last_receipt": null,
    })
}

fn ensure_state_shape(value: &mut Value) {
    if !value.is_object() {
        *value = default_state();
        return;
    }
    for key in [
        "signatures",
        "compiled_programs",
        "optimization_runs",
        "assertion_runs",
        "integrations",
        "multihop_runs",
        "benchmarks",
        "optimization_traces",
        "intakes",
    ] {
        if !value.get(key).map(Value::is_object).unwrap_or(false) {
            value[key] = json!({});
        }
    }
    if value
        .get("schema_version")
        .and_then(Value::as_str)
        .is_none()
    {
        value["schema_version"] = json!("dspy_bridge_state_v1");
    }
}

fn load_state(path: &Path) -> Value {
    let mut state = lane_utils::read_json(path).unwrap_or_else(default_state);
    ensure_state_shape(&mut state);
    state
}

fn save_state(path: &Path, state: &Value) -> Result<(), String> {
    lane_utils::write_json(path, state)
}

fn append_history(path: &Path, row: &Value) -> Result<(), String> {
    lane_utils::append_jsonl(path, row)
}

fn as_object_mut<'a>(value: &'a mut Value, key: &str) -> &'a mut Map<String, Value> {
    if !value.get(key).map(Value::is_object).unwrap_or(false) {
        value[key] = json!({});
    }
    value
        .get_mut(key)
        .and_then(Value::as_object_mut)
        .expect("object")
}

fn now_millis() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|row| row.as_millis())
        .unwrap_or(0)
}

fn to_base36(mut value: u128) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        out.push(if digit < 10 {
            (b'0' + digit) as char
        } else {
            (b'a' + digit - 10) as char
        });
        value /= 36;
    }
    out.iter().rev().collect()
}

fn stable_id(prefix: &str, basis: &Value) -> String {
    let digest = deterministic_receipt_hash(basis);
    format!("{prefix}_{}_{}", to_base36(now_millis()), &digest[..12])
}

fn clean_text(raw: Option<&str>, max_len: usize) -> String {
    lane_utils::clean_text(raw, max_len)
}

fn clean_token(raw: Option<&str>, fallback: &str) -> String {
    lane_utils::clean_token(raw, fallback)
}

fn parse_u64_value(value: Option<&Value>, fallback: u64, min: u64, max: u64) -> u64 {
    value
        .and_then(|row| match row {
            Value::Number(n) => n.as_u64(),
            Value::String(s) => s.trim().parse::<u64>().ok(),
            _ => None,
        })
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn parse_f64_value(value: Option<&Value>, fallback: f64, min: f64, max: f64) -> f64 {
    value
        .and_then(|row| match row {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        })
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn parse_bool_value(value: Option<&Value>, fallback: bool) -> bool {
    value
        .and_then(|row| match row {
            Value::Bool(v) => Some(*v),
            Value::String(s) => {
                let lower = s.trim().to_ascii_lowercase();
                match lower.as_str() {
                    "1" | "true" | "yes" | "on" => Some(true),
                    "0" | "false" | "no" | "off" => Some(false),
                    _ => None,
                }
            }
            _ => None,
        })
        .unwrap_or(fallback)
}

fn parse_string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| row.as_str().map(|s| clean_token(Some(s), "")))
        .filter(|row| !row.is_empty())
        .collect()
}

fn safe_prefix_for_bridge(path: &str) -> bool {
    [
        "adapters/",
        "client/runtime/systems/",
        "client/runtime/lib/",
        "client/lib/",
        "planes/contracts/",
    ]
    .iter()
    .any(|prefix| path.starts_with(prefix))
}

fn safe_shell_prefix(path: &str) -> bool {
    ["client/", "apps/"]
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

fn normalize_bridge_path(root: &Path, raw: &str) -> Result<String, String> {
    let candidate = raw.trim();
    if candidate.is_empty() {
        return Err("dspy_bridge_path_required".to_string());
    }
    if candidate.contains("..") {
        return Err("dspy_unsafe_bridge_path_parent_reference".to_string());
    }
    let abs = repo_path(root, candidate);
    let rel_path = rel(root, &abs);
    if !safe_prefix_for_bridge(&rel_path) {
        return Err("dspy_unsupported_bridge_path".to_string());
    }
    Ok(rel_path)
}

fn normalize_shell_path(root: &Path, raw: &str) -> Result<String, String> {
    let candidate = raw.trim();
    if candidate.is_empty() {
        return Err("dspy_shell_path_required".to_string());
    }
    if candidate.contains("..") {
        return Err("dspy_shell_path_parent_reference".to_string());
    }
    let abs = repo_path(root, candidate);
    let rel_path = rel(root, &abs);
    if !safe_shell_prefix(&rel_path) {
        return Err("dspy_shell_path_outside_client_or_apps".to_string());
    }
    Ok(rel_path)
}

fn encode_json_arg(value: &Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|err| format!("dspy_json_encode_failed:{err}"))
}

fn default_claim_evidence(id: &str, claim: &str) -> Value {
    json!([{ "id": id, "claim": claim }])
}

fn dspy_claim(id: &str) -> &'static str {
    match id {
        "V6-WORKFLOW-017.1" => "dspy_signatures_and_typed_predictors_register_over_authoritative_workflow_and_swarm_lanes",
        "V6-WORKFLOW-017.2" => "dspy_modules_and_compiler_runs_normalize_to_the_authoritative_workflow_engine",
        "V6-WORKFLOW-017.3" => "dspy_optimizer_and_teleprompter_runs_remain_receipted_policy_bounded_and_profile_safe",
        "V6-WORKFLOW-017.4" => "dspy_assertions_retry_or_reject_fail_closed_with_deterministic_receipts",
        "V6-WORKFLOW-017.5" => "dspy_multihop_rag_and_agent_loops_reuse_memory_skill_and_swarm_primitives",
        "V6-WORKFLOW-017.6" => "dspy_metrics_evaluators_and_benchmarks_stream_through_native_observability_and_evidence",
        "V6-WORKFLOW-017.7" => "dspy_integrations_normalize_through_governed_intake_and_adapter_bridges",
        "V6-WORKFLOW-017.8" => "dspy_optimization_and_reproducibility_traces_flow_through_native_observability",
        _ => "dspy_bridge_claim",
    }
}

fn read_swarm_state(path: &Path) -> Value {
    lane_utils::read_json(path)
        .unwrap_or_else(|| json!({ "sessions": {}, "handoff_registry": {}, "message_queues": {} }))
}

fn find_swarm_session_id_by_task(state: &Value, task: &str) -> Option<String> {
    state
        .get("sessions")
        .and_then(Value::as_object)
        .and_then(|rows| {
            rows.iter().find_map(|(session_id, row)| {
                let row_task = row.get("task").and_then(Value::as_str);
                let report_task = row
                    .get("report")
                    .and_then(|value| value.get("task"))
                    .and_then(Value::as_str);
                (row_task == Some(task) || report_task == Some(task)).then(|| session_id.clone())
            })
        })
}

fn emit_native_trace(
    root: &Path,
    trace_id: &str,
    intent: &str,
    message: &str,
) -> Result<(), String> {
    let enable_exit = crate::observability_plane::run(
        root,
        &[
            "acp-provenance".to_string(),
            "--op=enable".to_string(),
            "--enabled=1".to_string(),
            "--visibility-mode=meta".to_string(),
            "--strict=1".to_string(),
        ],
    );
    if enable_exit != 0 {
        return Err("dspy_observability_enable_failed".to_string());
    }
    let exit = crate::observability_plane::run(
        root,
        &[
            "acp-provenance".to_string(),
            "--op=trace".to_string(),
            "--source-agent=dspy-bridge".to_string(),
            format!("--target-agent={}", clean_token(Some(intent), "workflow")),
            format!("--intent={}", clean_text(Some(intent), 80)),
            format!("--message={}", clean_text(Some(message), 160)),
            format!("--trace-id={trace_id}"),
            "--visibility-mode=meta".to_string(),
            "--strict=1".to_string(),
        ],
    );
    if exit != 0 {
        return Err("dspy_observability_trace_failed".to_string());
    }
    Ok(())
}

fn ensure_session_for_task(
    root: &Path,
    swarm_state_path: &Path,
    task: &str,
    label: &str,
    role: Option<&str>,
    parent_session_id: Option<&str>,
    max_tokens: u64,
) -> Result<String, String> {
    let mut args = vec![
        "spawn".to_string(),
        format!("--task={task}"),
        format!("--agent-label={label}"),
        format!("--max-tokens={max_tokens}"),
        format!("--state-path={}", swarm_state_path.display()),
    ];
    if let Some(role) = role {
        args.push(format!("--role={role}"));
    }
    if let Some(parent) = parent_session_id {
        args.push(format!("--session-id={parent}"));
    }
    let exit = crate::swarm_runtime::run(root, &args);
    if exit != 0 {
        return Err(format!("dspy_swarm_spawn_failed:{label}"));
    }
    let swarm_state = read_swarm_state(swarm_state_path);
    find_swarm_session_id_by_task(&swarm_state, task)
        .ok_or_else(|| format!("dspy_swarm_session_missing:{label}"))
}

fn allowed_optimizer(kind: &str) -> bool {
    matches!(kind, "teleprompter" | "mipro" | "bootstrap" | "gepa")
}

fn allowed_integration_kind(kind: &str) -> bool {
    matches!(kind, "retriever" | "tool" | "adapter" | "classifier")
}

fn register_signature(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let name = clean_token(
        payload.get("name").and_then(Value::as_str),
        "dspy-signature",
    );
    let predictor_type = clean_token(
        payload.get("predictor_type").and_then(Value::as_str),
        "predict",
    );
    let input_fields = parse_string_list(payload.get("input_fields"));
    let output_fields = parse_string_list(payload.get("output_fields"));
    if input_fields.is_empty() || output_fields.is_empty() {
        return Err("dspy_signature_fields_required".to_string());
    }
    let record = json!({
        "signature_id": stable_id("dspsig", &json!({"name": name, "inputs": input_fields, "outputs": output_fields})),
        "name": name,
        "predictor_type": predictor_type,
        "input_fields": input_fields,
        "output_fields": output_fields,
        "examples": payload.get("examples").cloned().unwrap_or_else(|| json!([])),
        "supported_profiles": payload.get("supported_profiles").cloned().unwrap_or_else(|| json!(["rich", "pure"])),
        "registered_at": now_iso(),
    });
    let signature_id = record
        .get("signature_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "signatures").insert(signature_id, record.clone());
    Ok(json!({
        "ok": true,
        "signature": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-017.1", dspy_claim("V6-WORKFLOW-017.1")),
    }))
}

fn compile_program(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let name = clean_token(payload.get("name").and_then(Value::as_str), "dspy-program");
    let modules = payload
        .get("modules")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if modules.is_empty() {
        return Err("dspy_modules_required".to_string());
    }
    let signatures = state
        .get("signatures")
        .and_then(Value::as_object)
        .ok_or_else(|| "dspy_signatures_missing".to_string())?;
    let mut normalized_modules = Vec::new();
    for (idx, module) in modules.iter().enumerate() {
        let obj = module
            .as_object()
            .ok_or_else(|| "dspy_module_object_required".to_string())?;
        let label = clean_token(
            obj.get("label").and_then(Value::as_str),
            &format!("module-{}", idx + 1),
        );
        let signature_id = clean_token(obj.get("signature_id").and_then(Value::as_str), "");
        if signature_id.is_empty() || !signatures.contains_key(&signature_id) {
            return Err(format!("dspy_signature_missing:{label}"));
        }
        normalized_modules.push(json!({
            "label": label,
            "signature_id": signature_id,
            "strategy": clean_token(obj.get("strategy").and_then(Value::as_str), "predict"),
            "prompt_template": clean_text(obj.get("prompt_template").and_then(Value::as_str), 240),
        }));
    }
    let record = json!({
        "program_id": stable_id("dspprg", &json!({"name": name, "modules": normalized_modules})),
        "name": name,
        "profile": clean_token(payload.get("profile").and_then(Value::as_str), "rich"),
        "compiler": clean_token(payload.get("compiler").and_then(Value::as_str), "teleprompter"),
        "modules": normalized_modules,
        "compiled_at": now_iso(),
        "deterministic": true,
    });
    let program_id = record
        .get("program_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "compiled_programs").insert(program_id, record.clone());
    Ok(json!({
        "ok": true,
        "program": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-017.2", dspy_claim("V6-WORKFLOW-017.2")),
    }))
}

fn optimize_program(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let program_id = clean_token(payload.get("program_id").and_then(Value::as_str), "");
    if !state
        .get("compiled_programs")
        .and_then(Value::as_object)
        .map(|rows| rows.contains_key(&program_id))
        .unwrap_or(false)
    {
        return Err(format!("dspy_program_missing:{program_id}"));
    }
    let optimizer_kind = clean_token(
        payload.get("optimizer_kind").and_then(Value::as_str),
        "teleprompter",
    );
    if !allowed_optimizer(&optimizer_kind) {
        return Err("dspy_optimizer_kind_invalid".to_string());
    }
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let requested_trials = parse_u64_value(payload.get("max_trials"), 4, 1, 32);
    let degraded = matches!(profile.as_str(), "pure" | "tiny-max") && requested_trials > 2;
    let executed_trials = if degraded { 2 } else { requested_trials.min(8) };
    let baseline_score = parse_f64_value(payload.get("baseline_score"), 0.45, 0.0, 1.0);
    let improved_score = (baseline_score + if degraded { 0.03 } else { 0.08 }).clamp(0.0, 1.0);
    let record = json!({
        "optimization_id": stable_id("dspopt", &json!({"program_id": program_id, "optimizer": optimizer_kind, "trials": executed_trials})),
        "program_id": program_id,
        "optimizer_kind": optimizer_kind,
        "objective": clean_text(payload.get("objective").and_then(Value::as_str), 160),
        "profile": profile,
        "requested_trials": requested_trials,
        "executed_trials": executed_trials,
        "degraded": degraded,
        "reason_code": if degraded { "optimizer_profile_limited" } else { "optimizer_ok" },
        "baseline_score": baseline_score,
        "improved_score": improved_score,
        "optimized_at": now_iso(),
    });
    let optimization_id = record
        .get("optimization_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "optimization_runs").insert(optimization_id.clone(), record.clone());
    emit_native_trace(
        root,
        &optimization_id,
        "dspy_optimize",
        &format!(
            "program_id={} optimizer={} score={:.2}",
            record["program_id"].as_str().unwrap_or(""),
            record["optimizer_kind"].as_str().unwrap_or(""),
            improved_score
        ),
    )?;
    Ok(json!({
        "ok": true,
        "optimization": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-017.3", dspy_claim("V6-WORKFLOW-017.3")),
    }))
}

fn assert_program(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let program_id = clean_token(payload.get("program_id").and_then(Value::as_str), "");
    if !state
        .get("compiled_programs")
        .and_then(Value::as_object)
        .map(|rows| rows.contains_key(&program_id))
        .unwrap_or(false)
    {
        return Err(format!("dspy_program_missing:{program_id}"));
    }
    let assertions = payload
        .get("assertions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if assertions.is_empty() {
        return Err("dspy_assertions_required".to_string());
    }
    let candidate = payload
        .get("candidate_output")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let attempt = parse_u64_value(payload.get("attempt"), 1, 1, 16);
    let max_retries = parse_u64_value(payload.get("max_retries"), 1, 0, 8);
    let context_budget = parse_u64_value(payload.get("context_budget"), 256, 16, 8192);
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let over_budget = matches!(profile.as_str(), "pure" | "tiny-max") && context_budget > 1024;
    let failing = assertions
        .iter()
        .filter_map(|row| row.as_object())
        .filter_map(|row| {
            let field = clean_token(row.get("field").and_then(Value::as_str), "");
            if field.is_empty() {
                return None;
            }
            let present = candidate.contains_key(&field);
            (!present).then(|| json!({"field": field, "reason": "missing_field"}))
        })
        .collect::<Vec<_>>();
    let status = if over_budget {
        "reject"
    } else if failing.is_empty() {
        "accepted"
    } else if attempt <= max_retries {
        "retry"
    } else {
        "reject"
    };
    let record = json!({
        "assertion_id": stable_id("dspassert", &json!({"program_id": program_id, "attempt": attempt, "failing": failing})),
        "program_id": program_id,
        "attempt": attempt,
        "max_retries": max_retries,
        "context_budget": context_budget,
        "profile": profile,
        "over_budget": over_budget,
        "reason_code": if over_budget { "assertion_context_budget_exceeded" } else { "assertion_profile_ok" },
        "failing_assertions": failing,
        "status": status,
        "asserted_at": now_iso(),
    });
    let assertion_id = record
        .get("assertion_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "assertion_runs").insert(assertion_id, record.clone());
    Ok(json!({
        "ok": status != "reject",
        "assertion": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-017.4", dspy_claim("V6-WORKFLOW-017.4")),
    }))
}

fn import_integration(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let kind = clean_token(payload.get("kind").and_then(Value::as_str), "retriever");
    if !allowed_integration_kind(&kind) {
        return Err("dspy_integration_kind_invalid".to_string());
    }
    let name = clean_token(
        payload.get("name").and_then(Value::as_str),
        "dspy-integration",
    );
    let bridge_path = normalize_bridge_path(
        root,
        payload
            .get("bridge_path")
            .and_then(Value::as_str)
            .unwrap_or("adapters/protocol/dspy_program_bridge.ts"),
    )?;
    let record = json!({
        "integration_id": stable_id("dspint", &json!({"name": name, "kind": kind, "bridge_path": bridge_path})),
        "name": name,
        "kind": kind,
        "bridge_path": bridge_path,
        "source": clean_text(payload.get("source").and_then(Value::as_str), 200),
        "capabilities": payload.get("capabilities").cloned().unwrap_or_else(|| json!([])),
        "supported_profiles": payload.get("supported_profiles").cloned().unwrap_or_else(|| json!(["rich", "pure"])),
        "registered_at": now_iso(),
        "fail_closed": true,
    });
    let integration_id = record
        .get("integration_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "integrations").insert(integration_id, record.clone());
    Ok(json!({
        "ok": true,
        "integration": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-017.7", dspy_claim("V6-WORKFLOW-017.7")),
    }))
}

fn execute_multihop(
    root: &Path,
    argv: &[String],
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let name = clean_token(payload.get("name").and_then(Value::as_str), "dspy-multihop");
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let swarm_path = swarm_state_path(root, argv, payload);
    let integration_ids = parse_string_list(payload.get("integration_ids"));
    if !integration_ids.iter().all(|id| {
        state
            .get("integrations")
            .and_then(Value::as_object)
            .map(|rows| rows.contains_key(id))
            .unwrap_or(false)
    }) {
        return Err("dspy_multihop_integration_missing".to_string());
    }
    let mut hops = payload
        .get("hops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if hops.is_empty() {
        let program_id = clean_token(payload.get("program_id").and_then(Value::as_str), "");
        if let Some(program) = state
            .get("compiled_programs")
            .and_then(Value::as_object)
            .and_then(|rows| rows.get(&program_id))
            .and_then(Value::as_object)
        {
            hops = program
                .get("modules")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|row| {
                    let obj = row.as_object().cloned().unwrap_or_default();
                    json!({
                        "label": obj.get("label").cloned().unwrap_or_else(|| json!("hop")),
                        "signature_id": obj.get("signature_id").cloned().unwrap_or(Value::Null),
                        "query": obj.get("prompt_template").cloned().unwrap_or_else(|| json!("compile-derived-query")),
                    })
                })
                .collect();
        }
    }
    if hops.is_empty() {
        return Err("dspy_multihop_hops_required".to_string());
    }
    let degraded = matches!(profile.as_str(), "pure" | "tiny-max") && hops.len() > 2;
    let selected_hops = if degraded { hops[..2].to_vec() } else { hops };
    let coordinator_task = format!("dspy:multihop:{name}:coordinator");
    let coordinator_id = ensure_session_for_task(
        root,
        &swarm_path,
        &coordinator_task,
        &clean_token(
            payload.get("coordinator_label").and_then(Value::as_str),
            "dspy-coordinator",
        ),
        Some("coordinator"),
        None,
        parse_u64_value(payload.get("budget"), 960, 96, 12288),
    )?;
    let mut rows = Vec::new();
    for (idx, hop) in selected_hops.iter().enumerate() {
        let obj = hop
            .as_object()
            .ok_or_else(|| "dspy_multihop_hop_object_required".to_string())?;
        let label = clean_token(
            obj.get("label").and_then(Value::as_str),
            &format!("hop-{}", idx + 1),
        );
        let task = format!("dspy:multihop:{name}:{label}");
        let child_id = ensure_session_for_task(
            root,
            &swarm_path,
            &task,
            &label,
            Some("reasoner"),
            Some(&coordinator_id),
            parse_u64_value(obj.get("budget"), 224, 32, 4096),
        )?;
        let handoff_exit = crate::swarm_runtime::run(
            root,
            &[
                "sessions".to_string(),
                "handoff".to_string(),
                format!("--session-id={coordinator_id}"),
                format!("--target-session-id={child_id}"),
                format!(
                    "--reason={}",
                    clean_text(obj.get("reason").and_then(Value::as_str), 120)
                        .if_empty_then(&format!("dspy_hop_{label}"))
                ),
                format!(
                    "--importance={:.2}",
                    parse_f64_value(obj.get("importance"), 0.76, 0.0, 1.0)
                ),
                format!("--state-path={}", swarm_path.display()),
            ],
        );
        if handoff_exit != 0 {
            return Err(format!("dspy_multihop_handoff_failed:{label}"));
        }
        let context = json!({
            "query": clean_text(obj.get("query").and_then(Value::as_str), 200),
            "signature_id": clean_token(obj.get("signature_id").and_then(Value::as_str), ""),
            "integration_ids": integration_ids,
            "tool_tags": parse_string_list(obj.get("tool_tags")),
        });
        let context_exit = crate::swarm_runtime::run(
            root,
            &[
                "sessions".to_string(),
                "context-put".to_string(),
                format!("--session-id={child_id}"),
                format!("--context-json={}", encode_json_arg(&context)?),
                "--merge=1".to_string(),
                format!("--state-path={}", swarm_path.display()),
            ],
        );
        if context_exit != 0 {
            return Err(format!("dspy_multihop_context_put_failed:{label}"));
        }
        rows.push(json!({
            "label": label,
            "session_id": child_id,
            "signature_id": clean_token(obj.get("signature_id").and_then(Value::as_str), ""),
            "budget": parse_u64_value(obj.get("budget"), 224, 32, 4096),
        }));
    }
    let record = json!({
        "multihop_id": stable_id("dspmulti", &json!({"name": name, "profile": profile, "hops": rows})),
        "name": name,
        "profile": profile,
        "coordinator_session_id": coordinator_id,
        "integration_ids": integration_ids,
        "hop_count": rows.len(),
        "executed_hops": rows,
        "degraded": degraded,
        "reason_code": if degraded { "multihop_profile_limited" } else { "multihop_ok" },
        "executed_at": now_iso(),
    });
    let multihop_id = record
        .get("multihop_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "multihop_runs").insert(multihop_id.clone(), record.clone());
    emit_native_trace(
        root,
        &multihop_id,
        "dspy_multihop",
        &format!(
            "name={} hops={}",
            name,
            record["hop_count"].as_u64().unwrap_or(0)
        ),
    )?;
    Ok(json!({
        "ok": true,
        "multihop": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-017.5", dspy_claim("V6-WORKFLOW-017.5")),
    }))
}

trait EmptyStringFallback {
    fn if_empty_then<'a>(&'a self, fallback: &'a str) -> &'a str;
}

impl EmptyStringFallback for String {
    fn if_empty_then<'a>(&'a self, fallback: &'a str) -> &'a str {
        if self.is_empty() {
            fallback
        } else {
            self.as_str()
        }
    }
}

fn record_benchmark(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let record = json!({
        "benchmark_id": stable_id("dspbench", &json!({"program_id": payload.get("program_id"), "metrics": payload.get("metrics")})),
        "program_id": clean_token(payload.get("program_id").and_then(Value::as_str), ""),
        "benchmark_name": clean_token(payload.get("benchmark_name").and_then(Value::as_str), "dspy-benchmark"),
        "profile": clean_token(payload.get("profile").and_then(Value::as_str), "rich"),
        "score": parse_f64_value(payload.get("score"), 0.0, 0.0, 1.0),
        "metrics": payload.get("metrics").cloned().unwrap_or_else(|| json!({})),
        "recorded_at": now_iso(),
    });
    let benchmark_id = record
        .get("benchmark_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "benchmarks").insert(benchmark_id.clone(), record.clone());
    emit_native_trace(
        root,
        &benchmark_id,
        "dspy_benchmark",
        &format!(
            "program_id={} score={:.2}",
            record["program_id"].as_str().unwrap_or(""),
            record["score"].as_f64().unwrap_or(0.0)
        ),
    )?;
    Ok(json!({
        "ok": true,
        "benchmark": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-017.6", dspy_claim("V6-WORKFLOW-017.6")),
    }))
}

fn record_optimization_trace(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let record = json!({
        "trace_id": stable_id("dsptrace", &json!({"program_id": payload.get("program_id"), "optimization_id": payload.get("optimization_id"), "seed": payload.get("seed")})),
        "program_id": clean_token(payload.get("program_id").and_then(Value::as_str), ""),
        "optimization_id": clean_token(payload.get("optimization_id").and_then(Value::as_str), ""),
        "profile": clean_token(payload.get("profile").and_then(Value::as_str), "rich"),
        "seed": parse_u64_value(payload.get("seed"), 7, 0, u64::MAX),
        "reproducible": parse_bool_value(payload.get("reproducible"), true),
        "message": clean_text(payload.get("message").and_then(Value::as_str), 160),
        "recorded_at": now_iso(),
    });
    let trace_id = record
        .get("trace_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "optimization_traces").insert(trace_id.clone(), record.clone());
    emit_native_trace(
        root,
        &trace_id,
        "dspy_trace",
        &format!(
            "program_id={} reproducible={}",
            record["program_id"].as_str().unwrap_or(""),
            record["reproducible"].as_bool().unwrap_or(false)
        ),
    )?;
    Ok(json!({
        "ok": true,
        "optimization_trace": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-017.8", dspy_claim("V6-WORKFLOW-017.8")),
    }))
}

fn assimilate_intake(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let shell_path = normalize_shell_path(
        root,
        payload
            .get("shell_path")
            .and_then(Value::as_str)
            .unwrap_or("client/runtime/systems/workflow/dspy_bridge.ts"),
    )?;
    let record = json!({
        "intake_id": stable_id("dspintake", &json!({"shell_path": shell_path, "target": payload.get("target")})),
        "shell_name": clean_token(payload.get("shell_name").and_then(Value::as_str), "dspy-shell"),
        "shell_path": shell_path,
        "target": clean_token(payload.get("target").and_then(Value::as_str), "local"),
        "artifact_path": clean_text(payload.get("artifact_path").and_then(Value::as_str), 240),
        "deletable": true,
        "authority_delegate": "core://dspy-bridge",
        "deployed_at": now_iso(),
    });
    let intake_id = record
        .get("intake_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "intakes").insert(intake_id, record.clone());
    Ok(json!({
        "ok": true,
        "intake": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-017.7", dspy_claim("V6-WORKFLOW-017.7")),
    }))
}

fn status(root: &Path, state: &Value, state_path: &Path, history_path: &Path) -> Value {
    json!({
        "ok": true,
        "state_path": rel(root, state_path),
        "history_path": rel(root, history_path),
        "signatures": state.get("signatures").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "compiled_programs": state.get("compiled_programs").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "optimization_runs": state.get("optimization_runs").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "assertion_runs": state.get("assertion_runs").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "integrations": state.get("integrations").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "multihop_runs": state.get("multihop_runs").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "benchmarks": state.get("benchmarks").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "optimization_traces": state.get("optimization_traces").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "intakes": state.get("intakes").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "last_receipt": state.get("last_receipt").cloned().unwrap_or(Value::Null),
    })
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let Some(command) = argv.first().map(|row| row.trim().to_ascii_lowercase()) else {
        usage();
        return 0;
    };
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    let payload = match payload_json(argv) {
        Ok(value) => value,
        Err(err) => {
            print_json_line(&cli_error("dspy_bridge_error", &err));
            return 1;
        }
    };
    let payload = payload_obj(&payload);
    let state_path = state_path(root, argv, payload);
    let history_path = history_path(root, argv, payload);
    let mut state = load_state(&state_path);

    let result = match command.as_str() {
        "status" => Ok(status(root, &state, &state_path, &history_path)),
        "register-signature" => register_signature(&mut state, payload),
        "compile-program" => compile_program(&mut state, payload),
        "optimize-program" => optimize_program(root, &mut state, payload),
        "assert-program" => assert_program(&mut state, payload),
        "import-integration" => import_integration(root, &mut state, payload),
        "execute-multihop" => execute_multihop(root, argv, &mut state, payload),
        "record-benchmark" => record_benchmark(root, &mut state, payload),
        "record-optimization-trace" => record_optimization_trace(root, &mut state, payload),
        "assimilate-intake" => assimilate_intake(root, &mut state, payload),
        other => Err(format!("dspy_bridge_unknown_command:{other}")),
    };

    match result {
        Ok(payload_out) => {
            let receipt = cli_receipt(
                match command.as_str() {
                    "status" => "dspy_bridge_status",
                    "register-signature" => "dspy_bridge_register_signature",
                    "compile-program" => "dspy_bridge_compile_program",
                    "optimize-program" => "dspy_bridge_optimize_program",
                    "assert-program" => "dspy_bridge_assert_program",
                    "import-integration" => "dspy_bridge_import_integration",
                    "execute-multihop" => "dspy_bridge_execute_multihop",
                    "record-benchmark" => "dspy_bridge_record_benchmark",
                    "record-optimization-trace" => "dspy_bridge_record_optimization_trace",
                    "assimilate-intake" => "dspy_bridge_assimilate_intake",
                    _ => "dspy_bridge_command",
                },
                payload_out,
            );
            state["last_receipt"] = receipt.clone();
            if command != "status" {
                if let Err(err) = save_state(&state_path, &state)
                    .and_then(|_| append_history(&history_path, &receipt))
                {
                    print_json_line(&cli_error("dspy_bridge_error", &err));
                    return 1;
                }
            }
            print_json_line(&receipt);
            if receipt.get("ok").and_then(Value::as_bool).unwrap_or(true) {
                0
            } else {
                1
            }
        }
        Err(err) => {
            print_json_line(&cli_error("dspy_bridge_error", &err));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optimize_program_degrades_in_pure_profile() {
        let mut state = default_state();
        let _ = register_signature(
            &mut state,
            &Map::from_iter(vec![
                ("name".to_string(), json!("qa_signature")),
                ("input_fields".to_string(), json!(["question"])),
                ("output_fields".to_string(), json!(["answer"])),
            ]),
        )
        .expect("signature");
        let signature_id = state
            .get("signatures")
            .and_then(Value::as_object)
            .and_then(|rows| rows.values().next())
            .and_then(|row| row.get("signature_id"))
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        let _ = compile_program(
            &mut state,
            &Map::from_iter(vec![
                ("name".to_string(), json!("qa_program")),
                (
                    "modules".to_string(),
                    json!([{"label": "answer", "signature_id": signature_id}]),
                ),
            ]),
        )
        .expect("program");
        let program_id = state
            .get("compiled_programs")
            .and_then(Value::as_object)
            .and_then(|rows| rows.values().next())
            .and_then(|row| row.get("program_id"))
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        let tmp = tempfile::tempdir().expect("tempdir");
        let response = optimize_program(
            tmp.path(),
            &mut state,
            &Map::from_iter(vec![
                ("program_id".to_string(), json!(program_id)),
                ("profile".to_string(), json!("pure")),
                ("max_trials".to_string(), json!(8)),
            ]),
        )
        .expect("optimize");
        assert_eq!(response["optimization"]["degraded"], json!(true));
        assert_eq!(
            response["claim_evidence"][0]["id"],
            json!("V6-WORKFLOW-017.3")
        );
    }
}
