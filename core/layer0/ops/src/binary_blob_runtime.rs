// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use crate::directive_kernel;
use crate::v8_kernel::{
    keyed_digest_hex, parse_bool, parse_f64, print_json, read_json, scoped_state_root, sha256_file,
    sha256_hex_str, write_json, write_receipt,
};
use crate::{clean, now_iso, parse_args};
use memmap2::MmapOptions;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "BINARY_BLOB_RUNTIME_STATE_ROOT";
const STATE_SCOPE: &str = "binary_blob_runtime";
const BLOB_SIGNING_ENV: &str = "BINARY_BLOB_VAULT_SIGNING_KEY";
#[path = "binary_blob_runtime_run.rs"]
mod binary_blob_runtime_run;

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn active_path(root: &Path) -> PathBuf {
    state_root(root).join("active_blobs.json")
}

fn blobs_dir(root: &Path) -> PathBuf {
    state_root(root).join("blobs")
}

fn snapshots_dir(root: &Path) -> PathBuf {
    state_root(root).join("snapshots")
}

fn mutation_history_path(root: &Path) -> PathBuf {
    state_root(root).join("mutation_history.jsonl")
}

fn prime_blob_vault_path(root: &Path) -> PathBuf {
    state_root(root).join("prime_blob_vault.json")
}

fn default_prime_blob_vault() -> Value {
    json!({
        "version": "1.0",
        "entries": [],
        "chain_head": "genesis",
        "created_at": now_iso()
    })
}

fn load_prime_blob_vault(root: &Path) -> Value {
    read_json(&prime_blob_vault_path(root)).unwrap_or_else(default_prime_blob_vault)
}

fn store_prime_blob_vault(root: &Path, vault: &Value) -> Result<(), String> {
    write_json(&prime_blob_vault_path(root), vault)
}

fn blob_vault_secret() -> Option<String> {
    std::env::var(BLOB_SIGNING_ENV)
        .ok()
        .map(|v| clean(v, 1024))
        .filter(|v| !v.is_empty())
        .or_else(|| {
            std::env::var("DIRECTIVE_KERNEL_SIGNING_KEY")
                .ok()
                .map(|v| clean(v, 1024))
                .filter(|v| !v.is_empty())
        })
}

fn blob_signature_payload(entry: &Value) -> Value {
    json!({
        "entry_id": entry.get("entry_id").cloned().unwrap_or(Value::Null),
        "module": entry.get("module").cloned().unwrap_or(Value::Null),
        "blob_id": entry.get("blob_id").cloned().unwrap_or(Value::Null),
        "source_hash": entry.get("source_hash").cloned().unwrap_or(Value::Null),
        "blob_hash": entry.get("blob_hash").cloned().unwrap_or(Value::Null),
        "policy_hash": entry.get("policy_hash").cloned().unwrap_or(Value::Null),
        "mode": entry.get("mode").cloned().unwrap_or(Value::Null),
        "shadow_pointer": entry.get("shadow_pointer").cloned().unwrap_or(Value::Null),
        "rollback_pointer": entry.get("rollback_pointer").cloned().unwrap_or(Value::Null),
        "prev_hash": entry.get("prev_hash").cloned().unwrap_or(Value::Null),
        "ts": entry.get("ts").cloned().unwrap_or(Value::Null)
    })
}

fn sign_blob_entry(entry: &Value) -> String {
    let payload = blob_signature_payload(entry);
    let key = blob_vault_secret().unwrap_or_default();
    if key.is_empty() {
        format!(
            "unsigned:{}",
            sha256_hex_str(&serde_json::to_string(&payload).unwrap_or_default())
        )
    } else {
        format!("sig:{}", keyed_digest_hex(&key, &payload))
    }
}

