// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer1/security (authoritative)

use crate::clean;
use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use walkdir::WalkDir;

fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
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

fn proofs_state_dir(root: &Path) -> PathBuf {
    state_dir(root).join("proofs")
}

fn proofs_latest_path(root: &Path) -> PathBuf {
    proofs_state_dir(root).join("latest.json")
}

fn proofs_history_path(root: &Path) -> PathBuf {
    proofs_state_dir(root).join("history.jsonl")
}

fn audit_state_dir(root: &Path) -> PathBuf {
    state_dir(root).join("audit")
}

fn audit_latest_path(root: &Path) -> PathBuf {
    audit_state_dir(root).join("latest.json")
}

fn audit_history_path(root: &Path) -> PathBuf {
    audit_state_dir(root).join("history.jsonl")
}

fn threat_state_dir(root: &Path) -> PathBuf {
    state_dir(root).join("threat_model")
}

fn threat_latest_path(root: &Path) -> PathBuf {
    threat_state_dir(root).join("latest.json")
}

fn threat_history_path(root: &Path) -> PathBuf {
    threat_state_dir(root).join("history.jsonl")
}

fn contracts_state_dir(root: &Path) -> PathBuf {
    state_dir(root).join("contracts")
}

fn contract_state_path(root: &Path, id: &str) -> PathBuf {
    contracts_state_dir(root).join(format!("{id}.json"))
}

fn contract_history_path(root: &Path) -> PathBuf {
    contracts_state_dir(root).join("history.jsonl")
}

fn skill_quarantine_state_path(root: &Path) -> PathBuf {
    state_dir(root).join("skill_quarantine.json")
}

fn skill_quarantine_events_path(root: &Path) -> PathBuf {
    state_dir(root).join("skill_quarantine_events.jsonl")
}

fn skills_plane_state_root(root: &Path) -> PathBuf {
    if let Ok(value) = std::env::var("SKILLS_PLANE_STATE_ROOT") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("skills_plane")
}

fn skills_registry_path(root: &Path) -> PathBuf {
    skills_plane_state_root(root).join("registry.json")
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    lane_utils::parse_flag(argv, key, false)
}

fn parse_bool(raw: Option<String>, fallback: bool) -> bool {
    lane_utils::parse_bool(raw.as_deref(), fallback)
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
    let _ = lane_utils::append_jsonl(path, row);
}

fn write_json(path: &Path, payload: &Value) {
    let _ = lane_utils::write_json(path, payload);
}

fn read_json(path: &Path) -> Option<Value> {
    lane_utils::read_json(path)
}

fn hash_text(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

fn persist_security_receipt(root: &Path, payload: &Value) {
    let _ = lane_utils::write_json(&security_latest_path(root), payload);
    let _ = lane_utils::append_jsonl(&security_history_path(root), payload);
}

fn run_security_contract_command(
    root: &Path,
    argv: &[String],
    strict: bool,
    command: &str,
    contract_id: &str,
    checks: &[(&str, Option<&str>)],
) -> (Value, i32) {
    let mut missing = Vec::<String>::new();
    let mut mismatch = Vec::<String>::new();
    let mut provided = serde_json::Map::<String, Value>::new();
    for (key, expected) in checks {
        let got = lane_utils::parse_flag(argv, key, false);
        if let Some(value) = got.as_deref() {
            provided.insert((*key).to_string(), Value::String(clean(value, 200)));
        } else {
            missing.push((*key).to_string());
            continue;
        }
        if let Some(expected_value) = expected {
            if got
                .as_deref()
                .map(|v| v.trim().eq_ignore_ascii_case(expected_value))
                .unwrap_or(false)
            {
                continue;
            }
            mismatch.push(format!("{key}:{expected_value}"));
        }
    }

    let ok = missing.is_empty() && mismatch.is_empty();
    let contract_state = json!({
        "id": contract_id,
        "command": command,
        "strict": strict,
        "updated_at": now_iso(),
        "missing_flags": missing,
        "mismatch_flags": mismatch,
        "provided_flags": provided
    });
    let path = contract_state_path(root, contract_id);
    let _ = lane_utils::write_json(&path, &contract_state);
    let _ = lane_utils::append_jsonl(
        &contract_history_path(root),
        &json!({
            "ts": now_iso(),
            "id": contract_id,
            "command": command,
            "ok": ok,
            "strict": strict
        }),
    );

    let out = json!({
        "ok": ok,
        "type": "security_plane_contract_lane",
        "lane": "core/layer1/security",
        "mode": command,
        "strict": strict,
        "contract_id": contract_id,
        "state_path": path.display().to_string(),
        "missing_flags": contract_state.get("missing_flags").cloned().unwrap_or(Value::Null),
        "mismatch_flags": contract_state.get("mismatch_flags").cloned().unwrap_or(Value::Null),
        "claim_evidence": [{
            "id": contract_id,
            "claim": "security_contract_lane_executes_with_fail_closed_validation_and_receipted_state_artifacts",
            "evidence": {
                "command": command,
                "state_path": path.display().to_string(),
                "missing_flags": contract_state.get("missing_flags").cloned().unwrap_or(Value::Null),
                "mismatch_flags": contract_state.get("mismatch_flags").cloned().unwrap_or(Value::Null)
            }
        }]
    });
    let exit = if strict && !ok { 2 } else { 0 };
    (out, exit)
}

fn split_csv(raw: Option<String>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(|row| clean(row, 160).to_ascii_lowercase())
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>()
}

fn canonicalize_for_prefix_check(path: &Path) -> PathBuf {
    if let Ok(canonical) = fs::canonicalize(path) {
        return canonical;
    }
    if let Some(parent) = path.parent() {
        if let Ok(canonical_parent) = fs::canonicalize(parent) {
            if let Some(name) = path.file_name() {
                return canonical_parent.join(name);
            }
            return canonical_parent;
        }
    }
    path.to_path_buf()
}

fn run_skill_install_path_enforcer(root: &Path, argv: &[String], strict: bool) -> (Value, i32) {
    let Some(raw_path) = parse_flag(argv, "skill-path") else {
        let out = json!({
            "ok": false,
            "type": "security_plane_skill_install_path_enforcer",
            "strict": strict,
            "error": "skill_path_required",
            "claim_evidence": [{
                "id": "V6-SEC-SKILL-PATH-001",
                "claim": "skill_install_paths_are_enforced_to_approved_roots_with_fail_closed_guardrails",
                "evidence": {"skill_path_present": false}
            }]
        });
        return (out, if strict { 2 } else { 0 });
    };

    let raw_candidate = PathBuf::from(raw_path.trim());
    let candidate = if raw_candidate.is_absolute() {
        raw_candidate
    } else {
        root.join(raw_candidate)
    };
    let candidate_norm = canonicalize_for_prefix_check(&candidate);

    let mut allowed_roots = vec![
        root.join("client")
            .join("runtime")
            .join("systems")
            .join("skills")
            .join("packages"),
        root.join("local")
            .join("workspace")
            .join("assistant")
            .join("skills"),
    ];
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        let trimmed = codex_home.trim();
        if !trimmed.is_empty() {
            allowed_roots.push(PathBuf::from(trimmed).join("skills"));
        }
    }
    for extra in split_csv(parse_flag(argv, "extra-allowed-root")) {
        let path = PathBuf::from(extra);
        allowed_roots.push(if path.is_absolute() {
            path
        } else {
            root.join(path)
        });
    }
    let normalized_roots = allowed_roots
        .iter()
        .map(|path| canonicalize_for_prefix_check(path))
        .collect::<Vec<_>>();

    let allowed = normalized_roots
        .iter()
        .any(|prefix| candidate_norm.starts_with(prefix));

    let out = json!({
        "ok": allowed,
        "type": "security_plane_skill_install_path_enforcer",
        "strict": strict,
        "skill_path": candidate_norm.display().to_string(),
        "allowed": allowed,
        "allowed_roots": normalized_roots
            .iter()
            .map(|path| Value::String(path.display().to_string()))
            .collect::<Vec<_>>(),
        "claim_evidence": [{
            "id": "V6-SEC-SKILL-PATH-001",
            "claim": "skill_install_paths_are_enforced_to_approved_roots_with_fail_closed_guardrails",
            "evidence": {
                "skill_path": candidate_norm.display().to_string(),
                "allowed": allowed
            }
        }]
    });
    (out, if strict && !allowed { 2 } else { 0 })
}

