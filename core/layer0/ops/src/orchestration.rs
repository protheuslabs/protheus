// SPDX-License-Identifier: Apache-2.0
use crate::{now_iso, parse_args};
use chrono::{Datelike, Timelike, Utc};
use rand::RngCore;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const SCRATCHPAD_SCHEMA_VERSION: &str = "scratchpad/v1";
const TASKGROUP_SCHEMA_VERSION: &str = "taskgroup/v1";
const ITEM_INTERVAL: i64 = 10;
const TIME_INTERVAL_MS: i64 = 120_000;
const MAX_AUTO_RETRIES: i64 = 1;

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops orchestration invoke --op=<operation> [--payload-json=<json>]");
    println!("  protheus-ops orchestration help");
}

fn to_clean_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(v) => v.to_string().trim().to_string(),
        None => String::new(),
    }
}

fn get_string_any(payload: &Value, keys: &[&str]) -> String {
    keys.iter()
        .map(|key| to_clean_string(payload.get(*key)))
        .find(|v| !v.is_empty())
        .unwrap_or_default()
}

fn payload_root_dir(payload: &Value) -> Option<String> {
    let root_dir = get_string_any(payload, &["root_dir", "rootDir"]);
    if root_dir.is_empty() {
        None
    } else {
        Some(root_dir)
    }
}

fn get_i64_any(payload: &Value, keys: &[&str], default: i64) -> i64 {
    for key in keys {
        if let Some(value) = payload.get(*key) {
            let out = match value {
                Value::Number(num) => num.as_i64().or_else(|| num.as_u64().map(|v| v as i64)),
                Value::String(text) => text.trim().parse::<i64>().ok(),
                _ => None,
            };
            if let Some(parsed) = out {
                return parsed;
            }
        }
    }
    default
}

fn get_object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

#[derive(Clone, Copy)]
enum FirstByteRule {
    AlphaNum,
    LowerOrDigit,
}

fn validate_identifier(value: &str, min_len: usize, max_len: usize, first_rule: FirstByteRule) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < min_len || bytes.len() > max_len {
        return false;
    }
    let first = bytes[0] as char;
    let first_ok = match first_rule {
        FirstByteRule::AlphaNum => first.is_ascii_alphanumeric(),
        FirstByteRule::LowerOrDigit => first.is_ascii_lowercase() || first.is_ascii_digit(),
    };
    if !first_ok {
        return false;
    }
    bytes.iter().all(|b| {
        let ch = *b as char;
        match first_rule {
            FirstByteRule::AlphaNum => ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'),
            FirstByteRule::LowerOrDigit => {
                ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | ':' | '-')
            }
        }
    })
}

fn is_valid_task_id(task_id: &str) -> bool {
    validate_identifier(task_id, 3, 128, FirstByteRule::AlphaNum)
}

fn validate_group_id(task_group_id: &str) -> bool {
    validate_identifier(task_group_id, 6, 128, FirstByteRule::LowerOrDigit)
}

fn validate_agent_id(agent_id: &str) -> bool {
    validate_identifier(agent_id, 2, 128, FirstByteRule::AlphaNum)
}

fn default_scratchpad_dir(root: &Path) -> PathBuf {
    root.join("local").join("workspace").join("scratchpad")
}

fn default_taskgroup_dir(root: &Path) -> PathBuf {
    default_scratchpad_dir(root).join("taskgroups")
}

fn scratchpad_path(root: &Path, task_id: &str, root_dir: Option<&str>) -> Result<PathBuf, String> {
    if !is_valid_task_id(task_id) {
        return Err(format!("invalid_task_id:{}", if task_id.is_empty() { "<empty>" } else { task_id }));
    }
    let base = root_dir
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| default_scratchpad_dir(root));
    Ok(base.join(format!("{task_id}.json")))
}

fn taskgroup_path(root: &Path, task_group_id: &str, root_dir: Option<&str>) -> Result<PathBuf, String> {
    let normalized = task_group_id.trim().to_ascii_lowercase();
    if !validate_group_id(&normalized) {
        return Err(format!(
            "invalid_task_group_id:{}",
            if task_group_id.trim().is_empty() { "<empty>" } else { task_group_id }
        ));
    }
    let base = root_dir
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| default_taskgroup_dir(root));
    Ok(base.join(format!("{normalized}.json")))
}

fn empty_scratchpad(task_id: &str) -> Value {
    let now = now_iso();
    json!({
        "schema_version": SCRATCHPAD_SCHEMA_VERSION,
        "task_id": task_id,
        "created_at": now,
        "updated_at": now,
        "progress": {
            "processed": 0,
            "total": 0
        },
        "findings": [],
        "checkpoints": []
    })
}

#[derive(Debug, Clone)]
struct LoadedScratchpad {
    scratchpad: Value,
    file_path: PathBuf,
    exists: bool,
}

fn load_scratchpad(root: &Path, task_id: &str, root_dir: Option<&str>) -> Result<LoadedScratchpad, String> {
    let file_path = scratchpad_path(root, task_id, root_dir)?;
    match fs::read_to_string(&file_path) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(parsed @ Value::Object(_)) => Ok(LoadedScratchpad {
                scratchpad: parsed,
                file_path,
                exists: true,
            }),
            _ => Ok(LoadedScratchpad {
                scratchpad: empty_scratchpad(task_id),
                file_path,
                exists: false,
            }),
        },
        Err(_) => Ok(LoadedScratchpad {
            scratchpad: empty_scratchpad(task_id),
            file_path,
            exists: false,
        }),
    }
}

