// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_QUEUE_REL: &str = "client/runtime/local/state/approvals_queue.yaml";

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
struct ApprovalQueue {
    #[serde(default)]
    pending: Vec<ApprovalEntry>,
    #[serde(default)]
    approved: Vec<ApprovalEntry>,
    #[serde(default)]
    denied: Vec<ApprovalEntry>,
    #[serde(default)]
    history: Vec<ApprovalEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
struct ApprovalEntry {
    #[serde(default)]
    action_id: String,
    #[serde(default)]
    timestamp: String,
    #[serde(default)]
    directive_id: String,
    #[serde(rename = "type", default)]
    entry_type: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    payload_pointer: String,
    #[serde(default)]
    approved_at: String,
    #[serde(default)]
    denied_at: String,
    #[serde(default)]
    deny_reason: String,
    #[serde(default)]
    action: String,
    #[serde(default)]
    history_at: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct QueuePayload {
    #[serde(default)]
    action_envelope: Option<Value>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    queue: Option<ApprovalQueue>,
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
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

fn usage() {
    println!("approval-gate-kernel commands:");
    println!("  protheus-ops approval-gate-kernel status [--queue-path=<path>]");
    println!("  protheus-ops approval-gate-kernel queue --payload-base64=<base64_json> [--queue-path=<path>]");
    println!("  protheus-ops approval-gate-kernel approve --action-id=<id> [--queue-path=<path>]");
    println!("  protheus-ops approval-gate-kernel deny --action-id=<id> [--reason=<text>] [--queue-path=<path>]");
    println!("  protheus-ops approval-gate-kernel was-approved --action-id=<id> [--queue-path=<path>]");
    println!("  protheus-ops approval-gate-kernel parse-command --text-base64=<base64_text>");
    println!("  protheus-ops approval-gate-kernel parse-yaml --text-base64=<base64_text>");
    println!("  protheus-ops approval-gate-kernel replace --payload-base64=<base64_json> [--queue-path=<path>]");
}

fn resolve_queue_path(root: &Path, argv: &[String]) -> PathBuf {
    if let Some(explicit) = lane_utils::parse_flag(argv, "queue-path", false) {
        let cleaned = explicit.trim();
        if !cleaned.is_empty() {
            let candidate = PathBuf::from(cleaned);
            if candidate.is_absolute() {
                return candidate;
            }
            return root.join(candidate);
        }
    }
    for env_name in ["APPROVAL_GATE_QUEUE_PATH", "PROTHEUS_APPROVAL_GATE_QUEUE_PATH"] {
        if let Ok(raw) = std::env::var(env_name) {
            let cleaned = raw.trim();
            if !cleaned.is_empty() {
                let candidate = PathBuf::from(cleaned);
                if candidate.is_absolute() {
                    return candidate;
                }
                return root.join(candidate);
            }
        }
    }
    root.join(DEFAULT_QUEUE_REL)
}

fn load_payload(argv: &[String]) -> Result<QueuePayload, String> {
    if let Some(payload) = lane_utils::parse_flag(argv, "payload", false) {
        return serde_json::from_str::<QueuePayload>(&payload)
            .map_err(|err| format!("approval_gate_kernel_payload_decode_failed:{err}"));
    }
    if let Some(payload_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(payload_b64.as_bytes())
            .map_err(|err| format!("approval_gate_kernel_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("approval_gate_kernel_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<QueuePayload>(&text)
            .map_err(|err| format!("approval_gate_kernel_payload_decode_failed:{err}"));
    }
    Err("approval_gate_kernel_missing_payload".to_string())
}

fn decode_text_flag(argv: &[String], flag: &str) -> Result<String, String> {
    let Some(encoded) = lane_utils::parse_flag(argv, flag, false) else {
        return Err(format!("approval_gate_kernel_missing_{flag}"));
    };
    let bytes = BASE64_STANDARD
        .decode(encoded.as_bytes())
        .map_err(|err| format!("approval_gate_kernel_{flag}_base64_decode_failed:{err}"))?;
    String::from_utf8(bytes)
        .map_err(|err| format!("approval_gate_kernel_{flag}_utf8_decode_failed:{err}"))
}

fn read_queue(path: &Path) -> Result<ApprovalQueue, String> {
    if !path.exists() {
        return Ok(ApprovalQueue::default());
    }
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("approval_gate_kernel_read_queue_failed:{err}"))?;
    if raw.trim().is_empty() {
        return Ok(ApprovalQueue::default());
    }
    serde_yaml::from_str::<ApprovalQueue>(&raw)
        .map_err(|err| format!("approval_gate_kernel_parse_queue_failed:{err}"))
}

fn write_queue(path: &Path, queue: &ApprovalQueue) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("approval_gate_kernel_create_dir_failed:{err}"))?;
    }
    let encoded = serde_yaml::to_string(queue)
        .map_err(|err| format!("approval_gate_kernel_encode_queue_failed:{err}"))?;
    fs::write(path, encoded).map_err(|err| format!("approval_gate_kernel_write_queue_failed:{err}"))
}

fn clean_text(value: Option<&Value>, max_len: usize) -> String {
    value.and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(max_len)
        .collect()
}

fn generate_approval_message(entry: &ApprovalEntry) -> String {
    format!(
        "Action: {}\nType: {}\nDirective: {}\nWhy gated: {}\nAction ID: {}\n\nTo approve, reply: APPROVE {}\nTo deny, reply: DENY {}",
        entry.summary,
        entry.entry_type,
        entry.directive_id,
        entry.reason,
        entry.action_id,
        entry.action_id,
        entry.action_id
    )
}

fn queue_entry_from_payload(action_envelope: &Value, reason: &str) -> Result<ApprovalEntry, String> {
    let Some(obj) = action_envelope.as_object() else {
        return Err("approval_gate_kernel_action_envelope_invalid".to_string());
    };
    let action_id = clean_text(obj.get("action_id"), 160);
    if action_id.is_empty() {
        return Err("approval_gate_kernel_action_id_missing".to_string());
    }
    let directive_id = clean_text(obj.get("directive_id"), 160);
    let entry_type = clean_text(obj.get("type"), 120);
    let summary = clean_text(obj.get("summary"), 480);
    Ok(ApprovalEntry {
        action_id: action_id.clone(),
        timestamp: now_iso(),
        directive_id: if directive_id.is_empty() {
            "T0_invariants".to_string()
        } else {
            directive_id
        },
        entry_type,
        summary,
        reason: reason.trim().to_string(),
        status: "PENDING".to_string(),
        payload_pointer: action_id,
        ..ApprovalEntry::default()
    })
}

fn parse_approval_command(text: &str) -> Value {
    let trimmed = text.trim();
    let mut parts = trimmed.split_whitespace();
    let Some(action) = parts.next() else {
        return Value::Null;
    };
    let Some(action_id) = parts.next() else {
        return Value::Null;
    };
    if parts.next().is_some() {
        return Value::Null;
    }
    let normalized = action.trim().to_ascii_lowercase();
    if normalized == "approve" || normalized == "deny" {
        return json!({
            "action": normalized,
            "action_id": action_id
        });
    }
    Value::Null
}

fn command_status(root: &Path, argv: &[String]) -> Value {
    let queue_path = resolve_queue_path(root, argv);
    match read_queue(&queue_path) {
        Ok(queue) => cli_receipt(
            "approval_gate_kernel_status",
            json!({
                "ok": true,
                "queue_path": queue_path.to_string_lossy(),
                "queue": queue
            }),
        ),
        Err(error) => cli_error("approval_gate_kernel_status", &error),
    }
}

fn command_queue(root: &Path, argv: &[String]) -> Value {
    let queue_path = resolve_queue_path(root, argv);
    let payload = match load_payload(argv) {
        Ok(payload) => payload,
        Err(error) => return cli_error("approval_gate_kernel_queue", &error),
    };
    let action_envelope = match payload.action_envelope {
        Some(value) => value,
        None => return cli_error("approval_gate_kernel_queue", "approval_gate_kernel_action_envelope_missing"),
    };
    let reason = payload.reason.unwrap_or_else(|| "approval_required".to_string());
    let mut queue = match read_queue(&queue_path) {
        Ok(queue) => queue,
        Err(error) => return cli_error("approval_gate_kernel_queue", &error),
    };
    let entry = match queue_entry_from_payload(&action_envelope, &reason) {
        Ok(entry) => entry,
        Err(error) => return cli_error("approval_gate_kernel_queue", &error),
    };
    queue.pending.push(entry.clone());
    if let Err(error) = write_queue(&queue_path, &queue) {
        return cli_error("approval_gate_kernel_queue", &error);
    }
    cli_receipt(
        "approval_gate_kernel_queue",
        json!({
            "ok": true,
            "queue_path": queue_path.to_string_lossy(),
            "queue": queue,
            "result": {
                "success": true,
                "action_id": entry.action_id,
                "message": generate_approval_message(&entry)
            }
        }),
    )
}

fn transition_entry(
    queue: &mut ApprovalQueue,
    action_id: &str,
    deny_reason: Option<&str>,
) -> Result<Value, String> {
    let Some(idx) = queue.pending.iter().position(|entry| entry.action_id == action_id) else {
        return Err(format!("approval_gate_kernel_action_not_found:{action_id}"));
    };
    let mut entry = queue.pending.remove(idx);
    let ts = now_iso();
    let success_message;
    if let Some(reason) = deny_reason {
        entry.status = "DENIED".to_string();
        entry.denied_at = ts.clone();
        entry.deny_reason = reason.to_string();
        queue.denied.push(entry.clone());
        let mut history = entry.clone();
        history.action = "denied".to_string();
        history.history_at = ts;
        queue.history.push(history);
        success_message = format!("DENIED: {}", entry.summary);
    } else {
        entry.status = "APPROVED".to_string();
        entry.approved_at = ts.clone();
        queue.approved.push(entry.clone());
        let mut history = entry.clone();
        history.action = "approved".to_string();
        history.history_at = ts;
        queue.history.push(history);
        success_message = format!("APPROVED: {}. You can now re-run this action.", entry.summary);
    }
    Ok(json!({
        "success": true,
        "action_id": action_id,
        "message": success_message
    }))
}

fn command_approve(root: &Path, argv: &[String]) -> Value {
    let queue_path = resolve_queue_path(root, argv);
    let Some(action_id) = lane_utils::parse_flag(argv, "action-id", false) else {
        return cli_error("approval_gate_kernel_approve", "approval_gate_kernel_action_id_missing");
    };
    let mut queue = match read_queue(&queue_path) {
        Ok(queue) => queue,
        Err(error) => return cli_error("approval_gate_kernel_approve", &error),
    };
    let result = match transition_entry(&mut queue, action_id.trim(), None) {
        Ok(result) => result,
        Err(error) => return cli_error("approval_gate_kernel_approve", &error),
    };
    if let Err(error) = write_queue(&queue_path, &queue) {
        return cli_error("approval_gate_kernel_approve", &error);
    }
    cli_receipt(
        "approval_gate_kernel_approve",
        json!({
            "ok": true,
            "queue_path": queue_path.to_string_lossy(),
            "queue": queue,
            "result": result
        }),
    )
}

fn command_deny(root: &Path, argv: &[String]) -> Value {
    let queue_path = resolve_queue_path(root, argv);
    let Some(action_id) = lane_utils::parse_flag(argv, "action-id", false) else {
        return cli_error("approval_gate_kernel_deny", "approval_gate_kernel_action_id_missing");
    };
    let reason = lane_utils::parse_flag(argv, "reason", false)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "User denied".to_string());
    let mut queue = match read_queue(&queue_path) {
        Ok(queue) => queue,
        Err(error) => return cli_error("approval_gate_kernel_deny", &error),
    };
    let result = match transition_entry(&mut queue, action_id.trim(), Some(&reason)) {
        Ok(result) => result,
        Err(error) => return cli_error("approval_gate_kernel_deny", &error),
    };
    if let Err(error) = write_queue(&queue_path, &queue) {
        return cli_error("approval_gate_kernel_deny", &error);
    }
    cli_receipt(
        "approval_gate_kernel_deny",
        json!({
            "ok": true,
            "queue_path": queue_path.to_string_lossy(),
            "queue": queue,
            "result": result
        }),
    )
}