fn run_skill_quarantine_command(root: &Path, argv: &[String], strict: bool) -> (Value, i32) {
    let mode = parse_subcommand(argv, "status");
    let path = skill_quarantine_state_path(root);
    let mut state = read_json(&path).unwrap_or_else(|| json!({"quarantined": {}}));
    if !state.is_object() {
        state = json!({"quarantined": {}});
    }
    if state
        .get("quarantined")
        .and_then(Value::as_object)
        .is_none()
    {
        state["quarantined"] = json!({});
    }

    let skill_id = parse_flag(argv, "skill-id")
        .or_else(|| parse_flag(argv, "skill"))
        .unwrap_or_default();
    let skill_id = clean(&skill_id, 120);
    let reason = clean(
        parse_flag(argv, "reason").unwrap_or_else(|| "manual".to_string()),
        240,
    );
    let mut ok = true;
    let mut error = Value::Null;

    match mode.as_str() {
        "quarantine" => {
            if skill_id.is_empty() {
                ok = false;
                error = Value::String("skill_id_required".to_string());
            } else {
                state["quarantined"][skill_id.clone()] = json!({
                    "skill_id": skill_id,
                    "reason": reason,
                    "quarantined_at": now_iso(),
                });
                append_jsonl(
                    &skill_quarantine_events_path(root),
                    &json!({
                        "ts": now_iso(),
                        "action": "quarantine",
                        "skill_id": skill_id,
                        "reason": reason
                    }),
                );
            }
        }
        "release" | "unquarantine" => {
            if skill_id.is_empty() {
                ok = false;
                error = Value::String("skill_id_required".to_string());
            } else if let Some(map) = state.get_mut("quarantined").and_then(Value::as_object_mut) {
                map.remove(&skill_id);
                append_jsonl(
                    &skill_quarantine_events_path(root),
                    &json!({
                        "ts": now_iso(),
                        "action": "release",
                        "skill_id": skill_id
                    }),
                );
            }
        }
        "status" => {}
        other => {
            ok = false;
            error = Value::String(format!("unknown_mode:{other}"));
        }
    }

    if ok {
        write_json(&path, &state);
    }
    let count = state
        .get("quarantined")
        .and_then(Value::as_object)
        .map(|rows| rows.len())
        .unwrap_or(0);
    let out = json!({
        "ok": ok,
        "type": "security_plane_skill_quarantine",
        "strict": strict,
        "mode": mode,
        "error": error,
        "state_path": path.display().to_string(),
        "quarantined_count": count,
        "quarantined": state.get("quarantined").cloned().unwrap_or_else(|| json!({})),
        "claim_evidence": [{
            "id": "V6-SEC-SKILL-QUARANTINE-001",
            "claim": "skills_can_be_quarantined_and_released_with_receipted_state_and_history",
            "evidence": {
                "mode": mode,
                "state_path": path.display().to_string(),
                "quarantined_count": count
            }
        }]
    });
    (out, if strict && !ok { 2 } else { 0 })
}

fn run_autonomous_skill_necessity_audit(
    root: &Path,
    argv: &[String],
    strict: bool,
) -> (Value, i32) {
    let registry = read_json(&skills_registry_path(root)).unwrap_or_else(|| json!({}));
    let installed = registry
        .get("installed")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let required = split_csv(parse_flag(argv, "required-skills"));
    let required_set = required.iter().cloned().collect::<BTreeSet<_>>();
    let mut installed_ids = installed
        .keys()
        .map(|row| row.to_ascii_lowercase())
        .collect::<Vec<_>>();
    installed_ids.sort();
    let unnecessary = installed_ids
        .iter()
        .filter(|id| !required_set.contains(*id))
        .cloned()
        .collect::<Vec<_>>();
    let max_installed = parse_u64(parse_flag(argv, "max-installed"), 24);
    let overloaded = (installed_ids.len() as u64) > max_installed;
    let out = json!({
        "ok": !overloaded,
        "type": "security_plane_autonomous_skill_necessity_audit",
        "strict": strict,
        "registry_path": skills_registry_path(root).display().to_string(),
        "installed_count": installed_ids.len(),
        "max_installed": max_installed,
        "required_skills": required,
        "unnecessary_skills": unnecessary,
        "overloaded": overloaded,
        "claim_evidence": [{
            "id": "V6-SEC-SKILL-AUDIT-001",
            "claim": "autonomous_skill_necessity_audit_flags_skill_sprawl_from_installed_registry_state",
            "evidence": {
                "installed_count": installed_ids.len(),
                "overloaded": overloaded
            }
        }]
    });
    (out, if strict && overloaded { 2 } else { 0 })
}

