// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::observability_plane (authoritative)

use crate::v8_kernel::{
    append_jsonl, attach_conduit, build_conduit_enforcement, conduit_bypass_requested,
    load_json_or, parse_bool, read_json, scoped_state_root, sha256_hex_str, write_json,
    write_receipt,
};
use crate::{clean, parse_args};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "OBSERVABILITY_PLANE_STATE_ROOT";
const STATE_SCOPE: &str = "observability_plane";

const MONITORING_CONTRACT_PATH: &str =
    "planes/contracts/observability/realtime_monitoring_contract_v1.json";
const WORKFLOW_CONTRACT_PATH: &str =
    "planes/contracts/observability/workflow_editor_contract_v1.json";
const INCIDENT_CONTRACT_PATH: &str =
    "planes/contracts/observability/incident_response_contract_v1.json";
const SELFHOST_CONTRACT_PATH: &str =
    "planes/contracts/observability/self_hosted_deploy_contract_v1.json";
const ACP_PROVENANCE_CONTRACT_PATH: &str =
    "planes/contracts/observability/acp_provenance_contract_v1.json";

fn usage() {
    println!("Usage:");
    println!("  protheus-ops observability-plane status");
    println!(
        "  protheus-ops observability-plane monitor [--source=<id>] [--alert-class=<slo|security|runtime|cost>] [--severity=<low|medium|high|critical>] [--message=<text>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops observability-plane workflow --op=<upsert|list|run> [--workflow-id=<id>] [--trigger=<cron|event>] [--schedule=<expr>] [--steps-json=<json>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops observability-plane incident --op=<trigger|status|resolve> [--incident-id=<id>] [--runbook=<id>] [--action=<text>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops observability-plane selfhost --op=<deploy|status> [--profile=<docker-local|k8s-local>] [--telemetry-opt-in=0|1] [--strict=1|0]"
    );
    println!(
        "  protheus-ops observability-plane acp-provenance --op=<enable|status|trace|debug> [--source-agent=<id>] [--target-agent=<id>] [--intent=<text>] [--message=<text>] [--trace-id=<id>] [--visibility-mode=<off|meta|meta+receipt>] [--strict=1|0]"
    );
}

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn print_payload(payload: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(payload)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn emit(root: &Path, payload: Value) -> i32 {
    match write_receipt(root, STATE_ENV, STATE_SCOPE, payload) {
        Ok(out) => {
            print_payload(&out);
            if out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                0
            } else {
                1
            }
        }
        Err(err) => {
            print_payload(&json!({
                "ok": false,
                "type": "observability_plane_error",
                "error": clean(err, 240)
            }));
            1
        }
    }
}

fn status(root: &Path) -> Value {
    json!({
        "ok": true,
        "type": "observability_plane_status",
        "lane": "core/layer0/ops",
        "latest_path": latest_path(root).display().to_string(),
        "latest": read_json(&latest_path(root))
    })
}

fn claim_ids_for_action(action: &str) -> Vec<&'static str> {
    match action {
        "monitor" => vec!["V6-OBSERVABILITY-001.1", "V6-OBSERVABILITY-001.5"],
        "workflow" => vec!["V6-OBSERVABILITY-001.2", "V6-OBSERVABILITY-001.5"],
        "incident" => vec!["V6-OBSERVABILITY-001.3", "V6-OBSERVABILITY-001.5"],
        "selfhost" => vec!["V6-OBSERVABILITY-001.4", "V6-OBSERVABILITY-001.5"],
        "acp-provenance" => vec![
            "V6-OBSERVABILITY-005.7",
            "V6-OBSERVABILITY-005.8",
            "V6-OBSERVABILITY-005.9",
            "V6-OBSERVABILITY-005.10",
            "V6-OBSERVABILITY-005.11",
        ],
        _ => vec!["V6-OBSERVABILITY-001.5"],
    }
}

fn conduit_enforcement(
    root: &Path,
    parsed: &crate::ParsedArgs,
    strict: bool,
    action: &str,
) -> Value {
    let bypass_requested = conduit_bypass_requested(&parsed.flags);
    let claim_rows = claim_ids_for_action(action)
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "claim": "observability_controls_route_through_layer0_conduit_with_fail_closed_denials",
                "evidence": {
                    "action": clean(action, 120),
                    "bypass_requested": bypass_requested
                }
            })
        })
        .collect::<Vec<_>>();
    build_conduit_enforcement(
        root,
        STATE_ENV,
        STATE_SCOPE,
        strict,
        action,
        "observability_conduit_enforcement",
        "core/layer0/ops/observability_plane",
        bypass_requested,
        claim_rows,
    )
}

fn alerts_state_path(root: &Path) -> PathBuf {
    state_root(root).join("alerts").join("latest.json")
}

fn workflows_state_path(root: &Path) -> PathBuf {
    state_root(root).join("workflows").join("registry.json")
}

fn incidents_state_path(root: &Path) -> PathBuf {
    state_root(root).join("incidents").join("active.json")
}

fn incident_artifacts_dir(root: &Path, incident_id: &str) -> PathBuf {
    state_root(root)
        .join("incidents")
        .join("artifacts")
        .join(incident_id)
}