fn merge_objects(base: &Value, patch: &Value) -> Value {
    let mut out = get_object(base);
    if let Value::Object(map) = patch {
        for (k, v) in map {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

fn normalize_progress(progress: Option<&Value>) -> Value {
    let processed = progress
        .and_then(|p| p.get("processed"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let total = progress
        .and_then(|p| p.get("total"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    json!({
        "processed": if processed.is_finite() { processed } else { 0.0 },
        "total": if total.is_finite() { total } else { 0.0 }
    })
}

fn write_scratchpad(root: &Path, task_id: &str, patch: &Value, root_dir: Option<&str>) -> Result<Value, String> {
    let loaded = load_scratchpad(root, task_id, root_dir)?;
    let mut next = merge_objects(&loaded.scratchpad, patch);
    let now = now_iso();
    if let Value::Object(map) = &mut next {
        map.insert(
            "schema_version".to_string(),
            Value::String(SCRATCHPAD_SCHEMA_VERSION.to_string()),
        );
        map.insert("task_id".to_string(), Value::String(task_id.to_string()));
        map.insert("updated_at".to_string(), Value::String(now.clone()));
        if map
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .is_empty()
        {
            map.insert("created_at".to_string(), Value::String(now.clone()));
        }

        let progress = normalize_progress(map.get("progress"));
        map.insert("progress".to_string(), progress);

        if !map.get("findings").map(Value::is_array).unwrap_or(false) {
            map.insert("findings".to_string(), Value::Array(Vec::new()));
        }
        if !map.get("checkpoints").map(Value::is_array).unwrap_or(false) {
            map.insert("checkpoints".to_string(), Value::Array(Vec::new()));
        }
    }

    if let Some(parent) = loaded.file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("scratchpad_create_parent_failed:{}:{err}", parent.display()))?;
    }

    let payload = serde_json::to_string_pretty(&next)
        .map_err(|err| format!("scratchpad_encode_failed:{err}"))?
        + "\n";
    fs::write(&loaded.file_path, payload)
        .map_err(|err| format!("scratchpad_write_failed:{}:{err}", loaded.file_path.display()))?;

    Ok(json!({
        "ok": true,
        "type": "orchestration_scratchpad_write",
        "task_id": task_id,
        "file_path": loaded.file_path,
        "scratchpad": next
    }))
}

fn is_datetime(value: &str) -> bool {
    if value.trim().is_empty() {
        return false;
    }
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

fn severity_order(severity: &str) -> i64 {
    match severity {
        "critical" => 5,
        "high" => 4,
        "medium" => 3,
        "low" => 2,
        "info" => 1,
        _ => 0,
    }
}

fn status_order(status: &str) -> i64 {
    match status {
        "confirmed" => 5,
        "open" => 4,
        "needs-review" => 3,
        "resolved" => 2,
        "dismissed" => 1,
        _ => 0,
    }
}

fn normalize_finding(input: &Value) -> Value {
    let mut out = get_object(input);

    out.insert(
        "audit_id".to_string(),
        Value::String(to_clean_string(input.get("audit_id"))),
    );
    out.insert(
        "item_id".to_string(),
        Value::String(to_clean_string(input.get("item_id"))),
    );
    out.insert(
        "severity".to_string(),
        Value::String(to_clean_string(input.get("severity")).to_ascii_lowercase()),
    );
    out.insert(
        "status".to_string(),
        Value::String(to_clean_string(input.get("status")).to_ascii_lowercase()),
    );
    out.insert(
        "location".to_string(),
        Value::String(to_clean_string(input.get("location"))),
    );

    let timestamp = to_clean_string(input.get("timestamp"));
    out.insert(
        "timestamp".to_string(),
        Value::String(if timestamp.is_empty() { now_iso() } else { timestamp }),
    );

    let mut evidence = Vec::new();
    if let Some(rows) = input.get("evidence").and_then(Value::as_array) {
        for row in rows {
            let mut ev = Map::new();
            ev.insert("type".to_string(), Value::String(to_clean_string(row.get("type"))));
            ev.insert("value".to_string(), Value::String(to_clean_string(row.get("value"))));
            let source = to_clean_string(row.get("source"));
            if !source.is_empty() {
                ev.insert("source".to_string(), Value::String(source));
            }
            evidence.push(Value::Object(ev));
        }
    }
    out.insert("evidence".to_string(), Value::Array(evidence));

    Value::Object(out)
}

fn validate_finding(input: &Value) -> (bool, String) {
    let finding = if input.is_object() { input } else { return (false, "finding_invalid_type".to_string()) };

    for key in [
        "audit_id",
        "item_id",
        "severity",
        "status",
        "location",
        "evidence",
        "timestamp",
    ] {
        if finding.get(key).is_none() {
            return (false, format!("finding_missing_{key}"));
        }
    }

    let severity = to_clean_string(finding.get("severity")).to_ascii_lowercase();
    if severity_order(&severity) == 0 {
        return (false, "finding_invalid_severity".to_string());
    }

    let status = to_clean_string(finding.get("status")).to_ascii_lowercase();
    if status_order(&status) == 0 {
        return (false, "finding_invalid_status".to_string());
    }

    if to_clean_string(finding.get("audit_id")).is_empty() {
        return (false, "finding_invalid_audit_id".to_string());
    }
    if to_clean_string(finding.get("item_id")).is_empty() {
        return (false, "finding_invalid_item_id".to_string());
    }
    if to_clean_string(finding.get("location")).is_empty() {
        return (false, "finding_invalid_location".to_string());
    }

    let evidence = finding.get("evidence").and_then(Value::as_array);
    if evidence.map(|rows| rows.is_empty()).unwrap_or(true) {
        return (false, "finding_invalid_evidence".to_string());
    }
    for row in evidence.unwrap_or(&Vec::new()) {
        if !row.is_object() {
            return (false, "finding_invalid_evidence_row".to_string());
        }
        if to_clean_string(row.get("type")).is_empty() {
            return (false, "finding_invalid_evidence_type".to_string());
        }
        if to_clean_string(row.get("value")).is_empty() {
            return (false, "finding_invalid_evidence_value".to_string());
        }
    }

    let timestamp = to_clean_string(finding.get("timestamp"));
    if !is_datetime(&timestamp) {
        return (false, "finding_invalid_timestamp".to_string());
    }

    (true, "finding_valid".to_string())
}

fn append_finding(root: &Path, task_id: &str, finding: &Value, root_dir: Option<&str>) -> Value {
    let normalized = normalize_finding(finding);
    let (ok, reason) = validate_finding(&normalized);
    if !ok {
        return json!({
            "ok": false,
            "type": "orchestration_scratchpad_append_finding",
            "reason_code": reason,
            "task_id": task_id
        });
    }

    let loaded = match load_scratchpad(root, task_id, root_dir) {
        Ok(value) => value,
        Err(err) => {
            return json!({
                "ok": false,
                "type": "orchestration_scratchpad_append_finding",
                "reason_code": err,
                "task_id": task_id
            });
        }
    };

    let mut findings = loaded
        .scratchpad
        .get("findings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    findings.push(normalized);
    let out = match write_scratchpad(
        root,
        task_id,
        &json!({ "findings": findings }),
        root_dir,
    ) {
        Ok(value) => value,
        Err(err) => {
            return json!({
                "ok": false,
                "type": "orchestration_scratchpad_append_finding",
                "reason_code": err,
                "task_id": task_id
            });
        }
    };

    let count = out
        .get("scratchpad")
        .and_then(|v| v.get("findings"))
        .and_then(Value::as_array)
        .map(|rows| rows.len())
        .unwrap_or(0);

    json!({
        "ok": true,
        "type": "orchestration_scratchpad_append_finding",
        "task_id": task_id,
        "file_path": out.get("file_path").cloned().unwrap_or(Value::Null),
        "scratchpad": out.get("scratchpad").cloned().unwrap_or(Value::Null),
        "finding_count": count
    })
}

fn append_checkpoint(root: &Path, task_id: &str, checkpoint: &Value, root_dir: Option<&str>) -> Value {
    let loaded = match load_scratchpad(root, task_id, root_dir) {
        Ok(value) => value,
        Err(err) => {
            return json!({
                "ok": false,
                "type": "orchestration_scratchpad_append_checkpoint",
                "reason_code": err,
                "task_id": task_id
            });
        }
    };

    let mut rows = loaded
        .scratchpad
        .get("checkpoints")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut next_checkpoint = get_object(checkpoint);
    if to_clean_string(next_checkpoint.get("created_at")).is_empty() {
        next_checkpoint.insert("created_at".to_string(), Value::String(now_iso()));
    }
    rows.push(Value::Object(next_checkpoint));

    let out = match write_scratchpad(root, task_id, &json!({ "checkpoints": rows }), root_dir) {
        Ok(value) => value,
        Err(err) => {
            return json!({
                "ok": false,
                "type": "orchestration_scratchpad_append_checkpoint",
                "reason_code": err,
                "task_id": task_id
            });
        }
    };

    let count = out
        .get("scratchpad")
        .and_then(|v| v.get("checkpoints"))
        .and_then(Value::as_array)
        .map(|rows| rows.len())
        .unwrap_or(0);

    json!({
        "ok": true,
        "type": "orchestration_scratchpad_append_checkpoint",
        "task_id": task_id,
        "file_path": out.get("file_path").cloned().unwrap_or(Value::Null),
        "scratchpad": out.get("scratchpad").cloned().unwrap_or(Value::Null),
        "checkpoint_count": count
    })
}

fn cleanup_scratchpad(root: &Path, task_id: &str, root_dir: Option<&str>) -> Value {
    let file_path = match scratchpad_path(root, task_id, root_dir) {
        Ok(path) => path,
        Err(err) => {
            return json!({
                "ok": false,
                "type": "orchestration_scratchpad_cleanup",
                "reason_code": err,
                "task_id": task_id
            });
        }
    };

    let _ = fs::remove_file(&file_path);
    json!({
        "ok": true,
        "type": "orchestration_scratchpad_cleanup",
        "task_id": task_id,
        "file_path": file_path,
        "removed": !file_path.exists()
    })
}

fn parse_scope_list(input: Option<&Value>, upper: bool) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    let source = match input {
        Some(Value::Array(rows)) => rows.clone(),
        Some(Value::String(text)) => text
            .split(',')
            .map(|v| Value::String(v.trim().to_string()))
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };

    for row in source {
        let mut token = to_clean_string(Some(&row));
        if token.is_empty() {
            continue;
        }
        if upper {
            token = token.to_ascii_uppercase();
        } else {
            token = token.replace('\\', "/");
        }
        if seen.insert(token.clone()) {
            out.push(token);
        }
    }

    out
}

fn normalize_path_pattern(raw: &str) -> String {
    raw.trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_string()
}

fn path_pattern_overlaps(left_raw: &str, right_raw: &str) -> bool {
    let left = normalize_path_pattern(left_raw);
    let right = normalize_path_pattern(right_raw);
    if left.is_empty() || right.is_empty() {
        return false;
    }
    if left == right {
        return true;
    }

    let left_prefix = if left.ends_with('*') {
        left.trim_end_matches('*')
    } else {
        ""
    };
    let right_prefix = if right.ends_with('*') {
        right.trim_end_matches('*')
    } else {
        ""
    };

    (!left_prefix.is_empty() && right.starts_with(left_prefix))
        || (!right_prefix.is_empty() && left.starts_with(right_prefix))
        || (left_prefix.is_empty() && !right_prefix.is_empty() && left.starts_with(right_prefix))
        || (right_prefix.is_empty() && !left_prefix.is_empty() && right.starts_with(left_prefix))
}

fn finding_matches_path_scope(finding: &Value, path_scopes: &[String]) -> bool {
    if path_scopes.is_empty() {
        return true;
    }

    let location = normalize_path_pattern(&to_clean_string(finding.get("location")));
    if location.is_empty() {
        return false;
    }

    for pattern_raw in path_scopes {
        let pattern = normalize_path_pattern(pattern_raw);
        if pattern.is_empty() {
            continue;
        }
        if pattern.ends_with('*') {
            let prefix = pattern.trim_end_matches('*');
            if location.starts_with(prefix) {
                return true;
            }
            continue;
        }
        if location == pattern
            || location.starts_with(&format!("{pattern}:"))
            || location.starts_with(&format!("{pattern}#"))
        {
            return true;
        }
    }
    false
}

fn finding_matches_series_scope(finding: &Value, series_scopes: &[String]) -> bool {
    if series_scopes.is_empty() {
        return true;
    }
    let item_id = to_clean_string(finding.get("item_id")).to_ascii_uppercase();
    if item_id.is_empty() {
        return false;
    }
    series_scopes
        .iter()
        .any(|series| item_id.starts_with(&series.to_ascii_uppercase()))
}

fn normalize_scope(raw_scope: &Value, index: usize) -> Value {
    let scope = if raw_scope.is_object() {
        raw_scope.clone()
    } else {
        Value::Object(Map::new())
    };

    let scope_id_raw = {
        let id = get_string_any(&scope, &["scope_id", "scopeId"]);
        if id.is_empty() {
            format!("scope-{}", index + 1)
        } else {
            id.to_ascii_lowercase()
        }
    };

    let scope_id = if validate_group_id(&scope_id_raw) {
        scope_id_raw
    } else {
        format!("scope-{}", index + 1)
    };

    let series = parse_scope_list(scope.get("series"), true);
    let paths = parse_scope_list(scope.get("paths"), false)
        .into_iter()
        .map(|row| normalize_path_pattern(&row))
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>();

    if series.is_empty() && paths.is_empty() {
        return json!({
            "ok": false,
            "reason_code": "scope_missing_series_and_paths",
            "scope_id": scope_id
        });
    }

    json!({
        "ok": true,
        "scope": {
            "scope_id": scope_id,
            "series": series,
            "paths": paths
        }
    })
}

fn detect_scope_overlaps(scopes: &[Value]) -> Value {
    let mut normalized = Vec::new();
    for (index, scope) in scopes.iter().enumerate() {
        let out = normalize_scope(scope, index);
        if out.get("ok").and_then(Value::as_bool) != Some(true) {
            return json!({
                "ok": false,
                "reason_code": out.get("reason_code").cloned().unwrap_or(Value::String("scope_invalid".to_string())),
                "scope_id": out.get("scope_id").cloned().unwrap_or(Value::Null),
                "overlaps": []
            });
        }
        normalized.push(out.get("scope").cloned().unwrap_or(Value::Object(Map::new())));
    }

    let mut overlaps = Vec::new();
    for left_index in 0..normalized.len() {
        for right_index in (left_index + 1)..normalized.len() {
            let left = &normalized[left_index];
            let right = &normalized[right_index];

            let left_series = left
                .get("series")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|v| to_clean_string(Some(&v)))
                .collect::<HashSet<_>>();

            let right_series = right
                .get("series")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|v| to_clean_string(Some(&v)))
                .collect::<HashSet<_>>();

            let overlapping_series = left_series
                .intersection(&right_series)
                .cloned()
                .map(Value::String)
                .collect::<Vec<_>>();

            let left_paths = left
                .get("paths")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|v| to_clean_string(Some(&v)))
                .collect::<Vec<_>>();
            let right_paths = right
                .get("paths")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|v| to_clean_string(Some(&v)))
                .collect::<Vec<_>>();

            let mut overlapping_paths = Vec::new();
            for left_path in &left_paths {
                for right_path in &right_paths {
                    if path_pattern_overlaps(left_path, right_path) {
                        overlapping_paths.push(json!({
                            "left": left_path,
                            "right": right_path
                        }));
                    }
                }
            }

            if !overlapping_series.is_empty() || !overlapping_paths.is_empty() {
                overlaps.push(json!({
                    "left_scope_id": to_clean_string(left.get("scope_id")),
                    "right_scope_id": to_clean_string(right.get("scope_id")),
                    "overlapping_series": overlapping_series,
                    "overlapping_paths": overlapping_paths
                }));
            }
        }
    }

    json!({
        "ok": overlaps.is_empty(),
        "reason_code": if overlaps.is_empty() { "scope_non_overlap_ok" } else { "scope_overlap_detected" },
        "normalized_scopes": normalized,
        "overlaps": overlaps
    })
}

fn finding_in_scope(finding: &Value, scope: &Value) -> Value {
    let normalized_scope = normalize_scope(scope, 0);
    if normalized_scope.get("ok").and_then(Value::as_bool) != Some(true) {
        return json!({
            "ok": false,
            "reason_code": normalized_scope.get("reason_code").cloned().unwrap_or(Value::String("scope_invalid".to_string())),
            "in_scope": false,
            "scope_id": normalized_scope.get("scope_id").cloned().unwrap_or(Value::Null)
        });
    }

    let scope_data = normalized_scope.get("scope").cloned().unwrap_or(Value::Object(Map::new()));
    let series = scope_data
        .get("series")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|v| to_clean_string(Some(&v)))
        .collect::<Vec<_>>();
    let paths = scope_data
        .get("paths")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|v| to_clean_string(Some(&v)))
        .collect::<Vec<_>>();

    let matches_series = finding_matches_series_scope(finding, &series);
    let matches_paths = finding_matches_path_scope(finding, &paths);
    let in_scope = matches_series && matches_paths;

    json!({
        "ok": true,
        "reason_code": if in_scope { "finding_in_scope" } else { "finding_out_of_scope" },
        "in_scope": in_scope,
        "scope_id": scope_data.get("scope_id").cloned().unwrap_or(Value::Null),
        "matches_series": matches_series,
        "matches_paths": matches_paths
    })
}