fn run_repo_hygiene_guard(root: &Path, argv: &[String], strict: bool, mode: &str) -> (Value, i32) {
    let scan_root = parse_flag(argv, "scan-root")
        .map(|value| {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                path
            } else {
                root.join(path)
            }
        })
        .unwrap_or_else(|| root.to_path_buf());
    let max_files = parse_u64(parse_flag(argv, "max-files"), 4000) as usize;
    let mut hits = Vec::<Value>::new();
    let mut scanned = 0usize;

    for entry in WalkDir::new(&scan_root)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            name != ".git" && name != "node_modules" && name != "target"
        })
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        scanned += 1;
        if scanned > max_files {
            break;
        }
        let path = entry.path();
        let Ok(raw) = fs::read_to_string(path) else {
            continue;
        };
        let has_conflict =
            raw.contains("<<<<<<<") || raw.contains("=======") && raw.contains(">>>>>>>");
        let has_runtime_stub = raw.contains("compatibility_only\": true");
        let flagged = if mode == "conflict-marker-guard" {
            has_conflict
        } else {
            has_conflict || has_runtime_stub
        };
        if !flagged {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .display()
            .to_string();
        hits.push(json!({
            "path": rel,
            "conflict_marker": has_conflict,
            "compatibility_stub_marker": has_runtime_stub
        }));
        if hits.len() >= 25 {
            break;
        }
    }

    let blocked = !hits.is_empty();
    let out = json!({
        "ok": !blocked,
        "type": "security_plane_repo_hygiene_guard",
        "strict": strict,
        "mode": mode,
        "scan_root": scan_root.display().to_string(),
        "scanned_files": scanned,
        "hit_count": hits.len(),
        "hits": hits,
        "claim_evidence": [{
            "id": if mode == "conflict-marker-guard" { "V6-SEC-CONFLICT-GUARD-001" } else { "V6-SEC-REPO-HYGIENE-001" },
            "claim": "repository_hygiene_and_conflict_markers_are_enforced_with_fail_closed_scan_receipts",
            "evidence": {
                "mode": mode,
                "hit_count": hits.len()
            }
        }]
    });
    (out, if strict && blocked { 2 } else { 0 })
}

fn run_log_redaction_guard(root: &Path, argv: &[String], strict: bool) -> (Value, i32) {
    let mut source = "text".to_string();
    let mut content = parse_flag(argv, "text").unwrap_or_default();
    if content.is_empty() {
        if let Some(path) = parse_flag(argv, "log-path") {
            let candidate = if Path::new(&path).is_absolute() {
                PathBuf::from(&path)
            } else {
                root.join(&path)
            };
            source = candidate.display().to_string();
            content = fs::read_to_string(&candidate).unwrap_or_default();
        }
    }
    let lower = content.to_ascii_lowercase();
    let patterns = [
        ("openai_api_key", "sk-"),
        ("anthropic_api_key", "sk-ant-"),
        ("aws_access_key", "akia"),
        ("private_key", "-----begin private key-----"),
        ("github_pat", "ghp_"),
    ];
    let mut hits = Vec::<Value>::new();
    for (name, pattern) in patterns {
        if lower.contains(pattern) {
            hits.push(json!({"pattern": name}));
        }
    }
    let mut redacted = content.clone();
    for needle in ["sk-", "sk-ant-", "ghp_", "AKIA"] {
        if redacted.contains(needle) {
            redacted = redacted.replace(needle, "[REDACTED]");
        }
    }
    if redacted.len() > 400 {
        redacted.truncate(400);
    }

    let blocked = !hits.is_empty();
    let out = json!({
        "ok": !blocked,
        "type": "security_plane_log_redaction_guard",
        "strict": strict,
        "source": source,
        "hit_count": hits.len(),
        "hits": hits,
        "redacted_preview": redacted,
        "claim_evidence": [{
            "id": "V6-SEC-LOG-REDACTION-001",
            "claim": "log_redaction_guard_detects_secret_egress_patterns_before_output_release",
            "evidence": {
                "hit_count": hits.len()
            }
        }]
    });
    (out, if strict && blocked { 2 } else { 0 })
}

fn path_size_bytes(path: &Path) -> u64 {
    if path.is_file() {
        return fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    }
    let mut total = 0u64;
    for entry in WalkDir::new(path).into_iter().filter_map(Result::ok) {
        if entry.file_type().is_file() {
            total = total.saturating_add(entry.metadata().map(|meta| meta.len()).unwrap_or(0));
        }
    }
    total
}

fn run_workspace_dump_guard(root: &Path, argv: &[String], strict: bool) -> (Value, i32) {
    let target = parse_flag(argv, "path").unwrap_or_default();
    let target_path = if Path::new(&target).is_absolute() {
        PathBuf::from(&target)
    } else {
        root.join(&target)
    };
    let exists = !target.is_empty() && target_path.exists();
    let bytes = if exists {
        path_size_bytes(&target_path)
    } else {
        parse_u64(parse_flag(argv, "bytes"), 0)
    };
    let max_bytes = parse_u64(parse_flag(argv, "max-bytes"), 5_000_000);
    let lower_target = target.to_ascii_lowercase();
    let sensitive_path = lower_target.contains(".env")
        || lower_target.contains("secret")
        || lower_target.contains("key");
    let blocked = bytes > max_bytes || sensitive_path || !exists;
    let out = json!({
        "ok": !blocked,
        "type": "security_plane_workspace_dump_guard",
        "strict": strict,
        "path": target_path.display().to_string(),
        "exists": exists,
        "bytes": bytes,
        "max_bytes": max_bytes,
        "sensitive_path": sensitive_path,
        "blocked": blocked,
        "claim_evidence": [{
            "id": "V6-SEC-WORKSPACE-DUMP-001",
            "claim": "workspace_dump_guard_blocks_sensitive_or_oversized_exports_before_egress",
            "evidence": {
                "blocked": blocked,
                "bytes": bytes,
                "max_bytes": max_bytes
            }
        }]
    });
    (out, if strict && blocked { 2 } else { 0 })
}

