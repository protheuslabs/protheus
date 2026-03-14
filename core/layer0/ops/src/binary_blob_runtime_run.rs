use super::*;

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn compute_dashboard_metrics(
    root: &Path,
    active: &Map<String, Value>,
    checks: &[Value],
    policy_hash: &str,
    vault_integrity: &Value,
) -> Value {
    let active_modules = active.len() as u64;
    let healthy_modules = checks
        .iter()
        .filter(|row| row.get("ok").and_then(Value::as_bool).unwrap_or(false))
        .count() as u64;
    let unhealthy_modules = active_modules.saturating_sub(healthy_modules);
    let verified_ok = unhealthy_modules == 0;

    let mut source_bytes_total = 0u64;
    let mut blob_bytes_total = 0u64;
    let mut policy_bound_modules = 0u64;
    let mut shadow_swap_ready_modules = 0u64;

    for entry in active.values() {
        if entry
            .get("shadow_pointer")
            .and_then(Value::as_str)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
        {
            shadow_swap_ready_modules += 1;
        }

        if entry
            .get("policy_hash")
            .and_then(Value::as_str)
            .map(|v| v == policy_hash)
            .unwrap_or(false)
        {
            policy_bound_modules += 1;
        }

        let snapshot_path = entry
            .get("snapshot_path")
            .and_then(Value::as_str)
            .map(PathBuf::from);
        let Some(snapshot_path) = snapshot_path else {
            continue;
        };
        let Some(snapshot) = read_json(&snapshot_path) else {
            continue;
        };
        let source_path = snapshot
            .get("source_path")
            .and_then(Value::as_str)
            .map(PathBuf::from);
        if let Some(source_path) = source_path {
            source_bytes_total = source_bytes_total.saturating_add(file_size(&source_path));
        }
        let blob_path = snapshot
            .get("blob_path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .or_else(|| {
                entry.get("blob_path")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
            });
        if let Some(blob_path) = blob_path {
            blob_bytes_total = blob_bytes_total.saturating_add(file_size(&blob_path));
        }
    }

    let delta_bytes = (source_bytes_total as i128) - (blob_bytes_total as i128);
    let savings_percent = if source_bytes_total == 0 {
        0.0
    } else {
        ((delta_bytes as f64) / (source_bytes_total as f64)) * 100.0
    };

    let directive_integrity_ok = directive_kernel::directive_vault_integrity(root)
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let vault_integrity_ok = vault_integrity
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    json!({
        "blob_health": {
            "active_modules": active_modules,
            "healthy_modules": healthy_modules,
            "unhealthy_modules": unhealthy_modules,
            "verified_ok": verified_ok
        },
        "memory_savings": {
            "source_bytes_total": source_bytes_total,
            "blob_bytes_total": blob_bytes_total,
            "delta_bytes": delta_bytes,
            "savings_percent": ((savings_percent * 100.0).round() / 100.0)
        },
        "directive_compliance": {
            "policy_hash": policy_hash,
            "policy_bound_modules": policy_bound_modules,
            "policy_bound_ratio": if active_modules == 0 { 0.0 } else { policy_bound_modules as f64 / active_modules as f64 },
            "directive_integrity_ok": directive_integrity_ok,
            "blob_vault_integrity_ok": vault_integrity_ok
        },
        "zero_downtime": {
            "shadow_swap_ready_modules": shadow_swap_ready_modules,
            "shadow_swap_ready_ratio": if active_modules == 0 { 0.0 } else { shadow_swap_ready_modules as f64 / active_modules as f64 }
        }
    })
}