fn command_was_approved(root: &Path, argv: &[String]) -> Value {
    let queue_path = resolve_queue_path(root, argv);
    let Some(action_id) = lane_utils::parse_flag(argv, "action-id", false) else {
        return cli_error("approval_gate_kernel_was_approved", "approval_gate_kernel_action_id_missing");
    };
    let queue = match read_queue(&queue_path) {
        Ok(queue) => queue,
        Err(error) => return cli_error("approval_gate_kernel_was_approved", &error),
    };
    let approved = queue
        .approved
        .iter()
        .any(|entry| entry.action_id == action_id.trim());
    cli_receipt(
        "approval_gate_kernel_was_approved",
        json!({
            "ok": true,
            "queue_path": queue_path.to_string_lossy(),
            "action_id": action_id.trim(),
            "approved": approved
        }),
    )
}

fn command_parse_command(argv: &[String]) -> Value {
    match decode_text_flag(argv, "text-base64") {
        Ok(text) => cli_receipt(
            "approval_gate_kernel_parse_command",
            json!({
                "ok": true,
                "command": parse_approval_command(&text)
            }),
        ),
        Err(error) => cli_error("approval_gate_kernel_parse_command", &error),
    }
}

fn command_parse_yaml(argv: &[String]) -> Value {
    match decode_text_flag(argv, "text-base64") {
        Ok(text) => match serde_yaml::from_str::<ApprovalQueue>(&text) {
            Ok(queue) => cli_receipt(
                "approval_gate_kernel_parse_yaml",
                json!({
                    "ok": true,
                    "queue": queue
                }),
            ),
            Err(error) => cli_error(
                "approval_gate_kernel_parse_yaml",
                &format!("approval_gate_kernel_parse_queue_failed:{error}"),
            ),
        },
        Err(error) => cli_error("approval_gate_kernel_parse_yaml", &error),
    }
}

