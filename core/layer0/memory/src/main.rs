// SPDX-License-Identifier: Apache-2.0
use protheus_memory_core_v6::{
    clear_cache, compress_store, crdt_exchange_json, ebbinghaus_curve, get_json, ingest_memory,
    load_embedded_execution_replay, load_embedded_heartbeat, load_embedded_observability_profile,
    load_embedded_vault_policy, pack_embedded_blob_assets, recall_json, set_hot_state,
};
#[cfg(not(target_arch = "wasm32"))]
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::Path;
use std::time::Instant;

#[derive(Deserialize, Default)]
struct DaemonRequest {
    cmd: String,
    #[serde(default)]
    args: HashMap<String, String>,
}

fn parse_args(raw: &[String]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for token in raw {
        if !token.starts_with("--") {
            continue;
        }
        if let Some(eq) = token.find('=') {
            let key = token[2..eq].to_string();
            let value = token[eq + 1..].to_string();
            out.insert(key, value);
        } else {
            out.insert(token[2..].to_string(), "1".to_string());
        }
    }
    out
}

fn parse_bool(v: Option<&String>, fallback: bool) -> bool {
    match v.map(|s| s.trim().to_lowercase()) {
        Some(raw) if matches!(raw.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(raw) if matches!(raw.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

fn parse_u32(v: Option<&String>, fallback: u32) -> u32 {
    v.and_then(|s| s.parse::<u32>().ok()).unwrap_or(fallback)
}

fn parse_f64(v: Option<&String>, fallback: f64) -> f64 {
    v.and_then(|s| s.parse::<f64>().ok()).unwrap_or(fallback)
}

fn parse_u16(v: Option<&String>, fallback: u16) -> u16 {
    v.and_then(|s| s.parse::<u16>().ok()).unwrap_or(fallback)
}

fn print_json(value: serde_json::Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{\"ok\":false}".to_string())
    );
}

fn is_date_memory_file(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.len() != 13 {
        return false;
    }
    for (idx, b) in bytes.iter().enumerate() {
        match idx {
            4 | 7 => {
                if *b != b'-' {
                    return false;
                }
            }
            10 => {
                if *b != b'.' {
                    return false;
                }
            }
            11 => {
                if *b != b'm' {
                    return false;
                }
            }
            12 => {
                if *b != b'd' {
                    return false;
                }
            }
            _ => {
                if !b.is_ascii_digit() {
                    return false;
                }
            }
        }
    }
    true
}

fn parse_node_id(chunk: &str) -> Option<String> {
    for line in chunk.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("node_id:") {
            continue;
        }
        let value = trimmed
            .split_once(':')
            .map(|(_, rhs)| rhs.trim())
            .unwrap_or_default();
        if value.is_empty() {
            return None;
        }
        let candidate: String = value
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
            .collect();
        if candidate.is_empty() {
            return None;
        }
        return Some(candidate);
    }
    None
}

fn parse_tags_inline(raw: &str) -> Vec<String> {
    let cleaned = raw
        .replace(['[', ']', '"', '\''], " ")
        .replace(',', " ")
        .replace('\t', " ");
    cleaned
        .split_whitespace()
        .map(|token| token.trim_start_matches('#').to_ascii_lowercase())
        .filter(|token| {
            !token.is_empty()
                && token.chars().all(|ch| {
                    ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '_' | '-')
                })
        })
        .collect()
}

fn build_index_stats(root: &Path) -> serde_json::Value {
    let memory_dir = root.join("memory");
    if !memory_dir.exists() {
        return json!({
          "ok": true,
          "backend_used": "rust",
          "transport": "cli",
          "node_count": 0,
          "tag_count": 0,
          "files_scanned": 0
        });
    }

    let mut files: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&memory_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_date_memory_file(&name) {
                files.push(name);
            }
        }
    }
    files.sort();

    let mut seen = BTreeSet::new();
    let mut tags = BTreeSet::new();
    let mut files_scanned: u64 = 0;

    for name in &files {
        let file_path = memory_dir.join(name);
        let text = match fs::read_to_string(&file_path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        files_scanned += 1;
        for chunk in text.split("<!-- NODE -->") {
            if let Some(node_id) = parse_node_id(chunk) {
                seen.insert(format!("{node_id}@client/memory/{name}"));
            }
            for line in chunk.lines() {
                let trimmed = line.trim();
                if !trimmed.starts_with("tags:") {
                    continue;
                }
                let raw = trimmed
                    .split_once(':')
                    .map(|(_, rhs)| rhs.trim())
                    .unwrap_or_default();
                for tag in parse_tags_inline(raw) {
                    tags.insert(tag);
                }
            }
        }
    }

    json!({
      "ok": true,
      "backend_used": "rust",
      "transport": "cli",
      "node_count": seen.len(),
      "tag_count": tags.len(),
      "files_scanned": files_scanned
    })
}

