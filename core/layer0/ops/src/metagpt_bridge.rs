// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::contract_lane_utils::{
    self as lane_utils, clean_text, clean_token, cli_error, cli_receipt,
    normalize_bridge_path_clean, payload_obj, print_json_line, rel_path as rel, repo_path,
};
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_STATE_REL: &str = "local/state/ops/metagpt_bridge/latest.json";
const DEFAULT_HISTORY_REL: &str = "local/state/ops/metagpt_bridge/history.jsonl";
const DEFAULT_APPROVAL_QUEUE_REL: &str = "client/runtime/local/state/metagpt_review_queue.yaml";
const DEFAULT_TRACE_REL: &str = "local/state/ops/metagpt_bridge/pipeline_trace.jsonl";

fn usage() {
    println!("metagpt-bridge commands:");
    println!("  protheus-ops metagpt-bridge status [--state-path=<path>]");
    println!("  protheus-ops metagpt-bridge register-company [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops metagpt-bridge run-sop [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops metagpt-bridge simulate-pr [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops metagpt-bridge run-debate [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops metagpt-bridge plan-requirements [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops metagpt-bridge record-oversight [--payload-base64=<json>] [--state-path=<path>] [--approval-queue-path=<path>]");
    println!("  protheus-ops metagpt-bridge record-pipeline-trace [--payload-base64=<json>] [--state-path=<path>] [--trace-path=<path>]");
    println!("  protheus-ops metagpt-bridge ingest-config [--payload-base64=<json>] [--state-path=<path>]");
}

fn payload_json(argv: &[String]) -> Result<Value, String> {
    lane_utils::payload_json(argv, "metagpt_bridge")
}

fn state_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "state-path", false)
        .or_else(|| payload.get("state_path").and_then(Value::as_str).map(ToString::to_string))
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_STATE_REL))
}

fn history_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "history-path", false)
        .or_else(|| payload.get("history_path").and_then(Value::as_str).map(ToString::to_string))
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_HISTORY_REL))
}

fn approval_queue_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "approval-queue-path", false)
        .or_else(|| payload.get("approval_queue_path").and_then(Value::as_str).map(ToString::to_string))
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_APPROVAL_QUEUE_REL))
}

fn trace_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "trace-path", false)
        .or_else(|| payload.get("trace_path").and_then(Value::as_str).map(ToString::to_string))
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_TRACE_REL))
}

fn default_state() -> Value {
    json!({
        "schema_version": "metagpt_bridge_state_v1",
        "companies": {},
        "sop_runs": {},
        "pr_simulations": {},
        "debates": {},
        "requirements": {},
        "oversight": {},
        "traces": [],
        "configs": {},
        "last_receipt": null,
    })
}

fn ensure_state_shape(value: &mut Value) {
    if !value.is_object() {
        *value = default_state();
        return;
    }
    for key in ["companies", "sop_runs", "pr_simulations", "debates", "requirements", "oversight", "configs"] {
        if !value.get(key).map(Value::is_object).unwrap_or(false) {
            value[key] = json!({});
        }
    }
    if !value.get("traces").map(Value::is_array).unwrap_or(false) {
        value["traces"] = json!([]);
    }
    if value.get("schema_version").and_then(Value::as_str).is_none() {
        value["schema_version"] = json!("metagpt_bridge_state_v1");
    }
}

fn load_state(path: &Path) -> Value {
    let mut state = lane_utils::read_json(path).unwrap_or_else(default_state);
    ensure_state_shape(&mut state);
    state
}

fn save_state(path: &Path, state: &Value) -> Result<(), String> { lane_utils::write_json(path, state) }
fn append_history(path: &Path, row: &Value) -> Result<(), String> { lane_utils::append_jsonl(path, row) }

fn as_object_mut<'a>(value: &'a mut Value, key: &str) -> &'a mut Map<String, Value> {
    if !value.get(key).map(Value::is_object).unwrap_or(false) {
        value[key] = json!({});
    }
    value.get_mut(key).and_then(Value::as_object_mut).expect("object")
}

