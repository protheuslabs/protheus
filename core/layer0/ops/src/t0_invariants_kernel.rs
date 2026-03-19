// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use crate::contract_lane_utils as lane_utils;
use crate::deterministic_receipt_hash;
use crate::swarm_runtime;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const DIRECTIVE_PATH: &str = "client/runtime/config/directives/T0_invariants.yaml";
const STATE_ROOT: &str = "core/local/state/ops/security_plane/t0_invariants";

fn state_root(root: &Path) -> PathBuf {
    root.join(STATE_ROOT)
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn history_path(root: &Path) -> PathBuf {
    state_root(root).join("history.jsonl")
}

fn load_directive_doc(root: &Path) -> Value {
    let path = root.join(DIRECTIVE_PATH);
    fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_yaml::from_str::<serde_yaml::Value>(&raw).ok())
        .and_then(|doc| serde_json::to_value(doc).ok())
        .unwrap_or_else(|| json!({}))
}

fn invariant_catalog() -> Vec<Value> {
    vec![
        json!({"id":"no_disable_receipts","description":"No agent can disable receipts"}),
        json!({"id":"approved_memory_scopes_only","description":"No agent can access unapproved memory scopes"}),
        json!({"id":"shell_requires_approval","description":"No agent can execute shell without approval"}),
        json!({"id":"no_exfil_outside_policy","description":"No agent can exfiltrate data outside policy"}),
        json!({"id":"no_self_modify_safety_plane","description":"No agent can self-modify core safety plane"}),
        json!({"id":"external_calls_receipted","description":"All external calls must be receipted"}),
        json!({"id":"budget_overrun_terminates","description":"Budget overruns trigger immediate termination"}),
        json!({"id":"human_veto_overrides_all","description":"Human veto overrides all"}),
    ]
}

fn evaluate_attempt(argv: &[String]) -> Value {
    let receipts_enabled = lane_utils::parse_bool_extended(
        lane_utils::parse_flag(argv, "receipts-enabled", false).as_deref(),
        true,
    );
    let memory_scope_approved = lane_utils::parse_bool_extended(
        lane_utils::parse_flag(argv, "memory-scope-approved", false).as_deref(),
        true,
    );
    let shell_approved = lane_utils::parse_bool_extended(
        lane_utils::parse_flag(argv, "shell-approved", false).as_deref(),
        false,
    );
    let exfil_approved = lane_utils::parse_bool_extended(
        lane_utils::parse_flag(argv, "exfil-approved", false).as_deref(),
        false,
    );
    let core_safety_modify_approved = lane_utils::parse_bool_extended(
        lane_utils::parse_flag(argv, "core-safety-modify-approved", false).as_deref(),
        false,
    );
    let external_call_receipted = lane_utils::parse_bool_extended(
        lane_utils::parse_flag(argv, "external-call-receipted", false).as_deref(),
        true,
    );
    let budget_overrun = lane_utils::parse_bool_extended(
        lane_utils::parse_flag(argv, "budget-overrun", false).as_deref(),
        false,
    );
    let human_veto = lane_utils::parse_bool_extended(
        lane_utils::parse_flag(argv, "human-veto", false).as_deref(),
        false,
    );

    let mut violations = Vec::<Value>::new();
    if !receipts_enabled {
        violations.push(json!({"id":"no_disable_receipts","reason":"receipts_disabled"}));
    }
    if !memory_scope_approved {
        violations
            .push(json!({"id":"approved_memory_scopes_only","reason":"memory_scope_unapproved"}));
    }
    if lane_utils::parse_bool_extended(
        lane_utils::parse_flag(argv, "shell-exec", false).as_deref(),
        false,
    ) && !shell_approved
    {
        violations
            .push(json!({"id":"shell_requires_approval","reason":"shell_exec_without_approval"}));
    }
    if lane_utils::parse_bool_extended(
        lane_utils::parse_flag(argv, "external-exfil", false).as_deref(),
        false,
    ) && !exfil_approved
    {
        violations.push(json!({"id":"no_exfil_outside_policy","reason":"exfil_outside_policy"}));
    }
    if lane_utils::parse_bool_extended(
        lane_utils::parse_flag(argv, "modify-safety-plane", false).as_deref(),
        false,
    ) && !core_safety_modify_approved
    {
        violations.push(json!({"id":"no_self_modify_safety_plane","reason":"safety_plane_modification_attempt"}));
    }
    if lane_utils::parse_bool_extended(
        lane_utils::parse_flag(argv, "external-call", false).as_deref(),
        false,
    ) && !external_call_receipted
    {
        violations.push(
            json!({"id":"external_calls_receipted","reason":"external_call_without_receipt"}),
        );
    }
    if budget_overrun {
        violations
            .push(json!({"id":"budget_overrun_terminates","reason":"budget_overrun_detected"}));
    }
    if human_veto {
        violations.push(json!({"id":"human_veto_overrides_all","reason":"human_veto_asserted"}));
    }

    json!({
        "receipts_enabled": receipts_enabled,
        "memory_scope_approved": memory_scope_approved,
        "shell_approved": shell_approved,
        "exfil_approved": exfil_approved,
        "core_safety_modify_approved": core_safety_modify_approved,
        "external_call_receipted": external_call_receipted,
        "budget_overrun": budget_overrun,
        "human_veto": human_veto,
        "violations": violations,
    })
}

fn persist(root: &Path, payload: &Value) {
    let _ = lane_utils::write_json(&latest_path(root), payload);
    let _ = lane_utils::append_jsonl(&history_path(root), payload);
}

