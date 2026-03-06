use crate::{deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

const POLICY_REL: &str = "config/rust_lane_canary_rollout_policy.json";
const LANE_ID: &str = "rollout_rings";

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn flag_value(argv: &[String], key: &str) -> Option<String> {
    let pref = format!("--{key}=");
    let mut idx = 0usize;
    while idx < argv.len() {
        let token = argv[idx].trim();
        if let Some(v) = token.strip_prefix(&pref) {
            return Some(v.to_string());
        }
        if token == format!("--{key}") {
            if let Some(next) = argv.get(idx + 1) {
                if !next.starts_with("--") {
                    return Some(next.clone());
                }
            }
        }
        idx += 1;
    }
    None
}

fn to_f64(raw: Option<String>, fallback: f64) -> f64 {
    raw.and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .unwrap_or(fallback)
}

fn read_json(path: &Path) -> Result<Value, String> {
    let raw =
        fs::read_to_string(path).map_err(|err| format!("read_policy_failed:{}:{err}", path.display()))?;
    serde_json::from_str::<Value>(&raw)
        .map_err(|err| format!("parse_policy_failed:{}:{err}", path.display()))
}

fn default_policy() -> Value {
    json!({
        "schema_id": "rust_lane_canary_rollout_policy",
        "schema_version": "1.0",
        "rollout_phases": ["shadow", "canary_5pct", "canary_25pct", "canary_50pct", "default"],
        "promotion_requirements": {
            "min_success_rate": 0.98,
            "max_error_rate": 0.02,
            "max_p95_regression_pct": 10.0
        },
        "auto_rollback": {
            "enabled": true,
            "rollback_target": "previous_stable_profile"
        }
    })
}

fn policy_with_defaults(root: &Path) -> Value {
    let mut policy = default_policy();
    let path = root.join(POLICY_REL);
    if let Ok(loaded) = read_json(&path) {
        if let Some(dst) = policy.as_object_mut() {
            if let Some(src) = loaded.as_object() {
                for (k, v) in src {
                    dst.insert(k.clone(), v.clone());
                }
            }
        }
    }
    policy
}

fn rollout_phases(policy: &Value) -> Vec<String> {
    policy
        .get("rollout_phases")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|row| row.trim().to_string())
                .filter(|row| !row.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|rows| !rows.is_empty())
        .unwrap_or_else(|| {
            vec![
                "shadow".to_string(),
                "canary_5pct".to_string(),
                "canary_25pct".to_string(),
                "canary_50pct".to_string(),
                "default".to_string(),
            ]
        })
}

fn requirement_f64(policy: &Value, key: &str, fallback: f64) -> f64 {
    policy
        .get("promotion_requirements")
        .and_then(Value::as_object)
        .and_then(|obj| obj.get(key))
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .unwrap_or(fallback)
}

