// Layer ownership: core/layer0/ops (authoritative)
// SPDX-License-Identifier: Apache-2.0
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::cmp::Reverse;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 4173;
const DEFAULT_TEAM: &str = "ops";
const DEFAULT_REFRESH_MS: u64 = 2000;
const MAX_REQUEST_BYTES: usize = 2_000_000;
const STATE_DIR_REL: &str = "client/runtime/local/state/ui/infring_dashboard";
const ACTION_DIR_REL: &str = "client/runtime/local/state/ui/infring_dashboard/actions";
const SNAPSHOT_LATEST_REL: &str =
    "client/runtime/local/state/ui/infring_dashboard/latest_snapshot.json";
const SNAPSHOT_HISTORY_REL: &str =
    "client/runtime/local/state/ui/infring_dashboard/snapshot_history.jsonl";
const ACTION_LATEST_REL: &str =
    "client/runtime/local/state/ui/infring_dashboard/actions/latest.json";
const ACTION_HISTORY_REL: &str =
    "client/runtime/local/state/ui/infring_dashboard/actions/history.jsonl";

#[derive(Debug, Clone)]
struct Flags {
    mode: String,
    host: String,
    port: u16,
    team: String,
    refresh_ms: u64,
    pretty: bool,
}

#[derive(Debug, Clone)]
struct LaneResult {
    ok: bool,
    status: i32,
    argv: Vec<String>,
    payload: Option<Value>,
}

#[derive(Debug, Clone)]
struct FileRow {
    rel_path: String,
    full_path: PathBuf,
    mtime_ms: i64,
    mtime: String,
    size_bytes: u64,
}

#[derive(Debug)]
struct HttpRequest {
    method: String,
    path: String,
    body: Vec<u8>,
}

fn now_iso() -> String {
    crate::now_iso()
}

fn clean_text(value: &str, max_len: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .chars()
        .take(max_len)
        .collect::<String>()
}

fn parse_positive_u16(raw: &str, fallback: u16) -> u16 {
    raw.parse::<u16>().ok().unwrap_or(fallback)
}

fn parse_positive_u64(raw: &str, fallback: u64, min: u64, max: u64) -> u64 {
    raw.parse::<u64>()
        .ok()
        .map(|n| n.clamp(min, max))
        .unwrap_or(fallback)
}

fn parse_flags(argv: &[String]) -> Flags {
    let mut out = Flags {
        mode: "serve".to_string(),
        host: DEFAULT_HOST.to_string(),
        port: DEFAULT_PORT,
        team: DEFAULT_TEAM.to_string(),
        refresh_ms: DEFAULT_REFRESH_MS,
        pretty: true,
    };
    let mut mode_set = false;
    for token in argv {
        let value = token.trim();
        if value.is_empty() {
            continue;
        }
        if !mode_set && !value.starts_with("--") {
            out.mode = value.to_ascii_lowercase();
            mode_set = true;
            continue;
        }
        if let Some(rest) = value.strip_prefix("--host=") {
            let parsed = clean_text(rest, 100);
            if !parsed.is_empty() {
                out.host = parsed;
            }
            continue;
        }
        if let Some(rest) = value.strip_prefix("--port=") {
            out.port = parse_positive_u16(rest, DEFAULT_PORT);
            continue;
        }
        if let Some(rest) = value.strip_prefix("--team=") {
            let parsed = clean_text(rest, 80);
            if !parsed.is_empty() {
                out.team = parsed;
            }
            continue;
        }
        if let Some(rest) = value.strip_prefix("--refresh-ms=") {
            out.refresh_ms = parse_positive_u64(rest, DEFAULT_REFRESH_MS, 800, 60_000);
            continue;
        }
        if value == "--pretty=0" || value == "--pretty=false" {
            out.pretty = false;
            continue;
        }
    }
    out
}

fn parse_json_loose(raw: &str) -> Option<Value> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return Some(value);
    }
    for line in text.lines().rev() {
        let candidate = line.trim();
        if candidate.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(candidate) {
            return Some(value);
        }
    }
    None
}

fn run_lane(root: &Path, domain: &str, args: &[String]) -> LaneResult {
    let exe = match env::current_exe() {
        Ok(path) => path,
        Err(_) => {
            return LaneResult {
                ok: false,
                status: 1,
                argv: std::iter::once(domain.to_string())
                    .chain(args.iter().cloned())
                    .collect(),
                payload: None,
            };
        }
    };
    let output = Command::new(exe)
        .arg(domain)
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    let argv = std::iter::once(domain.to_string())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>();
    match output {
        Ok(out) => {
            let status = out.status.code().unwrap_or(1);
            let payload = parse_json_loose(&String::from_utf8_lossy(&out.stdout));
            LaneResult {
                ok: status == 0 && payload.is_some(),
                status,
                argv,
                payload,
            }
        }
        Err(_) => LaneResult {
            ok: false,
            status: 1,
            argv,
            payload: None,
        },
    }
}

fn ensure_dir(path: &Path) {
    let _ = fs::create_dir_all(path);
}

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        ensure_dir(parent);
    }
    if let Ok(body) = serde_json::to_string_pretty(value) {
        let _ = fs::write(path, format!("{body}\n"));
    }
}

fn append_jsonl(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        ensure_dir(parent);
    }
    if let Ok(line) = serde_json::to_string(value) {
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| writeln!(f, "{line}"));
    }
}

fn to_iso(ts: SystemTime) -> String {
    DateTime::<Utc>::from(ts).to_rfc3339()
}

