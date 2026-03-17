// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use rand::RngCore;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};

const ACTION_RESEARCH: &str = "research";
const ACTION_CODE_CHANGE: &str = "code_change";
const ACTION_PUBLISH_PUBLICLY: &str = "publish_publicly";
const ACTION_SPEND_MONEY: &str = "spend_money";
const ACTION_CHANGE_CREDENTIALS: &str = "change_credentials";
const ACTION_DELETE_DATA: &str = "delete_data";
const ACTION_OUTBOUND_CONTACT_NEW: &str = "outbound_contact_new";
const ACTION_OUTBOUND_CONTACT_EXISTING: &str = "outbound_contact_existing";
const ACTION_DEPLOYMENT: &str = "deployment";
const ACTION_OTHER: &str = "other";

const RISK_LOW: &str = "low";
const RISK_MEDIUM: &str = "medium";
const RISK_HIGH: &str = "high";

fn usage() {
    println!("action-envelope-kernel commands:");
    println!("  protheus-ops action-envelope-kernel create [--payload-base64=<base64_json>]");
    println!("  protheus-ops action-envelope-kernel classify [--payload-base64=<base64_json>]");
    println!(
        "  protheus-ops action-envelope-kernel auto-classify [--payload-base64=<base64_json>]"
    );
    println!(
        "  protheus-ops action-envelope-kernel requires-approval [--payload-base64=<base64_json>]"
    );
    println!("  protheus-ops action-envelope-kernel detect-irreversible [--payload-base64=<base64_json>]");
    println!("  protheus-ops action-envelope-kernel generate-id");
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
            .map_err(|err| format!("action_envelope_kernel_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("action_envelope_kernel_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("action_envelope_kernel_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("action_envelope_kernel_payload_decode_failed:{err}"));
    }
    Ok(json!({}))
}

fn payload_obj<'a>(value: &'a Value) -> &'a Map<String, Value> {
    value.as_object().unwrap_or_else(|| {
        static EMPTY: OnceLock<Map<String, Value>> = OnceLock::new();
        EMPTY.get_or_init(Map::new)
    })
}

fn as_object<'a>(value: Option<&'a Value>) -> Option<&'a Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn as_array<'a>(value: Option<&'a Value>) -> &'a Vec<Value> {
    value.and_then(Value::as_array).unwrap_or_else(|| {
        static EMPTY: OnceLock<Vec<Value>> = OnceLock::new();
        EMPTY.get_or_init(Vec::new)
    })
}

fn as_str(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(v)) => v.trim().to_string(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string().trim_matches('"').trim().to_string(),
    }
}

fn as_i64(value: Option<&Value>, fallback: i64) -> i64 {
    match value {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(fallback),
        Some(Value::String(v)) => v.trim().parse::<i64>().unwrap_or(fallback),
        _ => fallback,
    }
}

fn clean_text(raw: &str, max_len: usize) -> String {
    let mut out = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.len() > max_len {
        out.truncate(max_len);
    }
    out
}

fn normalized_type(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        ACTION_RESEARCH => ACTION_RESEARCH,
        ACTION_CODE_CHANGE => ACTION_CODE_CHANGE,
        ACTION_PUBLISH_PUBLICLY => ACTION_PUBLISH_PUBLICLY,
        ACTION_SPEND_MONEY => ACTION_SPEND_MONEY,
        ACTION_CHANGE_CREDENTIALS => ACTION_CHANGE_CREDENTIALS,
        ACTION_DELETE_DATA => ACTION_DELETE_DATA,
        ACTION_OUTBOUND_CONTACT_NEW => ACTION_OUTBOUND_CONTACT_NEW,
        ACTION_OUTBOUND_CONTACT_EXISTING => ACTION_OUTBOUND_CONTACT_EXISTING,
        ACTION_DEPLOYMENT => ACTION_DEPLOYMENT,
        _ => ACTION_OTHER,
    }
}

fn normalized_risk(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        RISK_LOW => RISK_LOW,
        RISK_HIGH => RISK_HIGH,
        _ => RISK_MEDIUM,
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|row| row.as_millis())
        .unwrap_or(0)
}

fn to_base36(mut value: u128) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut buf = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        let ch = if digit < 10 {
            (b'0' + digit) as char
        } else {
            (b'a' + (digit - 10)) as char
        };
        buf.push(ch);
        value /= 36;
    }
    buf.iter().rev().collect()
}

fn generate_action_id() -> String {
    let timestamp = to_base36(now_millis());
    let mut bytes = [0_u8; 4];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("act_{timestamp}_{}", hex::encode(bytes))
}

fn compile_pattern(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap()
}

