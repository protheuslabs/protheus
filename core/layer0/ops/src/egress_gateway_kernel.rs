// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use chrono::TimeZone;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_POLICY_REL: &str = "config/egress_gateway_policy.json";
const DEFAULT_STATE_REL: &str = "local/state/security/egress_gateway/state.json";
const DEFAULT_AUDIT_REL: &str = "local/state/security/egress_gateway/audit.jsonl";

#[derive(Clone, Debug)]
struct ScopeRule {
    id: String,
    methods: Vec<String>,
    domains: Vec<String>,
    require_runtime_allowlist: bool,
    rate_caps: RateCaps,
}

#[derive(Clone, Debug, Default)]
struct RateCaps {
    per_hour: Option<u64>,
    per_day: Option<u64>,
}

#[derive(Clone, Debug)]
struct Policy {
    version: String,
    default_decision: String,
    global_rate_caps: RateCaps,
    scopes: BTreeMap<String, ScopeRule>,
}

fn usage() {
    println!("egress-gateway-kernel commands:");
    println!("  protheus-ops egress-gateway-kernel load-policy [--payload-base64=<json>]");
    println!("  protheus-ops egress-gateway-kernel load-state [--payload-base64=<json>]");
    println!("  protheus-ops egress-gateway-kernel authorize --payload-base64=<json>");
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
            .map_err(|err| format!("egress_gateway_kernel_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("egress_gateway_kernel_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("egress_gateway_kernel_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("egress_gateway_kernel_payload_decode_failed:{err}"));
    }
    Ok(json!({}))
}

fn payload_obj<'a>(value: &'a Value) -> &'a Map<String, Value> {
    value.as_object().unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        EMPTY.get_or_init(Map::new)
    })
}

fn as_str(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(v)) => v.trim().to_string(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string().trim_matches('"').trim().to_string(),
    }
}

fn clean_text(value: Option<&Value>, max_len: usize) -> String {
    let mut out = as_str(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if out.len() > max_len {
        out.truncate(max_len);
    }
    out
}

fn normalize_token(raw: &str, max_len: usize) -> String {
    let mut out = String::new();
    let mut prev_sep = false;
    for ch in raw.chars() {
        let lower = ch.to_ascii_lowercase();
        let keep = matches!(lower, 'a'..='z' | '0'..='9' | '_' | '.' | ':' | '/' | '-');
        if keep {
            out.push(lower);
            prev_sep = false;
        } else if !prev_sep {
            out.push('_');
            prev_sep = true;
        }
        if out.len() >= max_len {
            break;
        }
    }
    out.trim_matches('_').to_string()
}

fn workspace_root(root: &Path) -> PathBuf {
    if let Ok(raw) = std::env::var("PROTHEUS_WORKSPACE_ROOT") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    root.to_path_buf()
}

fn runtime_root(root: &Path, payload: &Map<String, Value>) -> PathBuf {
    let explicit = clean_text(payload.get("root"), 520);
    if !explicit.is_empty() {
        return PathBuf::from(explicit);
    }
    if let Ok(raw) = std::env::var("PROTHEUS_RUNTIME_ROOT") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let workspace = workspace_root(root);
    let candidate = workspace.join("client").join("runtime");
    if candidate.exists() {
        candidate
    } else {
        workspace
    }
}

fn resolve_path(runtime_root: &Path, explicit: &str, fallback_rel: &str) -> PathBuf {
    let trimmed = explicit.trim();
    if trimmed.is_empty() {
        return runtime_root.join(fallback_rel);
    }
    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute() {
        candidate
    } else {
        runtime_root.join(trimmed)
    }
}

fn read_json_or_default(file_path: &Path, fallback: Value) -> Value {
    match fs::read_to_string(file_path) {
        Ok(raw) => serde_json::from_str::<Value>(&raw).unwrap_or(fallback),
        Err(_) => fallback,
    }
}

fn write_json_atomic(file_path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("egress_gateway_kernel_create_dir_failed:{err}"))?;
    }
    let tmp_path = file_path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    fs::write(
        &tmp_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(value)
                .map_err(|err| format!("egress_gateway_kernel_encode_failed:{err}"))?
        ),
    )
    .map_err(|err| format!("egress_gateway_kernel_write_failed:{err}"))?;
    fs::rename(&tmp_path, file_path)
        .map_err(|err| format!("egress_gateway_kernel_rename_failed:{err}"))?;
    Ok(())
}

