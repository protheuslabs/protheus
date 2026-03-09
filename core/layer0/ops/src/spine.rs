// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use protheus_spine_core_v1::{
    run_background_hands_scheduler, run_evidence_run_plan, run_rsi_idle_hands_scheduler,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone)]
struct CliArgs {
    command: String,
    mode: String,
    date: String,
    max_eyes: Option<i64>,
}

#[derive(Debug, Clone)]
struct StepResult {
    ok: bool,
    code: i32,
    payload: Option<Value>,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Clone)]
struct LedgerWriter {
    root: PathBuf,
    date: String,
    run_id: String,
    seq: u64,
    last_type: Option<String>,
}

#[derive(Debug, Clone)]
struct MechSuitPolicy {
    enabled: bool,
    heartbeat_hours: i64,
    manual_triggers_allowed: bool,
    quiet_non_critical: bool,
    silent_subprocess_output: bool,
    push_attention_queue: bool,
    attention_queue_path: String,
    attention_receipts_path: String,
    attention_latest_path: String,
    attention_max_queue_depth: i64,
    attention_ttl_hours: i64,
    attention_dedupe_window_hours: i64,
    attention_backpressure_drop_below: String,
    attention_escalate_levels: Vec<String>,
    ambient_stance: bool,
    dopamine_threshold_breach_only: bool,
    status_path: PathBuf,
    history_path: PathBuf,
    policy_path: PathBuf,
}

fn stable_hash(seed: &str, len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let hex = hex::encode(hasher.finalize());
    hex[..len.min(hex.len())].to_string()
}

fn receipt_hash(v: &Value) -> String {
    deterministic_receipt_hash(v)
}

fn to_base36(mut n: u64) -> String {
    if n == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while n > 0 {
        let digit = (n % 36) as u8;
        let ch = if digit < 10 {
            (b'0' + digit) as char
        } else {
            (b'a' + (digit - 10)) as char
        };
        out.push(ch);
        n /= 36;
    }
    out.into_iter().rev().collect()
}

fn parse_cli(argv: &[String]) -> Option<CliArgs> {
    if argv.is_empty() {
        return None;
    }

    let mut idx = 0usize;
    let mut command = "run".to_string();
    let mut mode = argv[idx].to_ascii_lowercase();
    if mode == "status" {
        command = "status".to_string();
        mode = "daily".to_string();
    } else if mode == "run" {
        idx += 1;
        mode = argv.get(idx)?.to_ascii_lowercase();
    }

    if command != "status" && mode != "eyes" && mode != "daily" {
        return None;
    }

    if command != "status" {
        idx += 1;
    }
    let mut date = argv
        .get(idx)
        .map(|s| s.trim().to_string())
        .filter(|s| s.len() == 10 && s.chars().nth(4) == Some('-') && s.chars().nth(7) == Some('-'))
        .unwrap_or_else(|| now_iso()[..10].to_string());

    let mut max_eyes = None::<i64>;
    let mut i = 0usize;
    while i < argv.len() {
        let token = argv[i].trim();
        if let Some((k, v)) = token.split_once('=') {
            if k == "--max-eyes" {
                if let Ok(n) = v.parse::<i64>() {
                    max_eyes = Some(n.clamp(1, 500));
                }
            } else if k == "--mode" {
                let candidate = v.trim().to_ascii_lowercase();
                if candidate == "eyes" || candidate == "daily" {
                    mode = candidate;
                }
            } else if k == "--date" {
                let candidate = v.trim();
                if candidate.len() == 10
                    && candidate.chars().nth(4) == Some('-')
                    && candidate.chars().nth(7) == Some('-')
                {
                    date = candidate.to_string();
                }
            }
            i += 1;
            continue;
        }
        if token == "--max-eyes" {
            if let Some(next) = argv.get(i + 1) {
                if !next.starts_with("--") {
                    if let Ok(n) = next.trim().parse::<i64>() {
                        max_eyes = Some(n.clamp(1, 500));
                    }
                    i += 2;
                    continue;
                }
            }
        } else if token == "--mode" {
            if let Some(next) = argv.get(i + 1) {
                let candidate = next.trim().to_ascii_lowercase();
                if !next.starts_with("--") && (candidate == "eyes" || candidate == "daily") {
                    mode = candidate;
                    i += 2;
                    continue;
                }
            }
        } else if token == "--date" {
            if let Some(next) = argv.get(i + 1) {
                let candidate = next.trim();
                if !next.starts_with("--")
                    && candidate.len() == 10
                    && candidate.chars().nth(4) == Some('-')
                    && candidate.chars().nth(7) == Some('-')
                {
                    date = candidate.to_string();
                    i += 2;
                    continue;
                }
            }
        }
        i += 1;
    }

    Some(CliArgs {
        command,
        mode,
        date,
        max_eyes,
    })
}