fn high_stakes_rules() -> &'static [(&'static str, &'static str)] {
    &[
        (
            ACTION_SPEND_MONEY,
            r"purchase|buy|subscribe|payment|\$\d+|\d+\s*(USD|EUR|GBP)",
        ),
        (
            ACTION_PUBLISH_PUBLICLY,
            r"post\s+to|publish|tweet|moltbook.*create|blog|medium|github.*push",
        ),
        (
            ACTION_CHANGE_CREDENTIALS,
            r"password|api_key|token|credential|auth|secret|rotate",
        ),
        (
            ACTION_DELETE_DATA,
            r"rm\s+-rf|delete|drop\s+table|destroy|reset|truncate",
        ),
        (
            ACTION_OUTBOUND_CONTACT_NEW,
            r"send.*email|email.*to|message.*new|contact.*@|reach.?out",
        ),
        (
            ACTION_DEPLOYMENT,
            r"deploy|release|production|prod|go.*live",
        ),
    ]
}

fn low_risk_patterns() -> &'static [&'static str] {
    &[
        r"read",
        r"list",
        r"get",
        r"fetch",
        r"search",
        r"grep",
        r"cat\s+",
        r"ls\s+",
        r"echo",
        r"test",
        r"benchmark",
    ]
}

fn irreversible_patterns() -> &'static [&'static str] {
    &[
        r"rm\s+-rf",
        r"rm\s+.*\/\*",
        r"drop\s+database",
        r"drop\s+table",
        r"truncate.*table",
        r"delete.*where",
        r"destroy",
        r"reset\s+--hard",
        r"git\s+clean\s+-fd",
    ]
}

fn classify_value(payload: &Map<String, Value>) -> Value {
    let tool_name = as_str(payload.get("tool_name").or_else(|| payload.get("toolName")));
    let command_text = as_str(
        payload
            .get("command_text")
            .or_else(|| payload.get("commandText")),
    );
    let text = format!("{tool_name} {command_text}").to_ascii_lowercase();

    for (action_type, pattern) in high_stakes_rules() {
        let re = compile_pattern(pattern);
        if re.is_match(&text) {
            return json!({
                "type": action_type,
                "risk": RISK_HIGH,
                "confidence": "medium",
                "matched_pattern": re.as_str()
            });
        }
    }

    for pattern in low_risk_patterns() {
        let re = compile_pattern(pattern);
        if re.is_match(&text) {
            return json!({
                "type": ACTION_RESEARCH,
                "risk": RISK_LOW,
                "confidence": "low",
                "matched_pattern": re.as_str()
            });
        }
    }

    json!({
        "type": ACTION_OTHER,
        "risk": RISK_MEDIUM,
        "confidence": "low",
        "matched_pattern": Value::Null
    })
}

fn requires_approval_value(action_type: &str) -> bool {
    matches!(
        normalized_type(action_type),
        ACTION_PUBLISH_PUBLICLY
            | ACTION_SPEND_MONEY
            | ACTION_CHANGE_CREDENTIALS
            | ACTION_DELETE_DATA
            | ACTION_OUTBOUND_CONTACT_NEW
            | ACTION_DEPLOYMENT
    )
}

fn detect_irreversible_value(command_text: &str) -> Value {
    let text = command_text.to_ascii_lowercase();
    for pattern in irreversible_patterns() {
        let re = compile_pattern(pattern);
        if re.is_match(&text) {
            return json!({
                "is_irreversible": true,
                "pattern": re.as_str(),
                "severity": "critical"
            });
        }
    }
    json!({ "is_irreversible": false })
}

fn generate_summary(tool_name: &str, command_text: &str, action_type: &str) -> String {
    if !tool_name.is_empty() && !command_text.is_empty() {
        let clipped = if command_text.len() > 50 {
            format!("{}...", &command_text[..50])
        } else {
            command_text.to_string()
        };
        return format!("{action_type}: {tool_name} - {clipped}");
    }
    if !tool_name.is_empty() {
        return format!("{action_type}: {tool_name}");
    }
    if !command_text.is_empty() {
        let clipped = if command_text.len() > 60 {
            format!("{}...", &command_text[..60])
        } else {
            command_text.to_string()
        };
        return format!("{action_type}: {clipped}");
    }
    format!("{action_type}: Unnamed action")
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    as_array(value)
        .iter()
        .map(|row| clean_text(&as_str(Some(row)), 120))
        .filter(|row| !row.is_empty())
        .collect()
}

fn payload_map_clone(value: Option<&Value>) -> Map<String, Value> {
    as_object(value).cloned().unwrap_or_default()
}