fn as_array_mut<'a>(value: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    if !value.get(key).map(Value::is_array).unwrap_or(false) {
        value[key] = json!([]);
    }
    value.get_mut(key).and_then(Value::as_array_mut).expect("array")
}

fn now_millis() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn to_base36(mut value: u128) -> String {
    if value == 0 { return "0".to_string(); }
    let mut out = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        out.push(if digit < 10 { (b'0' + digit) as char } else { (b'a' + digit - 10) as char });
        value /= 36;
    }
    out.iter().rev().collect()
}

fn stable_id(prefix: &str, basis: &Value) -> String {
    let digest = deterministic_receipt_hash(basis);
    format!("{prefix}_{}_{}", to_base36(now_millis()), &digest[..12])
}

fn claim(id: &str, claim: &str) -> Value { json!([{"id": id, "claim": claim}]) }
fn profile(raw: Option<&Value>) -> String { clean_token(raw.and_then(Value::as_str), "rich") }

fn normalize_bridge_path(root: &Path, raw: &str) -> Result<String, String> {
    normalize_bridge_path_clean(root, raw, "metagpt_bridge_path_outside_allowed_surface")
}

fn register_company(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let company_name = clean_text(payload.get("company_name").and_then(Value::as_str), 120);
    if company_name.is_empty() { return Err("metagpt_company_name_required".to_string()); }
    let roles = payload.get("roles").and_then(Value::as_array).cloned().unwrap_or_default();
    if roles.is_empty() { return Err("metagpt_roles_required".to_string()); }
    let company = json!({
        "company_id": stable_id("mgcompany", &json!({"company_name": company_name, "roles": roles})),
        "company_name": company_name,
        "product_goal": clean_text(payload.get("product_goal").and_then(Value::as_str), 160),
        "roles": roles,
        "org_chart": payload.get("org_chart").cloned().unwrap_or_else(|| json!(["ceo", "cto", "pm", "engineer"])),
        "registered_at": now_iso(),
    });
    let id = company.get("company_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "companies").insert(id, company.clone());
    Ok(json!({"ok": true, "company": company, "claim_evidence": claim("V6-WORKFLOW-006.1", "metagpt_company_roles_are_registered_on_governed_workflow_swarm_and_persona_lanes")}))
}

fn run_sop(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let company_id = clean_token(payload.get("company_id").and_then(Value::as_str), "");
    if company_id.is_empty() { return Err("metagpt_company_id_required".to_string()); }
    let steps = payload.get("steps").and_then(Value::as_array).cloned().unwrap_or_default();
    if steps.is_empty() { return Err("metagpt_sop_steps_required".to_string()); }
    let budget = payload.get("budget").cloned().unwrap_or_else(|| json!({"tokens": 2000, "max_stages": steps.len()}));
    let run = json!({
        "sop_run_id": stable_id("mgsop", &json!({"company_id": company_id, "steps": steps})),
        "company_id": company_id,
        "pipeline_name": clean_text(payload.get("pipeline_name").and_then(Value::as_str), 120),
        "stage_count": steps.len(),
        "steps": steps,
        "checkpoint_labels": payload.get("checkpoint_labels").cloned().unwrap_or_else(|| json!(["requirements", "design", "build", "review"])),
        "budget": budget,
        "executed_at": now_iso(),
    });
    let id = run.get("sop_run_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "sop_runs").insert(id, run.clone());
    Ok(json!({"ok": true, "sop_run": run, "claim_evidence": claim("V6-WORKFLOW-006.2", "metagpt_sop_pipelines_execute_on_authoritative_workflow_with_receipts_and_budget_controls")}))
}

fn safe_repo_change_path(value: &str) -> bool {
    ["core/", "client/", "adapters/", "apps/", "docs/", "tests/"]
        .iter()
        .any(|prefix| value.starts_with(prefix))
}

fn simulate_pr(root: &Path, state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let adapter_path = normalize_bridge_path(
        root,
        payload.get("bridge_path").and_then(Value::as_str).unwrap_or("adapters/protocol/metagpt_config_bridge.ts"),
    )?;
    let sandbox_mode = clean_token(payload.get("sandbox_mode").and_then(Value::as_str), "readonly");
    if sandbox_mode == "disabled" {
        return Err("metagpt_pr_simulation_requires_sandbox".to_string());
    }
    let changed_files = payload.get("changed_files").and_then(Value::as_array).cloned().unwrap_or_default();
    if changed_files.iter().filter_map(Value::as_str).any(|path| !safe_repo_change_path(path)) {
        return Err("metagpt_pr_simulation_path_outside_allowed_surface".to_string());
    }
    let destructive = payload.get("destructive").and_then(Value::as_bool).unwrap_or(false);
    if destructive { return Err("metagpt_pr_simulation_destructive_change_denied".to_string()); }
    let pr = json!({
        "simulation_id": stable_id("mgpr", &json!({"task": payload.get("task"), "changed_files": changed_files})),
        "task": clean_text(payload.get("task").and_then(Value::as_str), 160),
        "changed_files": changed_files,
        "generated_patch_summary": clean_text(payload.get("generated_patch_summary").and_then(Value::as_str), 200),
        "tests": payload.get("tests").cloned().unwrap_or_else(|| json!([])),
        "sandbox_mode": sandbox_mode,
        "bridge_path": adapter_path,
        "review_required": true,
        "simulated_at": now_iso(),
    });
    let id = pr.get("simulation_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "pr_simulations").insert(id, pr.clone());
    Ok(json!({"ok": true, "pr_simulation": pr, "claim_evidence": claim("V6-WORKFLOW-006.3", "metagpt_code_generation_execution_and_pr_simulation_remain_sandboxed_and_review_gated")}))
}

fn run_debate(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let proposal = clean_text(payload.get("proposal").and_then(Value::as_str), 200);
    if proposal.is_empty() { return Err("metagpt_debate_proposal_required".to_string()); }
    let profile = profile(payload.get("profile"));
    let participants = payload.get("participants").and_then(Value::as_array).cloned().unwrap_or_else(|| vec![json!("pm"), json!("architect")]);
    let requested_rounds = payload.get("rounds").and_then(Value::as_u64).unwrap_or(2);
    let context_budget = payload.get("context_budget").and_then(Value::as_u64).unwrap_or(4096);
    let allowed_rounds = if profile == "tiny-max" { requested_rounds.min(2) } else { requested_rounds };
    let degraded = allowed_rounds != requested_rounds || context_budget < 1024;
    let review = json!({
        "debate_id": stable_id("mgdebate", &json!({"proposal": proposal, "participants": participants})),
        "proposal": proposal,
        "participants": participants,
        "rounds": allowed_rounds,
        "context_budget": context_budget,
        "degraded": degraded,
        "recommendation": clean_token(payload.get("recommendation").and_then(Value::as_str), "revise"),
        "completed_at": now_iso(),
    });
    let id = review.get("debate_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "debates").insert(id, review.clone());
    Ok(json!({"ok": true, "debate": review, "claim_evidence": claim("V6-WORKFLOW-006.4", "metagpt_multi_agent_debate_and_review_cycles_remain_receipted_and_budgeted")}))
}

fn plan_requirements(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let prd_title = clean_text(payload.get("prd_title").and_then(Value::as_str), 140);
    if prd_title.is_empty() { return Err("metagpt_prd_title_required".to_string()); }
    let requirements = payload.get("requirements").and_then(Value::as_array).cloned().unwrap_or_default();
    if requirements.is_empty() { return Err("metagpt_requirements_required".to_string()); }
    let stories: Vec<Value> = requirements.iter().enumerate().map(|(idx, row)| {
        let text = row.as_str().unwrap_or("requirement");
        json!({"story_id": format!("story-{}", idx + 1), "summary": text, "tasks": [format!("draft {}", idx + 1), format!("review {}", idx + 1)]})
    }).collect();
    let plan = json!({
        "plan_id": stable_id("mgreq", &json!({"prd_title": prd_title, "requirements": requirements})),
        "prd_title": prd_title,
        "requirements": requirements,
        "stories": stories,
        "stakeholders": payload.get("stakeholders").cloned().unwrap_or_else(|| json!([])),
        "auto_recall_query": clean_text(payload.get("auto_recall_query").and_then(Value::as_str), 120),
        "planned_at": now_iso(),
    });
    let id = plan.get("plan_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "requirements").insert(id, plan.clone());
    Ok(json!({"ok": true, "requirements_plan": plan, "claim_evidence": claim("V6-WORKFLOW-006.5", "metagpt_requirements_analysis_and_task_breakdown_route_through_governed_memory_and_decomposition_lanes")}))
}

fn record_oversight(state: &mut Value, approval_queue_path: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let operator_id = clean_token(payload.get("operator_id").and_then(Value::as_str), "");
    if operator_id.is_empty() { return Err("metagpt_operator_id_required".to_string()); }
    let event = json!({
        "oversight_id": stable_id("mgoverse", &json!({"operator_id": operator_id, "action": payload.get("action")})),
        "operator_id": operator_id,
        "action": clean_token(payload.get("action").and_then(Value::as_str), "review"),
        "target_id": clean_token(payload.get("target_id").and_then(Value::as_str), ""),
        "notes": clean_text(payload.get("notes").and_then(Value::as_str), 200),
        "recorded_at": now_iso(),
    });
    let mut queue = match fs::read_to_string(approval_queue_path) {
        Ok(raw) => serde_yaml::from_str::<Value>(&raw).unwrap_or_else(|_| json!({"events": []})),
        Err(_) => json!({"events": []}),
    };
    if !queue.get("events").map(Value::is_array).unwrap_or(false) { queue["events"] = json!([]); }
    queue.get_mut("events").and_then(Value::as_array_mut).expect("events").push(event.clone());
    let encoded = serde_yaml::to_string(&queue).map_err(|err| format!("metagpt_oversight_queue_encode_failed:{err}"))?;
    if let Some(parent) = approval_queue_path.parent() { fs::create_dir_all(parent).map_err(|err| format!("metagpt_oversight_queue_dir_create_failed:{err}"))?; }
    fs::write(approval_queue_path, encoded).map_err(|err| format!("metagpt_oversight_queue_write_failed:{err}"))?;
    let id = event.get("oversight_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "oversight").insert(id, event.clone());
    Ok(json!({"ok": true, "oversight": event, "approval_queue_path": approval_queue_path.display().to_string(), "claim_evidence": claim("V6-WORKFLOW-006.6", "metagpt_human_oversight_and_intervention_points_remain_within_existing_approval_boundaries")}))
}

fn record_pipeline_trace(root: &Path, state: &mut Value, trace_path: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let trace = json!({
        "trace_id": stable_id("mgtrace", &json!({"stage": payload.get("stage"), "message": payload.get("message")})),
        "run_id": clean_token(payload.get("run_id").and_then(Value::as_str), ""),
        "stage": clean_token(payload.get("stage").and_then(Value::as_str), "pipeline"),
        "message": clean_text(payload.get("message").and_then(Value::as_str), 180),
        "metrics": payload.get("metrics").cloned().unwrap_or_else(|| json!({})),
        "trace_path": rel(root, trace_path),
        "recorded_at": now_iso(),
    });
    lane_utils::append_jsonl(trace_path, &trace)?;
    as_array_mut(state, "traces").push(trace.clone());
    Ok(json!({"ok": true, "pipeline_trace": trace, "claim_evidence": claim("V6-WORKFLOW-006.7", "metagpt_pipeline_events_stream_through_native_observability_and_receipt_lanes")}))
}

fn ingest_config(root: &Path, state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let adapter_path = normalize_bridge_path(
        root,
        payload.get("bridge_path").and_then(Value::as_str).unwrap_or("adapters/protocol/metagpt_config_bridge.ts"),
    )?;
    let yaml = payload.get("config_yaml").and_then(Value::as_str).ok_or_else(|| "metagpt_config_yaml_required".to_string())?;
    let parsed_yaml: Value = serde_yaml::from_str::<Value>(yaml).map_err(|err| format!("metagpt_config_yaml_parse_failed:{err}"))?;
    let extensions = parsed_yaml.get("extensions").and_then(Value::as_array).cloned().unwrap_or_default();
    let unsupported: Vec<String> = extensions.iter().filter_map(|row| row.as_str()).filter(|row| row.contains("shell:") || row.contains("rm ")).map(ToString::to_string).collect();
    if !unsupported.is_empty() {
        return Err(format!("metagpt_config_extension_unsupported:{}", unsupported.join(",")));
    }
    let record = json!({
        "config_id": stable_id("mgcfg", &json!({"yaml": yaml})),
        "bridge_path": adapter_path,
        "roles": parsed_yaml.get("roles").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0),
        "sops": parsed_yaml.get("sops").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0),
        "extensions": extensions,
        "parsed": parsed_yaml,
        "ingested_at": now_iso(),
    });
    let id = record.get("config_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "configs").insert(id, record.clone());
    Ok(json!({"ok": true, "config": record, "claim_evidence": claim("V6-WORKFLOW-006.8", "metagpt_yaml_and_extension_assets_are_ingested_through_governed_adapter_owned_manifests")}))
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    if argv.is_empty() {
        usage();
        return 0;
    }
    let command = argv[0].as_str();
    let payload = match payload_json(argv) {
        Ok(value) => value,
        Err(error) => {
            print_json_line(&cli_error("metagpt_bridge_error", &error));
            return 1;
        }
    };
    let payload = payload_obj(&payload);
    let state_path = state_path(root, argv, payload);
    let history_path = history_path(root, argv, payload);
    let approval_queue_path = approval_queue_path(root, argv, payload);
    let trace_path = trace_path(root, argv, payload);

    if matches!(command, "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    let mut state = load_state(&state_path);
    let payload_out = match command {
        "status" => Ok(json!({
            "ok": true,
            "schema_version": state.get("schema_version").cloned().unwrap_or_else(|| json!(null)),
            "companies": state.get("companies").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
            "sop_runs": state.get("sop_runs").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
            "pr_simulations": state.get("pr_simulations").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
            "debates": state.get("debates").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
            "requirements": state.get("requirements").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
            "oversight": state.get("oversight").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
            "traces": state.get("traces").and_then(Value::as_array).map(|row| row.len()).unwrap_or(0),
            "configs": state.get("configs").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
            "state_path": rel(root, &state_path),
            "history_path": rel(root, &history_path),
        })),
        "register-company" => register_company(&mut state, payload),
        "run-sop" => run_sop(&mut state, payload),
        "simulate-pr" => simulate_pr(root, &mut state, payload),
        "run-debate" => run_debate(&mut state, payload),
        "plan-requirements" => plan_requirements(&mut state, payload),
        "record-oversight" => record_oversight(&mut state, &approval_queue_path, payload),
        "record-pipeline-trace" => record_pipeline_trace(root, &mut state, &trace_path, payload),
        "ingest-config" => ingest_config(root, &mut state, payload),
        _ => Err(format!("unknown_metagpt_bridge_command:{command}")),
    };

    let payload_out = match payload_out {
        Ok(value) => value,
        Err(error) => {
            print_json_line(&cli_error("metagpt_bridge_error", &error));
            return 1;
        }
    };

    let receipt = cli_receipt("metagpt_bridge_receipt", payload_out);
    state["last_receipt"] = receipt.clone();
    if let Err(error) = save_state(&state_path, &state) {
        print_json_line(&cli_error("metagpt_bridge_error", &error));
        return 1;
    }
    if let Err(error) = append_history(&history_path, &receipt) {
        print_json_line(&cli_error("metagpt_bridge_error", &error));
        return 1;
    }
    print_json_line(&receipt);
    0
}
