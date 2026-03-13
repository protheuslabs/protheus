// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use crate::binary_blob_runtime;
use crate::directive_kernel;
use crate::network_protocol;
use crate::v8_kernel::{
    append_jsonl, parse_bool, parse_f64, print_json, read_json, scoped_state_root, sha256_hex_str,
    write_json, write_receipt,
};
use crate::{clean, now_iso, parse_args};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "RSI_IGNITION_STATE_ROOT";
const STATE_SCOPE: &str = "rsi_ignition";

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn loop_state_path(root: &Path) -> PathBuf {
    state_root(root).join("loop_state.json")
}

fn recursive_loop_path(root: &Path) -> PathBuf {
    state_root(root).join("recursive_loop.jsonl")
}

fn metacognition_journal_path(root: &Path) -> PathBuf {
    state_root(root).join("metacognition_journal.jsonl")
}

fn network_symbiosis_path(root: &Path) -> PathBuf {
    state_root(root).join("network_symbiosis.jsonl")
}

fn proactive_evolution_path(root: &Path) -> PathBuf {
    state_root(root).join("proactive_evolution.jsonl")
}

fn default_loop_state() -> Value {
    json!({
        "version": "1.0",
        "active": false,
        "drift_score": 0.12,
        "exploration_drive": 0.62,
        "merge_count": 0,
        "rollback_count": 0,
        "proactive_evolution_count": 0,
        "last_merge": null,
        "last_rollback": null,
        "swarm": {
            "nodes": 0,
            "share_rate": 0.0,
            "convergence_score": 0.0
        },
        "created_at": now_iso()
    })
}

fn load_loop_state(root: &Path) -> Value {
    read_json(&loop_state_path(root)).unwrap_or_else(default_loop_state)
}

fn store_loop_state(root: &Path, state: &Value) -> Result<(), String> {
    write_json(&loop_state_path(root), state)
}

fn loop_obj_mut(state: &mut Value) -> &mut Map<String, Value> {
    if !state.is_object() {
        *state = default_loop_state();
    }
    state.as_object_mut().expect("loop_state_object")
}

fn mutation_history_path(root: &Path) -> PathBuf {
    crate::core_state_root(root)
        .join("ops")
        .join("binary_blob_runtime")
        .join("mutation_history.jsonl")
}

fn estimate_recent_failure_rate(root: &Path) -> f64 {
    let path = mutation_history_path(root);
    let Ok(raw) = fs::read_to_string(path) else {
        return 0.0;
    };
    let mut total = 0usize;
    let mut denied = 0usize;
    for line in raw.lines().rev().take(64) {
        let Ok(row) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if row.get("allow").is_some() {
            total += 1;
            if !row.get("allow").and_then(Value::as_bool).unwrap_or(false) {
                denied += 1;
            }
        }
    }
    if total == 0 {
        0.0
    } else {
        (denied as f64) / (total as f64)
    }
}

fn simulate_regression(proposal: &str, module: &str) -> f64 {
    let h = sha256_hex_str(&format!("{proposal}:{module}"));
    let tail = &h[h.len().saturating_sub(4)..];
    let n = u64::from_str_radix(tail, 16).unwrap_or(0);
    ((n % 100) as f64) / 1000.0
}

fn maybe_token_reward(root: &Path, agent: &str, amount: f64, reason: &str) -> Value {
    if !directive_kernel::action_allowed(root, "tokenomics") {
        return json!({
            "attempted": false,
            "ok": false,
            "reason": "directive_gate_denied"
        });
    }
    let exit = network_protocol::run(
        root,
        &[
            "reward".to_string(),
            format!("--agent={}", clean(agent, 120)),
            format!("--amount={:.8}", amount.max(0.0)),
            format!("--reason={}", clean(reason, 120)),
        ],
    );
    json!({
        "attempted": true,
        "ok": exit == 0,
        "exit_code": exit
    })
}

fn emit(root: &Path, payload: Value) -> i32 {
    match write_receipt(root, STATE_ENV, STATE_SCOPE, payload) {
        Ok(out) => {
            print_json(&out);
            if out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                0
            } else {
                2
            }
        }
        Err(err) => {
            let mut out = json!({
                "ok": false,
                "type": "rsi_ignition_error",
                "lane": "core/layer0/ops",
                "error": clean(err, 220),
                "exit_code": 2
            });
            out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
            print_json(&out);
            2
        }
    }
}

