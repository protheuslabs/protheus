// SPDX-License-Identifier: Apache-2.0
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::env;

fn collapse_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_text(input: &str, max_len: usize) -> String {
    collapse_whitespace(input)
        .trim()
        .chars()
        .take(max_len)
        .collect()
}

fn value_as_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(v)) => v.to_string(),
        Some(Value::Number(v)) => v.to_string(),
        Some(other) => other.to_string(),
    }
}

fn normalize_token_cli(input: &str, max_len: usize) -> String {
    let cleaned = clean_text(input, max_len).to_ascii_lowercase();
    let mut out = String::with_capacity(cleaned.len());
    let mut prev_underscore = false;
    for ch in cleaned.chars() {
        let mapped = if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-' {
            ch
        } else {
            '_'
        };
        if mapped == '_' {
            if !prev_underscore {
                out.push('_');
                prev_underscore = true;
            }
        } else {
            out.push(mapped);
            prev_underscore = false;
        }
    }
    out.trim_matches('_').to_string()
}

fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(v) => {
            if *v {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        Value::Number(v) => v.to_string(),
        Value::String(v) => serde_json::to_string(v).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(rows) => {
            let joined = rows
                .iter()
                .map(stable_stringify)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{joined}]")
        }
        Value::Object(map) => {
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let joined = keys
                .iter()
                .map(|key| {
                    let key_json = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
                    let value_json = stable_stringify(map.get(key).unwrap_or(&Value::Null));
                    format!("{key_json}:{value_json}")
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{joined}}}")
        }
    }
}

fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn object_clone(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new)
}

fn primitive_stable_stringify(input: &Value) -> Value {
    let value = input.get("value").unwrap_or(&Value::Null);
    json!({ "value": stable_stringify(value) })
}

fn primitive_sha256_hex(input: &Value) -> Value {
    let text = value_as_string(input.get("text"));
    json!({ "hash": sha256_hex(&text) })
}

fn primitive_short_query_hash(input: &Value) -> Value {
    let query = value_as_string(input.get("query"));
    let digest = sha256_hex(&query);
    let short = digest.chars().take(16).collect::<String>();
    json!({ "value": short })
}

fn primitive_system_passed_payload_hash(input: &Value) -> Value {
    let source = normalize_token_cli(&value_as_string(input.get("source")), 80);
    let tags = input
        .get("tags")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| value_as_string(Some(row)))
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    let snippet = clean_text(&value_as_string(input.get("snippet")), 2000);
    let payload = format!("v1|{source}|{tags}|{snippet}");
    json!({ "hash": sha256_hex(&payload) })
}