fn file_rows(
    root: &Path,
    dir: &Path,
    max_depth: usize,
    limit: usize,
    include: &dyn Fn(&Path) -> bool,
) -> Vec<FileRow> {
    let mut rows = Vec::<FileRow>::new();
    for entry in WalkDir::new(dir)
        .max_depth(max_depth)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if !include(path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let modified = meta.modified().unwrap_or(UNIX_EPOCH);
        let mtime_ms = modified
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let rel = path
            .strip_prefix(root)
            .ok()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string());
        rows.push(FileRow {
            rel_path: rel,
            full_path: path.to_path_buf(),
            mtime_ms,
            mtime: to_iso(modified),
            size_bytes: meta.len(),
        });
    }
    rows.sort_by_key(|row| Reverse(row.mtime_ms));
    rows.truncate(limit);
    rows
}

fn read_tail_lines(path: &Path, max_lines: usize) -> Vec<String> {
    let raw = fs::read_to_string(path).unwrap_or_default();
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .rev()
        .take(max_lines)
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn collect_log_events(root: &Path) -> Vec<Value> {
    let roots = [
        root.join("core/local/state/ops"),
        root.join("client/runtime/local/state"),
    ];
    let mut rows = Vec::<Value>::new();
    for base in roots {
        let files = file_rows(root, &base, 4, 8, &|path| {
            let rel = path.to_string_lossy();
            rel.ends_with(".jsonl")
        });
        for file in files {
            for line in read_tail_lines(&file.full_path, 8) {
                let payload = parse_json_loose(&line).unwrap_or(Value::Null);
                let ts = payload
                    .get("ts")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| file.mtime.clone());
                let message = payload
                    .get("type")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| clean_text(&line, 220));
                rows.push(json!({
                    "ts": ts,
                    "source": file.rel_path,
                    "message": message
                }));
            }
        }
    }
    rows.sort_by(|a, b| {
        b.get("ts")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(a.get("ts").and_then(Value::as_str).unwrap_or(""))
    });
    rows.truncate(40);
    rows
}

fn collect_receipts(root: &Path) -> Vec<Value> {
    let roots = [
        root.join("core/local/state/ops"),
        root.join("client/runtime/local/state"),
    ];
    let mut files = Vec::<FileRow>::new();
    for base in roots {
        files.extend(file_rows(root, &base, 4, 30, &|path| {
            let rel = path.to_string_lossy();
            rel.ends_with("latest.json")
                || rel.ends_with("history.jsonl")
                || rel.ends_with(".receipt.json")
        }));
    }
    files.sort_by_key(|row| Reverse(row.mtime_ms));
    files.truncate(32);
    files
        .into_iter()
        .map(|row| {
            json!({
                "kind": if row.rel_path.ends_with(".jsonl") { "timeline" } else { "receipt" },
                "path": row.rel_path,
                "mtime": row.mtime,
                "size_bytes": row.size_bytes
            })
        })
        .collect()
}

fn collect_memory_artifacts(root: &Path) -> Vec<Value> {
    let roots = [
        root.join("client/runtime/local/state"),
        root.join("core/local/state/ops"),
    ];
    let mut rows = Vec::<Value>::new();
    for base in roots {
        for row in file_rows(root, &base, 3, 20, &|path| {
            let rel = path.to_string_lossy();
            rel.ends_with("latest.json") || rel.ends_with(".jsonl") || rel.ends_with("queue.json")
        }) {
            rows.push(json!({
                "scope": if row.rel_path.contains("memory") { "memory" } else { "state" },
                "kind": if row.rel_path.ends_with(".jsonl") { "timeline" } else { "snapshot" },
                "path": row.rel_path,
                "mtime": row.mtime
            }));
        }
    }
    rows.sort_by(|a, b| {
        b.get("mtime")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(a.get("mtime").and_then(Value::as_str).unwrap_or(""))
    });
    rows.truncate(30);
    rows
}

fn metric_rows(health: &Value) -> Vec<Value> {
    let Some(metrics) = health.get("dashboard_metrics").and_then(Value::as_object) else {
        return Vec::new();
    };
    metrics
        .iter()
        .map(|(name, row)| {
            let status = row
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let target = row
                .get("target_max")
                .map(|v| format!("<= {v}"))
                .or_else(|| row.get("target_min").map(|v| format!(">= {v}")))
                .unwrap_or_else(|| "n/a".to_string());
            json!({
                "name": name,
                "status": status,
                "value": row.get("value").cloned().unwrap_or(Value::Null),
                "target": target
            })
        })
        .collect()
}

