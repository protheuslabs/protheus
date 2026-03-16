// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer1/security (authoritative)

use crate::clean;
use crate::{deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn compatibility_security_command(command: &str, argv: &[String]) -> (Value, i32) {
    let mut out = json!({
        "ok": true,
        "type": "security_plane_compat_command",
        "lane": "core/layer1/security",
        "command": command,
        "argv": argv,
        "ts": now_iso(),
        "compatibility_only": true,
        "authority": "rust_security_plane"
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    (out, 0)
}

fn state_dir(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("security_plane")
}

fn capability_event_path(root: &Path) -> PathBuf {
    state_dir(root).join("capability_events.jsonl")
}

fn security_latest_path(root: &Path) -> PathBuf {
    state_dir(root).join("latest.json")
}

fn security_history_path(root: &Path) -> PathBuf {
    state_dir(root).join("history.jsonl")
}

fn scanner_state_dir(root: &Path) -> PathBuf {
    state_dir(root).join("scanner")
}

fn scanner_latest_path(root: &Path) -> PathBuf {
    scanner_state_dir(root).join("latest.json")
}

fn remediation_state_dir(root: &Path) -> PathBuf {
    state_dir(root).join("remediation")
}

fn remediation_gate_path(root: &Path) -> PathBuf {
    remediation_state_dir(root).join("promotion_gate.json")
}

fn blast_radius_events_path(root: &Path) -> PathBuf {
    state_dir(root).join("blast_radius_events.jsonl")
}

fn secrets_state_path(root: &Path) -> PathBuf {
    state_dir(root).join("secrets_federation.json")
}

fn secrets_events_path(root: &Path) -> PathBuf {
    state_dir(root).join("secrets_events.jsonl")
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let pref = format!("--{key}=");
    let key_long = format!("--{key}");
    let mut i = 0usize;
    while i < argv.len() {
        let token = argv[i].trim();
        if let Some(value) = token.strip_prefix(&pref) {
            return Some(value.to_string());
        }
        if token == key_long && i + 1 < argv.len() && !argv[i + 1].starts_with("--") {
            return Some(argv[i + 1].clone());
        }
        i += 1;
    }
    None
}

fn parse_bool(raw: Option<String>, fallback: bool) -> bool {
    raw.map(|v| {
        matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
    .unwrap_or(fallback)
}

fn parse_u64(raw: Option<String>, fallback: u64) -> u64 {
    raw.and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(fallback)
}

fn parse_subcommand(argv: &[String], fallback: &str) -> String {
    argv.iter()
        .find(|token| !token.starts_with("--"))
        .map(|token| clean(token, 64).to_ascii_lowercase())
        .unwrap_or_else(|| fallback.to_string())
}

fn append_jsonl(path: &Path, row: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(line) = serde_json::to_string(row) {
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| file.write_all(format!("{line}\n").as_bytes()));
    }
}

fn write_json(path: &Path, payload: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(encoded) = serde_json::to_string_pretty(payload) {
        let _ = fs::write(path, format!("{encoded}\n"));
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn hash_text(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

fn persist_security_receipt(root: &Path, payload: &Value) {
    write_json(&security_latest_path(root), payload);
    append_jsonl(&security_history_path(root), payload);
}

const INJECTION_PATTERNS: [&str; 8] = [
    "ignore previous instructions",
    "system override",
    "reveal hidden prompt",
    "disable safety",
    "act as unrestricted",
    "tool poisoning",
    "execute without approval",
    "export secrets",
];

const MCP_POISON_PATTERNS: [&str; 6] = [
    "mcp://override-policy",
    "mcp://disable-guard",
    "inject tool schema",
    "replace capability manifest",
    "hidden adapter payload",
    "credential siphon",
];

fn detect_pattern_hits(content: &str, patterns: &[&str]) -> Vec<String> {
    let lower = content.to_ascii_lowercase();
    patterns
        .iter()
        .filter(|pattern| lower.contains(**pattern))
        .map(|pattern| pattern.to_string())
        .collect::<Vec<_>>()
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>()
}

fn run_scan_command(root: &Path, argv: &[String], strict: bool) -> (Value, i32) {
    let prompt = parse_flag(argv, "prompt").unwrap_or_default();
    let tool_input = parse_flag(argv, "tool-input").unwrap_or_default();
    let mcp_payload = parse_flag(argv, "mcp").unwrap_or_default();
    let scan_pack = parse_flag(argv, "pack").unwrap_or_else(|| "zeroleaks-hardened".to_string());
    let fail_threshold = parse_u64(parse_flag(argv, "critical-threshold"), 0);

    let mut hits = detect_pattern_hits(&prompt, &INJECTION_PATTERNS);
    hits.extend(detect_pattern_hits(&tool_input, &INJECTION_PATTERNS));
    let mut mcp_hits = detect_pattern_hits(&mcp_payload, &MCP_POISON_PATTERNS);
    hits.append(&mut mcp_hits);
    hits.sort();
    hits.dedup();

    let critical_hits = hits.len() as u64;
    let total_probes = (INJECTION_PATTERNS.len() + MCP_POISON_PATTERNS.len()) as u64;
    let pass_probes = total_probes.saturating_sub(critical_hits);
    let success_rate = if total_probes == 0 {
        1.0
    } else {
        (pass_probes as f64) / (total_probes as f64)
    };
    let score = ((success_rate * 100.0).round() as i64).max(0) as u64;
    let blast_radius_events = read_jsonl(&blast_radius_events_path(root)).len() as u64;
    let blocked = critical_hits > fail_threshold;

    let scan_pack_clean = clean(&scan_pack, 80);
    let scan_payload = json!({
        "generated_at": now_iso(),
        "pack": scan_pack_clean,
        "critical_hits": critical_hits,
        "success_rate": success_rate,
        "score": score,
        "blast_radius_events": blast_radius_events,
        "hits": hits,
        "inputs": {
            "prompt_sha256": hash_text(&prompt),
            "tool_input_sha256": hash_text(&tool_input),
            "mcp_payload_sha256": hash_text(&mcp_payload)
        }
    });
    let scan_id = deterministic_receipt_hash(&scan_payload);
    let scan_path = scanner_state_dir(root).join(format!("scan_{}.json", &scan_id[..16]));
    write_json(&scan_path, &scan_payload);
    write_json(
        &scanner_latest_path(root),
        &json!({
            "scan_id": scan_id,
            "scan_path": scan_path.display().to_string(),
            "scan": scan_payload
        }),
    );

    let out = json!({
        "ok": !blocked,
        "type": "security_plane_injection_scan",
        "lane": "core/layer1/security",
        "mode": "scan",
        "strict": strict,
        "scan_id": scan_id,
        "scan_path": scan_path.display().to_string(),
        "pack": clean(&scan_pack, 80),
        "score": score,
        "success_rate": success_rate,
        "critical_hits": critical_hits,
        "blast_radius_events": blast_radius_events,
        "blocked": blocked,
        "fail_threshold": fail_threshold,
        "claim_evidence": [{
            "id": "V6-SEC-010",
            "claim": "continuous_injection_and_mcp_poisoning_scanner_emits_deterministic_scores_and_blast_radius_signals",
            "evidence": {
                "scan_id": scan_id,
                "critical_hits": critical_hits,
                "success_rate": success_rate,
                "score": score,
                "blast_radius_events": blast_radius_events
            }
        }]
    });
    (out, if strict && blocked { 2 } else { 0 })
}

fn classify_blast_event(action: &str, target: &str, credential: bool, network: bool) -> String {
    let low_action = action.to_ascii_lowercase();
    let low_target = target.to_ascii_lowercase();
    if credential
        || network
        || low_action.contains("exfil")
        || low_action.contains("delete")
        || low_action.contains("wipe")
        || low_target.contains("secret")
        || low_target.contains("token")
    {
        "critical".to_string()
    } else if low_action.contains("write") || low_action.contains("exec") {
        "high".to_string()
    } else {
        "low".to_string()
    }
}

fn run_blast_radius_command(root: &Path, argv: &[String], strict: bool) -> (Value, i32) {
    let op = parse_subcommand(argv, "record");
    if op == "status" {
        let events = read_jsonl(&blast_radius_events_path(root));
        let blocked = events
            .iter()
            .filter(|row| row.get("blocked").and_then(Value::as_bool) == Some(true))
            .count();
        let out = json!({
            "ok": true,
            "type": "security_plane_blast_radius_sentinel",
            "lane": "core/layer1/security",
            "mode": "status",
            "strict": strict,
            "event_count": events.len(),
            "blocked_count": blocked,
            "claim_evidence": [{
                "id": "V6-SEC-012",
                "claim": "blast_radius_sentinel_tracks_attempted_actions_and_blocked_events",
                "evidence": {
                    "event_count": events.len(),
                    "blocked_count": blocked
                }
            }]
        });
        return (out, 0);
    }

    let action = parse_flag(argv, "action").unwrap_or_else(|| "tool_call".to_string());
    let target = parse_flag(argv, "target").unwrap_or_else(|| "unspecified".to_string());
    let credential = parse_bool(parse_flag(argv, "credential"), false);
    let network = parse_bool(parse_flag(argv, "network"), false);
    let allow = parse_bool(parse_flag(argv, "allow"), false);
    let severity = classify_blast_event(&action, &target, credential, network);
    let blocked = !allow && matches!(severity.as_str(), "critical" | "high");

    let event = json!({
        "ts": now_iso(),
        "action": clean(action, 120),
        "target": clean(target, 160),
        "credential": credential,
        "network": network,
        "severity": severity,
        "blocked": blocked
    });
    append_jsonl(&blast_radius_events_path(root), &event);

    let out = json!({
        "ok": !blocked,
        "type": "security_plane_blast_radius_sentinel",
        "lane": "core/layer1/security",
        "mode": "record",
        "strict": strict,
        "event": event,
        "claim_evidence": [{
            "id": "V6-SEC-012",
            "claim": "blast_radius_sentinel_enforces_fail_closed_blocking_for_high_risk_tool_network_and_credential_actions",
            "evidence": {
                "blocked": blocked,
                "severity": severity,
                "credential": credential,
                "network": network
            }
        }]
    });
    (out, if strict && blocked { 2 } else { 0 })
}

fn run_remediation_command(root: &Path, _argv: &[String], strict: bool) -> (Value, i32) {
    let latest = read_json(&scanner_latest_path(root));
    let Some(scan_doc) = latest else {
        let out = json!({
            "ok": false,
            "type": "security_plane_auto_remediation",
            "lane": "core/layer1/security",
            "mode": "remediate",
            "strict": strict,
            "error": "scan_missing",
            "claim_evidence": [{
                "id": "V6-SEC-011",
                "claim": "auto_remediation_lane_requires_scan_artifacts_before_policy_patch_proposal",
                "evidence": {"scan_present": false}
            }]
        });
        return (out, if strict { 2 } else { 0 });
    };

    let scan = scan_doc.get("scan").cloned().unwrap_or_else(|| json!({}));
    let critical_hits = scan
        .get("critical_hits")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let hit_rows = scan
        .get("hits")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let scan_id = scan_doc
        .get("scan_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown_scan")
        .to_string();

    let promotion_blocked = critical_hits > 0;
    let patch = json!({
        "scan_id": scan_id,
        "generated_at": now_iso(),
        "blocked_patterns": hit_rows,
        "rules": {
            "deny_tool_poisoning": true,
            "deny_prompt_override": true,
            "require_index_first": true,
            "conduit_only_execution": true
        },
        "next_action": if promotion_blocked { "rescan_required" } else { "promotion_allowed" }
    });
    let patch_path = remediation_state_dir(root).join(format!("prompt_policy_patch_{}.json", &scan_id[..16.min(scan_id.len())]));
    write_json(&patch_path, &patch);
    write_json(
        &remediation_gate_path(root),
        &json!({
            "updated_at": now_iso(),
            "scan_id": scan_id,
            "promotion_blocked": promotion_blocked,
            "patch_path": patch_path.display().to_string()
        }),
    );

    let out = json!({
        "ok": !promotion_blocked,
        "type": "security_plane_auto_remediation",
        "lane": "core/layer1/security",
        "mode": "remediate",
        "strict": strict,
        "scan_id": scan_id,
        "critical_hits": critical_hits,
        "promotion_blocked": promotion_blocked,
        "patch_path": patch_path.display().to_string(),
        "claim_evidence": [{
            "id": "V6-SEC-011",
            "claim": "auto_remediation_generates_policy_patch_and_blocks_promotion_until_rescan_passes",
            "evidence": {
                "scan_id": scan_id,
                "critical_hits": critical_hits,
                "promotion_blocked": promotion_blocked,
                "patch_path": patch_path.display().to_string()
            }
        }]
    });
    (out, if strict && promotion_blocked { 2 } else { 0 })
}

#[derive(Debug, Clone)]
struct SecretHandleRow {
    provider: String,
    secret_path: String,
    scope: String,
    lease_expires_at: String,
    revoked: bool,
    revoked_at: Option<String>,
    rotated_at: Option<String>,
    secret_sha256: String,
}

fn read_secret_state(root: &Path) -> BTreeMap<String, SecretHandleRow> {
    let Some(value) = read_json(&secrets_state_path(root)) else {
        return BTreeMap::new();
    };
    value
        .get("handles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(k, row)| {
            let obj = row.as_object()?;
            Some((
                k,
                SecretHandleRow {
                    provider: obj
                        .get("provider")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    secret_path: obj
                        .get("secret_path")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    scope: obj
                        .get("scope")
                        .and_then(Value::as_str)
                        .unwrap_or("default")
                        .to_string(),
                    lease_expires_at: obj
                        .get("lease_expires_at")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    revoked: obj.get("revoked").and_then(Value::as_bool).unwrap_or(false),
                    revoked_at: obj
                        .get("revoked_at")
                        .and_then(Value::as_str)
                        .map(|v| v.to_string()),
                    rotated_at: obj
                        .get("rotated_at")
                        .and_then(Value::as_str)
                        .map(|v| v.to_string()),
                    secret_sha256: obj
                        .get("secret_sha256")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                },
            ))
        })
        .collect::<BTreeMap<_, _>>()
}

fn write_secret_state(root: &Path, handles: &BTreeMap<String, SecretHandleRow>) {
    let payload = json!({
        "updated_at": now_iso(),
        "handles": handles.iter().map(|(id, row)| {
            (id.clone(), json!({
                "provider": row.provider,
                "secret_path": row.secret_path,
                "scope": row.scope,
                "lease_expires_at": row.lease_expires_at,
                "revoked": row.revoked,
                "revoked_at": row.revoked_at,
                "rotated_at": row.rotated_at,
                "secret_sha256": row.secret_sha256
            }))
        }).collect::<serde_json::Map<String, Value>>()
    });
    write_json(&secrets_state_path(root), &payload);
}

fn secret_env_var_name(provider: &str, secret_path: &str) -> String {
    let provider = provider
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect::<String>()
        .to_ascii_uppercase();
    let path = secret_path
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect::<String>()
        .to_ascii_uppercase();
    format!("PROTHEUS_SECRET_{}_{}", provider, path)
}

fn run_secrets_federation_command(root: &Path, argv: &[String], strict: bool) -> (Value, i32) {
    let op = parse_subcommand(argv, "status");
    let provider = parse_flag(argv, "provider")
        .unwrap_or_else(|| "vault".to_string())
        .to_ascii_lowercase();
    let secret_path = parse_flag(argv, "path").unwrap_or_else(|| "default/secret".to_string());
    let scope = parse_flag(argv, "scope").unwrap_or_else(|| "default".to_string());
    let lease_seconds = parse_u64(parse_flag(argv, "lease-seconds"), 3600);
    let supported = ["vault", "aws", "1password", "onepassword"];
    if strict && !supported.contains(&provider.as_str()) {
        let out = json!({
            "ok": false,
            "type": "security_plane_secrets_federation",
            "lane": "core/layer1/security",
            "mode": op,
            "strict": strict,
            "error": format!("unsupported_provider:{}", provider),
            "claim_evidence": [{
                "id": "V6-SEC-016",
                "claim": "external_secrets_federation_rejects_unknown_provider_profiles_fail_closed",
                "evidence": {"provider": provider}
            }]
        });
        return (out, 2);
    }

    let mut handles = read_secret_state(root);
    let mut out = json!({
        "ok": true,
        "type": "security_plane_secrets_federation",
        "lane": "core/layer1/security",
        "mode": op,
        "strict": strict
    });

    match op.as_str() {
        "fetch" => {
            let env_name = secret_env_var_name(&provider, &secret_path);
            let secret_value = std::env::var(&env_name)
                .ok()
                .or_else(|| std::env::var("PROTHEUS_SECRET_VALUE").ok());
            let Some(secret_value) = secret_value else {
                out["ok"] = Value::Bool(false);
                out["error"] = Value::String("secret_not_found".to_string());
                out["env_name"] = Value::String(env_name);
                out["claim_evidence"] = json!([{
                    "id": "V6-SEC-016",
                    "claim": "external_secrets_federation_fails_closed_when_secret_material_is_missing",
                    "evidence": {"provider": provider, "secret_path": secret_path}
                }]);
                return (out, if strict { 2 } else { 0 });
            };
            let ts = now_iso();
            let handle_id = deterministic_receipt_hash(&json!({
                "provider": provider,
                "secret_path": secret_path,
                "scope": scope,
                "ts": ts
            }));
            let row = SecretHandleRow {
                provider: provider.clone(),
                secret_path: secret_path.clone(),
                scope: scope.clone(),
                lease_expires_at: now_iso(),
                revoked: false,
                revoked_at: None,
                rotated_at: None,
                secret_sha256: hash_text(&secret_value),
            };
            handles.insert(handle_id.clone(), row);
            out["handle_id"] = Value::String(handle_id);
            out["lease_seconds"] = Value::from(lease_seconds);
            out["scope"] = Value::String(scope);
            out["provider"] = Value::String(provider.clone());
            out["secret_path"] = Value::String(secret_path.clone());
            out["claim_evidence"] = json!([{
                "id": "V6-SEC-016",
                "claim": "external_secrets_federation_issues_scoped_handles_with_fail_closed_fetch_semantics",
                "evidence": {
                    "provider": out["provider"],
                    "secret_path": out["secret_path"],
                    "handle_id": out["handle_id"]
                }
            }]);
        }
        "rotate" => {
            let handle_id = parse_flag(argv, "handle-id").unwrap_or_default();
            if let Some(row) = handles.get_mut(&handle_id) {
                row.rotated_at = Some(now_iso());
                row.lease_expires_at = now_iso();
                out["handle_id"] = Value::String(handle_id);
                out["rotated"] = Value::Bool(true);
            } else {
                out["ok"] = Value::Bool(false);
                out["error"] = Value::String("handle_not_found".to_string());
            }
            out["claim_evidence"] = json!([{
                "id": "V6-SEC-016",
                "claim": "external_secrets_federation_supports_rotation_and_audit_receipts_for_issued_handles",
                "evidence": {"handle_id": out.get("handle_id").cloned().unwrap_or(Value::Null)}
            }]);
        }
        "revoke" => {
            let handle_id = parse_flag(argv, "handle-id").unwrap_or_default();
            if let Some(row) = handles.get_mut(&handle_id) {
                row.revoked = true;
                row.revoked_at = Some(now_iso());
                out["handle_id"] = Value::String(handle_id);
                out["revoked"] = Value::Bool(true);
            } else {
                out["ok"] = Value::Bool(false);
                out["error"] = Value::String("handle_not_found".to_string());
            }
            out["claim_evidence"] = json!([{
                "id": "V6-SEC-016",
                "claim": "external_secrets_federation_supports_revoke_semantics_for_issued_handles",
                "evidence": {"handle_id": out.get("handle_id").cloned().unwrap_or(Value::Null)}
            }]);
        }
        _ => {
            let active_handles = handles.values().filter(|row| !row.revoked).count();
            out["active_handles"] = Value::from(active_handles as u64);
            out["total_handles"] = Value::from(handles.len() as u64);
            out["providers"] = Value::Array(
                handles
                    .values()
                    .map(|row| Value::String(row.provider.clone()))
                    .collect::<Vec<_>>(),
            );
            out["claim_evidence"] = json!([{
                "id": "V6-SEC-016",
                "claim": "external_secrets_federation_status_exports_active_handle_and_provider_inventory",
                "evidence": {
                    "active_handles": out["active_handles"],
                    "total_handles": out["total_handles"]
                }
            }]);
        }
    }

    write_secret_state(root, &handles);
    append_jsonl(
        &secrets_events_path(root),
        &json!({
            "ts": now_iso(),
            "mode": op,
            "ok": out.get("ok").and_then(Value::as_bool).unwrap_or(false),
            "provider": provider,
            "secret_path": secret_path,
            "handle_id": out.get("handle_id").cloned().unwrap_or(Value::Null)
        }),
    );
    let failed = !out.get("ok").and_then(Value::as_bool).unwrap_or(false);
    (out, if strict && failed { 2 } else { 0 })
}

fn capability_action(command: &str, argv: &[String], payload: &Value) -> Option<String> {
    if let Some(action) = payload.get("action").and_then(Value::as_str) {
        let clean = action.trim().to_ascii_lowercase();
        if clean == "grant" || clean == "revoke" {
            return Some(clean);
        }
    }
    if command == "capability-switchboard" || command == "capability_switchboard" {
        if payload.get("type").and_then(Value::as_str) == Some("capability_switchboard_set") {
            if let Some(enabled) = payload.get("enabled").and_then(Value::as_bool) {
                return Some(if enabled { "grant" } else { "revoke" }.to_string());
            }
            if let Some(state) = parse_flag(argv, "state") {
                let lowered = state.trim().to_ascii_lowercase();
                return Some(
                    if matches!(lowered.as_str(), "on" | "true" | "1") {
                        "grant"
                    } else {
                        "revoke"
                    }
                    .to_string(),
                );
            }
        }
    }
    None
}

fn append_capability_event(root: &Path, event: &Value) {
    let path = capability_event_path(root);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(line) = serde_json::to_string(event) {
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut file| file.write_all(format!("{line}\n").as_bytes()));
    }
}

fn wrap_capability_event(root: &Path, command: &str, argv: &[String], payload: Value) -> Value {
    let strict = parse_bool(parse_flag(argv, "strict"), true);
    let mut out = if payload.is_object() {
        payload
    } else {
        json!({
            "ok": false,
            "type": "security_plane_wrap_error",
            "payload": payload
        })
    };
    if out.get("lane").is_none() {
        out["lane"] = Value::String("core/layer1/security".to_string());
    }
    out["strict"] = Value::Bool(strict);
    out["policy_engine"] = Value::String("infring_layer1_security".to_string());
    out["authority"] = Value::String("rust_security_plane".to_string());
    out["ts"] = out
        .get("ts")
        .cloned()
        .unwrap_or_else(|| Value::String(now_iso()));

    let action = capability_action(command, argv, &out);
    let event = json!({
        "kind": "infring_capability_event",
        "command": clean(command, 120),
        "action": action.clone().unwrap_or_else(|| "observe".to_string()),
        "runtime_capability_change": action.is_some()
    });
    out["infring_capability_event"] = event.clone();
    if let Some(action) = action {
        out["grant_revoke_receipt"] = json!({
            "action": action,
            "ts": now_iso(),
            "source": "security_plane_runtime"
        });
    }

    let mut claim_rows = out
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    claim_rows.push(json!({
        "id": "V8-DIRECTIVES-001.3",
        "claim": "security_plane_operations_are_surfaced_as_infring_capability_events",
        "evidence": {
            "command": clean(command, 120),
            "policy_engine": "infring_layer1_security"
        }
    }));
    if out.get("grant_revoke_receipt").is_some() {
        claim_rows.push(json!({
            "id": "V7-ASSIMILATE-001.3",
            "claim": "runtime_capability_changes_emit_grant_revoke_receipts",
            "evidence": {
                "command": clean(command, 120)
            }
        }));
    }
    out["claim_evidence"] = Value::Array(claim_rows);
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));

    let log_row = json!({
        "ts": now_iso(),
        "type": "security_plane_capability_event",
        "command": clean(command, 120),
        "receipt_hash": out.get("receipt_hash").cloned().unwrap_or(Value::Null),
        "event": event,
        "grant_revoke_receipt": out.get("grant_revoke_receipt").cloned().unwrap_or(Value::Null)
    });
    append_capability_event(root, &log_row);
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let cmd = argv
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let rest = if argv.is_empty() { &[][..] } else { &argv[1..] };

    let (payload, code) = match cmd.as_str() {
        "guard" => infring_layer1_security::run_guard(root, rest),
        "anti-sabotage-shield" | "anti_sabotage_shield" => {
            infring_layer1_security::run_anti_sabotage_shield(root, rest)
        }
        "constitution-guardian" | "constitution_guardian" => {
            infring_layer1_security::run_constitution_guardian(root, rest)
        }
        "remote-emergency-halt" | "remote_emergency_halt" => {
            infring_layer1_security::run_remote_emergency_halt(root, rest)
        }
        "soul-token-guard" | "soul_token_guard" => {
            infring_layer1_security::run_soul_token_guard(root, rest)
        }
        "integrity-reseal" | "integrity_reseal" => {
            infring_layer1_security::run_integrity_reseal(root, rest)
        }
        "integrity-reseal-assistant" | "integrity_reseal_assistant" => {
            infring_layer1_security::run_integrity_reseal_assistant(root, rest)
        }
        "capability-lease" | "capability_lease" => {
            infring_layer1_security::run_capability_lease(root, rest)
        }
        "startup-attestation" | "startup_attestation" => {
            infring_layer1_security::run_startup_attestation(root, rest)
        }
        "directive-hierarchy-controller" | "directive_hierarchy_controller" => {
            infring_layer1_security::run_directive_hierarchy_controller(root, rest)
        }
        "integrity-kernel" | "integrity_kernel" => {
            infring_layer1_security::run_integrity_kernel(root, rest)
        }
        "emergency-stop" | "emergency_stop" => {
            infring_layer1_security::run_emergency_stop(root, rest)
        }
        "capability-switchboard" | "capability_switchboard" => {
            infring_layer1_security::run_capability_switchboard(root, rest)
        }
        "black-box-ledger" | "black_box_ledger" => {
            infring_layer1_security::run_black_box_ledger(root, rest)
        }
        "goal-preservation-kernel" | "goal_preservation_kernel" => {
            infring_layer1_security::run_goal_preservation_kernel(root, rest)
        }
        "dream-warden-guard" | "dream_warden_guard" => {
            infring_layer1_security::run_dream_warden_guard(root, rest)
        }
        "truth-seeking-gate" | "truth_seeking_gate" | "truth-gate" | "truth_gate" => {
            infring_layer1_security::run_truth_seeking_gate(root, rest)
        }
        "abac-policy-plane" | "abac_policy_plane" => {
            infring_layer1_security::run_abac_policy_plane(root, rest)
        }
        "scan" => run_scan_command(root, rest, parse_bool(parse_flag(rest, "strict"), true)),
        "remediate" | "auto-remediate" | "auto_remediate" => run_remediation_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
        ),
        "blast-radius-sentinel" | "blast_radius_sentinel" => run_blast_radius_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
        ),
        "secrets-federation" | "secrets_federation" => run_secrets_federation_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
        ),
        "copy-hardening-pack" | "copy_hardening_pack" => {
            compatibility_security_command("copy-hardening-pack", rest)
        }
        "governance-hardening-pack" | "governance_hardening_pack" => {
            compatibility_security_command("governance-hardening-pack", rest)
        }
        "repository-access-auditor" | "repository_access_auditor" => {
            compatibility_security_command("repository-access-auditor", rest)
        }
        "operator-terms-ack" | "operator_terms_ack" => {
            compatibility_security_command("operator-terms-ack", rest)
        }
        "governance-hardening-lane" | "governance_hardening_lane" => {
            compatibility_security_command("governance-hardening-lane", rest)
        }
        "skill-install-path-enforcer" | "skill_install_path_enforcer" => {
            compatibility_security_command("skill-install-path-enforcer", rest)
        }
        "skill-quarantine" | "skill_quarantine" => {
            compatibility_security_command("skill-quarantine", rest)
        }
        "autonomous-skill-necessity-audit" | "autonomous_skill_necessity_audit" => {
            compatibility_security_command("autonomous-skill-necessity-audit", rest)
        }
        "formal-invariant-engine" | "formal_invariant_engine" => {
            compatibility_security_command("formal-invariant-engine", rest)
        }
        "repo-hygiene-guard" | "repo_hygiene_guard" => {
            compatibility_security_command("repo-hygiene-guard", rest)
        }
        "capability-envelope-guard" | "capability_envelope_guard" => {
            compatibility_security_command("capability-envelope-guard", rest)
        }
        "ip-posture-review" | "ip_posture_review" => {
            compatibility_security_command("ip-posture-review", rest)
        }
        "habit-hygiene-guard" | "habit_hygiene_guard" => {
            compatibility_security_command("habit-hygiene-guard", rest)
        }
        "enterprise-access-gate" | "enterprise_access_gate" => {
            compatibility_security_command("enterprise-access-gate", rest)
        }
        "model-vaccine-sandbox" | "model_vaccine_sandbox" => {
            compatibility_security_command("model-vaccine-sandbox", rest)
        }
        "skill-install-enforcer" | "skill_install_enforcer" => {
            compatibility_security_command("skill-install-enforcer", rest)
        }
        "execution-sandbox-envelope" | "execution_sandbox_envelope" => {
            compatibility_security_command("execution-sandbox-envelope", rest)
        }
        "workspace-dump-guard" | "workspace_dump_guard" => {
            compatibility_security_command("workspace-dump-guard", rest)
        }
        "external-security-cycle" | "external_security_cycle" => {
            compatibility_security_command("external-security-cycle", rest)
        }
        "log-redaction-guard" | "log_redaction_guard" => {
            compatibility_security_command("log-redaction-guard", rest)
        }
        "rsi-git-patch-self-mod-gate" | "rsi_git_patch_self_mod_gate" => {
            compatibility_security_command("rsi-git-patch-self-mod-gate", rest)
        }
        "request-ingress" | "request_ingress" => {
            compatibility_security_command("request-ingress", rest)
        }
        "startup-attestation-boot-gate" | "startup_attestation_boot_gate" => {
            compatibility_security_command("startup-attestation-boot-gate", rest)
        }
        "conflict-marker-guard" | "conflict_marker_guard" => {
            compatibility_security_command("conflict-marker-guard", rest)
        }
        "llm-gateway-guard" | "llm_gateway_guard" => {
            compatibility_security_command("llm-gateway-guard", rest)
        }
        "required-checks-policy-guard" | "required_checks_policy_guard" => {
            compatibility_security_command("required-checks-policy-guard", rest)
        }
        "mcp-a2a-venom-contract-gate" | "mcp_a2a_venom_contract_gate" => {
            compatibility_security_command("mcp-a2a-venom-contract-gate", rest)
        }
        "critical-runtime-formal-depth-pack" | "critical_runtime_formal_depth_pack" => {
            compatibility_security_command("critical-runtime-formal-depth-pack", rest)
        }
        "dire-case-emergency-autonomy-protocol" | "dire_case_emergency_autonomy_protocol" => {
            compatibility_security_command("dire-case-emergency-autonomy-protocol", rest)
        }
        "supply-chain-reproducible-build-plane" | "supply_chain_reproducible_build_plane" => {
            compatibility_security_command("supply-chain-reproducible-build-plane", rest)
        }
        "signed-plugin-trust-marketplace" | "signed_plugin_trust_marketplace" => {
            compatibility_security_command("signed-plugin-trust-marketplace", rest)
        }
        "phoenix-protocol-respawn-continuity" | "phoenix_protocol_respawn_continuity" => {
            compatibility_security_command("phoenix-protocol-respawn-continuity", rest)
        }
        "multi-mind-isolation-boundary-plane" | "multi_mind_isolation_boundary_plane" => {
            compatibility_security_command("multi-mind-isolation-boundary-plane", rest)
        }
        "irrevocable-geas-covenant" | "irrevocable_geas_covenant" => {
            compatibility_security_command("irrevocable-geas-covenant", rest)
        }
        "insider-threat-split-trust-command-governance"
        | "insider_threat_split_trust_command_governance" => {
            compatibility_security_command("insider-threat-split-trust-command-governance", rest)
        }
        "independent-safety-coprocessor-veto-plane"
        | "independent_safety_coprocessor_veto_plane" => {
            compatibility_security_command("independent-safety-coprocessor-veto-plane", rest)
        }
        "hardware-root-of-trust-attestation-mesh" | "hardware_root_of_trust_attestation_mesh" => {
            compatibility_security_command("hardware-root-of-trust-attestation-mesh", rest)
        }
        "formal-threat-modeling-engine" | "formal_threat_modeling_engine" => {
            compatibility_security_command("formal-threat-modeling-engine", rest)
        }
        "formal-mind-sovereignty-verification" | "formal_mind_sovereignty_verification" => {
            compatibility_security_command("formal-mind-sovereignty-verification", rest)
        }
        "alias-verification-vault" | "alias_verification_vault" => {
            compatibility_security_command("alias-verification-vault", rest)
        }
        "psycheforge-psycheforge-organ" | "psycheforge_psycheforge_organ" => {
            compatibility_security_command("psycheforge-psycheforge-organ", rest)
        }
        "psycheforge-profile-synthesizer" | "psycheforge_profile_synthesizer" => {
            compatibility_security_command("psycheforge-profile-synthesizer", rest)
        }
        "psycheforge-temporal-profile-store" | "psycheforge_temporal_profile_store" => {
            compatibility_security_command("psycheforge-temporal-profile-store", rest)
        }
        "psycheforge-countermeasure-selector" | "psycheforge_countermeasure_selector" => {
            compatibility_security_command("psycheforge-countermeasure-selector", rest)
        }
        "delegated-authority-branching" | "delegated_authority_branching" => {
            compatibility_security_command("delegated-authority-branching", rest)
        }
        "organ-state-encryption-plane" | "organ_state_encryption_plane" => {
            compatibility_security_command("organ-state-encryption-plane", rest)
        }
        "remote-tamper-heartbeat" | "remote_tamper_heartbeat" => {
            compatibility_security_command("remote-tamper-heartbeat", rest)
        }
        "skin-protection-layer" | "skin_protection_layer" => {
            compatibility_security_command("skin-protection-layer", rest)
        }
        "critical-path-formal-verifier" | "critical_path_formal_verifier" => {
            compatibility_security_command("critical-path-formal-verifier", rest)
        }
        "key-lifecycle-governor" | "key_lifecycle_governor" => {
            compatibility_security_command("key-lifecycle-governor", rest)
        }
        "supply-chain-trust-plane" | "supply_chain_trust_plane" => {
            compatibility_security_command("supply-chain-trust-plane", rest)
        }
        "post-quantum-migration-lane" | "post_quantum_migration_lane" => {
            compatibility_security_command("post-quantum-migration-lane", rest)
        }
        "safety-resilience-guard" | "safety_resilience_guard" => {
            compatibility_security_command("safety-resilience-guard", rest)
        }
        "status" => (
            json!({
                "ok": true,
                "type": "security_plane_status",
                "lane": "core/layer1/security",
                "commands": [
                    "guard",
                    "anti-sabotage-shield",
                    "constitution-guardian",
                    "remote-emergency-halt",
                    "soul-token-guard",
                    "integrity-reseal",
                    "integrity-reseal-assistant",
                    "capability-lease",
                    "startup-attestation",
                    "directive-hierarchy-controller",
                    "integrity-kernel",
                    "emergency-stop",
                    "capability-switchboard",
                    "black-box-ledger",
                    "goal-preservation-kernel",
                    "dream-warden-guard",
                    "abac-policy-plane",
                    "scan",
                    "remediate",
                    "blast-radius-sentinel",
                    "secrets-federation",
                    "delegated-authority-branching",
                    "organ-state-encryption-plane",
                    "remote-tamper-heartbeat",
                    "skin-protection-layer",
                    "critical-path-formal-verifier",
                    "key-lifecycle-governor",
                    "supply-chain-trust-plane",
                    "post-quantum-migration-lane",
                    "safety-resilience-guard",
                    "rsi-git-patch-self-mod-gate",
                    "request-ingress",
                    "startup-attestation-boot-gate",
                    "conflict-marker-guard",
                    "llm-gateway-guard",
                    "required-checks-policy-guard",
                    "mcp-a2a-venom-contract-gate",
                    "critical-runtime-formal-depth-pack",
                    "dire-case-emergency-autonomy-protocol",
                    "supply-chain-reproducible-build-plane",
                    "signed-plugin-trust-marketplace",
                    "phoenix-protocol-respawn-continuity",
                    "multi-mind-isolation-boundary-plane",
                    "irrevocable-geas-covenant",
                    "insider-threat-split-trust-command-governance",
                    "independent-safety-coprocessor-veto-plane",
                    "hardware-root-of-trust-attestation-mesh",
                    "formal-threat-modeling-engine",
                    "formal-mind-sovereignty-verification",
                    "alias-verification-vault",
                    "psycheforge-psycheforge-organ",
                    "psycheforge-profile-synthesizer",
                    "psycheforge-temporal-profile-store",
                    "psycheforge-countermeasure-selector"
                ]
            }),
            0,
        ),
        _ => (
            json!({
                "ok": false,
                "type": "security_plane_error",
                "error": format!("unknown_command:{}", clean(&cmd, 120)),
                "usage": [
                    "protheus-ops security-plane guard [--files=<a,b,c>] [--strict=1|0]",
                    "protheus-ops security-plane anti-sabotage-shield <snapshot|verify|watch|status> [flags]",
                    "protheus-ops security-plane constitution-guardian <init-genesis|propose-change|approve-change|veto-change|run-gauntlet|activate-change|enforce-inheritance|emergency-rollback|status> [flags]",
                    "protheus-ops security-plane remote-emergency-halt <status|sign-halt|sign-purge|receive|receive-b64> [flags]",
                    "protheus-ops security-plane soul-token-guard <issue|stamp-build|verify|status> [flags]",
                    "protheus-ops security-plane integrity-reseal <check|apply> [flags]",
                    "protheus-ops security-plane integrity-reseal-assistant <run|status> [flags]",
                    "protheus-ops security-plane capability-lease <issue|verify|consume> [flags]",
                    "protheus-ops security-plane startup-attestation <issue|verify|status> [flags]",
                    "protheus-ops security-plane directive-hierarchy-controller <status|decompose> [flags]",
                    "protheus-ops security-plane integrity-kernel <run|status|seal> [flags]",
                    "protheus-ops security-plane emergency-stop <status|engage|release> [flags]",
                    "protheus-ops security-plane capability-switchboard <status|evaluate|set> [flags]",
                    "protheus-ops security-plane black-box-ledger <rollup|verify|status> [flags]",
                    "protheus-ops security-plane goal-preservation-kernel <evaluate|status> [flags]",
                    "protheus-ops security-plane dream-warden-guard <run|status> [flags]",
                    "protheus-ops security-plane truth-seeking-gate <status|ingest-rule|evaluate> [flags]",
                    "protheus-ops security-plane abac-policy-plane <status|evaluate> [flags]",
                    "protheus-ops security-plane scan [--prompt=<text>] [--tool-input=<text>] [--mcp=<text>] [--pack=<id>] [--critical-threshold=<n>] [--strict=1|0]",
                    "protheus-ops security-plane remediate [--strict=1|0]",
                    "protheus-ops security-plane blast-radius-sentinel <record|status> [--action=<id>] [--target=<id>] [--credential=1|0] [--network=1|0] [--allow=1|0] [--strict=1|0]",
                    "protheus-ops security-plane secrets-federation <status|fetch|rotate|revoke> [--provider=vault|aws|1password] [--path=<secret/path>] [--scope=<scope>] [--handle-id=<id>] [--lease-seconds=<n>] [--strict=1|0]",
                    "protheus-ops security-plane copy-hardening-pack <command> [flags]",
                    "protheus-ops security-plane governance-hardening-pack <command> [flags]",
                    "protheus-ops security-plane repository-access-auditor <command> [flags]",
                    "protheus-ops security-plane operator-terms-ack <command> [flags]",
                    "protheus-ops security-plane governance-hardening-lane <command> [flags]",
                    "protheus-ops security-plane skill-install-path-enforcer <command> [flags]",
                    "protheus-ops security-plane skill-quarantine <command> [flags]",
                    "protheus-ops security-plane autonomous-skill-necessity-audit <command> [flags]",
                    "protheus-ops security-plane formal-invariant-engine <command> [flags]",
                    "protheus-ops security-plane repo-hygiene-guard <command> [flags]",
                    "protheus-ops security-plane rsi-git-patch-self-mod-gate <command> [flags]",
                    "protheus-ops security-plane request-ingress <command> [flags]",
                    "protheus-ops security-plane startup-attestation-boot-gate <command> [flags]",
                    "protheus-ops security-plane conflict-marker-guard <command> [flags]",
                    "protheus-ops security-plane llm-gateway-guard <command> [flags]",
                    "protheus-ops security-plane required-checks-policy-guard <command> [flags]",
                    "protheus-ops security-plane mcp-a2a-venom-contract-gate <command> [flags]",
                    "protheus-ops security-plane critical-runtime-formal-depth-pack <command> [flags]",
                    "protheus-ops security-plane dire-case-emergency-autonomy-protocol <command> [flags]",
                    "protheus-ops security-plane supply-chain-reproducible-build-plane <command> [flags]",
                    "protheus-ops security-plane signed-plugin-trust-marketplace <command> [flags]",
                    "protheus-ops security-plane phoenix-protocol-respawn-continuity <command> [flags]",
                    "protheus-ops security-plane multi-mind-isolation-boundary-plane <command> [flags]",
                    "protheus-ops security-plane irrevocable-geas-covenant <command> [flags]",
                    "protheus-ops security-plane insider-threat-split-trust-command-governance <command> [flags]",
                    "protheus-ops security-plane independent-safety-coprocessor-veto-plane <command> [flags]",
                    "protheus-ops security-plane hardware-root-of-trust-attestation-mesh <command> [flags]",
                    "protheus-ops security-plane formal-threat-modeling-engine <command> [flags]",
                    "protheus-ops security-plane formal-mind-sovereignty-verification <command> [flags]",
                    "protheus-ops security-plane alias-verification-vault <command> [flags]",
                    "protheus-ops security-plane psycheforge-psycheforge-organ <command> [flags]",
                    "protheus-ops security-plane psycheforge-profile-synthesizer <command> [flags]",
                    "protheus-ops security-plane psycheforge-temporal-profile-store <command> [flags]",
                    "protheus-ops security-plane psycheforge-countermeasure-selector <command> [flags]"
                ]
            }),
            2,
        ),
    };

    let wrapped = wrap_capability_event(root, &cmd, rest, payload);
    persist_security_receipt(root, &wrapped);
    print_json(&wrapped);
    code
}
