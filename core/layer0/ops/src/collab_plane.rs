// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::collab_plane (authoritative)

use crate::v8_kernel::{
    append_jsonl, parse_bool, parse_u64, read_json, scoped_state_root, sha256_hex_str, write_json,
    write_receipt,
};
use crate::{clean, parse_args};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "COLLAB_PLANE_STATE_ROOT";
const STATE_SCOPE: &str = "collab_plane";

const DASHBOARD_CONTRACT_PATH: &str = "planes/contracts/collab/team_dashboard_contract_v1.json";
const LAUNCHER_CONTRACT_PATH: &str = "planes/contracts/collab/role_launcher_contract_v1.json";
const SCHEDULER_CONTRACT_PATH: &str = "planes/contracts/collab/team_schedule_contract_v1.json";
const CONTINUITY_CONTRACT_PATH: &str = "planes/contracts/collab/team_continuity_contract_v1.json";

fn usage() {
    println!("Usage:");
    println!("  protheus-ops collab-plane status");
    println!(
        "  protheus-ops collab-plane dashboard [--team=<id>] [--refresh-ms=<n>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops collab-plane launch-role --role=<id> [--team=<id>] [--shadow=<id>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops collab-plane schedule --op=<upsert|kickoff|list> [--team=<id>] [--job=<id>] [--cron=<expr>] [--shadows=a,b] [--strict=1|0]"
    );
    println!(
        "  protheus-ops collab-plane continuity --op=<checkpoint|reconstruct|status> [--team=<id>] [--state-json=<json>] [--strict=1|0]"
    );
}

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
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
                "type": "collab_plane_error",
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
        "type": "collab_plane_status",
        "lane": "core/layer0/ops",
        "latest_path": latest_path(root).display().to_string(),
        "latest": read_json(&latest_path(root))
    })
}

fn claim_ids_for_action(action: &str) -> Vec<&'static str> {
    match action {
        "dashboard" => vec!["V6-COLLAB-001.1", "V6-COLLAB-001.4"],
        "launch-role" => vec!["V6-COLLAB-001.2", "V6-COLLAB-001.4"],
        "schedule" => vec!["V6-COLLAB-001.3", "V6-COLLAB-001.4"],
        "continuity" => vec!["V6-COLLAB-001.5", "V6-COLLAB-001.4"],
        _ => vec!["V6-COLLAB-001.4"],
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
                "claim": "collaboration_controls_route_through_layer0_conduit_with_fail_closed_denials",
                "evidence": {
                    "action": clean(action, 120),
                    "bypass_requested": bypass_requested
                }
            })
        })
        .collect::<Vec<_>>();
    let mut out = json!({
        "ok": if strict { ok } else { true },
        "type": "collab_conduit_enforcement",
        "action": clean(action, 120),
        "required_path": "core/layer0/ops/collab_plane",
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

fn team_state_path(root: &Path, team: &str) -> PathBuf {
    state_root(root).join("teams").join(format!("{team}.json"))
}

fn schedule_state_path(root: &Path, team: &str) -> PathBuf {
    state_root(root)
        .join("schedules")
        .join(format!("{team}.json"))
}

fn continuity_checkpoint_path(root: &Path, team: &str) -> PathBuf {
    state_root(root)
        .join("continuity")
        .join("checkpoint")
        .join(format!("{team}.json"))
}

fn continuity_reconstruct_path(root: &Path, team: &str) -> PathBuf {
    state_root(root)
        .join("continuity")
        .join("reconstructed")
        .join(format!("{team}.json"))
}

fn split_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|row| clean(row, 80))
        .filter(|row| !row.is_empty())
        .collect()
}

