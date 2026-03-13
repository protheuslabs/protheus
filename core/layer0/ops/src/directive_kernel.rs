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
        if is_entry_active(&row) {
            out.push(row);
        }
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
    let mut rows = prime_rows(&vault);
    rows.extend(derived_rows(&vault));
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
        "entry_count": entry_count,
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

pub fn run(root: &Path, argv: &[String]) -> i32 {
    directive_kernel_run::run(root, argv)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        env_lock()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
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
}
