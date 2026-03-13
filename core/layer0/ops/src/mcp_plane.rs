// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::mcp_plane (authoritative)

use crate::v8_kernel::{
    append_jsonl, parse_bool, parse_u64, read_json, scoped_state_root, sha256_hex_str, write_json,
    write_receipt,
};
use crate::{clean, now_iso, parse_args};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "MCP_PLANE_STATE_ROOT";
const STATE_SCOPE: &str = "mcp_plane";

const CAPABILITY_MATRIX_CONTRACT_PATH: &str =
    "planes/contracts/mcp/capability_matrix_contract_v1.json";
const DURABLE_WORKFLOW_CONTRACT_PATH: &str =
    "planes/contracts/mcp/durable_workflow_contract_v1.json";
const EXPOSURE_CONTRACT_PATH: &str = "planes/contracts/mcp/exposure_contract_v1.json";
const PATTERN_PACK_CONTRACT_PATH: &str = "planes/contracts/mcp/pattern_pack_contract_v1.json";
const TEMPLATE_GOVERNANCE_CONTRACT_PATH: &str =
    "planes/contracts/mcp/template_governance_contract_v1.json";
const TEMPLATE_MANIFEST_PATH: &str = "planes/contracts/mcp/template_pack_manifest_v1.json";

fn usage() {
    println!("Usage:");
    println!("  protheus-ops mcp-plane status");
    println!("  protheus-ops mcp-plane capability-matrix [--server-capabilities=a,b] [--server-capabilities-file=<path>] [--strict=1|0]");
    println!("  protheus-ops mcp-plane workflow --op=<start|pause|resume|retry|status> [--workflow-id=<id>] [--checkpoint-json=<json>|--checkpoint-path=<path>] [--reason=<text>] [--strict=1|0]");
    println!(
        "  protheus-ops mcp-plane expose --agent=<id> [--tools=a,b] [--max-rps=<n>] [--strict=1|0]"
    );
    println!("  protheus-ops mcp-plane pattern-pack [--pattern=router|map-reduce|fanout|sequential] [--tasks=a,b] [--steps-json=<json>] [--strict=1|0]");
    println!("  protheus-ops mcp-plane template-governance [--manifest=<path>] [--templates-root=<path>] [--strict=1|0]");
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
                "type": "mcp_plane_error",
                "error": clean(err, 240)
            }));
            1
        }
    }
}

fn load_json_or(root: &Path, rel: &str, fallback: Value) -> Value {
    read_json(&root.join(rel)).unwrap_or(fallback)
}

fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                if let Some(v) = map.get(&key) {
                    out.insert(key, canonicalize_json(v));
                }
            }
            Value::Object(out)
        }
        Value::Array(rows) => Value::Array(rows.iter().map(canonicalize_json).collect()),
        _ => value.clone(),
    }
}

fn canonical_json_string(value: &Value) -> String {
    serde_json::to_string(&canonicalize_json(value)).unwrap_or_else(|_| "null".to_string())
}