fn command_status(root: &Path) -> i32 {
    let state = load_loop_state(root);
    emit(
        root,
        json!({
            "ok": true,
            "type": "rsi_ignition_status",
            "lane": "core/layer0/ops",
            "loop_state": state,
            "artifact_counts": {
                "recursive_loop_entries": fs::read_to_string(recursive_loop_path(root)).ok().map(|v| v.lines().filter(|l| !l.trim().is_empty()).count()).unwrap_or(0),
                "metacognition_entries": fs::read_to_string(metacognition_journal_path(root)).ok().map(|v| v.lines().filter(|l| !l.trim().is_empty()).count()).unwrap_or(0),
                "network_symbiosis_entries": fs::read_to_string(network_symbiosis_path(root)).ok().map(|v| v.lines().filter(|l| !l.trim().is_empty()).count()).unwrap_or(0),
                "proactive_evolution_entries": fs::read_to_string(proactive_evolution_path(root)).ok().map(|v| v.lines().filter(|l| !l.trim().is_empty()).count()).unwrap_or(0)
            },
            "latest": read_json(&latest_path(root))
        }),
    )
}

fn command_ignite(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let proposal = clean(
        parsed
            .flags
            .get("proposal")
            .cloned()
            .unwrap_or_else(|| "optimize_runtime_loop".to_string()),
        280,
    );
    let module = clean(
        parsed
            .flags
            .get("module")
            .cloned()
            .unwrap_or_else(|| "conduit".to_string()),
        120,
    )
    .to_ascii_lowercase();
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let canary_pass = parse_bool(parsed.flags.get("canary-pass"), true);
    let sim_regression = parsed
        .flags
        .get("sim-regression")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or_else(|| simulate_regression(&proposal, &module))
        .max(0.0);
    let threshold = parse_f64(parsed.flags.get("max-regression"), 0.05).max(0.0);
    let gate_action = format!("rsi:ignite:{module}");
    let gate_eval = directive_kernel::evaluate_action(root, &gate_action);
    let gate_ok = gate_eval
        .get("allowed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut allowed = gate_ok && canary_pass && sim_regression <= threshold;
    let mut mutation_exit = 0i32;
    let mut reward = Value::Null;

    let mut state = load_loop_state(root);
    let state_obj = loop_obj_mut(&mut state);
    state_obj.insert("active".to_string(), Value::Bool(apply && allowed));

    if apply && allowed {
        mutation_exit = binary_blob_runtime::run(
            root,
            &[
                "mutate".to_string(),
                format!("--module={module}"),
                format!("--proposal={proposal}"),
                "--apply=1".to_string(),
                format!("--canary-pass={}", if canary_pass { 1 } else { 0 }),
                format!("--sim-regression={sim_regression:.4}"),
            ],
        );
        if mutation_exit != 0 {
            allowed = false;
        }
    }

    if apply {
        let _ = append_jsonl(
            &recursive_loop_path(root),
            &json!({
                "ts": now_iso(),
                "proposal": proposal,
                "module": module,
                "gate_action": gate_action,
                "gate_eval": gate_eval,
                "canary_pass": canary_pass,
                "sim_regression": sim_regression,
                "threshold": threshold,
                "mutation_exit": mutation_exit,
                "result": if allowed { "merge" } else { "rollback" }
            }),
        );
    }

    if apply && allowed {
        let next = state_obj
            .get("merge_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1;
        state_obj.insert("merge_count".to_string(), Value::from(next));
        state_obj.insert(
            "last_merge".to_string(),
            json!({
                "ts": now_iso(),
                "proposal": proposal,
                "module": module,
                "sim_regression": sim_regression
            }),
        );
        reward = maybe_token_reward(root, "organism:global", 1.0, "tokenomics");
    } else if apply {
        let next = state_obj
            .get("rollback_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1;
        state_obj.insert("rollback_count".to_string(), Value::from(next));
        state_obj.insert(
            "last_rollback".to_string(),
            json!({
                "ts": now_iso(),
                "proposal": proposal,
                "module": module,
                "gate_ok": gate_ok,
                "canary_pass": canary_pass,
                "sim_regression": sim_regression,
                "mutation_exit": mutation_exit
            }),
        );
    }

    if let Err(err) = store_loop_state(root, &state) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "rsi_ignition_activate",
                "lane": "core/layer0/ops",
                "error": clean(err, 220)
            }),
        );
    }

    emit(
        root,
        json!({
            "ok": allowed,
            "type": "rsi_ignition_activate",
            "lane": "core/layer0/ops",
            "proposal": proposal,
            "module": module,
            "apply": apply,
            "gate_ok": gate_ok,
            "canary_pass": canary_pass,
            "sim_regression": sim_regression,
            "max_regression": threshold,
            "mutation_exit": mutation_exit,
            "token_reward": reward,
            "pipeline": ["propose", "simulate", "canary", "merge_or_rollback"],
            "claim_evidence": [
                {
                    "id": "V8-RSI-IGNITION-001",
                    "claim": "recursive_self_modification_is_inversion_gated_with_merge_and_rollback_paths",
                    "evidence": {
                        "gate_action": gate_action,
                        "gate_allowed": gate_ok,
                        "canary_pass": canary_pass,
                        "sim_regression": sim_regression,
                        "mutation_exit": mutation_exit,
                        "result": if allowed { "merge" } else { "rollback" }
                    }
                }
            ]
        }),
    )
}

