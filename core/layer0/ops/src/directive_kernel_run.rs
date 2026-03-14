use super::*;

pub(super) fn emit_receipt(root: &Path, payload: Value) -> i32 {
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
        println!("  protheus-ops directive-kernel dashboard");
        println!("  protheus-ops directive-kernel prime-sign [--directive=<text>] [--signer=<id>] [--allow-unsigned=1|0]");
        println!("  protheus-ops directive-kernel derive [--parent=<id|text>] [--directive=<text>] [--signer=<id>] [--allow-unsigned=1|0]");
        println!("  protheus-ops directive-kernel supersede [--target=<id|text>] [--directive=<text>] [--signer=<id>] [--allow-unsigned=1|0]");
        println!("  protheus-ops directive-kernel compliance-check [--action=<text>]");
        println!("  protheus-ops directive-kernel bridge-rsi [--proposal=<text>] [--apply=1|0]");
        println!(
            "  protheus-ops directive-kernel migrate [--apply=1|0] [--allow-unsigned=1|0] [--repair-signatures=1|0]"
        );
        return 0;
    }

    let status_dashboard =
        command == "dashboard" || parse_bool(parsed.flags.get("dashboard"), false);

    if command == "status" && !status_dashboard {
        let vault = load_vault(root);
        let (signature_total, signature_valid) = signature_counts(&vault);
        let integrity = directive_vault_integrity(root);
        return emit_receipt(
            root,
            json!({
                "ok": integrity.get("ok").and_then(Value::as_bool).unwrap_or(false),
                "type": "directive_kernel_status",
                "lane": "core/layer0/ops",
                "vault": vault,
                "policy_hash": directive_vault_hash(root),
                "signature_summary": {
                    "total_entries": signature_total,
                    "valid_entries": signature_valid,
                    "invalid_entries": signature_total.saturating_sub(signature_valid)
                },
                "integrity": integrity,
                "latest": read_json(&latest_path(root))
            }),
        );
    }

    if status_dashboard {
        let vault = load_vault(root);
        let integrity = directive_vault_integrity(root);
        let prime_rows = vault
            .get("prime")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let derived_rows = vault
            .get("derived")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let prime_count = prime_rows.len();
        let derived_count = derived_rows.len();
        let supersession_count = derived_rows
            .iter()
            .filter(|row| {
                row.get("supersedes")
                    .and_then(Value::as_str)
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false)
            })
            .count();
        let parent_linked_derived = derived_rows
            .iter()
            .filter(|row| {
                row.get("parent_id")
                    .and_then(Value::as_str)
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false)
            })
            .count();
        let parent_missing_derived = derived_count.saturating_sub(parent_linked_derived);
        let compliance_actions = vec![
            "blob:mutate".to_string(),
            "rsi:unsafe".to_string(),
            "organism:dream".to_string(),
            "network:gossip".to_string(),
        ];
        let compliance_preview = compliance_actions
            .iter()
            .map(|action| evaluate_action(root, action))
            .collect::<Vec<_>>();
        let denied_count = compliance_preview
            .iter()
            .filter(|row| !row.get("allowed").and_then(Value::as_bool).unwrap_or(false))
            .count();

        return emit_receipt(
            root,
            json!({
                "ok": integrity.get("ok").and_then(Value::as_bool).unwrap_or(false),
                "type": "directive_kernel_dashboard",
                "lane": "core/layer0/ops",
                "dashboard": {
                    "hierarchy": {
                        "prime_count": prime_count,
                        "derived_count": derived_count,
                        "supersession_count": supersession_count,
                        "parent_linked_derived": parent_linked_derived,
                        "parent_missing_derived": parent_missing_derived
                    },
                    "compliance": {
                        "actions_sampled": compliance_actions,
                        "preview": compliance_preview,
                        "denied_count": denied_count,
                        "integrity_ok": integrity.get("ok").and_then(Value::as_bool).unwrap_or(false)
                    }
                },
                "policy_hash": directive_vault_hash(root),
                "commands": ["protheus directives migrate", "protheus directives status", "protheus directives dashboard"],
                "layer_map": ["0","1","2","client","app"],
                "claim_evidence": [
                    {
                        "id": "V8-DIRECTIVES-001.5",
                        "claim": "directive_migration_and_visibility_dashboard_are_available_as_one_command_core_paths",
                        "evidence": {
                            "prime_count": prime_count,
                            "derived_count": derived_count,
                            "supersession_count": supersession_count,
                            "denied_preview_count": denied_count
                        }
                    }
                ]
            }),
        );
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
                            "id": "V8-DIRECTIVES-001.1",
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
                                "id": "V8-DIRECTIVES-001.1",
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
                        "id": "V8-DIRECTIVES-001.1",
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
                            "id": "V8-DIRECTIVES-001.2",
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
                            "id": "V8-DIRECTIVES-001.2",
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
                            "id": "V8-DIRECTIVES-001.2",
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
            None,
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
                                "id": "V8-DIRECTIVES-001.2",
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
                        "id": "V8-DIRECTIVES-001.2",
                        "claim": "derived_directives_require_parent_linkage_and_fail_on_inheritance_conflict",
                        "evidence": {"accepted": true, "parent_id": parent_id}
                    }
                ]
            }),
        );
    }

    if command == "supersede" {
        let target_hint = parsed.flags.get("target").cloned().unwrap_or_default();
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
                    "type": "directive_kernel_supersede",
                    "lane": "core/layer0/ops",
                    "error": "missing_signing_key",
                    "signing_env": SIGNING_ENV,
                    "claim_evidence": [
                        {
                            "id": "V8-DIRECTIVES-001.1",
                            "claim": "prime_directives_are_append_only_signed_objects_with_supersession_not_inline_edits",
                            "evidence": {"accepted": false, "reason": "missing_signing_key"}
                        }
                    ]
                }),
            );
        }
        let vault = load_vault(root);
        let Some(target) = resolve_parent(&vault, &target_hint) else {
            return emit_receipt(
                root,
                json!({
                    "ok": false,
                    "type": "directive_kernel_supersede",
                    "lane": "core/layer0/ops",
                    "error": "target_not_found",
                    "target": clean(target_hint, 320)
                }),
            );
        };
        let target_id = target
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if target_id.is_empty() {
            return emit_receipt(
                root,
                json!({
                    "ok": false,
                    "type": "directive_kernel_supersede",
                    "lane": "core/layer0/ops",
                    "error": "target_id_missing"
                }),
            );
        }
        let entry = match append_directive_entry(
            root,
            "derived",
            &directive,
            &signer,
            Some(&target_id),
            Some(&target_id),
            "supersession",
        ) {
            Ok(v) => v,
            Err(err) => {
                return emit_receipt(
                    root,
                    json!({
                        "ok": false,
                        "type": "directive_kernel_supersede",
                        "lane": "core/layer0/ops",
                        "error": clean(&err, 240)
                    }),
                );
            }
        };

        return emit_receipt(
            root,
            json!({
                "ok": true,
                "type": "directive_kernel_supersede",
                "lane": "core/layer0/ops",
                "target": target,
                "entry": entry,
                "policy_hash": directive_vault_hash(root),
                "layer_map": ["0","1","2"],
                "claim_evidence": [
                    {
                        "id": "V8-DIRECTIVES-001.1",
                        "claim": "prime_directives_are_append_only_signed_objects_with_supersession_not_inline_edits",
                        "evidence": {
                            "target_id": target_id,
                            "superseding_entry_id": entry.get("id").cloned().unwrap_or(Value::Null)
                        }
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
                        "id": "V8-DIRECTIVES-001.3",
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
                        "id": "V8-DIRECTIVES-001.4",
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
        let repair_signatures = parse_bool(parsed.flags.get("repair-signatures"), false);
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
                            "id": "V8-DIRECTIVES-001.5",
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
        let signature_repair = if repair_signatures {
            Some(
                repair_vault_signatures(root, apply, allow_unsigned).unwrap_or_else(|err| {
                    json!({
                        "error": clean(err, 220),
                        "apply": apply
                    })
                }),
            )
        } else {
            None
        };
        let migration_ok = !migrated.get("error").is_some();
        let repair_ok = signature_repair
            .as_ref()
            .map(|v| !v.get("error").is_some())
            .unwrap_or(true);
        let ok = migration_ok && repair_ok;
        return emit_receipt(
            root,
            json!({
                "ok": ok,
                "type": "directive_kernel_migrate",
                "lane": "core/layer0/ops",
                "apply": apply,
                "migration": migrated,
                "signature_repair": signature_repair,
                "commands": ["protheus directives migrate", "protheus directives status", "protheus prime sign", "protheus directives supersede"],
                "policy_hash": directive_vault_hash(root),
                "layer_map": ["0","1","2","client","app"],
                "claim_evidence": [
                    {
                        "id": "V8-DIRECTIVES-001.5",
                        "claim": "directive_migration_and_status_are_available_as_one_command_core_paths",
                        "evidence": {
                            "apply": apply,
                            "ok": ok,
                            "repair_signatures": repair_signatures
                        }
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
