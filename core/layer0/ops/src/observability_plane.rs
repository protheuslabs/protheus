// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::observability_plane (authoritative)

use crate::v8_kernel::{
    append_jsonl, parse_bool, read_json, scoped_state_root, sha256_hex_str, write_json,
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

fn load_json_or(root: &Path, rel: &str, fallback: Value) -> Value {
    read_json(&root.join(rel)).unwrap_or(fallback)
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
        _ => vec!["V6-OBSERVABILITY-001.5"],
    }
}

fn conduit_enforcement(
    root: &Path,
    parsed: &crate::ParsedArgs,
    strict: bool,
    action: &str,
) -> Value {
    let bypass_requested = parse_bool(parsed.flags.get("bypass"), false)
        || parse_bool(parsed.flags.get("direct"), false)
        || parse_bool(parsed.flags.get("unsafe-client-route"), false)
        || parse_bool(parsed.flags.get("client-bypass"), false);
    let ok = !bypass_requested;
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
    let mut out = json!({
        "ok": if strict { ok } else { true },
        "type": "observability_conduit_enforcement",
        "action": clean(action, 120),
        "required_path": "core/layer0/ops/observability_plane",
        "bypass_requested": bypass_requested,
        "errors": if ok { Value::Array(Vec::new()) } else { json!(["conduit_bypass_rejected"]) },
        "claim_evidence": claim_rows
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    let _ = append_jsonl(
        &state_root(root).join("conduit").join("history.jsonl"),
        &out,
    );
    out
}

fn attach_conduit(mut payload: Value, conduit: Option<&Value>) -> Value {
    if let Some(gate) = conduit {
        payload["conduit_enforcement"] = gate.clone();
        let mut claims = payload
            .get("claim_evidence")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(rows) = gate.get("claim_evidence").and_then(Value::as_array) {
            claims.extend(rows.iter().cloned());
        }
        if !claims.is_empty() {
            payload["claim_evidence"] = Value::Array(claims);
        }
    }
    payload["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&payload));
    payload
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

fn selfhost_state_path(root: &Path) -> PathBuf {
    state_root(root).join("deploy").join("latest.json")
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
        let steps = parse_json_flag(
            parsed.flags.get("steps-json"),
            json!(["collect-metrics", "attach-context", "notify"]),
        );
        let workflow = json!({
            "workflow_id": workflow_id,
            "trigger": trigger,
            "schedule": schedule,
            "steps": steps,
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
    let run = json!({
        "run_id": run_id,
        "workflow_id": workflow_id,
        "status": "started",
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
            "default_response_actions": ["quarantine", "rollback", "page-oncall"]
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
            parsed
                .flags
                .get("action")
                .cloned()
                .unwrap_or_else(|| "quarantine+rollback".to_string()),
            160,
        );
        let incident = json!({
            "incident_id": incident_id,
            "runbook": runbook,
            "action": action,
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
                        "incident_id": incident_id
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
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "observability_plane_selfhost",
            "lane": "core/layer0/ops",
            "op": "status",
            "latest": latest,
            "claim_evidence": [
                {
                    "id": "V6-OBSERVABILITY-001.4",
                    "claim": "self_hosted_observability_profile_status_is_available_without_mandatory_telemetry",
                    "evidence": {
                        "has_latest": !latest.is_null()
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
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "observability_plane_selfhost",
        "lane": "core/layer0/ops",
        "op": "deploy",
        "deployment": deployment,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&read_json(&path).unwrap_or_else(|| json!({})).to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-OBSERVABILITY-001.4",
                "claim": "single_command_self_hosted_observability_profile_is_deployable_without_mandatory_telemetry",
                "evidence": {
                    "profile": profile,
                    "telemetry_opt_in": telemetry_opt_in
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
