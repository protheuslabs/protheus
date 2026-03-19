// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use crate::v8_kernel::{
    append_jsonl, keyed_digest_hex, parse_bool, print_json, read_json, scoped_state_root,
    sha256_hex_str, write_json, write_receipt,
};
use crate::{clean, now_iso, parse_args};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "DIRECTIVE_KERNEL_STATE_ROOT";
const STATE_SCOPE: &str = "directive_kernel";
const SIGNING_ENV: &str = "DIRECTIVE_KERNEL_SIGNING_KEY";
const DIRECTIVES_SUBDIR: [&str; 4] = ["client", "runtime", "config", "directives"];
#[path = "directive_kernel_run.rs"]
mod directive_kernel_run;

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn history_path(root: &Path) -> PathBuf {
    state_root(root).join("history.jsonl")
}

fn vault_path(root: &Path) -> PathBuf {
    state_root(root).join("prime_directive_vault.json")
}

fn directives_dir(root: &Path) -> PathBuf {
    let mut out = root.to_path_buf();
    for segment in DIRECTIVES_SUBDIR {
        out.push(segment);
    }
    out
}

fn active_directives_path(root: &Path) -> PathBuf {
    directives_dir(root).join("ACTIVE.yaml")
}

fn yaml_to_json(text: &str) -> Result<Value, String> {
    let parsed: serde_yaml::Value =
        serde_yaml::from_str(text).map_err(|err| format!("directive_yaml_parse_failed:{err}"))?;
    serde_json::to_value(parsed).map_err(|err| format!("directive_yaml_encode_failed:{err}"))
}

fn yaml_timebound_signal_present(parsed: &Value, raw_text: &str) -> bool {
    let keywords = [
        "timeframe",
        "deadline",
        "target_date",
        "target-date",
        "review_by",
        "review-by",
        "horizon",
        "month",
        "months",
        "year",
        "years",
        "quarter",
    ];
    let raw = raw_text.to_ascii_lowercase();
    if keywords.iter().any(|keyword| raw.contains(keyword)) {
        return true;
    }

    fn scan(value: &Value, keywords: &[&str]) -> bool {
        match value {
            Value::Object(map) => map.iter().any(|(key, value)| {
                let key_norm = key.to_ascii_lowercase();
                keywords.iter().any(|keyword| key_norm.contains(keyword)) || scan(value, keywords)
            }),
            Value::Array(rows) => rows.iter().any(|row| scan(row, keywords)),
            Value::String(text) => {
                let norm = text.to_ascii_lowercase();
                keywords.iter().any(|keyword| norm.contains(keyword))
            }
            Value::Number(number) => number.as_i64().map(|value| value > 0).unwrap_or(false),
            _ => false,
        }
    }

    scan(parsed, &keywords)
}

fn validate_tier1_directive_quality(content: &str, directive_id: &str) -> Value {
    let parsed = yaml_to_json(content).unwrap_or_else(|_| Value::Object(Map::new()));
    let obj = parsed.as_object();
    let empty = Map::new();
    let root = obj.unwrap_or(&empty);
    let intent = root
        .get("intent")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let constraints = root
        .get("constraints")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let success = root
        .get("success_metrics")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let scope = root
        .get("scope")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let approval = root
        .get("approval_policy")
        .and_then(Value::as_object)
        .unwrap_or(&empty);

    let mut missing = Vec::<String>::new();
    let mut questions = Vec::<String>::new();

    let intent_primary = intent
        .get("primary")
        .and_then(Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if !intent_primary {
        missing.push("intent.primary".to_string());
        questions.push("What is the single specific objective (intent.primary)?".to_string());
    }

    let definitions = intent.get("definitions");
    let definitions_present = definitions
        .and_then(Value::as_object)
        .map(|value| !value.is_empty())
        .unwrap_or(false);
    if !definitions_present
        || !yaml_timebound_signal_present(definitions.unwrap_or(&Value::Null), content)
    {
        missing.push("intent.definitions_timebound".to_string());
        questions.push("What explicit time-bound target or review horizon applies?".to_string());
    }

    let included = scope
        .get("included")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);
    if !included {
        missing.push("scope.included".to_string());
        questions.push("What is explicitly in scope for this directive?".to_string());
    }

    let excluded = scope
        .get("excluded")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);
    if !excluded {
        missing.push("scope.excluded".to_string());
        questions.push("What is explicitly out of scope for this directive?".to_string());
    }

    let risk_limits = constraints
        .get("risk_limits")
        .and_then(Value::as_object)
        .map(|value| !value.is_empty())
        .unwrap_or(false);
    if !risk_limits {
        missing.push("constraints.risk_limits".to_string());
        questions.push(
            "What quantitative risk limits apply (drawdown, burn, position size)?".to_string(),
        );
    }

    let leading = success
        .get("leading")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);
    if !leading {
        missing.push("success_metrics.leading".to_string());
        questions.push("Which leading indicators will be used to measure progress?".to_string());
    }

    let lagging = success
        .get("lagging")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);
    if !lagging {
        missing.push("success_metrics.lagging".to_string());
        questions.push("Which lagging metrics define end-state success?".to_string());
    }

    let additional_gates = approval
        .get("additional_gates")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);
    if !additional_gates {
        missing.push("approval_policy.additional_gates".to_string());
        questions
            .push("Which additional approval gates are required for Tier 1 actions?".to_string());
    }

    json!({
        "ok": missing.is_empty(),
        "directive_id": clean(directive_id, 128),
        "missing": missing,
        "questions": questions
    })
}

