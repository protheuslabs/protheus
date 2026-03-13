// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::company_plane (authoritative)

use crate::v8_kernel::{
    append_jsonl, parse_bool, parse_u64, read_json, scoped_state_root, sha256_hex_str, write_json,
    write_receipt,
};
use crate::{clean, parse_args};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "COMPANY_PLANE_STATE_ROOT";
const STATE_SCOPE: &str = "company_plane";

const ORG_CONTRACT_PATH: &str = "planes/contracts/company/org_hierarchy_contract_v1.json";
const BUDGET_CONTRACT_PATH: &str = "planes/contracts/company/per_agent_budget_contract_v1.json";
const TICKET_CONTRACT_PATH: &str = "planes/contracts/company/ticket_audit_contract_v1.json";
const HEARTBEAT_CONTRACT_PATH: &str = "planes/contracts/company/team_heartbeat_contract_v1.json";

fn usage() {
    println!("Usage:");
    println!("  protheus-ops company-plane status");
    println!(
        "  protheus-ops company-plane orchestrate-agency --team=<id> [--org-json=<json>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops company-plane budget-enforce --agent=<id> [--period=daily|weekly] [--tokens=<n>] [--cost-usd=<n>] [--compute-ms=<n>] [--privacy-units=<n>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops company-plane ticket --op=<create|assign|transition|handoff|close|status> [--team=<id>] [--ticket-id=<id>] [--title=<text>] [--state=<id>] [--assignee=<id>] [--from=<id>] [--to=<id>] [--tool-call-id=<id>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops company-plane heartbeat --op=<tick|status|remote-feed> [--team=<id>] [--status=<healthy|degraded|critical>] [--agents-online=<n>] [--queue-depth=<n>] [--strict=1|0]"
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
                "type": "company_plane_error",
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
        "type": "company_plane_status",
        "lane": "core/layer0/ops",
        "latest_path": latest_path(root).display().to_string(),
        "latest": read_json(&latest_path(root))
    })
}

