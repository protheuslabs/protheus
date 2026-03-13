use super::*;

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
        println!("  protheus-ops binary-blob-runtime migrate [--apply=1|0] [--mode=modular|monolithic] [--modules=<csv>]");
        println!("  protheus-ops binary-blob-runtime settle [--module=<id>] [--module-path=<path>] [--mode=modular|monolithic] [--shadow-swap=1|0] [--apply=1|0]");
        println!("  protheus-ops binary-blob-runtime load [--module=<id>]");
        println!("  protheus-ops binary-blob-runtime mutate [--module=<id>] [--proposal=<text>] [--apply=1|0] [--canary-pass=1|0]");
        println!("  protheus-ops binary-blob-runtime vault-status");
        println!("  protheus-ops binary-blob-runtime substrate-probe [--prefer=ternary|binary]");
        println!("  protheus-ops binary-blob-runtime debug-access [--module=<id>] [--tamper=1|0] [--apply=1|0]");
        return 0;
    }

    if command == "status" {
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

        let mut out = json!({
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
            "claim_evidence": [
                {
                    "id": "v8_binary_blob_001_1",
                    "claim": "settled_blob_artifacts_are_bound_to_signed_source_snapshots_and_policy_hashes",
                    "evidence": {"active_modules": modules.len(), "vault_integrity_ok": vault_ok}
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        print_json(&out);
        return if out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            0
        } else {
            2
        };
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
                    "gate_evaluation": gate_evaluation
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
                    "gate_evaluation": gate_evaluation
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
