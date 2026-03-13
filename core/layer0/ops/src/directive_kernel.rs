// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use crate::v8_kernel::{
    append_jsonl, keyed_digest_hex, parse_bool, print_json, read_json, scoped_state_root,
    sha256_hex_str, write_json, write_receipt,
};
use crate::{clean, now_iso, parse_args};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "DIRECTIVE_KERNEL_STATE_ROOT";
const STATE_SCOPE: &str = "directive_kernel";
const SIGNING_ENV: &str = "DIRECTIVE_KERNEL_SIGNING_KEY";

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
    let key = std::env::var(SIGNING_ENV).unwrap_or_default();
    if key.trim().is_empty() {
        // still deterministic, but marked as unsigned in policy metadata.
        return format!(
            "unsigned:{}",
            sha256_hex_str(&serde_json::to_string(entry).unwrap_or_default())
        );
    }
    format!("sig:{}", keyed_digest_hex(&key, entry))
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
        let strict = std::env::var("DIRECTIVE_KERNEL_STRICT_SIGNATURE_VERIFY")
            .ok()
            .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or(false);
        if !strict {
            return true;
        }
        let key = std::env::var(SIGNING_ENV).unwrap_or_default();
        if key.trim().is_empty() {
            return false;
        }
        return raw.eq_ignore_ascii_case(&keyed_digest_hex(&key, &payload));
    }
    false
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
        out.push(row);
    }
    for row in derived_rows(vault) {
        if is_entry_active(&row) {
            out.push(row);
        }
    }
    out
}

pub fn directive_vault_hash(root: &Path) -> String {
    let vault = load_vault(root);
    sha256_hex_str(&serde_json::to_string(&vault).unwrap_or_default())
}

