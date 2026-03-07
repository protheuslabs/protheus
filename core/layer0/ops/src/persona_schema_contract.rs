// SPDX-License-Identifier: Apache-2.0
use crate::{clean, deterministic_receipt_hash, now_iso, parse_args};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const STATE_REL: &str = "state/ops/persona_schema_contract/latest.json";

#[derive(Debug, Clone, PartialEq, Eq)]
struct ValidationIssue {
    code: String,
    detail: String,
}

pub fn run(root: &Path, args: &[String]) -> i32 {
    let parsed = parse_args(args);
    let command = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "validate".to_string());

    match command.as_str() {
        "validate" => {
            let strict = parse_bool(parsed.flags.get("strict").map(String::as_str), true);
            let schema_mode = clean(
                parsed
                    .flags
                    .get("schema-mode")
                    .or_else(|| parsed.flags.get("schema"))
                    .map(String::as_str)
                    .unwrap_or("persona_lens_v1"),
                64,
            );
            let payload = match load_payload(root, &parsed) {
                Ok(value) => value,
                Err(err) => {
                    let receipt = error_receipt(&schema_mode, strict, &err);
                    print_json(&receipt);
                    let _ = write_state(root, &receipt);
                    return 1;
                }
            };

            let issues = validate_payload(&payload, &schema_mode);
            let valid = issues.is_empty();
            let fail_closed = strict && !valid;
            let ts = now_iso();
            let mut receipt = json!({
                "ok": !fail_closed,
                "type": "persona_schema_contract",
                "schema_id": "persona_schema_contract_receipt",
                "schema_version": "1.0",
                "ts": ts,
                "date": ts[..10].to_string(),
                "command": "validate",
                "strict_mode": strict,
                "schema_mode": schema_mode,
                "validation": {
                    "valid": valid,
                    "issue_count": issues.len(),
                    "issues": issues
                        .iter()
                        .map(|issue| json!({"code": issue.code, "detail": issue.detail}))
                        .collect::<Vec<_>>()
                },
                "metadata": {
                    "has_persona_lenses": payload.get("persona_lenses").map(Value::is_object).unwrap_or(false),
                    "has_active_lens": payload
                        .pointer("/persona_lenses/active")
                        .and_then(Value::as_str)
                        .map(|v| !v.trim().is_empty())
                        .unwrap_or(false),
                    "has_clearance": payload
                        .pointer("/persona_lenses/clearance")
                        .and_then(Value::as_str)
                        .map(|v| !v.trim().is_empty())
                        .unwrap_or(false)
                },
                "fail_closed": fail_closed,
                "claim_evidence": [
                    {
                        "id": "strict_persona_lens_schema_contract",
                        "claim": "persona_and_lens_outputs_fail_closed_when_schema_contract_is_violated_in_strict_mode",
                        "evidence": {
                            "schema_mode": schema_mode,
                            "strict_mode": strict,
                            "valid": valid,
                            "issue_count": issues.len()
                        }
                    }
                ]
            });
            receipt["receipt_hash"] = Value::String(deterministic_receipt_hash(&receipt));
            print_json(&receipt);
            let _ = write_state(root, &receipt);
            if fail_closed { 1 } else { 0 }
        }
        "status" => {
            let state_path = root.join(STATE_REL);
            if !state_path.exists() {
                let receipt = json!({
                    "ok": false,
                    "type": "persona_schema_contract_status",
                    "error": "state_missing",
                    "state_path": state_path.to_string_lossy().to_string()
                });
                print_json(&receipt);
                return 1;
            }
            match fs::read_to_string(&state_path) {
                Ok(raw) => {
                    match serde_json::from_str::<Value>(&raw) {
                        Ok(mut value) => {
                            value["type"] = Value::String("persona_schema_contract_status".to_string());
                            print_json(&value);
                            0
                        }
                        Err(err) => {
                            let receipt = json!({
                                "ok": false,
                                "type": "persona_schema_contract_status",
                                "error": format!("state_decode_failed:{err}")
                            });
                            print_json(&receipt);
                            1
                        }
                    }
                }
                Err(err) => {
                    let receipt = json!({
                        "ok": false,
                        "type": "persona_schema_contract_status",
                        "error": format!("state_read_failed:{err}")
                    });
                    print_json(&receipt);
                    1
                }
            }
        }
        _ => {
            let receipt = json!({
                "ok": false,
                "type": "persona_schema_contract",
                "error": "unknown_command",
                "command": command
            });
            print_json(&receipt);
            1
        }
    }
}