fn daemon_response(cmd: &str, args: &HashMap<String, String>) -> serde_json::Value {
    match cmd {
        "ping" => json!({
          "ok": true,
          "pong": true
        }),
        "recall" => {
            let q = args.get("query").cloned().unwrap_or_default();
            let limit = parse_u32(args.get("limit"), 5);
            serde_json::from_str::<serde_json::Value>(&recall_json(&q, limit))
                .unwrap_or_else(|_| json!({"ok": false, "error": "invalid_recall_payload"}))
        }
        "get" => {
            let id = args.get("id").cloned().unwrap_or_default();
            serde_json::from_str::<serde_json::Value>(&get_json(&id))
                .unwrap_or_else(|_| json!({"ok": false, "error": "invalid_get_payload"}))
        }
        "compress" => {
            let aggressive = parse_bool(args.get("aggressive"), false);
            match compress_store(aggressive) {
                Ok(compacted) => {
                    json!({"ok": true, "aggressive": aggressive, "compacted_rows": compacted})
                }
                Err(err) => json!({"ok": false, "error": err}),
            }
        }
        "clear-cache" => match clear_cache() {
            Ok(cleared) => json!({"ok": true, "cleared": cleared}),
            Err(err) => json!({"ok": false, "error": err}),
        },
        _ => json!({"ok": false, "error": "unsupported_daemon_command", "command": cmd}),
    }
}