fn primitive_compute_persona_bundle_hash(input: &Value) -> Value {
    let blocks = input
        .get("blocks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut hasher = Sha256::new();

    for block in blocks {
        let (name, body) = match block {
            Value::Array(parts) if parts.len() >= 2 => (
                value_as_string(parts.first()),
                value_as_string(parts.get(1)),
            ),
            Value::Object(map) => (
                value_as_string(map.get("name")),
                value_as_string(map.get("body")),
            ),
            _ => (String::new(), String::new()),
        };

        hasher.update(name.as_bytes());
        hasher.update(b"\n");
        hasher.update(body.as_bytes());
        hasher.update(b"\n---\n");
    }

    json!({ "hash": format!("{:x}", hasher.finalize()) })
}

fn primitive_append_jsonl_hash_chained_row(input: &Value) -> Value {
    let mut base = object_clone(input.get("row"));
    let prev_hash = clean_text(&value_as_string(input.get("prev_hash")), 200);
    base.insert(
        "prev_hash".to_string(),
        if prev_hash.is_empty() {
            Value::Null
        } else {
            Value::String(prev_hash)
        },
    );
    let hash = sha256_hex(&stable_stringify(&Value::Object(base.clone())));
    base.insert("hash".to_string(), Value::String(hash));
    json!({ "row": Value::Object(base) })
}

fn primitive_chain_rows(input: &Value) -> Value {
    let rows = input
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::with_capacity(rows.len());
    let mut prev_hash = String::new();

    for raw in rows {
        let mut row = object_clone(Some(&raw));
        row.remove("hash");
        row.remove("prev_hash");
        row.insert(
            "prev_hash".to_string(),
            if prev_hash.is_empty() {
                Value::Null
            } else {
                Value::String(prev_hash.clone())
            },
        );
        let hash = sha256_hex(&stable_stringify(&Value::Object(row.clone())));
        row.insert("hash".to_string(), Value::String(hash.clone()));
        prev_hash = hash;
        out.push(Value::Object(row));
    }

    json!({ "rows": out })
}

fn primitive_verify_hash_chain(input: &Value) -> Value {
    let rows = input
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut issues = Vec::new();
    let mut prev_hash: Option<String> = None;

    for (idx, row_value) in rows.iter().enumerate() {
        let row = object_clone(Some(row_value));

        let actual_prev = match row.get("prev_hash") {
            None | Some(Value::Null) => None,
            Some(value) => Some(clean_text(&value_as_string(Some(value)), 200)),
        };
        if actual_prev != prev_hash {
            issues.push(format!("prev_hash_mismatch:index={idx}"));
        }

        let mut row_copy = row.clone();
        row_copy.remove("hash");
        let expected_hash = sha256_hex(&stable_stringify(&Value::Object(row_copy)));
        let actual_hash = clean_text(&value_as_string(row.get("hash")), 200);
        if actual_hash.is_empty() || actual_hash != expected_hash {
            issues.push(format!("hash_mismatch:index={idx}"));
        }

        prev_hash = if actual_hash.is_empty() {
            None
        } else {
            Some(actual_hash)
        };
    }

    json!({
        "ok": issues.is_empty(),
        "issues": issues
    })
}

fn run_primitive(mode: &str, input: &Value) -> Result<Value, String> {
    match mode {
        "stable_stringify" => Ok(primitive_stable_stringify(input)),
        "sha256_hex" => Ok(primitive_sha256_hex(input)),
        "short_query_hash" => Ok(primitive_short_query_hash(input)),
        "system_passed_payload_hash" => Ok(primitive_system_passed_payload_hash(input)),
        "compute_persona_bundle_hash" => Ok(primitive_compute_persona_bundle_hash(input)),
        "append_jsonl_hash_chained_row" => Ok(primitive_append_jsonl_hash_chained_row(input)),
        "chain_rows" => Ok(primitive_chain_rows(input)),
        "verify_hash_chain" => Ok(primitive_verify_hash_chain(input)),
        _ => Err(format!("personas_mode_unsupported:{mode}")),
    }
}

fn parse_payload_base64(args: &[String]) -> Result<String, String> {
    for token in args {
        if let Some(value) = token.strip_prefix("--payload-base64=") {
            if !value.is_empty() {
                return Ok(value.to_string());
            }
        }
    }
    Err("payload_base64_missing".to_string())
}

fn emit_json(payload: &Value) {
    println!(
        "{}",
        serde_json::to_string(payload).unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) != Some("primitive") {
        emit_json(&json!({
            "ok": false,
            "error": "usage: personas_core primitive --payload-base64=<base64-json>"
        }));
        std::process::exit(1);
    }

    let payload_base64 = match parse_payload_base64(&args[1..]) {
        Ok(v) => v,
        Err(err) => {
            emit_json(&json!({ "ok": false, "error": err }));
            std::process::exit(1);
        }
    };

    let payload_bytes = match B64.decode(payload_base64.as_bytes()) {
        Ok(v) => v,
        Err(err) => {
            emit_json(&json!({
                "ok": false,
                "error": format!("payload_decode_failed:{err}")
            }));
            std::process::exit(1);
        }
    };

    let request: Value = match serde_json::from_slice(&payload_bytes) {
        Ok(v) => v,
        Err(err) => {
            emit_json(&json!({
                "ok": false,
                "error": format!("request_parse_failed:{err}")
            }));
            std::process::exit(1);
        }
    };

    let mode = clean_text(&value_as_string(request.get("mode")), 80).to_ascii_lowercase();
    if mode.is_empty() {
        emit_json(&json!({ "ok": false, "error": "personas_mode_missing" }));
        std::process::exit(1);
    }

    let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
    match run_primitive(&mode, &input) {
        Ok(payload) => {
            emit_json(&json!({
                "ok": true,
                "mode": mode,
                "payload": payload
            }));
            std::process::exit(0);
        }
        Err(err) => {
            emit_json(&json!({ "ok": false, "mode": mode, "error": err }));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_stringify_sorts_nested_keys() {
        let value = json!({
            "b": 2,
            "a": {
                "z": 1,
                "y": [2, {"m": 1, "a": 2}]
            }
        });
        let out = stable_stringify(&value);
        assert_eq!(
            out,
            "{\"a\":{\"y\":[2,{\"a\":2,\"m\":1}],\"z\":1},\"b\":2}"
        );
    }

    #[test]
    fn system_passed_payload_hash_matches_reference() {
        let input = json!({
            "source": "Master LLM",
            "tags": ["drift", "security"],
            "snippet": "  Keep   deterministic receipts. "
        });
        let out = primitive_system_passed_payload_hash(&input);
        let expected = sha256_hex("v1|master_llm|drift,security|Keep deterministic receipts.");
        assert_eq!(out["hash"].as_str().unwrap_or(""), expected);
    }

    #[test]
    fn short_query_hash_is_16_hex_chars() {
        let out = primitive_short_query_hash(&json!({"query":"Should we ship now?"}));
        let value = out["value"].as_str().unwrap_or("");
        assert_eq!(value.len(), 16);
        assert!(value.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn persona_bundle_hash_uses_named_blocks() {
        let input = json!({
            "blocks": [
                ["profile.md", "Alpha"],
                ["decision_lens.md", "Beta"]
            ]
        });
        let out = primitive_compute_persona_bundle_hash(&input);

        let mut hasher = Sha256::new();
        hasher.update(b"profile.md\nAlpha\n---\n");
        hasher.update(b"decision_lens.md\nBeta\n---\n");
        let expected = format!("{:x}", hasher.finalize());

        assert_eq!(out["hash"].as_str().unwrap_or(""), expected);
    }

    #[test]
    fn append_chain_and_verify_round_trip() {
        let first = primitive_append_jsonl_hash_chained_row(&json!({
            "prev_hash": "",
            "row": {"type":"selection_receipt","ts":"2026-03-05T00:00:00.000Z"}
        }));
        let first_row = first["row"].clone();

        let second = primitive_append_jsonl_hash_chained_row(&json!({
            "prev_hash": first_row["hash"],
            "row": {"type":"arbitration_receipt","ts":"2026-03-05T00:01:00.000Z"}
        }));
        let second_row = second["row"].clone();

        let verified = primitive_verify_hash_chain(&json!({
            "rows": [first_row, second_row]
        }));
        assert_eq!(verified["ok"], Value::Bool(true));
        assert_eq!(verified["issues"], Value::Array(Vec::new()));
    }

    #[test]
    fn verify_hash_chain_flags_tamper() {
        let chained = primitive_chain_rows(&json!({
            "rows": [
                {"type":"selection_receipt","ts":"2026-03-05T00:00:00.000Z"},
                {"type":"arbitration_receipt","ts":"2026-03-05T00:01:00.000Z"}
            ]
        }));
        let mut rows = chained["rows"].as_array().cloned().unwrap_or_default();
        rows[1]["type"] = Value::String("tampered_receipt".to_string());

        let verified = primitive_verify_hash_chain(&json!({"rows": rows}));
        assert_eq!(verified["ok"], Value::Bool(false));
        let issues = verified["issues"].as_array().cloned().unwrap_or_default();
        assert!(issues.iter().any(|v| v.as_str().unwrap_or("").starts_with("hash_mismatch:index=1")));
    }
}