fn parse_csv_flag(parsed: &crate::ParsedArgs, key: &str, max_len: usize) -> Vec<String> {
    parsed
        .flags
        .get(key)
        .map(|v| {
            v.split(',')
                .map(|row| clean(row, max_len))
                .filter(|row| !row.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn parse_csv_or_file(
    root: &Path,
    parsed: &crate::ParsedArgs,
    csv_key: &str,
    file_key: &str,
    max_len: usize,
) -> Vec<String> {
    let mut values = parse_csv_flag(parsed, csv_key, max_len);
    if let Some(rel_or_abs) = parsed.flags.get(file_key) {
        let path = if Path::new(rel_or_abs).is_absolute() {
            PathBuf::from(rel_or_abs)
        } else {
            root.join(rel_or_abs)
        };
        if let Ok(raw) = fs::read_to_string(path) {
            if raw.trim_start().starts_with('[') {
                if let Ok(parsed_json) = serde_json::from_str::<Value>(&raw) {
                    if let Some(rows) = parsed_json.as_array() {
                        for row in rows {
                            if let Some(s) = row.as_str() {
                                let cleaned = clean(s, max_len);
                                if !cleaned.is_empty() {
                                    values.push(cleaned);
                                }
                            }
                        }
                    }
                }
            } else {
                for row in raw.lines() {
                    let cleaned = clean(row, max_len);
                    if !cleaned.is_empty() {
                        values.push(cleaned);
                    }
                }
            }
        }
    }
    values.sort();
    values.dedup();
    values
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
    let mut out = json!({
        "ok": if strict { ok } else { true },
        "type": "mcp_conduit_enforcement",
        "action": clean(action, 120),
        "required_path": "core/layer0/ops/mcp_plane",
        "bypass_requested": bypass_requested,
        "errors": if ok { Value::Array(Vec::new()) } else { json!(["conduit_bypass_rejected"]) },
        "claim_evidence": [
            {
                "id": "V6-MCP-001.6",
                "claim": "all_mcp_client_server_actions_are_conduit_only_with_fail_closed_bypass_rejection",
                "evidence": {
                    "action": clean(action, 120),
                    "bypass_requested": bypass_requested
                }
            }
        ]
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

fn status(root: &Path) -> Value {
    json!({
        "ok": true,
        "type": "mcp_plane_status",
        "lane": "core/layer0/ops",
        "latest_path": latest_path(root).display().to_string(),
        "latest": read_json(&latest_path(root))
    })
}

fn run_capability_matrix(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        CAPABILITY_MATRIX_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "mcp_capability_matrix_contract",
            "required_capabilities": ["tools.call", "resources.read"],
            "optional_capabilities": ["workflow.pause_resume_retry", "server.expose", "pattern.pack"]
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("mcp_capability_matrix_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "mcp_capability_matrix_contract"
    {
        errors.push("mcp_capability_matrix_contract_kind_invalid".to_string());
    }

    let server_caps = parse_csv_or_file(
        root,
        parsed,
        "server-capabilities",
        "server-capabilities-file",
        120,
    );
    if server_caps.is_empty() {
        errors.push("server_capabilities_required".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "mcp_plane_capability_matrix",
            "errors": errors
        });
    }

    let required = contract
        .get("required_capabilities")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|v| clean(v, 120))
        .collect::<Vec<_>>();
    let optional = contract
        .get("optional_capabilities")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|v| clean(v, 120))
        .collect::<Vec<_>>();

    let missing_required = required
        .iter()
        .filter(|cap| !server_caps.iter().any(|row| row == *cap))
        .cloned()
        .collect::<Vec<_>>();
    let coverage = required
        .iter()
        .chain(optional.iter())
        .map(|cap| {
            json!({
                "capability": cap,
                "required": required.iter().any(|row| row == cap),
                "present": server_caps.iter().any(|row| row == cap)
            })
        })
        .collect::<Vec<_>>();
    let pass = missing_required.is_empty();
    let ok = if strict { pass } else { true };

    let result = json!({
        "required_capabilities": required,
        "optional_capabilities": optional,
        "server_capabilities": server_caps,
        "missing_required": missing_required,
        "coverage": coverage,
        "pass": pass
    });
    let artifact_path = state_root(root)
        .join("capability_matrix")
        .join("latest.json");
    let _ = write_json(&artifact_path, &result);

    let mut out = json!({
        "ok": ok,
        "strict": strict,
        "type": "mcp_plane_capability_matrix",
        "lane": "core/layer0/ops",
        "artifact": {
            "path": artifact_path.display().to_string(),
            "sha256": sha256_hex_str(&result.to_string())
        },
        "result": result,
        "errors": if pass { Value::Array(Vec::new()) } else { json!(["required_capabilities_missing"]) },
        "claim_evidence": [
            {
                "id": "V6-MCP-001.1",
                "claim": "versioned_mcp_capability_matrix_conformance_harness_produces_deterministic_pass_fail_receipts",
                "evidence": {
                    "missing_required_count": missing_required.len(),
                    "pass": pass
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn load_checkpoint(root: &Path, parsed: &crate::ParsedArgs) -> Option<Value> {
    if let Some(raw) = parsed.flags.get("checkpoint-json") {
        if let Ok(value) = serde_json::from_str::<Value>(raw) {
            return Some(value);
        }
    }
    if let Some(rel_or_abs) = parsed.flags.get("checkpoint-path") {
        let path = if Path::new(rel_or_abs).is_absolute() {
            PathBuf::from(rel_or_abs)
        } else {
            root.join(rel_or_abs)
        };
        if let Some(value) = read_json(&path) {
            return Some(value);
        }
    }
    None
}

fn run_workflow_runtime(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        DURABLE_WORKFLOW_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "durable_mcp_workflow_contract",
            "max_retries": 5,
            "checkpoint_relpath": "workflow_runtime/state.json"
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("durable_workflow_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "durable_mcp_workflow_contract"
    {
        errors.push("durable_workflow_contract_kind_invalid".to_string());
    }
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "status".to_string()),
        32,
    )
    .to_ascii_lowercase();
    if !matches!(
        op.as_str(),
        "start" | "pause" | "resume" | "retry" | "status"
    ) {
        errors.push("workflow_op_invalid".to_string());
    }
    let workflow_id = clean(
        parsed
            .flags
            .get("workflow-id")
            .cloned()
            .unwrap_or_else(|| "wf-default".to_string()),
        120,
    );
    if workflow_id.is_empty() {
        errors.push("workflow_id_required".to_string());
    }
    let max_retries = contract
        .get("max_retries")
        .and_then(Value::as_u64)
        .unwrap_or(5);
    let checkpoint_relpath = clean(
        contract
            .get("checkpoint_relpath")
            .and_then(Value::as_str)
            .unwrap_or("workflow_runtime/state.json"),
        200,
    );
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "mcp_plane_workflow_runtime",
            "errors": errors
        });
    }

    let state_path = state_root(root).join(checkpoint_relpath);
    let mut state = read_json(&state_path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "kind": "mcp_workflow_runtime_state",
            "workflows": {}
        })
    });
    if !state
        .get("workflows")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        state["workflows"] = Value::Object(Map::new());
    }
    let workflows = state
        .get("workflows")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut current = workflows.get(&workflow_id).cloned().unwrap_or_else(|| {
        json!({
            "workflow_id": workflow_id,
            "status": "idle",
            "step": 0_u64,
            "retry_count": 0_u64,
            "resume_count": 0_u64,
            "last_event_hash": "genesis"
        })
    });

    let status_before = current
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("idle")
        .to_string();
    let mut apply_state = false;
    match op.as_str() {
        "status" => {}
        "start" => {
            current["status"] = Value::String("running".to_string());
            current["step"] = json!(current.get("step").and_then(Value::as_u64).unwrap_or(0) + 1);
            current["updated_at"] = Value::String(now_iso());
            if let Some(checkpoint) = load_checkpoint(root, parsed) {
                current["checkpoint"] = checkpoint;
            }
            apply_state = true;
        }
        "pause" => {
            if strict && status_before != "running" {
                errors.push("workflow_pause_requires_running_status".to_string());
            } else {
                current["status"] = Value::String("paused".to_string());
                current["pause_count"] = json!(
                    current
                        .get("pause_count")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        + 1
                );
                current["updated_at"] = Value::String(now_iso());
                apply_state = true;
            }
        }
        "resume" => {
            if strict && status_before != "paused" {
                errors.push("workflow_resume_requires_paused_status".to_string());
            } else {
                current["status"] = Value::String("running".to_string());
                current["resume_count"] = json!(
                    current
                        .get("resume_count")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        + 1
                );
                current["updated_at"] = Value::String(now_iso());
                apply_state = true;
            }
        }
        "retry" => {
            let retries = current
                .get("retry_count")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if strict && retries >= max_retries {
                errors.push("workflow_retry_limit_exceeded".to_string());
            } else {
                current["status"] = Value::String("running".to_string());
                current["retry_count"] = json!(retries + 1);
                current["last_retry_reason"] = Value::String(clean(
                    parsed
                        .flags
                        .get("reason")
                        .cloned()
                        .unwrap_or_else(|| "operator_retry".to_string()),
                    240,
                ));
                current["updated_at"] = Value::String(now_iso());
                apply_state = true;
            }
        }
        _ => {}
    }

    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "mcp_plane_workflow_runtime",
            "errors": errors
        });
    }

    let mut event = Value::Null;
    if apply_state {
        let prev_hash = current
            .get("last_event_hash")
            .and_then(Value::as_str)
            .unwrap_or("genesis")
            .to_string();
        let event_payload = json!({
            "workflow_id": workflow_id,
            "op": op,
            "status": current.get("status").and_then(Value::as_str).unwrap_or("idle"),
            "step": current.get("step").and_then(Value::as_u64).unwrap_or(0),
            "retry_count": current.get("retry_count").and_then(Value::as_u64).unwrap_or(0),
            "resume_count": current.get("resume_count").and_then(Value::as_u64).unwrap_or(0),
            "ts": now_iso()
        });
        let chain_hash = sha256_hex_str(&format!(
            "{}:{}",
            prev_hash,
            canonical_json_string(&event_payload)
        ));
        current["last_event_hash"] = Value::String(chain_hash.clone());
        event = json!({
            "event": event_payload,
            "prev_hash": prev_hash,
            "chain_hash": chain_hash
        });
        let _ = append_jsonl(
            &state_root(root)
                .join("workflow_runtime")
                .join("history.jsonl"),
            &event,
        );
    }

    let mut workflows_next = state
        .get("workflows")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    workflows_next.insert(workflow_id.clone(), current.clone());
    state["workflows"] = Value::Object(workflows_next);
    let _ = write_json(&state_path, &state);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "mcp_plane_workflow_runtime",
        "lane": "core/layer0/ops",
        "workflow_id": workflow_id,
        "op": op,
        "state_path": state_path.display().to_string(),
        "workflow": current,
        "event": event,
        "claim_evidence": [
            {
                "id": "V6-MCP-001.2",
                "claim": "durable_mcp_workflow_execution_supports_pause_resume_retry_with_policy_scoped_checkpointing_and_deterministic_recovery_receipts",
                "evidence": {
                    "op": op,
                    "state_path": state_path.display().to_string()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_expose(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        EXPOSURE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "mcp_exposure_contract",
            "default_max_rps": 10,
            "max_tools": 16
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("mcp_exposure_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "mcp_exposure_contract"
    {
        errors.push("mcp_exposure_contract_kind_invalid".to_string());
    }
    let agent = clean(
        parsed
            .flags
            .get("agent")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_default(),
        120,
    );
    if agent.is_empty() {
        errors.push("agent_required".to_string());
    }
    let tools = parse_csv_flag(parsed, "tools", 120);
    let max_tools = contract
        .get("max_tools")
        .and_then(Value::as_u64)
        .unwrap_or(16) as usize;
    if strict && tools.len() > max_tools {
        errors.push("tool_limit_exceeded".to_string());
    }
    let max_rps = parse_u64(
        parsed.flags.get("max-rps"),
        contract
            .get("default_max_rps")
            .and_then(Value::as_u64)
            .unwrap_or(10),
    )
    .clamp(1, 50_000);
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "mcp_plane_expose",
            "errors": errors
        });
    }

    let exposure_id = format!(
        "mcp_{}",
        &sha256_hex_str(&format!("{}:{}:{}", agent, tools.join(","), max_rps))[..16]
    );
    let mut registry =
        read_json(&state_root(root).join("exposure_registry.json")).unwrap_or_else(|| {
            json!({
                "version": "v1",
                "kind": "mcp_exposure_registry",
                "entries": {}
            })
        });
    if !registry
        .get("entries")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        registry["entries"] = Value::Object(Map::new());
    }
    let mut entries = registry
        .get("entries")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let entry = json!({
        "id": exposure_id,
        "agent": agent,
        "tools": tools,
        "max_rps": max_rps,
        "created_at": now_iso(),
        "endpoint": format!("mcp://{}", exposure_id)
    });
    entries.insert(exposure_id.clone(), entry.clone());
    registry["entries"] = Value::Object(entries);
    let registry_path = state_root(root).join("exposure_registry.json");
    let _ = write_json(&registry_path, &registry);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "mcp_plane_expose",
        "lane": "core/layer0/ops",
        "registry_path": registry_path.display().to_string(),
        "exposed": entry,
        "claim_evidence": [
            {
                "id": "V6-MCP-001.3",
                "claim": "agent_or_workflow_can_be_exposed_as_an_mcp_server_with_bounded_exposure_controls",
                "evidence": {
                    "exposure_id": exposure_id,
                    "max_rps": max_rps
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_pattern_pack(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        PATTERN_PACK_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "mcp_pattern_pack_contract",
            "allowed_patterns": ["router", "map-reduce", "fanout", "sequential"]
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("mcp_pattern_pack_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "mcp_pattern_pack_contract"
    {
        errors.push("mcp_pattern_pack_contract_kind_invalid".to_string());
    }
    let pattern = clean(
        parsed
            .flags
            .get("pattern")
            .cloned()
            .unwrap_or_else(|| "router".to_string()),
        40,
    )
    .to_ascii_lowercase();
    let allowed = contract
        .get("allowed_patterns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|v| clean(v, 40).to_ascii_lowercase())
        .collect::<Vec<_>>();
    if strict && !allowed.iter().any(|row| row == &pattern) {
        errors.push("pattern_not_allowed".to_string());
    }
    let tasks = parse_csv_flag(parsed, "tasks", 200);
    let steps = if let Some(raw) = parsed.flags.get("steps-json") {
        serde_json::from_str::<Value>(raw)
            .ok()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .map(|v| clean(v, 120))
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>()
    } else {
        match pattern.as_str() {
            "map-reduce" => vec![
                "map_discovery".to_string(),
                "map_execution".to_string(),
                "reduce_merge".to_string(),
            ],
            "fanout" => vec![
                "fanout_split".to_string(),
                "parallel_execute".to_string(),
                "aggregate_outputs".to_string(),
            ],
            "sequential" => vec![
                "step_one".to_string(),
                "step_two".to_string(),
                "step_three".to_string(),
            ],
            _ => vec![
                "router_select".to_string(),
                "router_dispatch".to_string(),
                "router_merge".to_string(),
            ],
        }
    };
    if steps.is_empty() {
        errors.push("pattern_steps_required".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "mcp_plane_pattern_pack",
            "errors": errors
        });
    }

    let step_receipts = steps
        .iter()
        .enumerate()
        .map(|(idx, step)| {
            json!({
                "index": idx,
                "step": step,
                "step_hash": sha256_hex_str(&format!("{}:{}:{}", pattern, idx, step))
            })
        })
        .collect::<Vec<_>>();
    let result = json!({
        "pattern": pattern,
        "tasks": tasks,
        "steps": steps,
        "step_receipts": step_receipts
    });
    let artifact_path = state_root(root).join("pattern_pack").join("latest.json");
    let _ = write_json(&artifact_path, &result);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "mcp_plane_pattern_pack",
        "lane": "core/layer0/ops",
        "artifact": {
            "path": artifact_path.display().to_string(),
            "sha256": sha256_hex_str(&result.to_string())
        },
        "result": result,
        "claim_evidence": [
            {
                "id": "V6-MCP-001.4",
                "claim": "declarative_composable_workflow_pattern_pack_compiles_to_deterministic_steps_with_receipts",
                "evidence": {
                    "pattern": pattern,
                    "step_count": steps.len()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_template_governance(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        TEMPLATE_GOVERNANCE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "mcp_template_governance_contract",
            "manifest_path": TEMPLATE_MANIFEST_PATH,
            "templates_root": "planes/contracts/mcp/templates",
            "required_mcp_version": "v1",
            "max_review_cadence_days": 120
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("mcp_template_governance_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "mcp_template_governance_contract"
    {
        errors.push("mcp_template_governance_contract_kind_invalid".to_string());
    }

    let manifest_rel = parsed
        .flags
        .get("manifest")
        .cloned()
        .or_else(|| {
            contract
                .get("manifest_path")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| TEMPLATE_MANIFEST_PATH.to_string());
    let templates_root_rel = parsed
        .flags
        .get("templates-root")
        .cloned()
        .or_else(|| {
            contract
                .get("templates_root")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "planes/contracts/mcp/templates".to_string());
    let manifest_path = if Path::new(&manifest_rel).is_absolute() {
        PathBuf::from(&manifest_rel)
    } else {
        root.join(&manifest_rel)
    };
    let templates_root = if Path::new(&templates_root_rel).is_absolute() {
        PathBuf::from(&templates_root_rel)
    } else {
        root.join(&templates_root_rel)
    };
    let manifest = read_json(&manifest_path).unwrap_or(Value::Null);
    if manifest.is_null() {
        errors.push(format!(
            "mcp_template_manifest_not_found:{}",
            manifest_path.display()
        ));
    }

    let required_mcp_version = clean(
        contract
            .get("required_mcp_version")
            .and_then(Value::as_str)
            .unwrap_or("v1"),
        32,
    );
    let max_review_cadence_days = contract
        .get("max_review_cadence_days")
        .and_then(Value::as_u64)
        .unwrap_or(120);
    let mut validated = Vec::<Value>::new();

    if !manifest.is_null() {
        if manifest
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            != "v1"
        {
            errors.push("mcp_template_manifest_version_must_be_v1".to_string());
        }
        if manifest
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            != "mcp_template_pack_manifest"
        {
            errors.push("mcp_template_manifest_kind_invalid".to_string());
        }
        let templates = manifest
            .get("templates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if templates.is_empty() {
            errors.push("mcp_template_manifest_templates_required".to_string());
        }

        for entry in templates {
            let rel_path = entry
                .get("path")
                .and_then(Value::as_str)
                .map(|v| clean(v, 260))
                .unwrap_or_default();
            if rel_path.is_empty() {
                errors.push("mcp_template_entry_path_required".to_string());
                continue;
            }
            let tpl_path = if Path::new(&rel_path).is_absolute() {
                PathBuf::from(&rel_path)
            } else {
                templates_root.join(&rel_path)
            };
            let raw_res = fs::read_to_string(&tpl_path)
                .map_err(|_| format!("mcp_template_file_missing:{}", tpl_path.display()));
            let raw = match raw_res {
                Ok(v) => v,
                Err(err) => {
                    errors.push(err);
                    continue;
                }
            };
            let expected_sha = entry
                .get("sha256")
                .and_then(Value::as_str)
                .map(|v| clean(v, 128))
                .unwrap_or_default();
            let actual_sha = sha256_hex_str(&raw);
            if expected_sha.is_empty() || expected_sha != actual_sha {
                errors.push(format!("mcp_template_sha_mismatch:{}", rel_path));
            }
            let human_reviewed = entry
                .get("human_reviewed")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if strict && !human_reviewed {
                errors.push(format!("mcp_template_not_human_reviewed:{}", rel_path));
            }
            let review_cadence_days = entry
                .get("review_cadence_days")
                .and_then(Value::as_u64)
                .unwrap_or(max_review_cadence_days + 1);
            if strict && review_cadence_days > max_review_cadence_days {
                errors.push(format!("mcp_template_review_cadence_exceeded:{}", rel_path));
            }
            let mcp_version = entry
                .get("compatibility")
                .and_then(Value::as_object)
                .and_then(|row| row.get("mcp_version"))
                .and_then(Value::as_str)
                .map(|v| clean(v, 32))
                .unwrap_or_default();
            if strict && mcp_version != required_mcp_version {
                errors.push(format!("mcp_template_version_incompatible:{}", rel_path));
            }

            validated.push(json!({
                "path": tpl_path.display().to_string(),
                "sha256": actual_sha,
                "human_reviewed": human_reviewed,
                "review_cadence_days": review_cadence_days,
                "mcp_version": mcp_version
            }));
        }

        let signature = manifest
            .get("signature")
            .and_then(Value::as_str)
            .map(|v| clean(v, 240))
            .unwrap_or_default();
        let mut signature_basis = manifest.clone();
        if let Some(obj) = signature_basis.as_object_mut() {
            obj.remove("signature");
        }
        match std::env::var("MCP_TEMPLATE_SIGNING_KEY")
            .ok()
            .map(|v| clean(v, 4096))
            .filter(|v| !v.is_empty())
        {
            Some(key) => {
                let expected = format!(
                    "sig:{}",
                    sha256_hex_str(&format!(
                        "{}:{}",
                        key,
                        canonical_json_string(&signature_basis)
                    ))
                );
                if signature != expected {
                    errors.push("mcp_template_manifest_signature_invalid".to_string());
                }
            }
            None => {
                if strict {
                    errors.push("mcp_template_signing_key_missing".to_string());
                }
            }
        }
    }

    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "mcp_plane_template_governance",
            "errors": errors
        });
    }

    let result = json!({
        "manifest_path": manifest_path.display().to_string(),
        "templates_root": templates_root.display().to_string(),
        "validated_templates": validated,
        "required_mcp_version": required_mcp_version
    });
    let artifact_path = state_root(root)
        .join("template_governance")
        .join("latest.json");
    let _ = write_json(&artifact_path, &result);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "mcp_plane_template_governance",
        "lane": "core/layer0/ops",
        "artifact": {
            "path": artifact_path.display().to_string(),
            "sha256": sha256_hex_str(&result.to_string())
        },
        "result": result,
        "claim_evidence": [
            {
                "id": "V6-MCP-001.5",
                "claim": "signed_mcp_template_library_governance_validates_compatibility_metadata_and_review_cadence",
                "evidence": {
                    "manifest_path": manifest_path.display().to_string(),
                    "validated_templates": validated.len()
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
                "type": "mcp_plane_conduit_gate",
                "errors": ["conduit_bypass_rejected"],
                "conduit_enforcement": conduit
            }),
        );
    }

    let payload = match command.as_str() {
        "status" => status(root),
        "capability-matrix" | "capability_matrix" | "capabilities" => {
            run_capability_matrix(root, &parsed, strict)
        }
        "workflow" | "durable-workflow" | "workflow-runtime" => {
            run_workflow_runtime(root, &parsed, strict)
        }
        "expose" => run_expose(root, &parsed, strict),
        "pattern-pack" | "pattern_pack" => run_pattern_pack(root, &parsed, strict),
        "template-governance" | "template_governance" | "templates" => {
            run_template_governance(root, &parsed, strict)
        }
        _ => json!({
            "ok": false,
            "type": "mcp_plane_error",
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
    fn capability_matrix_requires_caps() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = crate::parse_args(&["capability-matrix".to_string()]);
        let out = run_capability_matrix(root.path(), &parsed, true);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn conduit_rejects_bypass() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed =
            crate::parse_args(&["capability-matrix".to_string(), "--bypass=1".to_string()]);
        let out = conduit_enforcement(root.path(), &parsed, true, "capability-matrix");
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    }
}
