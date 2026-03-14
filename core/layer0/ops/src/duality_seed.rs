// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer2/autonomy (authoritative)

use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::{clean, deterministic_receipt_hash, now_iso};

const DEFAULT_POLICY_REL: &str = "client/runtime/config/duality_seed_policy.json";
const DEFAULT_CODEX_REL: &str = "client/runtime/config/duality_codex.txt";
const DEFAULT_LATEST_REL: &str = "local/state/autonomy/duality/latest.json";
const DEFAULT_HISTORY_REL: &str = "local/state/autonomy/duality/history.jsonl";

const TRIT_PAIN: i64 = -1;
const TRIT_UNKNOWN: i64 = 0;
const TRIT_OK: i64 = 1;

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let pref = format!("--{key}=");
    let long = format!("--{key}");
    let mut idx = 0usize;
    while idx < argv.len() {
        let token = argv[idx].trim();
        if let Some(v) = token.strip_prefix(&pref) {
            return Some(v.to_string());
        }
        if token == long && idx + 1 < argv.len() {
            return Some(argv[idx + 1].clone());
        }
        idx += 1;
    }
    None
}

fn load_payload(argv: &[String]) -> Result<Value, String> {
    if let Some(payload) = parse_flag(argv, "payload") {
        return serde_json::from_str::<Value>(&payload)
            .map_err(|err| format!("duality_seed_payload_decode_failed:{err}"));
    }
    if let Some(path) = parse_flag(argv, "payload-file") {
        let text = fs::read_to_string(path.trim())
            .map_err(|err| format!("duality_seed_payload_file_read_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("duality_seed_payload_decode_failed:{err}"));
    }
    Err("duality_seed_missing_payload".to_string())
}

fn as_str(value: Option<&Value>) -> String {
    value
        .map(|v| match v {
            Value::String(s) => s.trim().to_string(),
            Value::Null => String::new(),
            _ => v.to_string().trim_matches('"').trim().to_string(),
        })
        .unwrap_or_default()
}

fn as_bool(value: Option<&Value>, fallback: bool) -> bool {
    match value {
        Some(Value::Bool(v)) => *v,
        Some(Value::Number(n)) => n.as_i64().map(|v| v != 0).unwrap_or(fallback),
        Some(Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => fallback,
        },
        _ => fallback,
    }
}

fn as_i64(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn as_f64(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn clean_text(raw: &str, max_len: usize) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_len)
        .collect()
}

fn normalize_token(raw: &str, max_len: usize) -> String {
    let text = clean_text(raw, max_len).to_ascii_lowercase();
    let mut out = String::new();
    let mut prev_sep = false;
    for ch in text.chars() {
        let allowed = ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '/' | '-');
        if allowed {
            out.push(ch);
            prev_sep = false;
        } else if !prev_sep {
            out.push('_');
            prev_sep = true;
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    trimmed.chars().take(max_len).collect()
}

fn normalize_word(raw: &str, max_len: usize) -> String {
    let text = clean_text(raw, max_len).to_ascii_lowercase();
    let mut out = String::new();
    let mut prev_sep = false;
    for ch in text.chars() {
        let allowed = ch.is_ascii_alphanumeric();
        if allowed {
            out.push(ch);
            prev_sep = false;
        } else if !prev_sep {
            out.push('_');
            prev_sep = true;
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    trimmed.chars().take(max_len).collect()
}

fn clamp_i64(value: i64, lo: i64, hi: i64) -> i64 {
    if value < lo {
        lo
    } else if value > hi {
        hi
    } else {
        value
    }
}

fn clamp_f64(value: f64, lo: f64, hi: f64) -> f64 {
    if value < lo {
        lo
    } else if value > hi {
        hi
    } else {
        value
    }
}

fn normalize_trit(value: Option<&Value>) -> i64 {
    let n = as_f64(value).unwrap_or(0.0);
    if n > 0.0 {
        TRIT_OK
    } else if n < 0.0 {
        TRIT_PAIN
    } else {
        TRIT_UNKNOWN
    }
}

fn trit_label(trit: i64) -> &'static str {
    if trit > 0 {
        "ok"
    } else if trit < 0 {
        "pain"
    } else {
        "unknown"
    }
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("duality_seed_create_dir_failed:{}:{err}", parent.display()))?;
    }
    Ok(())
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let temp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    let payload = serde_json::to_string_pretty(value)
        .map_err(|err| format!("duality_seed_encode_json_failed:{err}"))?;
    let mut file = fs::File::create(&temp)
        .map_err(|err| format!("duality_seed_create_tmp_failed:{}:{err}", temp.display()))?;
    file.write_all(payload.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|err| format!("duality_seed_write_tmp_failed:{}:{err}", temp.display()))?;
    fs::rename(&temp, path)
        .map_err(|err| format!("duality_seed_rename_tmp_failed:{}:{err}", path.display()))
}

fn append_jsonl(path: &Path, row: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("duality_seed_open_jsonl_failed:{}:{err}", path.display()))?;
    let line = serde_json::to_string(row)
        .map_err(|err| format!("duality_seed_encode_jsonl_failed:{err}"))?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|err| format!("duality_seed_append_jsonl_failed:{}:{err}", path.display()))
}

fn read_json(path: &Path) -> Value {
    let Ok(raw) = fs::read_to_string(path) else {
        return Value::Null;
    };
    serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null)
}