fn classify_findings_by_scope(findings: &[Value], scope: &Value, agent_id: &str) -> Value {
    let mut in_scope = Vec::new();
    let mut out_of_scope = Vec::new();
    let mut violations = Vec::new();

    let normalized_agent_id = if agent_id.trim().is_empty() {
        Value::Null
    } else {
        Value::String(agent_id.trim().to_string())
    };

    for finding in findings {
        let verdict = finding_in_scope(finding, scope);
        if verdict.get("ok").and_then(Value::as_bool) != Some(true) {
            out_of_scope.push(finding.clone());
            violations.push(json!({
                "reason_code": verdict.get("reason_code").cloned().unwrap_or(Value::String("scope_classification_failed".to_string())),
                "item_id": finding.get("item_id").cloned().unwrap_or(Value::Null),
                "location": finding.get("location").cloned().unwrap_or(Value::Null),
                "agent_id": normalized_agent_id,
                "scope_id": verdict.get("scope_id").cloned().unwrap_or(Value::Null)
            }));
            continue;
        }

        if verdict.get("in_scope").and_then(Value::as_bool) == Some(true) {
            in_scope.push(finding.clone());
            continue;
        }

        out_of_scope.push(finding.clone());
        violations.push(json!({
            "reason_code": "out_of_scope_finding",
            "item_id": finding.get("item_id").cloned().unwrap_or(Value::Null),
            "location": finding.get("location").cloned().unwrap_or(Value::Null),
            "agent_id": normalized_agent_id,
            "scope_id": verdict.get("scope_id").cloned().unwrap_or(Value::Null),
            "matches_series": verdict.get("matches_series").cloned().unwrap_or(Value::Bool(false)),
            "matches_paths": verdict.get("matches_paths").cloned().unwrap_or(Value::Bool(false))
        }));
    }

    json!({
        "ok": true,
        "type": "orchestration_scope_classification",
        "in_scope": in_scope,
        "out_of_scope": out_of_scope,
        "violations": violations
    })
}

fn slug(raw: &str, fallback: &str, max_len: usize) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_dash = false;
    for ch in raw.trim().to_ascii_lowercase().chars() {
        let mapped = if ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '_' | '.' | '-') {
            ch
        } else {
            '-'
        };
        if mapped == '-' {
            if !prev_dash {
                out.push('-');
                prev_dash = true;
            }
        } else {
            out.push(mapped);
            prev_dash = false;
        }
        if out.len() >= max_len {
            break;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

fn timestamp_token(now_ms: i64) -> String {
    let date = chrono::DateTime::<Utc>::from_timestamp_millis(now_ms).unwrap_or_else(Utc::now);
    format!(
        "{:04}{:02}{:02}{:02}{:02}{:02}",
        date.year(),
        date.month(),
        date.day(),
        date.hour(),
        date.minute(),
        date.second()
    )
}

fn nonce_token(length: usize) -> String {
    let width = length.max(4);
    let mut bytes = vec![0u8; width];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex = bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>();
    hex.chars().take(width).collect()
}

fn generate_task_group_id(task_type: &str, now_ms: i64, nonce: &str) -> String {
    let nonce_value = if nonce.trim().is_empty() {
        nonce_token(6)
    } else {
        nonce.trim().to_ascii_lowercase()
    };
    let out = format!(
        "{}-{}-{}",
        slug(task_type, "task", 48),
        timestamp_token(now_ms),
        slug(&nonce_value, &nonce_token(6), 24)
    );
    out.chars().take(127).collect()
}

fn allowed_agent_status(status: &str) -> bool {
    matches!(status, "pending" | "running" | "done" | "failed" | "timeout")
}

fn terminal_agent_status(status: &str) -> bool {
    matches!(status, "done" | "failed" | "timeout")
}

fn normalize_agent_id(raw: &str, index: usize) -> Result<String, String> {
    let id = if raw.trim().is_empty() {
        format!("agent-{}", index + 1)
    } else {
        raw.trim().to_string()
    };
    if validate_agent_id(&id) {
        Ok(id)
    } else {
        Err(format!("invalid_agent_id:{id}"))
    }
}

fn normalize_agents(input_agents: &[Value], fallback_count: i64) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for (index, row) in input_agents.iter().enumerate() {
        let row_object = row.as_object().cloned().unwrap_or_default();
        let raw_agent_id = row_object
            .get("agent_id")
            .or_else(|| row_object.get("agentId"))
            .map(|v| to_clean_string(Some(v)))
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| to_clean_string(Some(row)));
        let agent_id = normalize_agent_id(&raw_agent_id, index)?;
        if !seen.insert(agent_id.clone()) {
            continue;
        }
        let status = to_clean_string(row_object.get("status")).to_ascii_lowercase();
        let normalized_status = if allowed_agent_status(&status) {
            status
        } else {
            "pending".to_string()
        };
        let details = row_object
            .get("details")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();

        out.push(json!({
            "agent_id": agent_id,
            "status": normalized_status,
            "updated_at": now_iso(),
            "details": details
        }));
    }

    let desired_count = fallback_count.max(1) as usize;
    while out.len() < desired_count {
        let next_id = normalize_agent_id("", out.len())?;
        if !seen.insert(next_id.clone()) {
            continue;
        }
        out.push(json!({
            "agent_id": next_id,
            "status": "pending",
            "updated_at": now_iso(),
            "details": {}
        }));
    }

    Ok(out)
}

fn status_counts(task_group: &Value) -> Value {
    let mut pending = 0;
    let mut running = 0;
    let mut done = 0;
    let mut failed = 0;
    let mut timeout = 0;

    let agents = task_group
        .get("agents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for agent in agents {
        let status = to_clean_string(agent.get("status")).to_ascii_lowercase();
        match status.as_str() {
            "pending" => pending += 1,
            "running" => running += 1,
            "done" => done += 1,
            "failed" => failed += 1,
            "timeout" => timeout += 1,
            _ => {}
        }
    }

    let total = pending + running + done + failed + timeout;
    json!({
        "pending": pending,
        "running": running,
        "done": done,
        "failed": failed,
        "timeout": timeout,
        "total": total
    })
}

fn derive_group_status(task_group: &Value) -> String {
    let counts = status_counts(task_group);
    let total = get_i64_any(&counts, &["total"], 0);
    let pending = get_i64_any(&counts, &["pending"], 0);
    let running = get_i64_any(&counts, &["running"], 0);
    let done = get_i64_any(&counts, &["done"], 0);
    let failed = get_i64_any(&counts, &["failed"], 0);
    let timeout = get_i64_any(&counts, &["timeout"], 0);

    if total == 0 || pending == total {
        "pending".to_string()
    } else if running > 0 || pending > 0 {
        "running".to_string()
    } else if failed > 0 && done == 0 && timeout == 0 {
        "failed".to_string()
    } else if timeout > 0 && done == 0 && failed == 0 {
        "timeout".to_string()
    } else if done == total {
        "done".to_string()
    } else if done + failed + timeout == total {
        "completed".to_string()
    } else {
        "running".to_string()
    }
}