fn build_snapshot(root: &Path, flags: &Flags) -> Value {
    let team = if flags.team.trim().is_empty() {
        DEFAULT_TEAM.to_string()
    } else {
        clean_text(&flags.team, 80)
    };
    let health = run_lane(root, "health-status", &["dashboard".to_string()]);
    let app = run_lane(
        root,
        "app-plane",
        &["history".to_string(), "--app=chat-ui".to_string()],
    );
    let collab = run_lane(
        root,
        "collab-plane",
        &["dashboard".to_string(), format!("--team={team}")],
    );
    let skills = run_lane(root, "skills-plane", &["dashboard".to_string()]);

    let health_payload = health.payload.unwrap_or_else(|| json!({}));
    let app_payload = app.payload.unwrap_or_else(|| json!({}));
    let collab_payload = collab.payload.unwrap_or_else(|| json!({}));
    let skills_payload = skills.payload.unwrap_or_else(|| json!({}));

    let mut out = json!({
        "ok": health.ok && app.ok && collab.ok && skills.ok,
        "type": "infring_dashboard_snapshot",
        "ts": now_iso(),
        "metadata": {
            "root": root.to_string_lossy().to_string(),
            "team": team,
            "refresh_ms": flags.refresh_ms,
            "authority": "rust_core_lanes",
            "lanes": {
                "health": health.argv.join(" "),
                "app": app.argv.join(" "),
                "collab": collab.argv.join(" "),
                "skills": skills.argv.join(" ")
            }
        },
        "health": health_payload,
        "app": app_payload,
        "collab": collab_payload,
        "skills": skills_payload,
        "memory": {
            "entries": collect_memory_artifacts(root)
        },
        "receipts": {
            "recent": collect_receipts(root),
            "action_history_path": ACTION_HISTORY_REL
        },
        "logs": {
            "recent": collect_log_events(root)
        },
        "apm": {
            "metrics": [],
            "checks": {},
            "alerts": {}
        }
    });
    out["apm"]["metrics"] = Value::Array(metric_rows(&out["health"]));
    out["apm"]["checks"] = out["health"]
        .get("checks")
        .cloned()
        .unwrap_or_else(|| json!({}));
    out["apm"]["alerts"] = out["health"]
        .get("alerts")
        .cloned()
        .unwrap_or_else(|| json!({}));
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn write_snapshot_receipt(root: &Path, snapshot: &Value) {
    let latest = root.join(SNAPSHOT_LATEST_REL);
    let history = root.join(SNAPSHOT_HISTORY_REL);
    write_json(&latest, snapshot);
    append_jsonl(&history, snapshot);
}

fn ui_event_payload(event: &str, payload: Value) -> LaneResult {
    let mut out = json!({
        "ok": true,
        "type": "infring_dashboard_ui_event",
        "event": event,
        "ts": now_iso()
    });
    if let Some(map) = payload.as_object() {
        for (k, v) in map {
            out[k] = v.clone();
        }
    }
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    LaneResult {
        ok: true,
        status: 0,
        argv: vec![event.to_string()],
        payload: Some(out),
    }
}

fn run_action(root: &Path, action: &str, payload: &Value) -> LaneResult {
    let normalized = clean_text(action, 80);
    match normalized.as_str() {
        "dashboard.ui.toggleControls" => {
            let open = payload
                .get("open")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            ui_event_payload("toggle_controls", json!({ "open": open }))
        }
        "dashboard.ui.toggleSection" => {
            let section = payload
                .get("section")
                .and_then(Value::as_str)
                .map(|v| clean_text(v, 80))
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "unknown".to_string());
            let open = payload
                .get("open")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            ui_event_payload(
                "toggle_section",
                json!({
                    "section": section,
                    "open": open
                }),
            )
        }
        "dashboard.ui.switchControlsTab" => {
            let tab = payload
                .get("tab")
                .and_then(Value::as_str)
                .map(|v| clean_text(v, 40))
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "swarm".to_string());
            ui_event_payload("switch_controls_tab", json!({ "tab": tab }))
        }
        "app.switchProvider" => {
            let provider = payload
                .get("provider")
                .and_then(Value::as_str)
                .map(|v| clean_text(v, 60))
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "openai".to_string());
            let model = payload
                .get("model")
                .and_then(Value::as_str)
                .map(|v| clean_text(v, 100))
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "gpt-5".to_string());
            run_lane(
                root,
                "app-plane",
                &[
                    "switch-provider".to_string(),
                    "--app=chat-ui".to_string(),
                    format!("--provider={provider}"),
                    format!("--model={model}"),
                ],
            )
        }
        "app.chat" => {
            let input = payload
                .get("input")
                .and_then(Value::as_str)
                .or_else(|| payload.get("message").and_then(Value::as_str))
                .map(|v| clean_text(v, 2000))
                .unwrap_or_default();
            if input.is_empty() {
                return LaneResult {
                    ok: false,
                    status: 2,
                    argv: vec!["app-plane".to_string(), "run".to_string()],
                    payload: Some(json!({
                        "ok": false,
                        "type": "infring_dashboard_action_error",
                        "error": "chat_input_required"
                    })),
                };
            }
            run_lane(
                root,
                "app-plane",
                &[
                    "run".to_string(),
                    "--app=chat-ui".to_string(),
                    format!("--input={input}"),
                ],
            )
        }
        "collab.launchRole" => {
            let team = payload
                .get("team")
                .and_then(Value::as_str)
                .map(|v| clean_text(v, 60))
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| DEFAULT_TEAM.to_string());
            let role = payload
                .get("role")
                .and_then(Value::as_str)
                .map(|v| clean_text(v, 60))
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "analyst".to_string());
            let shadow = payload
                .get("shadow")
                .and_then(Value::as_str)
                .map(|v| clean_text(v, 80))
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| format!("{team}-{role}-shadow"));
            run_lane(
                root,
                "collab-plane",
                &[
                    "launch-role".to_string(),
                    format!("--team={team}"),
                    format!("--role={role}"),
                    format!("--shadow={shadow}"),
                ],
            )
        }
        "skills.run" => {
            let skill = payload
                .get("skill")
                .and_then(Value::as_str)
                .map(|v| clean_text(v, 80))
                .unwrap_or_default();
            if skill.is_empty() {
                return LaneResult {
                    ok: false,
                    status: 2,
                    argv: vec!["skills-plane".to_string(), "run".to_string()],
                    payload: Some(json!({
                        "ok": false,
                        "type": "infring_dashboard_action_error",
                        "error": "skill_required"
                    })),
                };
            }
            let input = payload
                .get("input")
                .and_then(Value::as_str)
                .map(|v| clean_text(v, 600))
                .unwrap_or_default();
            let mut args = vec!["run".to_string(), format!("--skill={skill}")];
            if !input.is_empty() {
                args.push(format!("--input={input}"));
            }
            run_lane(root, "skills-plane", &args)
        }
        "dashboard.assimilate" => {
            let target = payload
                .get("target")
                .and_then(Value::as_str)
                .map(|v| clean_text(v, 120))
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "codex".to_string());
            run_lane(
                root,
                "app-plane",
                &[
                    "run".to_string(),
                    "--app=chat-ui".to_string(),
                    format!("--input=assimilate target {target} with receipt-first safety"),
                ],
            )
        }
        "dashboard.benchmark" => run_lane(root, "health-status", &["dashboard".to_string()]),
        _ => LaneResult {
            ok: false,
            status: 2,
            argv: Vec::new(),
            payload: Some(json!({
                "ok": false,
                "type": "infring_dashboard_action_error",
                "error": format!("unsupported_action:{normalized}")
            })),
        },
    }
}