fn parse_bool(raw: Option<&str>, fallback: bool) -> bool {
    let Some(value) = raw else {
        return fallback;
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn load_payload(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    if let Some(raw) = parsed.flags.get("payload") {
        return serde_json::from_str(raw).map_err(|err| format!("payload_json_invalid:{err}"));
    }
    if let Some(input) = parsed.flags.get("input") {
        let candidate = PathBuf::from(input);
        let path = if candidate.is_absolute() {
            candidate
        } else {
            root.join(candidate)
        };
        let raw = fs::read_to_string(&path).map_err(|err| format!("input_read_failed:{err}"))?;
        return serde_json::from_str(&raw).map_err(|err| format!("input_json_invalid:{err}"));
    }
    Err("payload_missing_use_--payload_or_--input".to_string())
}

fn validate_payload(payload: &Value, schema_mode: &str) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    if !payload.is_object() {
        issues.push(issue("payload_not_object", "top-level payload must be an object"));
        return issues;
    }

    expect_exact_string(payload, "/schema_id", schema_mode, "schema_id_mismatch", &mut issues);
    expect_nonempty_string(
        payload,
        "/schema_version",
        "schema_version_missing_or_invalid",
        &mut issues,
    );

    let persona_lenses = payload.pointer("/persona_lenses");
    if !persona_lenses.map(Value::is_object).unwrap_or(false) {
        issues.push(issue(
            "persona_lenses_missing_or_invalid",
            "persona_lenses must be an object",
        ));
    } else {
        expect_nonempty_string(
            payload,
            "/persona_lenses/active",
            "persona_lenses_active_missing_or_invalid",
            &mut issues,
        );
        expect_nonempty_string(
            payload,
            "/persona_lenses/clearance",
            "persona_lenses_clearance_missing_or_invalid",
            &mut issues,
        );
    }
    issues
}

fn expect_nonempty_string(
    payload: &Value,
    pointer: &str,
    code: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    let valid = payload
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if !valid {
        issues.push(issue(code, &format!("{pointer} must be a non-empty string")));
    }
}

fn expect_exact_string(
    payload: &Value,
    pointer: &str,
    expected: &str,
    code: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    let actual = payload.pointer(pointer).and_then(Value::as_str).unwrap_or("");
    if actual != expected {
        issues.push(issue(
            code,
            &format!("{pointer} expected `{expected}` but received `{actual}`"),
        ));
    }
}

fn issue(code: &str, detail: &str) -> ValidationIssue {
    ValidationIssue {
        code: code.to_string(),
        detail: detail.to_string(),
    }
}

fn error_receipt(schema_mode: &str, strict: bool, error: &str) -> Value {
    let ts = now_iso();
    let mut out = json!({
        "ok": false,
        "type": "persona_schema_contract",
        "schema_id": "persona_schema_contract_receipt",
        "schema_version": "1.0",
        "ts": ts,
        "date": ts[..10].to_string(),
        "strict_mode": strict,
        "schema_mode": schema_mode,
        "fail_closed": true,
        "error": error
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn write_state(root: &Path, receipt: &Value) -> Result<(), String> {
    let path = root.join(STATE_REL);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("state_dir_create_failed:{err}"))?;
    }
    let encoded = serde_json::to_string_pretty(receipt)
        .map_err(|err| format!("state_encode_failed:{err}"))?;
    fs::write(&path, format!("{encoded}\n")).map_err(|err| format!("state_write_failed:{err}"))
}

fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string())
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn valid_payload() -> Value {
        json!({
            "schema_id": "persona_lens_v1",
            "schema_version": "1.0",
            "persona_lenses": {
                "active": "guardian",
                "clearance": "3"
            }
        })
    }

    #[test]
    fn strict_validation_passes_for_valid_payload() {
        let issues = validate_payload(&valid_payload(), "persona_lens_v1");
        assert!(issues.is_empty());
    }

    #[test]
    fn strict_validation_fails_closed_for_missing_fields() {
        let payload = json!({
            "schema_id": "persona_lens_v1",
            "schema_version": "1.0",
            "persona_lenses": {
                "active": ""
            }
        });
        let issues = validate_payload(&payload, "persona_lens_v1");
        assert!(!issues.is_empty());
        assert!(
            issues
                .iter()
                .any(|issue| issue.code == "persona_lenses_active_missing_or_invalid")
        );
        assert!(
            issues
                .iter()
                .any(|issue| issue.code == "persona_lenses_clearance_missing_or_invalid")
        );
    }

    #[test]
    fn error_receipt_hash_is_deterministic() {
        let receipt = error_receipt("persona_lens_v1", true, "payload_missing");
        let hash = receipt
            .get("receipt_hash")
            .and_then(Value::as_str)
            .expect("hash")
            .to_string();
        let mut no_hash = receipt.clone();
        no_hash
            .as_object_mut()
            .expect("object")
            .remove("receipt_hash");
        assert_eq!(deterministic_receipt_hash(&no_hash), hash);
    }

    #[test]
    fn parse_bool_accepts_true_false_forms() {
        assert!(parse_bool(Some("1"), false));
        assert!(parse_bool(Some("true"), false));
        assert!(!parse_bool(Some("0"), true));
        assert!(!parse_bool(Some("false"), true));
        assert!(parse_bool(Some("invalid"), true));
    }

    #[test]
    fn cli_validate_writes_schema_mode_and_metadata() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        let payload =
            r#"{"schema_id":"persona_lens_v1","schema_version":"1.0","persona_lenses":{"active":"guardian","clearance":"3"}}"#;
        let args = vec![
            "validate".to_string(),
            "--strict=1".to_string(),
            "--schema-mode=persona_lens_v1".to_string(),
            format!("--payload={payload}"),
        ];

        let exit = run(root, &args);
        assert_eq!(exit, 0);

        let state_path = root.join(STATE_REL);
        let state = fs::read_to_string(&state_path).expect("state");
        let json: Value = serde_json::from_str(&state).expect("state json");
        assert_eq!(
            json.get("schema_mode").and_then(Value::as_str),
            Some("persona_lens_v1")
        );
        assert_eq!(
            json.pointer("/metadata/has_persona_lenses")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            json.pointer("/validation/valid").and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn cli_validate_fails_closed_when_strict_and_invalid() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        let payload = r#"{"schema_id":"persona_lens_v1","schema_version":"1.0","persona_lenses":{"active":""}}"#;
        let args = vec![
            "validate".to_string(),
            "--strict=1".to_string(),
            "--schema-mode=persona_lens_v1".to_string(),
            format!("--payload={payload}"),
        ];

        let exit = run(root, &args);
        assert_eq!(exit, 1);

        let state_path = root.join(STATE_REL);
        let state = fs::read_to_string(&state_path).expect("state");
        let json: Value = serde_json::from_str(&state).expect("state json");
        assert_eq!(json.get("fail_closed").and_then(Value::as_bool), Some(true));
        assert_eq!(json.get("ok").and_then(Value::as_bool), Some(false));
        assert!(
            json.pointer("/validation/issue_count")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                >= 1
        );
    }
}