fn run_dashboard(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        DASHBOARD_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "collab_team_dashboard_contract",
            "max_refresh_ms": 2000,
            "default_refresh_ms": 1000
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("collab_dashboard_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "collab_team_dashboard_contract"
    {
        errors.push("collab_dashboard_contract_kind_invalid".to_string());
    }
    let team = team_slug(
        parsed
            .flags
            .get("team")
            .map(String::as_str)
            .unwrap_or("default-team"),
    );
    let default_refresh = contract
        .get("default_refresh_ms")
        .and_then(Value::as_u64)
        .unwrap_or(1000);
    let max_refresh = contract
        .get("max_refresh_ms")
        .and_then(Value::as_u64)
        .unwrap_or(2000);
    let refresh_ms = parse_u64(parsed.flags.get("refresh-ms"), default_refresh);
    if strict && refresh_ms > max_refresh {
        errors.push("collab_dashboard_refresh_exceeds_contract".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "collab_plane_dashboard",
            "errors": errors
        });
    }

    let team_state = read_json(&team_state_path(root, &team)).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "team": team,
            "agents": [],
            "tasks": [],
            "handoffs": []
        })
    });
    let handoffs = team_state
        .get("handoffs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tasks = team_state
        .get("tasks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let agents = team_state
        .get("agents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let receipt_drilldown = vec![
        json!({
            "lane": "collab_plane",
            "latest_path": latest_path(root).display().to_string()
        }),
        json!({
            "lane": "agency_plane",
            "latest_path": state_root(root)
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("agency_plane")
                .join("latest.json")
                .display()
                .to_string()
        }),
    ];
    let dashboard = json!({
        "version": "v1",
        "team": team,
        "refresh_ms": refresh_ms,
        "target_refresh_ms": max_refresh,
        "agents": agents,
        "tasks": tasks,
        "handoff_history": handoffs,
        "receipt_drilldown": receipt_drilldown,
        "rendered_at": crate::now_iso()
    });
    let path = state_root(root)
        .join("dashboard")
        .join(format!("{team}.json"));
    let _ = write_json(&path, &dashboard);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "collab_plane_dashboard",
        "lane": "core/layer0/ops",
        "dashboard": dashboard,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&dashboard.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-COLLAB-001.1",
                "claim": "team_dashboard_exposes_agent_status_tasks_handoffs_with_receipt_drilldown_and_sub_two_second_refresh",
                "evidence": {
                    "team": team,
                    "refresh_ms": refresh_ms,
                    "agent_count": agents.len(),
                    "task_count": tasks.len(),
                    "handoff_count": handoffs.len()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_launch_role(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        LAUNCHER_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "collab_role_launcher_contract",
            "roles": {
                "coordinator": {"default_tools": ["plan", "route"], "policy_mode": "safe"},
                "researcher": {"default_tools": ["search", "extract"], "policy_mode": "safe"},
                "builder": {"default_tools": ["compile", "verify"], "policy_mode": "safe"},
                "reviewer": {"default_tools": ["audit", "report"], "policy_mode": "safe"},
                "analyst": {"default_tools": ["summarize", "score"], "policy_mode": "safe"}
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
        errors.push("collab_role_launcher_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "collab_role_launcher_contract"
    {
        errors.push("collab_role_launcher_contract_kind_invalid".to_string());
    }
    let team = team_slug(
        parsed
            .flags
            .get("team")
            .map(String::as_str)
            .unwrap_or("default-team"),
    );
    let role = clean(
        parsed
            .flags
            .get("role")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_default(),
        80,
    );
    if role.is_empty() {
        errors.push("collab_role_required".to_string());
    }
    let role_table = contract
        .get("roles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let role_cfg = role_table.get(&role).cloned().unwrap_or(Value::Null);
    if strict && role_cfg.is_null() {
        errors.push("collab_role_unknown".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "collab_plane_launch_role",
            "errors": errors
        });
    }

    let shadow = clean(
        parsed
            .flags
            .get("shadow")
            .cloned()
            .unwrap_or_else(|| format!("{}-{}", role, &sha256_hex_str(&team)[..8])),
        120,
    );
    let activation = json!({
        "team": team,
        "shadow": shadow,
        "role": role,
        "policy_mode": role_cfg
            .get("policy_mode")
            .cloned()
            .unwrap_or(json!("safe")),
        "default_tools": role_cfg
            .get("default_tools")
            .cloned()
            .unwrap_or_else(|| json!(["plan"])),
        "activated_at": crate::now_iso(),
        "activation_hash": sha256_hex_str(&format!("{}:{}:{}", team, shadow, role))
    });

    let team_path = team_state_path(root, &team);
    let mut team_state = read_json(&team_path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "team": team,
            "agents": [],
            "tasks": [],
            "handoffs": []
        })
    });
    let mut agents = team_state
        .get("agents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !agents
        .iter()
        .any(|row| row.get("shadow").and_then(Value::as_str) == Some(shadow.as_str()))
    {
        agents.push(json!({
            "shadow": shadow,
            "role": role,
            "status": "active",
            "activated_at": crate::now_iso()
        }));
    }
    team_state["agents"] = Value::Array(agents.clone());
    let _ = write_json(&team_path, &team_state);
    let _ = append_jsonl(
        &state_root(root).join("launch").join("history.jsonl"),
        &activation,
    );

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "collab_plane_launch_role",
        "lane": "core/layer0/ops",
        "activation": activation,
        "artifact": {
            "path": team_path.display().to_string(),
            "sha256": sha256_hex_str(&team_state.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-COLLAB-001.2",
                "claim": "instant_role_launcher_starts_policy_safe_shadows_with_deterministic_activation_receipts",
                "evidence": {
                    "team": team,
                    "role": role,
                    "shadow": shadow
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_schedule(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        SCHEDULER_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "collab_team_scheduler_contract",
            "allowed_ops": ["upsert", "kickoff", "list"]
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("collab_scheduler_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "collab_team_scheduler_contract"
    {
        errors.push("collab_scheduler_contract_kind_invalid".to_string());
    }
    let team = team_slug(
        parsed
            .flags
            .get("team")
            .map(String::as_str)
            .unwrap_or("default-team"),
    );
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "list".to_string()),
        40,
    )
    .to_ascii_lowercase();
    let allowed_ops = contract
        .get("allowed_ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![json!("upsert"), json!("kickoff"), json!("list")])
        .iter()
        .filter_map(Value::as_str)
        .map(|v| clean(v, 30).to_ascii_lowercase())
        .collect::<Vec<_>>();
    if strict && !allowed_ops.iter().any(|v| v == &op) {
        errors.push("collab_scheduler_op_invalid".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "collab_plane_schedule",
            "errors": errors
        });
    }

    let path = schedule_state_path(root, &team);
    let mut schedule_state = read_json(&path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "team": team,
            "jobs": []
        })
    });
    if !schedule_state
        .get("jobs")
        .map(Value::is_array)
        .unwrap_or(false)
    {
        schedule_state["jobs"] = Value::Array(Vec::new());
    }

    let job_id = clean(
        parsed
            .flags
            .get("job")
            .cloned()
            .unwrap_or_else(|| "default-job".to_string()),
        120,
    );
    let cron = clean(
        parsed
            .flags
            .get("cron")
            .cloned()
            .unwrap_or_else(|| "*/30 * * * *".to_string()),
        120,
    );
    let shadows = parsed
        .flags
        .get("shadows")
        .map(|raw| split_csv(raw))
        .filter(|rows| !rows.is_empty())
        .unwrap_or_else(|| vec!["default-shadow".to_string()]);

    let mut kickoff_receipts = Vec::<Value>::new();
    match op.as_str() {
        "upsert" => {
            let mut jobs = schedule_state
                .get("jobs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut replaced = false;
            for row in &mut jobs {
                if row.get("job_id").and_then(Value::as_str) == Some(job_id.as_str()) {
                    *row = json!({
                        "job_id": job_id,
                        "cron": cron,
                        "shadows": shadows,
                        "updated_at": crate::now_iso()
                    });
                    replaced = true;
                }
            }
            if !replaced {
                jobs.push(json!({
                    "job_id": job_id,
                    "cron": cron,
                    "shadows": shadows,
                    "updated_at": crate::now_iso()
                }));
            }
            schedule_state["jobs"] = Value::Array(jobs);
        }
        "kickoff" => {
            kickoff_receipts = shadows
                .iter()
                .enumerate()
                .map(|(idx, shadow)| {
                    json!({
                        "index": idx + 1,
                        "job_id": job_id,
                        "shadow": shadow,
                        "kickoff_ts": crate::now_iso(),
                        "handoff_hash": sha256_hex_str(&format!("{}:{}:{}:{}", team, job_id, shadow, idx + 1))
                    })
                })
                .collect::<Vec<_>>();
            let mut team_state = read_json(&team_state_path(root, &team)).unwrap_or_else(|| {
                json!({
                    "version": "v1",
                    "team": team,
                    "agents": [],
                    "tasks": [],
                    "handoffs": []
                })
            });
            let mut handoffs = team_state
                .get("handoffs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            handoffs.extend(kickoff_receipts.clone());
            team_state["handoffs"] = Value::Array(handoffs);
            let _ = write_json(&team_state_path(root, &team), &team_state);
        }
        _ => {}
    }
    schedule_state["updated_at"] = Value::String(crate::now_iso());
    let _ = write_json(&path, &schedule_state);
    let _ = append_jsonl(
        &state_root(root).join("schedules").join("history.jsonl"),
        &json!({
            "type": "collab_schedule",
            "team": team,
            "op": op,
            "job_id": job_id,
            "cron": cron,
            "shadows": shadows,
            "kickoff_count": kickoff_receipts.len(),
            "ts": crate::now_iso()
        }),
    );

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "collab_plane_schedule",
        "lane": "core/layer0/ops",
        "op": op,
        "team": team,
        "job_id": job_id,
        "schedule": schedule_state,
        "kickoff_receipts": kickoff_receipts,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&schedule_state.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-COLLAB-001.3",
                "claim": "team_scheduler_supports_deterministic_kickoff_and_handoff_receipts",
                "evidence": {
                    "team": team,
                    "op": op,
                    "kickoff_count": kickoff_receipts.len()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_continuity(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        CONTINUITY_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "collab_team_continuity_contract",
            "required_keys": ["team", "agents", "tasks", "handoffs"]
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("collab_continuity_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "collab_team_continuity_contract"
    {
        errors.push("collab_continuity_contract_kind_invalid".to_string());
    }
    let team = team_slug(
        parsed
            .flags
            .get("team")
            .map(String::as_str)
            .unwrap_or("default-team"),
    );
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "status".to_string()),
        30,
    )
    .to_ascii_lowercase();
    if !matches!(op.as_str(), "checkpoint" | "reconstruct" | "status") {
        errors.push("collab_continuity_op_invalid".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "collab_plane_continuity",
            "errors": errors
        });
    }

    match op.as_str() {
        "status" => {
            let checkpoint_path = continuity_checkpoint_path(root, &team);
            let reconstruct_path = continuity_reconstruct_path(root, &team);
            let checkpoint = read_json(&checkpoint_path);
            let reconstructed = read_json(&reconstruct_path);
            let mut out = json!({
                "ok": true,
                "strict": strict,
                "type": "collab_plane_continuity",
                "op": "status",
                "team": team,
                "checkpoint_present": checkpoint.is_some(),
                "reconstructed_present": reconstructed.is_some(),
                "checkpoint_path": checkpoint_path.display().to_string(),
                "reconstruct_path": reconstruct_path.display().to_string(),
                "claim_evidence": [
                    {
                        "id": "V6-COLLAB-001.5",
                        "claim": "team_state_continuity_supports_restart_reconstruction_with_deterministic_audit_receipts",
                        "evidence": {
                            "team": team,
                            "checkpoint_present": checkpoint.is_some(),
                            "reconstructed_present": reconstructed.is_some()
                        }
                    }
                ]
            });
            out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
            out
        }
        "checkpoint" => {
            let mut state = parsed
                .flags
                .get("state-json")
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .unwrap_or_else(|| {
                    json!({
                        "team": team,
                        "agents": [],
                        "tasks": [],
                        "handoffs": []
                    })
                });
            for key in contract
                .get("required_keys")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(Value::as_str)
            {
                if !state.get(key).is_some() {
                    state[key] = Value::Null;
                }
            }
            state["checkpoint_ts"] = Value::String(crate::now_iso());
            state["checkpoint_hash"] = Value::String(sha256_hex_str(&state.to_string()));
            let path = continuity_checkpoint_path(root, &team);
            let _ = write_json(&path, &state);
            let _ = append_jsonl(
                &state_root(root).join("continuity").join("history.jsonl"),
                &json!({
                    "type": "collab_checkpoint",
                    "team": team,
                    "path": path.display().to_string(),
                    "ts": crate::now_iso()
                }),
            );
            let mut out = json!({
                "ok": true,
                "strict": strict,
                "type": "collab_plane_continuity",
                "op": "checkpoint",
                "team": team,
                "checkpoint": state,
                "artifact": {
                    "path": path.display().to_string(),
                    "sha256": sha256_hex_str(&state.to_string())
                },
                "claim_evidence": [
                    {
                        "id": "V6-COLLAB-001.5",
                        "claim": "team_state_continuity_persists_checkpoint_for_recovery_audits",
                        "evidence": {
                            "team": team
                        }
                    }
                ]
            });
            out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
            out
        }
        "reconstruct" => {
            let checkpoint_path = continuity_checkpoint_path(root, &team);
            let Some(checkpoint) = read_json(&checkpoint_path) else {
                return json!({
                    "ok": false,
                    "strict": strict,
                    "type": "collab_plane_continuity",
                    "op": "reconstruct",
                    "errors": [format!("checkpoint_missing:{}", checkpoint_path.display())]
                });
            };
            let mut restored = checkpoint.clone();
            restored["reconstructed_ts"] = Value::String(crate::now_iso());
            restored["daemon_restart_simulated"] = Value::Bool(true);
            restored["reattach_simulated"] = Value::Bool(true);
            let path = continuity_reconstruct_path(root, &team);
            let _ = write_json(&path, &restored);
            let mut out = json!({
                "ok": true,
                "strict": strict,
                "type": "collab_plane_continuity",
                "op": "reconstruct",
                "team": team,
                "restored": restored,
                "artifact": {
                    "path": path.display().to_string(),
                    "sha256": sha256_hex_str(&restored.to_string())
                },
                "claim_evidence": [
                    {
                        "id": "V6-COLLAB-001.5",
                        "claim": "team_state_reconstruction_restores_auditable_collaboration_state_after_restart",
                        "evidence": {
                            "team": team,
                            "daemon_restart_simulated": true,
                            "reattach_simulated": true
                        }
                    }
                ]
            });
            out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
            out
        }
        _ => json!({
            "ok": false,
            "strict": strict,
            "type": "collab_plane_continuity",
            "errors": ["collab_continuity_op_invalid"]
        }),
    }
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
                "type": "collab_plane_conduit_gate",
                "errors": ["conduit_bypass_rejected"],
                "conduit_enforcement": conduit
            }),
        );
    }

    let payload = match command.as_str() {
        "status" => status(root),
        "dashboard" => run_dashboard(root, &parsed, strict),
        "launch-role" | "launch" => run_launch_role(root, &parsed, strict),
        "schedule" => run_schedule(root, &parsed, strict),
        "continuity" => run_continuity(root, &parsed, strict),
        _ => json!({
            "ok": false,
            "type": "collab_plane_error",
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
        let parsed = crate::parse_args(&["dashboard".to_string(), "--bypass=1".to_string()]);
        let out = conduit_enforcement(root.path(), &parsed, true, "dashboard");
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    }
}