fn load_active_directives(
    root: &Path,
    allow_missing: bool,
    allow_weak_tier1: bool,
) -> Result<Vec<Value>, String> {
    let active_path = active_directives_path(root);
    if !active_path.exists() {
        return Err(format!(
            "active_directives_missing:{}",
            active_path.display()
        ));
    }

    let active_content = fs::read_to_string(&active_path)
        .map_err(|err| format!("active_directives_read_failed:{err}"))?;
    let active = yaml_to_json(&active_content)?;
    let active_rows = active
        .get("active_directives")
        .and_then(Value::as_array)
        .ok_or_else(|| "active_directives_array_missing".to_string())?;

    let directives_root = directives_dir(root);
    let mut loaded = Vec::<Value>::new();
    let mut missing = Vec::<Value>::new();
    for row in active_rows {
        let Some(entry) = row.as_object() else {
            continue;
        };
        let status = entry
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("active")
            .trim()
            .to_ascii_lowercase();
        if status != "active" {
            continue;
        }
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .map(|value| clean(value, 160))
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let tier = entry.get("tier").and_then(Value::as_i64).unwrap_or(99);
        let file_name = if id.ends_with(".yaml") {
            id.clone()
        } else {
            format!("{id}.yaml")
        };
        let file_path = directives_root.join(&file_name);
        if !file_path.exists() {
            if allow_missing {
                continue;
            }
            missing.push(json!({
                "id": id,
                "file": file_name,
                "path": file_path.display().to_string()
            }));
            continue;
        }

        let content = fs::read_to_string(&file_path)
            .map_err(|err| format!("directive_read_failed:{}:{err}", file_path.display()))?;
        if tier == 1 {
            let quality = validate_tier1_directive_quality(&content, &id);
            if !quality.get("ok").and_then(Value::as_bool).unwrap_or(false) && !allow_weak_tier1 {
                let missing_lines = quality
                    .get("missing")
                    .and_then(Value::as_array)
                    .map(|rows| {
                        rows.iter()
                            .filter_map(Value::as_str)
                            .map(|value| format!("  - {value}"))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                let question_lines = quality
                    .get("questions")
                    .and_then(Value::as_array)
                    .map(|rows| {
                        rows.iter()
                            .filter_map(Value::as_str)
                            .map(|value| format!("  - {value}"))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                return Err(format!(
                    "tier1_directive_quality_failed:{id}\n{missing_lines}\n{question_lines}"
                ));
            }
        }

        let directive = yaml_to_json(&content)?;
        loaded.push(json!({
            "id": id,
            "tier": tier,
            "status": status,
            "data": directive
        }));
    }

    if !missing.is_empty() && !allow_missing {
        return Err(format!(
            "active_directives_missing_files:{}",
            serde_json::to_string(&missing).unwrap_or_else(|_| "[]".to_string())
        ));
    }

    loaded.sort_by_key(|row| row.get("tier").and_then(Value::as_i64).unwrap_or(99));
    Ok(loaded)
}

fn merge_active_constraints(directives: &[Value]) -> Value {
    let mut hard_blocks = Vec::<Value>::new();
    let mut approval_required = Vec::<Value>::new();
    let mut risk_limits = Map::<String, Value>::new();
    let mut high_stakes_seen = HashSet::<String>::new();
    let mut high_stakes_domains = Vec::<Value>::new();

    for directive in directives {
        let Some(data) = directive.get("data").and_then(Value::as_object) else {
            continue;
        };
        let directive_tier = directive.get("tier").and_then(Value::as_i64).unwrap_or(99);
        if let Some(rows) = data.get("hard_blocks").and_then(Value::as_array) {
            for row in rows {
                let Some(obj) = row.as_object() else {
                    continue;
                };
                let Some(rule) = obj.get("rule").and_then(Value::as_str) else {
                    continue;
                };
                hard_blocks.push(json!({
                    "rule": clean(rule, 160),
                    "description": clean(
                        obj.get("description").and_then(Value::as_str).unwrap_or(rule),
                        240
                    ),
                    "tier": obj.get("tier").and_then(Value::as_i64).unwrap_or(directive_tier),
                    "patterns": obj.get("patterns").cloned().unwrap_or_else(|| Value::Array(Vec::new()))
                }));
            }
        }
        if let Some(rows) = data.get("approval_required").and_then(Value::as_array) {
            for row in rows {
                let Some(obj) = row.as_object() else {
                    continue;
                };
                let Some(rule) = obj.get("rule").and_then(Value::as_str) else {
                    continue;
                };
                approval_required.push(json!({
                    "rule": clean(rule, 160),
                    "description": clean(
                        obj.get("description").and_then(Value::as_str).unwrap_or(rule),
                        240
                    ),
                    "tier": obj.get("tier").and_then(Value::as_i64).unwrap_or(directive_tier),
                    "examples": obj.get("examples").cloned().unwrap_or_else(|| Value::Array(Vec::new()))
                }));
            }
        }
        if let Some(rows) = data.get("high_stakes_domains").and_then(Value::as_array) {
            for row in rows {
                let Some(obj) = row.as_object() else {
                    continue;
                };
                let Some(domain) = obj.get("domain").and_then(Value::as_str) else {
                    continue;
                };
                if !obj
                    .get("escalation_required")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    continue;
                }
                let domain_norm = clean(domain, 160).to_ascii_lowercase();
                if high_stakes_seen.insert(domain_norm.clone()) {
                    high_stakes_domains.push(Value::String(domain_norm));
                }
            }
        }
        if let Some(rows) = data.get("directives").and_then(Value::as_array) {
            for row in rows {
                let Some(obj) = row.as_object() else {
                    continue;
                };
                let Some(id) = obj.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let Some(constraints) = obj.get("constraints").and_then(Value::as_object) else {
                    continue;
                };
                if constraints.is_empty() {
                    continue;
                }
                risk_limits.insert(clean(id, 160), Value::Object(constraints.clone()));
            }
        }
    }

    json!({
        "tier": 0,
        "hard_blocks": hard_blocks,
        "approval_required": approval_required,
        "risk_limits": Value::Object(risk_limits),
        "high_stakes_domains": high_stakes_domains
    })
}

fn payload_contains_secret_token(payload: &str, marker: &str, min_len: usize) -> bool {
    let bytes = payload.as_bytes();
    let marker_bytes = marker.as_bytes();
    let mut idx = 0usize;
    while idx + marker_bytes.len() <= bytes.len() {
        if &bytes[idx..idx + marker_bytes.len()] != marker_bytes {
            idx += 1;
            continue;
        }
        let mut count = 0usize;
        let mut cursor = idx + marker_bytes.len();
        while cursor < bytes.len() {
            let ch = bytes[cursor] as char;
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                count += 1;
                cursor += 1;
                continue;
            }
            break;
        }
        if count >= min_len {
            return true;
        }
        idx = cursor;
    }
    false
}

fn payload_contains_authorization_bearer(payload: &str, min_len: usize) -> bool {
    let lowered = payload.to_ascii_lowercase();
    let marker = "authorization: bearer ";
    let bytes = lowered.as_bytes();
    let marker_bytes = marker.as_bytes();
    let mut idx = 0usize;
    while idx + marker_bytes.len() <= bytes.len() {
        if &bytes[idx..idx + marker_bytes.len()] != marker_bytes {
            idx += 1;
            continue;
        }
        let mut count = 0usize;
        let mut cursor = idx + marker_bytes.len();
        while cursor < bytes.len() {
            let ch = bytes[cursor] as char;
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.' {
                count += 1;
                cursor += 1;
                continue;
            }
            break;
        }
        if count >= min_len {
            return true;
        }
        idx = cursor;
    }
    false
}

fn approval_required_by_default(action_type: &str) -> bool {
    matches!(
        action_type,
        "publish_publicly"
            | "spend_money"
            | "change_credentials"
            | "delete_data"
            | "outbound_contact_new"
            | "deployment"
    )
}

fn irreversible_pattern(command_text: &str) -> Option<&'static str> {
    let patterns = [
        "rm -rf",
        "drop database",
        "drop table",
        "truncate",
        "delete",
        "destroy",
        "reset --hard",
        "git clean -fd",
    ];
    let lowered = command_text.to_ascii_lowercase();
    patterns
        .iter()
        .find(|pattern| lowered.contains(**pattern))
        .copied()
}

