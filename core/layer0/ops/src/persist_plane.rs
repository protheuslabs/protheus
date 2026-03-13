// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::persist_plane (authoritative)

use crate::v8_kernel::{
    append_jsonl, parse_bool, read_json, scoped_state_root, sha256_hex_str, write_json,
    write_receipt,
};
use crate::{clean, parse_args};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "PERSIST_PLANE_STATE_ROOT";
const STATE_SCOPE: &str = "persist_plane";

const SCHEDULE_CONTRACT_PATH: &str = "planes/contracts/persist/schedule_contract_v1.json";
const MOBILE_CONTRACT_PATH: &str = "planes/contracts/persist/mobile_cockpit_contract_v1.json";

fn usage() {
    println!("Usage:");
    println!("  protheus-ops persist-plane status");
    println!(
        "  protheus-ops persist-plane schedule --op=<upsert|list|kickoff> [--job=<id>] [--cron=<expr>] [--workflow=<id>] [--owner=<id>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops persist-plane mobile-cockpit --op=<publish|status|intervene> [--session-id=<id>] [--device=<id>] [--action=<pause|resume|abort>] [--strict=1|0]"
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
                "type": "persist_plane_error",
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
        "type": "persist_plane_status",
        "lane": "core/layer0/ops",
        "latest_path": latest_path(root).display().to_string(),
        "latest": read_json(&latest_path(root))
    })
}