fn read_text(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn resolve_path(root: &Path, raw: &str, fallback_rel: &str) -> PathBuf {
    let token = clean_text(raw, 400);
    if token.is_empty() {
        return root.join(fallback_rel);
    }
    let candidate = PathBuf::from(token);
    if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
}

fn default_policy(root: &Path) -> Value {
    json!({
        "version": "1.0",
        "enabled": true,
        "shadow_only": true,
        "advisory_only": true,
        "advisory_weight": 0.35,
        "positive_threshold": 0.3,
        "negative_threshold": -0.2,
        "minimum_seed_confidence": 0.25,
        "contradiction_decay_step": 0.04,
        "support_recovery_step": 0.01,
        "max_observation_window": 200,
        "self_validation_interval_minutes": 360,
        "codex_path": root.join(DEFAULT_CODEX_REL).to_string_lossy(),
        "state": {
            "latest_path": root.join(DEFAULT_LATEST_REL).to_string_lossy(),
            "history_path": root.join(DEFAULT_HISTORY_REL).to_string_lossy()
        },
        "integration": {
            "belief_formation": true,
            "inversion_trigger": true,
            "assimilation_candidacy": true,
            "task_decomposition": true,
            "weaver_arbitration": true,
            "heroic_echo_filtering": true
        },
        "outputs": {
            "persist_shadow_receipts": true,
            "persist_observations": true
        }
    })
}

fn load_policy(root: &Path, policy_path_override: Option<&str>) -> Value {
    let policy_path = policy_path_override
        .map(|v| resolve_path(root, v, DEFAULT_POLICY_REL))
        .or_else(|| {
            std::env::var("DUALITY_SEED_POLICY_PATH")
                .ok()
                .as_deref()
                .map(|v| resolve_path(root, v, DEFAULT_POLICY_REL))
        })
        .unwrap_or_else(|| root.join(DEFAULT_POLICY_REL));

    let base = default_policy(root);
    let src = read_json(&policy_path);
    let src_obj = src.as_object().cloned().unwrap_or_default();
    let base_obj = base.as_object().cloned().unwrap_or_default();

    let base_state = base_obj
        .get("state")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let base_integration = base_obj
        .get("integration")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let base_outputs = base_obj
        .get("outputs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let src_state = src_obj
        .get("state")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let src_integration = src_obj
        .get("integration")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let src_outputs = src_obj
        .get("outputs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let codex_path_raw = {
        let candidate = as_str(src_obj.get("codex_path"));
        if candidate.is_empty() {
            as_str(base_obj.get("codex_path"))
        } else {
            candidate
        }
    };

    let latest_path_raw = {
        let candidate = as_str(src_state.get("latest_path"));
        if candidate.is_empty() {
            as_str(base_state.get("latest_path"))
        } else {
            candidate
        }
    };

    let history_path_raw = {
        let candidate = as_str(src_state.get("history_path"));
        if candidate.is_empty() {
            as_str(base_state.get("history_path"))
        } else {
            candidate
        }
    };

    let version = {
        let candidate = as_str(src_obj.get("version"));
        if candidate.is_empty() {
            "1.0".to_string()
        } else {
            candidate
        }
    };

    json!({
        "version": version,
        "enabled": as_bool(src_obj.get("enabled"), as_bool(base_obj.get("enabled"), true)),
        "shadow_only": as_bool(src_obj.get("shadow_only"), as_bool(base_obj.get("shadow_only"), true)),
        "advisory_only": as_bool(src_obj.get("advisory_only"), as_bool(base_obj.get("advisory_only"), true)),
        "advisory_weight": clamp_f64(as_f64(src_obj.get("advisory_weight")).unwrap_or(as_f64(base_obj.get("advisory_weight")).unwrap_or(0.35)), 0.0, 1.0),
        "positive_threshold": clamp_f64(as_f64(src_obj.get("positive_threshold")).unwrap_or(as_f64(base_obj.get("positive_threshold")).unwrap_or(0.3)), -1.0, 1.0),
        "negative_threshold": clamp_f64(as_f64(src_obj.get("negative_threshold")).unwrap_or(as_f64(base_obj.get("negative_threshold")).unwrap_or(-0.2)), -1.0, 1.0),
        "minimum_seed_confidence": clamp_f64(as_f64(src_obj.get("minimum_seed_confidence")).unwrap_or(as_f64(base_obj.get("minimum_seed_confidence")).unwrap_or(0.25)), 0.0, 1.0),
        "contradiction_decay_step": clamp_f64(as_f64(src_obj.get("contradiction_decay_step")).unwrap_or(as_f64(base_obj.get("contradiction_decay_step")).unwrap_or(0.04)), 0.0001, 1.0),
        "support_recovery_step": clamp_f64(as_f64(src_obj.get("support_recovery_step")).unwrap_or(as_f64(base_obj.get("support_recovery_step")).unwrap_or(0.01)), 0.0001, 1.0),
        "max_observation_window": clamp_i64(as_i64(src_obj.get("max_observation_window")).unwrap_or(as_i64(base_obj.get("max_observation_window")).unwrap_or(200)), 10, 20_000),
        "self_validation_interval_minutes": clamp_i64(as_i64(src_obj.get("self_validation_interval_minutes")).unwrap_or(as_i64(base_obj.get("self_validation_interval_minutes")).unwrap_or(360)), 5, 24 * 60),
        "codex_path": resolve_path(root, &codex_path_raw, DEFAULT_CODEX_REL).to_string_lossy(),
        "state": {
            "latest_path": resolve_path(root, &latest_path_raw, DEFAULT_LATEST_REL).to_string_lossy(),
            "history_path": resolve_path(root, &history_path_raw, DEFAULT_HISTORY_REL).to_string_lossy()
        },
        "integration": {
            "belief_formation": as_bool(src_integration.get("belief_formation"), as_bool(base_integration.get("belief_formation"), true)),
            "inversion_trigger": as_bool(src_integration.get("inversion_trigger"), as_bool(base_integration.get("inversion_trigger"), true)),
            "assimilation_candidacy": as_bool(src_integration.get("assimilation_candidacy"), as_bool(base_integration.get("assimilation_candidacy"), true)),
            "task_decomposition": as_bool(src_integration.get("task_decomposition"), as_bool(base_integration.get("task_decomposition"), true)),
            "weaver_arbitration": as_bool(src_integration.get("weaver_arbitration"), as_bool(base_integration.get("weaver_arbitration"), true)),
            "heroic_echo_filtering": as_bool(src_integration.get("heroic_echo_filtering"), as_bool(base_integration.get("heroic_echo_filtering"), true))
        },
        "outputs": {
            "persist_shadow_receipts": as_bool(src_outputs.get("persist_shadow_receipts"), as_bool(base_outputs.get("persist_shadow_receipts"), true)),
            "persist_observations": as_bool(src_outputs.get("persist_observations"), as_bool(base_outputs.get("persist_observations"), true))
        }
    })
}

fn parse_attrs(raw: &str) -> Vec<String> {
    let mut out = Vec::<String>::new();
    let mut seen = BTreeSet::<String>::new();
    for row in raw.split(',') {
        let token = normalize_word(row, 60);
        if token.is_empty() {
            continue;
        }
        if seen.insert(token.clone()) {
            out.push(token);
        }
    }
    out
}

fn default_codex() -> Value {
    json!({
        "version": "1.0",
        "flux_pairs": [
            {
                "yin": "order",
                "yang": "chaos",
                "yin_attrs": ["structure", "stability", "planning", "precision", "discipline"],
                "yang_attrs": ["energy", "variation", "exploration", "adaptation", "novelty"]
            },
            {
                "yin": "logic",
                "yang": "intuition",
                "yin_attrs": ["analysis", "proof", "verification", "determinism"],
                "yang_attrs": ["insight", "creativity", "synthesis", "leap"]
            },
            {
                "yin": "preservation",
                "yang": "transformation",
                "yin_attrs": ["safety", "containment", "resilience"],
                "yang_attrs": ["mutation", "inversion", "breakthrough"]
            }
        ],
        "flow_values": ["life/death", "progression/degression", "creation/decay", "integration/fragmentation"],
        "balance_rules": {
            "positive_balance": "creates_energy",
            "negative_balance": "destroys",
            "extreme_yin": "stagnation",
            "extreme_yang": "unraveling"
        },
        "asymptote": {
            "zero_point": "opposites_flow_into_each_other",
            "harmony": "balanced_interplay_enables_impossible"
        },
        "warnings": [
            "single_pole_optimization_causes_debt",
            "long_extremes_trigger_snapback",
            "protect_constitution_and_user_sovereignty"
        ]
    })
}

fn parse_codex_text(text: &str) -> Value {
    let base = default_codex();
    let base_obj = base.as_object().cloned().unwrap_or_default();

    let mut version = as_str(base_obj.get("version"));
    let mut section = String::new();
    let mut flux_pairs = Vec::<Value>::new();
    let mut flow_values = Vec::<String>::new();
    let mut balance_rules = Map::<String, Value>::new();
    let mut asymptote = Map::<String, Value>::new();
    let mut warnings = Vec::<String>::new();

    for line in text
        .replace('\r', "")
        .lines()
        .map(|row| row.trim().to_string())
        .filter(|row| !row.is_empty() && !row.starts_with('#'))
    {
        if line.starts_with('[') && line.ends_with(']') {
            section = normalize_word(&line[1..line.len() - 1], 80);
            continue;
        }

        if section == "meta" {
            let chunks = line
                .split('=')
                .map(|row| row.trim().to_string())
                .collect::<Vec<_>>();
            if chunks.len() >= 2 && normalize_word(&chunks[0], 40) == "version" {
                version = clean_text(&chunks[1..].join("="), 40);
            }
            continue;
        }

        if section == "flux_pairs" {
            if line.contains('|') {
                let parts = line
                    .split('|')
                    .map(|row| clean_text(row, 160))
                    .collect::<Vec<_>>();
                if parts.len() >= 2 {
                    let yin = normalize_word(&parts[0], 40);
                    let yang = normalize_word(&parts[1], 40);
                    if yin.is_empty() || yang.is_empty() {
                        continue;
                    }
                    let mut yin_attrs = Vec::<String>::new();
                    let mut yang_attrs = Vec::<String>::new();
                    for part in parts.iter().skip(2) {
                        let kv = part
                            .split('=')
                            .map(|row| row.trim().to_string())
                            .collect::<Vec<_>>();
                        if kv.len() < 2 {
                            continue;
                        }
                        let key = normalize_word(&kv[0], 40);
                        let value = kv[1..].join("=");
                        if matches!(key.as_str(), "yin_attrs" | "yin" | "yinattr" | "yinattrs") {
                            yin_attrs = parse_attrs(&value);
                        } else if matches!(
                            key.as_str(),
                            "yang_attrs" | "yang" | "yangattr" | "yangattrs"
                        ) {
                            yang_attrs = parse_attrs(&value);
                        }
                    }
                    flux_pairs.push(json!({
                        "yin": yin,
                        "yang": yang,
                        "yin_attrs": yin_attrs,
                        "yang_attrs": yang_attrs
                    }));
                }
            } else if line.contains("<->") {
                let parts = line
                    .split("<->")
                    .map(|row| normalize_word(row, 40))
                    .filter(|row| !row.is_empty())
                    .collect::<Vec<_>>();
                if parts.len() >= 2 {
                    flux_pairs.push(json!({
                        "yin": parts[0],
                        "yang": parts[1],
                        "yin_attrs": [],
                        "yang_attrs": []
                    }));
                }
            }
            continue;
        }

        if section == "flow_values" {
            if line.contains('/') {
                flow_values.push(clean_text(&line, 120));
            }
            continue;
        }

        if section == "balance_rules" || section == "asymptote" {
            let chunks = if line.contains('=') {
                line.split('=')
                    .map(|row| row.trim().to_string())
                    .collect::<Vec<_>>()
            } else {
                line.split(':')
                    .map(|row| row.trim().to_string())
                    .collect::<Vec<_>>()
            };
            if chunks.len() >= 2 {
                let key = normalize_word(&chunks[0], 64);
                let value = normalize_word(&chunks[1..].join("="), 120);
                if key.is_empty() || value.is_empty() {
                    continue;
                }
                if section == "balance_rules" {
                    balance_rules.insert(key, Value::String(value));
                } else {
                    asymptote.insert(key, Value::String(value));
                }
            }
            continue;
        }

        if section == "warnings" {
            let token = normalize_word(&line, 120);
            if !token.is_empty() {
                warnings.push(token);
            }
            continue;
        }
    }

    json!({
        "version": if version.is_empty() { "1.0".to_string() } else { version },
        "flux_pairs": if flux_pairs.is_empty() {
            base_obj.get("flux_pairs").cloned().unwrap_or_else(|| json!([]))
        } else {
            Value::Array(flux_pairs)
        },
        "flow_values": if flow_values.is_empty() {
            base_obj.get("flow_values").cloned().unwrap_or_else(|| json!([]))
        } else {
            Value::Array(flow_values.into_iter().map(Value::String).collect::<Vec<_>>())
        },
        "balance_rules": if balance_rules.is_empty() {
            base_obj.get("balance_rules").cloned().unwrap_or_else(|| json!({}))
        } else {
            Value::Object(balance_rules)
        },
        "asymptote": if asymptote.is_empty() {
            base_obj.get("asymptote").cloned().unwrap_or_else(|| json!({}))
        } else {
            Value::Object(asymptote)
        },
        "warnings": if warnings.is_empty() {
            base_obj.get("warnings").cloned().unwrap_or_else(|| json!([]))
        } else {
            Value::Array(warnings.into_iter().map(Value::String).collect::<Vec<_>>())
        }
    })
}

fn load_codex(policy: &Value) -> Value {
    let codex_path = policy
        .get("codex_path")
        .map(|v| PathBuf::from(as_str(Some(v))))
        .unwrap_or_else(|| PathBuf::from(DEFAULT_CODEX_REL));
    let text = read_text(&codex_path);
    parse_codex_text(&text)
}

fn default_state() -> Value {
    json!({
        "schema_id": "duality_seed_state",
        "schema_version": "1.0",
        "updated_at": now_iso(),
        "seed_confidence": 1.0,
        "observations_total": 0,
        "contradictions_total": 0,
        "supports_total": 0,
        "neutral_total": 0,
        "consecutive_contradictions": 0,
        "consecutive_supports": 0,
        "observation_window": [],
        "self_validation": {
            "last_run_ts": Value::Null,
            "confidence": 0.0,
            "scenario_count": 0
        }
    })
}

fn load_state(policy: &Value) -> Value {
    let state_path = policy
        .get("state")
        .and_then(Value::as_object)
        .and_then(|obj| obj.get("latest_path"))
        .map(|v| PathBuf::from(as_str(Some(v))))
        .unwrap_or_else(|| PathBuf::from(DEFAULT_LATEST_REL));

    let src = read_json(&state_path);
    if !src.is_object() {
        return default_state();
    }
    let src_obj = src.as_object().cloned().unwrap_or_default();
    let base_obj = default_state().as_object().cloned().unwrap_or_default();

    let mut out = base_obj;
    for (key, value) in src_obj {
        out.insert(key, value);
    }

    out.insert(
        "seed_confidence".to_string(),
        json!(clamp_f64(
            as_f64(out.get("seed_confidence")).unwrap_or(1.0),
            0.0,
            1.0,
        )),
    );
    out.insert(
        "observations_total".to_string(),
        json!(clamp_i64(
            as_i64(out.get("observations_total")).unwrap_or(0),
            0,
            100_000_000
        )),
    );
    out.insert(
        "contradictions_total".to_string(),
        json!(clamp_i64(
            as_i64(out.get("contradictions_total")).unwrap_or(0),
            0,
            100_000_000,
        )),
    );
    out.insert(
        "supports_total".to_string(),
        json!(clamp_i64(
            as_i64(out.get("supports_total")).unwrap_or(0),
            0,
            100_000_000
        )),
    );
    out.insert(
        "neutral_total".to_string(),
        json!(clamp_i64(
            as_i64(out.get("neutral_total")).unwrap_or(0),
            0,
            100_000_000
        )),
    );
    out.insert(
        "consecutive_contradictions".to_string(),
        json!(clamp_i64(
            as_i64(out.get("consecutive_contradictions")).unwrap_or(0),
            0,
            100_000_000,
        )),
    );
    out.insert(
        "consecutive_supports".to_string(),
        json!(clamp_i64(
            as_i64(out.get("consecutive_supports")).unwrap_or(0),
            0,
            100_000_000,
        )),
    );

    if let Some(window) = out.get("observation_window").and_then(Value::as_array) {
        let trimmed = window
            .iter()
            .filter(|row| row.is_object())
            .cloned()
            .rev()
            .take(2000)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>();
        out.insert("observation_window".to_string(), Value::Array(trimmed));
    } else {
        out.insert("observation_window".to_string(), Value::Array(Vec::new()));
    }

    Value::Object(out)
}

fn persist_state(policy: &Value, state: &Value) -> Result<Value, String> {
    let state_path = policy
        .get("state")
        .and_then(Value::as_object)
        .and_then(|obj| obj.get("latest_path"))
        .map(|v| PathBuf::from(as_str(Some(v))))
        .unwrap_or_else(|| PathBuf::from(DEFAULT_LATEST_REL));

    let mut next = default_state().as_object().cloned().unwrap_or_default();
    if let Some(obj) = state.as_object() {
        for (key, value) in obj {
            next.insert(key.clone(), value.clone());
        }
    }
    next.insert("updated_at".to_string(), Value::String(now_iso()));
    let payload = Value::Object(next);
    write_json_atomic(&state_path, &payload)?;
    Ok(payload)
}

fn tokenize_context(context: &Value) -> Vec<String> {
    fn walk(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Null => {}
            Value::Bool(v) => out.push(v.to_string()),
            Value::Number(v) => out.push(v.to_string()),
            Value::String(v) => out.push(v.clone()),
            Value::Array(rows) => {
                for row in rows {
                    walk(row, out);
                }
            }
            Value::Object(obj) => {
                for (key, value) in obj {
                    out.push(key.clone());
                    walk(value, out);
                }
            }
        }
    }

    let mut raw = Vec::<String>::new();
    walk(context, &mut raw);

    let joined = raw.join(" ").to_ascii_lowercase();
    let mut seen = BTreeSet::<String>::new();
    let mut out = Vec::<String>::new();
    for token in joined
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .map(|row| row.trim().to_string())
        .filter(|row| row.len() >= 3)
    {
        if seen.insert(token.clone()) {
            out.push(token);
        }
        if out.len() >= 512 {
            break;
        }
    }
    out
}

fn keyword_sets(codex: &Value) -> (HashSet<String>, HashSet<String>) {
    let mut yin = HashSet::from([
        "order".to_string(),
        "structure".to_string(),
        "stability".to_string(),
        "planning".to_string(),
        "discipline".to_string(),
        "safety".to_string(),
        "containment".to_string(),
        "precision".to_string(),
        "governance".to_string(),
        "control".to_string(),
        "determinism".to_string(),
    ]);
    let mut yang = HashSet::from([
        "chaos".to_string(),
        "energy".to_string(),
        "variation".to_string(),
        "exploration".to_string(),
        "novelty".to_string(),
        "adaptation".to_string(),
        "creativity".to_string(),
        "inversion".to_string(),
        "mutation".to_string(),
        "breakthrough".to_string(),
        "divergence".to_string(),
    ]);

    if let Some(rows) = codex.get("flux_pairs").and_then(Value::as_array) {
        for row in rows {
            let Some(obj) = row.as_object() else {
                continue;
            };
            let yin_token = normalize_word(&as_str(obj.get("yin")), 60);
            let yang_token = normalize_word(&as_str(obj.get("yang")), 60);
            if !yin_token.is_empty() {
                yin.insert(yin_token);
            }
            if !yang_token.is_empty() {
                yang.insert(yang_token);
            }
            if let Some(yin_attrs) = obj.get("yin_attrs").and_then(Value::as_array) {
                for attr in yin_attrs {
                    let token = normalize_word(&as_str(Some(attr)), 60);
                    if !token.is_empty() {
                        yin.insert(token);
                    }
                }
            }
            if let Some(yang_attrs) = obj.get("yang_attrs").and_then(Value::as_array) {
                for attr in yang_attrs {
                    let token = normalize_word(&as_str(Some(attr)), 60);
                    if !token.is_empty() {
                        yang.insert(token);
                    }
                }
            }
        }
    }

    (yin, yang)
}

fn lane_enabled(policy: &Value, lane_raw: &str) -> bool {
    let lane = normalize_token(lane_raw, 120);
    let key = match lane.as_str() {
        "belief_formation" => Some("belief_formation"),
        "inversion_trigger" => Some("inversion_trigger"),
        "assimilation_candidacy" => Some("assimilation_candidacy"),
        "task_decomposition" => Some("task_decomposition"),
        "weaver_arbitration" => Some("weaver_arbitration"),
        "heroic_echo_filtering" => Some("heroic_echo_filtering"),
        _ => None,
    };
    let Some(flag_key) = key else {
        return true;
    };
    let integration = policy
        .get("integration")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    as_bool(integration.get(flag_key), true)
}

fn recommend_adjustment(yin_hits: usize, yang_hits: usize) -> &'static str {
    if yin_hits == 0 && yang_hits == 0 {
        "introduce_balanced_order_and_flux"
    } else if yin_hits > yang_hits {
        "increase_yang_flux"
    } else if yang_hits > yin_hits {
        "increase_yin_order"
    } else {
        "hold_balance_near_zero_point"
    }
}