fn usage() {
    eprintln!("Usage:");
    eprintln!("  protheus-ops spine eyes [YYYY-MM-DD] [--max-eyes=N]");
    eprintln!("  protheus-ops spine daily [YYYY-MM-DD] [--max-eyes=N]");
    eprintln!("  protheus-ops spine run [eyes|daily] [YYYY-MM-DD] [--max-eyes=N]");
    eprintln!("  protheus-ops spine status [--mode=eyes|daily] [--date=YYYY-MM-DD]");
    eprintln!("  protheus-ops spine background-hands-scheduler <configure|schedule|status> [flags]");
    eprintln!("  protheus-ops spine rsi-idle-hands-scheduler <run|status> [flags]");
    eprintln!("  protheus-ops spine evidence-run-plan [--configured-runs=N] [--budget-pressure=none|soft|hard] [--projected-pressure=none|soft|hard]");
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn cli_error_receipt(argv: &[String], error: &str, code: i32) -> Value {
    let ts = now_iso();
    let mut out = json!({
        "ok": false,
        "type": "spine_cli_error",
        "ts": ts,
        "mode": "unknown",
        "date": ts[..10].to_string(),
        "argv": argv,
        "error": error,
        "exit_code": code,
        "claim_evidence": [
            {
                "id": "fail_closed_cli",
                "claim": "spine_cli_invalid_args_fail_closed_with_deterministic_receipt",
                "evidence": {
                    "error": error,
                    "argv_len": argv.len()
                }
            }
        ],
        "persona_lenses": {
            "guardian": {
                "constitution_integrity_ok": true
            },
            "strategist": {
                "mode": "cli_error"
            }
        }
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn run_node_json(root: &Path, args: &[String]) -> StepResult {
    let output = Command::new("node")
        .args(args)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let payload = parse_json_payload(&stdout);
            StepResult {
                ok: out.status.success(),
                code: out.status.code().unwrap_or(1),
                payload,
                stdout,
                stderr,
            }
        }
        Err(err) => StepResult {
            ok: false,
            code: 1,
            payload: None,
            stdout: String::new(),
            stderr: format!("spawn_failed:{err}"),
        },
    }
}

fn run_ops_domain_json(
    root: &Path,
    domain: &str,
    args: &[String],
    run_context: Option<&str>,
) -> StepResult {
    let root_buf = root.to_path_buf();
    let (command, mut command_args) = resolve_protheus_ops_command(&root_buf, domain);
    command_args.extend(args.iter().cloned());

    let mut cmd = Command::new(command);
    cmd.args(command_args)
        .current_dir(root)
        .env(
            "PROTHEUS_NODE_BINARY",
            std::env::var("PROTHEUS_NODE_BINARY").unwrap_or_else(|_| "node".to_string()),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(context) = run_context {
        let trimmed = context.trim();
        if !trimmed.is_empty() {
            cmd.env("SPINE_RUN_CONTEXT", trimmed);
        }
    }

    match cmd.output() {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let payload = parse_json_payload(&stdout);
            StepResult {
                ok: out.status.success(),
                code: out.status.code().unwrap_or(1),
                payload,
                stdout,
                stderr,
            }
        }
        Err(err) => StepResult {
            ok: false,
            code: 1,
            payload: None,
            stdout: String::new(),
            stderr: format!("spawn_failed:{err}"),
        },
    }
}

fn resolve_protheus_ops_command(root: &Path, domain: &str) -> (String, Vec<String>) {
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

fn enqueue_spine_attention(root: &Path, source_type: &str, severity: &str, summary: &str) {
    let mut event = json!({
        "ts": now_iso(),
        "type": source_type,
        "source": "spine",
        "source_type": source_type,
        "severity": severity,
        "summary": summary,
        "attention_key": format!("spine:{source_type}")
    });
    event["receipt_hash"] = Value::String(receipt_hash(&event));
    let encoded = BASE64_STANDARD.encode(
        serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string()),
    );
    let (command, mut args) = resolve_protheus_ops_command(root, "attention-queue");
    args.push("enqueue".to_string());
    args.push(format!("--event-json-base64={encoded}"));
    args.push("--run-context=spine".to_string());

    let _ = Command::new(command)
        .args(args)
        .current_dir(root)
        .env(
            "PROTHEUS_NODE_BINARY",
            std::env::var("PROTHEUS_NODE_BINARY").unwrap_or_else(|_| "node".to_string()),
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn parse_json_payload(raw: &str) -> Option<Value> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return Some(v);
    }
    for line in text.lines().rev() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            return Some(v);
        }
    }
    None
}

fn spine_runs_dir(root: &Path) -> PathBuf {
    root.join("client/runtime/local/state/spine/runs")
}

fn ensure_dir(path: &Path) {
    let _ = fs::create_dir_all(path);
}

