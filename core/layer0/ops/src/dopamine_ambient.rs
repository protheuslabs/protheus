// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone)]
struct DopamineAmbientPolicy {
    enabled: bool,
    threshold_breach_only: bool,
    surface_levels: Vec<String>,
    push_attention_queue: bool,
    latest_path: PathBuf,
    receipts_path: PathBuf,
    runtime_script: PathBuf,
    status_path: PathBuf,
    history_path: PathBuf,
    policy_path: PathBuf,
}

fn usage() {
    eprintln!("Usage:");
    eprintln!(
        "  protheus-ops dopamine-ambient closeout [--date=YYYY-MM-DD] [--run-context=<value>]"
    );
    eprintln!("  protheus-ops dopamine-ambient status [--date=YYYY-MM-DD] [--run-context=<value>]");
    eprintln!("  protheus-ops dopamine-ambient evaluate --summary-json=<json>|--summary-json-base64=<base64> [--date=YYYY-MM-DD] [--run-context=<value>]");
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut raw) = serde_json::to_string_pretty(value) {
        raw.push('\n');
        let _ = fs::write(path, raw);
    }
}

fn append_jsonl(path: &Path, row: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(line) = serde_json::to_string(row) {
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| {
                std::io::Write::write_all(&mut file, format!("{line}\n").as_bytes())
            });
    }
}

fn parse_cli_flags(argv: &[String]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut i = 0usize;
    while i < argv.len() {
        let token = argv[i].trim();
        if !token.starts_with("--") {
            i += 1;
            continue;
        }
        if let Some((k, v)) = token.split_once('=') {
            out.insert(k.trim_start_matches("--").to_string(), v.to_string());
            i += 1;
            continue;
        }
        let key = token.trim_start_matches("--").to_string();
        if let Some(next) = argv.get(i + 1) {
            if !next.starts_with("--") {
                out.insert(key, next.clone());
                i += 2;
                continue;
            }
        }
        out.insert(key, "true".to_string());
        i += 1;
    }
    out
}

fn bool_from_env(name: &str) -> Option<bool> {
    let raw = std::env::var(name).ok()?;
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn clean_text(value: Option<&str>, max_len: usize) -> String {
    let mut out = String::new();
    if let Some(raw) = value {
        for ch in raw.split_whitespace().collect::<Vec<_>>().join(" ").chars() {
            if out.len() >= max_len {
                break;
            }
            out.push(ch);
        }
    }
    out.trim().to_string()
}

fn normalize_path(root: &Path, value: Option<&Value>, fallback: &str) -> PathBuf {
    let raw = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback);
    let candidate = PathBuf::from(raw);
    if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
}

fn normalize_date(raw: Option<&str>) -> String {
    let value = clean_text(raw, 40);
    if value.len() == 10 && value.chars().nth(4) == Some('-') && value.chars().nth(7) == Some('-') {
        return value;
    }
    now_iso()[..10].to_string()
}

fn parse_json_payload(stdout: &str) -> Option<Value> {
    let raw = stdout.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(payload) = serde_json::from_str::<Value>(raw) {
        return Some(payload);
    }
    for line in raw.lines().rev() {
        let trimmed = line.trim();
        if !trimmed.starts_with('{') {
            continue;
        }
        if let Ok(payload) = serde_json::from_str::<Value>(trimmed) {
            return Some(payload);
        }
    }
    None
}

