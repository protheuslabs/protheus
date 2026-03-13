// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::child_organ_runtime (authoritative)
use crate::{client_state_root, deterministic_receipt_hash, now_iso};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const LANE_ID: &str = "child_organ_runtime";

#[derive(Debug, Clone)]
struct RuntimePolicy {
    max_runtime_ms: u64,
    max_output_bytes: usize,
    max_allowed_commands: usize,
    allow_commands: Vec<String>,
}

#[derive(Debug, Clone)]
struct Budget {
    max_runtime_ms: u64,
    max_output_bytes: usize,
    allow_commands: Vec<String>,
}

#[path = "child_organ_runtime_spawn.rs"]
mod child_organ_runtime_spawn;
use child_organ_runtime_spawn::spawn_payload;

#[cfg(test)]
#[path = "child_organ_runtime_tests.rs"]
mod tests;

fn usage() {
    println!("Usage:");
    println!("  protheus-ops child-organ-runtime plan --organ-id=<id> [--budget-json=<json>] [--apply=1|0]");
    println!("  protheus-ops child-organ-runtime spawn --organ-id=<id> --command=<cmd> [--arg=<v> ...] [--budget-json=<json>] [--apply=1|0]");
    println!("  protheus-ops child-organ-runtime status [--organ-id=<id>]");
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn receipt_hash(v: &Value) -> String {
    deterministic_receipt_hash(v)
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let with_eq = format!("--{key}=");
    let plain = format!("--{key}");
    let mut i = 0usize;
    while i < argv.len() {
        let token = argv[i].trim();
        if let Some(v) = token.strip_prefix(&with_eq) {
            return Some(v.trim().to_string());
        }
        if token == plain {
            if let Some(next) = argv.get(i + 1) {
                if !next.trim_start().starts_with("--") {
                    return Some(next.trim().to_string());
                }
            }
            return Some("true".to_string());
        }
        i += 1;
    }
    None
}

fn collect_flags(argv: &[String], key: &str) -> Vec<String> {
    let with_eq = format!("--{key}=");
    let plain = format!("--{key}");
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < argv.len() {
        let token = argv[i].trim();
        if token == plain {
            if let Some(next) = argv.get(i + 1) {
                if !next.trim_start().starts_with("--") {
                    out.push(next.trim().to_string());
                    i += 2;
                    continue;
                }
            }
            out.push(String::new());
            i += 1;
            continue;
        }
        if let Some(v) = token.strip_prefix(&with_eq) {
            out.push(v.trim().to_string());
        }
        i += 1;
    }
    out
}

fn parse_bool(raw: Option<&str>, fallback: bool) -> bool {
    let Some(v) = raw else {
        return fallback;
    };
    match v.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn clean_id(raw: Option<&str>, fallback: &str) -> String {
    let mut out = String::new();
    if let Some(v) = raw {
        for ch in v.trim().chars() {
            if out.len() >= 120 {
                break;
            }
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                out.push(ch);
            } else {
                out.push('-');
            }
        }
    }
    let cleaned = out.trim_matches('-');
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned.to_string()
    }
}

fn clean_text(raw: Option<&str>, max_len: usize) -> String {
    let mut out = String::new();
    if let Some(v) = raw {
        for ch in v.split_whitespace().collect::<Vec<_>>().join(" ").chars() {
            if out.len() >= max_len {
                break;
            }
            out.push(ch);
        }
    }
    out.trim().to_string()
}

fn parse_json(raw: Option<&str>) -> Result<Value, String> {
    let text = raw.ok_or_else(|| "missing_json_payload".to_string())?;
    serde_json::from_str::<Value>(text).map_err(|err| format!("invalid_json_payload:{err}"))
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent).map_err(|err| format!("mkdir_failed:{}:{err}", parent.display()))
}

fn write_json(path: &Path, payload: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let mut encoded =
        serde_json::to_string_pretty(payload).map_err(|err| format!("encode_failed:{err}"))?;
    encoded.push('\n');
    fs::write(path, encoded).map_err(|err| format!("write_failed:{}:{err}", path.display()))
}

fn append_jsonl(path: &Path, row: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    use std::io::Write;
    let line = serde_json::to_string(row).map_err(|err| format!("encode_failed:{err}"))? + "\n";
    let mut opts = fs::OpenOptions::new();
    opts.create(true).append(true);
    let mut file = opts
        .open(path)
        .map_err(|err| format!("open_failed:{}:{err}", path.display()))?;
    file.write_all(line.as_bytes())
        .map_err(|err| format!("append_failed:{}:{err}", path.display()))
}

fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| path.to_string_lossy().replace('\\', "/"))
}

fn runtime_dir(root: &Path) -> PathBuf {
    client_state_root(root)
        .join("fractal")
        .join("child_organ_runtime")
}

fn plans_path(root: &Path) -> PathBuf {
    runtime_dir(root).join("plans.json")
}

fn history_path(root: &Path) -> PathBuf {
    runtime_dir(root).join("history.jsonl")
}

fn runs_dir(root: &Path) -> PathBuf {
    runtime_dir(root).join("runs")
}

fn policy_path(root: &Path) -> PathBuf {
    root.join("client")
        .join("runtime")
        .join("config")
        .join("child_organ_policy.json")
}

fn default_policy() -> RuntimePolicy {
    RuntimePolicy {
        max_runtime_ms: 20_000,
        max_output_bytes: 64 * 1024,
        max_allowed_commands: 64,
        allow_commands: vec![
            "echo".to_string(),
            "true".to_string(),
            "false".to_string(),
            "protheus-ops".to_string(),
            "cargo".to_string(),
        ],
    }
}

fn load_policy(root: &Path) -> RuntimePolicy {
    let mut out = default_policy();
    if let Some(v) = read_json(&policy_path(root)) {
        out.max_runtime_ms = v
            .get("max_runtime_ms")
            .and_then(Value::as_u64)
            .filter(|n| *n >= 100)
            .unwrap_or(out.max_runtime_ms);
        out.max_output_bytes = v
            .get("max_output_bytes")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .filter(|n| *n >= 1024)
            .unwrap_or(out.max_output_bytes);
        out.max_allowed_commands = v
            .get("max_allowed_commands")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .filter(|n| *n >= 1)
            .unwrap_or(out.max_allowed_commands);
        if let Some(rows) = v.get("allow_commands").and_then(Value::as_array) {
            let cmds = rows
                .iter()
                .filter_map(Value::as_str)
                .map(|v| clean_text(Some(v), 128))
                .filter(|v| !v.is_empty())
                .take(out.max_allowed_commands)
                .collect::<Vec<_>>();
            if !cmds.is_empty() {
                out.allow_commands = cmds;
            }
        }
    }
    out
}

fn parse_budget(raw: Option<&str>, policy: &RuntimePolicy) -> Result<Budget, String> {
    if raw.is_none() {
        return Ok(Budget {
            max_runtime_ms: policy.max_runtime_ms,
            max_output_bytes: policy.max_output_bytes,
            allow_commands: policy.allow_commands.clone(),
        });
    }

    let payload = parse_json(raw)?;
    let max_runtime_ms = payload
        .get("max_runtime_ms")
        .and_then(Value::as_u64)
        .unwrap_or(policy.max_runtime_ms)
        .clamp(100, policy.max_runtime_ms);
    let max_output_bytes = payload
        .get("max_output_bytes")
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(policy.max_output_bytes)
        .clamp(1024, policy.max_output_bytes);
    let allow_commands = payload
        .get("allow_commands")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|v| clean_text(Some(v), 128))
                .filter(|v| !v.is_empty())
                .take(policy.max_allowed_commands)
                .collect::<Vec<_>>()
        })
        .filter(|rows| !rows.is_empty())
        .unwrap_or_else(|| policy.allow_commands.clone());
    Ok(Budget {
        max_runtime_ms,
        max_output_bytes,
        allow_commands,
    })
}

fn load_plan_map(root: &Path) -> BTreeMap<String, Value> {
    read_json(&plans_path(root))
        .and_then(|v| v.get("plans").and_then(Value::as_object).cloned())
        .map(|m| {
            let mut out = BTreeMap::new();
            for (k, v) in m {
                out.insert(k, v);
            }
            out
        })
        .unwrap_or_default()
}

fn write_plan_map(root: &Path, plans: &BTreeMap<String, Value>) -> Result<(), String> {
    let mut map = Map::new();
    for (k, v) in plans {
        map.insert(k.clone(), v.clone());
    }
    write_json(
        &plans_path(root),
        &json!({
            "version": 1,
            "updated_at": now_iso(),
            "plans": Value::Object(map)
        }),
    )
}