fn selfhost_state_path(root: &Path) -> PathBuf {
    state_root(root).join("deploy").join("latest.json")
}

fn selfhost_health_path(root: &Path) -> PathBuf {
    state_root(root).join("deploy").join("health.json")
}

fn provenance_config_path(root: &Path) -> PathBuf {
    state_root(root).join("provenance").join("config.json")
}

fn provenance_history_path(root: &Path) -> PathBuf {
    state_root(root).join("provenance").join("traces.jsonl")
}

fn provenance_latest_path(root: &Path) -> PathBuf {
    state_root(root)
        .join("provenance")
        .join("latest_trace.json")
}

fn parse_visibility_mode(raw: Option<String>) -> String {
    let mode = clean(raw.unwrap_or_else(|| "meta+receipt".to_string()), 32).to_ascii_lowercase();
    match mode.as_str() {
        "off" | "meta" | "meta+receipt" => mode,
        _ => "meta+receipt".to_string(),
    }
}

fn visible_trace_payload(entry: &Value, mode: &str) -> Value {
    if mode == "off" {
        return json!({
            "trace_id": entry.get("trace_id").cloned().unwrap_or(Value::Null),
            "hop_index": entry.get("hop_index").cloned().unwrap_or(Value::Null),
            "visibility_mode": mode
        });
    }
    if mode == "meta" {
        return json!({
            "trace_id": entry.get("trace_id").cloned().unwrap_or(Value::Null),
            "hop_index": entry.get("hop_index").cloned().unwrap_or(Value::Null),
            "source_agent": entry.get("source_agent").cloned().unwrap_or(Value::Null),
            "target_agent": entry.get("target_agent").cloned().unwrap_or(Value::Null),
            "intent": entry.get("intent").cloned().unwrap_or(Value::Null),
            "ts": entry.get("ts").cloned().unwrap_or(Value::Null),
            "visibility_mode": mode
        });
    }
    json!({
        "trace_id": entry.get("trace_id").cloned().unwrap_or(Value::Null),
        "hop_index": entry.get("hop_index").cloned().unwrap_or(Value::Null),
        "source_agent": entry.get("source_agent").cloned().unwrap_or(Value::Null),
        "target_agent": entry.get("target_agent").cloned().unwrap_or(Value::Null),
        "intent": entry.get("intent").cloned().unwrap_or(Value::Null),
        "message": entry.get("message").cloned().unwrap_or(Value::Null),
        "ts": entry.get("ts").cloned().unwrap_or(Value::Null),
        "hop_hash": entry.get("hop_hash").cloned().unwrap_or(Value::Null),
        "previous_hop_hash": entry.get("previous_hop_hash").cloned().unwrap_or(Value::Null),
        "receipt_hash": entry.get("receipt_hash").cloned().unwrap_or(Value::Null),
        "visibility_mode": mode
    })
}