fn command_reflect(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let mut state = load_loop_state(root);
    let observed_failure_rate = estimate_recent_failure_rate(root);
    let drift = parsed
        .flags
        .get("drift")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or((0.1 + observed_failure_rate * 0.8).clamp(0.0, 1.0))
        .clamp(0.0, 1.0);
    let exploration = parsed
        .flags
        .get("exploration")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or_else(|| {
            let prior = state
                .get("exploration_drive")
                .and_then(Value::as_f64)
                .unwrap_or(0.6);
            if drift > 0.5 {
                (prior - 0.15).clamp(0.05, 1.0)
            } else {
                (prior + 0.05).clamp(0.05, 1.0)
            }
        })
        .clamp(0.0, 1.0);

    {
        let obj = loop_obj_mut(&mut state);
        obj.insert("drift_score".to_string(), Value::from(drift));
        obj.insert("exploration_drive".to_string(), Value::from(exploration));
        obj.insert(
            "last_reflection".to_string(),
            json!({
                "ts": now_iso(),
                "drift_score": drift,
                "exploration_drive": exploration,
                "observed_failure_rate": observed_failure_rate,
                "action": if drift > 0.5 { "self_correct" } else { "continue_explore" }
            }),
        );
    }
    if let Err(err) = store_loop_state(root, &state) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "rsi_ignition_reflection",
                "lane": "core/layer0/ops",
                "error": clean(err, 220)
            }),
        );
    }

    let _ = append_jsonl(
        &metacognition_journal_path(root),
        &json!({
            "ts": now_iso(),
            "drift_score": drift,
            "exploration_drive": exploration,
            "observed_failure_rate": observed_failure_rate,
            "strategy_adjustment": if drift > 0.5 { "stabilize" } else { "explore" }
        }),
    );

    emit(
        root,
        json!({
            "ok": true,
            "type": "rsi_ignition_reflection",
            "lane": "core/layer0/ops",
            "drift_score": drift,
            "exploration_drive": exploration,
            "observed_failure_rate": observed_failure_rate,
            "action": if drift > 0.5 { "self_correct" } else { "continue_explore" },
            "claim_evidence": [
                {
                    "id": "V8-RSI-IGNITION-002",
                    "claim": "metacognitive_reflection_tracks_goal_drift_and_adjusts_exploration_drive",
                    "evidence": {
                        "drift_score": drift,
                        "exploration_drive": exploration,
                        "observed_failure_rate": observed_failure_rate
                    }
                }
            ]
        }),
    )
}

fn command_swarm(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let nodes = parse_f64(parsed.flags.get("nodes"), 8.0).max(1.0) as u64;
    let share_rate = parse_f64(parsed.flags.get("share-rate"), 0.55).clamp(0.0, 1.0);
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let gate_ok = directive_kernel::action_allowed(root, "rsi:swarm");
    let convergence = ((share_rate * 0.75) + ((nodes as f64).ln() / 10.0)).clamp(0.0, 1.0);
    let allowed = gate_ok && convergence > 0.1;
    let mut reward = Value::Null;

    let mut state = load_loop_state(root);
    if apply && allowed {
        let obj = loop_obj_mut(&mut state);
        obj.insert(
            "swarm".to_string(),
            json!({
                "nodes": nodes,
                "share_rate": share_rate,
                "convergence_score": convergence,
                "updated_at": now_iso()
            }),
        );
        reward = maybe_token_reward(
            root,
            "organism:swarm",
            (nodes as f64) * share_rate * 0.1,
            "tokenomics",
        );
        let _ = append_jsonl(
            &network_symbiosis_path(root),
            &json!({
                "ts": now_iso(),
                "nodes": nodes,
                "share_rate": share_rate,
                "convergence_score": convergence,
                "resource_allocation": {
                    "token_reward_attempted": reward.get("attempted").and_then(Value::as_bool).unwrap_or(false),
                    "token_reward_ok": reward.get("ok").and_then(Value::as_bool).unwrap_or(false)
                }
            }),
        );
    }
    if let Err(err) = store_loop_state(root, &state) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "rsi_ignition_swarm",
                "lane": "core/layer0/ops",
                "error": clean(err, 220)
            }),
        );
    }

    emit(
        root,
        json!({
            "ok": allowed,
            "type": "rsi_ignition_swarm",
            "lane": "core/layer0/ops",
            "nodes": nodes,
            "share_rate": share_rate,
            "convergence_score": convergence,
            "apply": apply,
            "gate_ok": gate_ok,
            "swarm_reward": reward,
            "claim_evidence": [
                {
                    "id": "V8-RSI-IGNITION-003",
                    "claim": "network_level_sub_swarms_share_improvements_with_policy_bounded_resource_allocation",
                    "evidence": {
                        "nodes": nodes,
                        "share_rate": share_rate,
                        "convergence_score": convergence
                    }
                }
            ]
        }),
    )
}