fn budget_from_plan_value(row: &Value, policy: &RuntimePolicy) -> Budget {
    let max_runtime_ms = row
        .get("max_runtime_ms")
        .and_then(Value::as_u64)
        .unwrap_or(policy.max_runtime_ms)
        .clamp(100, policy.max_runtime_ms);
    let max_output_bytes = row
        .get("max_output_bytes")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(policy.max_output_bytes)
        .clamp(1024, policy.max_output_bytes);
    let allow_commands = row
        .get("allow_commands")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|v| clean_text(Some(v), 128))
                .filter(|v| !v.is_empty())
                .take(policy.max_allowed_commands)
                .collect::<Vec<_>>()
        })
        .filter(|rows| !rows.is_empty())
        .unwrap_or_else(|| policy.allow_commands.clone());
    Budget {
        max_runtime_ms,
        max_output_bytes,
        allow_commands,
    }
}

fn plan_payload(root: &Path, policy: &RuntimePolicy, argv: &[String]) -> Result<Value, String> {
    let organ_id = clean_id(parse_flag(argv, "organ-id").as_deref(), "organ");
    let budget = parse_budget(parse_flag(argv, "budget-json").as_deref(), policy)?;
    let apply = parse_bool(parse_flag(argv, "apply").as_deref(), true);

    if apply {
        let mut plans = load_plan_map(root);
        plans.insert(
            organ_id.clone(),
            json!({
                "max_runtime_ms": budget.max_runtime_ms,
                "max_output_bytes": budget.max_output_bytes,
                "allow_commands": budget.allow_commands,
                "updated_at": now_iso()
            }),
        );
        write_plan_map(root, &plans)?;
        append_jsonl(
            &history_path(root),
            &json!({
                "type": "child_organ_plan",
                "organ_id": organ_id,
                "ts": now_iso(),
                "max_runtime_ms": budget.max_runtime_ms,
                "max_output_bytes": budget.max_output_bytes
            }),
        )?;
    }

    let mut out = json!({
        "ok": true,
        "type": "child_organ_runtime_plan",
        "lane": LANE_ID,
        "organ_id": organ_id,
        "apply": apply,
        "plans_path": rel_path(root, &plans_path(root)),
        "budget": {
            "max_runtime_ms": budget.max_runtime_ms,
            "max_output_bytes": budget.max_output_bytes,
            "allow_commands": budget.allow_commands
        }
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    Ok(out)
}

fn status_payload(root: &Path, argv: &[String]) -> Value {
    let organ_filter = clean_id(parse_flag(argv, "organ-id").as_deref(), "");
    let plans = load_plan_map(root);
    let plan_count = plans.len();
    let mut matched_plan = Value::Null;
    if !organ_filter.is_empty() {
        if let Some(row) = plans.get(&organ_filter) {
            matched_plan = row.clone();
        }
    }
    let mut runs = 0usize;
    if let Ok(read) = fs::read_dir(runs_dir(root)) {
        for entry in read.flatten() {
            if entry.path().extension().and_then(|s| s.to_str()) == Some("json") {
                runs += 1;
            }
        }
    }
    let mut out = json!({
        "ok": true,
        "type": "child_organ_runtime_status",
        "lane": LANE_ID,
        "plans_path": rel_path(root, &plans_path(root)),
        "history_path": rel_path(root, &history_path(root)),
        "runs_dir": rel_path(root, &runs_dir(root)),
        "plan_count": plan_count,
        "run_count": runs,
        "organ_id": if organ_filter.is_empty() { Value::Null } else { Value::String(organ_filter) },
        "organ_plan": matched_plan
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn cli_error(argv: &[String], err: &str, exit_code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "child_organ_runtime_cli_error",
        "lane": LANE_ID,
        "argv": argv,
        "error": err,
        "exit_code": exit_code
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let policy = load_policy(root);
    let command = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    let result = match command.as_str() {
        "plan" => plan_payload(root, &policy, &argv[1..]),
        "spawn" => spawn_payload(root, &policy, &argv[1..]),
        "status" => Ok(status_payload(root, &argv[1..])),
        _ => Err("unknown_command".to_string()),
    };

    match result {
        Ok(payload) => {
            let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(false);
            print_json_line(&payload);
            if ok {
                0
            } else {
                1
            }
        }
        Err(err) => {
            if err == "unknown_command" {
                usage();
            }
            print_json_line(&cli_error(argv, &err, 2));
            2
        }
    }
}