fn clean_id(raw: Option<&str>, fallback: &str) -> String {
    let mut out = String::new();
    if let Some(v) = raw {
        for ch in v.trim().chars() {
            if out.len() >= 96 {
                break;
            }
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                out.push(ch.to_ascii_lowercase());
            } else {
                out.push('-');
            }
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn parse_json_flag(raw: Option<&String>, fallback: Value) -> Value {
    if let Some(value) = raw {
        if let Ok(parsed) = serde_json::from_str::<Value>(value) {
            return parsed;
        }
    }
    fallback
}

fn looks_like_cron(expr: &str) -> bool {
    expr.split_whitespace().count() == 5
}

fn split_actions(raw: &str) -> Vec<String> {
    raw.split(['+', ','])
        .map(|row| clean(row, 80).to_ascii_lowercase())
        .filter(|row| !row.is_empty())
        .collect()
}

fn compile_steps_graph(step_names: &[String]) -> Value {
    let nodes = step_names
        .iter()
        .enumerate()
        .map(|(idx, name)| {
            json!({
                "id": format!("step-{idx}"),
                "name": clean(name, 120),
                "kind": "workflow_step"
            })
        })
        .collect::<Vec<_>>();
    let edges = (1..step_names.len())
        .map(|idx| {
            json!({
                "from": format!("step-{}", idx - 1),
                "to": format!("step-{idx}")
            })
        })
        .collect::<Vec<_>>();
    json!({
        "nodes": nodes,
        "edges": edges
    })
}

fn intelligent_context(root: &Path) -> Value {
    let company_feed = read_json(
        &root
            .join("core")
            .join("local")
            .join("state")
            .join("ops")
            .join("company_plane")
            .join("heartbeat")
            .join("remote_feed.json"),
    );
    let substrate_latest = read_json(
        &root
            .join("core")
            .join("local")
            .join("state")
            .join("ops")
            .join("substrate_plane")
            .join("latest.json"),
    );
    let persist_mobile = read_json(
        &root
            .join("core")
            .join("local")
            .join("state")
            .join("ops")
            .join("persist_plane")
            .join("mobile")
            .join("latest.json"),
    );
    json!({
        "company_heartbeat": company_feed
            .and_then(|v| v.get("teams").cloned())
            .unwrap_or_else(|| json!({})),
        "substrate_feedback_mode": substrate_latest
            .as_ref()
            .and_then(|v| v.get("feedback"))
            .and_then(|v| v.get("mode"))
            .and_then(Value::as_str)
            .unwrap_or("unknown"),
        "persist_mobile_connected": persist_mobile
            .as_ref()
            .and_then(|v| v.get("connected"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "snapshot_at": crate::now_iso()
    })
}

fn run_monitor(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        MONITORING_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "observability_realtime_monitoring_contract",
            "allowed_alert_classes": ["slo", "security", "runtime", "cost"],
            "allowed_severities": ["low", "medium", "high", "critical"]
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("observability_monitor_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "observability_realtime_monitoring_contract"
    {
        errors.push("observability_monitor_contract_kind_invalid".to_string());
    }
    let source = clean(
        parsed
            .flags
            .get("source")
            .cloned()
            .unwrap_or_else(|| "protheusd".to_string()),
        120,
    );
    let alert_class = clean(
        parsed
            .flags
            .get("alert-class")
            .cloned()
            .unwrap_or_else(|| "runtime".to_string()),
        32,
    )
    .to_ascii_lowercase();
    let severity = clean(
        parsed
            .flags
            .get("severity")
            .cloned()
            .unwrap_or_else(|| "medium".to_string()),
        20,
    )
    .to_ascii_lowercase();
    let class_allowed = contract
        .get("allowed_alert_classes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .any(|row| row == alert_class);
    if strict && !class_allowed {
        errors.push("observability_monitor_alert_class_invalid".to_string());
    }
    let severity_allowed = contract
        .get("allowed_severities")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .any(|row| row == severity);
    if strict && !severity_allowed {
        errors.push("observability_monitor_severity_invalid".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "observability_plane_monitor",
            "errors": errors
        });
    }

    let message = clean(
        parsed
            .flags
            .get("message")
            .cloned()
            .unwrap_or_else(|| "runtime anomaly detected".to_string()),
        220,
    );
    let alert_id = format!(
        "obs_{}",
        &sha256_hex_str(&format!("{source}:{alert_class}:{severity}:{message}"))[..12]
    );
    let context = intelligent_context(root);
    let alert = json!({
        "version": "v1",
        "alert_id": alert_id,
        "source": source,
        "alert_class": alert_class,
        "severity": severity,
        "message": message,
        "context": context,
        "ts": crate::now_iso()
    });
    let path = alerts_state_path(root);
    let _ = write_json(&path, &alert);
    let _ = append_jsonl(
        &state_root(root).join("alerts").join("history.jsonl"),
        &alert,
    );

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "observability_plane_monitor",
        "lane": "core/layer0/ops",
        "alert": alert,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&alert.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-OBSERVABILITY-001.1",
                "claim": "realtime_monitoring_emits_alerts_with_intelligent_context_and_deterministic_receipts",
                "evidence": {
                    "alert_id": alert_id
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_workflow(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        WORKFLOW_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "observability_workflow_editor_contract",
            "allowed_ops": ["upsert", "list", "run"],
            "allowed_triggers": ["cron", "event"]
        }),
    );
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "list".to_string()),
        20,
    )
    .to_ascii_lowercase();
    let allowed_ops = contract
        .get("allowed_ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if strict
        && !allowed_ops
            .iter()
            .filter_map(Value::as_str)
            .any(|row| row == op)
    {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "observability_plane_workflow",
            "errors": ["observability_workflow_op_invalid"]
        });
    }

    let path = workflows_state_path(root);
    let mut state = read_json(&path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "workflows": {},
            "runs": []
        })
    });
    if !state
        .get("workflows")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        state["workflows"] = Value::Object(serde_json::Map::new());
    }
    if !state.get("runs").map(Value::is_array).unwrap_or(false) {
        state["runs"] = Value::Array(Vec::new());
    }

    if op == "list" {
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "observability_plane_workflow",
            "lane": "core/layer0/ops",
            "op": "list",
            "state": state,
            "claim_evidence": [
                {
                    "id": "V6-OBSERVABILITY-001.2",
                    "claim": "visual_workflow_editor_and_scheduler_surfaces_registered_workflows",
                    "evidence": {
                        "workflow_count": state
                            .get("workflows")
                            .and_then(Value::as_object)
                            .map(|m| m.len())
                            .unwrap_or(0)
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    let workflow_id = clean_id(
        parsed
            .flags
            .get("workflow-id")
            .map(String::as_str)
            .or_else(|| parsed.flags.get("id").map(String::as_str)),
        "default-workflow",
    );
    if op == "upsert" {
        let trigger = clean(
            parsed
                .flags
                .get("trigger")
                .cloned()
                .unwrap_or_else(|| "cron".to_string()),
            20,
        )
        .to_ascii_lowercase();
        let trigger_allowed = contract
            .get("allowed_triggers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .any(|row| row == trigger);
        if strict && !trigger_allowed {
            return json!({
                "ok": false,
                "strict": strict,
                "type": "observability_plane_workflow",
                "errors": ["observability_workflow_trigger_invalid"]
            });
        }
        let schedule = clean(
            parsed
                .flags
                .get("schedule")
                .cloned()
                .unwrap_or_else(|| "*/5 * * * *".to_string()),
            160,
        );
        if strict && trigger == "cron" && !looks_like_cron(&schedule) {
            return json!({
                "ok": false,
                "strict": strict,
                "type": "observability_plane_workflow",
                "errors": ["observability_workflow_schedule_invalid_for_cron"]
            });
        }
        if strict && trigger == "event" && !schedule.starts_with("event:") {
            return json!({
                "ok": false,
                "strict": strict,
                "type": "observability_plane_workflow",
                "errors": ["observability_workflow_schedule_invalid_for_event"]
            });
        }
        let steps = parse_json_flag(
            parsed.flags.get("steps-json"),
            json!(["collect-metrics", "attach-context", "notify"]),
        );
        let step_names = steps
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|row| {
                row.as_str()
                    .map(|raw| clean(raw.to_string(), 120))
                    .filter(|cleaned| !cleaned.is_empty())
            })
            .collect::<Vec<_>>();
        if strict && step_names.is_empty() {
            return json!({
                "ok": false,
                "strict": strict,
                "type": "observability_plane_workflow",
                "errors": ["observability_workflow_steps_required"]
            });
        }
        let compiled_graph = compile_steps_graph(&step_names);
        let workflow = json!({
            "workflow_id": workflow_id,
            "trigger": trigger,
            "schedule": schedule,
            "steps": Value::Array(step_names.iter().map(|step| Value::String(step.clone())).collect()),
            "compiled_graph": compiled_graph,
            "updated_at": crate::now_iso()
        });
        state["workflows"][&workflow_id] = workflow.clone();
        state["updated_at"] = Value::String(crate::now_iso());
        let _ = write_json(&path, &state);
        let _ = append_jsonl(
            &state_root(root).join("workflows").join("history.jsonl"),
            &json!({"op": "upsert", "workflow_id": workflow_id, "ts": crate::now_iso()}),
        );
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "observability_plane_workflow",
            "lane": "core/layer0/ops",
            "op": "upsert",
            "workflow": workflow,
            "artifact": {
                "path": path.display().to_string(),
                "sha256": sha256_hex_str(&state.to_string())
            },
            "claim_evidence": [
                {
                    "id": "V6-OBSERVABILITY-001.2",
                    "claim": "workflow_editor_compiles_visual_steps_into_receipted_schedules",
                    "evidence": {
                        "workflow_id": workflow_id
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    if strict && state["workflows"].get(&workflow_id).is_none() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "observability_plane_workflow",
            "errors": ["observability_workflow_not_found"]
        });
    }
    let run_id = format!(
        "run_{}",
        &sha256_hex_str(&format!("{workflow_id}:{}", crate::now_iso()))[..10]
    );
    let step_trace = state["workflows"]
        .get(&workflow_id)
        .and_then(|row| row.get("steps"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(idx, step)| {
            json!({
                "step_index": idx,
                "step": step,
                "status": "queued"
            })
        })
        .collect::<Vec<_>>();
    let run = json!({
        "run_id": run_id,
        "workflow_id": workflow_id,
        "status": "started",
        "step_trace": step_trace,
        "ts": crate::now_iso()
    });
    let mut runs = state
        .get("runs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    runs.push(run.clone());
    state["runs"] = Value::Array(runs);
    state["updated_at"] = Value::String(crate::now_iso());
    let _ = write_json(&path, &state);
    let _ = append_jsonl(
        &state_root(root).join("workflows").join("history.jsonl"),
        &json!({"op": "run", "run": run, "ts": crate::now_iso()}),
    );
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "observability_plane_workflow",
        "lane": "core/layer0/ops",
        "op": "run",
        "run": run,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&state.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-OBSERVABILITY-001.2",
                "claim": "workflow_scheduling_and_execution_are_receipted_for_editor_runs",
                "evidence": {
                    "run_id": run_id
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_incident(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        INCIDENT_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "observability_incident_response_contract",
            "allowed_ops": ["trigger", "status", "resolve"],
            "default_response_actions": ["snapshot", "log-capture", "recovery"],
            "allowed_response_actions": ["snapshot", "log-capture", "recovery", "quarantine", "rollback", "page-oncall"]
        }),
    );
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "status".to_string()),
        20,
    )
    .to_ascii_lowercase();
    let allowed_ops = contract
        .get("allowed_ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if strict
        && !allowed_ops
            .iter()
            .filter_map(Value::as_str)
            .any(|row| row == op)
    {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "observability_plane_incident",
            "errors": ["observability_incident_op_invalid"]
        });
    }

    let path = incidents_state_path(root);
    let mut state = read_json(&path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "incidents": {},
            "last_updated_at": crate::now_iso()
        })
    });
    if !state
        .get("incidents")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        state["incidents"] = Value::Object(serde_json::Map::new());
    }

    if op == "status" {
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "observability_plane_incident",
            "lane": "core/layer0/ops",
            "op": "status",
            "state": state,
            "claim_evidence": [
                {
                    "id": "V6-OBSERVABILITY-001.3",
                    "claim": "incident_response_orchestrator_surfaces_active_incident_state",
                    "evidence": {
                        "incident_count": state
                            .get("incidents")
                            .and_then(Value::as_object)
                            .map(|m| m.len())
                            .unwrap_or(0)
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    let incident_id = clean_id(
        parsed
            .flags
            .get("incident-id")
            .map(String::as_str)
            .or_else(|| parsed.flags.get("id").map(String::as_str)),
        "incident-default",
    );

    if op == "trigger" {
        let runbook = clean(
            parsed
                .flags
                .get("runbook")
                .cloned()
                .unwrap_or_else(|| "default-runbook".to_string()),
            120,
        );
        let action = clean(
            parsed.flags.get("action").cloned().unwrap_or_else(|| {
                contract
                    .get("default_response_actions")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("+")
            }),
            160,
        );
        let requested_actions = {
            let rows = split_actions(&action);
            if rows.is_empty() {
                contract
                    .get("default_response_actions")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|row| row.to_ascii_lowercase())
                    .collect::<Vec<_>>()
            } else {
                rows
            }
        };
        let mut allowed_actions = contract
            .get("allowed_response_actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .map(|row| row.to_ascii_lowercase())
            .collect::<Vec<_>>();
        if allowed_actions.is_empty() {
            allowed_actions = contract
                .get("default_response_actions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(Value::as_str)
                .map(|row| row.to_ascii_lowercase())
                .collect::<Vec<_>>();
        }
        if allowed_actions.is_empty() {
            allowed_actions = vec![
                "snapshot".to_string(),
                "log-capture".to_string(),
                "recovery".to_string(),
                "quarantine".to_string(),
                "rollback".to_string(),
                "page-oncall".to_string(),
            ];
        }
        if strict
            && requested_actions
                .iter()
                .any(|row| !allowed_actions.iter().any(|allowed| allowed == row))
        {
            return json!({
                "ok": false,
                "strict": strict,
                "type": "observability_plane_incident",
                "errors": ["observability_incident_response_action_invalid"]
            });
        }
        let mut response_receipts = Vec::<Value>::new();
        let artifacts_dir = incident_artifacts_dir(root, &incident_id);
        let _ = std::fs::create_dir_all(&artifacts_dir);
        for (idx, step) in requested_actions.iter().enumerate() {
            let artifact_path = artifacts_dir.join(format!("{:02}_{}.json", idx + 1, step));
            let artifact = match step.as_str() {
                "snapshot" => json!({
                    "step": step,
                    "context_snapshot": intelligent_context(root),
                    "ts": crate::now_iso()
                }),
                "log-capture" => json!({
                    "step": step,
                    "log_sources": [
                        alerts_state_path(root).display().to_string(),
                        workflows_state_path(root).display().to_string(),
                        incidents_state_path(root).display().to_string()
                    ],
                    "ts": crate::now_iso()
                }),
                "recovery" => json!({
                    "step": step,
                    "recovery_plan": {
                        "runbook": runbook,
                        "strategy": "bounded_rollback_then_verify"
                    },
                    "ts": crate::now_iso()
                }),
                _ => json!({
                    "step": step,
                    "runbook": runbook,
                    "policy_bounded": true,
                    "ts": crate::now_iso()
                }),
            };
            let _ = write_json(&artifact_path, &artifact);
            response_receipts.push(json!({
                "index": idx + 1,
                "step": step,
                "artifact_path": artifact_path.display().to_string(),
                "artifact_sha256": sha256_hex_str(&artifact.to_string())
            }));
        }
        let incident = json!({
            "incident_id": incident_id,
            "runbook": runbook,
            "action": action,
            "response_actions": requested_actions,
            "response_receipts": response_receipts,
            "status": "active",
            "context": intelligent_context(root),
            "triggered_at": crate::now_iso()
        });
        state["incidents"][&incident_id] = incident.clone();
        state["last_updated_at"] = Value::String(crate::now_iso());
        let _ = write_json(&path, &state);
        let _ = append_jsonl(
            &state_root(root).join("incidents").join("history.jsonl"),
            &json!({"op": "trigger", "incident_id": incident_id, "ts": crate::now_iso()}),
        );
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "observability_plane_incident",
            "lane": "core/layer0/ops",
            "op": "trigger",
            "incident": incident,
            "artifact": {
                "path": path.display().to_string(),
                "sha256": sha256_hex_str(&state.to_string())
            },
            "claim_evidence": [
                {
                    "id": "V6-OBSERVABILITY-001.3",
                    "claim": "incident_triggers_invoke_policy_bounded_response_actions_with_receipts",
                    "evidence": {
                        "incident_id": incident_id,
                        "response_action_count": incident
                            .get("response_actions")
                            .and_then(Value::as_array)
                            .map(|rows| rows.len())
                            .unwrap_or(0)
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    if strict && state["incidents"].get(&incident_id).is_none() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "observability_plane_incident",
            "errors": ["observability_incident_not_found"]
        });
    }
    state["incidents"][&incident_id]["status"] = Value::String("resolved".to_string());
    state["incidents"][&incident_id]["resolved_at"] = Value::String(crate::now_iso());
    state["last_updated_at"] = Value::String(crate::now_iso());
    let _ = write_json(&path, &state);
    let _ = append_jsonl(
        &state_root(root).join("incidents").join("history.jsonl"),
        &json!({"op": "resolve", "incident_id": incident_id, "ts": crate::now_iso()}),
    );
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "observability_plane_incident",
        "lane": "core/layer0/ops",
        "op": "resolve",
        "incident": state["incidents"][&incident_id].clone(),
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&state.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-OBSERVABILITY-001.3",
                "claim": "incident_resolution_generates_deterministic_orchestration_receipts",
                "evidence": {
                    "incident_id": incident_id
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_selfhost(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        SELFHOST_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "observability_self_hosted_deploy_contract",
            "allowed_profiles": ["docker-local", "k8s-local"],
            "telemetry_mandatory": false
        }),
    );
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "status".to_string()),
        20,
    )
    .to_ascii_lowercase();
    if op == "status" {
        let latest = read_json(&selfhost_state_path(root)).unwrap_or_else(|| Value::Null);
        let health = read_json(&selfhost_health_path(root)).unwrap_or_else(|| Value::Null);
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "observability_plane_selfhost",
            "lane": "core/layer0/ops",
            "op": "status",
            "latest": latest,
            "deployment_health": health,
            "claim_evidence": [
                {
                    "id": "V6-OBSERVABILITY-001.4",
                    "claim": "self_hosted_observability_profile_status_is_available_without_mandatory_telemetry",
                    "evidence": {
                        "has_latest": !latest.is_null(),
                        "has_health": !health.is_null()
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }
    if op != "deploy" {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "observability_plane_selfhost",
            "errors": ["observability_selfhost_op_invalid"]
        });
    }

    let profile = clean(
        parsed
            .flags
            .get("profile")
            .cloned()
            .unwrap_or_else(|| "docker-local".to_string()),
        40,
    )
    .to_ascii_lowercase();
    let profile_allowed = contract
        .get("allowed_profiles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .any(|row| row == profile);
    if strict && !profile_allowed {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "observability_plane_selfhost",
            "errors": ["observability_selfhost_profile_invalid"]
        });
    }
    let telemetry_opt_in = parse_bool(parsed.flags.get("telemetry-opt-in"), false);
    let telemetry_mandatory = contract
        .get("telemetry_mandatory")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if strict && telemetry_mandatory && !telemetry_opt_in {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "observability_plane_selfhost",
            "errors": ["observability_selfhost_telemetry_required_by_contract"]
        });
    }
    let deployment = json!({
        "version": "v1",
        "profile": profile,
        "telemetry_opt_in": telemetry_opt_in,
        "command": if profile == "k8s-local" { "kubectl apply -f observability-stack.yaml" } else { "docker compose -f observability-stack.yml up -d" },
        "deployed_at": crate::now_iso()
    });
    let path = selfhost_state_path(root);
    let _ = write_json(&path, &deployment);
    let _ = append_jsonl(
        &state_root(root).join("deploy").join("history.jsonl"),
        &deployment,
    );
    let deployment_health = {
        let components = json!({
            "alerts_store_ready": alerts_state_path(root).parent().map(|p| p.exists()).unwrap_or(false),
            "workflow_registry_ready": workflows_state_path(root).parent().map(|p| p.exists()).unwrap_or(false),
            "incident_store_ready": incidents_state_path(root).parent().map(|p| p.exists()).unwrap_or(false)
        });
        let healthy = components
            .as_object()
            .map(|rows| rows.values().all(|v| v.as_bool().unwrap_or(false)))
            .unwrap_or(false);
        json!({
            "profile": profile,
            "healthy": healthy,
            "components": components,
            "checked_at": crate::now_iso()
        })
    };
    let health_path = selfhost_health_path(root);
    let _ = write_json(&health_path, &deployment_health);
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "observability_plane_selfhost",
        "lane": "core/layer0/ops",
        "op": "deploy",
        "deployment": deployment,
        "deployment_health": deployment_health,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&read_json(&path).unwrap_or_else(|| json!({})).to_string()),
            "health_path": health_path.display().to_string(),
            "health_sha256": sha256_hex_str(&read_json(&health_path).unwrap_or_else(|| json!({})).to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-OBSERVABILITY-001.4",
                "claim": "single_command_self_hosted_observability_profile_is_deployable_without_mandatory_telemetry",
                "evidence": {
                    "profile": profile,
                    "telemetry_opt_in": telemetry_opt_in,
                    "health_checked": true
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_acp_provenance(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        ACP_PROVENANCE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "observability_acp_provenance_contract",
            "allowed_ops": ["enable", "status", "trace", "debug"],
            "allowed_visibility_modes": ["off", "meta", "meta+receipt"],
            "require_source_identity": true,
            "require_intent": true
        }),
    );
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "status".to_string()),
        20,
    )
    .to_ascii_lowercase();
    let allowed_ops = contract
        .get("allowed_ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|row| row.to_string())
        .collect::<Vec<_>>();
    if strict && !allowed_ops.iter().any(|row| row == &op) {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "observability_plane_acp_provenance",
            "errors": ["observability_acp_provenance_op_invalid"]
        });
    }

    let config_path = provenance_config_path(root);
    let mut config = read_json(&config_path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "enabled": false,
            "visibility_mode": "meta+receipt",
            "updated_at": crate::now_iso()
        })
    });
    if !config.is_object() {
        config = json!({
            "version": "v1",
            "enabled": false,
            "visibility_mode": "meta+receipt",
            "updated_at": crate::now_iso()
        });
    }

    if op == "status" {
        let latest = read_json(&provenance_latest_path(root));
        let history_rows = std::fs::read_to_string(provenance_history_path(root))
            .ok()
            .map(|raw| raw.lines().count())
            .unwrap_or(0);
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "observability_plane_acp_provenance",
            "lane": "core/layer0/ops",
            "op": "status",
            "config": config,
            "latest_trace": latest,
            "trace_history_rows": history_rows,
            "claim_evidence": [
                {
                    "id": "V6-OBSERVABILITY-005.11",
                    "claim": "acp_provenance_status_surface_reports_end_to_end_activation_and_trace_health",
                    "evidence": { "history_rows": history_rows }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    if op == "enable" {
        let enabled = parse_bool(parsed.flags.get("enabled"), true);
        let visibility_mode = parse_visibility_mode(parsed.flags.get("visibility-mode").cloned());
        let allowed_modes_values = contract
            .get("allowed_visibility_modes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let allowed_modes = allowed_modes_values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        if strict && !allowed_modes.iter().any(|row| row == &visibility_mode) {
            return json!({
                "ok": false,
                "strict": strict,
                "type": "observability_plane_acp_provenance",
                "errors": ["observability_acp_provenance_visibility_mode_invalid"]
            });
        }
        config["enabled"] = Value::Bool(enabled);
        config["visibility_mode"] = Value::String(visibility_mode.clone());
        config["updated_at"] = Value::String(crate::now_iso());
        let _ = write_json(&config_path, &config);
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "observability_plane_acp_provenance",
            "lane": "core/layer0/ops",
            "op": "enable",
            "config": config,
            "artifact": {
                "config_path": config_path.display().to_string(),
                "config_sha256": sha256_hex_str(&read_json(&config_path).unwrap_or(Value::Null).to_string())
            },
            "claim_evidence": [
                {
                    "id": "V6-OBSERVABILITY-005.11",
                    "claim": "one_command_activation_enables_acp_provenance_with_deterministic_receipts",
                    "evidence": {
                        "enabled": enabled,
                        "visibility_mode": visibility_mode
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    if strict
        && !config
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "observability_plane_acp_provenance",
            "op": op,
            "errors": ["observability_acp_provenance_not_enabled"]
        });
    }

    if op == "debug" {
        let trace_id = clean(
            parsed.flags.get("trace-id").cloned().unwrap_or_default(),
            120,
        );
        let rows = std::fs::read_to_string(provenance_history_path(root))
            .ok()
            .map(|raw| {
                raw.lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .filter(|row| {
                        if trace_id.is_empty() {
                            true
                        } else {
                            row.get("trace_id").and_then(Value::as_str) == Some(trace_id.as_str())
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "observability_plane_acp_provenance",
            "lane": "core/layer0/ops",
            "op": "debug",
            "trace_id": trace_id,
            "rows": rows,
            "claim_evidence": [
                {
                    "id": "V6-OBSERVABILITY-005.10",
                    "claim": "debug_surface_exposes_trace_chain_for_command_center_diagnostics",
                    "evidence": { "rows": rows.len() }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    let source_agent = clean(
        parsed
            .flags
            .get("source-agent")
            .cloned()
            .or_else(|| parsed.flags.get("source").cloned())
            .unwrap_or_default(),
        120,
    );
    let target_agent = clean(
        parsed
            .flags
            .get("target-agent")
            .cloned()
            .or_else(|| parsed.flags.get("target").cloned())
            .unwrap_or_else(|| "broadcast".to_string()),
        120,
    );
    let intent = clean(parsed.flags.get("intent").cloned().unwrap_or_default(), 180);
    let message = clean(
        parsed
            .flags
            .get("message")
            .cloned()
            .unwrap_or_else(|| "trace payload".to_string()),
        300,
    );
    let visibility_mode =
        parse_visibility_mode(parsed.flags.get("visibility-mode").cloned().or_else(|| {
            config
                .get("visibility_mode")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
        }));
    let require_source = contract
        .get("require_source_identity")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let require_intent = contract
        .get("require_intent")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if strict
        && ((require_source && source_agent.is_empty()) || (require_intent && intent.is_empty()))
    {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "observability_plane_acp_provenance",
            "op": "trace",
            "errors": ["observability_acp_unprovenanced_message_denied"],
            "denial_reason": {
                "missing_source_agent": source_agent.is_empty(),
                "missing_intent": intent.is_empty()
            },
            "claim_evidence": [
                {
                    "id": "V6-OBSERVABILITY-005.10",
                    "claim": "anonymous_or_unprovenanced_messages_are_denied_fail_closed",
                    "evidence": {
                        "missing_source_agent": source_agent.is_empty(),
                        "missing_intent": intent.is_empty()
                    }
                }
            ]
        });
    }

    let history_rows = std::fs::read_to_string(provenance_history_path(root))
        .ok()
        .map(|raw| {
            raw.lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let previous_hop_hash = history_rows
        .last()
        .and_then(|row| row.get("hop_hash"))
        .and_then(Value::as_str)
        .unwrap_or("genesis")
        .to_string();
    let trace_id = clean(
        parsed.flags.get("trace-id").cloned().unwrap_or_else(|| {
            format!(
                "trace_{}",
                &sha256_hex_str(&format!("{source_agent}:{target_agent}:{intent}:{message}"))[..12]
            )
        }),
        128,
    );
    let hop_index = history_rows
        .iter()
        .filter(|row| row.get("trace_id").and_then(Value::as_str) == Some(trace_id.as_str()))
        .count()
        + 1;
    let hop_meta = json!({
        "source_identity": source_agent,
        "target_identity": target_agent,
        "intent": intent,
        "timestamp": crate::now_iso()
    });
    let hop_hash = crate::v8_kernel::next_chain_hash(Some(&previous_hop_hash), &hop_meta);
    let mut trace_entry = json!({
        "version": "v1",
        "trace_id": trace_id,
        "hop_index": hop_index,
        "source_agent": hop_meta.get("source_identity").cloned().unwrap_or(Value::Null),
        "target_agent": hop_meta.get("target_identity").cloned().unwrap_or(Value::Null),
        "intent": hop_meta.get("intent").cloned().unwrap_or(Value::Null),
        "message": message,
        "ts": hop_meta.get("timestamp").cloned().unwrap_or(Value::Null),
        "previous_hop_hash": previous_hop_hash,
        "hop_hash": hop_hash
    });
    trace_entry["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&trace_entry));
    let _ = append_jsonl(&provenance_history_path(root), &trace_entry);
    let _ = write_json(&provenance_latest_path(root), &trace_entry);
    let visible = visible_trace_payload(&trace_entry, &visibility_mode);
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "observability_plane_acp_provenance",
        "lane": "core/layer0/ops",
        "op": "trace",
        "trace_id": trace_entry.get("trace_id").cloned().unwrap_or(Value::Null),
        "hop": visible,
        "visibility_mode": visibility_mode,
        "artifact": {
            "history_path": provenance_history_path(root).display().to_string(),
            "latest_trace_path": provenance_latest_path(root).display().to_string()
        },
        "claim_evidence": [
            {
                "id": "V6-OBSERVABILITY-005.7",
                "claim": "inter_agent_messages_attach_source_timestamp_and_intent_metadata",
                "evidence": {
                    "source_agent": trace_entry.get("source_agent").cloned().unwrap_or(Value::Null),
                    "hop_index": hop_index
                }
            },
            {
                "id": "V6-OBSERVABILITY-005.8",
                "claim": "trace_id_propagates_across_hops_with_deterministic_chain_hashes",
                "evidence": {
                    "trace_id": trace_entry.get("trace_id").cloned().unwrap_or(Value::Null),
                    "hop_hash": trace_entry.get("hop_hash").cloned().unwrap_or(Value::Null)
                }
            },
            {
                "id": "V6-OBSERVABILITY-005.9",
                "claim": "trace_visibility_modes_gate_metadata_and_receipt_detail_surfaces",
                "evidence": {
                    "visibility_mode": visibility_mode
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let command = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    let strict = parse_bool(parsed.flags.get("strict"), true);
    let conduit = if command != "status" {
        Some(conduit_enforcement(root, &parsed, strict, &command))
    } else {
        None
    };
    if strict
        && conduit
            .as_ref()
            .and_then(|v| v.get("ok"))
            .and_then(Value::as_bool)
            == Some(false)
    {
        return emit(
            root,
            json!({
                "ok": false,
                "strict": strict,
                "type": "observability_plane_conduit_gate",
                "errors": ["conduit_bypass_rejected"],
                "conduit_enforcement": conduit
            }),
        );
    }

    let payload = match command.as_str() {
        "status" => status(root),
        "monitor" => run_monitor(root, &parsed, strict),
        "workflow" => run_workflow(root, &parsed, strict),
        "incident" => run_incident(root, &parsed, strict),
        "selfhost" => run_selfhost(root, &parsed, strict),
        "acp-provenance" => run_acp_provenance(root, &parsed, strict),
        _ => json!({
            "ok": false,
            "type": "observability_plane_error",
            "error": "unknown_command",
            "command": command
        }),
    };
    if command == "status" {
        print_payload(&payload);
        return 0;
    }
    emit(root, attach_conduit(payload, conduit.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conduit_rejects_bypass() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = crate::parse_args(&["monitor".to_string(), "--bypass=1".to_string()]);
        let out = conduit_enforcement(root.path(), &parsed, true, "monitor");
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn workflow_upsert_creates_registry() {
        let root = tempfile::tempdir().expect("tempdir");
        let out = run_workflow(
            root.path(),
            &crate::parse_args(&[
                "workflow".to_string(),
                "--op=upsert".to_string(),
                "--workflow-id=obs-main".to_string(),
            ]),
            true,
        );
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        assert!(workflows_state_path(root.path()).exists());
    }
}