fn build_envelope(input: &Map<String, Value>) -> Value {
    let action_type = normalized_type(&as_str(input.get("type")));
    let risk = normalized_risk(&as_str(input.get("risk")));
    let tool_name = clean_text(
        &as_str(input.get("tool_name").or_else(|| input.get("toolName"))),
        120,
    );
    let command_text = clean_text(
        &as_str(
            input
                .get("command_text")
                .or_else(|| input.get("commandText")),
        ),
        240,
    );
    let summary = {
        let provided = clean_text(&as_str(input.get("summary")), 240);
        if provided.is_empty() {
            generate_summary(&tool_name, &command_text, action_type)
        } else {
            provided
        }
    };
    let tags = string_array(input.get("tags"));
    let payload = payload_map_clone(input.get("payload"));
    json!({
        "action_id": generate_action_id(),
        "directive_id": if as_str(input.get("directive_id")).is_empty() { Value::Null } else { Value::String(as_str(input.get("directive_id"))) },
        "tier": as_i64(input.get("tier"), 2),
        "type": action_type,
        "summary": summary,
        "risk": risk,
        "payload": Value::Object(payload),
        "tags": tags,
        "metadata": {
            "created_at": now_iso(),
            "tool_name": if tool_name.is_empty() { Value::Null } else { Value::String(tool_name) },
            "command_text": if command_text.is_empty() { Value::Null } else { Value::String(command_text.clone()) },
            "requires_approval": false,
            "allowed": true,
            "blocked_reason": Value::Null
        }
    })
}

fn run_command(command: &str, payload: &Map<String, Value>) -> Result<Value, String> {
    match command {
        "create" => {
            let input = as_object(payload.get("input")).cloned().unwrap_or_default();
            Ok(json!({
                "ok": true,
                "envelope": build_envelope(&input)
            }))
        }
        "generate-id" => Ok(json!({
            "ok": true,
            "action_id": generate_action_id()
        })),
        "classify" => Ok(json!({
            "ok": true,
            "classification": classify_value(payload)
        })),
        "requires-approval" => {
            let action_type = as_str(payload.get("type"));
            Ok(json!({
                "ok": true,
                "requires_approval": requires_approval_value(&action_type)
            }))
        }
        "detect-irreversible" => {
            let command_text = as_str(
                payload
                    .get("command_text")
                    .or_else(|| payload.get("commandText")),
            );
            Ok(json!({
                "ok": true,
                "result": detect_irreversible_value(&command_text)
            }))
        }
        "auto-classify" => {
            let classification = classify_value(payload);
            let mut input = payload.clone();
            input.insert(
                "type".to_string(),
                Value::String(as_str(classification.get("type"))),
            );
            input.insert(
                "risk".to_string(),
                Value::String(as_str(classification.get("risk"))),
            );
            if !payload.contains_key("tags") {
                input.insert(
                    "tags".to_string(),
                    json!([
                        as_str(classification.get("type")),
                        as_str(classification.get("risk"))
                    ]),
                );
            }
            Ok(json!({
                "ok": true,
                "classification": classification,
                "envelope": build_envelope(&input)
            }))
        }
        _ => Err("action_envelope_kernel_unknown_command".to_string()),
    }
}

pub fn run(_root: &std::path::Path, argv: &[String]) -> i32 {
    let Some(command) = argv.first().map(|value| value.as_str()) else {
        usage();
        return 1;
    };
    if matches!(command, "help" | "--help" | "-h") {
        usage();
        return 0;
    }
    let payload = match payload_json(argv) {
        Ok(value) => value,
        Err(err) => {
            print_json_line(&cli_error("action_envelope_kernel", &err));
            return 1;
        }
    };
    let payload = payload_obj(&payload).clone();
    match run_command(command, &payload) {
        Ok(out) => {
            print_json_line(&cli_receipt("action_envelope_kernel", out));
            0
        }
        Err(err) => {
            print_json_line(&cli_error("action_envelope_kernel", &err));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_detects_publish_publicly() {
        let classification = classify_value(payload_obj(&json!({
            "tool_name": "gh",
            "command_text": "publish blog post to medium"
        })));
        assert_eq!(
            classification.get("type").and_then(Value::as_str),
            Some(ACTION_PUBLISH_PUBLICLY)
        );
        assert_eq!(
            classification.get("risk").and_then(Value::as_str),
            Some(RISK_HIGH)
        );
    }

    #[test]
    fn auto_classify_preserves_tags_and_summary_shape() {
        let out = run_command(
            "auto-classify",
            payload_obj(&json!({
                "tool_name": "bash",
                "command_text": "rm -rf tmp/build",
                "payload": { "path": "tmp/build" }
            })),
        )
        .unwrap();
        let envelope = out.get("envelope").unwrap();
        assert_eq!(
            envelope.get("type").and_then(Value::as_str),
            Some(ACTION_DELETE_DATA)
        );
        assert_eq!(
            envelope.pointer("/tags/0").and_then(Value::as_str),
            Some(ACTION_DELETE_DATA)
        );
        assert!(envelope
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("")
            .starts_with("delete_data:"));
    }
}