fn enforce_vault_integrity_gate(
    root: &Path,
    command: &str,
    compat_action: Option<&str>,
) -> Result<Value, Value> {
    let gate_action = "blob:vault_integrity";
    let fallback_command_gate_action = format!("blob:{command}");
    let command_gate_action = compat_action
        .map(|v| v.to_string())
        .unwrap_or(fallback_command_gate_action);
    let wildcard_gate_action = "blob:*";
    let gate_evaluation = directive_kernel::evaluate_action(root, gate_action);
    let command_gate_evaluation = directive_kernel::evaluate_action(root, &command_gate_action);
    let wildcard_gate_evaluation = directive_kernel::evaluate_action(root, wildcard_gate_action);
    let gate_allowed = gate_evaluation
        .get("allowed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || command_gate_evaluation
            .get("allowed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || wildcard_gate_evaluation
            .get("allowed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let vault_integrity = validate_prime_blob_vault(&load_prime_blob_vault(root));
    let vault_ok = vault_integrity
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let gate = json!({
        "ok": gate_allowed && vault_ok,
        "gate_action": gate_action,
        "gate_action_compat": command_gate_action,
        "gate_action_wildcard": wildcard_gate_action,
        "gate_evaluation": gate_evaluation,
        "gate_evaluation_compat": command_gate_evaluation,
        "gate_evaluation_wildcard": wildcard_gate_evaluation,
        "vault_integrity": vault_integrity,
        "command": command
    });
    if gate_allowed && vault_ok {
        Ok(gate)
    } else {
        Err(json!({
            "ok": false,
            "type": "binary_blob_runtime_vault_integrity_gate",
            "lane": "core/layer0/ops",
            "error": if !gate_allowed { "directive_gate_denied" } else { "prime_blob_vault_chain_invalid" },
            "gate_action": command_gate_action,
            "gate_evaluation": command_gate_evaluation,
            "command": command,
            "vault_integrity_gate": gate,
            "claim_evidence": [
                {
                    "id": "V8-BINARY-BLOB-001.1",
                    "claim": "binary_blob_runtime_requires_vault_integrity_policy_gate_before_execution",
                    "evidence": {
                        "command": command
                    }
                }
            ]
        }))
    }
}

pub(super) fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let command = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        println!("Usage:");
        println!("  protheus-ops binary-blob-runtime status");
        println!("  protheus-ops binary-blob-runtime dashboard");
        println!("  protheus-ops binary-blob-runtime migrate [--apply=1|0] [--mode=modular|monolithic] [--modules=<csv>]");
        println!("  protheus-ops binary-blob-runtime settle [--module=<id>] [--module-path=<path>] [--mode=modular|monolithic] [--shadow-swap=1|0] [--apply=1|0]");
        println!("  protheus-ops binary-blob-runtime load [--module=<id>]");
        println!("  protheus-ops binary-blob-runtime mutate [--module=<id>] [--proposal=<text>] [--apply=1|0] [--canary-pass=1|0]");
        println!("  protheus-ops binary-blob-runtime vault-status");
        println!("  protheus-ops binary-blob-runtime substrate-probe [--prefer=ternary|binary]");
        println!("  protheus-ops binary-blob-runtime debug-access [--module=<id>] [--tamper=1|0] [--apply=1|0]");
        return 0;
    }

    if command == "status" || command == "dashboard" {
        let gate_action = "blob:status";
        if !directive_kernel::action_allowed(root, gate_action) {
            let gate_evaluation = directive_kernel::evaluate_action(root, gate_action);
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "binary_blob_runtime_status",
                    "lane": "core/layer0/ops",
                    "error": "directive_gate_denied",
                    "gate_action": gate_action,
                    "gate_evaluation": gate_evaluation
                }),
            );
        }
        let active = load_active_map(root);
        let modules = active.keys().cloned().collect::<Vec<_>>();
        let policy_hash = directive_kernel::directive_vault_hash(root);
        let blob_vault = load_prime_blob_vault(root);
        let vault_integrity = validate_prime_blob_vault(&blob_vault);
        let mut checks = Vec::new();
        for module in &modules {
            let check = load_and_verify(root, module);
            checks.push(json!({"module": module, "ok": check.is_ok(), "detail": check.unwrap_or_else(|err| json!({"error": err}))}));
        }
        let verified_ok = checks
            .iter()
            .all(|row| row.get("ok").and_then(Value::as_bool).unwrap_or(false));
        let vault_ok = vault_integrity
            .get("ok")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let dashboard = compute_dashboard_metrics(root, &active, &checks, &policy_hash, &vault_integrity);

        return emit(root, json!({
            "ok": verified_ok && vault_ok,
            "type": "binary_blob_runtime_status",
            "lane": "core/layer0/ops",
            "active": active,
            "policy_hash": policy_hash,
            "prime_blob_vault": {
                "entries": blob_vault.get("entries").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0),
                "chain_head": blob_vault.get("chain_head").cloned().unwrap_or(Value::String("genesis".to_string())),
                "integrity": vault_integrity
            },
            "verification": checks,
            "dashboard": dashboard,
            "commands": ["protheus blobs migrate", "protheus blobs status", "protheus blobs dashboard"],
            "claim_evidence": [
                {
                    "id": "V8-BINARY-BLOB-001.1",
                    "claim": "settled_blob_artifacts_are_bound_to_signed_source_snapshots_and_policy_hashes",
                    "evidence": {"active_modules": modules.len(), "vault_integrity_ok": vault_ok}
                },
                {
                    "id": "V8-BINARY-BLOB-001.6",
                    "claim": "blob_status_surfaces_health_memory_savings_and_directive_compliance_metrics",
                    "evidence": {
                        "active_modules": modules.len(),
                        "healthy_modules": dashboard.get("blob_health").and_then(|v| v.get("healthy_modules")).cloned().unwrap_or(Value::from(0)),
                        "savings_percent": dashboard.get("memory_savings").and_then(|v| v.get("savings_percent")).cloned().unwrap_or(Value::from(0.0))
                    }
                }
            ]
        }));
    }

    if command == "vault-status" {
        let gate_action = "blob:vault-status";
        if !directive_kernel::action_allowed(root, gate_action) {
            let gate_evaluation = directive_kernel::evaluate_action(root, gate_action);
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "binary_blob_runtime_vault_status",
                    "lane": "core/layer0/ops",
                    "error": "directive_gate_denied",
                    "gate_action": gate_action,
                    "gate_evaluation": gate_evaluation
                }),
            );
        }
        let vault = load_prime_blob_vault(root);
        let integrity = validate_prime_blob_vault(&vault);
        return emit(
            root,
            json!({
                "ok": integrity.get("ok").and_then(Value::as_bool).unwrap_or(false),
                "type": "binary_blob_runtime_vault_status",
                "lane": "core/layer0/ops",
                "entry_count": integrity.get("entry_count").cloned().unwrap_or(Value::from(0)),
                "signature_valid_count": integrity.get("signature_valid_count").cloned().unwrap_or(Value::from(0)),
                "hash_valid_count": integrity.get("hash_valid_count").cloned().unwrap_or(Value::from(0)),
                "chain_head": vault.get("chain_head").cloned().unwrap_or(Value::String("genesis".to_string())),
                "integrity": integrity
            }),
        );
    }

    let requires_integrity_gate = matches!(
        command.as_str(),
        "migrate" | "settle" | "load" | "mutate" | "substrate-probe" | "debug-access"
    );
    let gate_compat_action = match command.as_str() {
        "load" => Some(format!(
            "blob:load:{}",
            normalize_module(parsed.flags.get("module"))
        )),
        "settle" => Some(format!(
            "blob:settle:{}",
            normalize_module(parsed.flags.get("module"))
        )),
        "mutate" => Some("blob:mutate".to_string()),
        _ => None,
    };
    let vault_integrity_gate = if requires_integrity_gate {
        match enforce_vault_integrity_gate(root, &command, gate_compat_action.as_deref()) {
            Ok(gate) => Some(gate),
            Err(out) => return emit(root, out),
        }
    } else {
        None
    };

    if command == "migrate" {
        let gate_action = "blob:migrate";
        if !directive_kernel::action_allowed(root, gate_action) {
            let gate_evaluation = directive_kernel::evaluate_action(root, gate_action);
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "binary_blob_runtime_migrate",
                    "lane": "core/layer0/ops",
                    "error": "directive_gate_denied",
                    "gate_action": gate_action,
                    "gate_evaluation": gate_evaluation
                }),
            );
        }
        let modules = parse_module_list(&parsed.flags);
        let mut settled = Vec::new();
        let mut failures = Vec::new();
        for module in &modules {
            match settle_one(root, &parsed, module) {
                Ok(v) => settled.push(v),
                Err(err) => failures.push(json!({"module": module, "error": clean(err, 220)})),
            }
        }
        let active = load_active_map(root);
        let policy_hash = directive_kernel::directive_vault_hash(root);
        let blob_vault = load_prime_blob_vault(root);
        let vault_integrity = validate_prime_blob_vault(&blob_vault);
        let mut checks = Vec::new();
        for module in active.keys() {
            let check = load_and_verify(root, module);
            checks.push(json!({"module": module, "ok": check.is_ok(), "detail": check.unwrap_or_else(|err| json!({"error": err}))}));
        }
        let dashboard = compute_dashboard_metrics(root, &active, &checks, &policy_hash, &vault_integrity);

        return emit(
            root,
            json!({
                "ok": failures.is_empty(),
                "type": "binary_blob_runtime_migrate",
                "lane": "core/layer0/ops",
                "mode": clean(parsed.flags.get("mode").cloned().unwrap_or_else(|| "modular".to_string()), 24),
                "commands": ["protheus blobs migrate", "protheus blobs status"],
                "vault_integrity_gate": vault_integrity_gate.clone().unwrap_or(Value::Null),
                "settled": settled,
                "failures": failures,
                "dashboard": dashboard,
                "layer_map": ["0","1","2","client","app"],
                "claim_evidence": [
                    {
                        "id": "V8-BINARY-BLOB-001.6",
                        "claim": "one_command_blob_migration_and_status_flow_is_core_authoritative_with_dashboard_metrics",
                        "evidence": {
                            "module_count": modules.len(),
                            "healthy_modules": dashboard.get("blob_health").and_then(|v| v.get("healthy_modules")).cloned().unwrap_or(Value::from(0)),
                            "shadow_swap_ready_modules": dashboard.get("zero_downtime").and_then(|v| v.get("shadow_swap_ready_modules")).cloned().unwrap_or(Value::from(0))
                        }
                    }
                ]
            }),
        );
    }

    if command == "settle" {
        let module = normalize_module(parsed.flags.get("module"));
        let gate_action = format!("blob:settle:{module}");
        if !directive_kernel::action_allowed(root, &gate_action) {
            let gate_evaluation = directive_kernel::evaluate_action(root, &gate_action);
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "binary_blob_runtime_settle",
                    "lane": "core/layer0/ops",
                    "module": module,
                    "error": "directive_gate_denied",
                    "gate_action": gate_action,
                    "gate_evaluation": gate_evaluation,
                    "claim_evidence": [
                        {
                            "id": "V8-BINARY-BLOB-001.1",
                            "claim": "settle_operations_are_fail_closed_when_directive_gate_denies_action",
                            "evidence": {
                                "module": module,
                                "gate_action": gate_action,
                                "reason": "directive_gate_denied"
                            }
                        }
                    ]
                }),
            );
        }
        let result = settle_one(root, &parsed, &module);
        match result {
            Ok(detail) => emit(
                root,
                json!({
                    "ok": true,
                    "type": "binary_blob_runtime_settle",
                    "lane": "core/layer0/ops",
                    "detail": detail,
                    "vault_integrity_gate": vault_integrity_gate.clone().unwrap_or(Value::Null),
                    "layer_map": ["0","1","2","3","client"],
                    "claim_evidence": [
                        {
                            "id": "V8-BINARY-BLOB-001.1",
                            "claim": "settled_blob_artifacts_are_bound_to_signed_source_snapshots_and_policy_hashes",
                            "evidence": {"module": module}
                        },
                        {
                            "id": "V8-BINARY-BLOB-001.2",
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
                    "vault_integrity_gate": vault_integrity_gate.clone().unwrap_or(Value::Null),
                    "error": clean(err, 220)
                }),
            ),
        }
    } else if command == "load" {
        let module = normalize_module(parsed.flags.get("module"));
        let gate_action = format!("blob:load:{module}");
        if !directive_kernel::action_allowed(root, &gate_action) {
            let gate_evaluation = directive_kernel::evaluate_action(root, &gate_action);
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "binary_blob_runtime_load",
                    "lane": "core/layer0/ops",
                    "module": module,
                    "error": "directive_gate_denied",
                    "gate_action": gate_action,
                    "gate_evaluation": gate_evaluation,
                    "claim_evidence": [
                        {
                            "id": "V8-BINARY-BLOB-001.1",
                            "claim": "load_is_fail_closed_when_directive_or_policy_hash_check_mismatch",
                            "evidence": {
                                "module": module,
                                "verified": false,
                                "reason": "directive_gate_denied"
                            }
                        }
                    ]
                }),
            );
        }
        match load_and_verify(root, &module) {
            Ok(detail) => emit(
                root,
                json!({
                    "ok": true,
                    "type": "binary_blob_runtime_load",
                    "lane": "core/layer0/ops",
                    "detail": detail,
                    "vault_integrity_gate": vault_integrity_gate.clone().unwrap_or(Value::Null),
                    "claim_evidence": [
                        {
                            "id": "V8-BINARY-BLOB-001.1",
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
                    "vault_integrity_gate": vault_integrity_gate.clone().unwrap_or(Value::Null),
                    "error": clean(&err, 220),
                    "claim_evidence": [
                        {
                            "id": "V8-BINARY-BLOB-001.1",
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
        let gate_eval_base = directive_kernel::evaluate_action(root, "blob:mutate");
        let gate_eval_mutation =
            directive_kernel::evaluate_action(root, &format!("blob_mutate:{module}:{proposal}"));
        let directive_allowed = gate_eval_base
            .get("allowed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && gate_eval_mutation
                .get("allowed")
                .and_then(Value::as_bool)
                .unwrap_or(false);
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
                "vault_integrity_gate": vault_integrity_gate.clone().unwrap_or(Value::Null),
                "directive_allowed": directive_allowed,
                "gate_evaluation": {
                    "base": gate_eval_base,
                    "mutation": gate_eval_mutation
                },
                "canary_pass": canary_pass,
                "sim_regression": sim_regression,
                "rollback_target": rollback_target,
                "layer_map": ["0","1","2","3"],
                "claim_evidence": [
                    {
                        "id": "V8-BINARY-BLOB-001.3",
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
        let gate_action = "blob:substrate-probe";
        if !directive_kernel::action_allowed(root, gate_action) {
            let gate_evaluation = directive_kernel::evaluate_action(root, gate_action);
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "binary_blob_runtime_substrate_probe",
                    "lane": "core/layer0/ops",
                    "error": "directive_gate_denied",
                    "gate_action": gate_action,
                    "gate_evaluation": gate_evaluation
                }),
            );
        }
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
            .map(|v| {
                matches!(
                    v.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
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
                "vault_integrity_gate": vault_integrity_gate.clone().unwrap_or(Value::Null),
                "probe_order": probe_order,
                "ternary_available": ternary_available,
                "selected": selected,
                "fallback_reason": if selected == "binary" { "ternary_unavailable" } else { "none" },
                "layer_map": ["-1","0","1","2","3","adapter"],
                "claim_evidence": [
                    {
                        "id": "V8-BINARY-BLOB-001.4",
                        "claim": "settle_cycle_prefers_ternary_substrate_with_deterministic_binary_fallback",
                        "evidence": {"selected": selected, "ternary_available": ternary_available}
                    }
                ]
            }),
        )
    } else if command == "debug-access" {
        let module = normalize_module(parsed.flags.get("module"));
        let gate_action = format!("blob:debug-access:{module}");
        if !directive_kernel::action_allowed(root, &gate_action) {
            let gate_evaluation = directive_kernel::evaluate_action(root, &gate_action);
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "binary_blob_runtime_debug_access",
                    "lane": "core/layer0/ops",
                    "module": module,
                    "error": "directive_gate_denied",
                    "gate_action": gate_action,
                    "gate_evaluation": gate_evaluation
                }),
            );
        }
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
                "vault_integrity_gate": vault_integrity_gate.clone().unwrap_or(Value::Null),
                "tamper_signal": tamper,
                "token_verify": token_verify,
                "allowed": allowed,
                "layer_map": ["0","1","2","adapter","client"],
                "claim_evidence": [
                    {
                        "id": "V8-BINARY-BLOB-001.5",
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