fn claim_ids_for_action(action: &str) -> Vec<&'static str> {
    match action {
        "schedule" => vec!["V6-PERSIST-001.1"],
        "mobile-cockpit" => vec!["V6-PERSIST-001.2", "V6-PERSIST-001.1"],
        _ => vec!["V6-PERSIST-001.1"],
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
                "claim": "persist_controls_route_through_layer0_conduit_with_fail_closed_denials",
                "evidence": {
                    "action": clean(action, 120),
                    "bypass_requested": bypass_requested
                }
            })
        })
        .collect::<Vec<_>>();
    let mut out = json!({
        "ok": if strict { ok } else { true },
        "type": "persist_conduit_enforcement",
        "action": clean(action, 120),
        "required_path": "core/layer0/ops/persist_plane",
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

fn schedules_path(root: &Path) -> PathBuf {
    state_root(root).join("schedules").join("registry.json")
}

fn mobile_path(root: &Path) -> PathBuf {
    state_root(root).join("mobile").join("latest.json")
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

fn run_schedule(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        SCHEDULE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "persist_schedule_contract",
            "allowed_ops": ["upsert", "list", "kickoff"]
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
            "type": "persist_plane_schedule",
            "errors": ["persist_schedule_op_invalid"]
        });
    }

    let path = schedules_path(root);
    let mut state = read_json(&path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "jobs": {},
            "runs": []
        })
    });
    if !state.get("jobs").map(Value::is_object).unwrap_or(false) {
        state["jobs"] = Value::Object(serde_json::Map::new());
    }
    if !state.get("runs").map(Value::is_array).unwrap_or(false) {
        state["runs"] = Value::Array(Vec::new());
    }

    if op == "list" {
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "persist_plane_schedule",
            "lane": "core/layer0/ops",
            "op": "list",
            "state": state,
            "claim_evidence": [
                {
                    "id": "V6-PERSIST-001.1",
                    "claim": "scheduled_background_task_lane_surfaces_registered_jobs",
                    "evidence": {
                        "job_count": state
                            .get("jobs")
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

    let job_id = clean_id(
        parsed
            .flags
            .get("job")
            .map(String::as_str)
            .or_else(|| parsed.flags.get("job-id").map(String::as_str)),
        "default-job",
    );
    if op == "upsert" {
        let cron = clean(
            parsed
                .flags
                .get("cron")
                .cloned()
                .unwrap_or_else(|| "*/5 * * * *".to_string()),
            160,
        );
        let workflow = clean(
            parsed
                .flags
                .get("workflow")
                .cloned()
                .unwrap_or_else(|| "default-workflow".to_string()),
            120,
        );
        let owner = clean(
            parsed
                .flags
                .get("owner")
                .cloned()
                .unwrap_or_else(|| "system".to_string()),
            120,
        );
        let job = json!({
            "job_id": job_id,
            "cron": cron,
            "workflow": workflow,
            "owner": owner,
            "updated_at": crate::now_iso()
        });
        state["jobs"][&job_id] = job.clone();
        state["updated_at"] = Value::String(crate::now_iso());
        let _ = write_json(&path, &state);
        let _ = append_jsonl(
            &state_root(root).join("schedules").join("history.jsonl"),
            &json!({"op":"upsert","job_id":job_id,"ts":crate::now_iso()}),
        );
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "persist_plane_schedule",
            "lane": "core/layer0/ops",
            "op": "upsert",
            "job": job,
            "artifact": {
                "path": path.display().to_string(),
                "sha256": sha256_hex_str(&state.to_string())
            },
            "claim_evidence": [
                {
                    "id": "V6-PERSIST-001.1",
                    "claim": "schedule_contract_supports_receipted_recurring_background_workflows",
                    "evidence": {
                        "job_id": job_id
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    if strict && state["jobs"].get(&job_id).is_none() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "persist_plane_schedule",
            "errors": ["persist_schedule_job_not_found"]
        });
    }
    let run_id = format!(
        "kickoff_{}",
        &sha256_hex_str(&format!("{job_id}:{}", crate::now_iso()))[..10]
    );
    let run = json!({
        "run_id": run_id,
        "job_id": job_id,
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
        &state_root(root).join("schedules").join("history.jsonl"),
        &json!({"op":"kickoff","run":run,"ts":crate::now_iso()}),
    );
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "persist_plane_schedule",
        "lane": "core/layer0/ops",
        "op": "kickoff",
        "run": run,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&state.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-PERSIST-001.1",
                "claim": "scheduled_background_runtime_kickoff_is_receipted",
                "evidence": {
                    "run_id": run_id
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_mobile_cockpit(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        MOBILE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "persist_mobile_cockpit_contract",
            "allowed_ops": ["publish", "status", "intervene"],
            "allowed_actions": ["pause", "resume", "abort"]
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
            "type": "persist_plane_mobile_cockpit",
            "errors": ["persist_mobile_cockpit_op_invalid"]
        });
    }

    let path = mobile_path(root);
    let mut state = read_json(&path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "connected": false,
            "session_id": null,
            "device": null,
            "last_action": null
        })
    });

    if op == "status" {
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "persist_plane_mobile_cockpit",
            "lane": "core/layer0/ops",
            "op": "status",
            "state": state,
            "claim_evidence": [
                {
                    "id": "V6-PERSIST-001.2",
                    "claim": "mobile_cockpit_surfaces_live_daemon_state_and_intervention_controls",
                    "evidence": {
                        "connected": state
                            .get("connected")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    if op == "publish" {
        state["connected"] = Value::Bool(true);
        state["session_id"] = Value::String(clean_id(
            parsed.flags.get("session-id").map(String::as_str),
            "mobile-session",
        ));
        state["device"] = Value::String(clean(
            parsed
                .flags
                .get("device")
                .cloned()
                .unwrap_or_else(|| "mobile-client".to_string()),
            120,
        ));
        state["published_at"] = Value::String(crate::now_iso());
        state["last_action"] = Value::String("publish".to_string());
    } else {
        if strict
            && !state
                .get("connected")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            return json!({
                "ok": false,
                "strict": strict,
                "type": "persist_plane_mobile_cockpit",
                "errors": ["persist_mobile_cockpit_not_connected"]
            });
        }
        let action = clean(
            parsed
                .flags
                .get("action")
                .cloned()
                .unwrap_or_else(|| "pause".to_string()),
            20,
        )
        .to_ascii_lowercase();
        let action_allowed = contract
            .get("allowed_actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .any(|row| row == action);
        if strict && !action_allowed {
            return json!({
                "ok": false,
                "strict": strict,
                "type": "persist_plane_mobile_cockpit",
                "errors": ["persist_mobile_cockpit_action_invalid"]
            });
        }
        state["last_action"] = Value::String(action);
        state["intervened_at"] = Value::String(crate::now_iso());
    }

    state["updated_at"] = Value::String(crate::now_iso());
    let _ = write_json(&path, &state);
    let _ = append_jsonl(
        &state_root(root).join("mobile").join("history.jsonl"),
        &json!({"op": op, "state": state, "ts": crate::now_iso()}),
    );
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "persist_plane_mobile_cockpit",
        "lane": "core/layer0/ops",
        "op": op,
        "state": state,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&read_json(&path).unwrap_or_else(|| json!({})).to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-PERSIST-001.2",
                "claim": "mobile_cockpit_state_and_interventions_are_receipted_for_remote_control",
                "evidence": {
                    "op": op
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
                "type": "persist_plane_conduit_gate",
                "errors": ["conduit_bypass_rejected"],
                "conduit_enforcement": conduit
            }),
        );
    }

    let payload = match command.as_str() {
        "status" => status(root),
        "schedule" => run_schedule(root, &parsed, strict),
        "mobile-cockpit" => run_mobile_cockpit(root, &parsed, strict),
        _ => json!({
            "ok": false,
            "type": "persist_plane_error",
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
        let parsed = crate::parse_args(&["schedule".to_string(), "--bypass=1".to_string()]);
        let out = conduit_enforcement(root.path(), &parsed, true, "schedule");
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn schedule_upsert_creates_registry() {
        let root = tempfile::tempdir().expect("tempdir");
        let out = run_schedule(
            root.path(),
            &crate::parse_args(&[
                "schedule".to_string(),
                "--op=upsert".to_string(),
                "--job=daily-health".to_string(),
            ]),
            true,
        );
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        assert!(schedules_path(root.path()).exists());
    }
}