fn load_policy(root: &Path) -> DopamineAmbientPolicy {
    let default_policy = root.join("config").join("mech_suit_mode_policy.json");
    let policy_path = std::env::var("MECH_SUIT_MODE_POLICY_PATH")
        .ok()
        .map(PathBuf::from)
        .map(|p| if p.is_absolute() { p } else { root.join(p) })
        .unwrap_or(default_policy);
    let policy = read_json(&policy_path).unwrap_or_else(|| json!({}));
    let enabled = bool_from_env("MECH_SUIT_MODE_FORCE").unwrap_or_else(|| {
        policy
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true)
    });
    let eyes = policy.get("eyes");
    let dopamine = policy.get("dopamine");
    let state = policy.get("state");

    let surface_levels = dopamine
        .and_then(|v| v.get("surface_levels"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|row| row.trim().to_ascii_lowercase())
                .filter(|row| matches!(row.as_str(), "critical" | "warn" | "info"))
                .collect::<Vec<_>>()
        })
        .filter(|rows| !rows.is_empty())
        .unwrap_or_else(|| vec!["warn".to_string(), "critical".to_string()]);

    DopamineAmbientPolicy {
        enabled,
        threshold_breach_only: dopamine
            .and_then(|v| v.get("threshold_breach_only"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        surface_levels,
        push_attention_queue: eyes
            .and_then(|v| v.get("push_attention_queue"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        latest_path: normalize_path(
            root,
            dopamine.and_then(|v| v.get("latest_path")),
            "state/dopamine/ambient/latest.json",
        ),
        receipts_path: normalize_path(
            root,
            dopamine.and_then(|v| v.get("receipts_path")),
            "state/dopamine/ambient/receipts.jsonl",
        ),
        runtime_script: normalize_path(
            root,
            dopamine.and_then(|v| v.get("runtime_script")),
            "client/habits/scripts/dopamine_ambient_snapshot.js",
        ),
        status_path: normalize_path(
            root,
            state.and_then(|v| v.get("status_path")),
            "state/ops/mech_suit_mode/latest.json",
        ),
        history_path: normalize_path(
            root,
            state.and_then(|v| v.get("history_path")),
            "state/ops/mech_suit_mode/history.jsonl",
        ),
        policy_path,
    }
}

fn summary_number(summary: &Value, key: &str) -> f64 {
    if let Some(n) = summary.get(key).and_then(Value::as_f64) {
        return n;
    }
    if let Some(n) = summary.get(key).and_then(Value::as_i64) {
        return n as f64;
    }
    if let Some(n) = summary.get(key).and_then(Value::as_u64) {
        return n as f64;
    }
    0.0
}

fn classify_threshold(summary: &Value) -> (String, bool, Vec<String>) {
    let mut reasons = Vec::<String>::new();
    let directive_pain_active = summary
        .get("directive_pain")
        .and_then(|v| v.get("active"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let sds = summary_number(summary, "sds");
    let drift_minutes = summary_number(summary, "drift_minutes");

    if directive_pain_active {
        reasons.push("directive_pain_active".to_string());
    }
    if sds <= 0.0 {
        reasons.push("sds_non_positive".to_string());
    }
    if drift_minutes >= 120.0 {
        reasons.push("drift_over_threshold".to_string());
    }

    let severity = if directive_pain_active {
        "critical"
    } else if sds <= 0.0 || drift_minutes >= 120.0 {
        "warn"
    } else {
        "info"
    };
    (severity.to_string(), !reasons.is_empty(), reasons)
}

fn parse_summary_from_flags(flags: &BTreeMap<String, String>) -> Result<Option<Value>, String> {
    if let Some(raw) = flags.get("summary-json-base64") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw.as_bytes())
            .map_err(|err| format!("summary_json_base64_invalid:{err}"))?;
        let text =
            String::from_utf8(bytes).map_err(|err| format!("summary_json_utf8_invalid:{err}"))?;
        let summary = serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("summary_json_invalid:{err}"))?;
        return Ok(Some(summary));
    }
    if let Some(raw) = flags.get("summary-json") {
        let summary = serde_json::from_str::<Value>(raw)
            .map_err(|err| format!("summary_json_invalid:{err}"))?;
        return Ok(Some(summary));
    }
    Ok(None)
}

fn parse_snapshot_summary(snapshot: &Value) -> Value {
    snapshot
        .get("summary")
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn parse_string_array(value: Option<&Value>, max_items: usize, max_len: usize) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|row| clean_text(Some(row), max_len))
                .filter(|row| !row.is_empty())
                .take(max_items)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn parse_optional_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(|v| {
        if let Some(n) = v.as_f64() {
            return Some(n);
        }
        if let Some(n) = v.as_i64() {
            return Some(n as f64);
        }
        if let Some(n) = v.as_u64() {
            return Some(n as f64);
        }
        None
    })
}

fn load_cached_status_from_latest(
    latest: &Value,
) -> Option<(Value, String, bool, Vec<String>, f64)> {
    if !latest.is_object() {
        return None;
    }

    let summary = latest
        .get("summary")
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let (inferred_severity, inferred_breached, inferred_reasons) = classify_threshold(&summary);
    let cached_severity =
        clean_text(latest.get("severity").and_then(Value::as_str), 20).to_ascii_lowercase();
    let severity = if matches!(cached_severity.as_str(), "critical" | "warn" | "info") {
        cached_severity
    } else {
        inferred_severity
    };
    let breached = latest
        .get("threshold_breached")
        .and_then(Value::as_bool)
        .unwrap_or(inferred_breached);
    let reasons = {
        let parsed = parse_string_array(latest.get("breach_reasons"), 12, 80);
        if parsed.is_empty() {
            inferred_reasons
        } else {
            parsed
        }
    };
    let sds =
        parse_optional_number(latest.get("sds")).unwrap_or_else(|| summary_number(&summary, "sds"));

    Some((summary, severity, breached, reasons, sds))
}

fn run_snapshot(
    root: &Path,
    policy: &DopamineAmbientPolicy,
    mode: &str,
    date: &str,
) -> Result<Value, String> {
    let node = std::env::var("PROTHEUS_NODE_BINARY")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "node".to_string());
    let output = Command::new(node)
        .arg(policy.runtime_script.to_string_lossy().to_string())
        .arg(mode)
        .arg(format!("--date={date}"))
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| format!("dopamine_runtime_spawn_failed:{err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!(
            "dopamine_runtime_failed:{}:{}",
            output.status.code().unwrap_or(1),
            clean_text(Some(&stderr), 180)
        ));
    }
    parse_json_payload(&stdout).ok_or_else(|| {
        format!(
            "dopamine_runtime_invalid_json:{}",
            clean_text(Some(&stdout), 180)
        )
    })
}

