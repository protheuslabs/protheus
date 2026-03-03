use chrono::Utc;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn clean_text(v: &str, max_len: usize) -> String {
    let mut out = String::with_capacity(v.len().min(max_len));
    let mut last_space = false;
    for ch in v.chars() {
        let mapped = if ch.is_whitespace() { ' ' } else { ch };
        if mapped == ' ' {
            if last_space {
                continue;
            }
            last_space = true;
        } else {
            last_space = false;
        }
        out.push(mapped);
        if out.len() >= max_len {
            break;
        }
    }
    out.trim().to_string()
}

fn parse_flags(args: &[String]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for token in args {
        if !token.starts_with("--") {
            continue;
        }
        if let Some((k, v)) = token[2..].split_once('=') {
            out.insert(k.to_string(), v.to_string());
        } else {
            out.insert(token[2..].to_string(), "1".to_string());
        }
    }
    out
}

fn parse_json_payload(raw: &str) -> Option<Value> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return Some(v);
    }
    let lines: Vec<&str> = text
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect();
    for line in lines.iter().rev() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            return Some(v);
        }
    }
    None
}

fn ensure_dir(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
}

fn read_json(path: &Path) -> Value {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

fn write_json_atomic(path: &Path, value: &Value) {
    ensure_dir(path);
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let payload = serde_json::to_vec_pretty(value).unwrap_or_else(|_| b"{}\n".to_vec());
    if fs::write(&tmp, payload).is_ok() {
        let _ = fs::rename(tmp, path);
    }
}

fn append_jsonl(path: &Path, value: &Value) {
    ensure_dir(path);
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        if let Ok(row) = serde_json::to_string(value) {
            let _ = file.write_all(row.as_bytes());
            let _ = file.write_all(b"\n");
        }
    }
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    let raw = match fs::read_to_string(path) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    raw.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .collect()
}

fn resolve_path(root: &Path, raw: Option<&str>, fallback_rel: &str) -> PathBuf {
    let fallback = root.join(fallback_rel);
    let Some(raw) = raw else { return fallback };
    let expanded = raw
        .replace("${OPENCLAW_WORKSPACE}", &root.to_string_lossy())
        .replacen("$OPENCLAW_WORKSPACE", &root.to_string_lossy(), 1);
    if expanded.trim().is_empty() {
        return fallback;
    }
    let p = PathBuf::from(expanded);
    if p.is_absolute() {
        p
    } else {
        root.join(p)
    }
}

#[derive(Debug, Clone)]
struct CommandRun {
    ok: bool,
    payload: Value,
    error: String,
}

fn run_command_json(bin: &str, args: &[String], cwd: &Path) -> Option<CommandRun> {
    let output = Command::new(bin).args(args).current_dir(cwd).output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let payload = parse_json_payload(&stdout).unwrap_or(Value::Null);
    Some(CommandRun {
        ok: output.status.success() && payload.is_object(),
        payload,
        error: clean_text(&(stderr + &stdout), 320),
    })
}

fn run_memory_core(root: &Path, args: &[String]) -> CommandRun {
    let explicit = env::var("PROTHEUS_MEMORY_CORE_BIN").unwrap_or_default();
    let candidates = vec![
        explicit,
        root.join("target/release/memory-cli").to_string_lossy().to_string(),
        root.join("target/debug/memory-cli").to_string_lossy().to_string(),
        root.join("crates/memory/target/release/memory-cli")
            .to_string_lossy()
            .to_string(),
        root.join("crates/memory/target/debug/memory-cli")
            .to_string_lossy()
            .to_string(),
    ];
    for candidate in candidates {
        if candidate.trim().is_empty() || !Path::new(&candidate).exists() {
            continue;
        }
        if let Some(run) = run_command_json(&candidate, args, root) {
            if run.ok {
                return run;
            }
        }
    }

    let mut cargo_args = vec![
        "run".to_string(),
        "--quiet".to_string(),
        "--manifest-path".to_string(),
        root.join("crates/memory/Cargo.toml").to_string_lossy().to_string(),
        "--bin".to_string(),
        "memory-cli".to_string(),
        "--".to_string(),
    ];
    cargo_args.extend(args.iter().cloned());
    if let Some(run) = run_command_json("cargo", &cargo_args, root) {
        return run;
    }
    CommandRun {
        ok: false,
        payload: Value::Null,
        error: "memory_core_unavailable".to_string(),
    }
}