fn write_action_receipt(root: &Path, action: &str, payload: &Value, lane: &LaneResult) -> Value {
    let mut row = json!({
        "ok": lane.ok,
        "type": "infring_dashboard_action_receipt",
        "ts": now_iso(),
        "action": clean_text(action, 120),
        "payload": payload.clone(),
        "lane_status": lane.status,
        "lane_argv": lane.argv,
        "lane_receipt_hash": lane
            .payload
            .as_ref()
            .and_then(|v| v.get("receipt_hash"))
            .cloned()
            .unwrap_or(Value::Null)
    });
    row["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&row));
    write_json(&root.join(ACTION_LATEST_REL), &row);
    append_jsonl(&root.join(ACTION_HISTORY_REL), &row);
    row
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn parse_request(mut stream: &TcpStream) -> Result<HttpRequest, String> {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
    let mut data = Vec::<u8>::new();
    let mut chunk = [0u8; 4096];
    let header_end;
    loop {
        let n = stream
            .read(&mut chunk)
            .map_err(|err| format!("request_read_failed:{err}"))?;
        if n == 0 {
            return Err("request_closed".to_string());
        }
        data.extend_from_slice(&chunk[..n]);
        if data.len() > MAX_REQUEST_BYTES {
            return Err("request_too_large".to_string());
        }
        if let Some(pos) = find_bytes(&data, b"\r\n\r\n") {
            header_end = pos;
            break;
        }
    }
    let header_raw = String::from_utf8_lossy(&data[..header_end]).to_string();
    let mut lines = header_raw.lines();
    let Some(first_line) = lines.next() else {
        return Err("request_line_missing".to_string());
    };
    let mut parts = first_line.split_whitespace();
    let method = parts
        .next()
        .map(|v| v.to_ascii_uppercase())
        .ok_or_else(|| "request_method_missing".to_string())?;
    let path = parts
        .next()
        .map(|v| v.split('?').next().unwrap_or("/").to_string())
        .ok_or_else(|| "request_path_missing".to_string())?;

    let mut content_length = 0usize;
    for line in lines {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        if k.trim().eq_ignore_ascii_case("content-length") {
            content_length = v.trim().parse::<usize>().unwrap_or(0);
        }
    }
    if content_length > MAX_REQUEST_BYTES {
        return Err("content_length_too_large".to_string());
    }

    let mut body = data[(header_end + 4)..].to_vec();
    while body.len() < content_length {
        let n = stream
            .read(&mut chunk)
            .map_err(|err| format!("request_body_read_failed:{err}"))?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
        if body.len() > MAX_REQUEST_BYTES {
            return Err("request_body_too_large".to_string());
        }
    }
    body.truncate(content_length);

    Ok(HttpRequest { method, path, body })
}

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    }
}

fn write_response(
    mut stream: &TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        status,
        status_reason(status),
        content_type,
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .map_err(|err| format!("response_head_write_failed:{err}"))?;
    stream
        .write_all(body)
        .map_err(|err| format!("response_body_write_failed:{err}"))?;
    stream
        .flush()
        .map_err(|err| format!("response_flush_failed:{err}"))
}