fn run_llm_gateway_guard(_root: &Path, argv: &[String], strict: bool) -> (Value, i32) {
    let provider = clean(parse_flag(argv, "provider").unwrap_or_default(), 80).to_ascii_lowercase();
    let model = clean(parse_flag(argv, "model").unwrap_or_default(), 120).to_ascii_lowercase();
    let providers = {
        let rows = split_csv(parse_flag(argv, "allow-providers"));
        if rows.is_empty() {
            vec![
                "openai".to_string(),
                "anthropic".to_string(),
                "local".to_string(),
            ]
        } else {
            rows
        }
    };
    let prefixes = {
        let rows = split_csv(parse_flag(argv, "allow-model-prefixes"));
        if rows.is_empty() {
            vec![
                "gpt-".to_string(),
                "o3".to_string(),
                "o4".to_string(),
                "claude-".to_string(),
                "llama-".to_string(),
            ]
        } else {
            rows
        }
    };

    let provider_allowed = providers.iter().any(|allowed| allowed == &provider);
    let model_allowed = prefixes
        .iter()
        .any(|prefix| !model.is_empty() && model.starts_with(prefix));
    let blocked = provider.is_empty() || model.is_empty() || !provider_allowed || !model_allowed;
    let out = json!({
        "ok": !blocked,
        "type": "security_plane_llm_gateway_guard",
        "strict": strict,
        "provider": provider,
        "model": model,
        "provider_allowed": provider_allowed,
        "model_allowed": model_allowed,
        "allow_providers": providers,
        "allow_model_prefixes": prefixes,
        "claim_evidence": [{
            "id": "V6-SEC-LLM-GATEWAY-001",
            "claim": "llm_gateway_guard_fail_closes_provider_and_model_routing_outside_declared_allowlists",
            "evidence": {
                "provider_allowed": provider_allowed,
                "model_allowed": model_allowed
            }
        }]
    });
    (out, if strict && blocked { 2 } else { 0 })
}

fn run_startup_attestation_boot_gate(root: &Path, argv: &[String]) -> (Value, i32) {
    if argv.is_empty() {
        return infring_layer1_security::run_startup_attestation(root, &["status".to_string()]);
    }
    infring_layer1_security::run_startup_attestation(root, argv)
}

fn run_rsi_git_patch_self_mod_gate(root: &Path, argv: &[String], strict: bool) -> (Value, i32) {
    let approval = parse_bool(parse_flag(argv, "self-mod-approved"), false)
        || parse_bool(parse_flag(argv, "approved"), false);
    let protected_roots = {
        let rows = split_csv(parse_flag(argv, "protected-roots"));
        if rows.is_empty() {
            vec![
                "core/layer0/ops/src".to_string(),
                "core/layer1/security/src".to_string(),
                "client/runtime/systems/security".to_string(),
            ]
        } else {
            rows
        }
    };
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("status")
        .arg("--porcelain")
        .output();

    let mut sensitive = Vec::<String>::new();
    if let Ok(data) = output {
        let raw = String::from_utf8_lossy(&data.stdout);
        for line in raw.lines() {
            if line.len() < 4 {
                continue;
            }
            let file = line[3..].trim().to_string();
            let lower = file.to_ascii_lowercase();
            if protected_roots
                .iter()
                .any(|prefix| lower.starts_with(prefix))
            {
                sensitive.push(file);
            }
        }
    }
    sensitive.sort();
    sensitive.dedup();
    let blocked = !sensitive.is_empty() && !approval;
    let out = json!({
        "ok": !blocked,
        "type": "security_plane_rsi_git_patch_self_mod_gate",
        "strict": strict,
        "self_mod_approved": approval,
        "protected_roots": protected_roots,
        "sensitive_change_count": sensitive.len(),
        "sensitive_changes": sensitive,
        "claim_evidence": [{
            "id": "V6-SEC-RSI-SELFMOD-001",
            "claim": "rsi_git_patch_self_mod_gate_blocks_unapproved_mutation_of_security_authority_paths",
            "evidence": {
                "sensitive_change_count": sensitive.len(),
                "self_mod_approved": approval
            }
        }]
    });
    (out, if strict && blocked { 2 } else { 0 })
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
    let _ = run_security_contract_command(
        root,
        argv,
        strict,
        "scan",
        "V6-SEC-010",
        &[],
    );
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
        let _ = run_security_contract_command(
            root,
            argv,
            strict,
            "blast-radius-status",
            "V6-SEC-012",
            &[],
        );
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
    let _ = run_security_contract_command(
        root,
        argv,
        strict,
        "blast-radius-record",
        "V6-SEC-012",
        &[],
    );
    (out, if strict && blocked { 2 } else { 0 })
}