fn run_security_check(root: &Path, request: &Value) -> CommandRun {
    let request_json = serde_json::to_string(request).unwrap_or_else(|_| "{}".to_string());
    let arg = format!("--request-json={request_json}");
    let explicit = env::var("PROTHEUS_SECURITY_CORE_BIN").unwrap_or_default();
    let candidates = vec![
        explicit,
        root.join("target/release/security_core").to_string_lossy().to_string(),
        root.join("target/debug/security_core").to_string_lossy().to_string(),
        root.join("crates/security/target/release/security_core")
            .to_string_lossy()
            .to_string(),
        root.join("crates/security/target/debug/security_core")
            .to_string_lossy()
            .to_string(),
    ];
    for candidate in candidates {
        if candidate.trim().is_empty() || !Path::new(&candidate).exists() {
            continue;
        }
        if let Some(run) = run_command_json(&candidate, &["check".to_string(), arg.clone()], root) {
            if run.ok {
                return run;
            }
        }
    }

    let cargo_args = vec![
        "run".to_string(),
        "--quiet".to_string(),
        "--manifest-path".to_string(),
        root.join("crates/security/Cargo.toml")
            .to_string_lossy()
            .to_string(),
        "--bin".to_string(),
        "security_core".to_string(),
        "--".to_string(),
        "check".to_string(),
        arg,
    ];
    if let Some(run) = run_command_json("cargo", &cargo_args, root) {
        return run;
    }
    CommandRun {
        ok: false,
        payload: Value::Null,
        error: "security_core_unavailable".to_string(),
    }
}