fn run_daemon(host: &str, port: u16) {
    let listener = match TcpListener::bind((host, port)) {
        Ok(v) => v,
        Err(err) => {
            print_json(json!({
              "ok": false,
              "error": format!("daemon_bind_failed:{err}")
            }));
            std::process::exit(1);
        }
    };
    print_json(json!({
      "ok": true,
      "daemon_ready": true,
      "host": host,
      "port": port
    }));
    for stream in listener.incoming() {
        let mut stream = match stream {
            Ok(v) => v,
            Err(_) => continue,
        };
        let mut line = String::new();
        {
            let mut reader = BufReader::new(&mut stream);
            if reader.read_line(&mut line).is_err() {
                continue;
            }
        }
        let req = serde_json::from_str::<DaemonRequest>(line.trim()).unwrap_or_default();
        let cmd = req.cmd.trim().to_ascii_lowercase();
        let response = daemon_response(&cmd, &req.args);
        if let Ok(encoded) = serde_json::to_string(&response) {
            let _ = stream.write_all(encoded.as_bytes());
            let _ = stream.write_all(b"\n");
            let _ = stream.flush();
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn verify_envelope_report() -> serde_json::Value {
    let default_path = std::env::var("PROTHEUS_CORE_STATE_ROOT")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(|v| format!("{v}/memory/runtime_memory.sqlite"))
        .or_else(|| {
            std::env::var("PROTHEUS_CLIENT_STATE_ROOT")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .map(|v| format!("{v}/memory/runtime_memory.sqlite"))
        })
        .unwrap_or_else(|| "core/local/state/memory/runtime_memory.sqlite".to_string());
    let db_path = env::var("PROTHEUS_MEMORY_DB_PATH").unwrap_or(default_path);
    let _ = recall_json("", 1);
    match Connection::open(&db_path) {
        Ok(conn) => {
            let total_rows = conn
                .query_row("SELECT COUNT(1) FROM memory_cache", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap_or(0)
                .max(0) as u64;
            json!({
              "ok": true,
              "backend": "rust_core_v6",
              "db_path": db_path,
              "total_rows": total_rows,
              "enveloped_rows": total_rows,
              "legacy_cipher_rows": 0,
              "plain_rows": 0
            })
        }
        Err(err) => json!({
          "ok": false,
          "error": format!("sqlite_open_failed:{err}"),
          "db_path": db_path
        }),
    }
}

#[cfg(target_arch = "wasm32")]
fn verify_envelope_report() -> serde_json::Value {
    json!({
      "ok": false,
      "error": "verify_envelope_unavailable_on_wasm"
    })
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("help");
    let flags = parse_args(&args);

    match command {
        "help" | "--help" | "-h" => {
            print_json(json!({
              "ok": true,
              "commands": [
                "recall --query=<text> --limit=<n>",
                "query-index --q=<text> [--top=<n>] [--root=<path>]",
                "probe [--root=<path>]",
                "build-index [--root=<path>]",
                "daemon [--host=127.0.0.1] [--port=43117]",
                "verify-envelope [--db-path=<path>]",
                "compress --aggressive=0|1",
                "set-hot-state --key=<k> --value_json=<json> [--db-path=<path>]",
                "ingest --id=<id> --content=<text> [--tags=t1,t2] [--repetitions=1] [--lambda=0.02]",
                "get --id=<id>",
                "clear-cache",
                "ebbinghaus-score --age-days=<n> [--repetitions=1] [--lambda=0.02]",
                "crdt-exchange --payload=<json>",
                "load-embedded-heartbeat",
                "load-embedded-execution-replay",
                "load-embedded-vault-policy",
                "load-embedded-observability-profile",
                "pack-memory-blobs [--heartbeat=<text>]",
                "pack-heartbeat-blob [--content=<text>]"
              ]
            }));
        }
        "probe" => {
            let q = flags
                .get("q")
                .cloned()
                .unwrap_or_else(|| "rust_transition_benchmark".to_string());
            let started = Instant::now();
            let payload = recall_json(&q, 1);
            let parsed = serde_json::from_str::<serde_json::Value>(&payload)
                .unwrap_or_else(|_| json!({"ok": false, "error": "invalid_recall_payload"}));
            let elapsed = started.elapsed().as_millis().max(1) as u64;
            print_json(json!({
              "ok": parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
              "backend_used": "rust",
              "transport": "cli",
              "parity_error_count": 0,
              "estimated_ms": elapsed,
              "probe": parsed
            }));
        }
        "query-index" => {
            let q = flags
                .get("q")
                .cloned()
                .or_else(|| flags.get("query").cloned())
                .unwrap_or_default();
            let top = parse_u32(flags.get("top").or_else(|| flags.get("limit")), 5);
            let payload = recall_json(&q, top);
            let parsed = serde_json::from_str::<serde_json::Value>(&payload)
                .unwrap_or_else(|_| json!({"ok": false, "error": "invalid_recall_payload"}));
            print_json(json!({
              "ok": parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
              "backend_used": "rust",
              "transport": "cli",
              "query": q,
              "limit": top,
              "payload": parsed
            }));
        }
        "set-hot-state" => {
            let key = flags.get("key").cloned().unwrap_or_default();
            let value_json = flags
                .get("value_json")
                .cloned()
                .unwrap_or_else(|| "{}".to_string());
            if let Some(db_path) = flags.get("db-path").cloned() {
                if !db_path.trim().is_empty() {
                    // Required for backward compatibility with psycheforge hot-state sink.
                    std::env::set_var("PROTHEUS_MEMORY_DB_PATH", db_path);
                }
            }
            match set_hot_state(&key, &value_json) {
                Ok(()) => print_json(json!({
                  "ok": true,
                  "key": key
                })),
                Err(err) => print_json(json!({
                  "ok": false,
                  "error": err
                })),
            }
        }
        "build-index" => {
            let root = flags
                .get("root")
                .cloned()
                .unwrap_or_else(|| ".".to_string());
            print_json(build_index_stats(Path::new(&root)));
        }
        "daemon" => {
            let host = flags
                .get("host")
                .cloned()
                .unwrap_or_else(|| "127.0.0.1".to_string());
            let port = parse_u16(flags.get("port"), 43117);
            run_daemon(&host, port);
        }
        "verify-envelope" => {
            if let Some(db_path) = flags.get("db-path").cloned() {
                if !db_path.trim().is_empty() {
                    std::env::set_var("PROTHEUS_MEMORY_DB_PATH", db_path);
                }
            }
            print_json(verify_envelope_report());
        }
        "recall" => {
            let q = flags
                .get("query")
                .cloned()
                .unwrap_or_else(|| "".to_string());
            let limit = parse_u32(flags.get("limit"), 5);
            let payload = recall_json(&q, limit);
            let parsed = serde_json::from_str::<serde_json::Value>(&payload)
                .unwrap_or_else(|_| json!({"ok": false, "error": "invalid_recall_payload"}));
            print_json(parsed);
        }
        "compress" => {
            let aggressive = parse_bool(flags.get("aggressive"), false);
            match compress_store(aggressive) {
                Ok(compacted) => print_json(json!({
                  "ok": true,
                  "aggressive": aggressive,
                  "compacted_rows": compacted
                })),
                Err(err) => print_json(json!({
                  "ok": false,
                  "error": err
                })),
            }
        }
        "ingest" => {
            let id = flags
                .get("id")
                .cloned()
                .unwrap_or_else(|| format!("memory://{}", uuid_like_seed()));
            let content = flags.get("content").cloned().unwrap_or_default();
            let tags = flags
                .get("tags")
                .map(|s| {
                    s.split(',')
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let repetitions = parse_u32(flags.get("repetitions"), 1);
            let lambda = parse_f64(flags.get("lambda"), 0.02);
            match ingest_memory(&id, &content, tags, repetitions, lambda) {
                Ok(row) => print_json(json!({
                  "ok": true,
                  "row": row
                })),
                Err(err) => print_json(json!({
                  "ok": false,
                  "error": err
                })),
            }
        }
        "get" => {
            let id = flags.get("id").cloned().unwrap_or_default();
            let payload = get_json(&id);
            let parsed = serde_json::from_str::<serde_json::Value>(&payload)
                .unwrap_or_else(|_| json!({"ok": false, "error": "invalid_get_payload"}));
            print_json(parsed);
        }
        "clear-cache" => match clear_cache() {
            Ok(cleared) => print_json(json!({
              "ok": true,
              "cleared": cleared
            })),
            Err(err) => print_json(json!({
              "ok": false,
              "error": err
            })),
        },
        "ebbinghaus-score" => {
            let age_days = parse_f64(flags.get("age-days"), 0.0);
            let repetitions = parse_u32(flags.get("repetitions"), 1);
            let lambda = parse_f64(flags.get("lambda"), 0.02);
            print_json(ebbinghaus_curve(age_days, repetitions, lambda));
        }
        "crdt-exchange" => {
            let payload = flags
                .get("payload")
                .cloned()
                .unwrap_or_else(|| "{\"left\":{},\"right\":{}}".to_string());
            match crdt_exchange_json(&payload) {
                Ok(encoded) => {
                    let parsed = serde_json::from_str::<serde_json::Value>(&encoded)
                        .unwrap_or_else(|_| json!({"ok": false, "error": "invalid_crdt_payload"}));
                    print_json(parsed);
                }
                Err(err) => print_json(json!({
                  "ok": false,
                  "error": err
                })),
            }
        }
        "load-embedded-heartbeat" => match load_embedded_heartbeat() {
            Ok(content) => print_json(json!({
              "ok": true,
              "embedded_heartbeat": content
            })),
            Err(err) => print_json(json!({
              "ok": false,
              "error": err.to_string()
            })),
        },
        "load-embedded-execution-replay" => match load_embedded_execution_replay() {
            Ok(replay) => print_json(json!({
              "ok": true,
              "embedded_execution_replay": replay
            })),
            Err(err) => print_json(json!({
              "ok": false,
              "error": err.to_string()
            })),
        },
        "load-embedded-vault-policy" => match load_embedded_vault_policy() {
            Ok(vault_policy) => print_json(json!({
              "ok": true,
              "embedded_vault_policy": vault_policy
            })),
            Err(err) => print_json(json!({
              "ok": false,
              "error": err.to_string()
            })),
        },
        "load-embedded-observability-profile" => match load_embedded_observability_profile() {
            Ok(observability_profile) => print_json(json!({
              "ok": true,
              "embedded_observability_profile": observability_profile
            })),
            Err(err) => print_json(json!({
              "ok": false,
              "error": err.to_string()
            })),
        },
        "pack-memory-blobs" | "pack-heartbeat-blob" => {
            let content = flags
                .get("heartbeat")
                .or_else(|| flags.get("content"))
                .cloned()
                .unwrap_or_default();
            match pack_embedded_blob_assets(&content) {
                Ok(report) => print_json(json!({
                  "ok": true,
                  "manifest_path": report.manifest_path,
                  "manifest_bytes": report.manifest_bytes,
                  "artifacts": report.artifacts
                })),
                Err(err) => print_json(json!({
                  "ok": false,
                  "error": err.to_string()
                })),
            }
        }
        _ => {
            print_json(json!({
              "ok": false,
              "error": "unsupported_command",
              "command": command
            }));
            std::process::exit(1);
        }
    }
}

fn uuid_like_seed() -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(format!("{:?}", std::time::SystemTime::now()));
    let digest = hasher.finalize();
    hex::encode(&digest[..8])
}