fn command_replace(root: &Path, argv: &[String]) -> Value {
    let queue_path = resolve_queue_path(root, argv);
    let payload = match load_payload(argv) {
        Ok(payload) => payload,
        Err(error) => return cli_error("approval_gate_kernel_replace", &error),
    };
    let queue = match payload.queue {
        Some(queue) => queue,
        None => return cli_error("approval_gate_kernel_replace", "approval_gate_kernel_queue_missing"),
    };
    if let Err(error) = write_queue(&queue_path, &queue) {
        return cli_error("approval_gate_kernel_replace", &error);
    }
    cli_receipt(
        "approval_gate_kernel_replace",
        json!({
            "ok": true,
            "queue_path": queue_path.to_string_lossy(),
            "queue": queue
        }),
    )
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let command = argv
        .first()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    let receipt = match command.as_str() {
        "status" => command_status(root, argv),
        "queue" => command_queue(root, argv),
        "approve" => command_approve(root, argv),
        "deny" => command_deny(root, argv),
        "was-approved" | "was_approved" => command_was_approved(root, argv),
        "parse-command" | "parse_command" => command_parse_command(argv),
        "parse-yaml" | "parse_yaml" => command_parse_yaml(argv),
        "replace" => command_replace(root, argv),
        "help" | "--help" | "-h" => {
            usage();
            cli_receipt("approval_gate_kernel_help", json!({ "ok": true }))
        }
        _ => cli_error("approval_gate_kernel_error", "unknown_command"),
    };
    let exit_code = if receipt.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        0
    } else {
        1
    };
    print_json_line(&receipt);
    exit_code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_command_recognizes_approve_and_deny() {
        let approve = parse_approval_command("APPROVE act_123");
        assert_eq!(approve.get("action").and_then(Value::as_str), Some("approve"));
        assert_eq!(approve.get("action_id").and_then(Value::as_str), Some("act_123"));

        let deny = parse_approval_command("deny act_456");
        assert_eq!(deny.get("action").and_then(Value::as_str), Some("deny"));
        assert_eq!(deny.get("action_id").and_then(Value::as_str), Some("act_456"));
    }

    #[test]
    fn queue_round_trip_and_transition_work() {
        let entry = queue_entry_from_payload(
            &json!({
                "action_id": "act_123",
                "type": "publish_publicly",
                "summary": "Ship a change",
            }),
            "needs approval",
        )
        .expect("entry");
        let mut queue = ApprovalQueue::default();
        queue.pending.push(entry);
        let result = transition_entry(&mut queue, "act_123", None).expect("approve");
        assert_eq!(result.get("success").and_then(Value::as_bool), Some(true));
        assert!(queue.pending.is_empty());
        assert_eq!(queue.approved.len(), 1);
        assert_eq!(queue.history.len(), 1);

        let encoded = serde_yaml::to_string(&queue).expect("encode");
        let decoded = serde_yaml::from_str::<ApprovalQueue>(&encoded).expect("decode");
        assert_eq!(decoded.approved.len(), 1);
        assert_eq!(decoded.history.len(), 1);
    }
}
