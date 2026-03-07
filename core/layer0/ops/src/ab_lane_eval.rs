// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const LANE_ID: &str = "ab_lane_eval";
const STATE_DIR_REL: &str = "state/ops/ab_lane_eval";

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

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("create_dir_failed:{}:{err}", parent.display()))?;
    }
    Ok(())
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let payload =
        serde_json::to_string_pretty(value).map_err(|err| format!("encode_json_failed:{err}"))?;
    fs::write(path, format!("{payload}\n"))
        .map_err(|err| format!("write_json_failed:{}:{err}", path.display()))
}

fn append_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let encoded = serde_json::to_string(value).map_err(|err| format!("encode_jsonl_failed:{err}"))?;
    let mut line = encoded;
    line.push('\n');
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("open_jsonl_failed:{}:{err}", path.display()))?;
    file.write_all(line.as_bytes())
        .map_err(|err| format!("append_jsonl_failed:{}:{err}", path.display()))
}

fn score_variant(quality: f64, drift: f64, escalation: f64, cost: f64) -> f64 {
    quality - (drift * 2.0) - (escalation * 3.0) - (cost * 0.1)
}

fn state_paths(root: &Path) -> (PathBuf, PathBuf) {
    let state_dir = root.join(STATE_DIR_REL);
    (state_dir.join("latest.json"), state_dir.join("history.jsonl"))
}

fn run_receipt(root: &Path, args: &[String]) -> Value {
    let lane = flag_value(args, "lane").unwrap_or_else(|| "general".to_string());
    let variant_a = flag_value(args, "variant-a").unwrap_or_else(|| "A".to_string());
    let variant_b = flag_value(args, "variant-b").unwrap_or_else(|| "B".to_string());
    let min_promote_delta = to_f64(flag_value(args, "min-promote-delta"), 0.02);

    let a_quality = to_f64(flag_value(args, "a-quality"), 0.0);
    let a_drift = to_f64(flag_value(args, "a-drift"), 0.0);
    let a_escalation = to_f64(flag_value(args, "a-escalation"), 0.0);
    let a_cost = to_f64(flag_value(args, "a-cost"), 0.0);

    let b_quality = to_f64(flag_value(args, "b-quality"), 0.0);
    let b_drift = to_f64(flag_value(args, "b-drift"), 0.0);
    let b_escalation = to_f64(flag_value(args, "b-escalation"), 0.0);
    let b_cost = to_f64(flag_value(args, "b-cost"), 0.0);

    let score_a = score_variant(a_quality, a_drift, a_escalation, a_cost);
    let score_b = score_variant(b_quality, b_drift, b_escalation, b_cost);
    let delta = score_a - score_b;
    let (winner, promote) = if delta > min_promote_delta {
        (variant_a.clone(), true)
    } else if delta < -min_promote_delta {
        (variant_b.clone(), true)
    } else {
        ("tie".to_string(), false)
    };

    let (latest_path, history_path) = state_paths(root);
    let mut out = json!({
        "ok": true,
        "type": "ab_lane_eval_run",
        "lane_id": LANE_ID,
        "ts": now_iso(),
        "lane": lane,
        "min_promote_delta": min_promote_delta,
        "winner": winner,
        "promote": promote,
        "scores": {
            "a": {
                "variant": variant_a,
                "quality": a_quality,
                "drift": a_drift,
                "escalation": a_escalation,
                "cost": a_cost,
                "score": score_a
            },
            "b": {
                "variant": variant_b,
                "quality": b_quality,
                "drift": b_drift,
                "escalation": b_escalation,
                "cost": b_cost,
                "score": score_b
            },
            "delta": delta
        },
        "claim_evidence": [
            {
                "id": "ab_variant_trial_contract",
                "claim": "loop_persona_variants_are_scored_and_promoted_by_receipted_metrics",
                "evidence": {
                    "promote": promote,
                    "delta": delta
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));

    let _ = write_json(&latest_path, &out);
    let _ = append_jsonl(&history_path, &out);
    out
}

fn status_receipt(root: &Path) -> Value {
    let (latest_path, _) = state_paths(root);
    let latest = fs::read_to_string(&latest_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let mut out = json!({
        "ok": true,
        "type": "ab_lane_eval_status",
        "lane_id": LANE_ID,
        "ts": now_iso(),
        "state_dir": STATE_DIR_REL,
        "latest": latest
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops ab-lane-eval status");
    println!("  protheus-ops ab-lane-eval run --lane=<id> --variant-a=<A> --variant-b=<B> --a-quality=<n> --a-drift=<n> --a-escalation=<n> --a-cost=<n> --b-quality=<n> --b-drift=<n> --b-escalation=<n> --b-cost=<n> [--min-promote-delta=<n>]");
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
        "run" | "evaluate" => {
            print_json_line(&run_receipt(root, args));
            0
        }
        _ => {
            usage();
            let mut out = json!({
                "ok": false,
                "type": "ab_lane_eval_cli_error",
                "lane_id": LANE_ID,
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
    fn run_receipt_promotes_higher_scoring_variant() {
        let root = tempfile::tempdir().expect("tempdir");
        let args = vec![
            "run".to_string(),
            "--lane=persona_dispatch".to_string(),
            "--variant-a=baseline".to_string(),
            "--variant-b=tuned".to_string(),
            "--a-quality=0.61".to_string(),
            "--a-drift=0.06".to_string(),
            "--a-escalation=0.05".to_string(),
            "--a-cost=0.20".to_string(),
            "--b-quality=0.80".to_string(),
            "--b-drift=0.03".to_string(),
            "--b-escalation=0.02".to_string(),
            "--b-cost=0.24".to_string(),
        ];
        let out = run_receipt(root.path(), &args);
        assert_eq!(out.get("promote").and_then(Value::as_bool), Some(true));
        assert_eq!(out.get("winner").and_then(Value::as_str), Some("tuned"));
    }

    #[test]
    fn run_receipt_holds_when_delta_is_within_threshold() {
        let root = tempfile::tempdir().expect("tempdir");
        let args = vec![
            "run".to_string(),
            "--variant-a=A".to_string(),
            "--variant-b=B".to_string(),
            "--a-quality=0.50".to_string(),
            "--a-drift=0.10".to_string(),
            "--a-escalation=0.10".to_string(),
            "--a-cost=0.20".to_string(),
            "--b-quality=0.51".to_string(),
            "--b-drift=0.10".to_string(),
            "--b-escalation=0.10".to_string(),
            "--b-cost=0.20".to_string(),
            "--min-promote-delta=0.5".to_string(),
        ];
        let out = run_receipt(root.path(), &args);
        assert_eq!(out.get("promote").and_then(Value::as_bool), Some(false));
        assert_eq!(out.get("winner").and_then(Value::as_str), Some("tie"));
    }
}
