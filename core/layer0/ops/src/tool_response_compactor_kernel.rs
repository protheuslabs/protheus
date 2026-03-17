// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use regex::{Captures, Regex};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso, parse_args};

const COMPACTION_THRESHOLD_CHARS: usize = 1200;
const COMPACTION_THRESHOLD_LINES: usize = 40;

fn usage() {
    println!("tool-response-compactor-kernel commands:");
    println!("  protheus-ops tool-response-compactor-kernel compact --payload-base64=<json>");
    println!("  protheus-ops tool-response-compactor-kernel redact --payload-base64=<json>");
    println!("  protheus-ops tool-response-compactor-kernel extract-summary --payload-base64=<json>");
}

fn cli_receipt(kind: &str, payload: Value) -> Value {
    let ts = now_iso();
    let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(true);
    let mut out = json!({
        "ok": ok,
        "type": kind,
        "ts": ts,
        "date": ts[..10].to_string(),
        "payload": payload,
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn cli_error(kind: &str, error: &str) -> Value {
    let ts = now_iso();
    let mut out = json!({
        "ok": false,
        "type": kind,
        "ts": ts,
        "date": ts[..10].to_string(),
        "error": error,
        "fail_closed": true,
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn payload_json(argv: &[String]) -> Result<Value, String> {
    if let Some(raw) = lane_utils::parse_flag(argv, "payload", false) {
        return serde_json::from_str::<Value>(&raw)
            .map_err(|err| format!("tool_response_compactor_kernel_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("tool_response_compactor_kernel_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("tool_response_compactor_kernel_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("tool_response_compactor_kernel_payload_decode_failed:{err}"));
    }
    Ok(json!({}))
}

fn root_dir_from_payload(repo_root: &Path, payload: &Map<String, Value>) -> PathBuf {
    let raw = payload
        .get("root_dir")
        .map(Value::to_string)
        .unwrap_or_default()
        .trim_matches('"')
        .trim()
        .to_string();
    if raw.is_empty() {
        return repo_root.to_path_buf();
    }
    if Path::new(&raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        repo_root.join(raw)
    }
}

fn tool_raw_dir(root_dir: &Path) -> PathBuf {
    root_dir.join("local").join("logs").join("tool_raw")
}

fn render_input(value: &Value) -> String {
    match value {
        Value::String(v) => v.clone(),
        _ => serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
    }
}

fn redact_secrets(content: &str) -> String {
    let mut out = content.to_string();
    let moltbook_re =
        Regex::new(r"moltbook_sk_[a-zA-Z0-9]{32,}").expect("valid moltbook regex");
    out = moltbook_re
        .replace_all(&out, |caps: &Captures| {
            let token = caps.get(0).map(|m| m.as_str()).unwrap_or_default();
            let suffix = token
                .chars()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<String>();
            format!("moltbook_sk_****{suffix}")
        })
        .to_string();

    let bearer_re =
        Regex::new(r#"(?i)Authorization:\s*Bearer\s+[^\s"']+"#).expect("valid bearer regex");
    out = bearer_re
        .replace_all(&out, "Authorization: Bearer [REDACTED]")
        .to_string();

    let header_re = Regex::new(
        r#"(?i)(x-api-key|api-key|auth-token|authorization)\s*[:=]\s*["']?[a-z0-9._~+\-/]{12,}["']?"#,
    )
    .expect("valid header regex");
    out = header_re
        .replace_all(&out, |caps: &Captures| {
            let key = caps
                .get(1)
                .map(|m| m.as_str())
                .unwrap_or("authorization");
            format!("{key}: [REDACTED]")
        })
        .to_string();

    let json_secret_re = Regex::new(
        r#"(?i)("(?:auth_token|access_token|refresh_token|api_key|secret|password)"\s*:\s*)"(.*?)""#,
    )
    .expect("valid json secret regex");
    out = json_secret_re
        .replace_all(&out, "$1\"[REDACTED]\"")
        .to_string();

    let query_re =
        Regex::new(r"(?i)([?&](?:token|access_token|api_key|auth|ct0|bearer)=)[^&\s]+")
            .expect("valid query regex");
    out = query_re.replace_all(&out, "$1[REDACTED]").to_string();
    out
}

fn collect_ids_and_urls(value: &Value, ids: &mut Vec<String>, urls: &mut Vec<String>) {
    match value {
        Value::Object(obj) => {
            for (key, row) in obj {
                if key.to_ascii_lowercase().contains("id") {
                    if let Some(text) = row.as_str() {
                        let short = if text.len() > 8 {
                            format!("{}...", &text[..8])
                        } else {
                            text.to_string()
                        };
                        ids.push(short);
                    }
                }
                if let Some(text) = row.as_str() {
                    if text.starts_with("http://") || text.starts_with("https://") {
                        let short = if text.len() > 50 {
                            format!("{}...", &text[..50])
                        } else {
                            text.to_string()
                        };
                        urls.push(short);
                    }
                } else {
                    collect_ids_and_urls(row, ids, urls);
                }
            }
        }
        Value::Array(rows) => {
            for row in rows {
                collect_ids_and_urls(row, ids, urls);
            }
        }
        _ => {}
    }
}

fn dedupe_limit(rows: Vec<String>, max: usize) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for row in rows {
        if row.is_empty() || !seen.insert(row.clone()) {
            continue;
        }
        out.push(row);
        if out.len() >= max {
            break;
        }
    }
    out
}

fn extract_summary_rows(data: &Value, tool_name: &str) -> Vec<String> {
    let rendered = render_input(data);
    let mut bullets = Vec::<String>::new();
    let parsed = if let Value::String(text) = data {
        serde_json::from_str::<Value>(text).ok()
    } else {
        Some(data.clone())
    };

    if let Some(parsed) = parsed {
        if let Some(rows) = parsed.as_array() {
            bullets.push(format!("• Count: {} items", rows.len()));
        }

        let mut ids = Vec::new();
        let mut urls = Vec::new();
        collect_ids_and_urls(&parsed, &mut ids, &mut urls);
        let ids = dedupe_limit(ids, 5);
        let urls = dedupe_limit(urls, 3);
        if !ids.is_empty() {
            bullets.push(format!("• IDs: {}", ids.join(", ")));
        }
        if !urls.is_empty() {
            bullets.push(format!("• URLs: {}", urls.join(", ")));
        }

        if let Some(obj) = parsed.as_object() {
            let mut metrics = Vec::new();
            for (key, row) in obj {
                let lower = key.to_ascii_lowercase();
                if !(lower.contains("count")
                    || lower.contains("total")
                    || lower.contains("upvotes")
                    || lower.contains("downvotes"))
                {
                    continue;
                }
                if let Some(number) = row.as_i64() {
                    metrics.push(format!("{key}: {number}"));
                } else if let Some(number) = row.as_f64() {
                    metrics.push(format!("{key}: {number}"));
                }
                if metrics.len() >= 4 {
                    break;
                }
            }
            if !metrics.is_empty() {
                bullets.push(format!("• Metrics: {}", metrics.join(", ")));
            }
            if obj.contains_key("error") || obj.contains_key("errors") {
                bullets.push("• Error detected".to_string());
            }
            if obj
                .get("status")
                .and_then(Value::as_str)
                .map(|v| v.eq_ignore_ascii_case("error"))
                .unwrap_or(false)
            {
                bullets.push("• Status: error".to_string());
            }
        }
    } else {
        let line_count = rendered.lines().count();
        if line_count > 0 {
            bullets.push(format!("• {} lines of text output", line_count));
        }
    }

    while bullets.len() < 5 && bullets.len() < 10 {
        if !bullets.iter().any(|row| row.contains("Type:")) {
            bullets.push(format!("• Type: {}", if tool_name.is_empty() { "tool output" } else { tool_name }));
        } else if !bullets.iter().any(|row| row.contains("Status:")) {
            bullets.push("• Status: success".to_string());
        } else {
            break;
        }
    }

    bullets.truncate(10);
    bullets
}

fn safe_tool_name(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if matches!(ch, ':' | '/') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    if out.trim().is_empty() {
        "unknown".to_string()
    } else {
        out
    }
}

fn compact_tool_response(repo_root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let root_dir = root_dir_from_payload(repo_root, payload);
    let tool_name = payload
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let raw_content = render_input(payload.get("data").unwrap_or(&Value::Null));
    let char_count = raw_content.len();
    let line_count = raw_content.lines().count();
    let redacted = redact_secrets(&raw_content);

    if char_count <= COMPACTION_THRESHOLD_CHARS && line_count <= COMPACTION_THRESHOLD_LINES {
        return Ok(json!({
            "compacted": false,
            "content": redacted,
            "metrics": {
                "chars": char_count,
                "lines": line_count
            }
        }));
    }

    let dir = tool_raw_dir(&root_dir);
    fs::create_dir_all(&dir)
        .map_err(|err| format!("tool_response_compactor_kernel_mkdir_failed:{err}"))?;
    let timestamp = now_iso().replace([':', '.'], "-");
    let file_name = format!("{}_{}.txt", safe_tool_name(&tool_name), timestamp);
    let raw_path = dir.join(&file_name);
    fs::write(&raw_path, redacted.as_bytes())
        .map_err(|err| format!("tool_response_compactor_kernel_write_failed:{err}"))?;

    let summary = extract_summary_rows(payload.get("data").unwrap_or(&Value::Null), &tool_name);
    let compact_output = [
        "📦 [TOOL OUTPUT COMPACTED]".to_string(),
        String::new(),
        summary.join("\n"),
        String::new(),
        format!("📁 Raw output saved to: client/runtime/local/logs/tool_raw/{file_name}"),
        format!("📊 Original: {char_count} chars, {line_count} lines"),
        format!(
            "📊 Compacted: {} chars (summary only)",
            summary.join("").len()
        ),
    ]
    .join("\n");

    let compacted_chars = compact_output.len();
    let savings_percent = if char_count == 0 {
        0
    } else {
        (((char_count.saturating_sub(compacted_chars)) as f64 / char_count as f64) * 100.0).round()
            as i64
    };

    Ok(json!({
        "compacted": true,
        "content": compact_output,
        "rawPath": raw_path.to_string_lossy(),
        "metrics": {
            "originalChars": char_count,
            "originalLines": line_count,
            "compactedChars": compacted_chars,
            "savingsPercent": savings_percent
        }
    }))
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "help".to_string());

    match cmd.as_str() {
        "help" | "--help" | "-h" => {
            usage();
            0
        }
        "redact" => match payload_json(argv) {
            Ok(payload) => {
                let data = payload
                    .get("data")
                    .map(render_input)
                    .unwrap_or_default();
                print_json_line(&cli_receipt(
                    "tool_response_compactor_kernel_redact",
                    json!({ "content": redact_secrets(&data) }),
                ));
                0
            }
            Err(err) => {
                print_json_line(&cli_error("tool_response_compactor_kernel_redact", &err));
                1
            }
        },
        "extract-summary" => match payload_json(argv) {
            Ok(payload) => {
                let obj = payload.as_object().cloned().unwrap_or_default();
                let data = obj.get("data").cloned().unwrap_or(Value::Null);
                let tool_name = obj
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                print_json_line(&cli_receipt(
                    "tool_response_compactor_kernel_extract_summary",
                    json!({ "summary": extract_summary_rows(&data, tool_name) }),
                ));
                0
            }
            Err(err) => {
                print_json_line(&cli_error(
                    "tool_response_compactor_kernel_extract_summary",
                    &err,
                ));
                1
            }
        },
        "compact" => match payload_json(argv) {
            Ok(payload) => {
                let obj = payload.as_object().cloned().unwrap_or_default();
                match compact_tool_response(root, &obj) {
                    Ok(out) => {
                        print_json_line(&cli_receipt(
                            "tool_response_compactor_kernel_compact",
                            out,
                        ));
                        0
                    }
                    Err(err) => {
                        print_json_line(&cli_error(
                            "tool_response_compactor_kernel_compact",
                            &err,
                        ));
                        1
                    }
                }
            }
            Err(err) => {
                print_json_line(&cli_error("tool_response_compactor_kernel_compact", &err));
                1
            }
        },
        _ => {
            usage();
            print_json_line(&cli_error(
                "tool_response_compactor_kernel",
                "unknown_command",
            ));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_hides_tokens_and_bearer_headers() {
        let out = redact_secrets(
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\nmoltbook_sk_abcdefghijklmnopqrstuvwxyz1234567890",
        );
        assert!(out.contains("Authorization: Bearer [REDACTED]"));
        assert!(out.contains("moltbook_sk_****7890"));
    }

    #[test]
    fn extract_summary_reports_ids_and_urls() {
        let payload = json!({
            "id": "abcdef123456",
            "total_count": 4,
            "url": "https://example.com/long/path",
            "status": "error"
        });
        let summary = extract_summary_rows(&payload, "tool");
        assert!(summary.iter().any(|row| row.contains("IDs:")));
        assert!(summary.iter().any(|row| row.contains("URLs:")));
        assert!(summary.iter().any(|row| row.contains("Status: error")));
    }
}