fn command_evolve(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let mut state = load_loop_state(root);
    let insight = clean(
        parsed.flags.get("insight").cloned().unwrap_or_else(|| {
            "I found a lower-cost planning strategy with stable quality.".to_string()
        }),
        360,
    );
    let module = clean(
        parsed
            .flags
            .get("module")
            .cloned()
            .unwrap_or_else(|| "conduit".to_string()),
        120,
    )
    .to_ascii_lowercase();
    let apply = parse_bool(parsed.flags.get("apply"), false);
    let ignite_apply = parse_bool(parsed.flags.get("ignite-apply"), false);
    let night_cycle = parse_bool(parsed.flags.get("night-cycle"), true);
    let gate_ok = directive_kernel::action_allowed(root, &format!("rsi:evolve:{module}"));
    let proactive_message = format!(
        "night-cycle insight: {} | suggested module={} | apply={}",
        insight, module, ignite_apply
    );

    let mut ignite_exit = 0i32;
    if apply && gate_ok {
        ignite_exit = command_ignite(
            root,
            &parse_args(&[
                "ignite".to_string(),
                format!("--proposal={insight}"),
                format!("--module={module}"),
                format!("--apply={}", if ignite_apply { 1 } else { 0 }),
            ]),
        );
        if night_cycle {
            let _ = append_jsonl(
                &proactive_evolution_path(root),
                &json!({
                    "ts": now_iso(),
                    "insight": insight,
                    "module": module,
                    "directive_safe": gate_ok,
                    "proactive_message": proactive_message,
                    "morning_surface": true
                }),
            );
        }
    }

    {
        let obj = loop_obj_mut(&mut state);
        let next = obj
            .get("proactive_evolution_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1;
        obj.insert("proactive_evolution_count".to_string(), Value::from(next));
        obj.insert(
            "last_evolution".to_string(),
            json!({
                "ts": now_iso(),
                "insight": insight,
                "module": module,
                "apply": apply,
                "ignite_apply": ignite_apply,
                "ignite_exit": ignite_exit
            }),
        );
    }
    if let Err(err) = store_loop_state(root, &state) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "rsi_ignition_evolve",
                "lane": "core/layer0/ops",
                "error": clean(err, 220)
            }),
        );
    }

    emit(
        root,
        json!({
            "ok": gate_ok,
            "type": "rsi_ignition_evolve",
            "lane": "core/layer0/ops",
            "insight": insight,
            "module": module,
            "apply": apply,
            "ignite_apply": ignite_apply,
            "ignite_exit": ignite_exit,
            "night_cycle": night_cycle,
            "proactive_message": proactive_message,
            "directive_safe": gate_ok,
            "claim_evidence": [
                {
                    "id": "V8-RSI-IGNITION-004",
                    "claim": "proactive_evolution_surfaces_night_cycle_insights_with_directive_safe_receipts",
                    "evidence": {
                        "directive_safe": gate_ok,
                        "night_cycle": night_cycle,
                        "ignite_exit": ignite_exit
                    }
                }
            ]
        }),
    )
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let command = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        println!("Usage:");
        println!("  protheus-ops rsi-ignition status");
        println!("  protheus-ops rsi-ignition ignite [--proposal=<text>] [--module=<id>] [--apply=1|0] [--canary-pass=1|0] [--sim-regression=<0..1>]");
        println!("  protheus-ops rsi-ignition reflect [--drift=<0..1>] [--exploration=<0..1>]");
        println!(
            "  protheus-ops rsi-ignition swarm [--nodes=<n>] [--share-rate=<0..1>] [--apply=1|0]"
        );
        println!("  protheus-ops rsi-ignition evolve [--insight=<text>] [--module=<id>] [--apply=1|0] [--ignite-apply=1|0] [--night-cycle=1|0]");
        return 0;
    }

    match command.as_str() {
        "status" => command_status(root),
        "ignite" => command_ignite(root, &parsed),
        "reflect" => command_reflect(root, &parsed),
        "swarm" => command_swarm(root, &parsed),
        "evolve" => command_evolve(root, &parsed),
        _ => emit(
            root,
            json!({
                "ok": false,
                "type": "rsi_ignition_error",
                "lane": "core/layer0/ops",
                "error": "unknown_command",
                "command": command,
                "exit_code": 2
            }),
        ),
    }
}

#[cfg(test)]
#[path = "rsi_ignition_tests.rs"]
mod tests;