fn evaluate_receipt(root: &Path, args: &[String]) -> Value {
    let policy = policy_with_defaults(root);
    let phases = rollout_phases(&policy);
    let current_phase = flag_value(args, "phase").unwrap_or_else(|| phases[0].clone());
    let success_rate = to_f64(flag_value(args, "success-rate"), 1.0);
    let error_rate = to_f64(flag_value(args, "error-rate"), 0.0);
    let p95_regression_pct = to_f64(flag_value(args, "p95-regression-pct"), 0.0);
    let crash_count = to_f64(flag_value(args, "crash-count"), 0.0);

    let min_success_rate = requirement_f64(&policy, "min_success_rate", 0.98);
    let max_error_rate = requirement_f64(&policy, "max_error_rate", 0.02);
    let max_p95_regression_pct = requirement_f64(&policy, "max_p95_regression_pct", 10.0);
    let rollback_enabled = policy
        .get("auto_rollback")
        .and_then(|v| v.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let rollback_target = policy
        .get("auto_rollback")
        .and_then(|v| v.get("rollback_target"))
        .and_then(Value::as_str)
        .unwrap_or("previous_stable_profile")
        .to_string();

    let mut blockers = Vec::<String>::new();
    if success_rate < min_success_rate {
        blockers.push("success_rate_below_min".to_string());
    }
    if error_rate > max_error_rate {
        blockers.push("error_rate_above_max".to_string());
    }
    if p95_regression_pct > max_p95_regression_pct {
        blockers.push("p95_regression_above_max".to_string());
    }
    if crash_count > 0.0 {
        blockers.push("crash_count_non_zero".to_string());
    }

    let current_idx = phases
        .iter()
        .position(|phase| phase.eq_ignore_ascii_case(&current_phase))
        .unwrap_or(0);
    let next_phase = phases
        .get((current_idx + 1).min(phases.len().saturating_sub(1)))
        .cloned()
        .unwrap_or_else(|| phases[phases.len().saturating_sub(1)].clone());

    let action = if blockers.is_empty() {
        if next_phase == current_phase {
            "hold"
        } else {
            "promote"
        }
    } else if rollback_enabled {
        "rollback"
    } else {
        "hold"
    };

    let mut out = json!({
        "ok": blockers.is_empty(),
        "type": "rollout_rings_evaluate",
        "lane": LANE_ID,
        "ts": now_iso(),
        "policy_path": POLICY_REL,
        "current_phase": current_phase,
        "next_phase": next_phase,
        "action": action,
        "rollback_target": if action == "rollback" { Value::String(rollback_target) } else { Value::Null },
        "signals": {
            "success_rate": success_rate,
            "error_rate": error_rate,
            "p95_regression_pct": p95_regression_pct,
            "crash_count": crash_count
        },
        "thresholds": {
            "min_success_rate": min_success_rate,
            "max_error_rate": max_error_rate,
            "max_p95_regression_pct": max_p95_regression_pct
        },
        "blockers": blockers,
        "claim_evidence": [
            {
                "id": "progressive_rollout_rings",
                "claim": "rollout_progression_requires_measured_ring_signals",
                "evidence": {
                    "phase_count": phases.len(),
                    "rollback_enabled": rollback_enabled
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn status_receipt(root: &Path) -> Value {
    let policy = policy_with_defaults(root);
    let phases = rollout_phases(&policy);
    let mut out = json!({
        "ok": true,
        "type": "rollout_rings_status",
        "lane": LANE_ID,
        "ts": now_iso(),
        "policy_path": POLICY_REL,
        "phases": phases,
        "promotion_requirements": policy.get("promotion_requirements").cloned().unwrap_or_else(|| json!({})),
        "auto_rollback": policy.get("auto_rollback").cloned().unwrap_or_else(|| json!({}))
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn usage() {
    println!("Usage:");
    println!(
        "  protheus-ops rollout-rings status\n  protheus-ops rollout-rings evaluate --phase=<shadow|canary_5pct|...> --success-rate=<0..1> --error-rate=<0..1> --p95-regression-pct=<n> [--crash-count=<n>]"
    );
}

pub fn run(root: &Path, args: &[String]) -> i32 {
    if args.iter().any(|v| matches!(v.as_str(), "help" | "--help" | "-h")) {
        usage();
        return 0;
    }

    let cmd = args
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    match cmd.as_str() {
        "status" => {
            print_json_line(&status_receipt(root));
            0
        }
        "evaluate" | "run" => {
            let payload = evaluate_receipt(root, args);
            let exit = if payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                0
            } else {
                2
            };
            print_json_line(&payload);
            exit
        }
        _ => {
            usage();
            let mut out = json!({
                "ok": false,
                "type": "rollout_rings_cli_error",
                "lane": LANE_ID,
                "ts": now_iso(),
                "error": "unknown_command",
                "command": cmd,
                "argv": args,
                "exit_code": 2
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            print_json_line(&out);
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_loads_default_or_file_backed_policy() {
        let root = tempfile::tempdir().expect("tempdir");
        let payload = status_receipt(root.path());
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        let phases = payload.get("phases").and_then(Value::as_array).expect("phases");
        assert!(phases.len() >= 3);
    }

    #[test]
    fn evaluate_promotes_when_signals_pass_thresholds() {
        let root = tempfile::tempdir().expect("tempdir");
        let args = vec![
            "evaluate".to_string(),
            "--phase=shadow".to_string(),
            "--success-rate=0.995".to_string(),
            "--error-rate=0.01".to_string(),
            "--p95-regression-pct=4".to_string(),
        ];
        let payload = evaluate_receipt(root.path(), &args);
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(payload.get("action").and_then(Value::as_str), Some("promote"));
    }

    #[test]
    fn evaluate_rolls_back_when_error_or_crash_thresholds_fail() {
        let root = tempfile::tempdir().expect("tempdir");
        let args = vec![
            "evaluate".to_string(),
            "--phase=canary_25pct".to_string(),
            "--success-rate=0.96".to_string(),
            "--error-rate=0.03".to_string(),
            "--p95-regression-pct=15".to_string(),
            "--crash-count=1".to_string(),
        ];
        let payload = evaluate_receipt(root.path(), &args);
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(payload.get("action").and_then(Value::as_str), Some("rollback"));
    }
}