fn validate_action_envelope(root: &Path, envelope: &Value) -> Result<Value, String> {
    let directives = load_active_directives(root, false, false)?;
    let constraints = merge_active_constraints(&directives);
    let action_id = envelope
        .get("action_id")
        .and_then(Value::as_str)
        .map(|value| clean(value, 160))
        .unwrap_or_default();
    let tier = envelope.get("tier").and_then(Value::as_i64).unwrap_or(2);
    let action_type = envelope
        .get("type")
        .and_then(Value::as_str)
        .map(|value| clean(value, 120).to_ascii_lowercase())
        .unwrap_or_else(|| "other".to_string());
    let summary = envelope
        .get("summary")
        .and_then(Value::as_str)
        .map(|value| clean(value, 320).to_ascii_lowercase())
        .unwrap_or_default();
    let risk = envelope
        .get("risk")
        .and_then(Value::as_str)
        .map(|value| clean(value, 80).to_ascii_lowercase())
        .unwrap_or_else(|| "low".to_string());
    let payload_json = serde_json::to_string(envelope.get("payload").unwrap_or(&Value::Null))
        .unwrap_or_else(|_| "{}".to_string());

    let mut out = json!({
        "allowed": true,
        "requires_approval": false,
        "blocked_reason": Value::Null,
        "approval_reason": Value::Null,
        "effective_constraints": constraints.clone(),
        "action_id": action_id,
        "tier": tier
    });

    if constraints
        .get("hard_blocks")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false)
    {
        if payload_contains_secret_token(&payload_json, "moltbook_sk_", 20) {
            out["allowed"] = Value::Bool(false);
            out["blocked_reason"] = Value::String(
                "T0 INVARIANT VIOLATION: Secrets must always be redacted. Unredacted secret token detected in payload"
                    .to_string(),
            );
            return Ok(out);
        }
        if payload_contains_authorization_bearer(&payload_json, 20) {
            out["allowed"] = Value::Bool(false);
            out["blocked_reason"] = Value::String(
                "T0 INVARIANT VIOLATION: Secrets must always be redacted. Unredacted authorization header detected in payload"
                    .to_string(),
            );
            return Ok(out);
        }
    }

    let action_text = format!("{action_type} {summary}");
    if let Some(rows) = constraints
        .get("approval_required")
        .and_then(Value::as_array)
    {
        'approval_rows: for row in rows {
            let Some(obj) = row.as_object() else {
                continue;
            };
            if let Some(examples) = obj.get("examples").and_then(Value::as_array) {
                for example in examples {
                    let Some(example_text) = example.as_str() else {
                        continue;
                    };
                    let example_norm = clean(example_text, 160).to_ascii_lowercase();
                    if example_norm.is_empty() || !action_text.contains(&example_norm) {
                        continue;
                    }
                    out["requires_approval"] = Value::Bool(true);
                    out["approval_reason"] = Value::String(format!(
                        "{} (matched: {})",
                        clean(
                            obj.get("description")
                                .and_then(Value::as_str)
                                .unwrap_or(example_text),
                            240
                        ),
                        example_norm
                    ));
                    break 'approval_rows;
                }
            }
        }
    }

    if out
        .get("requires_approval")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        == false
    {
        if let Some(domains) = constraints
            .get("high_stakes_domains")
            .and_then(Value::as_array)
        {
            for domain in domains {
                let Some(domain_text) = domain.as_str() else {
                    continue;
                };
                if !action_text.contains(domain_text) {
                    continue;
                }
                out["requires_approval"] = Value::Bool(true);
                out["approval_reason"] = Value::String(format!(
                    "High-stakes domain '{}' requires approval",
                    domain_text
                ));
                break;
            }
        }
    }

    if let Some(command_text) = envelope
        .get("metadata")
        .and_then(|value| value.get("command_text"))
        .and_then(Value::as_str)
    {
        if irreversible_pattern(command_text).is_some()
            && !out
                .get("requires_approval")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            out["requires_approval"] = Value::Bool(true);
            out["approval_reason"] = Value::String(format!(
                "Irreversible action detected: {}",
                irreversible_pattern(command_text).unwrap_or("unknown")
            ));
        }
    }

    if approval_required_by_default(&action_type)
        && !out
            .get("requires_approval")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        out["requires_approval"] = Value::Bool(true);
        out["approval_reason"] = Value::String(format!(
            "Action type '{}' requires approval per T0 invariants",
            action_type
        ));
    }

    if risk == "high" && tier < 2 {
        out["requires_approval"] = Value::Bool(true);
        out["approval_reason"] =
            Value::String("High-risk action at Tier < 2 requires approval".to_string());
    }

    Ok(out)
}

fn check_tier_conflict(lower_tier_action: &Value, higher_tier_directive: &Value) -> Value {
    let lower_tier = lower_tier_action
        .get("tier")
        .and_then(Value::as_i64)
        .unwrap_or(2);
    let higher_tier = higher_tier_directive
        .get("tier")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if lower_tier > higher_tier {
        return json!({
            "is_conflict": true,
            "reason": format!(
                "Tier {} action attempted to override Tier {} directive",
                lower_tier,
                higher_tier
            ),
            "resolution": "Lower tier wins"
        });
    }
    json!({"is_conflict": false})
}

fn legacy_source_paths(root: &Path) -> Vec<PathBuf> {
    vec![
        root.join("docs")
            .join("workspace")
            .join("AGENT-CONSTITUTION.md"),
        root.join("docs")
            .join("client")
            .join("PROTHEUS_PRIME_SEED.md"),
        root.join("docs")
            .join("client")
            .join("internal")
            .join("persona")
            .join("AGENT-CONSTITUTION.md"),
    ]
}