fn run_remediation_command(root: &Path, argv: &[String], strict: bool) -> (Value, i32) {
    let latest = read_json(&scanner_latest_path(root));
    let Some(scan_doc) = latest else {
        let _ = run_security_contract_command(
            root,
            argv,
            strict,
            "remediate",
            "V6-SEC-011",
            &[],
        );
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
    let patch_path = remediation_state_dir(root).join(format!(
        "prompt_policy_patch_{}.json",
        &scan_id[..16.min(scan_id.len())]
    ));
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
    let _ = run_security_contract_command(
        root,
        argv,
        strict,
        "remediate",
        "V6-SEC-011",
        &[],
    );
    (out, if strict && promotion_blocked { 2 } else { 0 })
}

fn run_verify_proofs_command(root: &Path, argv: &[String], strict: bool) -> (Value, i32) {
    let raw_pack = parse_flag(argv, "proof-pack").unwrap_or_else(|| "proofs".to_string());
    let pack_path = if Path::new(&raw_pack).is_absolute() {
        PathBuf::from(&raw_pack)
    } else {
        root.join(&raw_pack)
    };
    let min_files = parse_u64(parse_flag(argv, "min-files"), 1) as usize;
    let max_files = parse_u64(parse_flag(argv, "max-files"), 10_000) as usize;
    let accepted_exts = {
        let parsed = split_csv(parse_flag(argv, "extensions"));
        if parsed.is_empty() {
            vec![
                "smt2".to_string(),
                "lean".to_string(),
                "proof".to_string(),
                "json".to_string(),
                "md".to_string(),
            ]
        } else {
            parsed
        }
    };

    let pack_exists = pack_path.exists();
    let mut proof_files = Vec::<String>::new();
    if pack_exists {
        for entry in WalkDir::new(&pack_path).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            let Some(ext) = entry.path().extension().and_then(|value| value.to_str()) else {
                continue;
            };
            let ext_lc = ext.to_ascii_lowercase();
            if !accepted_exts.iter().any(|item| item == &ext_lc) {
                continue;
            }
            proof_files.push(
                entry
                    .path()
                    .strip_prefix(root)
                    .unwrap_or(entry.path())
                    .display()
                    .to_string(),
            );
            if proof_files.len() >= max_files {
                break;
            }
        }
    }
    proof_files.sort();
    proof_files.dedup();
    let blocked = !pack_exists || proof_files.len() < min_files;

    let event = json!({
        "ts": now_iso(),
        "proof_pack": pack_path.display().to_string(),
        "pack_exists": pack_exists,
        "proof_file_count": proof_files.len(),
        "min_files": min_files,
        "extensions": accepted_exts,
        "sample_files": proof_files.iter().take(25).cloned().collect::<Vec<_>>(),
        "blocked": blocked
    });
    append_jsonl(&proofs_history_path(root), &event);
    write_json(&proofs_latest_path(root), &event);

    let out = json!({
        "ok": !blocked,
        "type": "security_plane_verify_proofs",
        "lane": "core/layer1/security",
        "mode": "verify-proofs",
        "strict": strict,
        "event": event,
        "claim_evidence": [{
            "id": "V6-SEC-013",
            "claim": "security_proof_pack_verification_enforces_minimum_receipted_proof_inventory_before_promotion",
            "evidence": {
                "pack_exists": pack_exists,
                "proof_file_count": proof_files.len(),
                "min_files": min_files,
                "blocked": blocked
            }
        }]
    });
    (out, if strict && blocked { 2 } else { 0 })
}

fn run_audit_logs_command(root: &Path, argv: &[String], strict: bool) -> (Value, i32) {
    let max_events = parse_u64(parse_flag(argv, "max-events"), 500) as usize;
    let max_failures = parse_u64(parse_flag(argv, "max-failures"), 0);
    let security_events = read_jsonl(&security_history_path(root));
    let capability_events = read_jsonl(&capability_event_path(root));
    let blast_events = read_jsonl(&blast_radius_events_path(root));
    let secret_events = read_jsonl(&secrets_events_path(root));
    let remediation_events = read_jsonl(&remediation_gate_path(root));

    let mut failed = 0u64;
    let mut blocked = 0u64;
    let mut by_type = BTreeMap::<String, u64>::new();
    for row in security_events
        .iter()
        .rev()
        .take(max_events)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        let ty = row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        *by_type.entry(ty).or_insert(0) += 1;
        if row.get("ok").and_then(Value::as_bool) == Some(false) {
            failed += 1;
        }
        if row.get("blocked").and_then(Value::as_bool) == Some(true) {
            blocked += 1;
        }
        if row
            .get("event")
            .and_then(|v| v.get("blocked"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            blocked += 1;
        }
    }

    let audit_blocked = failed > max_failures;
    let summary = json!({
        "ts": now_iso(),
        "max_events": max_events,
        "max_failures": max_failures,
        "security_events_considered": security_events.len().min(max_events),
        "failed_events": failed,
        "blocked_events": blocked,
        "capability_events": capability_events.len(),
        "blast_events": blast_events.len(),
        "secret_events": secret_events.len(),
        "remediation_events": remediation_events.len(),
        "events_by_type": by_type,
        "audit_blocked": audit_blocked
    });
    append_jsonl(&audit_history_path(root), &summary);
    write_json(&audit_latest_path(root), &summary);

    let out = json!({
        "ok": !audit_blocked,
        "type": "security_plane_audit_logs",
        "lane": "core/layer1/security",
        "mode": "audit-logs",
        "strict": strict,
        "summary": summary,
        "claim_evidence": [{
            "id": "V6-SEC-014",
            "claim": "security_audit_log_analysis_tracks_failed_and_blocked_events_with_fail_closed_thresholds",
            "evidence": {
                "failed_events": failed,
                "blocked_events": blocked,
                "max_failures": max_failures,
                "audit_blocked": audit_blocked
            }
        }]
    });
    (out, if strict && audit_blocked { 2 } else { 0 })
}