fn default_task_group(task_group_id: &str, input: &Value) -> Result<Value, String> {
    let agent_count = get_i64_any(input, &["agent_count", "agentCount"], 1).max(1);
    let agents_source = input
        .get("agents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let agents = normalize_agents(&agents_source, agent_count)?;

    let coordinator_session = {
        let value = get_string_any(input, &["coordinator_session", "coordinatorSession"]);
        if value.is_empty() {
            Value::Null
        } else {
            Value::String(value)
        }
    };

    Ok(json!({
        "schema_version": TASKGROUP_SCHEMA_VERSION,
        "task_group_id": task_group_id,
        "task_type": slug(&get_string_any(input, &["task_type", "taskType"]), "task", 48),
        "coordinator_session": coordinator_session,
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "agent_count": agents.len(),
        "status": "pending",
        "agents": agents,
        "history": []
    }))
}

#[derive(Debug, Clone)]
struct LoadedTaskGroup {
    exists: bool,
    file_path: PathBuf,
    task_group: Value,
}

fn load_task_group(root: &Path, task_group_id: &str, root_dir: Option<&str>) -> Result<LoadedTaskGroup, String> {
    let file_path = taskgroup_path(root, task_group_id, root_dir)?;
    if !file_path.exists() {
        return Ok(LoadedTaskGroup {
            exists: false,
            file_path,
            task_group: Value::Null,
        });
    }

    let raw = fs::read_to_string(&file_path)
        .map_err(|err| format!("taskgroup_read_failed:{}:{err}", file_path.display()))?;
    let mut parsed = serde_json::from_str::<Value>(&raw)
        .map_err(|err| format!("taskgroup_parse_failed:{}:{err}", file_path.display()))?;
    if !parsed.is_object() {
        return Err("invalid_taskgroup_payload".to_string());
    }

    if let Value::Object(map) = &mut parsed {
        map.insert(
            "schema_version".to_string(),
            Value::String(TASKGROUP_SCHEMA_VERSION.to_string()),
        );
        map.insert(
            "task_group_id".to_string(),
            Value::String(task_group_id.trim().to_ascii_lowercase()),
        );
        let agents_source = map
            .get("agents")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let agent_count = map
            .get("agent_count")
            .and_then(Value::as_i64)
            .or_else(|| map.get("agent_count").and_then(Value::as_u64).map(|v| v as i64))
            .unwrap_or(1)
            .max(1);
        let agents = normalize_agents(&agents_source, agent_count)?;
        map.insert("agents".to_string(), Value::Array(agents));
        let normalized_agent_count = map
            .get("agents")
            .and_then(Value::as_array)
            .map(|rows| rows.len() as i64)
            .unwrap_or(1);
        map.insert(
            "agent_count".to_string(),
            Value::Number(serde_json::Number::from(normalized_agent_count)),
        );
        if !map.get("history").map(Value::is_array).unwrap_or(false) {
            map.insert("history".to_string(), Value::Array(Vec::new()));
        }
        let status = derive_group_status(&Value::Object(map.clone()));
        map.insert("status".to_string(), Value::String(status));
    }

    Ok(LoadedTaskGroup {
        exists: true,
        file_path,
        task_group: parsed,
    })
}

fn save_task_group(root: &Path, task_group: &Value, root_dir: Option<&str>) -> Value {
    if !task_group.is_object() {
        return json!({
            "ok": false,
            "type": "orchestration_taskgroup_save",
            "reason_code": "invalid_taskgroup"
        });
    }

    let task_group_id = to_clean_string(task_group.get("task_group_id")).to_ascii_lowercase();
    let file_path = match taskgroup_path(root, &task_group_id, root_dir) {
        Ok(path) => path,
        Err(err) => {
            return json!({
                "ok": false,
                "type": "orchestration_taskgroup_save",
                "reason_code": err
            });
        }
    };

    let mut next = task_group.clone();
    if let Value::Object(map) = &mut next {
        map.insert(
            "schema_version".to_string(),
            Value::String(TASKGROUP_SCHEMA_VERSION.to_string()),
        );

        let agents_source = map
            .get("agents")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let desired = map
            .get("agent_count")
            .and_then(Value::as_i64)
            .or_else(|| map.get("agent_count").and_then(Value::as_u64).map(|v| v as i64))
            .unwrap_or(1)
            .max(1);
        let agents = match normalize_agents(&agents_source, desired) {
            Ok(rows) => rows,
            Err(err) => {
                return json!({
                    "ok": false,
                    "type": "orchestration_taskgroup_save",
                    "reason_code": err
                });
            }
        };
        map.insert("agents".to_string(), Value::Array(agents));
        let count = map
            .get("agents")
            .and_then(Value::as_array)
            .map(|rows| rows.len() as i64)
            .unwrap_or(1);
        map.insert(
            "agent_count".to_string(),
            Value::Number(serde_json::Number::from(count)),
        );
        let status = derive_group_status(&Value::Object(map.clone()));
        map.insert("status".to_string(), Value::String(status));
        map.insert("updated_at".to_string(), Value::String(now_iso()));
        if to_clean_string(map.get("created_at")).is_empty() {
            map.insert("created_at".to_string(), Value::String(now_iso()));
        }
        if !map.get("history").map(Value::is_array).unwrap_or(false) {
            map.insert("history".to_string(), Value::Array(Vec::new()));
        }
    }

    if let Some(parent) = file_path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            return json!({
                "ok": false,
                "type": "orchestration_taskgroup_save",
                "reason_code": format!("taskgroup_create_parent_failed:{}:{err}", parent.display())
            });
        }
    }

    let payload = match serde_json::to_string_pretty(&next) {
        Ok(text) => text + "\n",
        Err(err) => {
            return json!({
                "ok": false,
                "type": "orchestration_taskgroup_save",
                "reason_code": format!("taskgroup_encode_failed:{err}")
            });
        }
    };

    if let Err(err) = fs::write(&file_path, payload) {
        return json!({
            "ok": false,
            "type": "orchestration_taskgroup_save",
            "reason_code": format!("taskgroup_write_failed:{}:{err}", file_path.display())
        });
    }

    json!({
        "ok": true,
        "type": "orchestration_taskgroup_save",
        "file_path": file_path,
        "task_group": next,
        "counts": status_counts(&next)
    })
}

fn ensure_task_group(root: &Path, input: &Value, root_dir: Option<&str>) -> Value {
    let requested = get_string_any(input, &["task_group_id", "taskGroupId"]).to_ascii_lowercase();
    let task_group_id = if requested.is_empty() {
        let task_type = get_string_any(input, &["task_type", "taskType"]);
        let now_ms = get_i64_any(input, &["now_ms"], Utc::now().timestamp_millis());
        let nonce = get_string_any(input, &["nonce"]);
        generate_task_group_id(
            if task_type.is_empty() { "task" } else { &task_type },
            now_ms,
            &nonce,
        )
    } else {
        requested
    };

    let loaded = match load_task_group(root, &task_group_id, root_dir) {
        Ok(value) => value,
        Err(err) => {
            return json!({
                "ok": false,
                "type": "orchestration_taskgroup_ensure",
                "reason_code": err
            });
        }
    };

    if loaded.exists {
        return json!({
            "ok": true,
            "type": "orchestration_taskgroup_ensure",
            "created": false,
            "file_path": loaded.file_path,
            "task_group": loaded.task_group,
            "counts": status_counts(&loaded.task_group)
        });
    }

    let mut seed = input.clone();
    if let Value::Object(map) = &mut seed {
        map.insert("task_group_id".to_string(), Value::String(task_group_id.clone()));
    }
    let created = match default_task_group(&task_group_id, &seed) {
        Ok(value) => value,
        Err(err) => {
            return json!({
                "ok": false,
                "type": "orchestration_taskgroup_ensure",
                "reason_code": err
            });
        }
    };

    let saved = save_task_group(root, &created, root_dir);
    if saved.get("ok").and_then(Value::as_bool) != Some(true) {
        return saved;
    }

    json!({
        "ok": true,
        "type": "orchestration_taskgroup_ensure",
        "created": true,
        "file_path": saved.get("file_path").cloned().unwrap_or(Value::Null),
        "task_group": saved.get("task_group").cloned().unwrap_or(Value::Null),
        "counts": saved.get("counts").cloned().unwrap_or(Value::Null)
    })
}

fn update_agent_status(
    root: &Path,
    task_group_id: &str,
    agent_id: &str,
    status: &str,
    details: &Value,
    root_dir: Option<&str>,
) -> Value {
    let ensure = ensure_task_group(root, &json!({ "task_group_id": task_group_id }), root_dir);
    if ensure.get("ok").and_then(Value::as_bool) != Some(true) {
        return ensure;
    }

    let normalized_agent_id = match normalize_agent_id(agent_id, 0) {
        Ok(value) => value,
        Err(err) => {
            return json!({
                "ok": false,
                "type": "orchestration_taskgroup_update_status",
                "reason_code": err
            });
        }
    };
    let normalized_status = status.trim().to_ascii_lowercase();
    if !allowed_agent_status(&normalized_status) {
        return json!({
            "ok": false,
            "type": "orchestration_taskgroup_update_status",
            "reason_code": format!("invalid_agent_status:{}", if status.trim().is_empty() { "<empty>" } else { status })
        });
    }

    let mut group = ensure.get("task_group").cloned().unwrap_or(Value::Object(Map::new()));
    let now = now_iso();

    let mut previous_status = "pending".to_string();
    if let Some(agents) = group.get_mut("agents").and_then(Value::as_array_mut) {
        let mut found_index = None;
        for (index, row) in agents.iter().enumerate() {
            if to_clean_string(row.get("agent_id")) == normalized_agent_id {
                found_index = Some(index);
                break;
            }
        }

        if let Some(index) = found_index {
            if let Some(agent) = agents.get_mut(index) {
                previous_status = to_clean_string(agent.get("status")).to_ascii_lowercase();
                if let Value::Object(agent_map) = agent {
                    agent_map.insert("status".to_string(), Value::String(normalized_status.clone()));
                    agent_map.insert("updated_at".to_string(), Value::String(now.clone()));

                    let mut next_details = agent_map
                        .get("details")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    if let Some(new_details) = details.as_object() {
                        for (k, v) in new_details {
                            next_details.insert(k.clone(), v.clone());
                        }
                    }
                    agent_map.insert("details".to_string(), Value::Object(next_details));
                }
            }
        } else {
            agents.push(json!({
                "agent_id": normalized_agent_id,
                "status": normalized_status,
                "updated_at": now,
                "details": details.as_object().cloned().unwrap_or_default()
            }));
        }
    }

    if let Value::Object(map) = &mut group {
        let count = map
            .get("agents")
            .and_then(Value::as_array)
            .map(|rows| rows.len() as i64)
            .unwrap_or(1);
        map.insert(
            "agent_count".to_string(),
            Value::Number(serde_json::Number::from(count)),
        );

        let mut history = map
            .get("history")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        history.push(json!({
            "event": "agent_status_update",
            "at": now_iso(),
            "agent_id": normalized_agent_id,
            "previous_status": previous_status,
            "status": normalized_status,
            "terminal": terminal_agent_status(&normalized_status),
            "details": details.as_object().cloned().unwrap_or_default()
        }));
        map.insert("history".to_string(), Value::Array(history));
    }

    let saved = save_task_group(root, &group, root_dir);
    if saved.get("ok").and_then(Value::as_bool) != Some(true) {
        return saved;
    }

    json!({
        "ok": true,
        "type": "orchestration_taskgroup_update_status",
        "task_group_id": saved.get("task_group").and_then(|v| v.get("task_group_id")).cloned().unwrap_or(Value::Null),
        "agent_id": normalized_agent_id,
        "status": normalized_status,
        "previous_status": previous_status,
        "file_path": saved.get("file_path").cloned().unwrap_or(Value::Null),
        "task_group": saved.get("task_group").cloned().unwrap_or(Value::Null),
        "counts": saved.get("counts").cloned().unwrap_or(Value::Null)
    })
}

fn query_task_group(root: &Path, task_group_id: &str, root_dir: Option<&str>) -> Value {
    let loaded = match load_task_group(root, task_group_id, root_dir) {
        Ok(value) => value,
        Err(err) => {
            return json!({
                "ok": false,
                "type": "orchestration_taskgroup_query",
                "reason_code": err,
                "task_group_id": task_group_id.trim().to_ascii_lowercase()
            });
        }
    };

    if !loaded.exists {
        return json!({
            "ok": false,
            "type": "orchestration_taskgroup_query",
            "reason_code": "task_group_not_found",
            "task_group_id": task_group_id.trim().to_ascii_lowercase()
        });
    }

    json!({
        "ok": true,
        "type": "orchestration_taskgroup_query",
        "file_path": loaded.file_path,
        "task_group": loaded.task_group,
        "counts": status_counts(&loaded.task_group)
    })
}

fn build_checkpoint(task_id: &str, metrics: &Value, reason: &str) -> Value {
    json!({
        "task_id": task_id,
        "reason": reason,
        "processed_count": get_i64_any(metrics, &["processed_count", "processed"], 0),
        "total_count": get_i64_any(metrics, &["total_count", "total"], 0),
        "now_ms": get_i64_any(metrics, &["now_ms"], Utc::now().timestamp_millis()),
        "partial_results": metrics.get("partial_results").and_then(Value::as_array).cloned().unwrap_or_default(),
        "retry_count": get_i64_any(metrics, &["retry_count"], 0)
    })
}