fn html_shell(refresh_ms: u64) -> String {
    const TEMPLATE: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>InfRing Unified Dashboard</title>
  <style>
    :root {
      --bg: #070b14;
      --panel: rgba(12, 20, 38, 0.86);
      --panel-soft: rgba(18, 29, 52, 0.72);
      --text: #e7f0ff;
      --muted: #a7bfde;
      --accent: #36f0c7;
      --accent-2: #5aa3ff;
      --line: rgba(112, 156, 255, 0.28);
    }
    :root[data-theme='light'] {
      --bg: #eef4ff;
      --panel: rgba(255, 255, 255, 0.94);
      --panel-soft: rgba(245, 250, 255, 0.96);
      --text: #1a2b46;
      --muted: #556f90;
      --accent: #008e71;
      --accent-2: #2458d3;
      --line: rgba(71, 106, 184, 0.34);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      color: var(--text);
      background:
        radial-gradient(circle at 10% 10%, rgba(54, 240, 199, 0.08), transparent 30%),
        radial-gradient(circle at 90% 0%, rgba(90, 163, 255, 0.09), transparent 40%),
        linear-gradient(180deg, #050912, var(--bg));
      min-height: 100vh;
    }
    .wrap {
      max-width: 1060px;
      margin: 20px auto;
      padding: 14px;
    }
    .top {
      display: flex;
      gap: 12px;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .top-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .title {
      font-size: 18px;
      font-weight: 700;
      margin: 0;
    }
    .muted { color: var(--muted); }
    .btn {
      border: 1px solid var(--line);
      background: rgba(90, 163, 255, 0.12);
      color: var(--text);
      border-radius: 9px;
      padding: 8px 10px;
      font-size: 12px;
      cursor: pointer;
    }
    .btn.primary {
      border-color: rgba(54, 240, 199, 0.54);
      background: rgba(54, 240, 199, 0.14);
    }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11px;
      color: var(--muted);
      background: var(--panel-soft);
    }
    .chat {
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel);
      padding: 12px;
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.28);
    }
    .chat-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 10px;
      font-size: 12px;
    }
    .log {
      height: 340px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
      background: var(--panel-soft);
    }
    .turn {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px;
      margin-bottom: 8px;
      background: rgba(12, 20, 38, 0.55);
    }
    .chips {
      display: flex;
      gap: 8px;
      margin: 10px 0 8px;
      flex-wrap: wrap;
    }
    .chip {
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 6px 10px;
      font-size: 11px;
      background: rgba(90, 163, 255, 0.12);
      color: var(--text);
      cursor: pointer;
    }
    .composer {
      display: flex;
      gap: 8px;
    }
    .composer input {
      flex: 1;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel-soft);
      color: var(--text);
      padding: 10px;
      font-size: 13px;
    }
    .hint {
      margin-top: 8px;
      font-size: 11px;
      color: var(--muted);
    }
    .drawer {
      position: fixed;
      top: 0;
      right: 0;
      width: min(420px, 96vw);
      height: 100vh;
      background: var(--panel);
      border-left: 1px solid var(--line);
      box-shadow: -10px 0 28px rgba(0, 0, 0, 0.32);
      padding: 14px;
      overflow: auto;
      transform: translateX(102%);
      transition: transform .18s ease-out;
      z-index: 50;
    }
    .drawer.open { transform: translateX(0); }
    details {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px;
      margin-bottom: 8px;
      background: var(--panel-soft);
    }
    .tabs {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .tab {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 11px;
      color: var(--muted);
      background: var(--panel-soft);
      cursor: pointer;
    }
    .tab.active {
      color: var(--text);
      border-color: rgba(54, 240, 199, 0.54);
      background: rgba(54, 240, 199, 0.15);
    }
    .panel { display: none; }
    .panel.active { display: block; }
    summary {
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }
    ul { margin: 8px 0 0 16px; padding: 0; }
    li { margin-bottom: 4px; font-size: 12px; color: var(--muted); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="top-left">
        <button id="themeToggle" class="btn" type="button">Light</button>
        <div>
          <h1 class="title">InfRing - Unified Agent Deck</h1>
          <div class="muted" style="font-size:12px">Chat-first UI with advanced controls in side pane</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="pill">Mode: Chat</span>
        <button id="controlsToggle" class="btn primary" type="button">Open Controls</button>
      </div>
    </div>

    <section class="chat">
      <div class="chat-head">
        <div id="sessionHint" class="muted">Session: chat-ui-default</div>
        <div id="receiptHint" class="muted" style="font-family: ui-monospace, Menlo, monospace;">Receipt: n/a</div>
      </div>
      <div id="chatLog" class="log"></div>
      <div class="chips">
        <button class="chip" data-action="new-agent" type="button">New Agent</button>
        <button class="chip" data-action="new-swarm" type="button">New Swarm</button>
        <button class="chip" data-action="assimilate" type="button">Assimilate Codex</button>
        <button class="chip" data-action="benchmark" type="button">Run Benchmark</button>
        <button class="chip" data-action="open-controls" type="button">Open Controls</button>
        <button class="chip" data-action="manage-swarm" type="button">Swarm Tab</button>
      </div>
      <div class="composer">
        <input id="chatInput" placeholder="Ask anything or type 'new agent' to begin..." />
        <button id="sendBtn" class="btn primary" type="button">Send</button>
      </div>
      <div id="typingHint" class="hint">Tip: Press Enter to send. Esc closes controls.</div>
    </section>
  </div>

  <aside id="drawer" class="drawer">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px">
      <strong>Advanced Controls</strong>
      <button id="drawerClose" class="btn" type="button">Close</button>
    </div>
    <div class="tabs">
      <button type="button" class="tab active" data-controls-tab="swarm">Swarm</button>
      <button type="button" class="tab" data-controls-tab="audit">Audit</button>
      <button type="button" class="tab" data-controls-tab="ops">Ops</button>
      <button type="button" class="tab" data-controls-tab="settings">Settings</button>
    </div>
    <section class="panel active" data-controls-panel="swarm">
      <details open>
        <summary>Swarm / Agent Management</summary>
        <div style="display:flex;gap:8px;margin:8px 0 10px">
          <button class="btn" id="launchAnalyst" type="button">Launch Analyst</button>
          <button class="btn" id="launchOrchestrator" type="button">Launch Orchestrator</button>
        </div>
        <ul id="agentsList"></ul>
      </details>
    </section>
    <section class="panel" data-controls-panel="audit">
      <details open>
        <summary>Receipts & Audit</summary>
        <ul id="receiptsList"></ul>
      </details>
      <details>
        <summary>Logs</summary>
        <ul id="logsList"></ul>
      </details>
    </section>
    <section class="panel" data-controls-panel="ops">
      <details open>
        <summary>APM & Alerts</summary>
        <ul id="metricsList"></ul>
      </details>
    </section>
    <section class="panel" data-controls-panel="settings">
      <details open>
        <summary>Workspace</summary>
        <ul>
          <li>Theme toggle is in top-left.</li>
          <li>Chat mode is default on first load.</li>
          <li>Use controls tab to access advanced surfaces.</li>
        </ul>
      </details>
    </section>
  </aside>

  <script>
    const REFRESH_MS = __REFRESH_MS__;
    const keyTheme = 'infring_dashboard_theme_v2';
    const keyOpen = 'infring_dashboard_controls_open_v2';
    const keyTab = 'infring_dashboard_controls_tab_v1';

    const ui = {
      drawer: document.getElementById('drawer'),
      controlsToggle: document.getElementById('controlsToggle'),
      drawerClose: document.getElementById('drawerClose'),
      themeToggle: document.getElementById('themeToggle'),
      chatLog: document.getElementById('chatLog'),
      chatInput: document.getElementById('chatInput'),
      sendBtn: document.getElementById('sendBtn'),
      typingHint: document.getElementById('typingHint'),
      sessionHint: document.getElementById('sessionHint'),
      receiptHint: document.getElementById('receiptHint'),
      launchAnalyst: document.getElementById('launchAnalyst'),
      launchOrchestrator: document.getElementById('launchOrchestrator'),
      agentsList: document.getElementById('agentsList'),
      receiptsList: document.getElementById('receiptsList'),
      logsList: document.getElementById('logsList'),
      metricsList: document.getElementById('metricsList'),
      tabs: Array.from(document.querySelectorAll('[data-controls-tab]')),
      panels: Array.from(document.querySelectorAll('[data-controls-panel]'))
    };

    function esc(v) {
      return String(v == null ? '' : v)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function short(v, n = 96) {
      const t = String(v == null ? '' : v).trim();
      if (!t) return 'n/a';
      return t.length <= n ? t : `${t.slice(0, n)}...`;
    }

    function getTheme() {
      try {
        return localStorage.getItem(keyTheme) === 'light' ? 'light' : 'dark';
      } catch { return 'dark'; }
    }

    function setTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      ui.themeToggle.textContent = theme === 'dark' ? 'Light' : 'Dark';
      try { localStorage.setItem(keyTheme, theme); } catch {}
    }

    function getDrawerOpen() {
      try { return localStorage.getItem(keyOpen) === '1'; } catch { return false; }
    }

    function getControlsTab() {
      try {
        const v = localStorage.getItem(keyTab);
        return v || 'swarm';
      } catch { return 'swarm'; }
    }

    async function postAction(action, payload) {
      try {
        const res = await fetch('/api/dashboard/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, payload })
        });
        return await res.json();
      } catch {
        return null;
      }
    }

    async function fetchSnapshot() {
      try {
        const res = await fetch('/api/dashboard/snapshot', { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    }

    function list(el, rows, map) {
      const items = Array.isArray(rows) ? rows : [];
      el.innerHTML = items.length
        ? items.map((row) => `<li>${map(row)}</li>`).join('')
        : '<li>No data yet.</li>';
    }

    function renderTurns(turns) {
      const rows = Array.isArray(turns) ? turns.slice(-20) : [];
      if (!rows.length) {
        ui.chatLog.innerHTML = '<div class="muted" style="font-size:12px">No turns yet.</div>';
        return;
      }
      ui.chatLog.innerHTML = rows.map((turn) => `
        <article class="turn">
          <div class="muted" style="font-size:11px">${esc(short(turn.ts || 'n/a', 28))} · ${esc(turn.status || 'complete')}</div>
          <div style="font-size:12px;color:#8fd0ff;margin-top:4px"><strong>You:</strong> ${esc(turn.user || '')}</div>
          <div style="font-size:12px;color:#9ff2cf;margin-top:4px"><strong>Agent:</strong> ${esc(turn.assistant || '')}</div>
        </article>
      `).join('');
      ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
    }

    function render(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return;
      const turns = snapshot?.app?.turns || [];
      renderTurns(turns);
      ui.sessionHint.textContent = `Session: ${short(snapshot?.app?.session_id || 'chat-ui-default', 64)}`;
      ui.receiptHint.textContent = `Receipt: ${short(snapshot?.receipt_hash || 'n/a', 32)}`;
      list(ui.agentsList, snapshot?.collab?.dashboard?.agents || [], (row) =>
        `${esc(row.shadow || 'shadow')} · ${esc(row.role || 'role')} · ${esc(row.status || 'unknown')}`
      );
      list(ui.receiptsList, snapshot?.receipts?.recent || [], (row) => esc(short(row.path || 'artifact', 94)));
      list(ui.logsList, snapshot?.logs?.recent || [], (row) =>
        `${esc(short(row.ts || 'n/a', 24))} — ${esc(short(row.message || '', 96))}`
      );
      list(ui.metricsList, snapshot?.apm?.metrics || [], (row) =>
        `<strong>${esc(row.name || 'metric')}</strong>: ${esc(row.status || 'unknown')} (${esc(short(row.value, 22))})`
      );
    }

    function setDrawer(open) {
      ui.drawer.classList.toggle('open', open);
      ui.controlsToggle.textContent = open ? 'Close Controls' : 'Open Controls';
      try { localStorage.setItem(keyOpen, open ? '1' : '0'); } catch {}
      postAction('dashboard.ui.toggleControls', { open });
    }

    function setControlsTab(tab) {
      const selected = tab || 'swarm';
      ui.tabs.forEach((el) => {
        el.classList.toggle('active', el.getAttribute('data-controls-tab') === selected);
      });
      ui.panels.forEach((el) => {
        el.classList.toggle('active', el.getAttribute('data-controls-panel') === selected);
      });
      try { localStorage.setItem(keyTab, selected); } catch {}
      postAction('dashboard.ui.switchControlsTab', { tab: selected });
    }

    ui.controlsToggle.addEventListener('click', () => setDrawer(!ui.drawer.classList.contains('open')));
    ui.drawerClose.addEventListener('click', () => setDrawer(false));
    ui.themeToggle.addEventListener('click', () => {
      const next = getTheme() === 'dark' ? 'light' : 'dark';
      setTheme(next);
    });
    ui.tabs.forEach((el) => {
      el.addEventListener('click', () => setControlsTab(el.getAttribute('data-controls-tab')));
    });
    ui.launchAnalyst.addEventListener('click', async () => {
      await postAction('collab.launchRole', { team: 'ops', role: 'analyst', shadow: 'ops-analyst' });
      const snap = await fetchSnapshot();
      render(snap);
    });
    ui.launchOrchestrator.addEventListener('click', async () => {
      await postAction('collab.launchRole', { team: 'ops', role: 'orchestrator', shadow: 'ops-orchestrator' });
      const snap = await fetchSnapshot();
      render(snap);
    });

    document.querySelectorAll('[data-action]').forEach((el) => {
      el.addEventListener('click', async () => {
        const name = el.getAttribute('data-action');
        if (name === 'new-agent') await postAction('collab.launchRole', { team: 'ops', role: 'analyst', shadow: 'ops-analyst' });
        if (name === 'new-swarm') await postAction('collab.launchRole', { team: 'ops', role: 'orchestrator', shadow: 'ops-orchestrator' });
        if (name === 'assimilate') await postAction('dashboard.assimilate', { target: 'codex' });
        if (name === 'benchmark') await postAction('dashboard.benchmark', {});
        if (name === 'open-controls') setDrawer(true);
        if (name === 'manage-swarm') {
          setDrawer(true);
          setControlsTab('swarm');
        }
        const snap = await fetchSnapshot();
        render(snap);
      });
    });

    async function sendChat() {
      const text = String(ui.chatInput.value || '').trim();
      if (!text) return;
      ui.sendBtn.disabled = true;
       ui.typingHint.textContent = 'Sending...';
      await postAction('app.chat', { input: text });
      ui.chatInput.value = '';
      const snap = await fetchSnapshot();
      render(snap);
      ui.sendBtn.disabled = false;
      ui.typingHint.textContent = "Tip: Press Enter to send. Esc closes controls.";
    }

    ui.sendBtn.addEventListener('click', sendChat);
    ui.chatInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        sendChat();
      }
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') setDrawer(false);
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        ui.chatInput.focus();
      }
    });

    (async function boot() {
      setTheme(getTheme());
      setDrawer(getDrawerOpen());
      setControlsTab(getControlsTab());
      const first = await fetchSnapshot();
      render(first);
      setInterval(async () => {
        const snap = await fetchSnapshot();
        render(snap);
      }, REFRESH_MS);
    })();
  </script>