fn memory_view_policy(root: &Path) -> Value {
    let policy_path = env::var("MEMORY_ABSTRACTION_VIEW_POLICY_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("config/memory_abstraction_view_policy.json"));
    let raw = read_json(&policy_path);
    let default_limit = raw
        .get("default_limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(5)
        .max(1);
    let paths = raw.get("paths").cloned().unwrap_or(Value::Null);
    let latest_path = resolve_path(
        root,
        paths
            .get("latest_path")
            .and_then(|v| v.as_str()),
        "state/memory/abstraction/memory_view_latest.json",
    );
    let receipts_path = resolve_path(
        root,
        paths
            .get("receipts_path")
            .and_then(|v| v.as_str()),
        "state/memory/abstraction/memory_view_receipts.jsonl",
    );
    json!({
      "enabled": raw.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
      "default_limit": default_limit,
      "latest_path": latest_path,
      "receipts_path": receipts_path
    })
}

fn cmd_memory_view(root: &Path, subcmd: &str, flags: &HashMap<String, String>) -> Value {
    let p = memory_view_policy(root);
    if p.get("enabled").and_then(|v| v.as_bool()) != Some(true) {
        return json!({"ok": false, "error": "memory_abstraction_view_disabled"});
    }
    let latest_path = PathBuf::from(p.get("latest_path").and_then(|v| v.as_str()).unwrap_or(""));
    let receipts_path = PathBuf::from(
        p.get("receipts_path")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    );
    let default_limit = p
        .get("default_limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(5) as u32;

    let receipt = match subcmd {
        "query" => {
            let query = clean_text(
                flags
                    .get("query")
                    .or_else(|| flags.get("q"))
                    .map(String::as_str)
                    .unwrap_or(""),
                400,
            );
            let limit = flags
                .get("limit")
                .or_else(|| flags.get("top"))
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(default_limit)
                .max(1);
            let run = run_memory_core(
                root,
                &[format!("recall"), format!("--query={query}"), format!("--limit={limit}")],
            );
            let payload = run.payload.clone();
            let hits = payload
                .get("hits")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            json!({
              "ts": now_iso(),
              "type": "memory_view_query",
              "ok": run.ok,
              "backend": "rust_core_v6",
              "engine": if run.ok { Value::String("rust_core".to_string()) } else { Value::Null },
              "query": query,
              "limit": limit,
              "hit_count": payload.get("hit_count").and_then(|v| v.as_u64()).unwrap_or(hits.len() as u64),
              "hits": hits,
              "error": if run.ok { Value::Null } else { Value::String(clean_text(&run.error, 280)) }
            })
        }
        "get" => {
            let id = clean_text(flags.get("id").map(String::as_str).unwrap_or(""), 200);
            let run = run_memory_core(root, &[format!("get"), format!("--id={id}")]);
            let payload = run.payload.clone();
            json!({
              "ts": now_iso(),
              "type": "memory_view_get",
              "ok": run.ok,
              "backend": "rust_core_v6",
              "engine": if run.ok { Value::String("rust_core".to_string()) } else { Value::Null },
              "id": id,
              "row": payload.get("row").cloned().unwrap_or(Value::Null),
              "error": if run.ok { Value::Null } else { Value::String(clean_text(&run.error, 280)) }
            })
        }
        "snapshot" => {
            let query = clean_text(
                flags
                    .get("query")
                    .or_else(|| flags.get("q"))
                    .map(String::as_str)
                    .unwrap_or("memory"),
                200,
            );
            let limit = flags
                .get("limit")
                .or_else(|| flags.get("top"))
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(default_limit)
                .max(1);
            let recall_run = run_memory_core(
                root,
                &[format!("recall"), format!("--query={query}"), format!("--limit={limit}")],
            );
            let obs_run = run_memory_core(root, &[String::from("load-embedded-observability-profile")]);
            let vault_run = run_memory_core(root, &[String::from("load-embedded-vault-policy")]);

            let recall_payload = recall_run.payload.clone();
            let hits = recall_payload
                .get("hits")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let mut ratios = Vec::new();
            for hit in &hits {
                if let Some(v) = hit.get("compression_ratio").and_then(|n| n.as_f64()) {
                    if v.is_finite() && v >= 0.0 {
                        ratios.push(v);
                    }
                }
            }
            let avg = if ratios.is_empty() {
                0.0
            } else {
                (ratios.iter().sum::<f64>() / ratios.len() as f64 * 1_000_000.0).round()
                    / 1_000_000.0
            };
            let ok = recall_run.ok && obs_run.ok && vault_run.ok;
            let mut errs = Vec::new();
            if !recall_run.ok {
                errs.push("recall_failed".to_string());
            }
            if !obs_run.ok {
                errs.push("observability_blob_failed".to_string());
            }
            if !vault_run.ok {
                errs.push("vault_blob_failed".to_string());
            }
            json!({
              "ts": now_iso(),
              "type": "memory_view_snapshot",
              "ok": ok,
              "backend": "rust_core_v6",
              "query": query,
              "limit": limit,
              "hit_count": recall_payload.get("hit_count").and_then(|v| v.as_u64()).unwrap_or(hits.len() as u64),
              "avg_compression_ratio": avg,
              "observability_profile": obs_run.payload.get("embedded_observability_profile").cloned().unwrap_or(Value::Null),
              "vault_policy": vault_run.payload.get("embedded_vault_policy").cloned().unwrap_or(Value::Null),
              "error": if ok { Value::Null } else { Value::String(clean_text(&errs.join("; "), 320)) }
            })
        }
        "status" => json!({
          "ok": true,
          "type": "memory_view_status",
          "latest": read_json(&latest_path)
        }),
        _ => json!({"ok": false, "error": "unsupported_command", "cmd": subcmd}),
    };

    if subcmd != "status" && receipt.get("type").is_some() {
        write_json_atomic(&latest_path, &receipt);
        append_jsonl(&receipts_path, &receipt);
    }
    receipt
}

fn analytics_policy(root: &Path) -> Value {
    let policy_path = env::var("MEMORY_ABSTRACTION_ANALYTICS_POLICY_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("config/memory_abstraction_analytics_policy.json"));
    let raw = read_json(&policy_path);
    let paths = raw.get("paths").cloned().unwrap_or(Value::Null);
    json!({
      "enabled": raw.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
      "drift_warn_pct": raw.get("drift_warn_pct").and_then(|v| v.as_f64()).unwrap_or(1.0).max(0.0),
      "drift_fail_pct": raw.get("drift_fail_pct").and_then(|v| v.as_f64()).unwrap_or(2.0).max(0.0),
      "latest_path": resolve_path(root, paths.get("latest_path").and_then(|v| v.as_str()), "state/memory/abstraction/analytics_latest.json"),
      "history_path": resolve_path(root, paths.get("history_path").and_then(|v| v.as_str()), "state/memory/abstraction/analytics_history.jsonl"),
      "baseline_path": resolve_path(root, paths.get("baseline_path").and_then(|v| v.as_str()), "state/memory/abstraction/analytics_baseline.json"),
      "view_receipts_path": resolve_path(root, paths.get("view_receipts_path").and_then(|v| v.as_str()), "state/memory/abstraction/memory_view_receipts.jsonl"),
      "harness_receipts_path": resolve_path(root, paths.get("harness_receipts_path").and_then(|v| v.as_str()), "state/memory/abstraction/test_harness_receipts.jsonl"),
      "security_alerts_path": resolve_path(root, paths.get("security_alerts_path").and_then(|v| v.as_str()), "state/security/human_alerts.jsonl")
    })
}

fn compute_drift_pct(curr: f64, baseline: f64) -> f64 {
    if !curr.is_finite() || !baseline.is_finite() {
        return 0.0;
    }
    if baseline == 0.0 {
        return if curr == 0.0 { 0.0 } else { 100.0 };
    }
    ((curr - baseline).abs() / baseline * 100.0 * 1_000_000.0).round() / 1_000_000.0
}

fn cmd_analytics(root: &Path, subcmd: &str) -> Value {
    let p = analytics_policy(root);
    if p.get("enabled").and_then(|v| v.as_bool()) != Some(true) {
        return json!({"ok": false, "error": "memory_abstraction_analytics_disabled"});
    }
    let latest_path = PathBuf::from(p.get("latest_path").and_then(|v| v.as_str()).unwrap_or(""));
    let history_path = PathBuf::from(p.get("history_path").and_then(|v| v.as_str()).unwrap_or(""));
    let baseline_path = PathBuf::from(p.get("baseline_path").and_then(|v| v.as_str()).unwrap_or(""));
    let view_receipts_path = PathBuf::from(
        p.get("view_receipts_path")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    );
    let harness_receipts_path = PathBuf::from(
        p.get("harness_receipts_path")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    );
    let security_alerts_path = PathBuf::from(
        p.get("security_alerts_path")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    );
    let drift_warn = p.get("drift_warn_pct").and_then(|v| v.as_f64()).unwrap_or(1.0);
    let drift_fail = p.get("drift_fail_pct").and_then(|v| v.as_f64()).unwrap_or(2.0);

    match subcmd {
        "run" => {
            let view_receipts = read_jsonl(&view_receipts_path);
            let harness_receipts = read_jsonl(&harness_receipts_path);
            let security_alerts = read_jsonl(&security_alerts_path);
            let mut hits: Vec<Value> = Vec::new();
            for row in &view_receipts {
                if row.get("type").and_then(|v| v.as_str()) == Some("memory_view_query") {
                    if let Some(arr) = row.get("hits").and_then(|v| v.as_array()) {
                        hits.extend(arr.iter().cloned());
                    }
                }
            }
            let hit_count = hits.len() as f64;
            let mut matching_hits = 0.0;
            let mut ratios = Vec::new();
            for hit in &hits {
                let content = clean_text(
                    hit.get("content").and_then(|v| v.as_str()).unwrap_or(""),
                    2000,
                )
                .to_lowercase();
                let id = clean_text(hit.get("id").and_then(|v| v.as_str()).unwrap_or(""), 200)
                    .to_lowercase();
                let query = clean_text(
                    hit.get("query").and_then(|v| v.as_str()).unwrap_or(""),
                    200,
                )
                .to_lowercase();
                if query.is_empty() || content.contains(&query) || id.contains(&query) {
                    matching_hits += 1.0;
                }
                if let Some(r) = hit.get("compression_ratio").and_then(|v| v.as_f64()) {
                    if r.is_finite() && r >= 0.0 {
                        ratios.push(r);
                    }
                }
            }
            let recall_accuracy = if hit_count > 0.0 {
                (matching_hits / hit_count * 1_000_000.0).round() / 1_000_000.0
            } else {
                1.0
            };
            let compression_ratio = if ratios.is_empty() {
                0.0
            } else {
                (ratios.iter().sum::<f64>() / ratios.len() as f64 * 1_000_000.0).round()
                    / 1_000_000.0
            };
            let drift_pct = harness_receipts
                .last()
                .and_then(|v| v.get("max_drift_pct"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);

            let obs_run = run_memory_core(root, &[String::from("load-embedded-observability-profile")]);
            let scorer = obs_run
                .payload
                .get("embedded_observability_profile")
                .and_then(|v| v.get("sovereignty_scorer"))
                .cloned()
                .unwrap_or(Value::Null);
            let iw = scorer
                .get("integrity_weight_pct")
                .and_then(|v| v.as_f64())
                .unwrap_or(45.0);
            let cw = scorer
                .get("continuity_weight_pct")
                .and_then(|v| v.as_f64())
                .unwrap_or(25.0);
            let rw = scorer
                .get("reliability_weight_pct")
                .and_then(|v| v.as_f64())
                .unwrap_or(20.0);
            let cp = scorer
                .get("chaos_penalty_pct")
                .and_then(|v| v.as_f64())
                .unwrap_or(10.0);
            let alert_penalty = (security_alerts.len() as f64 * cp).min(100.0);
            let integrity = recall_accuracy * 100.0;
            let continuity = (100.0 - drift_pct).max(0.0);
            let reliability = (100.0
                - if compression_ratio > 1.0 {
                    (compression_ratio - 1.0) * 100.0
                } else {
                    0.0
                })
            .max(0.0);
            let weighted = (integrity * iw + continuity * cw + reliability * rw) / 100.0;
            let sovereignty_index = (weighted - alert_penalty).max(0.0);
            let sovereignty_index = (sovereignty_index * 1_000_000.0).round() / 1_000_000.0;

            let baseline_raw = read_json(&baseline_path);
            let baseline = if baseline_raw.is_object() {
                baseline_raw
            } else {
                json!({
                  "recall_accuracy": recall_accuracy,
                  "compression_ratio": compression_ratio,
                  "sovereignty_index": sovereignty_index,
                  "drift_pct": drift_pct
                })
            };
            let d_recall = compute_drift_pct(
                recall_accuracy,
                baseline
                    .get("recall_accuracy")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(recall_accuracy),
            );
            let d_compression = compute_drift_pct(
                compression_ratio,
                baseline
                    .get("compression_ratio")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(compression_ratio),
            );
            let d_sovereignty = compute_drift_pct(
                sovereignty_index,
                baseline
                    .get("sovereignty_index")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(sovereignty_index),
            );
            let d_drift = compute_drift_pct(
                drift_pct,
                baseline
                    .get("drift_pct")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(drift_pct),
            );
            let max_drift = d_recall.max(d_compression).max(d_sovereignty).max(d_drift);
            let drift_status = if max_drift > drift_fail {
                "fail"
            } else if max_drift > drift_warn {
                "warn"
            } else {
                "ok"
            };
            let receipt = json!({
              "ts": now_iso(),
              "type": "memory_analytics_run",
              "ok": drift_status != "fail",
              "backend": "rust_core_v6",
              "metrics": {
                "drift_pct": drift_pct,
                "recall_accuracy": recall_accuracy,
                "compression_ratio": compression_ratio,
                "sovereignty_index": sovereignty_index,
                "security_alert_count": security_alerts.len()
              },
              "blob_powered": {
                "observability_profile_loaded": obs_run.ok,
                "sovereignty_scorer": scorer
              },
              "drift": {
                "status": drift_status,
                "max_drift_pct": max_drift,
                "threshold_fail_pct": drift_fail,
                "threshold_warn_pct": drift_warn,
                "breakdown": {
                  "recall_accuracy_drift_pct": d_recall,
                  "compression_ratio_drift_pct": d_compression,
                  "sovereignty_index_drift_pct": d_sovereignty,
                  "drift_pct_drift_pct": d_drift
                }
              },
              "baseline": baseline
            });
            write_json_atomic(&latest_path, &receipt);
            append_jsonl(&history_path, &receipt);
            receipt
        }
        "baseline-capture" => {
            let latest = read_json(&latest_path);
            if !latest.is_object() || latest.get("metrics").is_none() {
                return json!({"ok": false, "error": "analytics_latest_missing"});
            }
            let metrics = latest.get("metrics").cloned().unwrap_or(Value::Null);
            let baseline = json!({
              "ts": now_iso(),
              "recall_accuracy": metrics.get("recall_accuracy").and_then(|v| v.as_f64()).unwrap_or(1.0),
              "compression_ratio": metrics.get("compression_ratio").and_then(|v| v.as_f64()).unwrap_or(0.0),
              "sovereignty_index": metrics.get("sovereignty_index").and_then(|v| v.as_f64()).unwrap_or(0.0),
              "drift_pct": metrics.get("drift_pct").and_then(|v| v.as_f64()).unwrap_or(0.0)
            });
            write_json_atomic(&baseline_path, &baseline);
            json!({"ok": true, "type": "memory_analytics_baseline_capture", "baseline": baseline})
        }
        "status" => json!({
          "ok": true,
          "type": "memory_analytics_status",
          "latest": read_json(&latest_path),
          "baseline": read_json(&baseline_path)
        }),
        _ => json!({"ok": false, "error": "unsupported_command", "cmd": subcmd}),
    }
}

fn harness_policy(root: &Path) -> Value {
    let policy_path = env::var("MEMORY_ABSTRACTION_TEST_POLICY_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("config/memory_abstraction_test_harness_policy.json"));
    let raw = read_json(&policy_path);
    let paths = raw.get("paths").cloned().unwrap_or(Value::Null);
    json!({
      "enabled": raw.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
      "drift_fail_pct": raw.get("drift_fail_pct").and_then(|v| v.as_f64()).unwrap_or(2.0).max(0.0),
      "latest_path": resolve_path(root, paths.get("latest_path").and_then(|v| v.as_str()), "state/memory/abstraction/test_harness_latest.json"),
      "receipts_path": resolve_path(root, paths.get("receipts_path").and_then(|v| v.as_str()), "state/memory/abstraction/test_harness_receipts.jsonl"),
      "baseline_path": resolve_path(root, paths.get("baseline_path").and_then(|v| v.as_str()), "state/memory/abstraction/test_harness_baseline.json")
    })
}

fn cmd_test_harness(root: &Path, subcmd: &str) -> Value {
    let p = harness_policy(root);
    if p.get("enabled").and_then(|v| v.as_bool()) != Some(true) {
        return json!({"ok": false, "error": "memory_abstraction_test_harness_disabled"});
    }
    let latest_path = PathBuf::from(p.get("latest_path").and_then(|v| v.as_str()).unwrap_or(""));
    let receipts_path = PathBuf::from(
        p.get("receipts_path")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    );
    let baseline_path = PathBuf::from(
        p.get("baseline_path")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    );
    let drift_fail = p
        .get("drift_fail_pct")
        .and_then(|v| v.as_f64())
        .unwrap_or(2.0);

    match subcmd {
        "run" => {
            let now_ms = Utc::now().timestamp_millis();
            let id = format!("memory://harness-{now_ms}");
            let security_req = json!({
              "operation_id": format!("memory_harness_probe_{now_ms}"),
              "subsystem": "memory",
              "action": "harness",
              "actor": "systems/memory/abstraction/test_harness",
              "risk_class": "high",
              "tags": ["memory", "test_harness", "foundation_lock"]
            });
            let security_probe = run_security_check(root, &security_req);

            let ingest_run = run_memory_core(
                root,
                &[
                    "ingest".to_string(),
                    format!("--id={id}"),
                    "--content=foundation lock harness sample memory row".to_string(),
                    "--tags=foundation_lock,memory_harness".to_string(),
                    "--repetitions=2".to_string(),
                    "--lambda=0.02".to_string(),
                ],
            );
            let recall_run = run_memory_core(
                root,
                &[
                    "recall".to_string(),
                    "--query=foundation".to_string(),
                    "--limit=5".to_string(),
                ],
            );
            let get_run = run_memory_core(root, &["get".to_string(), format!("--id={id}")]);
            let compress_run =
                run_memory_core(root, &["compress".to_string(), "--aggressive=0".to_string()]);
            let ebb_run = run_memory_core(
                root,
                &[
                    "ebbinghaus-score".to_string(),
                    "--age-days=1.5".to_string(),
                    "--repetitions=2".to_string(),
                    "--lambda=0.02".to_string(),
                ],
            );
            let crdt_run = run_memory_core(
                root,
                &[String::from("crdt-exchange"), String::from("--payload={\"left\":{\"topic\":{\"value\":\"alpha\",\"clock\":1,\"node\":\"left\"}},\"right\":{\"topic\":{\"value\":\"beta\",\"clock\":2,\"node\":\"right\"}}}")],
            );

            let recall_payload = &recall_run.payload;
            let get_payload = &get_run.payload;
            let compress_payload = &compress_run.payload;
            let ebb_payload = &ebb_run.payload;
            let crdt_payload = &crdt_run.payload;

            let metrics = json!({
              "recall_hit_count": recall_payload.get("hit_count").and_then(|v| v.as_u64()).unwrap_or(0),
              "get_ok": if get_payload.get("ok").and_then(|v| v.as_bool()) == Some(true) { 1 } else { 0 },
              "compacted_rows": compress_payload.get("compacted_rows").and_then(|v| v.as_u64()).unwrap_or(0),
              "retention_score": ebb_payload.get("retention_score").and_then(|v| v.as_f64()).unwrap_or(0.0),
              "crdt_topic_clock": crdt_payload.get("merged").and_then(|v| v.get("topic")).and_then(|v| v.get("clock")).and_then(|v| v.as_u64()).unwrap_or(0),
              "security_gate_ok": if security_probe.ok { 1 } else { 0 }
            });

            let baseline_raw = read_json(&baseline_path);
            let baseline = if baseline_raw.is_object() {
                baseline_raw
            } else {
                json!({"ts": now_iso(), "metrics": metrics})
            };
            let bm = baseline.get("metrics").cloned().unwrap_or(json!({}));
            let d_recall = compute_drift_pct(
                metrics
                    .get("recall_hit_count")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0),
                bm.get("recall_hit_count")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(metrics.get("recall_hit_count").and_then(|v| v.as_f64()).unwrap_or(0.0)),
            );
            let d_get = compute_drift_pct(
                metrics.get("get_ok").and_then(|v| v.as_f64()).unwrap_or(0.0),
                bm.get("get_ok")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(metrics.get("get_ok").and_then(|v| v.as_f64()).unwrap_or(0.0)),
            );
            let d_compact = compute_drift_pct(
                metrics
                    .get("compacted_rows")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0),
                bm.get("compacted_rows")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(
                        metrics
                            .get("compacted_rows")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(0.0),
                    ),
            );
            let d_retention = compute_drift_pct(
                metrics
                    .get("retention_score")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0),
                bm.get("retention_score")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(
                        metrics
                            .get("retention_score")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(0.0),
                    ),
            );
            let d_crdt = compute_drift_pct(
                metrics
                    .get("crdt_topic_clock")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0),
                bm.get("crdt_topic_clock")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(
                        metrics
                            .get("crdt_topic_clock")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(0.0),
                    ),
            );
            let d_sec = compute_drift_pct(
                metrics
                    .get("security_gate_ok")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0),
                bm.get("security_gate_ok")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(
                        metrics
                            .get("security_gate_ok")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(0.0),
                    ),
            );
            let max_drift = d_recall
                .max(d_get)
                .max(d_compact)
                .max(d_retention)
                .max(d_crdt)
                .max(d_sec);
            let ok = ingest_run.ok
                && recall_run.ok
                && get_run.ok
                && compress_run.ok
                && ebb_run.ok
                && crdt_run.ok
                && security_probe.ok
                && max_drift <= drift_fail;
            let receipt = json!({
              "ts": now_iso(),
              "type": "memory_abstraction_test_harness_run",
              "ok": ok,
              "backend": "rust_core_v6",
              "metrics": metrics,
              "max_drift_pct": max_drift,
              "drift_fail_pct": drift_fail,
              "drift_breakdown": {
                "recall_hit_count_pct": d_recall,
                "get_ok_pct": d_get,
                "compacted_rows_pct": d_compact,
                "retention_score_pct": d_retention,
                "crdt_topic_clock_pct": d_crdt,
                "security_gate_ok_pct": d_sec
              },
              "operations": {
                "ingest_ok": ingest_run.ok,
                "recall_ok": recall_run.ok,
                "get_ok": get_run.ok,
                "compress_ok": compress_run.ok,
                "ebbinghaus_ok": ebb_run.ok,
                "crdt_ok": crdt_run.ok,
                "security_gate_ok": security_probe.ok
              },
              "security_probe": security_probe.payload,
              "error": if ok { Value::Null } else { Value::String("memory_abstraction_harness_failed_or_drift_over_2pct".to_string()) }
            });
            write_json_atomic(&latest_path, &receipt);
            append_jsonl(&receipts_path, &receipt);
            receipt
        }
        "baseline-capture" => {
            let latest = read_json(&latest_path);
            if !latest.is_object() || latest.get("metrics").is_none() {
                return json!({"ok": false, "error": "test_harness_latest_missing"});
            }
            let baseline = json!({
              "ts": now_iso(),
              "metrics": latest.get("metrics").cloned().unwrap_or(Value::Null)
            });
            write_json_atomic(&baseline_path, &baseline);
            json!({"ok": true, "type": "memory_abstraction_test_harness_baseline_capture", "baseline": baseline})
        }
        "status" => json!({
          "ok": true,
          "type": "memory_abstraction_test_harness_status",
          "latest": read_json(&latest_path),
          "baseline": read_json(&baseline_path)
        }),
        _ => json!({"ok": false, "error": "unsupported_command", "cmd": subcmd}),
    }
}

fn usage() {
    println!("Usage:");
    println!("  memory_abstraction_core memory-view <query|get|snapshot|status> [--flags]");
    println!("  memory_abstraction_core analytics <run|baseline-capture|status>");
    println!("  memory_abstraction_core test-harness <run|baseline-capture|status>");
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        usage();
        std::process::exit(1);
    }
    let root = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let area = clean_text(&args[0], 80).to_lowercase();
    let subcmd = if args.len() > 1 {
        clean_text(&args[1], 80).to_lowercase()
    } else {
        "status".to_string()
    };
    let flags = parse_flags(&args);
    let payload = match area.as_str() {
        "memory-view" => cmd_memory_view(&root, &subcmd, &flags),
        "analytics" => cmd_analytics(&root, &subcmd),
        "test-harness" => cmd_test_harness(&root, &subcmd),
        "help" | "--help" | "-h" => {
            usage();
            json!({"ok": true})
        }
        _ => json!({"ok": false, "error": "unsupported_area", "area": area}),
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{\"ok\":false}".to_string())
    );
    let exit_ok = payload.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    std::process::exit(if exit_ok { 0 } else { 1 });
}
