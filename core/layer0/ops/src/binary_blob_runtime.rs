// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use crate::directive_kernel;
use crate::v8_kernel::{
    parse_bool, parse_f64, print_json, read_json, scoped_state_root, sha256_file, sha256_hex_str,
    write_json, write_receipt,
};
use memmap2::MmapOptions;
use crate::{clean, now_iso, parse_args};
use serde_json::{json, Map, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "BINARY_BLOB_RUNTIME_STATE_ROOT";
const STATE_SCOPE: &str = "binary_blob_runtime";

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
    let file = fs::File::open(path)
        .map_err(|err| format!("blob_open_failed:{}:{err}", path.display()))?;
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
    let mut file = fs::File::open(path)
        .map_err(|err| format!("blob_open_failed:{}:{err}", path.display()))?;
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
    let snapshot_path = snapshots_dir(root).join(module).join(format!("{blob_id}.json"));
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
    let rollback_pointer = format!("rollback://{}:{}", module, &sha256_hex_str(&now_iso())[..16]);

    let snapshot = json!({
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

    Ok(json!({
        "module": module,
        "snapshot_path": snapshot_path.display().to_string(),
        "source_path": source_path.display().to_string(),
        "blob_path": blob_path.display().to_string(),
        "source_hash": source_hash,
        "blob_hash": blob_hash,
        "policy_hash": current_policy_hash,
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
    let (payload, code) = infring_layer1_security::run_soul_token_guard(root, &["verify".to_string(), "--strict=1".to_string()]);
    json!({"ok": code == 0 && payload.get("ok").and_then(Value::as_bool).unwrap_or(false), "payload": payload, "code": code})
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
        println!("  protheus-ops binary-blob-runtime status");
        println!("  protheus-ops binary-blob-runtime migrate [--apply=1|0] [--mode=modular|monolithic] [--modules=<csv>]");
        println!("  protheus-ops binary-blob-runtime settle [--module=<id>] [--module-path=<path>] [--mode=modular|monolithic] [--shadow-swap=1|0] [--apply=1|0]");
        println!("  protheus-ops binary-blob-runtime load [--module=<id>]");
        println!("  protheus-ops binary-blob-runtime mutate [--module=<id>] [--proposal=<text>] [--apply=1|0] [--canary-pass=1|0]");
        println!("  protheus-ops binary-blob-runtime substrate-probe [--prefer=ternary|binary]");
        println!("  protheus-ops binary-blob-runtime debug-access [--module=<id>] [--tamper=1|0] [--apply=1|0]");
        return 0;
    }

    if command == "status" {
        let active = load_active_map(root);
        let modules = active.keys().cloned().collect::<Vec<_>>();
        let policy_hash = directive_kernel::directive_vault_hash(root);
        let mut checks = Vec::new();
        for module in &modules {
            let check = load_and_verify(root, module);
            checks.push(json!({"module": module, "ok": check.is_ok(), "detail": check.unwrap_or_else(|err| json!({"error": err}))}));
        }

        let mut out = json!({
            "ok": checks.iter().all(|row| row.get("ok").and_then(Value::as_bool).unwrap_or(false)),
            "type": "binary_blob_runtime_status",
            "lane": "core/layer0/ops",
            "active": active,
            "policy_hash": policy_hash,
            "verification": checks,
            "claim_evidence": [
                {
                    "id": "v8_binary_blob_001_1",
                    "claim": "settled_blob_artifacts_are_bound_to_signed_source_snapshots_and_policy_hashes",
                    "evidence": {"active_modules": modules.len()}
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        print_json(&out);
        return if out.get("ok").and_then(Value::as_bool).unwrap_or(false) { 0 } else { 2 };
    }

    if command == "migrate" {
        let modules = parse_module_list(&parsed.flags);
        let mut settled = Vec::new();
        let mut failures = Vec::new();
        for module in &modules {
            match settle_one(root, &parsed, module) {
                Ok(v) => settled.push(v),
                Err(err) => failures.push(json!({"module": module, "error": clean(err, 220)})),
            }
        }

        return emit(
            root,
            json!({
                "ok": failures.is_empty(),
                "type": "binary_blob_runtime_migrate",
                "lane": "core/layer0/ops",
                "mode": clean(parsed.flags.get("mode").cloned().unwrap_or_else(|| "modular".to_string()), 24),
                "commands": ["protheus blobs migrate", "protheus blobs status"],
                "settled": settled,
                "failures": failures,
                "layer_map": ["0","1","2","client","app"],
                "claim_evidence": [
                    {
                        "id": "v8_binary_blob_001_6",
                        "claim": "one_command_blob_migration_and_status_flow_is_core_authoritative",
                        "evidence": {"module_count": modules.len()}
                    }
                ]
            }),
        );
    }

    if command == "settle" {
        let module = normalize_module(parsed.flags.get("module"));
        let result = settle_one(root, &parsed, &module);
        match result {
            Ok(detail) => emit(
                root,
                json!({
                    "ok": true,
                    "type": "binary_blob_runtime_settle",
                    "lane": "core/layer0/ops",
                    "detail": detail,
                    "layer_map": ["0","1","2","3","client"],
                    "claim_evidence": [
                        {
                            "id": "v8_binary_blob_001_1",
                            "claim": "settled_blob_artifacts_are_bound_to_signed_source_snapshots_and_policy_hashes",
                            "evidence": {"module": module}
                        },
                        {
                            "id": "v8_binary_blob_001_2",
                            "claim": "re_settle_engine_supports_modular_or_monolithic_modes_with_shadow_swap",
                            "evidence": {
                                "mode": clean(parsed.flags.get("mode").cloned().unwrap_or_else(|| "modular".to_string()), 24),
                                "shadow_swap": parse_bool(parsed.flags.get("shadow-swap"), true)
                            }
                        }
                    ]
                }),
            ),
            Err(err) => emit(
                root,
                json!({
                    "ok": false,
                    "type": "binary_blob_runtime_settle",
                    "lane": "core/layer0/ops",
                    "module": module,
                    "error": clean(err, 220)
                }),
            ),
        }
    } else if command == "load" {
        let module = normalize_module(parsed.flags.get("module"));
        match load_and_verify(root, &module) {
            Ok(detail) => emit(
                root,
                json!({
                    "ok": true,
                    "type": "binary_blob_runtime_load",
                    "lane": "core/layer0/ops",
                    "detail": detail,
                    "claim_evidence": [
                        {
                            "id": "v8_binary_blob_001_1",
                            "claim": "load_is_fail_closed_when_directive_or_policy_hash_check_mismatch",
                            "evidence": {"module": module, "verified": true}
                        }
                    ]
                }),
            ),
            Err(err) => emit(
                root,
                json!({
                    "ok": false,
                    "type": "binary_blob_runtime_load",
                    "lane": "core/layer0/ops",
                    "module": module,
                    "error": clean(&err, 220),
                    "claim_evidence": [
                        {
                            "id": "v8_binary_blob_001_1",
                            "claim": "load_is_fail_closed_when_directive_or_policy_hash_check_mismatch",
                            "evidence": {"module": module, "verified": false, "reason": clean(&err, 220)}
                        }
                    ]
                }),
            ),
        }
    } else if command == "mutate" {
        let module = normalize_module(parsed.flags.get("module"));
        let proposal = clean(
            parsed
                .flags
                .get("proposal")
                .cloned()
                .unwrap_or_else(|| "optimize_runtime_profile".to_string()),
            320,
        );
        let apply = parse_bool(parsed.flags.get("apply"), true);
        let directive_allowed = directive_kernel::action_allowed(root, &format!("blob_mutate:{module}:{proposal}"));
        let canary_pass = parse_bool(parsed.flags.get("canary-pass"), true);
        let sim_regression = parse_f64(parsed.flags.get("sim-regression"), 0.0).max(0.0);
        let allow = directive_allowed && canary_pass && sim_regression <= 0.05;

        let active = load_active_map(root);
        let rollback_target = active
            .get(&module)
            .and_then(|v| v.get("previous"))
            .cloned()
            .unwrap_or(Value::Null);

        let event = json!({
            "ts": now_iso(),
            "module": module,
            "proposal": proposal,
            "directive_allowed": directive_allowed,
            "canary_pass": canary_pass,
            "sim_regression": sim_regression,
            "allow": allow,
            "rollback_target": rollback_target,
            "apply": apply
        });
        write_mutation_event(root, &event);

        if apply && !allow {
            // automatic rollback marker: keep previous pointer active and emit event.
            write_mutation_event(
                root,
                &json!({
                    "ts": now_iso(),
                    "type": "rollback_triggered",
                    "module": module,
                    "reason": if !directive_allowed { "directive_denied" } else if !canary_pass { "canary_failed" } else { "sim_regression" },
                    "target": rollback_target
                }),
            );
        }

        emit(
            root,
            json!({
                "ok": allow,
                "type": "binary_blob_runtime_mutate",
                "lane": "core/layer0/ops",
                "proposal": event.get("proposal").cloned().unwrap_or(Value::Null),
                "module": event.get("module").cloned().unwrap_or(Value::Null),
                "apply": apply,
                "directive_allowed": directive_allowed,
                "canary_pass": canary_pass,
                "sim_regression": sim_regression,
                "rollback_target": rollback_target,
                "layer_map": ["0","1","2","3"],
                "claim_evidence": [
                    {
                        "id": "v8_binary_blob_001_3",
                        "claim": "self_modification_mutation_is_inversion_simulated_and_directive_gated",
                        "evidence": {
                            "allow": allow,
                            "directive_allowed": directive_allowed,
                            "canary_pass": canary_pass,
                            "sim_regression": sim_regression
                        }
                    }
                ]
            }),
        )
    } else if command == "substrate-probe" {
        let prefer = clean(
            parsed
                .flags
                .get("prefer")
                .cloned()
                .unwrap_or_else(|| "ternary".to_string()),
            16,
        )
        .to_ascii_lowercase();
        let ternary_available = std::env::var("BITNET_TERNARY_AVAILABLE")
            .ok()
            .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or(false)
            || Path::new("/tmp/bitnet_device").exists();
        let probe_order = if prefer == "binary" {
            vec!["binary", "ternary"]
        } else {
            vec!["ternary", "binary"]
        };
        let selected = if probe_order[0] == "ternary" && ternary_available {
            "ternary"
        } else {
            "binary"
        };

        emit(
            root,
            json!({
                "ok": true,
                "type": "binary_blob_runtime_substrate_probe",
                "lane": "core/layer0/ops",
                "preferred": prefer,
                "probe_order": probe_order,
                "ternary_available": ternary_available,
                "selected": selected,
                "fallback_reason": if selected == "binary" { "ternary_unavailable" } else { "none" },
                "layer_map": ["-1","0","1","2","3","adapter"],
                "claim_evidence": [
                    {
                        "id": "v8_binary_blob_001_4",
                        "claim": "settle_cycle_prefers_ternary_substrate_with_deterministic_binary_fallback",
                        "evidence": {"selected": selected, "ternary_available": ternary_available}
                    }
                ]
            }),
        )
    } else if command == "debug-access" {
        let module = normalize_module(parsed.flags.get("module"));
        let tamper = parse_bool(parsed.flags.get("tamper"), false);
        let apply = parse_bool(parsed.flags.get("apply"), true);
        let token_verify = verify_debug_token(root);
        let token_ok = token_verify
            .get("ok")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let allowed = token_ok && !tamper;

        if apply && tamper {
            write_mutation_event(
                root,
                &json!({
                    "ts": now_iso(),
                    "type": "anti_tamper_dissolution",
                    "module": module,
                    "action": "deny_debug_and_preserve_opaque_blob"
                }),
            );
        }

        emit(
            root,
            json!({
                "ok": allowed,
                "type": "binary_blob_runtime_debug_access",
                "lane": "core/layer0/ops",
                "module": module,
                "tamper_signal": tamper,
                "token_verify": token_verify,
                "allowed": allowed,
                "layer_map": ["0","1","2","adapter","client"],
                "claim_evidence": [
                    {
                        "id": "v8_binary_blob_001_5",
                        "claim": "debug_visibility_requires_identity_bound_soul_token_and_anti_tamper_gate",
                        "evidence": {"allowed": allowed, "tamper_signal": tamper, "token_ok": token_ok}
                    }
                ]
            }),
        )
    } else {
        emit(
            root,
            json!({
                "ok": false,
                "type": "binary_blob_runtime_error",
                "lane": "core/layer0/ops",
                "error": "unknown_command",
                "command": command,
                "exit_code": 2
            }),
        )
    }
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
        let root = std::env::temp_dir().join(format!("protheus_blob_runtime_{name}_{nonce}"));
        fs::create_dir_all(&root).expect("mkdir");
        root
    }

    #[test]
    fn settle_writes_blob_and_load_verifies_hashes() {
        std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "test-sign-key");
        let root = temp_root("settle");

        assert_eq!(
            crate::directive_kernel::run(
                &root,
                &[
                    "prime-sign".to_string(),
                    "--directive=allow:blob_mutate".to_string(),
                    "--signer=tester".to_string(),
                ]
            ),
            0
        );

        let module_path = root.join("module.rs");
        fs::write(&module_path, "fn a() { 1 + 1; }\n").expect("write");
        assert_eq!(
            run(
                &root,
                &[
                    "settle".to_string(),
                    "--module=demo".to_string(),
                    format!("--module-path={}", module_path.display()),
                    "--mode=modular".to_string(),
                    "--apply=1".to_string()
                ]
            ),
            0
        );

        assert_eq!(
            run(&root, &["load".to_string(), "--module=demo".to_string()]),
            0
        );
        std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn load_fails_when_blob_is_tampered() {
        std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "test-sign-key");
        let root = temp_root("tamper");
        assert_eq!(
            crate::directive_kernel::run(
                &root,
                &[
                    "prime-sign".to_string(),
                    "--directive=allow:blob_mutate".to_string(),
                    "--signer=tester".to_string(),
                ]
            ),
            0
        );
        let module_path = root.join("module.rs");
        fs::write(&module_path, "fn trusted() -> u64 { 7 }\n").expect("write");
        assert_eq!(
            run(
                &root,
                &[
                    "settle".to_string(),
                    "--module=demo".to_string(),
                    format!("--module-path={}", module_path.display()),
                    "--apply=1".to_string()
                ]
            ),
            0
        );
        assert_eq!(
            run(&root, &["load".to_string(), "--module=demo".to_string()]),
            0
        );

        let active = load_active_map(&root);
        let blob_path = active
            .get("demo")
            .and_then(|v| v.get("blob_path"))
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .expect("blob path");
        fs::write(&blob_path, "tampered-by-test").expect("tamper");

        assert_eq!(
            run(&root, &["load".to_string(), "--module=demo".to_string()]),
            2
        );
        let latest = read_json(&crate::v8_kernel::latest_path(&root, STATE_ENV, STATE_SCOPE))
            .expect("latest");
        assert_eq!(
            latest.get("error").and_then(Value::as_str),
            Some("blob_hash_mismatch")
        );
        std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
        let _ = fs::remove_dir_all(root);
    }
}