fn default_vault() -> Value {
    json!({
        "version": "1.0",
        "prime": [],
        "derived": [],
        "chain_head": "genesis",
        "created_at": now_iso(),
        "migrations": []
    })
}

fn load_vault(root: &Path) -> Value {
    read_json(&vault_path(root)).unwrap_or_else(default_vault)
}

fn write_vault(root: &Path, vault: &Value) -> Result<(), String> {
    write_json(&vault_path(root), vault)
}

fn vault_obj_mut(vault: &mut Value) -> &mut Map<String, Value> {
    if !vault.is_object() {
        *vault = default_vault();
    }
    vault.as_object_mut().expect("vault_object")
}

fn ensure_array<'a>(obj: &'a mut Map<String, Value>, key: &str) -> &'a mut Vec<Value> {
    if !obj.get(key).map(Value::is_array).unwrap_or(false) {
        obj.insert(key.to_string(), Value::Array(Vec::new()));
    }
    obj.get_mut(key)
        .and_then(Value::as_array_mut)
        .expect("array")
}

fn normalize_rule(raw: &str) -> (String, String) {
    let cleaned = clean(raw, 512).to_ascii_lowercase();
    if let Some(v) = cleaned.strip_prefix("deny:") {
        return ("deny".to_string(), clean(v, 320));
    }
    if let Some(v) = cleaned.strip_prefix("allow:") {
        return ("allow".to_string(), clean(v, 320));
    }
    if cleaned.contains("deny") {
        ("deny".to_string(), cleaned)
    } else {
        ("allow".to_string(), cleaned)
    }
}

fn matches_pattern(action: &str, pattern: &str) -> bool {
    if pattern.is_empty() || pattern == "*" || pattern == "all" {
        return true;
    }
    if pattern.contains('*') {
        let parts = pattern
            .split('*')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>();
        if parts.is_empty() {
            return true;
        }
        return parts.iter().all(|part| action.contains(part));
    }
    action.contains(pattern)
}

fn signature_for_entry(entry: &Value) -> String {
    let payload = canonical_signature_payload(entry);
    let key = std::env::var(SIGNING_ENV).unwrap_or_default();
    if key.trim().is_empty() {
        // still deterministic, but marked as unsigned in policy metadata.
        return format!(
            "unsigned:{}",
            sha256_hex_str(&serde_json::to_string(&payload).unwrap_or_default())
        );
    }
    format!("sig:{}", keyed_digest_hex(&key, &payload))
}

fn canonical_signature_payload(entry: &Value) -> Value {
    json!({
        "id": entry.get("id").cloned().unwrap_or(Value::Null),
        "directive": entry.get("directive").cloned().unwrap_or(Value::Null),
        "rule_kind": entry.get("rule_kind").cloned().unwrap_or(Value::Null),
        "rule_pattern": entry.get("rule_pattern").cloned().unwrap_or(Value::Null),
        "signer": entry.get("signer").cloned().unwrap_or(Value::Null),
        "source": entry.get("source").cloned().unwrap_or(Value::Null),
        "parent_id": entry.get("parent_id").cloned().unwrap_or(Value::Null),
        "supersedes": entry.get("supersedes").cloned().unwrap_or(Value::Null),
        "ts": entry.get("ts").cloned().unwrap_or(Value::Null),
        "prev_hash": entry.get("prev_hash").cloned().unwrap_or(Value::Null)
    })
}

fn verify_entry_signature(entry: &Value) -> bool {
    let signature = entry
        .get("signature")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if signature.is_empty() {
        return false;
    }

    let payload = canonical_signature_payload(entry);
    if let Some(raw) = signature.strip_prefix("unsigned:") {
        return raw.eq_ignore_ascii_case(&sha256_hex_str(
            &serde_json::to_string(&payload).unwrap_or_default(),
        ));
    }
    if let Some(raw) = signature.strip_prefix("sig:") {
        let key = std::env::var(SIGNING_ENV).unwrap_or_default();
        if key.trim().is_empty() {
            return false;
        }
        return raw.eq_ignore_ascii_case(&keyed_digest_hex(&key, &payload));
    }
    false
}

fn is_structured_directive_entry(entry: &Value) -> bool {
    let Some(obj) = entry.as_object() else {
        return false;
    };
    let required = [
        "id",
        "directive",
        "rule_kind",
        "rule_pattern",
        "signer",
        "source",
        "prev_hash",
        "signature",
        "entry_hash",
        "ts",
    ];
    required.iter().all(|key| {
        obj.get(*key)
            .and_then(Value::as_str)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
    })
}

fn signature_counts(vault: &Value) -> (u64, u64) {
    let rows = collect_rules(vault);
    let total = rows.len() as u64;
    let valid = rows
        .iter()
        .filter(|row| verify_entry_signature(row))
        .count() as u64;
    (total, valid)
}