fn evaluate_signal(
    policy: &Value,
    codex: &Value,
    state: &Value,
    context: &Value,
    opts: &Value,
) -> Value {
    let context_obj = context.as_object().cloned().unwrap_or_default();
    let opts_obj = opts.as_object().cloned().unwrap_or_default();

    let lane = {
        let lane_candidate = as_str(context_obj.get("lane"));
        if !lane_candidate.is_empty() {
            normalize_token(&lane_candidate, 120)
        } else {
            let opt_lane = as_str(opts_obj.get("lane"));
            if !opt_lane.is_empty() {
                normalize_token(&opt_lane, 120)
            } else {
                let path_lane = as_str(context_obj.get("path"));
                if !path_lane.is_empty() {
                    normalize_token(&path_lane, 120)
                } else {
                    "unknown_lane".to_string()
                }
            }
        }
    };

    let run_id = {
        let candidate = as_str(context_obj.get("run_id"));
        if !candidate.is_empty() {
            candidate
        } else {
            let opt = as_str(opts_obj.get("run_id"));
            if opt.is_empty() {
                String::new()
            } else {
                opt
            }
        }
    };

    let source = {
        let candidate = as_str(context_obj.get("source"));
        if !candidate.is_empty() {
            normalize_token(&candidate, 120)
        } else {
            let opt = as_str(opts_obj.get("source"));
            if opt.is_empty() {
                "runtime".to_string()
            } else {
                normalize_token(&opt, 120)
            }
        }
    };

    let lane_is_enabled = lane_enabled(policy, &lane);
    if !as_bool(policy.get("enabled"), true) || !lane_is_enabled {
        return json!({
            "enabled": false,
            "lane": lane,
            "lane_enabled": lane_is_enabled,
            "advisory_only": true,
            "shadow_only": true,
            "score_trit": TRIT_UNKNOWN,
            "score_label": trit_label(TRIT_UNKNOWN),
            "zero_point_harmony_potential": 0.0,
            "recommended_adjustment": "disabled",
            "confidence": 0.0,
            "advisory_weight": 0.0,
            "effective_weight": 0.0,
            "seed_confidence": clamp_f64(as_f64(state.get("seed_confidence")).unwrap_or(1.0), 0.0, 1.0),
            "codex_version": as_str(codex.get("version")),
            "contradiction_tracking": {
                "observations_total": as_i64(state.get("observations_total")).unwrap_or(0),
                "contradictions_total": as_i64(state.get("contradictions_total")).unwrap_or(0)
            },
            "indicator": {
                "yin_yang_bias": "neutral",
                "subtle_hint": "duality_signal_disabled"
            }
        });
    }

    let tokens = tokenize_context(context);
    let (yin_set, yang_set) = keyword_sets(codex);
    let mut yin_hits = 0usize;
    let mut yang_hits = 0usize;
    for token in &tokens {
        if yin_set.contains(token) {
            yin_hits += 1;
        }
        if yang_set.contains(token) {
            yang_hits += 1;
        }
    }

    let total = yin_hits + yang_hits;
    let skew = if total > 0 {
        ((yin_hits as f64) - (yang_hits as f64)).abs() / (total as f64)
    } else {
        0.0
    };
    let harmony = if total > 0 { 1.0 - skew } else { 0.0 };
    let signal_density = (total as f64 / 8.0).min(1.0);

    let balance_score = if yin_hits > 0 && yang_hits > 0 {
        0.2 + (0.8 * harmony * signal_density)
    } else if total > 0 {
        -0.15 - (0.65f64).min((1.0 - harmony) * 0.7)
    } else {
        0.0
    };

    let positive_threshold = as_f64(policy.get("positive_threshold")).unwrap_or(0.3);
    let negative_threshold = as_f64(policy.get("negative_threshold")).unwrap_or(-0.2);

    let score_trit = if balance_score >= positive_threshold {
        TRIT_OK
    } else if balance_score <= negative_threshold {
        TRIT_PAIN
    } else {
        TRIT_UNKNOWN
    };

    let base_confidence = (0.2 + (0.45 * harmony) + (0.35 * signal_density)).min(1.0);
    let seed_confidence = clamp_f64(
        as_f64(state.get("seed_confidence")).unwrap_or(1.0),
        0.0,
        1.0,
    );
    let confidence = clamp_f64(base_confidence * seed_confidence, 0.0, 1.0);
    let advisory_weight = clamp_f64(
        as_f64(policy.get("advisory_weight")).unwrap_or(0.35),
        0.0,
        1.0,
    );
    let effective_weight = clamp_f64(advisory_weight * confidence, 0.0, 1.0);

    let contradiction_rate = {
        let observations = as_i64(state.get("observations_total")).unwrap_or(0) as f64;
        let contradictions = as_i64(state.get("contradictions_total")).unwrap_or(0) as f64;
        if observations > 0.0 {
            (contradictions / observations * 1_000_000.0).round() / 1_000_000.0
        } else {
            0.0
        }
    };

    let codex_version = {
        let v = as_str(codex.get("version"));
        if v.is_empty() {
            "1.0".to_string()
        } else {
            v
        }
    };
    let run_id_value = if run_id.is_empty() {
        Value::Null
    } else {
        Value::String(run_id)
    };

    json!({
        "enabled": true,
        "lane": lane,
        "lane_enabled": true,
        "advisory_only": as_bool(policy.get("advisory_only"), true),
        "shadow_only": as_bool(policy.get("shadow_only"), true),
        "score_trit": score_trit,
        "score_label": trit_label(score_trit),
        "balance_score": (balance_score * 1_000_000.0).round() / 1_000_000.0,
        "zero_point_harmony_potential": (harmony * 1_000_000.0).round() / 1_000_000.0,
        "recommended_adjustment": recommend_adjustment(yin_hits, yang_hits),
        "confidence": (confidence * 1_000_000.0).round() / 1_000_000.0,
        "advisory_weight": (advisory_weight * 1_000_000.0).round() / 1_000_000.0,
        "effective_weight": (effective_weight * 1_000_000.0).round() / 1_000_000.0,
        "seed_confidence": (seed_confidence * 1_000_000.0).round() / 1_000_000.0,
        "codex_version": codex_version,
        "codex_summary": {
            "flux_pairs": codex.get("flux_pairs").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0),
            "flow_values": codex.get("flow_values").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0),
            "warnings": codex.get("warnings").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0)
        },
        "diagnostics": {
            "token_count": tokens.len(),
            "yin_hits": yin_hits,
            "yang_hits": yang_hits,
            "signal_density": (signal_density * 1_000_000.0).round() / 1_000_000.0,
            "source": source
        },
        "indicator": {
            "yin_yang_bias": if yin_hits > yang_hits {
                "yin_lean"
            } else if yang_hits > yin_hits {
                "yang_lean"
            } else {
                "balanced"
            },
            "subtle_hint": if harmony >= 0.75 {
                "near_zero_point_harmony"
            } else if harmony >= 0.45 {
                "partial_balance"
            } else {
                "high_imbalance"
            }
        },
        "zero_point_insight": if harmony >= 0.75 {
            "opposites currently reinforce each other near the 0-point"
        } else {
            "rebalance order/flux before escalating decisions"
        },
        "contradiction_tracking": {
            "observations_total": as_i64(state.get("observations_total")).unwrap_or(0),
            "contradictions_total": as_i64(state.get("contradictions_total")).unwrap_or(0),
            "contradiction_rate": contradiction_rate
        },
        "run_id": run_id_value
    })
}