fn should_checkpoint(state: &Value, metrics: &Value, options: &Value) -> bool {
    let item_interval = get_i64_any(options, &["itemInterval", "item_interval"], ITEM_INTERVAL).max(1);
    let time_interval_ms =
        get_i64_any(options, &["timeIntervalMs", "time_interval_ms"], TIME_INTERVAL_MS).max(1);
    let now_ms = get_i64_any(metrics, &["now_ms"], Utc::now().timestamp_millis());
    let processed = get_i64_any(metrics, &["processed_count", "processed"], 0).max(0);

    let checkpoints = state
        .get("checkpoints")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if checkpoints.is_empty() {
        return processed > 0;
    }

    let last = checkpoints.last().cloned().unwrap_or(Value::Null);
    let last_processed = get_i64_any(&last, &["processed_count"], 0);
    let last_now_ms = get_i64_any(&last, &["now_ms"], now_ms);

    let item_delta = processed - last_processed;
    let time_delta = now_ms - last_now_ms;
    item_delta >= item_interval || time_delta >= time_interval_ms
}

fn maybe_checkpoint(root: &Path, task_id: &str, metrics: &Value, root_dir: Option<&str>) -> Value {
    let loaded = match load_scratchpad(root, task_id, root_dir) {
        Ok(value) => value,
        Err(err) => {
            return json!({
                "ok": false,
                "type": "orchestration_checkpoint_tick",
                "reason_code": err,
                "task_id": task_id
            });
        }
    };

    let should_write = should_checkpoint(&loaded.scratchpad, metrics, &Value::Null);
    if !should_write {
        return json!({
            "ok": true,
            "type": "orchestration_checkpoint_tick",
            "checkpoint_written": false,
            "task_id": task_id,
            "checkpoint_path": loaded.file_path
        });
    }

    let checkpoint = build_checkpoint(task_id, metrics, "interval");
    let appended = append_checkpoint(root, task_id, &checkpoint, root_dir);
    if appended.get("ok").and_then(Value::as_bool) != Some(true) {
        return json!({
            "ok": false,
            "type": "orchestration_checkpoint_tick",
            "reason_code": appended.get("reason_code").cloned().unwrap_or(Value::String("checkpoint_append_failed".to_string())),
            "task_id": task_id
        });
    }

    json!({
        "ok": true,
        "type": "orchestration_checkpoint_tick",
        "checkpoint_written": true,
        "task_id": task_id,
        "checkpoint_path": appended.get("file_path").cloned().unwrap_or(Value::Null),
        "checkpoint": checkpoint
    })
}

fn handle_timeout(root: &Path, task_id: &str, metrics: &Value, root_dir: Option<&str>) -> Value {
    let retry_count = get_i64_any(metrics, &["retry_count"], 0);
    let retry_allowed = retry_count < MAX_AUTO_RETRIES;
    let mut checkpoint = build_checkpoint(task_id, metrics, "timeout");
    if let Value::Object(map) = &mut checkpoint {
        map.insert("retry_allowed".to_string(), Value::Bool(retry_allowed));
    }

    let appended = append_checkpoint(root, task_id, &checkpoint, root_dir);
    if appended.get("ok").and_then(Value::as_bool) != Some(true) {
        return json!({
            "ok": false,
            "type": "orchestration_checkpoint_timeout",
            "reason_code": appended.get("reason_code").cloned().unwrap_or(Value::String("checkpoint_append_failed".to_string())),
            "task_id": task_id
        });
    }

    let _ = write_scratchpad(
        root,
        task_id,
        &json!({
            "progress": {
                "processed": get_i64_any(metrics, &["processed_count", "processed"], 0),
                "total": get_i64_any(metrics, &["total_count", "total"], 0)
            }
        }),
        root_dir,
    );

    json!({
        "ok": true,
        "type": "orchestration_checkpoint_timeout",
        "task_id": task_id,
        "checkpoint_path": appended.get("file_path").cloned().unwrap_or(Value::Null),
        "checkpoint": checkpoint,
        "partial_results": checkpoint.get("partial_results").cloned().unwrap_or(Value::Array(Vec::new())),
        "retry_allowed": retry_allowed
    })
}