fn claim_ids_for_action(action: &str) -> Vec<&'static str> {
    match action {
        "orchestrate-agency" => vec!["V6-COMPANY-001.1", "V6-COMPANY-001.5"],
        "budget-enforce" => vec!["V6-COMPANY-001.2", "V6-COMPANY-001.5"],
        "ticket" => vec!["V6-COMPANY-001.3", "V6-COMPANY-001.5"],
        "heartbeat" => vec!["V6-COMPANY-001.4", "V6-COMPANY-001.5"],
        _ => vec!["V6-COMPANY-001.2"],
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
                "claim": "company_control_paths_are_conduit_routed_with_fail_closed_receipts",
                "evidence": {
                    "action": clean(action, 120),
                    "bypass_requested": bypass_requested
                }
            })
        })
        .collect::<Vec<_>>();
    let mut out = json!({
        "ok": if strict { ok } else { true },
        "type": "company_conduit_enforcement",
        "action": clean(action, 120),
        "required_path": "core/layer0/ops/company_plane",
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

fn team_slug(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        if out.len() >= 80 {
            break;
        }
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "default-team".to_string()
    } else {
        trimmed.to_string()
    }
}

fn run_orchestrate_agency(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        ORG_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "company_org_hierarchy_contract",
            "required_fields": ["org_chart", "reporting_edges", "titles", "team_goals"],
            "default_org_chart": ["head", "lead", "member"]
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("company_org_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "company_org_hierarchy_contract"
    {
        errors.push("company_org_contract_kind_invalid".to_string());
    }
    let team = team_slug(
        parsed
            .flags
            .get("team")
            .map(String::as_str)
            .or_else(|| parsed.positional.get(1).map(String::as_str))
            .unwrap_or("default-team"),
    );
    let hierarchy = parsed
        .flags
        .get("org-json")
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or_else(|| {
            json!({
                "org_chart": contract
                    .get("default_org_chart")
                    .cloned()
                    .unwrap_or_else(|| json!(["head", "lead", "member"])),
                "reporting_edges": [
                    {"from": "head", "to": "lead"},
                    {"from": "lead", "to": "member"}
                ],
                "titles": {
                    "head": "Team Head",
                    "lead": "Team Lead",
                    "member": "Specialist"
                },
                "team_goals": [
                    "ship weekly quality improvements",
                    "keep safety gates green"
                ]
            })
        });
    for key in contract
        .get("required_fields")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
    {
        if strict && !hierarchy.get(key).is_some() {
            errors.push(format!("company_org_missing_field::{key}"));
        }
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "company_plane_orchestrate_agency",
            "errors": errors
        });
    }

    let artifact = json!({
        "version": "v1",
        "team": team,
        "instantiated_at": crate::now_iso(),
        "hierarchy": hierarchy,
        "command_alias": format!("protheus orchestrate agency {}", team)
    });
    let path = state_root(root).join("org").join(format!("{team}.json"));
    let _ = write_json(&path, &artifact);
    let _ = append_jsonl(
        &state_root(root).join("org").join("history.jsonl"),
        &artifact,
    );

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "company_plane_orchestrate_agency",
        "lane": "core/layer0/ops",
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&artifact.to_string())
        },
        "hierarchy": artifact,
        "claim_evidence": [
            {
                "id": "V6-COMPANY-001.1",
                "claim": "company_layer_instantiates_org_chart_reporting_edges_titles_and_team_goals",
                "evidence": {
                    "team": team,
                    "reporting_edges": artifact
                        .get("hierarchy")
                        .and_then(|v| v.get("reporting_edges"))
                        .and_then(Value::as_array)
                        .map(|rows| rows.len())
                        .unwrap_or(0)
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn budget_bucket(period: &str) -> String {
    let now = crate::now_iso();
    let date = now.get(0..10).unwrap_or("1970-01-01");
    if period == "weekly" {
        let year = date.get(0..4).unwrap_or("1970");
        let month = date.get(5..7).unwrap_or("01");
        let day = date
            .get(8..10)
            .and_then(|d| d.parse::<u32>().ok())
            .unwrap_or(1);
        let week = ((day.saturating_sub(1)) / 7) + 1;
        format!("{year}-{month}-W{week}")
    } else {
        date.to_string()
    }
}

fn parse_f64(raw: Option<&String>, fallback: f64) -> f64 {
    raw.and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(fallback)
}

fn ticket_state_path(root: &Path, team: &str) -> PathBuf {
    state_root(root)
        .join("tickets")
        .join(format!("{team}.json"))
}

fn ticket_history_path(root: &Path, team: &str) -> PathBuf {
    state_root(root)
        .join("tickets")
        .join("history")
        .join(format!("{team}.jsonl"))
}

fn heartbeat_state_path(root: &Path, team: &str) -> PathBuf {
    state_root(root)
        .join("heartbeat")
        .join("teams")
        .join(format!("{team}.json"))
}

fn heartbeat_remote_feed_path(root: &Path) -> PathBuf {
    state_root(root).join("heartbeat").join("remote_feed.json")
}

fn ensure_ticket_ledger_shape(v: &mut Value) {
    if !v.is_object() {
        *v = json!({
            "version": "v1",
            "teams": {}
        });
    }
    if !v.get("teams").map(Value::is_object).unwrap_or(false) {
        v["teams"] = Value::Object(serde_json::Map::new());
    }
}

fn read_json_lines(path: &Path) -> Vec<Value> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn ticket_event_hash(row: &Value) -> Option<String> {
    let mut canonical = row.clone();
    let obj = canonical.as_object_mut()?;
    obj.remove("event_hash");
    Some(sha256_hex_str(&canonical.to_string()))
}

fn validate_ticket_history_rows(history_rows: &[Value]) -> (bool, Vec<String>) {
    let mut issues = Vec::<String>::new();
    let mut previous_event_hash = "genesis".to_string();
    for (idx, row) in history_rows.iter().enumerate() {
        let stored_hash = row.get("event_hash").and_then(Value::as_str).unwrap_or("");
        if stored_hash.is_empty() {
            issues.push(format!("missing_event_hash_row_{idx}"));
            continue;
        }
        let recomputed = ticket_event_hash(row).unwrap_or_default();
        if recomputed != stored_hash {
            issues.push(format!("event_hash_mismatch_row_{idx}"));
        }
        let claimed_prev = row
            .get("prev_event_hash")
            .and_then(Value::as_str)
            .unwrap_or("");
        if claimed_prev != previous_event_hash {
            issues.push(format!("prev_hash_mismatch_row_{idx}"));
        }
        previous_event_hash = stored_hash.to_string();
    }
    (issues.is_empty(), issues)
}

fn run_budget_enforce(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        BUDGET_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "company_per_agent_budget_contract",
            "period_limits": {
                "daily": {"tokens": 200000, "cost_usd": 25.0, "compute_ms": 120000, "privacy_units": 1000},
                "weekly": {"tokens": 900000, "cost_usd": 100.0, "compute_ms": 500000, "privacy_units": 5000}
            }
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("company_budget_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "company_per_agent_budget_contract"
    {
        errors.push("company_budget_contract_kind_invalid".to_string());
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
        errors.push("company_budget_agent_required".to_string());
    }
    let period = clean(
        parsed
            .flags
            .get("period")
            .cloned()
            .unwrap_or_else(|| "daily".to_string()),
        20,
    )
    .to_ascii_lowercase();
    if strict && period != "daily" && period != "weekly" {
        errors.push("company_budget_period_invalid".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "company_plane_budget_enforce",
            "errors": errors
        });
    }

    let tokens = parse_u64(parsed.flags.get("tokens"), 0);
    let compute_ms = parse_u64(parsed.flags.get("compute-ms"), 0);
    let privacy_units = parse_u64(parsed.flags.get("privacy-units"), 0);
    let cost_usd = parse_f64(parsed.flags.get("cost-usd"), 0.0);
    let bucket = budget_bucket(&period);
    let period_limits = contract
        .get("period_limits")
        .and_then(|v| v.get(&period))
        .cloned()
        .unwrap_or_else(|| json!({}));

    let limits = json!({
        "tokens": period_limits.get("tokens").and_then(Value::as_u64).unwrap_or(0),
        "cost_usd": period_limits.get("cost_usd").and_then(Value::as_f64).unwrap_or(0.0),
        "compute_ms": period_limits.get("compute_ms").and_then(Value::as_u64).unwrap_or(0),
        "privacy_units": period_limits.get("privacy_units").and_then(Value::as_u64).unwrap_or(0)
    });

    let ledger_path = state_root(root).join("budgets").join("ledger.json");
    let mut ledger = read_json(&ledger_path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "agents": {}
        })
    });
    if !ledger.get("agents").map(Value::is_object).unwrap_or(false) {
        ledger["agents"] = Value::Object(serde_json::Map::new());
    }
    if !ledger["agents"].get(&agent).is_some() {
        ledger["agents"][&agent] = json!({});
    }
    if !ledger["agents"][&agent].get(&period).is_some() {
        ledger["agents"][&agent][&period] = json!({});
    }
    if !ledger["agents"][&agent][&period].get(&bucket).is_some() {
        ledger["agents"][&agent][&period][&bucket] = json!({
            "tokens": 0,
            "cost_usd": 0.0,
            "compute_ms": 0,
            "privacy_units": 0
        });
    }

    let current = ledger["agents"][&agent][&period][&bucket].clone();
    let projected = json!({
        "tokens": current.get("tokens").and_then(Value::as_u64).unwrap_or(0).saturating_add(tokens),
        "cost_usd": current.get("cost_usd").and_then(Value::as_f64).unwrap_or(0.0) + cost_usd,
        "compute_ms": current.get("compute_ms").and_then(Value::as_u64).unwrap_or(0).saturating_add(compute_ms),
        "privacy_units": current.get("privacy_units").and_then(Value::as_u64).unwrap_or(0).saturating_add(privacy_units)
    });

    let mut reason_codes = Vec::<String>::new();
    if projected.get("tokens").and_then(Value::as_u64).unwrap_or(0)
        > limits.get("tokens").and_then(Value::as_u64).unwrap_or(0)
    {
        reason_codes.push("tokens_budget_exceeded".to_string());
    }
    if projected
        .get("cost_usd")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        > limits
            .get("cost_usd")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    {
        reason_codes.push("cost_budget_exceeded".to_string());
    }
    if projected
        .get("compute_ms")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > limits
            .get("compute_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    {
        reason_codes.push("compute_budget_exceeded".to_string());
    }
    if projected
        .get("privacy_units")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > limits
            .get("privacy_units")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    {
        reason_codes.push("privacy_budget_exceeded".to_string());
    }
    let hard_stop = strict && !reason_codes.is_empty();
    if !hard_stop {
        ledger["agents"][&agent][&period][&bucket] = projected.clone();
        ledger["updated_at"] = Value::String(crate::now_iso());
        let _ = write_json(&ledger_path, &ledger);
    }
    let receipt = json!({
        "version": "v1",
        "agent": agent,
        "period": period,
        "bucket": bucket,
        "requested_delta": {
            "tokens": tokens,
            "cost_usd": cost_usd,
            "compute_ms": compute_ms,
            "privacy_units": privacy_units
        },
        "projected_usage": projected,
        "limits": limits,
        "hard_stop": hard_stop,
        "reason_codes": reason_codes,
        "ts": crate::now_iso()
    });
    let _ = append_jsonl(
        &state_root(root).join("budgets").join("history.jsonl"),
        &receipt,
    );

    let mut out = json!({
        "ok": !hard_stop,
        "strict": strict,
        "type": "company_plane_budget_enforce",
        "lane": "core/layer0/ops",
        "decision": receipt,
        "artifact": {
            "path": ledger_path.display().to_string(),
            "sha256": sha256_hex_str(&ledger.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-COMPANY-001.2",
                "claim": "per_agent_period_budget_enforcement_is_policy_backed_and_fail_closed_on_breaches",
                "evidence": {
                    "agent": agent,
                    "period": period,
                    "hard_stop": hard_stop
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_ticket(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        TICKET_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "company_ticket_audit_contract",
            "allowed_ops": ["create", "assign", "transition", "handoff", "close", "status"],
            "require_tool_call_trace_link": true
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("company_ticket_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "company_ticket_audit_contract"
    {
        errors.push("company_ticket_contract_kind_invalid".to_string());
    }

    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "status".to_string()),
        40,
    )
    .to_ascii_lowercase();
    let allowed = contract
        .get("allowed_ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .any(|v| v == op);
    if strict && !allowed {
        errors.push("company_ticket_op_invalid".to_string());
    }

    let team = team_slug(
        parsed
            .flags
            .get("team")
            .map(String::as_str)
            .unwrap_or("default-team"),
    );
    let mut ledger = read_json(&ticket_state_path(root, &team)).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "teams": {}
        })
    });
    ensure_ticket_ledger_shape(&mut ledger);
    if !ledger["teams"].get(&team).is_some() {
        ledger["teams"][&team] = json!({
            "tickets": {},
            "updated_at": crate::now_iso()
        });
    }
    if !ledger["teams"][&team]
        .get("tickets")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        ledger["teams"][&team]["tickets"] = Value::Object(serde_json::Map::new());
    }
    let tickets_obj = ledger["teams"][&team]["tickets"]
        .as_object()
        .cloned()
        .unwrap_or_default();

    let ticket_id = clean(
        parsed
            .flags
            .get("ticket-id")
            .cloned()
            .or_else(|| parsed.flags.get("id").cloned())
            .or_else(|| parsed.positional.get(2).cloned())
            .unwrap_or_default(),
        80,
    );
    if strict && op != "create" && op != "status" && ticket_id.is_empty() {
        errors.push("company_ticket_id_required".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "company_plane_ticket",
            "errors": errors
        });
    }

    if op == "status" {
        let ticket = if ticket_id.is_empty() {
            Value::Null
        } else {
            tickets_obj.get(&ticket_id).cloned().unwrap_or(Value::Null)
        };
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "company_plane_ticket",
            "lane": "core/layer0/ops",
            "team": team,
            "op": op,
            "ticket_id": if ticket_id.is_empty() { Value::Null } else { Value::String(ticket_id) },
            "ticket": ticket,
            "claim_evidence": [
                {
                    "id": "V6-COMPANY-001.3",
                    "claim": "ticket_status_returns_receipted_task_chain_state",
                    "evidence": {
                        "team": team
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    let existing = if ticket_id.is_empty() {
        Value::Null
    } else {
        tickets_obj.get(&ticket_id).cloned().unwrap_or(Value::Null)
    };
    let existing_state = existing
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("open")
        .to_string();
    let existing_assignee = existing
        .get("assignee")
        .and_then(Value::as_str)
        .unwrap_or("unassigned")
        .to_string();

    let require_trace = contract
        .get("require_tool_call_trace_link")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let tool_call_id = clean(
        parsed
            .flags
            .get("tool-call-id")
            .cloned()
            .or_else(|| parsed.flags.get("trace-id").cloned())
            .unwrap_or_else(|| {
                format!("tool_{}", &sha256_hex_str(&format!("{}:{op}", team))[..10])
            }),
        120,
    );
    if strict && require_trace && tool_call_id.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "company_plane_ticket",
            "errors": ["company_ticket_tool_call_trace_required"]
        });
    }

    let resolved_ticket_id = if op == "create" {
        if !ticket_id.is_empty() {
            ticket_id.clone()
        } else {
            format!(
                "TKT-{}",
                &sha256_hex_str(&format!("{}:{}", team, crate::now_iso()))[..12]
            )
        }
    } else {
        ticket_id.clone()
    };
    if strict && op == "create" && tickets_obj.contains_key(&resolved_ticket_id) {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "company_plane_ticket",
            "errors": ["company_ticket_already_exists"]
        });
    }
    if strict && op != "create" && !tickets_obj.contains_key(&resolved_ticket_id) {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "company_plane_ticket",
            "errors": ["company_ticket_not_found"]
        });
    }

    let mut ticket = existing
        .as_object()
        .cloned()
        .map(Value::Object)
        .unwrap_or_else(|| {
            json!({
                "ticket_id": resolved_ticket_id,
                "team": team,
                "title": clean(parsed.flags.get("title").cloned().unwrap_or_else(|| "Untitled Ticket".to_string()), 200),
                "state": "open",
                "assignee": parsed.flags.get("assignee").cloned().unwrap_or_else(|| "unassigned".to_string()),
                "created_at": crate::now_iso(),
                "updated_at": crate::now_iso(),
                "trace_chain_length": 0u64,
                "last_event_hash": "genesis"
            })
        });

    let mut event_details = json!({});
    match op.as_str() {
        "create" => {
            ticket["title"] = Value::String(clean(
                parsed
                    .flags
                    .get("title")
                    .cloned()
                    .unwrap_or_else(|| "Untitled Ticket".to_string()),
                200,
            ));
            if let Some(assignee) = parsed.flags.get("assignee") {
                ticket["assignee"] = Value::String(clean(assignee, 120));
            }
            ticket["state"] = Value::String("open".to_string());
            ticket["created_at"] = Value::String(crate::now_iso());
            event_details = json!({
                "title": ticket.get("title").cloned().unwrap_or(Value::Null),
                "initial_assignee": ticket.get("assignee").cloned().unwrap_or(Value::Null)
            });
        }
        "assign" => {
            let assignee = clean(
                parsed
                    .flags
                    .get("assignee")
                    .cloned()
                    .or_else(|| parsed.flags.get("to").cloned())
                    .unwrap_or_else(|| existing_assignee.clone()),
                120,
            );
            ticket["assignee"] = Value::String(assignee.clone());
            event_details = json!({
                "from_assignee": existing_assignee,
                "to_assignee": assignee
            });
        }
        "transition" => {
            let to_state = clean(
                parsed
                    .flags
                    .get("to")
                    .cloned()
                    .or_else(|| parsed.flags.get("state").cloned())
                    .unwrap_or_else(|| existing_state.clone()),
                80,
            );
            ticket["state"] = Value::String(to_state.clone());
            event_details = json!({
                "from_state": existing_state,
                "to_state": to_state
            });
        }
        "handoff" => {
            let from_assignee = clean(
                parsed
                    .flags
                    .get("from")
                    .cloned()
                    .unwrap_or_else(|| existing_assignee.clone()),
                120,
            );
            let to_assignee = clean(
                parsed
                    .flags
                    .get("to")
                    .cloned()
                    .or_else(|| parsed.flags.get("assignee").cloned())
                    .unwrap_or_else(|| existing_assignee.clone()),
                120,
            );
            ticket["assignee"] = Value::String(to_assignee.clone());
            event_details = json!({
                "from_assignee": from_assignee,
                "to_assignee": to_assignee
            });
        }
        "close" => {
            ticket["state"] = Value::String("closed".to_string());
            ticket["closed_at"] = Value::String(crate::now_iso());
            event_details = json!({
                "from_state": existing_state,
                "to_state": "closed"
            });
        }
        _ => {
            return json!({
                "ok": false,
                "strict": strict,
                "type": "company_plane_ticket",
                "errors": ["company_ticket_op_invalid"]
            });
        }
    }

    let prev_hash = ticket
        .get("last_event_hash")
        .and_then(Value::as_str)
        .unwrap_or("genesis")
        .to_string();
    let mut event = json!({
        "version": "v1",
        "team": team,
        "ticket_id": resolved_ticket_id,
        "op": op,
        "tool_call_id": tool_call_id,
        "prev_event_hash": prev_hash,
        "ts": crate::now_iso(),
        "details": event_details
    });
    let event_hash = sha256_hex_str(&event.to_string());
    event["event_hash"] = Value::String(event_hash.clone());
    let event_path = ticket_history_path(root, &team);
    let _ = append_jsonl(&event_path, &event);
    let history_rows = read_json_lines(&event_path)
        .into_iter()
        .filter(|row| row.get("ticket_id").and_then(Value::as_str) == Some(&resolved_ticket_id))
        .collect::<Vec<_>>();
    let (chain_valid, chain_issues) = validate_ticket_history_rows(&history_rows);
    if strict && !chain_valid {
        return json!({
            "ok": false,
            "strict": true,
            "type": "company_plane_ticket",
            "errors": ["company_ticket_chain_validation_failed"],
            "chain_issues": chain_issues
        });
    }

    let chain_len = ticket
        .get("trace_chain_length")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_add(1);
    ticket["trace_chain_length"] = Value::Number(serde_json::Number::from(chain_len));
    ticket["last_event_hash"] = Value::String(event_hash.clone());
    ticket["updated_at"] = Value::String(crate::now_iso());

    ledger["teams"][&team]["tickets"][&resolved_ticket_id] = ticket.clone();
    ledger["teams"][&team]["updated_at"] = Value::String(crate::now_iso());
    let ledger_path = ticket_state_path(root, &team);
    let _ = write_json(&ledger_path, &ledger);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "company_plane_ticket",
        "lane": "core/layer0/ops",
        "team": team,
        "op": op,
        "ticket_id": resolved_ticket_id,
        "ticket": ticket,
        "audit_event": event,
        "artifact": {
            "ledger_path": ledger_path.display().to_string(),
            "history_path": event_path.display().to_string(),
            "ledger_sha256": sha256_hex_str(&ledger.to_string()),
            "event_sha256": event_hash,
            "chain_valid": chain_valid,
            "chain_issues": chain_issues
        },
        "claim_evidence": [
            {
                "id": "V6-COMPANY-001.3",
                "claim": "ticket_lifecycle_ops_emit_immutable_audit_chain_with_tool_trace_linkage",
                "evidence": {
                    "team": team,
                    "ticket_id": resolved_ticket_id,
                    "chain_length": chain_len,
                    "chain_valid": chain_valid
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_heartbeat(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        HEARTBEAT_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "company_team_heartbeat_contract",
            "default_interval_seconds": 300,
            "max_queue_depth_warn": 50,
            "status_levels": ["healthy", "degraded", "critical"]
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("company_heartbeat_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "company_team_heartbeat_contract"
    {
        errors.push("company_heartbeat_contract_kind_invalid".to_string());
    }
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "tick".to_string()),
        30,
    )
    .to_ascii_lowercase();
    if strict && !matches!(op.as_str(), "tick" | "status" | "remote-feed") {
        errors.push("company_heartbeat_op_invalid".to_string());
    }
    let team = team_slug(
        parsed
            .flags
            .get("team")
            .map(String::as_str)
            .unwrap_or("default-team"),
    );
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "company_plane_heartbeat",
            "errors": errors
        });
    }

    let state_path = heartbeat_state_path(root, &team);
    let mut state = read_json(&state_path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "team": team,
            "sequence": 0u64,
            "status": "healthy",
            "agents_online": 0u64,
            "queue_depth": 0u64,
            "last_beat_ts": Value::Null
        })
    });
    if !state.is_object() {
        state = json!({});
    }
    let mut remote_feed = read_json(&heartbeat_remote_feed_path(root)).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "teams": {},
            "updated_at": Value::Null
        })
    });
    if !remote_feed
        .get("teams")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        remote_feed["teams"] = Value::Object(serde_json::Map::new());
    }

    if op == "status" {
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "company_plane_heartbeat",
            "lane": "core/layer0/ops",
            "team": team,
            "op": op,
            "state": state,
            "remote_feed_path": heartbeat_remote_feed_path(root).display().to_string(),
            "claim_evidence": [
                {
                    "id": "V6-COMPANY-001.4",
                    "claim": "team_heartbeat_status_surfaces_always_on_monitoring_state",
                    "evidence": {
                        "team": team
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    if op == "remote-feed" {
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "company_plane_heartbeat",
            "lane": "core/layer0/ops",
            "team": team,
            "op": op,
            "remote_feed": remote_feed,
            "artifact": {
                "path": heartbeat_remote_feed_path(root).display().to_string()
            },
            "claim_evidence": [
                {
                    "id": "V6-COMPANY-001.4",
                    "claim": "remote_mobile_safe_team_heartbeat_feed_is_available",
                    "evidence": {
                        "team_count": remote_feed
                            .get("teams")
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

    let sequence = state
        .get("sequence")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_add(1);
    let status = clean(
        parsed
            .flags
            .get("status")
            .cloned()
            .unwrap_or_else(|| "healthy".to_string()),
        20,
    )
    .to_ascii_lowercase();
    let status_allowed = contract
        .get("status_levels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .any(|s| s == status);
    if strict && !status_allowed {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "company_plane_heartbeat",
            "errors": ["company_heartbeat_status_invalid"]
        });
    }
    let agents_online = parse_u64(parsed.flags.get("agents-online"), 0);
    let queue_depth = parse_u64(parsed.flags.get("queue-depth"), 0);
    let warn_queue = contract
        .get("max_queue_depth_warn")
        .and_then(Value::as_u64)
        .unwrap_or(50);
    let degraded = status == "degraded" || status == "critical" || queue_depth > warn_queue;

    state["version"] = Value::String("v1".to_string());
    state["team"] = Value::String(team.clone());
    state["sequence"] = Value::Number(serde_json::Number::from(sequence));
    state["status"] = Value::String(status.clone());
    state["agents_online"] = Value::Number(serde_json::Number::from(agents_online));
    state["queue_depth"] = Value::Number(serde_json::Number::from(queue_depth));
    state["degraded"] = Value::Bool(degraded);
    state["interval_seconds"] = Value::Number(serde_json::Number::from(
        contract
            .get("default_interval_seconds")
            .and_then(Value::as_u64)
            .unwrap_or(300),
    ));
    state["last_beat_ts"] = Value::String(crate::now_iso());
    let _ = write_json(&state_path, &state);

    remote_feed["version"] = Value::String("v1".to_string());
    remote_feed["teams"][&team] = json!({
        "status": status,
        "agents_online": agents_online,
        "queue_depth": queue_depth,
        "degraded": degraded,
        "sequence": sequence,
        "last_beat_ts": state.get("last_beat_ts").cloned().unwrap_or(Value::Null)
    });
    remote_feed["updated_at"] = Value::String(crate::now_iso());
    let feed_path = heartbeat_remote_feed_path(root);
    let _ = write_json(&feed_path, &remote_feed);

    let receipt = json!({
        "version": "v1",
        "team": team,
        "sequence": sequence,
        "status": status,
        "agents_online": agents_online,
        "queue_depth": queue_depth,
        "degraded": degraded,
        "ts": crate::now_iso()
    });
    let _ = append_jsonl(
        &state_root(root).join("heartbeat").join("history.jsonl"),
        &receipt,
    );

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "company_plane_heartbeat",
        "lane": "core/layer0/ops",
        "team": team,
        "op": op,
        "heartbeat": receipt,
        "artifact": {
            "state_path": state_path.display().to_string(),
            "remote_feed_path": feed_path.display().to_string(),
            "state_sha256": sha256_hex_str(&state.to_string()),
            "feed_sha256": sha256_hex_str(&remote_feed.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-COMPANY-001.4",
                "claim": "team_heartbeat_scheduler_emits_deterministic_receipts_and_remote_monitor_feed",
                "evidence": {
                    "team": team,
                    "sequence": sequence,
                    "degraded": degraded
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
                "type": "company_plane_conduit_gate",
                "errors": ["conduit_bypass_rejected"],
                "conduit_enforcement": conduit
            }),
        );
    }

    let payload = match command.as_str() {
        "status" => status(root),
        "orchestrate-agency" | "orchestrate" => run_orchestrate_agency(root, &parsed, strict),
        "budget-enforce" | "budget" => run_budget_enforce(root, &parsed, strict),
        "ticket" => run_ticket(root, &parsed, strict),
        "heartbeat" => run_heartbeat(root, &parsed, strict),
        _ => json!({
            "ok": false,
            "type": "company_plane_error",
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
        let parsed = crate::parse_args(&["orchestrate".to_string(), "--bypass=1".to_string()]);
        let out = conduit_enforcement(root.path(), &parsed, true, "orchestrate-agency");
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    }
}