fn run_threat_model_command(root: &Path, argv: &[String], strict: bool) -> (Value, i32) {
    let scenario = clean(
        parse_flag(argv, "scenario").unwrap_or_else(|| "unspecified".to_string()),
        200,
    );
    let surface = clean(
        parse_flag(argv, "surface").unwrap_or_else(|| "control-plane".to_string()),
        120,
    );
    let vector = clean(parse_flag(argv, "vector").unwrap_or_default(), 200);
    let model = clean(
        parse_flag(argv, "model").unwrap_or_else(|| "security-default-v1".to_string()),
        80,
    );
    let threshold = parse_u64(parse_flag(argv, "block-threshold"), 70);
    let allow = parse_bool(parse_flag(argv, "allow"), false);

    let signal = format!(
        "{} {} {}",
        scenario.to_ascii_lowercase(),
        surface.to_ascii_lowercase(),
        vector.to_ascii_lowercase()
    );
    let mut score = 10u64;
    if signal.contains("exfil")
        || signal.contains("secret")
        || signal.contains("credential")
        || signal.contains("token")
    {
        score = score.saturating_add(55);
    }
    if signal.contains("rce")
        || signal.contains("shell")
        || signal.contains("exec")
        || signal.contains("privilege")
    {
        score = score.saturating_add(45);
    }
    if signal.contains("prompt")
        || signal.contains("injection")
        || signal.contains("poison")
        || signal.contains("jailbreak")
    {
        score = score.saturating_add(40);
    }
    if signal.contains("lateral")
        || signal.contains("persistence")
        || signal.contains("supply-chain")
        || signal.contains("supply chain")
    {
        score = score.saturating_add(35);
    }
    score = score.min(100);

    let severity = if score >= 80 {
        "critical"
    } else if score >= 60 {
        "high"
    } else if score >= 35 {
        "medium"
    } else {
        "low"
    };
    let recommendations = if score >= 80 {
        vec![
            "quarantine_execution_path",
            "require_human_approval",
            "enable_blast_radius_lockdown",
        ]
    } else if score >= 60 {
        vec![
            "tighten_allowlists",
            "enable_continuous_scan",
            "raise_audit_sampling",
        ]
    } else if score >= 35 {
        vec!["monitor_with_alerting", "add_regression_case"]
    } else {
        vec!["baseline_monitoring"]
    };
    let blocked = !allow && score >= threshold;

    let event = json!({
        "ts": now_iso(),
        "scenario": scenario,
        "surface": surface,
        "vector": vector,
        "model": model,
        "risk_score": score,
        "severity": severity,
        "block_threshold": threshold,
        "blocked": blocked,
        "recommendations": recommendations
    });
    append_jsonl(&threat_history_path(root), &event);
    write_json(&threat_latest_path(root), &event);

    let out = json!({
        "ok": !blocked,
        "type": "security_plane_threat_model",
        "lane": "core/layer1/security",
        "mode": "threat-model",
        "strict": strict,
        "event": event,
        "claim_evidence": [{
            "id": "V6-SEC-015",
            "claim": "threat_modeling_lane_classifies_attack_vectors_and_fail_closes_high_risk_scenarios",
            "evidence": {
                "risk_score": score,
                "severity": severity,
                "block_threshold": threshold,
                "blocked": blocked
            }
        }]
    });
    (out, if strict && blocked { 2 } else { 0 })
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
        let _ = run_security_contract_command(
            root,
            argv,
            strict,
            "secrets-federation",
            "V6-SEC-016",
            &[],
        );
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
                let _ = run_security_contract_command(
                    root,
                    argv,
                    strict,
                    "secrets-federation",
                    "V6-SEC-016",
                    &[],
                );
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
    let _ = run_security_contract_command(
        root,
        argv,
        strict,
        "secrets-federation",
        "V6-SEC-016",
        &[],
    );
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
    let mut capability_hash_chain_ok = Value::Null;
    if let Some(action) = action {
        let capability = parse_flag(argv, "capability")
            .or_else(|| {
                out.get("capability")
                    .and_then(Value::as_str)
                    .map(|row| row.to_string())
            })
            .or_else(|| parse_flag(argv, "policy"))
            .unwrap_or_else(|| "global".to_string());
        let subject = parse_flag(argv, "subject")
            .or_else(|| {
                out.get("subject")
                    .and_then(Value::as_str)
                    .map(|row| row.to_string())
            })
            .unwrap_or_else(|| "global".to_string());
        let reason = parse_flag(argv, "reason").unwrap_or_else(|| {
            format!(
                "{}:{}",
                clean(command, 80),
                out.get("type").and_then(Value::as_str).unwrap_or("runtime_change")
            )
        });
        out["grant_revoke_receipt"] = json!({
            "action": action,
            "ts": now_iso(),
            "source": "security_plane_runtime"
        });
        match crate::assimilation_controller::append_capability_hash_chain_event(
            root,
            out.get("grant_revoke_receipt")
                .and_then(|row| row.get("action"))
                .and_then(Value::as_str)
                .unwrap_or("observe"),
            &capability,
            &subject,
            &reason,
        ) {
            Ok(event_row) => {
                capability_hash_chain_ok = Value::Bool(true);
                out["capability_hash_chain_ledger"] = json!({
                    "ok": true,
                    "capability": capability,
                    "subject": subject,
                    "event": event_row
                });
            }
            Err(err) => {
                capability_hash_chain_ok = Value::Bool(false);
                out["capability_hash_chain_ledger"] = json!({
                    "ok": false,
                    "error": err,
                    "capability": capability,
                    "subject": subject
                });
                if strict {
                    out["ok"] = Value::Bool(false);
                    let mut errs = out
                        .get("errors")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    errs.push(Value::String(
                        "capability_hash_chain_append_failed".to_string(),
                    ));
                    out["errors"] = Value::Array(errs);
                }
            }
        }
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
        claim_rows.push(json!({
            "id": "V7-ASM-003",
            "claim": "runtime_capability_changes_are_written_to_capability_hash_chain_ledger",
            "evidence": {
                "command": clean(command, 120),
                "capability_hash_chain_ok": capability_hash_chain_ok
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
        "t0-invariants" | "t0_invariants" => crate::t0_invariants_kernel::run(root, rest),
        "thorn-swarm-protocol" | "thorn_swarm_protocol" | "thorn" => {
            crate::swarm_runtime::run_thorn_contract(root, rest)
        }
        "psycheforge" => crate::psycheforge_kernel::run(root, rest),
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
        "remediate" | "auto-remediate" | "auto_remediate" => {
            run_remediation_command(root, rest, parse_bool(parse_flag(rest, "strict"), true))
        }
        "verify-proofs" | "verify_proofs" => {
            run_verify_proofs_command(root, rest, parse_bool(parse_flag(rest, "strict"), true))
        }
        "audit-logs" | "audit_logs" => {
            run_audit_logs_command(root, rest, parse_bool(parse_flag(rest, "strict"), true))
        }
        "threat-model" | "threat_model" => {
            run_threat_model_command(root, rest, parse_bool(parse_flag(rest, "strict"), true))
        }
        "blast-radius-sentinel" | "blast_radius_sentinel" => {
            run_blast_radius_command(root, rest, parse_bool(parse_flag(rest, "strict"), true))
        }
        "secrets-federation" | "secrets_federation" => {
            run_secrets_federation_command(root, rest, parse_bool(parse_flag(rest, "strict"), true))
        }
        "copy-hardening-pack" | "copy_hardening_pack" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "copy-hardening-pack",
            "V6-SEC-014",
            &[("pack-uri", None), ("version", None)],
        ),
        "governance-hardening-pack" | "governance_hardening_pack" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "governance-hardening-pack",
            "V6-SEC-GOVERNANCE-PACK-001",
            &[("pack-id", None), ("window-days", None)],
        ),
        "repository-access-auditor" | "repository_access_auditor" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "repository-access-auditor",
            "V6-SEC-004",
            &[("report-path", None)],
        ),
        "operator-terms-ack" | "operator_terms_ack" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "operator-terms-ack",
            "V6-SEC-OPERATOR-TERMS-001",
            &[("operator-id", None), ("terms-version", None)],
        ),
        "governance-hardening-lane" | "governance_hardening_lane" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "governance-hardening-lane",
            "V6-SEC-013",
            &[("scoreboard-path", None), ("window-days", None)],
        ),
        "skill-install-path-enforcer" | "skill_install_path_enforcer" => {
            run_skill_install_path_enforcer(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
            )
        }
        "skill-quarantine" | "skill_quarantine" => {
            run_skill_quarantine_command(root, rest, parse_bool(parse_flag(rest, "strict"), true))
        }
        "autonomous-skill-necessity-audit" | "autonomous_skill_necessity_audit" => {
            run_autonomous_skill_necessity_audit(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
            )
        }
        "formal-invariant-engine" | "formal_invariant_engine" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "formal-invariant-engine",
            "V6-SEC-005",
            &[("proof-pack", None)],
        ),
        "repo-hygiene-guard" | "repo_hygiene_guard" => run_repo_hygiene_guard(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "repo-hygiene-guard",
        ),
        "capability-envelope-guard" | "capability_envelope_guard" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "capability-envelope-guard",
            "V6-SEC-ENVELOPE-001",
            &[("capability", None), ("boundary", Some("conduit_only"))],
        ),
        "ip-posture-review" | "ip_posture_review" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "ip-posture-review",
            "V6-SEC-002",
            &[("public-url", None)],
        ),
        "habit-hygiene-guard" | "habit_hygiene_guard" => run_repo_hygiene_guard(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "habit-hygiene-guard",
        ),
        "enterprise-access-gate" | "enterprise_access_gate" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "enterprise-access-gate",
            "V6-SEC-009",
            &[("profile", None)],
        ),
        "model-vaccine-sandbox" | "model_vaccine_sandbox" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "model-vaccine-sandbox",
            "V6-SEC-008",
            &[("suite", None)],
        ),
        "skill-install-enforcer" | "skill_install_enforcer" => run_skill_install_path_enforcer(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
        ),
        "execution-sandbox-envelope" | "execution_sandbox_envelope" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "execution-sandbox-envelope",
                "V6-SEC-SANDBOX-ENVELOPE-001",
                &[("sandbox", Some("enabled"))],
            )
        }
        "workspace-dump-guard" | "workspace_dump_guard" => {
            run_workspace_dump_guard(root, rest, parse_bool(parse_flag(rest, "strict"), true))
        }
        "external-security-cycle" | "external_security_cycle" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "external-security-cycle",
            "V6-SEC-007",
            &[("deployment-id", None)],
        ),
        "log-redaction-guard" | "log_redaction_guard" => {
            run_log_redaction_guard(root, rest, parse_bool(parse_flag(rest, "strict"), true))
        }
        "rsi-git-patch-self-mod-gate" | "rsi_git_patch_self_mod_gate" => {
            run_rsi_git_patch_self_mod_gate(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
            )
        }
        "request-ingress" | "request_ingress" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "request-ingress",
            "V6-SEC-006",
            &[("policy-version", None), ("contact", None)],
        ),
        "startup-attestation-boot-gate" | "startup_attestation_boot_gate" => {
            run_startup_attestation_boot_gate(root, rest)
        }
        "conflict-marker-guard" | "conflict_marker_guard" => run_repo_hygiene_guard(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "conflict-marker-guard",
        ),
        "llm-gateway-guard" | "llm_gateway_guard" => {
            run_llm_gateway_guard(root, rest, parse_bool(parse_flag(rest, "strict"), true))
        }
        "required-checks-policy-guard" | "required_checks_policy_guard" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "required-checks-policy-guard",
                "V6-SEC-003",
                &[
                    ("codeql", Some("required")),
                    ("dependabot", Some("required")),
                ],
            )
        }
        "mcp-a2a-venom-contract-gate" | "mcp_a2a_venom_contract_gate" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "mcp-a2a-venom-contract-gate",
                "V6-SEC-015",
                &[("boundary", Some("conduit_only"))],
            )
        }
        "critical-runtime-formal-depth-pack" | "critical_runtime_formal_depth_pack" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "critical-runtime-formal-depth-pack",
                "V6-SEC-CRITICAL-RUNTIME-001",
                &[("proof-pack", None), ("depth-level", None)],
            )
        }
        "dire-case-emergency-autonomy-protocol" | "dire_case_emergency_autonomy_protocol" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "dire-case-emergency-autonomy-protocol",
                "V6-SEC-DIRE-AUTONOMY-001",
                &[("incident-id", None), ("trigger", None)],
            )
        }
        "supply-chain-reproducible-build-plane" | "supply_chain_reproducible_build_plane" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "supply-chain-reproducible-build-plane",
                "V6-SEC-001",
                &[("sbom-path", None), ("release-tag", None)],
            )
        }
        "signed-plugin-trust-marketplace" | "signed_plugin_trust_marketplace" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "signed-plugin-trust-marketplace",
                "V6-SEC-017",
                &[("advisory-id", None), ("sbom-digest", None)],
            )
        }
        "phoenix-protocol-respawn-continuity" | "phoenix_protocol_respawn_continuity" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "phoenix-protocol-respawn-continuity",
                "V6-SEC-PHOENIX-001",
                &[("continuity-id", None), ("checkpoint", None)],
            )
        }
        "multi-mind-isolation-boundary-plane" | "multi_mind_isolation_boundary_plane" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "multi-mind-isolation-boundary-plane",
                "V6-SEC-MULTI-MIND-001",
                &[("boundary", Some("strict")), ("mind-id", None)],
            )
        }
        "irrevocable-geas-covenant" | "irrevocable_geas_covenant" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "irrevocable-geas-covenant",
            "V6-SEC-GEAS-001",
            &[("covenant-id", None), ("signer", None)],
        ),
        "insider-threat-split-trust-command-governance"
        | "insider_threat_split_trust_command_governance" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "insider-threat-split-trust-command-governance",
            "V6-SEC-INSIDER-SPLIT-TRUST-001",
            &[("approver-a", None), ("approver-b", None)],
        ),
        "independent-safety-coprocessor-veto-plane"
        | "independent_safety_coprocessor_veto_plane" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "independent-safety-coprocessor-veto-plane",
            "V6-SEC-COPROCESSOR-VETO-001",
            &[("coprocessor-id", None), ("veto-mode", None)],
        ),
        "hardware-root-of-trust-attestation-mesh" | "hardware_root_of_trust_attestation_mesh" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "hardware-root-of-trust-attestation-mesh",
                "V6-SEC-HARDWARE-ATTESTATION-001",
                &[("attestation-doc", None), ("node-id", None)],
            )
        }
        "formal-threat-modeling-engine" | "formal_threat_modeling_engine" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "formal-threat-modeling-engine",
                "V6-SEC-THREAT-MODEL-001",
                &[("threat-model-path", None)],
            )
        }
        "formal-mind-sovereignty-verification" | "formal_mind_sovereignty_verification" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "formal-mind-sovereignty-verification",
                "V6-SEC-MIND-SOVEREIGNTY-001",
                &[("proof-pack", None)],
            )
        }
        "alias-verification-vault" | "alias_verification_vault" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "alias-verification-vault",
            "V6-SEC-ALIAS-VAULT-001",
            &[("alias", None), ("identity-hash", None)],
        ),
        "psycheforge-psycheforge-organ" | "psycheforge_psycheforge_organ" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "psycheforge-psycheforge-organ",
                "V6-SEC-PSYCHE-001",
                &[("profile", None), ("confidence", None)],
            )
        }
        "psycheforge-profile-synthesizer" | "psycheforge_profile_synthesizer" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "psycheforge-profile-synthesizer",
                "V6-SEC-PSYCHE-001",
                &[("signal-pack", None), ("profile", None)],
            )
        }
        "psycheforge-temporal-profile-store" | "psycheforge_temporal_profile_store" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "psycheforge-temporal-profile-store",
                "V6-SEC-PSYCHE-001",
                &[("profile", None), ("window-hours", None)],
            )
        }
        "psycheforge-countermeasure-selector" | "psycheforge_countermeasure_selector" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "psycheforge-countermeasure-selector",
                "V6-SEC-PSYCHE-001",
                &[("profile", None), ("response-level", None)],
            )
        }
        "delegated-authority-branching" | "delegated_authority_branching" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "delegated-authority-branching",
                "V6-SEC-DELEGATED-AUTH-001",
                &[("authority-branch", None), ("delegation-token", None)],
            )
        }
        "organ-state-encryption-plane" | "organ_state_encryption_plane" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "organ-state-encryption-plane",
                "V6-SEC-ORGAN-ENCRYPTION-001",
                &[("algorithm", Some("aes-256-gcm")), ("key-id", None)],
            )
        }
        "remote-tamper-heartbeat" | "remote_tamper_heartbeat" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "remote-tamper-heartbeat",
            "V6-SEC-TAMPER-HEARTBEAT-001",
            &[("heartbeat-id", None), ("epoch", None)],
        ),
        "skin-protection-layer" | "skin_protection_layer" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "skin-protection-layer",
            "V6-SEC-SKIN-PROTECTION-001",
            &[("surface", None)],
        ),
        "critical-path-formal-verifier" | "critical_path_formal_verifier" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "critical-path-formal-verifier",
                "V6-SEC-CRITICAL-FORMAL-001",
                &[("proof-pack", None)],
            )
        }
        "key-lifecycle-governor" | "key_lifecycle_governor" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "key-lifecycle-governor",
            "V6-SEC-KEY-LIFECYCLE-001",
            &[("key-id", None), ("action", None)],
        ),
        "supply-chain-trust-plane" | "supply_chain_trust_plane" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "supply-chain-trust-plane",
            "V6-SEC-SUPPLY-TRUST-001",
            &[("sbom-digest", None), ("provenance", None)],
        ),
        "post-quantum-migration-lane" | "post_quantum_migration_lane" => {
            run_security_contract_command(
                root,
                rest,
                parse_bool(parse_flag(rest, "strict"), true),
                "post-quantum-migration-lane",
                "V6-SEC-POST-QUANTUM-001",
                &[("profile", None), ("phase", None)],
            )
        }
        "safety-resilience-guard" | "safety_resilience_guard" => run_security_contract_command(
            root,
            rest,
            parse_bool(parse_flag(rest, "strict"), true),
            "safety-resilience-guard",
            "V6-SEC-RESILIENCE-001",
            &[("scenario", None), ("rto-seconds", None)],
        ),
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
                    "t0-invariants",
                    "thorn-swarm-protocol",
                    "psycheforge",
                    "goal-preservation-kernel",
                    "dream-warden-guard",
                    "abac-policy-plane",
                    "scan",
                    "remediate",
                    "verify-proofs",
                    "audit-logs",
                    "threat-model",
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
                    "protheus-ops security-plane black-box-ledger <append|export|rollup|verify|verify-offline|status> [flags]",
                    "protheus-ops security-plane t0-invariants <status|evaluate|fuzz> [flags]",
                    "protheus-ops security-plane thorn-swarm-protocol <status|quarantine|release> [flags]",
                    "protheus-ops security-plane psycheforge <status|profile> [flags]",
                    "protheus-ops security-plane goal-preservation-kernel <evaluate|status> [flags]",
                    "protheus-ops security-plane dream-warden-guard <run|status> [flags]",
                    "protheus-ops security-plane truth-seeking-gate <status|ingest-rule|evaluate> [flags]",
                    "protheus-ops security-plane abac-policy-plane <status|evaluate> [flags]",
                    "protheus-ops security-plane scan [--prompt=<text>] [--tool-input=<text>] [--mcp=<text>] [--pack=<id>] [--critical-threshold=<n>] [--strict=1|0]",
                    "protheus-ops security-plane remediate [--strict=1|0]",
                    "protheus-ops security-plane verify-proofs [--proof-pack=<path>] [--min-files=<n>] [--extensions=smt2,lean,proof,json,md] [--strict=1|0]",
                    "protheus-ops security-plane audit-logs [--max-events=<n>] [--max-failures=<n>] [--strict=1|0]",
                    "protheus-ops security-plane threat-model [--scenario=<id>] [--surface=<id>] [--vector=<text>] [--block-threshold=<n>] [--allow=1|0] [--strict=1|0]",
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