fn partial_count_from_group(task_group: &Value) -> i64 {
    let agents = task_group
        .get("agents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut total = 0;
    for agent in agents {
        let details = agent.get("details").cloned().unwrap_or(Value::Null);
        let count = get_i64_any(&details, &["partial_results_count"], {
            details
                .get("partial_results")
                .and_then(Value::as_array)
                .map(|rows| rows.len() as i64)
                .unwrap_or(0)
        });
        if count > 0 {
            total += 1;
        }
    }
    total
}

fn completion_summary(task_group: &Value) -> Value {
    let counts = status_counts(task_group);
    let total = get_i64_any(&counts, &["total"], 0);
    let done = get_i64_any(&counts, &["done"], 0);
    let failed = get_i64_any(&counts, &["failed"], 0);
    let timeout = get_i64_any(&counts, &["timeout"], 0);
    let pending = get_i64_any(&counts, &["pending"], 0);
    let running = get_i64_any(&counts, &["running"], 0);
    let terminal_total = done + failed + timeout;
    let status = {
        let value = to_clean_string(task_group.get("status"));
        if value.is_empty() {
            "pending".to_string()
        } else {
            value
        }
    };

    json!({
        "task_group_id": to_clean_string(task_group.get("task_group_id")).to_ascii_lowercase(),
        "status": status,
        "completed_count": done,
        "failed_count": failed,
        "timeout_count": timeout,
        "pending_count": pending,
        "running_count": running,
        "partial_count": partial_count_from_group(task_group),
        "total_count": total,
        "complete": total > 0 && terminal_total == total,
        "counts": counts
    })
}

fn build_completion_notification(summary: &Value, task_group: &Value) -> Value {
    json!({
        "type": "orchestration_completion_notification",
        "task_group_id": summary.get("task_group_id").cloned().unwrap_or(Value::Null),
        "coordinator_session": task_group.get("coordinator_session").cloned().unwrap_or(Value::Null),
        "status": summary.get("status").cloned().unwrap_or(Value::Null),
        "completed_count": summary.get("completed_count").cloned().unwrap_or(Value::Null),
        "failed_count": summary.get("failed_count").cloned().unwrap_or(Value::Null),
        "timeout_count": summary.get("timeout_count").cloned().unwrap_or(Value::Null),
        "partial_count": summary.get("partial_count").cloned().unwrap_or(Value::Null),
        "total_count": summary.get("total_count").cloned().unwrap_or(Value::Null),
        "generated_at": now_iso()
    })
}

fn ensure_and_summarize(root: &Path, task_group_id: &str, root_dir: Option<&str>) -> Value {
    let ensured = ensure_task_group(root, &json!({ "task_group_id": task_group_id }), root_dir);
    if ensured.get("ok").and_then(Value::as_bool) != Some(true) {
        return ensured;
    }
    let task_group = ensured.get("task_group").cloned().unwrap_or(Value::Object(Map::new()));
    let summary = completion_summary(&task_group);
    json!({
        "ok": true,
        "type": "orchestration_completion_summary",
        "task_group": task_group,
        "summary": summary,
        "notification": if summary.get("complete").and_then(Value::as_bool) == Some(true) {
            build_completion_notification(&summary, &task_group)
        } else {
            Value::Null
        }
    })
}

fn track_agent_completion(root: &Path, task_group_id: &str, update: &Value, root_dir: Option<&str>) -> Value {
    let agent_id = get_string_any(update, &["agent_id", "agentId"]);
    let status = get_string_any(update, &["status"]).to_ascii_lowercase();
    if agent_id.is_empty() {
        return json!({
            "ok": false,
            "type": "orchestration_completion_track",
            "reason_code": "missing_agent_id"
        });
    }
    if !allowed_agent_status(&status) {
        return json!({
            "ok": false,
            "type": "orchestration_completion_track",
            "reason_code": format!("invalid_agent_status:{}", if status.is_empty() { "<empty>" } else { &status })
        });
    }

    let details = update.get("details").cloned().unwrap_or(Value::Object(Map::new()));
    let updated = update_agent_status(root, task_group_id, &agent_id, &status, &details, root_dir);
    if updated.get("ok").and_then(Value::as_bool) != Some(true) {
        return updated;
    }

    let task_group = updated.get("task_group").cloned().unwrap_or(Value::Object(Map::new()));
    let summary = completion_summary(&task_group);
    json!({
        "ok": true,
        "type": "orchestration_completion_track",
        "task_group": task_group,
        "summary": summary,
        "notification": if summary.get("complete").and_then(Value::as_bool) == Some(true) {
            build_completion_notification(&summary, &task_group)
        } else {
            Value::Null
        }
    })
}

fn track_batch_completion(root: &Path, task_group_id: &str, updates: &[Value], root_dir: Option<&str>) -> Value {
    let mut results = Vec::new();
    for update in updates {
        let tracked = track_agent_completion(root, task_group_id, update, root_dir);
        if tracked.get("ok").and_then(Value::as_bool) != Some(true) {
            return json!({
                "ok": false,
                "type": "orchestration_completion_track_batch",
                "reason_code": tracked.get("reason_code").cloned().unwrap_or(Value::String("batch_update_failed".to_string())),
                "failed_update": update
            });
        }
        results.push(json!({
            "agent_id": get_string_any(update, &["agent_id", "agentId"]),
            "status": get_string_any(update, &["status"]).to_ascii_lowercase(),
            "summary": tracked.get("summary").cloned().unwrap_or(Value::Null)
        }));
    }

    let query = query_task_group(root, task_group_id, root_dir);
    if query.get("ok").and_then(Value::as_bool) != Some(true) {
        return query;
    }

    let task_group = query.get("task_group").cloned().unwrap_or(Value::Object(Map::new()));
    let summary = completion_summary(&task_group);

    json!({
        "ok": true,
        "type": "orchestration_completion_track_batch",
        "task_group": task_group,
        "summary": summary,
        "updates_applied": results.len(),
        "updates": results,
        "notification": if summary.get("complete").and_then(Value::as_bool) == Some(true) {
            build_completion_notification(&summary, &task_group)
        } else {
            Value::Null
        }
    })
}

fn normalize_decision(raw: &str, has_partial_results: bool) -> String {
    let normalized = raw.trim().to_ascii_lowercase();
    if matches!(normalized.as_str(), "retry" | "continue" | "abort") {
        normalized
    } else if has_partial_results {
        "continue".to_string()
    } else {
        "retry".to_string()
    }
}

fn extract_partial_from_session_entry(entry: &Value) -> Option<Value> {
    if !entry.is_object() {
        return None;
    }

    let candidates = [
        entry.get("partial_results"),
        entry.get("partialResults"),
        entry.get("partial"),
        entry.get("findings"),
        entry.get("result").and_then(|v| v.get("partial_results")),
        entry.get("result").and_then(|v| v.get("findings")),
        entry.get("output").and_then(|v| v.get("partial_results")),
        entry.get("output").and_then(|v| v.get("findings")),
        entry.get("payload").and_then(|v| v.get("partial_results")),
        entry.get("payload").and_then(|v| v.get("findings")),
    ];

    for candidate in candidates.into_iter().flatten() {
        if let Some(rows) = candidate.as_array() {
            if rows.is_empty() {
                continue;
            }
            let items_completed = get_i64_any(
                entry,
                &["items_completed", "processed_count"],
                rows.len() as i64,
            );
            return Some(json!({
                "partial_results": rows,
                "items_completed": items_completed,
                "checkpoint_path": entry.get("checkpoint_path").or_else(|| entry.get("checkpointPath")).cloned().unwrap_or(Value::Null),
                "source_session_id": entry.get("session_id").or_else(|| entry.get("sessionId")).cloned().unwrap_or(Value::Null)
            }));
        }
    }

    None
}

fn from_session_history(history: &[Value]) -> Value {
    for entry in history.iter().rev() {
        if let Some(extracted) = extract_partial_from_session_entry(entry) {
            return json!({
                "ok": true,
                "type": "orchestration_partial_from_session_history",
                "source": "session_history",
                "items_completed": extracted.get("items_completed").cloned().unwrap_or(Value::Null),
                "findings_sofar": extracted.get("partial_results").cloned().unwrap_or(Value::Array(Vec::new())),
                "checkpoint_path": extracted.get("checkpoint_path").cloned().unwrap_or(Value::Null),
                "source_session_id": extracted.get("source_session_id").cloned().unwrap_or(Value::Null)
            });
        }
    }
    json!({
        "ok": false,
        "type": "orchestration_partial_from_session_history",
        "reason_code": "session_history_no_partial_results"
    })
}

fn latest_checkpoint_from_scratchpad(root: &Path, task_id: &str, root_dir: Option<&str>) -> Value {
    let loaded = match load_scratchpad(root, task_id, root_dir) {
        Ok(value) => value,
        Err(err) => {
            return json!({
                "ok": false,
                "type": "orchestration_partial_checkpoint_fallback",
                "reason_code": err,
                "task_id": task_id,
                "checkpoint_path": Value::Null
            });
        }
    };

    let checkpoints = loaded
        .scratchpad
        .get("checkpoints")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let latest = checkpoints.last().cloned().unwrap_or(Value::Null);
    let partial_results = latest
        .get("partial_results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if partial_results.is_empty() {
        return json!({
            "ok": false,
            "type": "orchestration_partial_checkpoint_fallback",
            "reason_code": "checkpoint_no_partial_results",
            "task_id": task_id,
            "checkpoint_path": loaded.file_path
        });
    }

    json!({
        "ok": true,
        "type": "orchestration_partial_checkpoint_fallback",
        "source": "checkpoint",
        "task_id": task_id,
        "checkpoint_path": loaded.file_path,
        "items_completed": get_i64_any(&latest, &["processed_count"], partial_results.len() as i64),
        "findings_sofar": partial_results,
        "retry_allowed": latest.get("retry_allowed").and_then(Value::as_bool).unwrap_or(false)
    })
}

fn retrieve_partial_results(root: &Path, input: &Value) -> Value {
    let task_id = get_string_any(input, &["task_id", "taskId"]);
    if task_id.is_empty() {
        return json!({
            "ok": false,
            "type": "orchestration_partial_retrieval",
            "reason_code": "missing_task_id"
        });
    }

    let session_history = input
        .get("session_history")
        .or_else(|| input.get("sessionHistory"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let from_sessions = from_session_history(&session_history);
    if from_sessions.get("ok").and_then(Value::as_bool) == Some(true) {
        return json!({
            "ok": true,
            "type": "orchestration_partial_retrieval",
            "source": from_sessions.get("source").cloned().unwrap_or(Value::Null),
            "task_id": task_id,
            "items_completed": from_sessions.get("items_completed").cloned().unwrap_or(Value::Null),
            "findings_sofar": from_sessions.get("findings_sofar").cloned().unwrap_or(Value::Array(Vec::new())),
            "checkpoint_path": from_sessions.get("checkpoint_path").cloned().unwrap_or(Value::Null),
            "source_session_id": from_sessions.get("source_session_id").cloned().unwrap_or(Value::Null),
            "decision": normalize_decision(&get_string_any(input, &["decision"]), true)
        });
    }

    let root_dir_value = get_string_any(input, &["root_dir", "rootDir"]);
    let root_dir = if root_dir_value.is_empty() {
        None
    } else {
        Some(root_dir_value.as_str())
    };
    let checkpoint = latest_checkpoint_from_scratchpad(root, &task_id, root_dir);

    if checkpoint.get("ok").and_then(Value::as_bool) != Some(true) {
        return json!({
            "ok": false,
            "type": "orchestration_partial_retrieval",
            "reason_code": "partial_results_unavailable",
            "task_id": task_id,
            "attempted_sources": ["session_history", "checkpoint"],
            "checkpoint_reason": checkpoint.get("reason_code").cloned().unwrap_or(Value::Null)
        });
    }

    json!({
        "ok": true,
        "type": "orchestration_partial_retrieval",
        "source": checkpoint.get("source").cloned().unwrap_or(Value::Null),
        "task_id": task_id,
        "items_completed": checkpoint.get("items_completed").cloned().unwrap_or(Value::Null),
        "findings_sofar": checkpoint.get("findings_sofar").cloned().unwrap_or(Value::Array(Vec::new())),
        "checkpoint_path": checkpoint.get("checkpoint_path").cloned().unwrap_or(Value::Null),
        "retry_allowed": checkpoint.get("retry_allowed").cloned().unwrap_or(Value::Bool(false)),
        "decision": normalize_decision(&get_string_any(input, &["decision"]), true)
    })
}

fn partition_work(items: &[Value], agent_count: i64) -> Vec<Value> {
    let count = agent_count.max(1) as usize;
    let mut partitions = (0..count)
        .map(|idx| {
            json!({
                "agent_id": format!("agent-{}", idx + 1),
                "items": []
            })
        })
        .collect::<Vec<_>>();

    for (index, item) in items.iter().enumerate() {
        if let Some(rows) = partitions
            .get_mut(index % count)
            .and_then(|partition| partition.get_mut("items"))
            .and_then(Value::as_array_mut)
        {
            rows.push(item.clone());
        }
    }

    partitions
}

fn merge_evidence(rows: &[Value]) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    for row in rows {
        if !row.is_object() {
            continue;
        }
        let key = format!(
            "{}:{}:{}",
            to_clean_string(row.get("type")),
            to_clean_string(row.get("value")),
            to_clean_string(row.get("source"))
        );
        if seen.insert(key) {
            merged.push(row.clone());
        }
    }
    merged
}

fn merge_findings(findings: &[Value]) -> Value {
    let mut buckets: BTreeMap<String, Value> = BTreeMap::new();
    let mut dropped = Vec::new();

    for raw in findings {
        let normalized = normalize_finding(raw);
        let (ok, reason) = validate_finding(&normalized);
        if !ok {
            dropped.push(json!({
                "reason_code": reason,
                "finding": normalized
            }));
            continue;
        }

        let item_id = to_clean_string(normalized.get("item_id"));
        if item_id.is_empty() {
            dropped.push(json!({
                "reason_code": "finding_invalid_item_id",
                "finding": normalized
            }));
            continue;
        }

        if let Some(existing) = buckets.get_mut(&item_id) {
            let existing_severity = to_clean_string(existing.get("severity")).to_ascii_lowercase();
            let existing_status = to_clean_string(existing.get("status")).to_ascii_lowercase();
            let next_severity = to_clean_string(normalized.get("severity")).to_ascii_lowercase();
            let next_status = to_clean_string(normalized.get("status")).to_ascii_lowercase();

            if severity_order(&next_severity) > severity_order(&existing_severity) {
                if let Value::Object(map) = existing {
                    map.insert("severity".to_string(), Value::String(next_severity));
                }
            }
            if status_order(&next_status) > status_order(&existing_status) {
                if let Value::Object(map) = existing {
                    map.insert("status".to_string(), Value::String(next_status));
                }
            }

            let evidence = [
                existing
                    .get("evidence")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                normalized
                    .get("evidence")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            ]
            .concat();
            let existing_ts = to_clean_string(existing.get("timestamp"));
            let existing_summary = to_clean_string(existing.get("summary"));
            if let Value::Object(map) = existing {
                map.insert("evidence".to_string(), Value::Array(merge_evidence(&evidence)));

                let next_ts = to_clean_string(normalized.get("timestamp"));
                let max_ts = if existing_ts > next_ts { existing_ts } else { next_ts };
                map.insert("timestamp".to_string(), Value::String(max_ts));

                let summary = [
                    existing_summary,
                    to_clean_string(normalized.get("summary")),
                ]
                .into_iter()
                .filter(|row| !row.is_empty())
                .collect::<Vec<_>>()
                .join(" | ");
                if !summary.is_empty() {
                    map.insert("summary".to_string(), Value::String(summary));
                }
            }
        } else {
            buckets.insert(item_id, normalized);
        }
    }

    let mut merged = buckets.values().cloned().collect::<Vec<_>>();
    merged.sort_by(|left, right| {
        let left_severity = to_clean_string(left.get("severity")).to_ascii_lowercase();
        let right_severity = to_clean_string(right.get("severity")).to_ascii_lowercase();
        let severity_cmp = severity_order(&right_severity).cmp(&severity_order(&left_severity));
        if severity_cmp != std::cmp::Ordering::Equal {
            return severity_cmp;
        }
        let left_id = to_clean_string(left.get("item_id"));
        let right_id = to_clean_string(right.get("item_id"));
        left_id.cmp(&right_id)
    });

    json!({
        "merged": merged,
        "dropped": dropped,
        "deduped_count": (findings.len() as i64) - (merged.len() as i64) - (dropped.len() as i64)
    })
}

fn assign_scopes_to_partitions(partitions: &[Value], normalized_scopes: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for (index, partition) in partitions.iter().enumerate() {
        let scope = if normalized_scopes.is_empty() {
            Value::Null
        } else {
            normalized_scopes[index % normalized_scopes.len()].clone()
        };
        let mut row = get_object(partition);
        row.insert("scope".to_string(), scope);
        out.push(Value::Object(row));
    }
    out
}

fn scope_map_by_agent(partitions: &[Value]) -> HashMap<String, Value> {
    let mut out = HashMap::new();
    for partition in partitions {
        let agent_id = to_clean_string(partition.get("agent_id"));
        let scope = partition.get("scope").cloned().unwrap_or(Value::Null);
        if !agent_id.is_empty() && scope.is_object() {
            out.insert(agent_id, scope);
        }
    }
    out
}

fn apply_scope_filtering(findings: &[Value], scope_by_agent: &HashMap<String, Value>) -> Value {
    let mut kept = Vec::new();
    let mut violations = Vec::new();

    for raw in findings {
        let finding = normalize_finding(raw);
        let agent_id = {
            let direct = to_clean_string(finding.get("agent_id"));
            if !direct.is_empty() {
                direct
            } else {
                finding
                    .get("metadata")
                    .and_then(Value::as_object)
                    .and_then(|meta| meta.get("agent_id"))
                    .map(|v| to_clean_string(Some(v)))
                    .unwrap_or_default()
            }
        };

        if agent_id.is_empty() || !scope_by_agent.contains_key(&agent_id) {
            kept.push(finding);
            continue;
        }

        let scope = scope_by_agent.get(&agent_id).cloned().unwrap_or(Value::Null);
        let classified = classify_findings_by_scope(&[finding.clone()], &scope, &agent_id);
        if classified.get("ok").and_then(Value::as_bool) != Some(true) {
            violations.push(json!({
                "reason_code": "scope_classification_failed",
                "agent_id": agent_id,
                "item_id": finding.get("item_id").cloned().unwrap_or(Value::Null),
                "location": finding.get("location").cloned().unwrap_or(Value::Null)
            }));
            continue;
        }

        if let Some(rows) = classified.get("in_scope").and_then(Value::as_array) {
            if let Some(first) = rows.first() {
                kept.push(first.clone());
            }
        }

        if let Some(rows) = classified.get("violations").and_then(Value::as_array) {
            for row in rows {
                violations.push(row.clone());
            }
        }
    }

    json!({
        "kept": kept,
        "violations": violations
    })
}

fn stable_hash_short(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
        .chars()
        .take(12)
        .collect::<String>()
}

fn run_coordinator(root: &Path, input: &Value) -> Value {
    let task_id = get_string_any(input, &["task_id"]);
    if task_id.is_empty() {
        return json!({
            "ok": false,
            "type": "orchestration_coordinator",
            "reason_code": "missing_task_id"
        });
    }

    let audit_id = {
        let explicit = get_string_any(input, &["audit_id"]);
        if explicit.is_empty() {
            format!("audit-{}", stable_hash_short(&task_id))
        } else {
            explicit
        }
    };

    let items = input
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let findings = input
        .get("findings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let scopes = input
        .get("scopes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let agent_count = get_i64_any(input, &["agent_count"], 1).max(1);

    let root_dir_string = get_string_any(input, &["root_dir", "rootDir"]);
    let root_dir = if root_dir_string.is_empty() {
        None
    } else {
        Some(root_dir_string.as_str())
    };

    let scope_check = detect_scope_overlaps(&scopes);
    if scope_check.get("ok").and_then(Value::as_bool) != Some(true) {
        return json!({
            "ok": false,
            "type": "orchestration_coordinator",
            "reason_code": scope_check.get("reason_code").cloned().unwrap_or(Value::String("scope_overlap_detected".to_string())),
            "overlaps": scope_check.get("overlaps").cloned().unwrap_or(Value::Array(Vec::new())),
            "scope_id": scope_check.get("scope_id").cloned().unwrap_or(Value::Null)
        });
    }

    let normalized_scopes = scope_check
        .get("normalized_scopes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let partitions = assign_scopes_to_partitions(&partition_work(&items, agent_count), &normalized_scopes);
    let scope_by_agent = scope_map_by_agent(&partitions);

    let task_type = {
        let value = get_string_any(input, &["task_type"]);
        if value.is_empty() {
            "audit".to_string()
        } else {
            value
        }
    };
    let coordinator_session = {
        let session = get_string_any(input, &["coordinator_session"]);
        if session.is_empty() {
            Value::Null
        } else {
            Value::String(session)
        }
    };
    let agents = partitions
        .iter()
        .map(|partition| {
            json!({
                "agent_id": partition.get("agent_id").cloned().unwrap_or(Value::Null),
                "status": "running",
                "details": {
                    "scope_id": partition.get("scope").and_then(|scope| scope.get("scope_id")).cloned().unwrap_or(Value::Null)
                }
            })
        })
        .collect::<Vec<_>>();

    let task_group = ensure_task_group(
        root,
        &json!({
            "task_group_id": get_string_any(input, &["task_group_id"]),
            "task_type": task_type,
            "coordinator_session": coordinator_session,
            "agent_count": partitions.len() as i64,
            "agents": agents
        }),
        root_dir,
    );

    if task_group.get("ok").and_then(Value::as_bool) != Some(true) {
        return json!({
            "ok": false,
            "type": "orchestration_coordinator",
            "reason_code": task_group.get("reason_code").cloned().unwrap_or(Value::String("task_group_creation_failed".to_string()))
        });
    }

    let findings_with_audit = findings
        .iter()
        .map(|finding| {
            if let Value::Object(map) = finding {
                let mut row = map.clone();
                row.insert("audit_id".to_string(), Value::String(audit_id.clone()));
                Value::Object(row)
            } else {
                json!({ "audit_id": audit_id })
            }
        })
        .collect::<Vec<_>>();

    let filtered = apply_scope_filtering(&findings_with_audit, &scope_by_agent);
    let merged = merge_findings(
        &filtered
            .get("kept")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    );

    let updated_progress = json!({
        "processed": merged
            .get("merged")
            .and_then(Value::as_array)
            .map(|rows| rows.len())
            .unwrap_or(0),
        "total": items.len()
    });

    let write_progress = write_scratchpad(root, &task_id, &json!({ "progress": updated_progress }), root_dir);
    if write_progress.is_err() {
        return json!({
            "ok": false,
            "type": "orchestration_coordinator",
            "reason_code": write_progress.err().unwrap_or_else(|| "scratchpad_write_failed".to_string())
        });
    }

    let merged_findings = merged
        .get("merged")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for finding in &merged_findings {
        let out = append_finding(root, &task_id, &json!({
            "audit_id": audit_id,
            "item_id": finding.get("item_id").cloned().unwrap_or(Value::Null),
            "severity": finding.get("severity").cloned().unwrap_or(Value::Null),
            "status": finding.get("status").cloned().unwrap_or(Value::Null),
            "location": finding.get("location").cloned().unwrap_or(Value::Null),
            "evidence": finding.get("evidence").cloned().unwrap_or(Value::Array(Vec::new())),
            "timestamp": finding.get("timestamp").cloned().unwrap_or(Value::String(now_iso())),
            "summary": finding.get("summary").cloned().unwrap_or(Value::Null),
            "agent_id": finding.get("agent_id").cloned().unwrap_or(Value::Null),
            "metadata": finding.get("metadata").cloned().unwrap_or(Value::Null)
        }), root_dir);
        if out.get("ok").and_then(Value::as_bool) != Some(true) {
            return json!({
                "ok": false,
                "type": "orchestration_coordinator",
                "reason_code": out.get("reason_code").cloned().unwrap_or(Value::String("append_finding_failed".to_string())),
                "task_id": task_id,
                "audit_id": audit_id
            });
        }
    }

    let _ = maybe_checkpoint(
        root,
        &task_id,
        &json!({
            "processed_count": updated_progress.get("processed").cloned().unwrap_or(Value::Number(serde_json::Number::from(0))),
            "total_count": updated_progress.get("total").cloned().unwrap_or(Value::Number(serde_json::Number::from(0))),
            "now_ms": Utc::now().timestamp_millis()
        }),
        root_dir,
    );

    let completion = track_batch_completion(
        root,
        &to_clean_string(task_group.get("task_group").and_then(|v| v.get("task_group_id"))),
        &partitions
            .iter()
            .map(|partition| {
                json!({
                    "agent_id": partition.get("agent_id").cloned().unwrap_or(Value::Null),
                    "status": "done",
                    "details": {
                        "processed_count": partition
                            .get("items")
                            .and_then(Value::as_array)
                            .map(|rows| rows.len())
                            .unwrap_or(0),
                        "scope_id": partition
                            .get("scope")
                            .and_then(|scope| scope.get("scope_id"))
                            .cloned()
                            .unwrap_or(Value::Null)
                    }
                })
            })
            .collect::<Vec<_>>(),
        root_dir,
    );

    if completion.get("ok").and_then(Value::as_bool) != Some(true) {
        return json!({
            "ok": false,
            "type": "orchestration_coordinator",
            "reason_code": completion.get("reason_code").cloned().unwrap_or(Value::String("completion_tracking_failed".to_string())),
            "task_id": task_id,
            "audit_id": audit_id
        });
    }

    json!({
        "ok": true,
        "type": "orchestration_coordinator",
        "task_id": task_id,
        "audit_id": audit_id,
        "task_group_id": task_group.get("task_group").and_then(|v| v.get("task_group_id")).cloned().unwrap_or(Value::Null),
        "partition_count": partitions.len(),
        "partitions": partitions,
        "findings_total": findings.len(),
        "findings_in_scope": filtered.get("kept").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0),
        "findings_merged": merged_findings.len(),
        "findings_deduped": get_i64_any(&merged, &["deduped_count"], 0),
        "findings_dropped": merged.get("dropped").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0),
        "scope_violation_count": filtered.get("violations").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0),
        "scope_violations": filtered.get("violations").cloned().unwrap_or(Value::Array(Vec::new())),
        "completion_summary": completion.get("summary").cloned().unwrap_or(Value::Null),
        "notification": completion.get("notification").cloned().unwrap_or(Value::Null),
        "report": {
            "findings": merged.get("merged").cloned().unwrap_or(Value::Array(Vec::new())),
            "dropped": merged.get("dropped").cloned().unwrap_or(Value::Array(Vec::new()))
        }
    })
}

fn invoke(root: &Path, op: &str, payload: &Value) -> Value {
    match op {
        "schema.validate_finding" => {
            let finding = payload.get("finding").cloned().unwrap_or_else(|| payload.clone());
            let normalized = normalize_finding(&finding);
            let (ok, reason_code) = validate_finding(&normalized);
            json!({
                "ok": ok,
                "type": "orchestration_schema_validate_finding",
                "reason_code": reason_code,
                "finding": normalized
            })
        }
        "schema.normalize_finding" => {
            let finding = payload.get("finding").cloned().unwrap_or_else(|| payload.clone());
            json!({
                "ok": true,
                "type": "orchestration_schema_normalize_finding",
                "finding": normalize_finding(&finding)
            })
        }
        "scope.detect_overlaps" => {
            let scopes = payload
                .get("scopes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut out = detect_scope_overlaps(&scopes);
            if let Value::Object(map) = &mut out {
                map.insert(
                    "type".to_string(),
                    Value::String("orchestration_scope_validate".to_string()),
                );
            }
            out
        }
        "scope.classify_findings" => {
            let findings = payload
                .get("findings")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let scope = payload.get("scope").cloned().unwrap_or(Value::Object(Map::new()));
            let agent_id = get_string_any(payload, &["agent_id", "agentId"]);
            classify_findings_by_scope(&findings, &scope, &agent_id)
        }
        "scratchpad.path" => {
            let task_id = get_string_any(payload, &["task_id", "taskId"]);
            let root_dir = payload_root_dir(payload);
            let out = scratchpad_path(
                root,
                &task_id,
                root_dir.as_deref(),
            );
            match out {
                Ok(file_path) => json!({
                    "ok": true,
                    "type": "orchestration_scratchpad_path",
                    "task_id": task_id,
                    "file_path": file_path
                }),
                Err(err) => json!({
                    "ok": false,
                    "type": "orchestration_scratchpad_path",
                    "reason_code": err,
                    "task_id": task_id
                }),
            }
        }
        "scratchpad.status" => {
            let task_id = get_string_any(payload, &["task_id", "taskId"]);
            let root_dir = payload_root_dir(payload);
            match load_scratchpad(
                root,
                &task_id,
                root_dir.as_deref(),
            ) {
                Ok(loaded) => json!({
                    "ok": true,
                    "type": "orchestration_scratchpad_status",
                    "task_id": task_id,
                    "file_path": loaded.file_path,
                    "exists": loaded.exists,
                    "scratchpad": loaded.scratchpad
                }),
                Err(err) => json!({
                    "ok": false,
                    "type": "orchestration_scratchpad_status",
                    "reason_code": err,
                    "task_id": task_id
                }),
            }
        }
        "scratchpad.write" => {
            let task_id = get_string_any(payload, &["task_id", "taskId"]);
            let patch = payload.get("patch").cloned().unwrap_or_else(|| payload.clone());
            let root_dir = payload_root_dir(payload);
            match write_scratchpad(
                root,
                &task_id,
                &patch,
                root_dir.as_deref(),
            ) {
                Ok(value) => value,
                Err(err) => json!({
                    "ok": false,
                    "type": "orchestration_scratchpad_write",
                    "reason_code": err,
                    "task_id": task_id
                }),
            }
        }
        "scratchpad.append_finding" => {
            let task_id = get_string_any(payload, &["task_id", "taskId"]);
            let finding = payload.get("finding").cloned().unwrap_or(Value::Object(Map::new()));
            let root_dir = payload_root_dir(payload);
            append_finding(
                root,
                &task_id,
                &finding,
                root_dir.as_deref(),
            )
        }
        "scratchpad.append_checkpoint" => {
            let task_id = get_string_any(payload, &["task_id", "taskId"]);
            let checkpoint = payload
                .get("checkpoint")
                .cloned()
                .unwrap_or(Value::Object(Map::new()));
            let root_dir = payload_root_dir(payload);
            append_checkpoint(
                root,
                &task_id,
                &checkpoint,
                root_dir.as_deref(),
            )
        }
        "scratchpad.cleanup" => {
            let task_id = get_string_any(payload, &["task_id", "taskId"]);
            let root_dir = payload_root_dir(payload);
            cleanup_scratchpad(
                root,
                &task_id,
                root_dir.as_deref(),
            )
        }
        "checkpoint.should" => {
            let state = payload.get("state").cloned().unwrap_or(Value::Object(Map::new()));
            let metrics = payload
                .get("metrics")
                .cloned()
                .unwrap_or(Value::Object(Map::new()));
            let options = payload
                .get("options")
                .cloned()
                .unwrap_or(Value::Object(Map::new()));
            json!({
                "ok": true,
                "type": "orchestration_checkpoint_should",
                "should_checkpoint": should_checkpoint(&state, &metrics, &options)
            })
        }
        "checkpoint.tick" => {
            let task_id = get_string_any(payload, &["task_id", "taskId"]);
            let metrics = payload
                .get("metrics")
                .cloned()
                .unwrap_or_else(|| payload.clone());
            let root_dir = payload_root_dir(payload);
            maybe_checkpoint(
                root,
                &task_id,
                &metrics,
                root_dir.as_deref(),
            )
        }
        "checkpoint.timeout" => {
            let task_id = get_string_any(payload, &["task_id", "taskId"]);
            let metrics = payload
                .get("metrics")
                .cloned()
                .unwrap_or_else(|| payload.clone());
            let root_dir = payload_root_dir(payload);
            handle_timeout(
                root,
                &task_id,
                &metrics,
                root_dir.as_deref(),
            )
        }
        "taskgroup.path" => {
            let task_group_id = get_string_any(payload, &["task_group_id", "taskGroupId", "id"]);
            let root_dir = payload_root_dir(payload);
            match taskgroup_path(
                root,
                &task_group_id,
                root_dir.as_deref(),
            ) {
                Ok(file_path) => json!({
                    "ok": true,
                    "type": "orchestration_taskgroup_path",
                    "task_group_id": task_group_id.to_ascii_lowercase(),
                    "file_path": file_path
                }),
                Err(err) => json!({
                    "ok": false,
                    "type": "orchestration_taskgroup_path",
                    "reason_code": err,
                    "task_group_id": task_group_id.to_ascii_lowercase()
                }),
            }
        }
        "taskgroup.ensure" => {
            let root_dir = payload_root_dir(payload);
            ensure_task_group(
                root,
                payload,
                root_dir.as_deref(),
            )
        }
        "taskgroup.query" => {
            let task_group_id = get_string_any(payload, &["task_group_id", "taskGroupId", "id"]);
            let root_dir = payload_root_dir(payload);
            query_task_group(
                root,
                &task_group_id,
                root_dir.as_deref(),
            )
        }
        "taskgroup.update_status" => {
            let task_group_id = get_string_any(payload, &["task_group_id", "taskGroupId", "id"]);
            let agent_id = get_string_any(payload, &["agent_id", "agentId"]);
            let status = get_string_any(payload, &["status"]);
            let details = payload.get("details").cloned().unwrap_or(Value::Object(Map::new()));
            let root_dir = payload_root_dir(payload);
            update_agent_status(
                root,
                &task_group_id,
                &agent_id,
                &status,
                &details,
                root_dir.as_deref(),
            )
        }
        "completion.status" => {
            let task_group_id = get_string_any(payload, &["task_group_id", "taskGroupId", "id"]);
            let root_dir = payload_root_dir(payload);
            ensure_and_summarize(
                root,
                &task_group_id,
                root_dir.as_deref(),
            )
        }
        "completion.track" => {
            let task_group_id = get_string_any(payload, &["task_group_id", "taskGroupId", "id"]);
            let update = payload.get("update").cloned().unwrap_or_else(|| payload.clone());
            let root_dir = payload_root_dir(payload);
            track_agent_completion(
                root,
                &task_group_id,
                &update,
                root_dir.as_deref(),
            )
        }
        "completion.batch" => {
            let task_group_id = get_string_any(payload, &["task_group_id", "taskGroupId", "id"]);
            let updates = payload
                .get("updates")
                .or_else(|| payload.get("updates_json"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let root_dir = payload_root_dir(payload);
            track_batch_completion(
                root,
                &task_group_id,
                &updates,
                root_dir.as_deref(),
            )
        }
        "partial.normalize_decision" => {
            let decision = get_string_any(payload, &["decision"]);
            let has_partial_results = payload
                .get("has_partial_results")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            json!({
                "ok": true,
                "type": "orchestration_partial_normalize_decision",
                "decision": normalize_decision(&decision, has_partial_results)
            })
        }
        "partial.fetch" => retrieve_partial_results(root, payload),
        "coordinator.partition" => {
            let items = payload
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let scopes = payload
                .get("scopes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let agent_count = get_i64_any(payload, &["agent_count", "agentCount"], 1).max(1);

            let scope_check = detect_scope_overlaps(&scopes);
            if scope_check.get("ok").and_then(Value::as_bool) != Some(true) {
                return json!({
                    "ok": false,
                    "type": "orchestration_partition",
                    "reason_code": scope_check.get("reason_code").cloned().unwrap_or(Value::String("scope_overlap_detected".to_string())),
                    "overlaps": scope_check.get("overlaps").cloned().unwrap_or(Value::Array(Vec::new()))
                });
            }
            let normalized_scopes = scope_check
                .get("normalized_scopes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let partitions = assign_scopes_to_partitions(&partition_work(&items, agent_count), &normalized_scopes);
            json!({
                "ok": true,
                "type": "orchestration_partition",
                "partitions": partitions
            })
        }
        "coordinator.merge_findings" => {
            let findings = payload
                .get("findings")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let merged = merge_findings(&findings);
            json!({
                "ok": true,
                "type": "orchestration_merge_findings",
                "merged": merged.get("merged").cloned().unwrap_or(Value::Array(Vec::new())),
                "dropped": merged.get("dropped").cloned().unwrap_or(Value::Array(Vec::new())),
                "deduped_count": merged.get("deduped_count").cloned().unwrap_or(Value::Number(serde_json::Number::from(0)))
            })
        }
        "coordinator.run" => run_coordinator(root, payload),
        _ => json!({
            "ok": false,
            "type": "orchestration_invoke",
            "reason_code": format!("unsupported_op:{op}")
        }),
    }
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let command = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "invoke".to_string());

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    if command != "invoke" {
        usage();
        let payload = json!({
            "ok": false,
            "type": "orchestration_command",
            "reason_code": format!("unsupported_command:{command}"),
            "commands": ["invoke", "help"]
        });
        print_json_line(&payload);
        return 1;
    }

    let op = parsed
        .flags
        .get("op")
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    if op.is_empty() {
        let payload = json!({
            "ok": false,
            "type": "orchestration_invoke",
            "reason_code": "missing_op"
        });
        print_json_line(&payload);
        return 1;
    }

    let payload_raw = parsed
        .flags
        .get("payload-json")
        .or_else(|| parsed.flags.get("payload_json"))
        .cloned()
        .unwrap_or_else(|| "{}".to_string());
    let payload = match serde_json::from_str::<Value>(&payload_raw) {
        Ok(value) => value,
        Err(_) => {
            let out = json!({
                "ok": false,
                "type": "orchestration_invoke",
                "reason_code": "invalid_payload_json"
            });
            print_json_line(&out);
            return 1;
        }
    };

    let out = invoke(root, &op, &payload);
    print_json_line(&out);
    if out.get("ok").and_then(Value::as_bool) == Some(true) {
        0
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_decision_defaults_to_retry_without_partials() {
        assert_eq!(normalize_decision("", false), "retry");
        assert_eq!(normalize_decision("continue", false), "continue");
    }

    #[test]
    fn finding_validation_rejects_invalid_severity() {
        let finding = json!({
            "audit_id": "a",
            "item_id": "b",
            "severity": "fatal",
            "status": "open",
            "location": "x:1",
            "evidence": [{ "type": "receipt", "value": "r" }],
            "timestamp": now_iso()
        });
        let normalized = normalize_finding(&finding);
        let (ok, reason) = validate_finding(&normalized);
        assert!(!ok);
        assert_eq!(reason, "finding_invalid_severity");
    }
}