fn verify_blob_entry_signature(entry: &Value) -> bool {
    let sig = entry
        .get("signature")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if sig.is_empty() {
        return false;
    }
    let payload = blob_signature_payload(entry);
    if let Some(raw) = sig.strip_prefix("unsigned:") {
        return raw.eq_ignore_ascii_case(&sha256_hex_str(
            &serde_json::to_string(&payload).unwrap_or_default(),
        ));
    }
    if let Some(raw) = sig.strip_prefix("sig:") {
        let Some(key) = blob_vault_secret() else {
            return false;
        };
        return raw.eq_ignore_ascii_case(&keyed_digest_hex(&key, &payload));
    }
    false
}

fn canonical_blob_entry_for_hash(entry: &Value) -> Value {
    let mut canonical = entry.clone();
    if let Some(obj) = canonical.as_object_mut() {
        obj.remove("entry_hash");
    }
    canonical
}

fn recompute_blob_entry_hash(entry: &Value) -> String {
    sha256_hex_str(
        &serde_json::to_string(&canonical_blob_entry_for_hash(entry)).unwrap_or_default(),
    )
}

fn validate_prime_blob_vault(vault: &Value) -> Value {
    let entries = vault
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let entry_count = entries.len() as u64;
    let chain_head = vault
        .get("chain_head")
        .and_then(Value::as_str)
        .unwrap_or("genesis")
        .to_string();
    let mut signature_valid = 0u64;
    let mut hash_valid = 0u64;
    let mut errors: Vec<String> = Vec::new();
    let mut by_hash: HashMap<String, Value> = HashMap::new();

    for (idx, entry) in entries.iter().enumerate() {
        if verify_blob_entry_signature(entry) {
            signature_valid += 1;
        } else {
            errors.push(format!("signature_invalid_at:{idx}"));
        }
        let actual = entry
            .get("entry_hash")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let expected = recompute_blob_entry_hash(entry);
        if !actual.is_empty() && actual.eq_ignore_ascii_case(&expected) {
            hash_valid += 1;
            if by_hash.insert(actual.clone(), entry.clone()).is_some() {
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
            let Some(entry) = by_hash.get(&cursor) else {
                chain_valid = false;
                errors.push(format!("chain_head_missing_entry:{cursor}"));
                break;
            };
            traversed_count += 1;
            cursor = entry
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

    let ok = entry_count == signature_valid && entry_count == hash_valid && chain_valid;
    json!({
        "ok": ok,
        "entry_count": entry_count,
        "signature_valid_count": signature_valid,
        "hash_valid_count": hash_valid,
        "chain_valid": chain_valid,
        "chain_head": chain_head,
        "errors": errors
    })
}

fn append_prime_blob_vault_entry(root: &Path, snapshot: &Value) -> Result<Value, String> {
    let mut vault = load_prime_blob_vault(root);
    if !vault.is_object() {
        vault = default_prime_blob_vault();
    }
    let obj = vault
        .as_object_mut()
        .ok_or_else(|| "blob_vault_not_object".to_string())?;
    let prev_hash = obj
        .get("chain_head")
        .and_then(Value::as_str)
        .unwrap_or("genesis")
        .to_string();

    let mut entry = json!({
        "entry_id": format!("blobv_{}", &sha256_hex_str(&format!("{}:{}", now_iso(), snapshot.get("blob_id").and_then(Value::as_str).unwrap_or("unknown")))[..16]),
        "module": snapshot.get("module").cloned().unwrap_or(Value::Null),
        "blob_id": snapshot.get("blob_id").cloned().unwrap_or(Value::Null),
        "source_hash": snapshot.get("source_hash").cloned().unwrap_or(Value::Null),
        "blob_hash": snapshot.get("blob_hash").cloned().unwrap_or(Value::Null),
        "policy_hash": snapshot.get("policy_hash").cloned().unwrap_or(Value::Null),
        "mode": snapshot.get("mode").cloned().unwrap_or(Value::Null),
        "shadow_pointer": snapshot.get("shadow_pointer").cloned().unwrap_or(Value::Null),
        "rollback_pointer": snapshot.get("rollback_pointer").cloned().unwrap_or(Value::Null),
        "prev_hash": prev_hash,
        "ts": now_iso()
    });
    let signature = sign_blob_entry(&entry);
    entry["signature"] = Value::String(signature);
    let entry_hash = sha256_hex_str(&serde_json::to_string(&entry).unwrap_or_default());
    entry["entry_hash"] = Value::String(entry_hash.clone());

    if !obj.get("entries").map(Value::is_array).unwrap_or(false) {
        obj.insert("entries".to_string(), Value::Array(Vec::new()));
    }
    obj.get_mut("entries")
        .and_then(Value::as_array_mut)
        .expect("entries_array")
        .push(entry.clone());
    obj.insert("chain_head".to_string(), Value::String(entry_hash));
    store_prime_blob_vault(root, &vault)?;
    Ok(entry)
}

fn find_prime_blob_entry(root: &Path, module: &str, blob_id: &str) -> Option<Value> {
    let vault = load_prime_blob_vault(root);
    let entries = vault.get("entries").and_then(Value::as_array)?;
    entries
        .iter()
        .rev()
        .find(|row| {
            row.get("module")
                .and_then(Value::as_str)
                .map(|v| v == module)
                .unwrap_or(false)
                && row
                    .get("blob_id")
                    .and_then(Value::as_str)
                    .map(|v| v == blob_id)
                    .unwrap_or(false)
        })
        .cloned()
}

fn normalize_module(raw: Option<&String>) -> String {
    clean(raw.cloned().unwrap_or_else(|| "all".to_string()), 96)
        .to_ascii_lowercase()
        .replace(' ', "_")
}

fn module_source_path(root: &Path, module: &str, explicit: Option<&String>) -> PathBuf {
    if let Some(p) = explicit {
        let c = PathBuf::from(clean(p, 512));
        if c.is_absolute() {
            return c;
        }
        return root.join(c);
    }
    root.join("core")
        .join("layer0")
        .join("ops")
        .join("src")
        .join(format!("{module}.rs"))
}

fn sha256_file_mmap(path: &Path) -> Result<String, String> {
    let file =
        fs::File::open(path).map_err(|err| format!("blob_open_failed:{}:{err}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|err| format!("blob_metadata_failed:{}:{err}", path.display()))?;
    if metadata.len() == 0 {
        return Ok(sha256_hex_str(""));
    }
    if metadata.len() > usize::MAX as u64 {
        return Err("blob_too_large_for_mmap".to_string());
    }
    let map = unsafe { MmapOptions::new().map(&file) }
        .map_err(|err| format!("blob_mmap_failed:{}:{err}", path.display()))?;
    Ok(crate::v8_kernel::sha256_hex_bytes(&map))
}

fn read_first_bytes(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let mut file =
        fs::File::open(path).map_err(|err| format!("blob_open_failed:{}:{err}", path.display()))?;
    let mut buf = vec![0u8; limit];
    let read = file
        .read(&mut buf)
        .map_err(|err| format!("blob_read_failed:{}:{err}", path.display()))?;
    buf.truncate(read);
    Ok(buf)
}

fn load_active_map(root: &Path) -> Map<String, Value> {
    read_json(&active_path(root))
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_active_map(root: &Path, map: &Map<String, Value>) -> Result<(), String> {
    write_json(&active_path(root), &Value::Object(map.clone()))
}

fn write_mutation_event(root: &Path, event: &Value) {
    if let Some(parent) = mutation_history_path(root).parent() {
        let _ = fs::create_dir_all(parent);
    }
    let line = serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string());
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(mutation_history_path(root))
        .and_then(|mut file| std::io::Write::write_all(&mut file, format!("{line}\n").as_bytes()));
}

fn parse_module_list(flags: &std::collections::HashMap<String, String>) -> Vec<String> {
    let csv = flags
        .get("modules")
        .cloned()
        .unwrap_or_else(|| "conduit,directive_kernel,network_protocol,intelligence_nexus,organism_layer,rsi_ignition".to_string());
    csv.split(',')
        .map(|v| clean(v, 96).to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
}

fn settle_one(root: &Path, parsed: &crate::ParsedArgs, module: &str) -> Result<Value, String> {
    let mode = clean(
        parsed
            .flags
            .get("mode")
            .cloned()
            .unwrap_or_else(|| "modular".to_string()),
        24,
    );
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let shadow_swap = parse_bool(parsed.flags.get("shadow-swap"), true);
    let source_path = module_source_path(root, module, parsed.flags.get("module-path"));

    if !source_path.exists() {
        return Err(format!("module_source_missing:{}", source_path.display()));
    }

    let source_hash = sha256_file(&source_path)?;
    let policy_hash = directive_kernel::directive_vault_hash(root);
    let blob_id = sha256_hex_str(&format!("{}:{}:{}", module, source_hash, policy_hash));

    let blob_path = blobs_dir(root).join(module).join(format!("{blob_id}.blob"));
    let snapshot_path = snapshots_dir(root)
        .join(module)
        .join(format!("{blob_id}.json"));
    let source_bytes = fs::read(&source_path)
        .map_err(|err| format!("module_source_read_failed:{}:{err}", source_path.display()))?;
    let blob_hash = crate::v8_kernel::sha256_hex_bytes(&source_bytes);
    if apply {
        if let Some(parent) = blob_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("blob_dir_create_failed:{}:{err}", parent.display()))?;
        }
        if let Some(parent) = snapshot_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("snapshot_dir_create_failed:{}:{err}", parent.display()))?;
        }
        fs::write(&blob_path, source_bytes)
            .map_err(|err| format!("blob_write_failed:{}:{err}", blob_path.display()))?;
    }

    let mut active = load_active_map(root);
    let previous = active.get(module).cloned().unwrap_or(Value::Null);
    let shadow_pointer = format!("shadow://{}:{}", module, &blob_id[..16]);
    let rollback_pointer = format!(
        "rollback://{}:{}",
        module,
        &sha256_hex_str(&now_iso())[..16]
    );

    let mut snapshot = json!({
        "module": module,
        "blob_id": blob_id,
        "source_path": source_path.display().to_string(),
        "source_hash": source_hash,
        "blob_path": blob_path.display().to_string(),
        "blob_hash": blob_hash,
        "policy_hash": policy_hash,
        "mode": mode,
        "shadow_swap": shadow_swap,
        "shadow_pointer": shadow_pointer,
        "rollback_pointer": rollback_pointer,
        "previous": previous,
        "ts": now_iso()
    });

    if apply {
        let vault_entry = append_prime_blob_vault_entry(root, &snapshot)?;
        snapshot["prime_blob_vault_entry"] = vault_entry.clone();
        write_json(&snapshot_path, &snapshot)?;
        active.insert(
            module.to_string(),
            json!({
                "blob_id": snapshot.get("blob_id").cloned().unwrap_or(Value::Null),
                "snapshot_path": snapshot_path.display().to_string(),
                "blob_path": blob_path.display().to_string(),
                "policy_hash": snapshot.get("policy_hash").cloned().unwrap_or(Value::Null),
                "source_hash": snapshot.get("source_hash").cloned().unwrap_or(Value::Null),
                "blob_hash": snapshot.get("blob_hash").cloned().unwrap_or(Value::Null),
                "prime_blob_vault_entry_id": vault_entry.get("entry_id").cloned().unwrap_or(Value::Null),
                "previous": snapshot.get("previous").cloned().unwrap_or(Value::Null),
                "shadow_pointer": shadow_pointer,
                "rollback_pointer": rollback_pointer,
                "active_at": now_iso()
            }),
        );
        write_active_map(root, &active)?;
    }

    Ok(json!({
        "module": module,
        "snapshot": snapshot,
        "snapshot_path": snapshot_path.display().to_string(),
        "blob_path": blob_path.display().to_string(),
        "applied": apply
    }))
}

fn load_and_verify(root: &Path, module: &str) -> Result<Value, String> {
    let vault_integrity = validate_prime_blob_vault(&load_prime_blob_vault(root));
    if !vault_integrity
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("prime_blob_vault_chain_invalid".to_string());
    }

    let active = load_active_map(root);
    let Some(entry) = active.get(module).cloned() else {
        return Err("module_not_settled".to_string());
    };

    let snapshot_path = entry
        .get("snapshot_path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| "snapshot_path_missing".to_string())?;
    if !snapshot_path.exists() {
        return Err(format!("snapshot_missing:{}", snapshot_path.display()));
    }

    let snapshot = read_json(&snapshot_path)
        .ok_or_else(|| format!("snapshot_read_failed:{}", snapshot_path.display()))?;
    let source_path = snapshot
        .get("source_path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| "snapshot_source_path_missing".to_string())?;
    let expected_source_hash = snapshot
        .get("source_hash")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let source_hash = sha256_file(&source_path)?;
    let expected_policy_hash = snapshot
        .get("policy_hash")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let blob_path = snapshot
        .get("blob_path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(|| {
            entry
                .get("blob_path")
                .and_then(Value::as_str)
                .map(PathBuf::from)
        })
        .ok_or_else(|| "snapshot_blob_path_missing".to_string())?;
    let expected_blob_hash = snapshot
        .get("blob_hash")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let expected_blob_id = snapshot
        .get("blob_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let current_policy_hash = directive_kernel::directive_vault_hash(root);

    if source_hash != expected_source_hash {
        return Err("source_hash_mismatch".to_string());
    }
    if !blob_path.exists() {
        return Err(format!("blob_missing:{}", blob_path.display()));
    }
    let blob_hash = sha256_file_mmap(&blob_path)?;
    if blob_hash != expected_blob_hash {
        return Err("blob_hash_mismatch".to_string());
    }
    if current_policy_hash != expected_policy_hash {
        return Err("policy_hash_mismatch".to_string());
    }

    let Some(vault_entry) = find_prime_blob_entry(root, module, &expected_blob_id) else {
        return Err("prime_blob_vault_entry_missing".to_string());
    };
    if !verify_blob_entry_signature(&vault_entry) {
        return Err("prime_blob_vault_signature_invalid".to_string());
    }
    if vault_entry
        .get("policy_hash")
        .and_then(Value::as_str)
        .unwrap_or("")
        != expected_policy_hash
    {
        return Err("prime_blob_vault_policy_mismatch".to_string());
    }
    if vault_entry
        .get("blob_hash")
        .and_then(Value::as_str)
        .unwrap_or("")
        != expected_blob_hash
    {
        return Err("prime_blob_vault_blob_hash_mismatch".to_string());
    }

    Ok(json!({
        "module": module,
        "snapshot_path": snapshot_path.display().to_string(),
        "source_path": source_path.display().to_string(),
        "blob_path": blob_path.display().to_string(),
        "source_hash": source_hash,
        "blob_hash": blob_hash,
        "policy_hash": current_policy_hash,
        "prime_blob_vault_entry_id": vault_entry.get("entry_id").cloned().unwrap_or(Value::Null),
        "prime_blob_vault_signature_verified": true,
        "prime_blob_vault_integrity": vault_integrity,
        "blob_first_bytes_hex": hex::encode(read_first_bytes(&blob_path, 16)?),
        "verified": true
    }))
}

fn emit(root: &Path, payload: Value) -> i32 {
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
                "type": "binary_blob_runtime_error",
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

fn verify_debug_token(root: &Path) -> Value {
    let (payload, code) = infring_layer1_security::run_soul_token_guard(
        root,
        &["verify".to_string(), "--strict=1".to_string()],
    );
    json!({"ok": code == 0 && payload.get("ok").and_then(Value::as_bool).unwrap_or(false), "payload": payload, "code": code})
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    binary_blob_runtime_run::run(root, argv)
}

#[cfg(test)]
#[path = "binary_blob_runtime_tests.rs"]
mod tests;
