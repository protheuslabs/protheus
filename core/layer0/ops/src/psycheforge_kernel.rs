// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso, swarm_runtime};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const STATE_ROOT: &str = "core/local/state/ops/security_plane/psycheforge";
const PROFILE_IDS: [&str; 7] = [
    "probe",
    "exfil",
    "escalation",
    "denial",
    "impersonation",
    "jailbreak",
    "drift",
];

fn state_root(root: &Path) -> PathBuf {
    root.join(STATE_ROOT)
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn history_path(root: &Path) -> PathBuf {
    state_root(root).join("history.jsonl")
}

fn score_keywords(haystack: &str, needles: &[&str]) -> f64 {
    let lower = haystack.to_ascii_lowercase();
    let hits = needles.iter().filter(|needle| lower.contains(**needle)).count();
    if needles.is_empty() {
        0.0
    } else {
        hits as f64 / needles.len() as f64
    }
}

fn classify_profiles(text: &str, anomaly_score: f64, deviation: f64, sensitivity: f64) -> Vec<Value> {
    let mut scores = BTreeMap::<&str, f64>::new();
    scores.insert("probe", score_keywords(text, &["scan", "probe", "enumerate", "discover", "map endpoint", "list tools"]));
    scores.insert("exfil", score_keywords(text, &["exfil", "dump secrets", "export data", "send outside", "leak", "upload archive"]));
    scores.insert("escalation", score_keywords(text, &["sudo", "root", "admin", "elevate", "bypass approval", "privilege escalation"]));
    scores.insert("denial", score_keywords(text, &["saturate", "fork bomb", "overwhelm", "deny service", "wipe", "kill all"]));
    scores.insert("impersonation", score_keywords(text, &["impersonate", "spoof", "pretend to be", "session hijack", "steal token"]));
    scores.insert("jailbreak", score_keywords(text, &["ignore previous instructions", "system override", "disable safety", "unrestricted", "developer mode"]));
    scores.insert("drift", score_keywords(text, &["drift", "handoff storm", "identity mismatch", "policy violation", "off objective"]));

    let mut rows = PROFILE_IDS
        .iter()
        .map(|id| {
            let mut score = *scores.get(id).unwrap_or(&0.0);
            if *id == "drift" {
                score = (score + anomaly_score + deviation) / 3.0;
            } else if *id == "jailbreak" || *id == "exfil" || *id == "escalation" {
                score = (score + anomaly_score * 0.35).clamp(0.0, 1.0);
            }
            let adjusted = (score * (0.6 + sensitivity * 0.4)).clamp(0.0, 1.0);
            json!({"profile": id, "score": adjusted})
        })
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        b.get("score")
            .and_then(Value::as_f64)
            .partial_cmp(&a.get("score").and_then(Value::as_f64))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    rows
}

fn high_threat(primary_profile: &str, primary_score: f64, anomaly_score: f64, deviation: f64) -> bool {
    if primary_score >= 0.82 {
        return true;
    }
    if matches!(primary_profile, "exfil" | "escalation" | "jailbreak") && primary_score >= 0.68 {
        return true;
    }
    matches!(primary_profile, "exfil" | "escalation" | "jailbreak")
        && primary_score >= 0.60
        && anomaly_score >= 0.90
        && deviation >= 0.90
}

fn append_ledger_event(root: &Path, action: &str, details: &Value) -> Value {
    let argv = vec![
        "append".to_string(),
        "--actor=psycheforge".to_string(),
        format!("--action={action}"),
        "--source=psycheforge".to_string(),
        format!("--details-json={}", serde_json::to_string(details).unwrap_or_else(|_| "{}".to_string())),
    ];
    let (payload, _) = infring_layer1_security::run_black_box_ledger(root, &argv);
    payload
}

pub fn run(root: &Path, argv: &[String]) -> (Value, i32) {
    let command = argv
        .first()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let strict = lane_utils::parse_bool(lane_utils::parse_flag(argv, "strict", false).as_deref(), true);
    let sensitivity = lane_utils::parse_f64_clamped(lane_utils::parse_flag(argv, "sensitivity", false).as_deref(), 0.5, 0.0, 1.0);

    let mut payload = match command.as_str() {
        "status" => {
            let latest = fs::read_to_string(latest_path(root))
                .ok()
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                .unwrap_or_else(|| json!({}));
            json!({
                "ok": true,
                "type": "security_plane_psycheforge",
                "mode": "status",
                "lane": "core/layer0/ops",
                "profiles": PROFILE_IDS,
                "latest_profile": latest,
                "default_sensitivity": sensitivity,
            })
        }
        "profile" => {
            let actor = lane_utils::parse_flag(argv, "actor", false).unwrap_or_else(|| "unknown_actor".to_string());
            let session_id = lane_utils::parse_flag(argv, "session-id", false);
            let prompt = lane_utils::parse_flag(argv, "prompt", false).unwrap_or_default();
            let tool_input = lane_utils::parse_flag(argv, "tool-input", false).unwrap_or_default();
            let handoff_pattern = lane_utils::parse_flag(argv, "handoff-pattern", false).unwrap_or_default();
            let anomaly_score = lane_utils::parse_f64_clamped(lane_utils::parse_flag(argv, "anomaly-score", false).as_deref(), 0.0, 0.0, 1.0);
            let deviation = lane_utils::parse_f64_clamped(lane_utils::parse_flag(argv, "statistical-deviation", false).as_deref(), 0.0, 0.0, 1.0);
            let text = format!("{}\n{}\n{}", prompt, tool_input, handoff_pattern);
            let profiles = classify_profiles(&text, anomaly_score, deviation, sensitivity);
            let primary = profiles.first().cloned().unwrap_or_else(|| json!({"profile":"probe","score":0.0}));
            let primary_score = primary.get("score").and_then(Value::as_f64).unwrap_or(0.0);
            let primary_profile = primary
                .get("profile")
                .and_then(Value::as_str)
                .unwrap_or("probe")
                .to_string();
            let high_threat = high_threat(
                primary_profile.as_str(),
                primary_score,
                anomaly_score,
                deviation,
            );
            let quarantine = if high_threat {
                session_id.as_ref().map(|id| {
                    let mut thorn_args = vec![
                        "quarantine".to_string(),
                        format!("--session-id={id}"),
                        format!("--anomaly-type={primary_profile}"),
                        format!("--reason=psycheforge:{primary_profile}"),
                    ];
                    if let Some(state_path) = lane_utils::parse_flag(argv, "swarm-state-path", false) {
                        thorn_args.push(format!("--state-path={state_path}"));
                    }
                    let (result, _) = swarm_runtime::run_thorn_contract(root, &thorn_args);
                    result
                })
            } else {
                None
            };
            let action = if quarantine.is_some() {
                "auto_quarantine"
            } else if high_threat {
                "human_approval_gate"
            } else {
                "observe"
            };
            let history_row = json!({
                "ts": now_iso(),
                "actor": actor,
                "session_id": session_id,
                "primary_profile": primary_profile,
                "primary_score": primary_score,
                "profiles": profiles,
                "anomaly_score": anomaly_score,
                "statistical_deviation": deviation,
                "action": action,
            });
            let ledger = append_ledger_event(root, "psyche_profile", &history_row);
            json!({
                "ok": true,
                "type": "security_plane_psycheforge",
                "mode": "profile",
                "lane": "core/layer0/ops",
                "history_row": history_row,
                "quarantine": quarantine,
                "ledger_entry": ledger,
                "high_threat": high_threat,
                "approval_required": high_threat && session_id.is_none(),
            })
        }
        _ => json!({
            "ok": false,
            "type": "security_plane_psycheforge",
            "mode": command,
            "lane": "core/layer0/ops",
            "error": format!("unknown_command:{command}"),
        }),
    };

    payload["strict"] = Value::Bool(strict);
    payload["claim_evidence"] = Value::Array(vec![json!({
        "id": "V6-SEC-PSYCHE-001",
        "claim": "psycheforge_classifies_behavior_into_seven_threat_profiles_and_routes_high_threat_flows_to_quarantine_or_human_gate",
        "evidence": {
            "mode": command,
            "profile_count": PROFILE_IDS.len(),
            "sensitivity": sensitivity
        }
    })]);
    payload["receipt_hash"] = Value::String(deterministic_receipt_hash(&payload));
    let exit = if strict && payload.get("ok").and_then(Value::as_bool) == Some(false) {
        2
    } else {
        0
    };
    let _ = lane_utils::write_json(&latest_path(root), &payload);
    let _ = lane_utils::append_jsonl(&history_path(root), &payload);
    (payload, exit)
}