</body>
</html>
"#;
    TEMPLATE.replace("__REFRESH_MS__", &refresh_ms.to_string())
}

fn handle_request(
    root: &Path,
    flags: &Flags,
    latest_snapshot: &Arc<Mutex<Value>>,
    stream: &TcpStream,
) -> Result<(), String> {
    let req = parse_request(stream)?;
    if req.method == "GET" && (req.path == "/" || req.path == "/dashboard") {
        let html = html_shell(flags.refresh_ms);
        return write_response(stream, 200, "text/html; charset=utf-8", html.as_bytes());
    }

    if req.method == "GET" && req.path == "/api/dashboard/snapshot" {
        let snapshot = build_snapshot(root, flags);
        write_snapshot_receipt(root, &snapshot);
        if let Ok(mut guard) = latest_snapshot.lock() {
            *guard = snapshot.clone();
        }
        let body = serde_json::to_string_pretty(&snapshot).unwrap_or_else(|_| "{}".to_string());
        return write_response(
            stream,
            200,
            "application/json; charset=utf-8",
            body.as_bytes(),
        );
    }

    if req.method == "POST" && req.path == "/api/dashboard/action" {
        let payload =
            parse_json_loose(&String::from_utf8_lossy(&req.body)).unwrap_or_else(|| json!({}));
        let action = payload
            .get("action")
            .and_then(Value::as_str)
            .map(|v| clean_text(v, 80))
            .unwrap_or_default();
        let action_payload = payload.get("payload").cloned().unwrap_or_else(|| json!({}));
        let lane = run_action(root, &action, &action_payload);
        let action_receipt = write_action_receipt(root, &action, &action_payload, &lane);
        let snapshot = build_snapshot(root, flags);
        write_snapshot_receipt(root, &snapshot);
        if let Ok(mut guard) = latest_snapshot.lock() {
            *guard = snapshot.clone();
        }
        let out = json!({
            "ok": lane.ok,
            "type": "infring_dashboard_action_response",
            "action": action,
            "action_receipt": action_receipt,
            "lane": lane.payload.unwrap_or(Value::Null),
            "snapshot": snapshot
        });
        let body = serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{}".to_string());
        let status = if out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            200
        } else {
            400
        };
        return write_response(
            stream,
            status,
            "application/json; charset=utf-8",
            body.as_bytes(),
        );
    }

    if req.method == "GET" && req.path == "/healthz" {
        let hash = latest_snapshot
            .lock()
            .ok()
            .and_then(|s| s.get("receipt_hash").cloned())
            .unwrap_or(Value::Null);
        let out = json!({
            "ok": true,
            "type": "infring_dashboard_healthz",
            "ts": now_iso(),
            "receipt_hash": hash
        });
        let body = serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{}".to_string());
        return write_response(
            stream,
            200,
            "application/json; charset=utf-8",
            body.as_bytes(),
        );
    }

    let out = json!({
        "ok": false,
        "type": "infring_dashboard_not_found",
        "path": req.path
    });
    let body = serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{}".to_string());
    write_response(
        stream,
        404,
        "application/json; charset=utf-8",
        body.as_bytes(),
    )
}