fn append_jsonl(file_path: &Path, row: &Value) -> Result<(), String> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("egress_gateway_kernel_create_dir_failed:{err}"))?;
    }
    use std::io::Write;
    let mut handle = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file_path)
        .map_err(|err| format!("egress_gateway_kernel_open_failed:{err}"))?;
    handle
        .write_all(format!("{}\n", serde_json::to_string(row).unwrap_or_else(|_| "null".to_string())).as_bytes())
        .map_err(|err| format!("egress_gateway_kernel_append_failed:{err}"))?;
    Ok(())
}

fn parse_host(raw_url: &str) -> String {
    let normalized = raw_url.trim();
    if normalized.is_empty() {
        return String::new();
    }
    let lower = normalized.to_ascii_lowercase();
    let without_scheme = if let Some(idx) = lower.find("://") {
        &lower[(idx + 3)..]
    } else {
        lower.as_str()
    };
    let host_port = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .trim();
    host_port
        .split('@')
        .next_back()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

fn domain_matches(host: &str, domain: &str) -> bool {
    let needle = domain.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return false;
    }
    host == needle || host.ends_with(&format!(".{needle}"))
}

fn clean_methods(value: Option<&Value>) -> Vec<String> {
    let mut methods = value
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| normalize_token(&as_str(Some(row)), 20).to_ascii_uppercase())
                .filter(|row| !row.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if methods.is_empty() {
        methods.push("GET".to_string());
    }
    methods
}

