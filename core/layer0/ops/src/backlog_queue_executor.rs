// SPDX-License-Identifier: Apache-2.0
use crate::{clean, deterministic_receipt_hash, now_iso, parse_args};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn state_root(root: &Path) -> PathBuf {
    if let Ok(v) = std::env::var("BACKLOG_QUEUE_EXECUTOR_STATE_ROOT") {
        let s = v.trim();
        if !s.is_empty() {
            return PathBuf::from(s);
        }
    }
    root.join("client")
        .join("local")
        .join("state")
        .join("ops")
        .join("backlog_queue_executor")
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn history_path(root: &Path) -> PathBuf {
    state_root(root).join("history.jsonl")
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut body) = serde_json::to_string_pretty(value) {
        body.push('\n');
        let _ = fs::write(path, body);
    }
}

fn append_jsonl(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(line) = serde_json::to_string(value) {
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| {
                std::io::Write::write_all(&mut file, format!("{line}\n").as_bytes())
            });
    }
}

fn parse_bool(raw: Option<&String>, fallback: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

fn parse_i64(raw: Option<&String>, fallback: i64, lo: i64, hi: i64) -> i64 {
    raw.and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(fallback)
        .clamp(lo, hi)
}

fn print_receipt(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn parse_srs_rows(path: &Path) -> Vec<(String, String)> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in raw.lines() {
        let l = line.trim();
        if !l.starts_with('|') {
            continue;
        }
        let cells: Vec<String> = l
            .trim_matches('|')
            .split('|')
            .map(|v| v.trim().to_string())
            .collect();
        if cells.len() < 2 {
            continue;
        }
        let id = cells[0].trim();
        if id == "ID" || id.starts_with("---") {
            continue;
        }
        if !id.starts_with('V') || !id.contains('-') {
            continue;
        }
        out.push((id.to_string(), cells[1].trim().to_ascii_lowercase()));
    }
    out
}

fn parse_ids_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|v| clean(v, 256).to_ascii_uppercase())
        .filter(|v| !v.is_empty())
        .collect()
}

fn lane_script_name(id: &str) -> String {
    format!("lane:{}:run", id.to_ascii_lowercase().replace('_', "-"))
}

fn test_script_name(id: &str) -> String {
    format!("test:lane:{}", id.to_ascii_lowercase().replace('_', "-"))
}

fn detect_missing_node_entrypoint(root: &Path, script_cmd: &str) -> Option<String> {
    let segment = script_cmd
        .split("&&")
        .next()
        .unwrap_or(script_cmd)
        .split("||")
        .next()
        .unwrap_or(script_cmd)
        .trim();
    let mut parts = segment.split_whitespace();
    let runner = parts.next()?;
    if runner != "node" {
        return None;
    }

    let mut entry = parts.next()?;
    while entry.starts_with('-') {
        entry = parts.next()?;
    }
    let entry = entry.trim_matches('"').trim_matches('\'');
    if entry.is_empty() || entry.starts_with('$') {
        return None;
    }

    let path = root.join(entry);
    if path.exists() {
        None
    } else {
        Some(entry.to_string())
    }
}

fn parse_npm_run_target(script_cmd: &str) -> Option<String> {
    let segment = script_cmd
        .split("&&")
        .next()
        .unwrap_or(script_cmd)
        .split("||")
        .next()
        .unwrap_or(script_cmd)
        .trim();
    let mut parts = segment.split_whitespace();
    if parts.next()? != "npm" {
        return None;
    }
    if parts.next()? != "run" {
        return None;
    }
    for token in parts {
        if token == "--" {
            continue;
        }
        if token.starts_with('-') {
            continue;
        }
        return Some(token.to_string());
    }
    None
}

fn detect_missing_entrypoint_for_script(
    root: &Path,
    scripts: &serde_json::Map<String, Value>,
    script_name: &str,
    depth: usize,
    seen: &mut std::collections::HashSet<String>,
) -> Option<String> {
    if depth > 6 {
        return None;
    }
    if !seen.insert(script_name.to_string()) {
        return None;
    }
    let cmd = scripts.get(script_name).and_then(|v| v.as_str())?;
    if let Some(missing) = detect_missing_node_entrypoint(root, cmd) {
        return Some(missing);
    }
    if let Some(nested) = parse_npm_run_target(cmd) {
        return detect_missing_entrypoint_for_script(root, scripts, &nested, depth + 1, seen);
    }
    None
}