fn run_serve(root: &Path, flags: &Flags) -> i32 {
    ensure_dir(&root.join(STATE_DIR_REL));
    ensure_dir(&root.join(ACTION_DIR_REL));

    let initial = build_snapshot(root, flags);
    write_snapshot_receipt(root, &initial);
    let latest_snapshot = Arc::new(Mutex::new(initial.clone()));
    let addr = format!("{}:{}", flags.host, flags.port);
    let listener = match TcpListener::bind(&addr) {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!(
                "{}",
                json!({
                    "ok": false,
                    "type": "infring_dashboard_server_error",
                    "error": clean_text(&format!("bind_failed:{err}"), 220),
                    "host": flags.host,
                    "port": flags.port
                })
            );
            return 1;
        }
    };

    let url = format!("http://{}:{}/dashboard", flags.host, flags.port);
    let status = json!({
        "ok": true,
        "type": "infring_dashboard_server",
        "ts": now_iso(),
        "url": url,
        "host": flags.host,
        "port": flags.port,
        "refresh_ms": flags.refresh_ms,
        "team": flags.team,
        "authority": "rust_core",
        "receipt_hash": initial.get("receipt_hash").cloned().unwrap_or(Value::Null),
        "snapshot_path": SNAPSHOT_LATEST_REL,
        "action_path": ACTION_LATEST_REL
    });
    write_json(
        &root.join(STATE_DIR_REL).join("server_status.json"),
        &status,
    );
    println!(
        "{}",
        serde_json::to_string_pretty(&status).unwrap_or_else(|_| "{}".to_string())
    );
    println!("Dashboard listening at {url}");

    for stream in listener.incoming() {
        let Ok(stream) = stream else {
            continue;
        };
        if let Err(err) = handle_request(root, flags, &latest_snapshot, &stream) {
            let out = json!({
                "ok": false,
                "type": "infring_dashboard_request_error",
                "ts": now_iso(),
                "error": clean_text(&err, 240)
            });
            let body =
                serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{\"ok\":false}".to_string());
            let _ = write_response(
                &stream,
                500,
                "application/json; charset=utf-8",
                body.as_bytes(),
            );
        }
    }
    0
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let flags = parse_flags(argv);
    match flags.mode.as_str() {
        "snapshot" | "status" => {
            let snapshot = build_snapshot(root, &flags);
            write_snapshot_receipt(root, &snapshot);
            if flags.pretty {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&snapshot).unwrap_or_else(|_| "{}".to_string())
                );
            } else {
                println!(
                    "{}",
                    serde_json::to_string(&snapshot).unwrap_or_else(|_| "{}".to_string())
                );
            }
            0
        }
        "serve" | "web" => run_serve(root, &flags),
        _ => {
            eprintln!(
                "{}",
                json!({
                    "ok": false,
                    "type": "infring_dashboard_cli_error",
                    "error": format!("unsupported_mode:{} (expected serve|snapshot|status)", flags.mode)
                })
            );
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_flags_defaults() {
        let flags = parse_flags(&[]);
        assert_eq!(flags.mode, "serve");
        assert_eq!(flags.host, "127.0.0.1");
        assert_eq!(flags.port, 4173);
        assert_eq!(flags.team, "ops");
    }

    #[test]
    fn parse_flags_overrides() {
        let flags = parse_flags(&[
            "snapshot".to_string(),
            "--host=0.0.0.0".to_string(),
            "--port=8080".to_string(),
            "--team=alpha".to_string(),
            "--refresh-ms=5000".to_string(),
            "--pretty=0".to_string(),
        ]);
        assert_eq!(flags.mode, "snapshot");
        assert_eq!(flags.host, "0.0.0.0");
        assert_eq!(flags.port, 8080);
        assert_eq!(flags.team, "alpha");
        assert_eq!(flags.refresh_ms, 5000);
        assert!(!flags.pretty);
    }

    #[test]
    fn parse_json_loose_supports_multiline_logs() {
        let raw = "noise\n{\"ok\":false}\n{\"ok\":true,\"type\":\"x\"}\n";
        let parsed = parse_json_loose(raw).expect("json");
        assert_eq!(parsed.get("ok").and_then(Value::as_bool), Some(true));
    }
}