fn clean_domains(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| clean_text(Some(row), 160).to_ascii_lowercase())
                .filter(|row| !row.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn to_u64(value: Option<&Value>) -> Option<u64> {
    match value {
        Some(Value::Number(number)) => number.as_u64().or_else(|| number.as_i64().map(|raw| raw.max(0) as u64)),
        Some(Value::String(raw)) => raw.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn normalize_scope_rule(id: &str, raw_rule: &Map<String, Value>) -> ScopeRule {
    ScopeRule {
        id: normalize_token(id, 120),
        methods: clean_methods(raw_rule.get("methods")),
        domains: clean_domains(raw_rule.get("domains")),
        require_runtime_allowlist: raw_rule
            .get("require_runtime_allowlist")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        rate_caps: RateCaps {
            per_hour: raw_rule
                .get("rate_caps")
                .and_then(Value::as_object)
                .and_then(|row| to_u64(row.get("per_hour"))),
            per_day: raw_rule
                .get("rate_caps")
                .and_then(Value::as_object)
                .and_then(|row| to_u64(row.get("per_day"))),
        },
    }
}

fn load_policy_model(root: &Path, payload: &Map<String, Value>) -> (Policy, PathBuf) {
    let runtime = runtime_root(root, payload);
    let explicit = clean_text(
        payload
            .get("policy_path")
            .or_else(|| payload.get("path")),
        520,
    );
    let policy_env = std::env::var("EGRESS_GATEWAY_POLICY_PATH").unwrap_or_default();
    let policy_path = resolve_path(
        &runtime,
        if explicit.is_empty() {
            &policy_env
        } else {
            &explicit
        },
        DEFAULT_POLICY_REL,
    );
    let src = read_json_or_default(&policy_path, json!({}));
    let src_obj = src.as_object().cloned().unwrap_or_default();
    let scopes_raw = src_obj
        .get("scopes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut scopes = BTreeMap::new();
    for (id, row) in scopes_raw {
        if let Some(rule) = row.as_object() {
            let normalized = normalize_scope_rule(id.as_str(), rule);
            if !normalized.id.is_empty() {
                scopes.insert(normalized.id.clone(), normalized);
            }
        }
    }
    (
        Policy {
            version: {
                let value = clean_text(src_obj.get("version"), 32);
                if value.is_empty() {
                    "1.0".to_string()
                } else {
                    value
                }
            },
            default_decision: {
                let value = normalize_token(&clean_text(src_obj.get("default_decision"), 12), 12);
                if value.is_empty() {
                    "deny".to_string()
                } else {
                    value
                }
            },
            global_rate_caps: RateCaps {
                per_hour: src_obj
                    .get("global_rate_caps")
                    .and_then(Value::as_object)
                    .and_then(|row| to_u64(row.get("per_hour"))),
                per_day: src_obj
                    .get("global_rate_caps")
                    .and_then(Value::as_object)
                    .and_then(|row| to_u64(row.get("per_day"))),
            },
            scopes,
        },
        policy_path,
    )
}

fn policy_to_value(policy: &Policy) -> Value {
    let scopes = policy
        .scopes
        .iter()
        .map(|(id, rule)| {
            (
                id.clone(),
                json!({
                    "id": rule.id,
                    "methods": rule.methods,
                    "domains": rule.domains,
                    "require_runtime_allowlist": rule.require_runtime_allowlist,
                    "rate_caps": {
                        "per_hour": rule.rate_caps.per_hour,
                        "per_day": rule.rate_caps.per_day,
                    }
                }),
            )
        })
        .collect::<serde_json::Map<String, Value>>();
    json!({
        "version": policy.version,
        "default_decision": policy.default_decision,
        "global_rate_caps": {
            "per_hour": policy.global_rate_caps.per_hour,
            "per_day": policy.global_rate_caps.per_day,
        },
        "scopes": scopes,
    })
}

fn load_state_model(root: &Path, payload: &Map<String, Value>) -> (Value, PathBuf) {
    let runtime = runtime_root(root, payload);
    let explicit = clean_text(
        payload
            .get("state_path")
            .or_else(|| payload.get("path")),
        520,
    );
    let state_env = std::env::var("EGRESS_GATEWAY_STATE_PATH").unwrap_or_default();
    let state_path = resolve_path(
        &runtime,
        if explicit.is_empty() {
            &state_env
        } else {
            &explicit
        },
        DEFAULT_STATE_REL,
    );
    let src = read_json_or_default(&state_path, json!({}));
    let src_obj = src.as_object().cloned().unwrap_or_default();
    let updated_at = {
        let value = clean_text(src_obj.get("updated_at"), 80);
        if value.is_empty() {
            Value::Null
        } else {
            Value::String(value)
        }
    };
    let per_hour = src_obj
        .get("per_hour")
        .cloned()
        .filter(|value| value.is_object())
        .unwrap_or_else(|| json!({}));
    let per_day = src_obj
        .get("per_day")
        .cloned()
        .filter(|value| value.is_object())
        .unwrap_or_else(|| json!({}));
    let state = json!({
        "schema_id": "egress_gateway_state",
        "schema_version": "1.0",
        "updated_at": updated_at,
        "per_hour": per_hour,
        "per_day": per_day,
    });
    (state, state_path)
}

fn audit_path(root: &Path, payload: &Map<String, Value>) -> PathBuf {
    let runtime = runtime_root(root, payload);
    let explicit = clean_text(payload.get("audit_path"), 520);
    let audit_env = std::env::var("EGRESS_GATEWAY_AUDIT_PATH").unwrap_or_default();
    resolve_path(
        &runtime,
        if explicit.is_empty() {
            &audit_env
        } else {
            &explicit
        },
        DEFAULT_AUDIT_REL,
    )
}

fn resolve_scope_rule<'a>(policy: &'a Policy, scope_id: &str) -> Option<&'a ScopeRule> {
    if let Some(rule) = policy.scopes.get(scope_id) {
        return Some(rule);
    }
    if scope_id.starts_with("sensory.collector.") {
        return policy.scopes.get("sensory.collector.dynamic");
    }
    None
}

fn count_key(scope_id: &str, epoch_key: &str) -> String {
    format!("{scope_id}:{epoch_key}")
}

fn counter_value(map: &Map<String, Value>, key: &str) -> u64 {
    to_u64(map.get(key)).unwrap_or(0)
}

fn check_cap(map: &Map<String, Value>, key: &str, cap: Option<u64>) -> bool {
    match cap {
        Some(limit) if limit > 0 => counter_value(map, key) < limit,
        _ => true,
    }
}

fn set_counter(map: &mut Map<String, Value>, key: &str, value: u64) {
    map.insert(key.to_string(), Value::Number(serde_json::Number::from(value)));
}

fn increment_counter(map: &mut Map<String, Value>, key: &str) {
    let next = counter_value(map, key).saturating_add(1);
    set_counter(map, key, next);
}

fn iso_hour_key(now_ms: i64) -> String {
    chrono::Utc
        .timestamp_millis_opt(now_ms)
        .single()
        .unwrap_or_else(chrono::Utc::now)
        .format("%Y-%m-%dT%H")
        .to_string()
}

fn iso_day_key(now_ms: i64) -> String {
    chrono::Utc
        .timestamp_millis_opt(now_ms)
        .single()
        .unwrap_or_else(chrono::Utc::now)
        .format("%Y-%m-%d")
        .to_string()
}

fn load_policy_command(root: &Path, payload: &Map<String, Value>) -> Value {
    let (policy, policy_path) = load_policy_model(root, payload);
    json!({
        "ok": true,
        "policy": policy_to_value(&policy),
        "policy_path": policy_path.to_string_lossy(),
    })
}

fn load_state_command(root: &Path, payload: &Map<String, Value>) -> Value {
    let (state, state_path) = load_state_model(root, payload);
    json!({
        "ok": true,
        "state": state,
        "state_path": state_path.to_string_lossy(),
    })
}

fn authorize_command(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let (policy, policy_path) = load_policy_model(root, payload);
    let (mut state, state_path) = load_state_model(root, payload);
    let audit_path = audit_path(root, payload);

    let scope_id = normalize_token(&clean_text(payload.get("scope"), 160), 160);
    let method = {
        let normalized = normalize_token(&clean_text(payload.get("method"), 20), 20).to_ascii_uppercase();
        if normalized.is_empty() { "GET".to_string() } else { normalized }
    };
    let caller = {
        let normalized = normalize_token(&clean_text(payload.get("caller"), 120), 120);
        if normalized.is_empty() { "unknown".to_string() } else { normalized }
    };
    let url = clean_text(payload.get("url"), 2000);
    let host = parse_host(&url);
    let runtime_allowlist = payload
        .get("runtime_allowlist")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| clean_text(Some(row), 160).to_ascii_lowercase())
                .filter(|row| !row.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let now_ms = to_u64(payload.get("now_ms"))
        .map(|value| value as i64)
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    let apply = payload.get("apply").and_then(Value::as_bool).unwrap_or(true);
    let ts = chrono::Utc
        .timestamp_millis_opt(now_ms)
        .single()
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let hour_key = iso_hour_key(now_ms);
    let day_key = iso_day_key(now_ms);

    let mut out = json!({
        "ok": true,
        "type": "egress_gateway_decision",
        "ts": ts,
        "scope": scope_id,
        "caller": caller,
        "method": method,
        "url": url,
        "host": host,
        "allow": false,
        "reason": "unknown",
        "code": "unknown",
        "policy_path": policy_path.to_string_lossy(),
        "state_path": state_path.to_string_lossy(),
        "audit_path": audit_path.to_string_lossy(),
    });

    let Some(rule) = resolve_scope_rule(&policy, &scope_id) else {
        let allow = policy.default_decision == "allow";
        out["allow"] = Value::Bool(allow);
        let reason = if allow { "default_allow" } else { "scope_not_allowlisted" };
        out["reason"] = Value::String(reason.to_string());
        out["code"] = Value::String(reason.to_string());
        return Ok(out);
    };

    if !rule.methods.iter().any(|row| row == &method) {
        out["reason"] = Value::String("method_not_allowlisted".to_string());
        out["code"] = Value::String("method_not_allowlisted".to_string());
        return Ok(out);
    }

    if host.is_empty() {
        out["reason"] = Value::String("invalid_url".to_string());
        out["code"] = Value::String("invalid_url".to_string());
        return Ok(out);
    }

    if !rule.domains.is_empty() && !rule.domains.iter().any(|domain| domain_matches(&host, domain)) {
        out["reason"] = Value::String("domain_not_allowlisted".to_string());
        out["code"] = Value::String("domain_not_allowlisted".to_string());
        return Ok(out);
    }

    if rule.require_runtime_allowlist {
        if runtime_allowlist.is_empty() {
            out["reason"] = Value::String("runtime_allowlist_required".to_string());
            out["code"] = Value::String("runtime_allowlist_required".to_string());
            return Ok(out);
        }
        let runtime_allowed = runtime_allowlist
            .iter()
            .any(|domain| domain_matches(&host, domain));
        if !runtime_allowed {
            out["reason"] = Value::String("runtime_allowlist_blocked".to_string());
            out["code"] = Value::String("runtime_allowlist_blocked".to_string());
            return Ok(out);
        }
    }

    let scope_hour_key = count_key(&scope_id, &hour_key);
    let scope_day_key = count_key(&scope_id, &day_key);
    let global_hour_key = count_key("__global__", &hour_key);
    let global_day_key = count_key("__global__", &day_key);

    let per_hour_view = state
        .get("per_hour")
        .and_then(Value::as_object)
        .ok_or_else(|| "egress_gateway_kernel_invalid_state_per_hour".to_string())?;
    let per_day_view = state
        .get("per_day")
        .and_then(Value::as_object)
        .ok_or_else(|| "egress_gateway_kernel_invalid_state_per_day".to_string())?;

    if !check_cap(per_hour_view, &scope_hour_key, rule.rate_caps.per_hour) {
        out["reason"] = Value::String("scope_hour_cap_exceeded".to_string());
        out["code"] = Value::String("scope_hour_cap_exceeded".to_string());
        return Ok(out);
    }
    if !check_cap(per_day_view, &scope_day_key, rule.rate_caps.per_day) {
        out["reason"] = Value::String("scope_day_cap_exceeded".to_string());
        out["code"] = Value::String("scope_day_cap_exceeded".to_string());
        return Ok(out);
    }
    if !check_cap(per_hour_view, &global_hour_key, policy.global_rate_caps.per_hour) {
        out["reason"] = Value::String("global_hour_cap_exceeded".to_string());
        out["code"] = Value::String("global_hour_cap_exceeded".to_string());
        return Ok(out);
    }
    if !check_cap(per_day_view, &global_day_key, policy.global_rate_caps.per_day) {
        out["reason"] = Value::String("global_day_cap_exceeded".to_string());
        out["code"] = Value::String("global_day_cap_exceeded".to_string());
        return Ok(out);
    }

    out["allow"] = Value::Bool(true);
    out["reason"] = Value::String("ok".to_string());
    out["code"] = Value::String("ok".to_string());
    out["scope_resolved"] = Value::String(rule.id.clone());

    if apply {
        let per_hour = state
            .get_mut("per_hour")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "egress_gateway_kernel_invalid_state_per_hour".to_string())?;
        increment_counter(per_hour, &scope_hour_key);
        increment_counter(per_hour, &global_hour_key);
        let per_day = state
            .get_mut("per_day")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "egress_gateway_kernel_invalid_state_per_day".to_string())?;
        increment_counter(per_day, &scope_day_key);
        increment_counter(per_day, &global_day_key);
        state["updated_at"] = Value::String(ts.clone());
        write_json_atomic(&state_path, &state)?;
        append_jsonl(&audit_path, &out)?;
    }

    Ok(out)
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    if argv
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        usage();
        return 0;
    }

    let command = argv
        .first()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "authorize".to_string());
    let payload = match payload_json(argv) {
        Ok(value) => value,
        Err(err) => {
            print_json_line(&cli_error("egress_gateway_kernel_error", err.as_str()));
            return 1;
        }
    };
    let payload = payload_obj(&payload);

    let receipt = match command.as_str() {
        "load-policy" => cli_receipt("egress_gateway_kernel_load_policy", load_policy_command(root, payload)),
        "load-state" => cli_receipt("egress_gateway_kernel_load_state", load_state_command(root, payload)),
        "authorize" => match authorize_command(root, payload) {
            Ok(value) => cli_receipt("egress_gateway_kernel_authorize", value),
            Err(err) => cli_error("egress_gateway_kernel_error", err.as_str()),
        },
        _ => {
            usage();
            cli_error(
                "egress_gateway_kernel_error",
                "egress_gateway_kernel_unknown_command",
            )
        }
    };

    let exit_code = if receipt.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        0
    } else {
        1
    };
    print_json_line(&receipt);
    exit_code
}