fn maybe_run_self_validation(
    policy: &Value,
    state: &Value,
    policy_path: Option<&str>,
) -> Result<Value, String> {
    let interval_minutes = clamp_i64(
        as_i64(policy.get("self_validation_interval_minutes")).unwrap_or(360),
        5,
        24 * 60,
    );
    let last_run_ts = state
        .get("self_validation")
        .and_then(Value::as_object)
        .and_then(|obj| obj.get("last_run_ts"))
        .map(|v| as_str(Some(v)))
        .unwrap_or_default();

    let due = if last_run_ts.is_empty() {
        true
    } else {
        let last_run_ms = chrono::DateTime::parse_from_rfc3339(&last_run_ts)
            .ok()
            .map(|ts| ts.timestamp_millis())
            .unwrap_or(0);
        let now_ms = chrono::Utc::now().timestamp_millis();
        (now_ms - last_run_ms) >= (interval_minutes * 60 * 1000)
    };

    if !due {
        return Ok(state.clone());
    }

    let scenarios = vec![
        (
            "balanced_context",
            json!({
                "lane": "self_validation",
                "objective": "keep order and exploration in harmony with safety and creativity"
            }),
            TRIT_OK,
        ),
        (
            "yin_extreme_context",
            json!({
                "lane": "self_validation",
                "objective": "maximize rigid structure and strict control without adaptation"
            }),
            TRIT_PAIN,
        ),
        (
            "yang_extreme_context",
            json!({
                "lane": "self_validation",
                "objective": "maximize mutation and chaos without constraints or stability"
            }),
            TRIT_PAIN,
        ),
    ];

    let codex = load_codex(policy);
    let mut rows = Vec::<Value>::new();
    for (id, context, expected) in scenarios {
        let out = evaluate_signal(
            policy,
            &codex,
            state,
            &context,
            &json!({
                "source": "duality_self_validation",
                "lane": "self_validation"
            }),
        );
        let predicted = normalize_trit(out.get("score_trit"));
        let pass = predicted == expected || (expected != TRIT_OK && predicted == TRIT_UNKNOWN);
        rows.push(json!({
            "scenario_id": id,
            "expected_trit": expected,
            "predicted_trit": predicted,
            "pass": pass
        }));
    }

    let pass_count = rows
        .iter()
        .filter(|row| row.get("pass").and_then(Value::as_bool) == Some(true))
        .count();
    let confidence = pass_count as f64 / (rows.len().max(1) as f64);
    let ts = now_iso();

    let mut next = state.as_object().cloned().unwrap_or_default();
    next.insert(
        "self_validation".to_string(),
        json!({
            "last_run_ts": ts,
            "confidence": (confidence * 1_000_000.0).round() / 1_000_000.0,
            "scenario_count": rows.len()
        }),
    );

    let persisted = persist_state(policy, &Value::Object(next))?;

    let history_path = policy
        .get("state")
        .and_then(Value::as_object)
        .and_then(|obj| obj.get("history_path"))
        .map(|v| PathBuf::from(as_str(Some(v))))
        .unwrap_or_else(|| PathBuf::from(DEFAULT_HISTORY_REL));

    append_jsonl(
        &history_path,
        &json!({
            "ts": ts,
            "type": "duality_self_validation",
            "confidence": (confidence * 1_000_000.0).round() / 1_000_000.0,
            "pass_count": pass_count,
            "scenario_count": rows.len(),
            "scenarios": rows,
            "seed_confidence": as_f64(persisted.get("seed_confidence")).unwrap_or(1.0)
        }),
    )?;

    let _ = policy_path;
    Ok(persisted)
}