fn write_json_atomic(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        ensure_dir(parent);
    }
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    if let Ok(mut payload) = serde_json::to_string_pretty(value) {
        payload.push('\n');
        if fs::write(&tmp, payload).is_ok() {
            let _ = fs::rename(tmp, path);
        }
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn bool_from_env(name: &str) -> Option<bool> {
    let raw = std::env::var(name).ok()?;
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn normalize_path(root: &Path, value: Option<&Value>, fallback: &str) -> PathBuf {
    let raw = value
        .and_then(Value::as_str)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback);
    let candidate = PathBuf::from(raw);
    if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
}

fn load_mech_suit_policy(root: &Path) -> MechSuitPolicy {
    let default_path = {
        let candidate = root.join("client").join("config").join("mech_suit_mode_policy.json");
        if candidate.exists() {
            candidate
        } else {
            root.join("config").join("mech_suit_mode_policy.json")
        }
    };
    let policy_path = std::env::var("MECH_SUIT_MODE_POLICY_PATH")
        .ok()
        .map(PathBuf::from)
        .map(|p| if p.is_absolute() { p } else { root.join(p) })
        .unwrap_or(default_path);
    let raw = read_json(&policy_path).unwrap_or_else(|| json!({}));
    let enabled = bool_from_env("MECH_SUIT_MODE_FORCE")
        .unwrap_or_else(|| raw.get("enabled").and_then(Value::as_bool).unwrap_or(true));
    let state = raw.get("state");
    let spine = raw.get("spine");
    let eyes = raw.get("eyes");
    let attention_contract = eyes
        .and_then(|v| v.get("attention_contract"))
        .and_then(Value::as_object);
    let personas = raw.get("personas");
    let dopamine = raw.get("dopamine");

    MechSuitPolicy {
        enabled,
        heartbeat_hours: spine
            .and_then(|v| v.get("heartbeat_hours"))
            .and_then(Value::as_i64)
            .unwrap_or(4)
            .max(1),
        manual_triggers_allowed: spine
            .and_then(|v| v.get("manual_triggers_allowed"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        quiet_non_critical: spine
            .and_then(|v| v.get("quiet_non_critical"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        silent_subprocess_output: spine
            .and_then(|v| v.get("silent_subprocess_output"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        push_attention_queue: eyes
            .and_then(|v| v.get("push_attention_queue"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        attention_queue_path: normalize_path(
            root,
            eyes.and_then(|v| v.get("attention_queue_path")),
            "client/runtime/local/state/attention/queue.jsonl",
        )
        .to_string_lossy()
        .to_string(),
        attention_receipts_path: normalize_path(
            root,
            eyes.and_then(|v| v.get("receipts_path")),
            "client/runtime/local/state/attention/receipts.jsonl",
        )
        .to_string_lossy()
        .to_string(),
        attention_latest_path: normalize_path(
            root,
            eyes.and_then(|v| v.get("latest_path")),
            "client/runtime/local/state/attention/latest.json",
        )
        .to_string_lossy()
        .to_string(),
        attention_max_queue_depth: attention_contract
            .and_then(|v| v.get("max_queue_depth"))
            .and_then(Value::as_i64)
            .unwrap_or(2048)
            .clamp(64, 200_000),
        attention_ttl_hours: attention_contract
            .and_then(|v| v.get("ttl_hours"))
            .and_then(Value::as_i64)
            .unwrap_or(48)
            .clamp(1, 24 * 90),
        attention_dedupe_window_hours: attention_contract
            .and_then(|v| v.get("dedupe_window_hours"))
            .and_then(Value::as_i64)
            .unwrap_or(24)
            .clamp(1, 24 * 90),
        attention_backpressure_drop_below: attention_contract
            .and_then(|v| v.get("backpressure_drop_below"))
            .and_then(Value::as_str)
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "critical".to_string()),
        attention_escalate_levels: attention_contract
            .and_then(|v| v.get("escalate_levels"))
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(Value::as_str)
                    .map(|row| row.trim().to_ascii_lowercase())
                    .filter(|row| !row.is_empty())
                    .collect::<Vec<_>>()
            })
            .filter(|rows| !rows.is_empty())
            .unwrap_or_else(|| vec!["critical".to_string()]),
        ambient_stance: personas
            .and_then(|v| v.get("ambient_stance"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        dopamine_threshold_breach_only: dopamine
            .and_then(|v| v.get("threshold_breach_only"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        status_path: normalize_path(
            root,
            state.and_then(|v| v.get("status_path")),
            "client/runtime/local/state/ops/mech_suit_mode/latest.json",
        ),
        history_path: normalize_path(
            root,
            state.and_then(|v| v.get("history_path")),
            "client/runtime/local/state/ops/mech_suit_mode/history.jsonl",
        ),
        policy_path,
    }
}

fn update_mech_suit_status(root: &Path, policy: &MechSuitPolicy, component: &str, patch: Value) {
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
    let rel_policy_path = policy
        .policy_path
        .strip_prefix(root)
        .ok()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| policy.policy_path.to_string_lossy().to_string());
    latest["ts"] = Value::String(now_iso());
    latest["active"] = Value::Bool(policy.enabled);
    latest["policy_path"] = Value::String(rel_policy_path);
    if !latest
        .get("components")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        latest["components"] = json!({});
    }
    latest["components"][component] = patch.clone();
    write_json_atomic(&policy.status_path, &latest);

    if let Some(parent) = policy.history_path.parent() {
        ensure_dir(parent);
    }
    let row = json!({
        "ts": now_iso(),
        "type": "mech_suit_status",
        "component": component,
        "active": policy.enabled,
        "patch": patch
    });
    if let Ok(payload) = serde_json::to_string(&row) {
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&policy.history_path)
            .and_then(|mut f| std::io::Write::write_all(&mut f, format!("{payload}\n").as_bytes()));
    }
}

fn build_spine_status_receipt(_root: &Path, cli: &CliArgs, policy: &MechSuitPolicy) -> Value {
    let run_context = std::env::var("SPINE_RUN_CONTEXT")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "manual".to_string());
    let attention_latest =
        read_json(Path::new(&policy.attention_latest_path)).unwrap_or_else(|| json!({}));
    let mut out = json!({
        "ok": true,
        "type": "spine_status",
        "ts": now_iso(),
        "command": cli.command,
        "mode": cli.mode,
        "date": cli.date,
        "ambient_mode_active": policy.enabled,
        "heartbeat_hours": policy.heartbeat_hours,
        "manual_triggers_allowed": policy.manual_triggers_allowed,
        "quiet_non_critical": policy.quiet_non_critical,
        "silent_subprocess_output": policy.silent_subprocess_output,
        "run_context": run_context,
        "attention_contract": {
            "event_owner": "eyes",
            "escalation_authority": "runtime_policy",
            "push_attention_queue": policy.push_attention_queue,
            "attention_queue_path": policy.attention_queue_path,
            "attention_receipts_path": policy.attention_receipts_path,
            "attention_latest_path": policy.attention_latest_path,
            "max_queue_depth": policy.attention_max_queue_depth,
            "ttl_hours": policy.attention_ttl_hours,
            "dedupe_window_hours": policy.attention_dedupe_window_hours,
            "backpressure_drop_below": policy.attention_backpressure_drop_below.clone(),
            "escalate_levels": policy.attention_escalate_levels.clone(),
            "latest": attention_latest
        },
        "personas": {
            "ambient_stance": policy.ambient_stance
        },
        "dopamine": {
            "threshold_breach_only": policy.dopamine_threshold_breach_only
        }
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn emit_status(root: &Path, cli: &CliArgs, policy: &MechSuitPolicy) -> i32 {
    let receipt = build_spine_status_receipt(root, cli, policy);
    update_mech_suit_status(
        root,
        policy,
        "spine",
        json!({
            "ambient": policy.enabled,
            "heartbeat_hours": policy.heartbeat_hours,
            "manual_triggers_allowed": policy.manual_triggers_allowed,
            "quiet_non_critical": policy.quiet_non_critical,
            "silent_subprocess_output": policy.silent_subprocess_output,
            "attention_emission_owner": "eyes",
            "attention_escalation_authority": "runtime_policy",
            "last_result": "status",
            "last_mode": cli.mode,
            "last_date": cli.date
        }),
    );
    print_json_line(&receipt);
    0
}

fn ambient_gate_blocked_receipt(
    cli: &CliArgs,
    policy: &MechSuitPolicy,
    run_context: &str,
) -> Value {
    let mut out = json!({
        "ok": false,
        "blocked": true,
        "type": "spine_ambient_gate",
        "ts": now_iso(),
        "command": cli.command,
        "mode": cli.mode,
        "date": cli.date,
        "reason": "manual_trigger_blocked_mech_suit_mode",
        "ambient_mode_active": policy.enabled,
        "required_run_context": "heartbeat",
        "received_run_context": run_context,
        "heartbeat_hours": policy.heartbeat_hours,
        "manual_triggers_allowed": policy.manual_triggers_allowed,
        "quiet_non_critical": policy.quiet_non_critical,
        "silent_subprocess_output": policy.silent_subprocess_output,
        "attention_contract": {
            "event_owner": "eyes",
            "escalation_authority": "runtime_policy",
            "push_attention_queue": policy.push_attention_queue,
            "attention_queue_path": policy.attention_queue_path,
            "attention_receipts_path": policy.attention_receipts_path,
            "max_queue_depth": policy.attention_max_queue_depth,
            "ttl_hours": policy.attention_ttl_hours,
            "dedupe_window_hours": policy.attention_dedupe_window_hours,
            "backpressure_drop_below": policy.attention_backpressure_drop_below.clone(),
            "escalate_levels": policy.attention_escalate_levels.clone()
        }
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

impl LedgerWriter {
    fn new(root: &Path, date: &str, run_id: &str) -> Self {
        Self {
            root: root.to_path_buf(),
            date: date.to_string(),
            run_id: run_id.to_string(),
            seq: 0,
            last_type: None,
        }
    }

    fn last_type(&self) -> Option<&str> {
        self.last_type.as_deref()
    }

    fn append(&mut self, mut evt: Value) {
        self.seq = self.seq.saturating_add(1);
        if let Some(map) = evt.as_object_mut() {
            let evt_type = map
                .get("type")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            map.insert("run_id".to_string(), Value::String(self.run_id.clone()));
            map.insert("ledger_seq".to_string(), Value::Number(self.seq.into()));
            if !map.contains_key("ts") {
                map.insert("ts".to_string(), Value::String(now_iso()));
            }
            if !map.contains_key("date") {
                map.insert("date".to_string(), Value::String(self.date.clone()));
            }
            if let Some(t) = evt_type {
                self.last_type = Some(t);
            }
        }

        let dir = spine_runs_dir(&self.root);
        ensure_dir(&dir);
        let file = dir.join(format!("{}.jsonl", self.date));
        if let Ok(payload) = serde_json::to_string(&evt) {
            let _ = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(file)
                .and_then(|mut f| {
                    std::io::Write::write_all(&mut f, format!("{payload}\n").as_bytes())
                });
        }

        write_json_atomic(&dir.join("latest.json"), &evt);
    }
}

fn constitution_hash(root: &Path) -> (bool, Option<String>, Option<String>) {
    let path = root.join("docs/workspace/AGENT-CONSTITUTION.md");
    match fs::read_to_string(&path) {
        Ok(raw) => {
            let digest = stable_hash(&raw, 64);
            let expected = std::env::var("PROTHEUS_CONSTITUTION_HASH").ok();
            if let Some(exp) = expected {
                (digest == exp, Some(digest), Some(exp))
            } else {
                (true, Some(digest), None)
            }
        }
        Err(_) => (false, None, None),
    }
}

fn compute_evidence_run_plan(
    configured_runs_raw: Option<i64>,
    budget: Option<&str>,
    projected: Option<&str>,
) -> Value {
    let configured_runs = configured_runs_raw.unwrap_or(2).clamp(0, 6);
    let normalize = |v: Option<&str>| -> String {
        match v.unwrap_or_default().trim().to_ascii_lowercase().as_str() {
            "soft" => "soft".to_string(),
            "hard" => "hard".to_string(),
            _ => "none".to_string(),
        }
    };
    let budget_pressure = normalize(budget);
    let projected_pressure = normalize(projected);
    let pressure_throttle = budget_pressure != "none" || projected_pressure != "none";
    let evidence_runs = if pressure_throttle {
        configured_runs.min(1)
    } else {
        configured_runs
    };
    json!({
        "configured_runs": configured_runs,
        "budget_pressure": budget_pressure,
        "projected_pressure": projected_pressure,
        "pressure_throttle": pressure_throttle,
        "evidence_runs": evidence_runs
    })
}

fn default_evidence_plan() -> Value {
    json!({
        "configured_runs": 0,
        "budget_pressure": "none",
        "projected_pressure": "none",
        "pressure_throttle": false,
        "evidence_runs": 0
    })
}

fn build_claim_evidence(
    constitution_hash: &Option<String>,
    constitution_ok: bool,
    evidence_plan: &Value,
    evidence_ok: i64,
) -> Value {
    json!([
        {
            "id": "constitution_integrity",
            "claim": "agent_constitution_integrity_verified",
            "evidence": {
                "constitution_hash": constitution_hash.clone(),
                "integrity_ok": constitution_ok
            }
        },
        {
            "id": "evidence_loop",
            "claim": "autonomy_evidence_loop_respected_budget_plan",
            "evidence": {
                "plan": evidence_plan,
                "evidence_ok": evidence_ok
            }
        }
    ])
}

fn build_persona_lenses(cli: &CliArgs, constitution_ok: bool, evidence_plan: &Value) -> Value {
    json!({
        "guardian": {
            "clearance": std::env::var("CLEARANCE").ok().unwrap_or_else(|| "3".to_string()),
            "constitution_integrity_ok": constitution_ok
        },
        "strategist": {
            "mode": cli.mode,
            "evidence_runs": evidence_plan.get("evidence_runs").and_then(Value::as_i64).unwrap_or(0)
        }
    })
}

struct TerminalReceiptContext<'a> {
    run_id: &'a str,
    cli: &'a CliArgs,
    policy: &'a MechSuitPolicy,
    constitution_hash: &'a Option<String>,
    constitution_ok: bool,
    evidence_plan: &'a Value,
    evidence_ok: i64,
    started_ms: i64,
}

fn build_resource_snapshot(started_ms: i64) -> Value {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let elapsed_ms = (now_ms - started_ms).max(0);
    json!({
        "pid": std::process::id(),
        "uptime_sec": (elapsed_ms as f64) / 1000.0
    })
}

fn emit_terminal_receipt(
    ledger: &mut LedgerWriter,
    context: &TerminalReceiptContext<'_>,
    ok: bool,
    failure_reason: Option<&str>,
) -> i32 {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let elapsed_ms = (now_ms - context.started_ms).max(0);
    let terminal_step = ledger
        .last_type()
        .unwrap_or("spine_run_started")
        .to_string();
    let mut receipt = json!({
        "ok": ok,
        "type": if ok { "spine_run_complete" } else { "spine_run_failed" },
        "ts": now_iso(),
        "run_id": context.run_id,
        "mode": context.cli.mode,
        "date": context.cli.date,
        "elapsed_ms": elapsed_ms,
        "terminal_step": terminal_step,
        "resource_snapshot": build_resource_snapshot(context.started_ms),
        "claim_evidence": build_claim_evidence(
            context.constitution_hash,
            context.constitution_ok,
            context.evidence_plan,
            context.evidence_ok
        ),
        "persona_lenses": build_persona_lenses(
            context.cli,
            context.constitution_ok,
            context.evidence_plan
        ),
        "evidence_plan": context.evidence_plan,
        "evidence_ok": context.evidence_ok
    });

    if let Some(reason) = failure_reason {
        receipt["failure_reason"] = Value::String(reason.to_string());
    }

    receipt["receipt_hash"] = Value::String(receipt_hash(&receipt));
    ledger.append(receipt.clone());

    if !ok {
        enqueue_spine_attention(
            &ledger.root,
            "spine_run_failed",
            "critical",
            failure_reason.unwrap_or("spine_run_failed"),
        );
    }

    if !ok || !(context.policy.enabled && context.policy.quiet_non_critical) {
        println!(
            "{}",
            serde_json::to_string(&receipt)
                .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
        );
    }

    update_mech_suit_status(
        &ledger.root,
        context.policy,
        "spine",
        json!({
            "ambient": context.policy.enabled,
            "heartbeat_hours": context.policy.heartbeat_hours,
            "manual_triggers_allowed": context.policy.manual_triggers_allowed,
            "quiet_non_critical": context.policy.quiet_non_critical,
            "silent_subprocess_output": context.policy.silent_subprocess_output,
            "attention_emission_owner": "eyes",
            "attention_escalation_authority": "runtime_policy",
            "last_result": if ok { "run_complete" } else { "run_failed" },
            "last_mode": context.cli.mode,
            "last_date": context.cli.date,
            "last_terminal_step": terminal_step,
            "last_failure_reason": failure_reason.map(|s| s.to_string())
        }),
    );

    if ok {
        0
    } else {
        1
    }
}

fn run_guard(root: &Path, files: &[&str]) -> StepResult {
    let file_list = files.join(",");
    run_node_json(
        root,
        &[
            "client/runtime/systems/security/guard.js".to_string(),
            format!("--files={file_list}"),
        ],
    )
}

fn step(
    root: &Path,
    name: &str,
    args: Vec<String>,
    ledger: &mut LedgerWriter,
    mode: &str,
    date: &str,
) -> Result<StepResult, String> {
    let res = run_node_json(root, &args);
    ledger.append(json!({
        "type": "spine_step",
        "mode": mode,
        "date": date,
        "step": name,
        "ok": res.ok,
        "code": res.code,
        "payload": res.payload,
        "reason": if res.ok { Value::Null } else { Value::String(clean_reason(&res.stderr, &res.stdout)) }
    }));

    if res.ok {
        Ok(res)
    } else {
        Err(format!("step_failed:{name}:{}", res.code))
    }
}

fn step_ops_domain(
    root: &Path,
    name: &str,
    domain: &str,
    args: Vec<String>,
    run_context: Option<&str>,
    ledger: &mut LedgerWriter,
    mode: &str,
    date: &str,
) -> Result<StepResult, String> {
    let res = run_ops_domain_json(root, domain, &args, run_context);
    ledger.append(json!({
        "type": "spine_step",
        "mode": mode,
        "date": date,
        "step": name,
        "domain": domain,
        "ok": res.ok,
        "code": res.code,
        "payload": res.payload,
        "reason": if res.ok { Value::Null } else { Value::String(clean_reason(&res.stderr, &res.stdout)) }
    }));

    if res.ok {
        Ok(res)
    } else {
        Err(format!("step_failed:{name}:{}", res.code))
    }
}

fn append_self_documentation_closeout(
    root: &Path,
    ledger: &mut LedgerWriter,
    mode: &str,
    date: &str,
) {
    if mode != "daily" {
        return;
    }

    let args = vec![
        "client/runtime/systems/autonomy/self_documentation_closeout.js".to_string(),
        "run".to_string(),
        date.to_string(),
        "--approve=1".to_string(),
    ];
    let res = run_node_json(root, &args);
    ledger.append(json!({
        "type": "spine_step",
        "mode": mode,
        "date": date,
        "step": "self_documentation_closeout",
        "ok": res.ok,
        "code": res.code,
        "non_blocking": true,
        "payload": res.payload,
        "reason": if res.ok { Value::Null } else { Value::String(clean_reason(&res.stderr, &res.stdout)) }
    }));
}

fn emit_terminal_with_closeout(
    root: &Path,
    ledger: &mut LedgerWriter,
    context: &TerminalReceiptContext<'_>,
    ok: bool,
    failure_reason: Option<&str>,
) -> i32 {
    append_self_documentation_closeout(root, ledger, &context.cli.mode, &context.cli.date);
    emit_terminal_receipt(ledger, context, ok, failure_reason)
}

fn clean_reason(stderr: &str, stdout: &str) -> String {
    let merged = format!("{} {}", stderr, stdout)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if merged.len() <= 180 {
        merged
    } else {
        merged[..180].to_string()
    }
}

fn execute_native(root: &Path, cli: &CliArgs) -> i32 {
    if std::env::var("CLEARANCE")
        .ok()
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        std::env::set_var("CLEARANCE", "3");
    }
    let policy = load_mech_suit_policy(root);
    if cli.command == "status" {
        return emit_status(root, cli, &policy);
    }

    let run_context = std::env::var("SPINE_RUN_CONTEXT")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "manual".to_string());
    if policy.enabled && !policy.manual_triggers_allowed && run_context != "heartbeat" {
        let receipt = ambient_gate_blocked_receipt(cli, &policy, &run_context);
        enqueue_spine_attention(
            root,
            "spine_ambient_gate",
            "critical",
            "manual_trigger_blocked_mech_suit_mode",
        );
        update_mech_suit_status(
            root,
            &policy,
            "spine",
            json!({
                "ambient": policy.enabled,
                "heartbeat_hours": policy.heartbeat_hours,
                "manual_triggers_allowed": policy.manual_triggers_allowed,
                "quiet_non_critical": policy.quiet_non_critical,
                "silent_subprocess_output": policy.silent_subprocess_output,
                "attention_emission_owner": "eyes",
                "attention_escalation_authority": "runtime_policy",
                "last_result": "manual_trigger_blocked",
                "last_mode": cli.mode,
                "last_date": cli.date,
                "last_run_context": run_context
            }),
        );
        print_json_line(&receipt);
        return 2;
    }

    let run_started_ms = chrono::Utc::now().timestamp_millis();
    let run_id = format!(
        "spine_{}_{}",
        to_base36(run_started_ms as u64),
        std::process::id()
    );

    let mut ledger = LedgerWriter::new(root, &cli.date, &run_id);
    let invoked = vec![
        "client/runtime/systems/spine/spine.js",
        "client/runtime/systems/security/guard.js",
        "client/cognition/habits/scripts/external_eyes.js",
        "client/cognition/habits/scripts/eyes_insight.js",
        "client/cognition/habits/scripts/sensory_queue.js",
        "client/runtime/systems/actuation/bridge_from_proposals.js",
        "client/runtime/systems/sensory/cross_signal_engine.js",
        "client/runtime/systems/autonomy/autonomy_controller.js",
        "client/runtime/systems/autonomy/self_documentation_closeout.js",
    ];

    let (constitution_ok, constitution_hash, expected_hash) = constitution_hash(root);
    let mut evidence_ok = 0i64;
    let mut evidence_plan = default_evidence_plan();

    ledger.append(json!({
        "type": "spine_run_started",
        "mode": cli.mode,
        "date": cli.date,
        "max_eyes": cli.max_eyes,
        "files_touched": invoked,
        "constitution_hash": constitution_hash,
        "expected_constitution_hash": expected_hash,
        "constitution_integrity_ok": constitution_ok
    }));

    if !constitution_ok {
        return emit_terminal_with_closeout(
            root,
            &mut ledger,
            &TerminalReceiptContext {
                run_id: &run_id,
                cli,
                policy: &policy,
                constitution_hash: &constitution_hash,
                constitution_ok,
                evidence_plan: &evidence_plan,
                evidence_ok,
                started_ms: run_started_ms,
            },
            false,
            Some("constitution_integrity_failed"),
        );
    }

    let guard_res = run_guard(root, &invoked);
    ledger.append(json!({
        "type": "spine_guard",
        "mode": cli.mode,
        "date": cli.date,
        "ok": guard_res.ok,
        "code": guard_res.code,
        "reason": if guard_res.ok { Value::Null } else { Value::String(clean_reason(&guard_res.stderr, &guard_res.stdout)) }
    }));
    if !guard_res.ok {
        return emit_terminal_with_closeout(
            root,
            &mut ledger,
            &TerminalReceiptContext {
                run_id: &run_id,
                cli,
                policy: &policy,
                constitution_hash: &constitution_hash,
                constitution_ok,
                evidence_plan: &evidence_plan,
                evidence_ok,
                started_ms: run_started_ms,
            },
            false,
            Some("guard_failed"),
        );
    }

    let mut step_args = vec![
        "client/cognition/habits/scripts/external_eyes.js".to_string(),
        "run".to_string(),
    ];
    if let Some(max_eyes) = cli.max_eyes {
        step_args.push(format!("--max-eyes={max_eyes}"));
    }
    if let Err(reason) = step(
        root,
        "external_eyes_run",
        step_args,
        &mut ledger,
        &cli.mode,
        &cli.date,
    ) {
        return emit_terminal_with_closeout(
            root,
            &mut ledger,
            &TerminalReceiptContext {
                run_id: &run_id,
                cli,
                policy: &policy,
                constitution_hash: &constitution_hash,
                constitution_ok,
                evidence_plan: &evidence_plan,
                evidence_ok,
                started_ms: run_started_ms,
            },
            false,
            Some(&reason),
        );
    }

    if cli.mode == "daily" {
        for (name, args) in [
            (
                "external_eyes_canary",
                vec![
                    "client/cognition/habits/scripts/external_eyes.js".to_string(),
                    "canary".to_string(),
                ],
            ),
            (
                "external_eyes_canary_signal",
                vec![
                    "client/cognition/habits/scripts/external_eyes.js".to_string(),
                    "canary-signal".to_string(),
                ],
            ),
        ] {
            if let Err(reason) = step(root, name, args, &mut ledger, &cli.mode, &cli.date) {
                return emit_terminal_with_closeout(
                    root,
                    &mut ledger,
                    &TerminalReceiptContext {
                        run_id: &run_id,
                        cli,
                        policy: &policy,
                        constitution_hash: &constitution_hash,
                        constitution_ok,
                        evidence_plan: &evidence_plan,
                        evidence_ok,
                        started_ms: run_started_ms,
                    },
                    false,
                    Some(&reason),
                );
            }
        }
    }

    for (name, args) in [
        (
            "external_eyes_score",
            vec![
                "client/cognition/habits/scripts/external_eyes.js".to_string(),
                "score".to_string(),
                cli.date.clone(),
            ],
        ),
        (
            "external_eyes_evolve",
            vec![
                "client/cognition/habits/scripts/external_eyes.js".to_string(),
                "evolve".to_string(),
                cli.date.clone(),
            ],
        ),
        (
            "cross_signal_engine",
            vec![
                "client/runtime/systems/sensory/cross_signal_engine.js".to_string(),
                "run".to_string(),
                cli.date.clone(),
            ],
        ),
        (
            "eyes_insight",
            vec![
                "client/cognition/habits/scripts/eyes_insight.js".to_string(),
                "run".to_string(),
                cli.date.clone(),
            ],
        ),
        (
            "sensory_queue_ingest",
            vec![
                "client/cognition/habits/scripts/sensory_queue.js".to_string(),
                "ingest".to_string(),
                cli.date.clone(),
            ],
        ),
        (
            "bridge_from_proposals",
            vec![
                "client/runtime/systems/actuation/bridge_from_proposals.js".to_string(),
                "run".to_string(),
                cli.date.clone(),
            ],
        ),
    ] {
        if let Err(reason) = step(root, name, args, &mut ledger, &cli.mode, &cli.date) {
            return emit_terminal_with_closeout(
                root,
                &mut ledger,
                &TerminalReceiptContext {
                    run_id: &run_id,
                    cli,
                    policy: &policy,
                    constitution_hash: &constitution_hash,
                    constitution_ok,
                    evidence_plan: &evidence_plan,
                    evidence_ok,
                    started_ms: run_started_ms,
                },
                false,
                Some(&reason),
            );
        }
    }

    if cli.mode == "daily" {
        let configured = std::env::var("AUTONOMY_EVIDENCE_RUNS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok());
        let budget_pressure = std::env::var("SPINE_BUDGET_PRESSURE").ok();
        let projected_pressure = std::env::var("SPINE_PROJECTED_BUDGET_PRESSURE").ok();
        let plan = compute_evidence_run_plan(
            configured,
            budget_pressure.as_deref(),
            projected_pressure.as_deref(),
        );

        let runs = plan
            .get("evidence_runs")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);

        let type_cap = std::env::var("SPINE_AUTONOMY_EVIDENCE_MAX_PER_TYPE")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(1)
            .clamp(0, 6);
        let mut per_type = HashMap::<String, i64>::new();

        for idx in 0..runs {
            let res = run_node_json(
                root,
                &[
                    "client/runtime/systems/autonomy/autonomy_controller.js".to_string(),
                    "evidence".to_string(),
                    cli.date.clone(),
                ],
            );
            let proposal_type = res
                .payload
                .as_ref()
                .and_then(|p| p.get("proposal_type"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();

            let current = per_type.get(&proposal_type).copied().unwrap_or(0);
            let over_cap = type_cap > 0 && !proposal_type.is_empty() && current >= type_cap;
            if over_cap {
                ledger.append(json!({
                    "type": "spine_autonomy_evidence_skipped_type_cap",
                    "mode": cli.mode,
                    "date": cli.date,
                    "attempt": idx + 1,
                    "proposal_type": proposal_type,
                    "type_cap": type_cap
                }));
                continue;
            }

            if !proposal_type.is_empty() {
                per_type.insert(proposal_type.clone(), current + 1);
            }

            if res.ok {
                evidence_ok += 1;
            }
            ledger.append(json!({
                "type": "spine_autonomy_evidence",
                "mode": cli.mode,
                "date": cli.date,
                "attempt": idx + 1,
                "ok": res.ok,
                "proposal_type": if proposal_type.is_empty() { Value::Null } else { Value::String(proposal_type) },
                "preview_receipt_id": res.payload.as_ref().and_then(|p| p.get("preview_receipt_id")).cloned().unwrap_or(Value::Null),
                "reason": if res.ok { Value::Null } else { Value::String(clean_reason(&res.stderr, &res.stdout)) }
            }));
        }

        evidence_plan = plan;
    }

    if cli.mode == "daily" {
        for (name, args) in [
            (
                "queue_gc",
                vec![
                    "client/cognition/habits/scripts/queue_gc.js".to_string(),
                    "run".to_string(),
                    cli.date.clone(),
                ],
            ),
            (
                "git_outcomes",
                vec![
                    "client/cognition/habits/scripts/git_outcomes.js".to_string(),
                    "run".to_string(),
                    cli.date.clone(),
                ],
            ),
            (
                "sensory_digest_daily",
                vec![
                    "client/cognition/habits/scripts/sensory_digest.js".to_string(),
                    "daily".to_string(),
                    cli.date.clone(),
                ],
            ),
        ] {
            if let Err(reason) = step(root, name, args, &mut ledger, &cli.mode, &cli.date) {
                return emit_terminal_with_closeout(
                    root,
                    &mut ledger,
                    &TerminalReceiptContext {
                        run_id: &run_id,
                        cli,
                        policy: &policy,
                        constitution_hash: &constitution_hash,
                        constitution_ok,
                        evidence_plan: &evidence_plan,
                        evidence_ok,
                        started_ms: run_started_ms,
                    },
                    false,
                    Some(&reason),
                );
            }
        }

        if let Err(reason) = step_ops_domain(
            root,
            "dopamine_closeout",
            "dopamine-ambient",
            vec![
                "closeout".to_string(),
                format!("--date={}", cli.date),
                "--run-context=spine".to_string(),
            ],
            Some(&run_context),
            &mut ledger,
            &cli.mode,
            &cli.date,
        ) {
            return emit_terminal_with_closeout(
                root,
                &mut ledger,
                &TerminalReceiptContext {
                    run_id: &run_id,
                    cli,
                    policy: &policy,
                    constitution_hash: &constitution_hash,
                    constitution_ok,
                    evidence_plan: &evidence_plan,
                    evidence_ok,
                    started_ms: run_started_ms,
                },
                false,
                Some(&reason),
            );
        }
    }

    emit_terminal_with_closeout(
        root,
        &mut ledger,
        &TerminalReceiptContext {
            run_id: &run_id,
            cli,
            policy: &policy,
            constitution_hash: &constitution_hash,
            constitution_ok,
            evidence_plan: &evidence_plan,
            evidence_ok,
            started_ms: run_started_ms,
        },
        true,
        None,
    )
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    if let Some(first) = argv.first() {
        let command = first.trim().to_ascii_lowercase();
        if command == "background-hands-scheduler" || command == "background_hands_scheduler" {
            let (code, payload) = run_background_hands_scheduler(root, &argv[1..]);
            print_json_line(&payload);
            return code;
        }
        if command == "rsi-idle-hands-scheduler" || command == "rsi_idle_hands_scheduler" {
            let (code, payload) = run_rsi_idle_hands_scheduler(root, &argv[1..]);
            print_json_line(&payload);
            return code;
        }
        if command == "evidence-run-plan" || command == "evidence_run_plan" {
            let (code, payload) = run_evidence_run_plan(&argv[1..]);
            print_json_line(&payload);
            return code;
        }
    }

    let Some(cli) = parse_cli(argv) else {
        usage();
        print_json_line(&cli_error_receipt(argv, "invalid_args", 2));
        return 2;
    };

    execute_native(root, &cli)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parity_fixture_evidence_plan_matches_ts_rules() {
        let a = compute_evidence_run_plan(Some(2), Some("none"), Some("none"));
        assert_eq!(a.get("evidence_runs").and_then(Value::as_i64), Some(2));

        let b = compute_evidence_run_plan(Some(2), Some("soft"), Some("none"));
        assert_eq!(
            b.get("pressure_throttle").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(b.get("evidence_runs").and_then(Value::as_i64), Some(1));

        let c = compute_evidence_run_plan(Some(4), Some("none"), Some("hard"));
        assert_eq!(
            c.get("pressure_throttle").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(c.get("evidence_runs").and_then(Value::as_i64), Some(1));
    }

    #[test]
    fn deterministic_receipt_hash_for_fixture() {
        let payload = json!({
            "ok": true,
            "type": "spine_run_complete",
            "mode": "eyes",
            "date": "2026-03-04",
            "claim_evidence": [{"id":"c1","claim":"x","evidence":{"a":1}}]
        });
        let h1 = receipt_hash(&payload);
        let h2 = receipt_hash(&payload);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn terminal_failure_receipt_is_emitted_with_claim_evidence_and_hash() {
        let root = tempdir().expect("tempdir");
        let cli = CliArgs {
            command: "run".to_string(),
            mode: "eyes".to_string(),
            date: "2026-03-04".to_string(),
            max_eyes: None,
        };
        let run_id = "spine_test_1";
        let mut ledger = LedgerWriter::new(root.path(), &cli.date, run_id);
        let evidence_plan = default_evidence_plan();
        let constitution_hash = Some("abc123".to_string());
        let policy = MechSuitPolicy {
            enabled: true,
            heartbeat_hours: 4,
            manual_triggers_allowed: false,
            quiet_non_critical: false,
            silent_subprocess_output: true,
            push_attention_queue: true,
            attention_queue_path: "state/attention/queue.jsonl".to_string(),
            attention_receipts_path: "state/attention/receipts.jsonl".to_string(),
            attention_latest_path: "state/attention/latest.json".to_string(),
            attention_max_queue_depth: 2048,
            attention_ttl_hours: 48,
            attention_dedupe_window_hours: 24,
            attention_backpressure_drop_below: "critical".to_string(),
            attention_escalate_levels: vec!["critical".to_string()],
            ambient_stance: true,
            dopamine_threshold_breach_only: true,
            status_path: root.path().join("state/ops/mech_suit_mode/latest.json"),
            history_path: root.path().join("state/ops/mech_suit_mode/history.jsonl"),
            policy_path: root.path().join("client/runtime/config/mech_suit_mode_policy.json"),
        };
        let context = TerminalReceiptContext {
            run_id,
            cli: &cli,
            policy: &policy,
            constitution_hash: &constitution_hash,
            constitution_ok: true,
            evidence_plan: &evidence_plan,
            evidence_ok: 0,
            started_ms: 0,
        };

        let code = emit_terminal_receipt(&mut ledger, &context, false, Some("guard_failed"));
        assert_eq!(code, 1);

        let latest_path = root.path().join("state/spine/runs/latest.json");
        let latest_raw = std::fs::read_to_string(latest_path).expect("latest json");
        let latest = serde_json::from_str::<Value>(&latest_raw).expect("valid json");

        assert_eq!(
            latest.get("type").and_then(Value::as_str),
            Some("spine_run_failed")
        );
        assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(false));
        assert!(latest.get("claim_evidence").is_some());
        assert!(latest.get("persona_lenses").is_some());
        assert_eq!(
            latest.get("failure_reason").and_then(Value::as_str),
            Some("guard_failed")
        );

        let expected_hash = latest
            .get("receipt_hash")
            .and_then(Value::as_str)
            .expect("hash")
            .to_string();
        let mut unhashed = latest.clone();
        let unhashed_obj = unhashed.as_object_mut().expect("object");
        unhashed_obj.remove("receipt_hash");
        // Ledger metadata is added after hash calculation for the terminal payload.
        unhashed_obj.remove("ledger_seq");
        assert_eq!(receipt_hash(&unhashed), expected_hash);
    }

    #[test]
    fn parse_cli_supports_run_alias() {
        let args = vec![
            "run".to_string(),
            "daily".to_string(),
            "2026-03-04".to_string(),
            "--max-eyes=7".to_string(),
        ];
        let parsed = parse_cli(&args).expect("parsed");
        assert_eq!(parsed.mode, "daily");
        assert_eq!(parsed.date, "2026-03-04");
        assert_eq!(parsed.max_eyes, Some(7));
    }

    #[test]
    fn parse_cli_supports_split_max_eyes_flag() {
        let args = vec![
            "eyes".to_string(),
            "2026-03-04".to_string(),
            "--max-eyes".to_string(),
            "12".to_string(),
        ];
        let parsed = parse_cli(&args).expect("parsed");
        assert_eq!(parsed.mode, "eyes");
        assert_eq!(parsed.date, "2026-03-04");
        assert_eq!(parsed.max_eyes, Some(12));
    }

    #[test]
    fn parse_cli_supports_status_overrides() {
        let args = vec![
            "status".to_string(),
            "--mode=eyes".to_string(),
            "--date=2026-03-05".to_string(),
        ];
        let parsed = parse_cli(&args).expect("parsed");
        assert_eq!(parsed.command, "status");
        assert_eq!(parsed.mode, "eyes");
        assert_eq!(parsed.date, "2026-03-05");
    }

    #[test]
    fn ambient_gate_receipt_is_hashed_and_fail_closed() {
        let policy = MechSuitPolicy {
            enabled: true,
            heartbeat_hours: 4,
            manual_triggers_allowed: false,
            quiet_non_critical: true,
            silent_subprocess_output: true,
            push_attention_queue: true,
            attention_queue_path: "state/attention/queue.jsonl".to_string(),
            attention_receipts_path: "state/attention/receipts.jsonl".to_string(),
            attention_latest_path: "state/attention/latest.json".to_string(),
            attention_max_queue_depth: 2048,
            attention_ttl_hours: 48,
            attention_dedupe_window_hours: 24,
            attention_backpressure_drop_below: "critical".to_string(),
            attention_escalate_levels: vec!["critical".to_string()],
            ambient_stance: true,
            dopamine_threshold_breach_only: true,
            status_path: PathBuf::from("state/ops/mech_suit_mode/latest.json"),
            history_path: PathBuf::from("state/ops/mech_suit_mode/history.jsonl"),
            policy_path: PathBuf::from("client/runtime/config/mech_suit_mode_policy.json"),
        };
        let cli = CliArgs {
            command: "run".to_string(),
            mode: "eyes".to_string(),
            date: "2026-03-05".to_string(),
            max_eyes: None,
        };
        let receipt = ambient_gate_blocked_receipt(&cli, &policy, "manual");
        assert_eq!(receipt.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(receipt.get("blocked").and_then(Value::as_bool), Some(true));
        assert_eq!(
            receipt.get("reason").and_then(Value::as_str),
            Some("manual_trigger_blocked_mech_suit_mode")
        );

        let expected_hash = receipt
            .get("receipt_hash")
            .and_then(Value::as_str)
            .expect("hash")
            .to_string();
        let mut unhashed = receipt.clone();
        unhashed
            .as_object_mut()
            .expect("object")
            .remove("receipt_hash");
        assert_eq!(receipt_hash(&unhashed), expected_hash);
    }

    #[test]
    fn cli_error_receipt_is_deterministic_and_hashed() {
        let argv = vec!["bad".to_string(), "--x=1".to_string()];
        let out = cli_error_receipt(&argv, "invalid_args", 2);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            out.get("type").and_then(Value::as_str),
            Some("spine_cli_error")
        );
        assert!(out.get("claim_evidence").is_some());
        assert!(out.get("persona_lenses").is_some());

        let expected_hash = out
            .get("receipt_hash")
            .and_then(Value::as_str)
            .expect("hash")
            .to_string();
        let mut unhashed = out.clone();
        unhashed
            .as_object_mut()
            .expect("object")
            .remove("receipt_hash");
        assert_eq!(receipt_hash(&unhashed), expected_hash);

        let ts = out.get("ts").and_then(Value::as_str).expect("ts");
        let date = out.get("date").and_then(Value::as_str).expect("date");
        assert!(ts.starts_with(date));
    }
}