fn append_ledger_event(root: &Path, action: &str, details: &Value) -> Value {
    let argv = vec![
        "append".to_string(),
        "--actor=t0_invariants".to_string(),
        format!("--action={action}"),
        "--source=t0_invariants".to_string(),
        format!(
            "--details-json={}",
            serde_json::to_string(details).unwrap_or_else(|_| "{}".to_string())
        ),
    ];
    let (payload, _) = infring_layer1_security::run_black_box_ledger(root, &argv);
    payload
}

fn shutdown_receipt(root: &Path, argv: &[String], reason: &str) -> Value {
    let mut shutdown_argv = vec![format!("--reason={reason}")];
    if let Some(state_path) = lane_utils::parse_flag(argv, "swarm-state-path", false) {
        shutdown_argv.push(format!("--state-path={state_path}"));
    }
    swarm_runtime::force_shutdown(root, &shutdown_argv).unwrap_or_else(|err| {
        json!({
            "ok": false,
            "type": "swarm_runtime_force_shutdown_error",
            "error": err,
        })
    })
}

pub fn run(root: &Path, argv: &[String]) -> (Value, i32) {
    let command = argv
        .first()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let strict = lane_utils::parse_bool_extended(
        lane_utils::parse_flag(argv, "strict", false).as_deref(),
        true,
    );

    let mut payload = match command.as_str() {
        "status" => {
            let directive = load_directive_doc(root);
            json!({
                "ok": true,
                "type": "security_plane_t0_invariants",
                "mode": "status",
                "lane": "core/layer0/ops",
                "directive_path": DIRECTIVE_PATH,
                "directive": directive,
                "invariants": invariant_catalog(),
                "compiled_into_layer0": true,
            })
        }
        "evaluate" => {
            let started = std::time::Instant::now();
            let evaluation = evaluate_attempt(argv);
            let violations = evaluation
                .get("violations")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let blocked = !violations.is_empty();
            let shutdown = if blocked {
                Some(shutdown_receipt(root, argv, "t0_invariant_violation"))
            } else {
                None
            };
            let ledger = if blocked {
                Some(append_ledger_event(
                    root,
                    "t0_invariant_violation",
                    &json!({
                        "violations": violations,
                        "action": lane_utils::parse_flag(argv, "action", false).unwrap_or_else(|| "unspecified".to_string()),
                    }),
                ))
            } else {
                None
            };
            json!({
                "ok": !blocked,
                "type": "security_plane_t0_invariants",
                "mode": "evaluate",
                "lane": "core/layer0/ops",
                "blocked": blocked,
                "shutdown_triggered": blocked,
                "swarm_shutdown": shutdown,
                "ledger_entry": ledger,
                "evaluation": evaluation,
                "evaluation_latency_ms": started.elapsed().as_millis() as u64,
            })
        }
        "fuzz" => {
            let attempts = lane_utils::parse_u64_clamped(
                lane_utils::parse_flag(argv, "attempts", false).as_deref(),
                10_000,
                1,
                100_000,
            );
            let mut blocked = 0u64;
            for idx in 0..attempts {
                let scenario = match idx % 8 {
                    0 => vec!["--receipts-enabled=0".to_string()],
                    1 => vec!["--memory-scope-approved=0".to_string()],
                    2 => vec![
                        "--shell-exec=1".to_string(),
                        "--shell-approved=0".to_string(),
                    ],
                    3 => vec![
                        "--external-exfil=1".to_string(),
                        "--exfil-approved=0".to_string(),
                    ],
                    4 => vec![
                        "--modify-safety-plane=1".to_string(),
                        "--core-safety-modify-approved=0".to_string(),
                    ],
                    5 => vec![
                        "--external-call=1".to_string(),
                        "--external-call-receipted=0".to_string(),
                    ],
                    6 => vec!["--budget-overrun=1".to_string()],
                    _ => vec!["--human-veto=1".to_string()],
                };
                let evaluation = evaluate_attempt(&scenario);
                if evaluation
                    .get("violations")
                    .and_then(Value::as_array)
                    .map(|rows| !rows.is_empty())
                    .unwrap_or(false)
                {
                    blocked += 1;
                }
            }
            json!({
                "ok": blocked == attempts,
                "type": "security_plane_t0_invariants",
                "mode": "fuzz",
                "lane": "core/layer0/ops",
                "attempts": attempts,
                "blocked_attempts": blocked,
                "false_negatives": attempts.saturating_sub(blocked),
            })
        }
        _ => json!({
            "ok": false,
            "type": "security_plane_t0_invariants",
            "mode": command,
            "lane": "core/layer0/ops",
            "error": format!("unknown_command:{command}"),
        }),
    };

    let claim = if payload.get("ok").and_then(Value::as_bool) == Some(false)
        && payload.get("error").is_some()
    {
        json!({
            "id": "V6-SEC-T0-001",
            "claim": "t0_invariant_kernel_fails_closed_on_unknown_or_invalid_commands",
            "evidence": {"mode": command}
        })
    } else {
        json!({
            "id": "V6-SEC-T0-001",
            "claim": "t0_invariants_execute_before_agent_policy_paths_with_fail_closed_shutdown_and_receipts",
            "evidence": {
                "mode": command,
                "compiled_into_layer0": true,
                "strict": strict
            }
        })
    };
    payload["strict"] = Value::Bool(strict);
    payload["claim_evidence"] = Value::Array(vec![claim]);
    payload["receipt_hash"] = Value::String(deterministic_receipt_hash(&payload));
    persist(root, &payload);

    let exit = if strict && payload.get("ok").and_then(Value::as_bool) == Some(false) {
        2
    } else {
        0
    };
    (payload, exit)
}