fn op_dispatch(root: &Path, op: &str, args: Option<&Value>) -> Result<Value, String> {
    let args_obj = args.and_then(Value::as_object).cloned().unwrap_or_default();
    let policy_path = as_str(args_obj.get("policy_path"));
    let policy = load_policy(
        root,
        if policy_path.is_empty() {
            None
        } else {
            Some(policy_path.as_str())
        },
    );

    match op {
        "loadDualityPolicy" => Ok(policy),
        "parseDualityCodexText" => {
            let text = as_str(args_obj.get("text"));
            Ok(parse_codex_text(&text))
        }
        "loadDualityCodex" => Ok(load_codex(&policy)),
        "loadDualityState" => Ok(load_state(&policy)),
        "evaluateDualitySignal" | "duality_evaluate" => {
            let state = load_state(&policy);
            let opts = args_obj.get("opts").cloned().unwrap_or_else(|| json!({}));
            let skip_validation = as_bool(opts.get("skip_validation"), false);
            let state_after_validation = if skip_validation {
                state.clone()
            } else {
                maybe_run_self_validation(
                    &policy,
                    &state,
                    if policy_path.is_empty() {
                        None
                    } else {
                        Some(policy_path.as_str())
                    },
                )?
            };
            let context = args_obj
                .get("context")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let out = evaluate_signal(
                &policy,
                &load_codex(&policy),
                &state_after_validation,
                &context,
                &opts,
            );

            if as_bool(opts.get("persist"), false)
                && as_bool(
                    policy
                        .get("outputs")
                        .and_then(Value::as_object)
                        .and_then(|obj| obj.get("persist_shadow_receipts")),
                    true,
                )
            {
                let history_path = policy
                    .get("state")
                    .and_then(Value::as_object)
                    .and_then(|obj| obj.get("history_path"))
                    .map(|v| PathBuf::from(as_str(Some(v))))
                    .unwrap_or_else(|| PathBuf::from(DEFAULT_HISTORY_REL));
                append_jsonl(
                    &history_path,
                    &json!({
                        "ts": now_iso(),
                        "type": "duality_evaluation",
                        "lane": out.get("lane").cloned().unwrap_or(Value::Null),
                        "run_id": out.get("run_id").cloned().unwrap_or(Value::Null),
                        "source": out
                            .get("diagnostics")
                            .and_then(Value::as_object)
                            .and_then(|obj| obj.get("source"))
                            .cloned()
                            .unwrap_or(Value::Null),
                        "score_trit": out.get("score_trit").cloned().unwrap_or(Value::Null),
                        "balance_score": out.get("balance_score").cloned().unwrap_or(Value::Null),
                        "zero_point_harmony_potential": out
                            .get("zero_point_harmony_potential")
                            .cloned()
                            .unwrap_or(Value::Null),
                        "confidence": out.get("confidence").cloned().unwrap_or(Value::Null),
                        "effective_weight": out.get("effective_weight").cloned().unwrap_or(Value::Null),
                        "recommended_adjustment": out
                            .get("recommended_adjustment")
                            .cloned()
                            .unwrap_or(Value::Null)
                    }),
                )?;
            }

            Ok(out)
        }
        "registerDualityObservation" => {
            let state = load_state(&policy);
            let input = args_obj.get("input").cloned().unwrap_or_else(|| json!({}));
            let input_obj = input.as_object().cloned().unwrap_or_default();

            let predicted = normalize_trit(input_obj.get("predicted_trit"));
            let observed = normalize_trit(input_obj.get("observed_trit"));
            let lane = normalize_token(&as_str(input_obj.get("lane")), 120);
            let lane = if lane.is_empty() {
                "unknown_lane".to_string()
            } else {
                lane
            };
            let run_id = {
                let v = as_str(input_obj.get("run_id"));
                if v.is_empty() {
                    Value::Null
                } else {
                    Value::String(v)
                }
            };
            let source = {
                let v = normalize_token(&as_str(input_obj.get("source")), 120);
                if v.is_empty() {
                    "runtime".to_string()
                } else {
                    v
                }
            };

            let contradiction = predicted != 0 && observed != 0 && predicted != observed;
            let support = predicted != 0 && observed != 0 && predicted == observed;
            let neutral = !contradiction && !support;

            let min_seed_confidence = clamp_f64(
                as_f64(policy.get("minimum_seed_confidence")).unwrap_or(0.25),
                0.0,
                1.0,
            );
            let decay_step = clamp_f64(
                as_f64(policy.get("contradiction_decay_step")).unwrap_or(0.04),
                0.0001,
                1.0,
            );
            let recovery_step = clamp_f64(
                as_f64(policy.get("support_recovery_step")).unwrap_or(0.01),
                0.0001,
                1.0,
            );

            let mut seed_confidence = clamp_f64(
                as_f64(state.get("seed_confidence")).unwrap_or(1.0),
                0.0,
                1.0,
            );
            let mut consecutive_contradictions =
                as_i64(state.get("consecutive_contradictions")).unwrap_or(0);
            let mut consecutive_supports = as_i64(state.get("consecutive_supports")).unwrap_or(0);

            if contradiction {
                consecutive_contradictions += 1;
                consecutive_supports = 0;
                let dynamic =
                    decay_step * (1.0 + ((consecutive_contradictions.min(12) as f64) * 0.12));
                seed_confidence = (seed_confidence - dynamic).max(min_seed_confidence);
            } else if support {
                consecutive_supports += 1;
                consecutive_contradictions = 0;
                let dynamic =
                    recovery_step * (1.0 + ((consecutive_supports.min(12) as f64) * 0.06));
                seed_confidence = (seed_confidence + dynamic).min(1.0);
            } else {
                consecutive_contradictions = 0;
                consecutive_supports = 0;
            }

            let ts = now_iso();
            let observation = json!({
                "ts": ts,
                "lane": lane,
                "run_id": run_id,
                "source": source,
                "predicted_trit": predicted,
                "observed_trit": observed,
                "contradiction": contradiction,
                "support": support,
                "neutral": neutral
            });

            let max_window = clamp_i64(
                as_i64(policy.get("max_observation_window")).unwrap_or(200),
                10,
                20_000,
            ) as usize;
            let mut window = state
                .get("observation_window")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if window.len() >= max_window {
                let keep = max_window.saturating_sub(1);
                window = window
                    .into_iter()
                    .rev()
                    .take(keep)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
            }
            window.push(observation.clone());

            let mut next = state.as_object().cloned().unwrap_or_default();
            next.insert(
                "seed_confidence".to_string(),
                json!((seed_confidence * 1_000_000.0).round() / 1_000_000.0),
            );
            next.insert(
                "observations_total".to_string(),
                json!(as_i64(state.get("observations_total")).unwrap_or(0) + 1),
            );
            next.insert(
                "contradictions_total".to_string(),
                json!(
                    as_i64(state.get("contradictions_total")).unwrap_or(0)
                        + if contradiction { 1 } else { 0 }
                ),
            );
            next.insert(
                "supports_total".to_string(),
                json!(
                    as_i64(state.get("supports_total")).unwrap_or(0) + if support { 1 } else { 0 }
                ),
            );
            next.insert(
                "neutral_total".to_string(),
                json!(
                    as_i64(state.get("neutral_total")).unwrap_or(0) + if neutral { 1 } else { 0 }
                ),
            );
            next.insert(
                "consecutive_contradictions".to_string(),
                json!(consecutive_contradictions),
            );
            next.insert(
                "consecutive_supports".to_string(),
                json!(consecutive_supports),
            );
            next.insert("observation_window".to_string(), Value::Array(window));

            let persisted = persist_state(&policy, &Value::Object(next))?;

            if as_bool(
                policy
                    .get("outputs")
                    .and_then(Value::as_object)
                    .and_then(|obj| obj.get("persist_observations")),
                true,
            ) {
                let history_path = policy
                    .get("state")
                    .and_then(Value::as_object)
                    .and_then(|obj| obj.get("history_path"))
                    .map(|v| PathBuf::from(as_str(Some(v))))
                    .unwrap_or_else(|| PathBuf::from(DEFAULT_HISTORY_REL));

                append_jsonl(
                    &history_path,
                    &json!({
                        "ts": ts,
                        "type": "duality_observation",
                        "lane": lane,
                        "run_id": observation.get("run_id").cloned().unwrap_or(Value::Null),
                        "source": source,
                        "predicted_trit": predicted,
                        "observed_trit": observed,
                        "contradiction": contradiction,
                        "support": support,
                        "seed_confidence": persisted.get("seed_confidence").cloned().unwrap_or(Value::Null)
                    }),
                )?;
            }

            Ok(json!({
                "ok": true,
                "type": "duality_observation",
                "lane": lane,
                "contradiction": contradiction,
                "support": support,
                "neutral": neutral,
                "seed_confidence": persisted.get("seed_confidence").cloned().unwrap_or(Value::Null),
                "observations_total": persisted.get("observations_total").cloned().unwrap_or(Value::Null),
                "contradictions_total": persisted.get("contradictions_total").cloned().unwrap_or(Value::Null)
            }))
        }
        "quarantineDualitySeed" => {
            let state = load_state(&policy);
            let input = args_obj.get("input").cloned().unwrap_or_else(|| json!({}));
            let input_obj = input.as_object().cloned().unwrap_or_default();
            let reason = {
                let value = as_str(input_obj.get("reason"));
                if value.is_empty() {
                    "quarantine_requested".to_string()
                } else {
                    clean_text(&value, 220)
                }
            };
            let actor = {
                let value = normalize_token(&as_str(input_obj.get("actor")), 120);
                if value.is_empty() {
                    "unknown_actor".to_string()
                } else {
                    value
                }
            };
            let min_seed = as_f64(policy.get("minimum_seed_confidence")).unwrap_or(0.25);
            let requested_seed = as_f64(input_obj.get("seed_confidence")).unwrap_or(min_seed);
            let ts = now_iso();

            let mut next = state.as_object().cloned().unwrap_or_default();
            next.insert(
                "seed_confidence".to_string(),
                json!(clamp_f64(requested_seed, 0.0, 1.0)),
            );
            next.insert(
                "quarantine".to_string(),
                json!({
                    "active": true,
                    "ts": ts,
                    "reason": reason,
                    "actor": actor
                }),
            );

            let persisted = persist_state(&policy, &Value::Object(next))?;
            let history_path = policy
                .get("state")
                .and_then(Value::as_object)
                .and_then(|obj| obj.get("history_path"))
                .map(|v| PathBuf::from(as_str(Some(v))))
                .unwrap_or_else(|| PathBuf::from(DEFAULT_HISTORY_REL));

            append_jsonl(
                &history_path,
                &json!({
                    "ts": ts,
                    "type": "duality_seed_quarantine",
                    "reason": reason,
                    "actor": actor,
                    "seed_confidence": persisted.get("seed_confidence").cloned().unwrap_or(Value::Null)
                }),
            )?;

            Ok(json!({
                "ok": true,
                "type": "duality_seed_quarantine",
                "ts": ts,
                "reason": reason,
                "actor": actor,
                "seed_confidence": persisted.get("seed_confidence").cloned().unwrap_or(Value::Null)
            }))
        }
        "maybeRunSelfValidation" => {
            let state = load_state(&policy);
            let out = maybe_run_self_validation(
                &policy,
                &state,
                if policy_path.is_empty() {
                    None
                } else {
                    Some(policy_path.as_str())
                },
            )?;
            Ok(out)
        }
        _ => Err(format!("duality_seed_unknown_op:{op}")),
    }
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let cmd = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(cmd.as_str(), "help" | "--help" | "-h") {
        println!("Usage:");
        println!("  protheus-ops duality-seed status");
        println!("  protheus-ops duality-seed invoke --payload=<json>");
        return 0;
    }

    if cmd == "status" {
        let mut out = json!({
            "ok": true,
            "type": "duality_seed_status",
            "authority": "core/layer2/autonomy",
            "commands": ["status", "invoke"],
            "default_policy_path": DEFAULT_POLICY_REL,
            "default_codex_path": DEFAULT_CODEX_REL,
            "default_latest_state_path": DEFAULT_LATEST_REL,
            "default_history_path": DEFAULT_HISTORY_REL,
            "ts": now_iso(),
            "root": clean(root.display(), 280)
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        print_json_line(&out);
        return 0;
    }

    if cmd != "invoke" {
        let mut out = json!({
            "ok": false,
            "type": "duality_seed_cli_error",
            "authority": "core/layer2/autonomy",
            "command": cmd,
            "error": "unknown_command",
            "ts": now_iso(),
            "exit_code": 2
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        print_json_line(&out);
        return 2;
    }

    let payload = match load_payload(argv) {
        Ok(value) => value,
        Err(err) => {
            let mut out = json!({
                "ok": false,
                "type": "duality_seed_cli_error",
                "authority": "core/layer2/autonomy",
                "command": "invoke",
                "error": err,
                "ts": now_iso(),
                "exit_code": 2
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            print_json_line(&out);
            return 2;
        }
    };

    let op = payload
        .get("op")
        .map(|v| as_str(Some(v)))
        .filter(|v| !v.is_empty())
        .unwrap_or_default();

    let result = op_dispatch(root, op.as_str(), payload.get("args"));
    match result {
        Ok(result_value) => {
            let mut out = json!({
                "ok": true,
                "type": "duality_seed",
                "authority": "core/layer2/autonomy",
                "command": "invoke",
                "op": op,
                "result": result_value,
                "ts": now_iso(),
                "root": clean(root.display(), 280)
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            print_json_line(&out);
            0
        }
        Err(err) => {
            let mut out = json!({
                "ok": false,
                "type": "duality_seed",
                "authority": "core/layer2/autonomy",
                "command": "invoke",
                "op": op,
                "error": err,
                "ts": now_iso(),
                "exit_code": 2
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            print_json_line(&out);
            2
        }
    }
}