fn load_npm_scripts(root: &Path) -> serde_json::Map<String, Value> {
    let pkg_path = root.join("package.json");
    let Ok(raw) = fs::read_to_string(pkg_path) else {
        return serde_json::Map::new();
    };
    let Ok(val) = serde_json::from_str::<Value>(&raw) else {
        return serde_json::Map::new();
    };
    val.get("scripts")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

fn run_npm_script(root: &Path, script: &str) -> Value {
    let output = Command::new("npm")
        .arg("run")
        .arg("-s")
        .arg(script)
        .current_dir(root)
        .output();
    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            json!({
                "ok": out.status.success(),
                "status": out.status.code().unwrap_or(-1),
                "stdout": clean(&stdout, 4000),
                "stderr": clean(&stderr, 4000)
            })
        }
        Err(err) => json!({
            "ok": false,
            "status": -1,
            "stdout": "",
            "stderr": clean(&format!("spawn_failed:{err}"), 4000)
        }),
    }
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
        println!("  protheus-ops backlog-queue-executor run [--all=1] [--ids=A,B] [--max=N] [--dry-run=1]");
        println!("  protheus-ops backlog-queue-executor status");
        return 0;
    }

    let latest = latest_path(root);
    let history = history_path(root);

    if command == "status" {
        let mut out = json!({
            "ok": true,
            "type": "backlog_queue_executor_status",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "latest": read_json(&latest)
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        print_receipt(&out);
        return 0;
    }

    let dry_run = parse_bool(
        parsed
            .flags
            .get("dry-run")
            .or_else(|| parsed.flags.get("dry_run")),
        false,
    );
    let max = parse_i64(parsed.flags.get("max"), 50, 1, 2000);
    let ids = clean(parsed.flags.get("ids").cloned().unwrap_or_default(), 4000);
    let all = parse_bool(parsed.flags.get("all"), false);

    let srs_rows = parse_srs_rows(&root.join("docs/workspace/SRS.md"));
    let actionable_status = ["queued", "in_progress"];
    let mut candidates: Vec<String> = srs_rows
        .into_iter()
        .filter(|(_, status)| actionable_status.contains(&status.as_str()))
        .map(|(id, _)| id)
        .collect();

    let requested_ids = parse_ids_csv(&ids);
    if !requested_ids.is_empty() {
        let requested: std::collections::HashSet<String> = requested_ids.into_iter().collect();
        candidates.retain(|id| requested.contains(id));
    }

    if !all && (candidates.len() as i64) > max {
        candidates.truncate(max as usize);
    }
    let mut dedup = std::collections::HashSet::new();
    candidates.retain(|id| dedup.insert(id.clone()));

    let scripts = load_npm_scripts(root);
    let mut executed = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    let mut rows = Vec::new();

    for id in candidates.iter() {
        let lane_script = lane_script_name(id);
        let test_script = test_script_name(id);
        let lane_cmd = scripts.get(&lane_script).and_then(|v| v.as_str()).unwrap_or("");
        let lane_exists = !lane_cmd.is_empty();
        let test_cmd = scripts.get(&test_script).and_then(|v| v.as_str()).unwrap_or("");
        let mut test_exists = !test_cmd.is_empty();

        if !lane_exists {
            skipped += 1;
            rows.push(json!({
                "id": id,
                "lane_script": lane_script,
                "status": "skipped",
                "reason": "lane_script_missing"
            }));
            continue;
        }

        let mut lane_seen = std::collections::HashSet::new();
        if let Some(missing_entry) =
            detect_missing_entrypoint_for_script(root, &scripts, &lane_script, 0, &mut lane_seen)
        {
            skipped += 1;
            rows.push(json!({
                "id": id,
                "lane_script": lane_script,
                "status": "skipped",
                "reason": "lane_entrypoint_missing",
                "missing_entrypoint": missing_entry
            }));
            continue;
        }
        let mut test_skip_reason = Value::Null;
        if test_exists {
            let mut test_seen = std::collections::HashSet::new();
            if let Some(missing_test_entry) =
                detect_missing_entrypoint_for_script(root, &scripts, &test_script, 0, &mut test_seen)
            {
                test_exists = false;
                test_skip_reason = json!({
                    "reason": "test_entrypoint_missing",
                    "missing_entrypoint": missing_test_entry
                });
            }
        }

        if dry_run {
            skipped += 1;
            rows.push(json!({
                "id": id,
                "lane_script": lane_script,
                "test_script": if test_exists { Value::String(test_script.clone()) } else { Value::Null },
                "status": "planned",
                "test_skip_reason": test_skip_reason
            }));
            continue;
        }

        let lane_result = run_npm_script(root, &lane_script);
        let mut test_result = Value::Null;
        let lane_ok = lane_result
            .get("ok")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let mut test_ok = true;
        if test_exists && lane_ok {
            test_result = run_npm_script(root, &test_script);
            test_ok = test_result
                .get("ok")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
        }

        if lane_ok && test_ok {
            executed += 1;
            rows.push(json!({
                "id": id,
                "lane_script": lane_script,
                "test_script": if test_exists { Value::String(test_script.clone()) } else { Value::Null },
                "status": "executed",
                "test_skip_reason": test_skip_reason,
                "lane_result": lane_result,
                "test_result": test_result
            }));
        } else {
            failed += 1;
            rows.push(json!({
                "id": id,
                "lane_script": lane_script,
                "test_script": if test_exists { Value::String(test_script.clone()) } else { Value::Null },
                "status": "failed",
                "test_skip_reason": test_skip_reason,
                "lane_result": lane_result,
                "test_result": test_result
            }));
        }
    }

    let mut out = json!({
        "ok": failed == 0,
        "type": "backlog_queue_executor",
        "lane": "core/layer0/ops",
        "ts": now_iso(),
        "command": command,
        "dry_run": dry_run,
        "all": all,
        "max": max,
        "ids": ids,
        "counts": {
            "scanned": candidates.len(),
            "executed": executed,
            "skipped": skipped,
            "failed": failed
        },
        "rows": rows
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    write_json(&latest, &out);
    append_jsonl(&history, &out);
    print_receipt(&out);
    0
}