fn signing_key_present() -> bool {
    std::env::var(SIGNING_ENV)
        .ok()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

fn append_directive_entry(
    root: &Path,
    bucket: &str,
    directive_text: &str,
    signer: &str,
    parent_id: Option<&str>,
    supersedes: Option<&str>,
    source: &str,
) -> Result<Value, String> {
    let mut vault = load_vault(root);
    let obj = vault_obj_mut(&mut vault);
    let chain_head = obj
        .get("chain_head")
        .and_then(Value::as_str)
        .unwrap_or("genesis")
        .to_string();
    let (rule_kind, rule_pattern) = normalize_rule(directive_text);

    let mut payload = json!({
        "id": format!("dir_{}", &sha256_hex_str(&format!("{}:{}:{}", now_iso(), directive_text, signer))[..16]),
        "directive": clean(directive_text, 512),
        "rule_kind": rule_kind,
        "rule_pattern": rule_pattern,
        "signer": clean(signer, 128),
        "source": clean(source, 128),
        "parent_id": parent_id.unwrap_or(""),
        "supersedes": supersedes.unwrap_or(""),
        "accepted": true,
        "ts": now_iso(),
        "prev_hash": chain_head
    });
    let signature = signature_for_entry(&payload);
    payload["signature"] = Value::String(signature);
    let entry_hash = sha256_hex_str(&serde_json::to_string(&payload).unwrap_or_default());
    payload["entry_hash"] = Value::String(entry_hash.clone());

    let list = ensure_array(obj, bucket);
    list.push(payload.clone());
    obj.insert("chain_head".to_string(), Value::String(entry_hash));

    write_vault(root, &vault)?;
    Ok(payload)
}

pub(crate) fn append_compaction_directive_entry(
    root: &Path,
    directive_text: &str,
    signer: &str,
    parent_id: Option<&str>,
    source: &str,
) -> Result<Value, String> {
    append_directive_entry(
        root,
        "derived",
        directive_text,
        signer,
        parent_id,
        None,
        source,
    )
}

fn prime_rows(vault: &Value) -> Vec<Value> {
    vault
        .get("prime")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn derived_rows(vault: &Value) -> Vec<Value> {
    vault
        .get("derived")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn is_entry_active(entry: &Value) -> bool {
    entry
        .get("accepted")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn collect_rules(vault: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for row in prime_rows(vault) {
        if is_entry_active(&row) && is_structured_directive_entry(&row) {
            out.push(row);
        }
    }
    for row in derived_rows(vault) {
        if is_entry_active(&row) && is_structured_directive_entry(&row) {
            out.push(row);
        }
    }
    out
}

pub fn directive_vault_hash(root: &Path) -> String {
    let vault = load_vault(root);
    sha256_hex_str(&serde_json::to_string(&vault).unwrap_or_default())
}

fn canonical_entry_for_hash(entry: &Value) -> Value {
    let mut canonical = entry.clone();
    if let Some(obj) = canonical.as_object_mut() {
        obj.remove("entry_hash");
    }
    canonical
}

fn recompute_entry_hash(entry: &Value) -> String {
    sha256_hex_str(&serde_json::to_string(&canonical_entry_for_hash(entry)).unwrap_or_default())
}

pub fn directive_vault_integrity(root: &Path) -> Value {
    let vault = load_vault(root);
    let mut raw_rows = prime_rows(&vault);
    raw_rows.extend(derived_rows(&vault));
    let raw_entry_count = raw_rows.len() as u64;
    let mut rows = Vec::new();
    let mut ignored_legacy_entry_count = 0u64;
    for row in raw_rows {
        if is_structured_directive_entry(&row) {
            rows.push(row);
        } else {
            ignored_legacy_entry_count += 1;
        }
    }
    let entry_count = rows.len() as u64;
    let chain_head = vault
        .get("chain_head")
        .and_then(Value::as_str)
        .unwrap_or("genesis")
        .to_string();

    let mut signature_valid_count = 0u64;
    let mut hash_valid_count = 0u64;
    let mut errors: Vec<String> = Vec::new();
    let mut by_hash: HashMap<String, Value> = HashMap::new();
    for (idx, row) in rows.iter().enumerate() {
        if verify_entry_signature(row) {
            signature_valid_count += 1;
        } else {
            errors.push(format!("signature_invalid_at:{idx}"));
        }
        let actual = row
            .get("entry_hash")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let expected = recompute_entry_hash(row);
        if !actual.is_empty() && actual.eq_ignore_ascii_case(&expected) {
            hash_valid_count += 1;
            if by_hash.insert(actual.clone(), row.clone()).is_some() {
                errors.push(format!("duplicate_entry_hash:{actual}"));
            }
        } else {
            errors.push(format!("entry_hash_mismatch_at:{idx}"));
        }
    }

    let mut chain_valid = true;
    let mut traversed_count = 0u64;
    if entry_count == 0 {
        if chain_head != "genesis" {
            chain_valid = false;
            errors.push("non_genesis_chain_head_for_empty_vault".to_string());
        }
    } else if chain_head == "genesis" {
        chain_valid = false;
        errors.push("missing_chain_head".to_string());
    } else {
        let mut cursor = chain_head.clone();
        let mut visited = HashSet::new();
        loop {
            if cursor == "genesis" {
                break;
            }
            if !visited.insert(cursor.clone()) {
                chain_valid = false;
                errors.push("chain_cycle_detected".to_string());
                break;
            }
            let Some(row) = by_hash.get(&cursor) else {
                chain_valid = false;
                errors.push(format!("chain_head_missing_entry:{cursor}"));
                break;
            };
            traversed_count += 1;
            cursor = row
                .get("prev_hash")
                .and_then(Value::as_str)
                .unwrap_or("genesis")
                .to_string();
        }
        if traversed_count != entry_count {
            chain_valid = false;
            errors.push(format!(
                "chain_length_mismatch:traversed={traversed_count}:entries={entry_count}"
            ));
        }
    }

    json!({
        "ok": entry_count == signature_valid_count && entry_count == hash_valid_count && chain_valid,
        "raw_entry_count": raw_entry_count,
        "entry_count": entry_count,
        "ignored_legacy_entry_count": ignored_legacy_entry_count,
        "signature_valid_count": signature_valid_count,
        "hash_valid_count": hash_valid_count,
        "chain_valid": chain_valid,
        "chain_head": chain_head,
        "errors": errors
    })
}

pub fn evaluate_action(root: &Path, action: &str) -> Value {
    let vault = load_vault(root);
    let integrity = directive_vault_integrity(root);
    if !integrity
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return json!({
            "allowed": false,
            "action": clean(action, 320).to_ascii_lowercase(),
            "deny_hits": [{"id":"integrity", "rule_kind":"deny", "rule_pattern":"vault_integrity"}],
            "allow_hits": [],
            "invalid_signature_hits": [],
            "superseded_ids": [],
            "integrity": integrity,
            "policy_hash": directive_vault_hash(root)
        });
    }
    let action_norm = clean(action, 320).to_ascii_lowercase();
    let rules = collect_rules(&vault);
    let mut superseded_ids = HashSet::new();
    for row in &rules {
        if !verify_entry_signature(row) {
            continue;
        }
        let supersedes = row
            .get("supersedes")
            .and_then(Value::as_str)
            .map(|v| clean(v, 128))
            .unwrap_or_default();
        if !supersedes.is_empty() {
            superseded_ids.insert(supersedes);
        }
    }

    let mut deny_hits = Vec::new();
    let mut allow_hits = Vec::new();
    let mut invalid_signature_hits = Vec::new();
    for row in rules {
        let row_id = row
            .get("id")
            .and_then(Value::as_str)
            .map(|v| clean(v, 128))
            .unwrap_or_default();
        if !row_id.is_empty() && superseded_ids.contains(&row_id) {
            continue;
        }
        if !verify_entry_signature(&row) {
            invalid_signature_hits.push(json!({
                "id": row.get("id").cloned().unwrap_or(Value::Null),
                "signer": row.get("signer").cloned().unwrap_or(Value::Null),
                "reason": "invalid_signature"
            }));
            continue;
        }
        let kind = row
            .get("rule_kind")
            .and_then(Value::as_str)
            .unwrap_or("allow")
            .to_ascii_lowercase();
        let pattern = row
            .get("rule_pattern")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches_pattern(&action_norm, &pattern) {
            continue;
        }
        let hit = json!({
            "id": row.get("id").cloned().unwrap_or(Value::Null),
            "rule_kind": kind,
            "rule_pattern": pattern,
            "signer": row.get("signer").cloned().unwrap_or(Value::Null)
        });
        if kind == "deny" {
            deny_hits.push(hit);
        } else {
            allow_hits.push(hit);
        }
    }

    let allowed = deny_hits.is_empty() && !allow_hits.is_empty();
    json!({
        "allowed": allowed,
        "action": action_norm,
        "deny_hits": deny_hits,
        "allow_hits": allow_hits,
        "invalid_signature_hits": invalid_signature_hits,
        "superseded_ids": superseded_ids.into_iter().collect::<Vec<_>>(),
        "integrity": integrity,
        "policy_hash": directive_vault_hash(root)
    })
}

pub fn action_allowed(root: &Path, action: &str) -> bool {
    evaluate_action(root, action)
        .get("allowed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn resolve_parent(vault: &Value, parent_hint: &str) -> Option<Value> {
    let norm = clean(parent_hint, 512);
    if norm.is_empty() {
        return None;
    }
    let mut rows = prime_rows(vault);
    rows.extend(derived_rows(vault));
    rows.into_iter().find(|row| {
        row.get("id")
            .and_then(Value::as_str)
            .map(|id| id == norm)
            .unwrap_or(false)
            || row
                .get("directive")
                .and_then(Value::as_str)
                .map(|text| text == norm)
                .unwrap_or(false)
    })
}

fn has_inheritance_conflict(parent: &Value, child_rule_kind: &str, child_pattern: &str) -> bool {
    let parent_kind = parent
        .get("rule_kind")
        .and_then(Value::as_str)
        .unwrap_or("allow")
        .to_ascii_lowercase();
    let parent_pattern = parent
        .get("rule_pattern")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();

    if parent_kind != "deny" || child_rule_kind != "allow" {
        return false;
    }
    child_pattern == parent_pattern
        || matches_pattern(child_pattern, &parent_pattern)
        || matches_pattern(&parent_pattern, child_pattern)
}

fn migrate_legacy_markdown(root: &Path, apply: bool) -> Result<Value, String> {
    let mut harvested = Vec::new();
    for path in legacy_source_paths(root) {
        if !path.exists() {
            continue;
        }
        let raw = fs::read_to_string(&path)
            .map_err(|err| format!("legacy_directive_read_failed:{}:{err}", path.display()))?;
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.starts_with('#') {
                continue;
            }
            if trimmed.starts_with("-") || trimmed.starts_with('*') {
                let cleaned = trimmed
                    .trim_start_matches('-')
                    .trim_start_matches('*')
                    .trim();
                if !cleaned.is_empty() {
                    harvested.push(clean(cleaned, 512));
                }
            }
        }
    }

    harvested.sort();
    harvested.dedup();

    let mut imported = Vec::new();
    if apply {
        for directive in &harvested {
            let entry = append_directive_entry(
                root,
                "prime",
                directive,
                "migration",
                None,
                None,
                "legacy_markdown",
            )?;
            imported.push(entry);
        }

        let mut vault = load_vault(root);
        let obj = vault_obj_mut(&mut vault);
        let migrations = ensure_array(obj, "migrations");
        migrations.push(json!({
            "ts": now_iso(),
            "type": "legacy_markdown_import",
            "count": harvested.len()
        }));
        write_vault(root, &vault)?;
    }

    Ok(json!({
        "harvested_count": harvested.len(),
        "imported_count": imported.len(),
        "legacy_paths": legacy_source_paths(root)
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
    }))
}

fn collect_structured_chain_entries(vault: &Value) -> Result<Vec<Value>, String> {
    let mut rows = prime_rows(vault);
    rows.extend(derived_rows(vault));
    let chain_head = vault
        .get("chain_head")
        .and_then(Value::as_str)
        .unwrap_or("genesis")
        .to_string();
    let mut by_hash: HashMap<String, Value> = HashMap::new();
    for row in rows {
        if !is_structured_directive_entry(&row) {
            continue;
        }
        let actual = row
            .get("entry_hash")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let expected = recompute_entry_hash(&row);
        if actual.is_empty() || !actual.eq_ignore_ascii_case(&expected) {
            return Err("repair_entry_hash_invalid".to_string());
        }
        by_hash.insert(actual, row);
    }

    if by_hash.is_empty() {
        return Ok(Vec::new());
    }
    if chain_head == "genesis" {
        return Err("repair_missing_chain_head".to_string());
    }

    let mut cursor = chain_head;
    let mut visited = HashSet::new();
    let mut ordered = Vec::new();
    loop {
        if cursor == "genesis" {
            break;
        }
        if !visited.insert(cursor.clone()) {
            return Err("repair_chain_cycle_detected".to_string());
        }
        let Some(row) = by_hash.get(&cursor) else {
            return Err("repair_chain_head_missing_entry".to_string());
        };
        ordered.push(row.clone());
        cursor = row
            .get("prev_hash")
            .and_then(Value::as_str)
            .unwrap_or("genesis")
            .to_string();
    }

    if ordered.len() != by_hash.len() {
        return Err("repair_chain_length_mismatch".to_string());
    }
    ordered.reverse();
    Ok(ordered)
}

fn repair_vault_signatures(
    root: &Path,
    apply: bool,
    allow_unsigned: bool,
) -> Result<Value, String> {
    let key_present = signing_key_present();
    if !key_present && !allow_unsigned {
        return Err("missing_signing_key".to_string());
    }

    let mut vault = load_vault(root);
    let ordered = collect_structured_chain_entries(&vault)?;
    let mode = if key_present { "keyed" } else { "unsigned" };

    if !apply {
        return Ok(json!({
            "apply": false,
            "mode": mode,
            "key_present": key_present,
            "eligible_entries": ordered.len()
        }));
    }

    let mut replacement_by_id: HashMap<String, Value> = HashMap::new();
    let mut prev_hash = "genesis".to_string();
    for row in ordered {
        let mut updated = row.clone();
        updated["prev_hash"] = Value::String(prev_hash.clone());
        updated["signature"] = Value::String(signature_for_entry(&updated));
        let entry_hash = recompute_entry_hash(&updated);
        updated["entry_hash"] = Value::String(entry_hash.clone());
        prev_hash = entry_hash;

        let id = updated
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "repair_entry_id_missing".to_string())?
            .to_string();
        replacement_by_id.insert(id, updated);
    }

    let obj = vault_obj_mut(&mut vault);
    for bucket in ["prime", "derived"] {
        let rows = ensure_array(obj, bucket);
        for row in rows.iter_mut() {
            if !is_structured_directive_entry(row) {
                continue;
            }
            let Some(id) = row.get("id").and_then(Value::as_str) else {
                continue;
            };
            if let Some(replacement) = replacement_by_id.get(id) {
                *row = replacement.clone();
            }
        }
    }
    obj.insert("chain_head".to_string(), Value::String(prev_hash.clone()));
    write_vault(root, &vault)?;

    Ok(json!({
        "apply": true,
        "mode": mode,
        "key_present": key_present,
        "repaired_entries": replacement_by_id.len(),
        "new_chain_head": prev_hash
    }))
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    directive_kernel_run::run(root, argv)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        crate::test_env_guard()
    }

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("protheus_directive_kernel_{name}_{nonce}"));
        fs::create_dir_all(&root).expect("mkdir");
        root
    }

    fn write_active_directive_fixture(root: &Path) {
        let directives = directives_dir(root);
        fs::create_dir_all(&directives).expect("directive fixture dir");
        fs::write(
            directives.join("ACTIVE.yaml"),
            r#"
metadata:
  last_updated: "2026-03-17"
active_directives:
  - id: T0_invariants
    tier: 0
    status: active
  - id: T1_build_sovereign_capital_v1
    tier: 1
    status: active
"#,
        )
        .expect("write active");
        fs::write(
            directives.join("T0_invariants.yaml"),
            r#"
metadata:
  id: T0_invariants
  tier: 0
hard_blocks:
  - rule: secret_redaction
    description: Secrets must always be redacted
approval_required:
  - rule: irreversible_actions
    description: No irreversible actions without explicit approval
high_stakes_domains:
  - domain: finance
    escalation_required: true
"#,
        )
        .expect("write t0");
        fs::write(
            directives.join("T1_build_sovereign_capital_v1.yaml"),
            r#"
metadata:
  id: T1_build_sovereign_capital_v1
  tier: 1
intent:
  primary: "Generate wealth through scalable, automated systems"
  definitions:
    timeframe_years: 5
constraints:
  risk_limits:
    max_drawdown_pct: 10
success_metrics:
  leading:
    - "Monthly recurring revenue growth rate"
  lagging:
    - "Net worth progression"
scope:
  included:
    - "Income-generating automation"
  excluded:
    - "Pure consumption"
approval_policy:
  additional_gates:
    - "Impact on 5-year trajectory"
"#,
        )
        .expect("write t1");
    }

    #[test]
    fn derive_requires_parent_prime_rule() {
        let _guard = env_guard();
        std::env::set_var(SIGNING_ENV, "test-signing-key");
        let root = temp_root("derive");
        let fail = run(
            &root,
            &[
                "derive".to_string(),
                "--parent=missing".to_string(),
                "--directive=allow:child".to_string(),
                "--allow-unsigned=1".to_string(),
            ],
        );
        assert_eq!(fail, 2);

        let ok_prime = run(
            &root,
            &[
                "prime-sign".to_string(),
                "--directive=allow:missing".to_string(),
                "--signer=operator".to_string(),
                "--allow-unsigned=1".to_string(),
            ],
        );
        assert_eq!(ok_prime, 0);

        let pass = run(
            &root,
            &[
                "derive".to_string(),
                "--parent=allow:missing".to_string(),
                "--directive=allow:child".to_string(),
                "--allow-unsigned=1".to_string(),
            ],
        );
        assert_eq!(pass, 0);

        let eval = evaluate_action(&root, "child");
        assert_eq!(eval.get("allowed").and_then(Value::as_bool), Some(true));

        std::env::remove_var(SIGNING_ENV);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tampered_signature_is_rejected_by_compliance_gate() {
        let _guard = env_guard();
        std::env::set_var(SIGNING_ENV, "test-signing-key");
        let root = temp_root("signature_tamper");
        assert_eq!(
            run(
                &root,
                &[
                    "prime-sign".to_string(),
                    "--directive=allow:graph:pagerank".to_string(),
                    "--signer=tester".to_string(),
                ],
            ),
            0
        );

        let mut vault = load_vault(&root);
        if let Some(rows) = vault.get_mut("prime").and_then(Value::as_array_mut) {
            if let Some(first) = rows.first_mut() {
                first["signature"] = Value::String("sig:tampered".to_string());
            }
        }
        write_vault(&root, &vault).expect("write vault");

        let eval = evaluate_action(&root, "graph:pagerank");
        assert_eq!(eval.get("allowed").and_then(Value::as_bool), Some(false));
        assert_eq!(
            eval.get("integrity")
                .and_then(|v| v.get("ok"))
                .and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            eval.get("integrity")
                .and_then(|v| v.get("errors"))
                .and_then(Value::as_array)
                .map(|rows| rows
                    .iter()
                    .any(|row| row.as_str().unwrap_or("").contains("signature_invalid"))),
            Some(true)
        );

        std::env::remove_var(SIGNING_ENV);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_placeholder_entries_are_ignored_by_integrity_gate() {
        let _guard = env_guard();
        std::env::set_var(SIGNING_ENV, "test-signing-key");
        let root = temp_root("legacy_placeholder_integrity");
        assert_eq!(
            run(
                &root,
                &[
                    "prime-sign".to_string(),
                    "--directive=allow:blob:status".to_string(),
                    "--signer=tester".to_string(),
                    "--allow-unsigned=1".to_string(),
                ],
            ),
            0
        );

        let mut vault = load_vault(&root);
        if let Some(rows) = vault.get_mut("prime").and_then(Value::as_array_mut) {
            rows.insert(
                0,
                json!({
                    "directive": "Protect operator intent",
                    "signer": "tester",
                    "supersedes_previous": true,
                    "ts": now_iso()
                }),
            );
        }
        write_vault(&root, &vault).expect("write vault");

        let integrity = directive_vault_integrity(&root);
        assert_eq!(integrity.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            integrity
                .get("ignored_legacy_entry_count")
                .and_then(Value::as_u64),
            Some(1)
        );

        let eval = evaluate_action(&root, "blob:status");
        assert_eq!(eval.get("allowed").and_then(Value::as_bool), Some(true));

        std::env::remove_var(SIGNING_ENV);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn derive_rejects_wildcard_inheritance_conflicts() {
        let _guard = env_guard();
        std::env::set_var(SIGNING_ENV, "test-signing-key");
        let root = temp_root("derive_wildcard_conflict");
        assert_eq!(
            run(
                &root,
                &[
                    "prime-sign".to_string(),
                    "--directive=deny:rsi:*".to_string(),
                    "--signer=operator".to_string(),
                    "--allow-unsigned=1".to_string(),
                ],
            ),
            0
        );
        assert_eq!(
            run(
                &root,
                &[
                    "derive".to_string(),
                    "--parent=deny:rsi:*".to_string(),
                    "--directive=allow:rsi:ignite:conduit".to_string(),
                    "--signer=system".to_string(),
                    "--allow-unsigned=1".to_string(),
                ],
            ),
            2
        );
        let eval = evaluate_action(&root, "rsi:ignite:conduit");
        assert_eq!(eval.get("allowed").and_then(Value::as_bool), Some(false));
        std::env::remove_var(SIGNING_ENV);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn signature_repair_rebuilds_chain_when_key_is_missing() {
        let _guard = env_guard();
        std::env::set_var(SIGNING_ENV, "orig-key");
        let root = temp_root("signature_repair_missing_key");
        assert_eq!(
            run(
                &root,
                &[
                    "prime-sign".to_string(),
                    "--directive=allow:blob:status".to_string(),
                    "--signer=tester".to_string(),
                    "--allow-unsigned=1".to_string(),
                ],
            ),
            0
        );
        assert_eq!(
            run(
                &root,
                &[
                    "prime-sign".to_string(),
                    "--directive=allow:credits:workspace-view".to_string(),
                    "--signer=tester".to_string(),
                    "--allow-unsigned=1".to_string(),
                ],
            ),
            0
        );

        std::env::remove_var(SIGNING_ENV);
        let before = directive_vault_integrity(&root);
        assert_eq!(before.get("ok").and_then(Value::as_bool), Some(false));

        let repair = repair_vault_signatures(&root, true, true).expect("repair signatures");
        assert_eq!(repair.get("apply").and_then(Value::as_bool), Some(true));
        assert_eq!(
            repair.get("repaired_entries").and_then(Value::as_u64),
            Some(2)
        );

        let after = directive_vault_integrity(&root);
        assert_eq!(after.get("ok").and_then(Value::as_bool), Some(true));

        let vault = load_vault(&root);
        let first_sig = vault
            .get("prime")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(|row| row.get("signature"))
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(first_sig.starts_with("unsigned:"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn signed_supersession_disables_targeted_rule_without_inplace_mutation() {
        let _guard = env_guard();
        std::env::set_var(SIGNING_ENV, "test-signing-key");
        let root = temp_root("supersession");
        assert_eq!(
            run(
                &root,
                &[
                    "prime-sign".to_string(),
                    "--directive=allow:blob:settle:demo".to_string(),
                    "--signer=operator".to_string(),
                ],
            ),
            0
        );
        let before = load_vault(&root);
        let before_id = before
            .get("prime")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(|row| row.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let before_hash = before
            .get("prime")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(|row| row.get("entry_hash"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        let before_eval = evaluate_action(&root, "blob:settle:demo");
        assert_eq!(
            before_eval.get("allowed").and_then(Value::as_bool),
            Some(true)
        );

        assert_eq!(
            run(
                &root,
                &[
                    "supersede".to_string(),
                    "--target=allow:blob:settle:demo".to_string(),
                    "--directive=deny:blob:settle:demo".to_string(),
                    "--signer=operator".to_string(),
                ],
            ),
            0
        );
        let after_eval = evaluate_action(&root, "blob:settle:demo");
        assert_eq!(
            after_eval.get("allowed").and_then(Value::as_bool),
            Some(false)
        );

        let after = load_vault(&root);
        let after_hash = after
            .get("prime")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(|row| row.get("entry_hash"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        assert_eq!(before_hash, after_hash);
        assert_eq!(
            after_eval
                .get("superseded_ids")
                .and_then(Value::as_array)
                .map(|rows| rows
                    .iter()
                    .any(|row| row.as_str() == Some(before_id.as_str()))),
            Some(true)
        );

        std::env::remove_var(SIGNING_ENV);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn active_directive_loader_and_merge_constraints_work() {
        let root = temp_root("active_directives");
        write_active_directive_fixture(&root);

        let directives =
            load_active_directives(&root, false, false).expect("load active directives");
        assert_eq!(directives.len(), 2);

        let merged = merge_active_constraints(&directives);
        assert_eq!(
            merged
                .get("hard_blocks")
                .and_then(Value::as_array)
                .map(|rows| rows.len()),
            Some(1)
        );
        assert_eq!(
            merged
                .get("approval_required")
                .and_then(Value::as_array)
                .map(|rows| rows.len()),
            Some(1)
        );
        assert_eq!(
            merged
                .get("high_stakes_domains")
                .and_then(Value::as_array)
                .map(|rows| rows.iter().any(|row| row.as_str() == Some("finance"))),
            Some(true)
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn validate_action_envelope_fails_closed_for_secrets_and_requires_approval_for_irreversible() {
        let root = temp_root("validate_action_envelope");
        write_active_directive_fixture(&root);

        let blocked = validate_action_envelope(
            &root,
            &json!({
                "action_id": "act_secret",
                "tier": 2,
                "type": "other",
                "summary": "Inspect payload",
                "risk": "low",
                "payload": {
                    "token": "moltbook_sk_1234567890123456789012345"
                }
            }),
        )
        .expect("blocked result");
        assert_eq!(blocked.get("allowed").and_then(Value::as_bool), Some(false));
        assert_eq!(
            blocked
                .get("blocked_reason")
                .and_then(Value::as_str)
                .map(|text| text.contains("Secrets must always be redacted")),
            Some(true)
        );

        let approval = validate_action_envelope(
            &root,
            &json!({
                "action_id": "act_rm",
                "tier": 2,
                "type": "other",
                "summary": "cleanup deployment",
                "risk": "low",
                "payload": {},
                "metadata": {
                    "command_text": "rm -rf /tmp/demo"
                }
            }),
        )
        .expect("approval result");
        assert_eq!(
            approval.get("requires_approval").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(approval.get("allowed").and_then(Value::as_bool), Some(true));

        let _ = fs::remove_dir_all(root);
    }
}