fn resolve_protheus_ops_command(root: &PathBuf, domain: &str) -> (String, Vec<String>) {
    if let Some(bin) = std::env::var("PROTHEUS_OPS_BIN").ok() {
        let trimmed = bin.trim();
        if !trimmed.is_empty() {
            return (trimmed.to_string(), vec![domain.to_string()]);
        }
    }

    let release = root.join("target").join("release").join("protheus-ops");
    if release.exists() {
        return (
            release.to_string_lossy().to_string(),
            vec![domain.to_string()],
        );
    }
    let debug = root.join("target").join("debug").join("protheus-ops");
    if debug.exists() {
        return (
            debug.to_string_lossy().to_string(),
            vec![domain.to_string()],
        );
    }

    (
        "cargo".to_string(),
        vec![
            "run".to_string(),
            "--quiet".to_string(),
            "--manifest-path".to_string(),
            "core/layer0/ops/Cargo.toml".to_string(),
            "--bin".to_string(),
            "protheus-ops".to_string(),
            "--".to_string(),
            domain.to_string(),
        ],
    )
}

fn enqueue_attention(
    root: &Path,
    summary: &Value,
    severity: &str,
    breach_reasons: &[String],
    date: &str,
    run_context: &str,
) -> Result<Value, String> {
    let sds = summary_number(summary, "sds");
    let summary_line = format!(
        "dopamine threshold breach ({severity}) sds={:.2} reasons={}",
        sds,
        if breach_reasons.is_empty() {
            "none".to_string()
        } else {
            breach_reasons.join(",")
        }
    );
    let event = json!({
        "ts": now_iso(),
        "source": "dopamine_ambient",
        "source_type": "dopamine_threshold_breach",
        "severity": severity,
        "summary": summary_line,
        "attention_key": format!("dopamine:{date}:{severity}:{:.0}", sds * 100.0),
        "breach_reasons": breach_reasons,
        "sds": sds,
        "date": date
    });
    let payload = serde_json::to_string(&event)
        .map_err(|err| format!("attention_event_encode_failed:{err}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(payload.as_bytes());
    let root_buf = root.to_path_buf();
    let (command, mut args) = resolve_protheus_ops_command(&root_buf, "attention-queue");
    args.push("enqueue".to_string());
    args.push(format!("--event-json-base64={encoded}"));
    args.push(format!("--run-context={run_context}"));

    let output = Command::new(command)
        .args(args)
        .current_dir(root)
        .env(
            "PROTHEUS_NODE_BINARY",
            std::env::var("PROTHEUS_NODE_BINARY").unwrap_or_else(|_| "node".to_string()),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| format!("attention_queue_spawn_failed:{err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let receipt = parse_json_payload(&stdout).unwrap_or_else(|| json!({}));
    let mut out = json!({
        "ok": output.status.success(),
        "routed_via": "rust_attention_queue",
        "exit_code": output.status.code().unwrap_or(1),
        "decision": receipt.get("decision").and_then(Value::as_str).unwrap_or("unknown"),
        "queued": receipt.get("queued").and_then(Value::as_bool).unwrap_or(false),
        "receipt": receipt
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));

    if output.status.success() {
        Ok(out)
    } else {
        Err(format!(
            "attention_queue_failed:{}:{}",
            output.status.code().unwrap_or(1),
            clean_text(Some(&stderr), 180)
        ))
    }
}

fn update_mech_suit_status(policy: &DopamineAmbientPolicy, patch: Value) {
    let mut latest = read_json(&policy.status_path).unwrap_or_else(|| {
        json!({
            "ts": Value::Null,
            "active": policy.enabled,
            "components": {}
        })
    });
    if !latest.is_object() {
        latest = json!({
            "ts": Value::Null,
            "active": policy.enabled,
            "components": {}
        });
    }
    latest["ts"] = Value::String(now_iso());
    latest["active"] = Value::Bool(policy.enabled);
    if !latest
        .get("components")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        latest["components"] = json!({});
    }
    latest["policy_path"] = Value::String(policy.policy_path.to_string_lossy().to_string());
    latest["components"]["dopamine"] = patch.clone();
    write_json(&policy.status_path, &latest);

    append_jsonl(
        &policy.history_path,
        &json!({
            "ts": now_iso(),
            "type": "mech_suit_status",
            "component": "dopamine",
            "active": policy.enabled,
            "patch": patch
        }),
    );
}

fn should_surface(
    policy: &DopamineAmbientPolicy,
    command: &str,
    severity: &str,
    breached: bool,
) -> bool {
    if command == "status" {
        return false;
    }
    if !policy
        .surface_levels
        .iter()
        .any(|level| level.as_str() == severity)
    {
        return false;
    }
    if policy.threshold_breach_only && !breached {
        return false;
    }
    true
}

fn cli_error_receipt(command: &str, reason: &str, date: &str, exit_code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "dopamine_ambient_error",
        "ts": now_iso(),
        "command": command,
        "date": date,
        "reason": reason,
        "exit_code": exit_code
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    if argv.is_empty() {
        usage();
        let receipt = cli_error_receipt("unknown", "missing_command", &now_iso()[..10], 2);
        println!(
            "{}",
            serde_json::to_string(&receipt).unwrap_or_else(|_| "{\"ok\":false}".to_string())
        );
        return 2;
    }
    let command = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(command.as_str(), "closeout" | "status" | "evaluate") {
        usage();
        let receipt = cli_error_receipt(&command, "unknown_command", &now_iso()[..10], 2);
        println!(
            "{}",
            serde_json::to_string(&receipt).unwrap_or_else(|_| "{\"ok\":false}".to_string())
        );
        return 2;
    }

    let flags = parse_cli_flags(&argv.iter().skip(1).cloned().collect::<Vec<_>>());
    let date = normalize_date(flags.get("date").map(String::as_str));
    let run_context = clean_text(flags.get("run-context").map(String::as_str), 40);
    let run_context = if run_context.is_empty() {
        "dopamine".to_string()
    } else {
        run_context
    };
    let policy = load_policy(root);

    let mut status_source = "computed";
    let (summary, severity, breached, breach_reasons, sds) = if command == "evaluate" {
        let summary = match parse_summary_from_flags(&flags) {
            Ok(Some(value)) => value,
            Ok(None) => {
                let receipt = cli_error_receipt(&command, "missing_summary_json", &date, 2);
                println!(
                    "{}",
                    serde_json::to_string(&receipt)
                        .unwrap_or_else(|_| "{\"ok\":false}".to_string())
                );
                return 2;
            }
            Err(reason) => {
                let receipt = cli_error_receipt(&command, &reason, &date, 2);
                println!(
                    "{}",
                    serde_json::to_string(&receipt)
                        .unwrap_or_else(|_| "{\"ok\":false}".to_string())
                );
                return 2;
            }
        };
        let (severity, breached, reasons) = classify_threshold(&summary);
        let sds = summary_number(&summary, "sds");
        (summary, severity, breached, reasons, sds)
    } else if command == "closeout" {
        let summary = match run_snapshot(root, &policy, "closeout", &date) {
            Ok(snapshot) => parse_snapshot_summary(&snapshot),
            Err(reason) => {
                let receipt = cli_error_receipt(&command, &reason, &date, 1);
                println!(
                    "{}",
                    serde_json::to_string(&receipt)
                        .unwrap_or_else(|_| "{\"ok\":false}".to_string())
                );
                return 1;
            }
        };
        let (severity, breached, reasons) = classify_threshold(&summary);
        let sds = summary_number(&summary, "sds");
        (summary, severity, breached, reasons, sds)
    } else {
        let latest = read_json(&policy.latest_path).unwrap_or_else(|| json!({}));
        if let Some((summary, severity, breached, reasons, sds)) =
            load_cached_status_from_latest(&latest)
        {
            status_source = "cached_latest";
            (summary, severity, breached, reasons, sds)
        } else {
            status_source = "cold_status";
            let summary = json!({});
            let (severity, breached, reasons) = classify_threshold(&summary);
            (summary, severity, breached, reasons, 0.0)
        }
    };

    let surfaced = should_surface(&policy, &command, &severity, breached);
    let attention_queue = if policy.enabled && policy.push_attention_queue && surfaced {
        match enqueue_attention(
            root,
            &summary,
            &severity,
            &breach_reasons,
            &date,
            &run_context,
        ) {
            Ok(value) => value,
            Err(reason) => {
                let receipt = cli_error_receipt(&command, &reason, &date, 1);
                println!(
                    "{}",
                    serde_json::to_string(&receipt)
                        .unwrap_or_else(|_| "{\"ok\":false}".to_string())
                );
                return 1;
            }
        }
    } else {
        json!({
            "ok": true,
            "queued": false,
            "decision": if command == "status" { "status_probe_no_enqueue" } else if !policy.enabled { "ambient_disabled" } else if !policy.push_attention_queue { "attention_queue_disabled" } else if !surfaced { "below_threshold" } else { "not_enqueued" },
            "routed_via": "rust_attention_queue"
        })
    };

    let mut receipt = json!({
        "ok": true,
        "type": "dopamine_ambient",
        "ts": now_iso(),
        "date": date,
        "command": command,
        "run_context": run_context,
        "status_source": status_source,
        "ambient_mode_active": policy.enabled,
        "threshold_breach_only": policy.threshold_breach_only,
        "surface_levels": policy.surface_levels,
        "severity": severity,
        "threshold_breached": breached,
        "breach_reasons": breach_reasons,
        "surfaced": surfaced,
        "sds": sds,
        "summary": summary,
        "attention_queue": attention_queue
    });
    receipt["receipt_hash"] = Value::String(deterministic_receipt_hash(&receipt));

    write_json(&policy.latest_path, &receipt);
    append_jsonl(&policy.receipts_path, &receipt);

    update_mech_suit_status(
        &policy,
        json!({
            "ambient": policy.enabled,
            "threshold_breach_only": policy.threshold_breach_only,
            "surface_levels": policy.surface_levels,
            "last_result": "dopamine_ambient",
            "last_date": date,
            "last_command": command,
            "last_severity": severity,
            "last_sds": sds,
            "last_threshold_breached": breached,
            "last_attention_decision": receipt
                .get("attention_queue")
                .and_then(|v| v.get("decision"))
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        }),
    );

    println!(
        "{}",
        serde_json::to_string(&receipt).unwrap_or_else(|_| "{\"ok\":false}".to_string())
    );
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_threshold_detects_non_positive_score() {
        let summary = json!({
            "sds": 0,
            "drift_minutes": 20,
            "directive_pain": { "active": false }
        });
        let (severity, breached, reasons) = classify_threshold(&summary);
        assert_eq!(severity, "warn");
        assert!(breached);
        assert!(reasons.iter().any(|row| row == "sds_non_positive"));
    }

    #[test]
    fn classify_threshold_detects_directive_pain_as_critical() {
        let summary = json!({
            "sds": 5,
            "drift_minutes": 10,
            "directive_pain": { "active": true }
        });
        let (severity, breached, reasons) = classify_threshold(&summary);
        assert_eq!(severity, "critical");
        assert!(breached);
        assert!(reasons.iter().any(|row| row == "directive_pain_active"));
    }
}