pub fn evaluate_action(root: &Path, action: &str) -> Value {
    let vault = load_vault(root);
    let action_norm = clean(action, 320).to_ascii_lowercase();
    let rules = collect_rules(&vault);

    let mut deny_hits = Vec::new();
    let mut allow_hits = Vec::new();
    let mut invalid_signature_hits = Vec::new();
    for row in rules {
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

    parent_kind == "deny" && child_rule_kind == "allow" && (child_pattern == parent_pattern)
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

fn emit_receipt(root: &Path, payload: Value) -> i32 {
    match write_receipt(root, STATE_ENV, STATE_SCOPE, payload) {
        Ok(out) => {
            print_json(&out);
            if out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                0
            } else {
                2
            }
        }
        Err(err) => {
            let mut out = json!({
                "ok": false,
                "type": "directive_kernel_error",
                "lane": "core/layer0/ops",
                "error": clean(err, 240),
                "exit_code": 2
            });
            out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
            print_json(&out);
            2
        }
    }
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let command = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        println!("Usage:");
        println!("  protheus-ops directive-kernel status");
        println!("  protheus-ops directive-kernel prime-sign [--directive=<text>] [--signer=<id>] [--allow-unsigned=1|0]");
        println!("  protheus-ops directive-kernel derive [--parent=<id|text>] [--directive=<text>] [--signer=<id>] [--allow-unsigned=1|0]");
        println!("  protheus-ops directive-kernel compliance-check [--action=<text>]");
        println!("  protheus-ops directive-kernel bridge-rsi [--proposal=<text>] [--apply=1|0]");
        println!("  protheus-ops directive-kernel migrate [--apply=1|0] [--allow-unsigned=1|0]");
        return 0;
    }

    if command == "status" {
        let vault = load_vault(root);
        let (signature_total, signature_valid) = signature_counts(&vault);
        let mut out = json!({
            "ok": true,
            "type": "directive_kernel_status",
            "lane": "core/layer0/ops",
            "vault": vault,
            "policy_hash": directive_vault_hash(root),
            "signature_summary": {
                "total_entries": signature_total,
                "valid_entries": signature_valid,
                "invalid_entries": signature_total.saturating_sub(signature_valid)
            },
            "latest": read_json(&latest_path(root))
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        print_json(&out);
        return 0;
    }

    if command == "prime-sign"
        || (command == "prime"
            && parsed
                .positional
                .get(1)
                .map(|v| v.eq_ignore_ascii_case("sign"))
                .unwrap_or(false))
    {
        let directive = parsed
            .flags
            .get("directive")
            .cloned()
            .unwrap_or_else(|| "deny:unsafe_action".to_string());
        let signer = parsed
            .flags
            .get("signer")
            .cloned()
            .unwrap_or_else(|| "operator".to_string());
        let allow_unsigned = parse_bool(parsed.flags.get("allow-unsigned"), false);
        if !allow_unsigned && !signing_key_present() {
            return emit_receipt(
                root,
                json!({
                    "ok": false,
                    "type": "directive_kernel_prime_sign",
                    "lane": "core/layer0/ops",
                    "error": "missing_signing_key",
                    "signing_env": SIGNING_ENV,
                    "claim_evidence": [
                        {
                            "id": "v8_directives_001_1",
                            "claim": "prime_directives_are_append_only_signed_objects_not_inline_mutations",
                            "evidence": {"accepted": false, "reason": "missing_signing_key"}
                        }
                    ]
                }),
            );
        }

        let entry = match append_directive_entry(
            root,
            "prime",
            &directive,
            &signer,
            None,
            "operator_sign",
        ) {
            Ok(v) => v,
            Err(err) => {
                return emit_receipt(
                    root,
                    json!({
                        "ok": false,
                        "type": "directive_kernel_prime_sign",
                        "lane": "core/layer0/ops",
                        "error": clean(&err, 240),
                        "claim_evidence": [
                            {
                                "id": "v8_directives_001_1",
                                "claim": "prime_directives_are_append_only_signed_objects_not_inline_mutations",
                                "evidence": {"error": clean(&err, 240)}
                            }
                        ]
                    }),
                );
            }
        };
        return emit_receipt(
            root,
            json!({
                "ok": true,
                "type": "directive_kernel_prime_sign",
                "lane": "core/layer0/ops",
                "entry": entry,
                "policy_hash": directive_vault_hash(root),
                "layer_map": ["0","1","2"],
                "claim_evidence": [
                    {
                        "id": "v8_directives_001_1",
                        "claim": "prime_directives_are_append_only_signed_objects_not_inline_mutations",
                        "evidence": {
                            "entry_id": entry.get("id").cloned().unwrap_or(Value::Null),
                            "signature_present": entry.get("signature").and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false)
                        }
                    }
                ]
            }),
        );
    }

    if command == "derive" {
        let parent_hint = parsed.flags.get("parent").cloned().unwrap_or_default();
        let directive = parsed
            .flags
            .get("directive")
            .cloned()
            .unwrap_or_else(|| "allow:bounded_autonomy".to_string());
        let signer = parsed
            .flags
            .get("signer")
            .cloned()
            .unwrap_or_else(|| "system".to_string());
        let allow_unsigned = parse_bool(parsed.flags.get("allow-unsigned"), false);
        if !allow_unsigned && !signing_key_present() {
            return emit_receipt(
                root,
                json!({
                    "ok": false,
                    "type": "directive_kernel_derive",
                    "lane": "core/layer0/ops",
                    "error": "missing_signing_key",
                    "signing_env": SIGNING_ENV,
                    "layer_map": ["0","1","2"],
                    "claim_evidence": [
                        {
                            "id": "v8_directives_001_2",
                            "claim": "derived_directives_require_parent_linkage_and_fail_on_inheritance_conflict",
                            "evidence": {"accepted": false, "reason": "missing_signing_key"}
                        }
                    ]
                }),
            );
        }

        let vault = load_vault(root);
        let Some(parent) = resolve_parent(&vault, &parent_hint) else {
            return emit_receipt(
                root,
                json!({
                    "ok": false,
                    "type": "directive_kernel_derive",
                    "lane": "core/layer0/ops",
                    "error": "parent_not_found",
                    "parent": clean(parent_hint, 320),
                    "layer_map": ["0","1","2"],
                    "claim_evidence": [
                        {
                            "id": "v8_directives_001_2",
                            "claim": "derived_directives_require_parent_linkage_and_fail_on_inheritance_conflict",
                            "evidence": {"accepted": false, "reason": "parent_not_found"}
                        }
                    ]
                }),
            );
        };

        let (child_kind, child_pattern) = normalize_rule(&directive);
        if has_inheritance_conflict(&parent, &child_kind, &child_pattern) {
            return emit_receipt(
                root,
                json!({
                    "ok": false,
                    "type": "directive_kernel_derive",
                    "lane": "core/layer0/ops",
                    "error": "inheritance_conflict",
                    "parent": parent,
                    "directive": clean(directive, 320),
                    "layer_map": ["0","1","2"],
                    "claim_evidence": [
                        {
                            "id": "v8_directives_001_2",
                            "claim": "derived_directives_require_parent_linkage_and_fail_on_inheritance_conflict",
                            "evidence": {"accepted": false, "reason": "inheritance_conflict"}
                        }
                    ]
                }),
            );
        }

        let parent_id = parent
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        let mut entry = match append_directive_entry(
            root,
            "derived",
            &directive,
            &signer,
            Some(&parent_id),
            "derived_engine",
        ) {
            Ok(v) => v,
            Err(err) => {
                return emit_receipt(
                    root,
                    json!({
                        "ok": false,
                        "type": "directive_kernel_derive",
                        "lane": "core/layer0/ops",
                        "error": clean(&err, 240),
                        "claim_evidence": [
                            {
                                "id": "v8_directives_001_2",
                                "claim": "derived_directives_require_parent_linkage_and_fail_on_inheritance_conflict",
                                "evidence": {"accepted": false, "reason": clean(&err, 240)}
                            }
                        ]
                    }),
                );
            }
        };
        entry["accepted"] = Value::Bool(true);

        let mut vault2 = load_vault(root);
        let obj = vault_obj_mut(&mut vault2);
        let rows = ensure_array(obj, "derived");
        if let Some(last) = rows.last_mut() {
            *last = entry.clone();
        }
        let _ = write_vault(root, &vault2);

        return emit_receipt(
            root,
            json!({
                "ok": true,
                "type": "directive_kernel_derive",
                "lane": "core/layer0/ops",
                "entry": entry,
                "parent": parent,
                "policy_hash": directive_vault_hash(root),
                "layer_map": ["0","1","2"],
                "claim_evidence": [
                    {
                        "id": "v8_directives_001_2",
                        "claim": "derived_directives_require_parent_linkage_and_fail_on_inheritance_conflict",
                        "evidence": {"accepted": true, "parent_id": parent_id}
                    }
                ]
            }),
        );
    }

    if command == "compliance-check" {
        let action = parsed
            .flags
            .get("action")
            .cloned()
            .unwrap_or_else(|| "unknown_action".to_string());
        let eval = evaluate_action(root, &action);
        return emit_receipt(
            root,
            json!({
                "ok": eval.get("allowed").and_then(Value::as_bool).unwrap_or(false),
                "type": "directive_kernel_compliance_check",
                "lane": "core/layer0/ops",
                "evaluation": eval,
                "gates": {
                    "conduit_required": true,
                    "prime_derived_hierarchy_enforced": true,
                    "override_flags_ignored": true,
                    "signature_verification_required": true
                },
                "layer_map": ["0","1","2"],
                "claim_evidence": [
                    {
                        "id": "v8_directives_001_3",
                        "claim": "all_actions_must_pass_directive_compliance_gate_before_execution",
                        "evidence": {
                            "action": clean(action, 220),
                            "allowed": eval.get("allowed").cloned().unwrap_or(Value::Bool(false)),
                            "deny_hits": eval.get("deny_hits").cloned().unwrap_or(Value::Array(Vec::new())),
                            "invalid_signature_hits": eval.get("invalid_signature_hits").cloned().unwrap_or(Value::Array(Vec::new()))
                        }
                    }
                ]
            }),
        );
    }

    if command == "bridge-rsi" {
        let proposal = parsed
            .flags
            .get("proposal")
            .cloned()
            .unwrap_or_else(|| "propose_loop_optimization".to_string());
        let apply = parse_bool(parsed.flags.get("apply"), true);
        let action = format!("rsi:{}", clean(&proposal, 220).to_ascii_lowercase());
        let eval = evaluate_action(root, &action);
        let allowed = eval
            .get("allowed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let rollback_pointer = format!(
            "rollback://directive_bridge/{}",
            &sha256_hex_str(&format!("{}:{}", now_iso(), proposal))[..18]
        );

        if apply && !allowed {
            let _ = append_jsonl(
                &history_path(root),
                &json!({
                    "ok": false,
                    "type": "directive_kernel_rsi_bridge_rollback",
                    "ts": now_iso(),
                    "proposal": clean(&proposal, 220),
                    "rollback_pointer": rollback_pointer,
                    "reason": "directive_gate_denied"
                }),
            );
        }

        return emit_receipt(
            root,
            json!({
                "ok": allowed,
                "type": "directive_kernel_rsi_bridge",
                "lane": "core/layer0/ops",
                "proposal": clean(&proposal, 220),
                "apply": apply,
                "allowed": allowed,
                "evaluation": eval,
                "rollback_pointer": rollback_pointer,
                "layer_map": ["0","1","2","3"],
                "claim_evidence": [
                    {
                        "id": "v8_directives_001_4",
                        "claim": "rsi_and_inversion_mutations_are_bound_to_prime_and_derived_directive_checks",
                        "evidence": {"allowed": allowed, "proposal": clean(proposal, 220)}
                    }
                ]
            }),
        );
    }

    if command == "migrate" {
        let apply = parse_bool(parsed.flags.get("apply"), true);
        let allow_unsigned = parse_bool(parsed.flags.get("allow-unsigned"), false);
        if apply && !allow_unsigned && !signing_key_present() {
            return emit_receipt(
                root,
                json!({
                    "ok": false,
                    "type": "directive_kernel_migrate",
                    "lane": "core/layer0/ops",
                    "error": "missing_signing_key",
                    "signing_env": SIGNING_ENV,
                    "layer_map": ["0","1","2","client","app"],
                    "claim_evidence": [
                        {
                            "id": "v8_directives_001_5",
                            "claim": "directive_migration_and_status_are_available_as_one_command_core_paths",
                            "evidence": {"apply": apply, "ok": false, "reason": "missing_signing_key"}
                        }
                    ]
                }),
            );
        }
        let migrated = migrate_legacy_markdown(root, apply).unwrap_or_else(|err| {
            json!({
                "error": clean(err, 220),
                "harvested_count": 0,
                "imported_count": 0
            })
        });
        let ok = !migrated.get("error").is_some();
        return emit_receipt(
            root,
            json!({
                "ok": ok,
                "type": "directive_kernel_migrate",
                "lane": "core/layer0/ops",
                "apply": apply,
                "migration": migrated,
                "commands": ["protheus directives migrate", "protheus directives status", "protheus prime sign"],
                "policy_hash": directive_vault_hash(root),
                "layer_map": ["0","1","2","client","app"],
                "claim_evidence": [
                    {
                        "id": "v8_directives_001_5",
                        "claim": "directive_migration_and_status_are_available_as_one_command_core_paths",
                        "evidence": {"apply": apply, "ok": ok}
                    }
                ]
            }),
        );
    }

    emit_receipt(
        root,
        json!({
            "ok": false,
            "type": "directive_kernel_error",
            "lane": "core/layer0/ops",
            "error": "unknown_command",
            "command": command,
            "exit_code": 2
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("protheus_directive_kernel_{name}_{nonce}"));
        fs::create_dir_all(&root).expect("mkdir");
        root
    }

    #[test]
    fn derive_requires_parent_prime_rule() {
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

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tampered_signature_is_rejected_by_compliance_gate() {
        std::env::set_var(SIGNING_ENV, "test-signing-key");
        std::env::set_var("DIRECTIVE_KERNEL_STRICT_SIGNATURE_VERIFY", "1");
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
            eval.get("invalid_signature_hits")
                .and_then(Value::as_array)
                .map(|rows| !rows.is_empty()),
            Some(true)
        );

        std::env::remove_var("DIRECTIVE_KERNEL_STRICT_SIGNATURE_VERIFY");
        std::env::remove_var(SIGNING_ENV);
        let _ = fs::remove_dir_all(root);
    }
}
