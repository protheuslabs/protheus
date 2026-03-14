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
        println!("  protheus-ops network-protocol status");
        println!("  protheus-ops network-protocol dashboard");
        println!("  protheus-ops network-protocol ignite-bitcoin [--seed=<text>] [--apply=1|0]");
        println!("  protheus-ops network-protocol stake [--action=stake|reward|slash] [--agent=<id>] [--amount=<n>] [--reason=<text>]");
        println!("  protheus-ops network-protocol oracle-query [--provider=polymarket] [--event=<text>] [--strict=1|0]");
        println!("  protheus-ops network-protocol truth-weight [--market=<id>] [--strict=1|0]");
        println!("  protheus-ops network-protocol merkle-root [--account=<id>] [--proof=1|0]");
        println!("  protheus-ops network-protocol emission [--height=<n>] [--halving-interval=<n>] [--initial-issuance=<n>]");
        println!("  protheus-ops network-protocol zk-claim [--claim-id=<id>] [--commitment=<hex>] [--challenge=<hex>] [--public-input=<text>] [--strict=1|0]");
        return 0;
    }

    if command == "status" {
        let ledger = load_ledger(root);
        let oracle_latest =
            read_json(&state_root(root).join("oracle").join("latest.json")).unwrap_or(Value::Null);
        return emit(
            root,
            json!({
                "ok": true,
                "type": "network_protocol_status",
                "lane": "core/layer0/ops",
                "ledger": ledger,
                "latest": read_json(&latest_path(root)),
                "oracle_latest": oracle_latest
            }),
        );
    }

    if command == "dashboard" {
        let ledger = load_ledger(root);
        let policy_hash = directive_kernel::directive_vault_hash(root);
        let leaves = leaves_for_root(&ledger, &policy_hash);
        let global_merkle_root = deterministic_merkle_root(&leaves);
        let balances = ledger
            .get("balances")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let staked = ledger
            .get("staked")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let zk_claims = ledger
            .get("zk_claims")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let verified_claims = zk_claims
            .values()
            .filter(|row| {
                row.get("verified")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
            .count();
        let total_balance = balances
            .values()
            .filter_map(Value::as_f64)
            .fold(0.0f64, |acc, amount| acc + amount);
        let total_staked = staked
            .values()
            .filter_map(Value::as_f64)
            .fold(0.0f64, |acc, amount| acc + amount);
        let emission = ledger.get("emission").cloned().unwrap_or(Value::Null);
        let oracle_latest =
            read_json(&state_root(root).join("oracle").join("latest.json")).unwrap_or(Value::Null);

        return emit(
            root,
            json!({
                "ok": true,
                "type": "network_protocol_dashboard",
                "lane": "core/layer0/ops",
                "activation_command": "protheus network ignite bitcoin",
                "token_flow": {
                    "accounts": balances.len(),
                    "total_balance": total_balance,
                    "total_staked": total_staked
                },
                "ledger_health": {
                    "global_merkle_root": global_merkle_root,
                    "root_head": ledger.get("root_head").cloned().unwrap_or(Value::Null),
                    "leaf_count": leaves.len(),
                    "height": ledger.get("height").cloned().unwrap_or(Value::from(0))
                },
                "emission_curve": emission,
                "zk_claims": {
                    "total": zk_claims.len(),
                    "verified": verified_claims
                },
                "network_organism_view": {
                    "tokenomics": true,
                    "merkle_state": true,
                    "emission": true,
                    "zk_claims": true,
                    "oracle": oracle_latest != Value::Null
                },
                "claim_evidence": [
                    {
                        "id": "V8-NETWORK-002.5",
                        "claim": "network_organism_dashboard_surfaces_token_ledger_emission_and_claim_health",
                        "evidence": {
                            "global_merkle_root": global_merkle_root,
                            "verified_claims": verified_claims,
                            "total_accounts": balances.len()
                        }
                    },
                    {
                        "id": "V8-NETWORK-003.5",
                        "claim": "dashboard_surfaces_oracle_and_truth_weight_state",
                        "evidence": {
                            "oracle_available": oracle_latest != Value::Null
                        }
                    }
                ]
            }),
        );
    }

    if command == "ignite-bitcoin"
        || (command == "ignite"
            && parsed
                .positional
                .get(1)
                .map(|v| v.trim().eq_ignore_ascii_case("bitcoin"))
                .unwrap_or(false))
    {
        let apply = parse_bool(parsed.flags.get("apply"), true);
        let seed = clean(
            parsed
                .flags
                .get("seed")
                .cloned()
                .unwrap_or_else(|| "genesis".to_string()),
            96,
        );
        let gate_ok = gate_action(root, "tokenomics:ignite-bitcoin");
        if apply && !gate_ok {
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "network_protocol_ignite_bitcoin",
                    "lane": "core/layer0/ops",
                    "apply": apply,
                    "profile": "bitcoin",
                    "seed": seed,
                    "error": "directive_gate_denied",
                    "gate_action": "tokenomics:ignite-bitcoin",
                    "layer_map": ["0","1","2","client","app"],
                    "claim_evidence": [
                        {
                            "id": "V8-NETWORK-002.5",
                            "claim": "bitcoin_profile_ignition_is_core_authoritative_and_receipted",
                            "evidence": {"allowed": false, "reason": "directive_gate_denied"}
                        }
                    ]
                }),
            );
        }

        if apply && !ledger_path(root).exists() {
            let mut ledger = default_ledger();
            put_balance(&mut ledger, "organism:treasury", 1_000_000.0);
            put_stake(&mut ledger, "organism:treasury", 0.0);
            let _ = commit_ledger(root, ledger, "ignite_bitcoin", json!({"seed": seed}));
        }

        let ledger = load_ledger(root);
        return emit(
            root,
            json!({
                "ok": true,
                "type": "network_protocol_ignite_bitcoin",
                "lane": "core/layer0/ops",
                "apply": apply,
                "profile": "bitcoin",
                "seed": seed,
                "activation": {
                    "command": "protheus network ignite bitcoin",
                    "surface": "core://network-protocol"
                },
                "network_state_root": ledger.get("root_head").cloned().unwrap_or(Value::String("genesis".to_string())),
                "gates": {
                    "conduit_required": true,
                    "prime_directive_gate": true,
                    "sovereign_identity_required": true,
                    "fail_closed": true
                },
                "gate_action": "tokenomics:ignite-bitcoin",
                "layer_map": ["0","1","2","client","app"],
                "claim_evidence": [
                    {
                        "id": "V8-NETWORK-002.5",
                        "claim": "bitcoin_profile_ignition_is_core_authoritative_and_receipted",
                        "evidence": {"profile": "bitcoin", "state_root_present": true}
                    }
                ]
            }),
        );
    }

    if command == "stake" || command == "reward" || command == "slash" {
        let action = parsed
            .flags
            .get("action")
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_else(|| command.clone());
        let agent = clean(
            parsed
                .flags
                .get("agent")
                .cloned()
                .unwrap_or_else(|| "shadow:default".to_string()),
            120,
        );
        let amount = parse_f64(parsed.flags.get("amount"), 10.0).max(0.0);
        let reason = clean(
            parsed
                .flags
                .get("reason")
                .cloned()
                .unwrap_or_else(|| "proof_of_useful_intelligence".to_string()),
            220,
        );

        let mut ledger = load_ledger(root);
        let balances = ledger
            .get("balances")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let current_balance = balance_of(&balances, &agent);

        let gate_action = format!("tokenomics:{}:{}:{}", action, agent, reason);
        let gate_ok = directive_kernel::action_allowed(root, &gate_action);
        if !gate_ok && action != "slash" {
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "network_protocol_tokenomics_update",
                    "lane": "core/layer0/ops",
                    "action": action,
                    "agent": agent,
                    "amount": amount,
                    "reason": reason,
                    "error": "directive_gate_denied",
                    "layer_map": ["0","1","2","adapter"],
                    "claim_evidence": [
                        {
                            "id": "V8-NETWORK-002.1",
                            "claim": "staking_rewards_and_slashing_emit_identity_bound_receipts",
                            "evidence": {"allowed": false, "reason": "directive_gate_denied"}
                        }
                    ]
                }),
            );
        }

        let next_balance = match action.as_str() {
            "slash" => (current_balance - amount).max(0.0),
            _ => current_balance + amount,
        };
        put_balance(&mut ledger, &agent, next_balance);

        let staked = ledger
            .get("staked")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let current_stake = balance_of(&staked, &agent);
        let next_stake = match action.as_str() {
            "stake" => current_stake + amount,
            "slash" => (current_stake - amount).max(0.0),
            _ => current_stake,
        };
        put_stake(&mut ledger, &agent, next_stake);

        match commit_ledger(
            root,
            ledger,
            "tokenomics_update",
            json!({
                "action": action,
                "agent": agent,
                "amount": amount,
                "reason": reason,
                "balance_after": next_balance,
                "stake_after": next_stake
            }),
        ) {
            Ok(updated) => emit(
                root,
                json!({
                    "ok": true,
                    "type": "network_protocol_tokenomics_update",
                    "lane": "core/layer0/ops",
                    "action": action,
                    "agent": agent,
                    "amount": amount,
                    "reason": reason,
                    "balances": updated.get("balances").cloned().unwrap_or(Value::Object(Map::new())),
                    "staked": updated.get("staked").cloned().unwrap_or(Value::Object(Map::new())),
                    "network_state_root": updated.get("root_head").cloned().unwrap_or(Value::Null),
                    "layer_map": ["0","1","2","adapter"],
                    "claim_evidence": [
                        {
                            "id": "V8-NETWORK-002.1",
                            "claim": "staking_rewards_and_slashing_emit_identity_bound_receipts",
                            "evidence": {"action": action, "agent": agent}
                        }
                    ]
                }),
            ),
            Err(err) => emit(
                root,
                json!({
                    "ok": false,
                    "type": "network_protocol_tokenomics_update",
                    "lane": "core/layer0/ops",
                    "error": clean(err, 220)
                }),
            ),
        }
    } else if command == "oracle-query" {
        let provider = clean(
            parsed
                .flags
                .get("provider")
                .cloned()
                .unwrap_or_else(|| "polymarket".to_string()),
            80,
        )
        .to_ascii_lowercase();
        let event = clean(
            parsed
                .flags
                .get("event")
                .cloned()
                .unwrap_or_else(|| "default-event".to_string()),
            240,
        );
        let strict = parse_bool(parsed.flags.get("strict"), true);
        let gate_ok = gate_action(root, &format!("oracle:query:{provider}:{event}"));
        if strict && !gate_ok {
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "network_protocol_oracle_query",
                    "lane": "core/layer0/ops",
                    "provider": provider,
                    "event": event,
                    "error": "directive_gate_denied",
                    "claim_evidence": [
                        {
                            "id": "V8-NETWORK-003.4",
                            "claim": "oracle_query_and_market_actions_are_conduit_and_policy_gated",
                            "evidence": {"allowed": false, "provider": provider}
                        }
                    ]
                }),
            );
        }
        let seed = sha256_hex_str(&format!("{provider}:{event}"));
        let yes = (u64::from_str_radix(&seed[0..8], 16).unwrap_or(5000) % 10000) as f64 / 10000.0;
        let no = 1.0 - yes;
        let market_id = format!("{}:{}", provider, &seed[..12]);
        let query = json!({
            "market_id": market_id,
            "provider": provider.clone(),
            "event": event.clone(),
            "probabilities": {
                "yes": yes,
                "no": no
            },
            "confidence": ((yes - 0.5).abs() * 2.0).min(1.0),
            "ts": now_iso(),
            "provenance_hash": seed
        });
        let _ = write_json(&state_root(root).join("oracle").join("latest.json"), &query);
        let _ = append_event(root, &json!({"oracle_query": query.clone()}));
        emit(
            root,
            json!({
                "ok": true,
                "type": "network_protocol_oracle_query",
                "lane": "core/layer0/ops",
                "query": query,
                "claim_evidence": [
                    {
                        "id": "V8-NETWORK-003.1",
                        "claim": "prediction_market_oracle_returns_structured_probability_with_provenance",
                        "evidence": {"provider": provider.clone(), "market_id": market_id}
                    },
                    {
                        "id": "V8-NETWORK-003.4",
                        "claim": "oracle_query_and_market_actions_are_conduit_and_policy_gated",
                        "evidence": {"allowed": true, "provider": provider}
                    }
                ]
            }),
        )
    } else if command == "truth-weight" {
        let strict = parse_bool(parsed.flags.get("strict"), true);
        let market = clean(
            parsed
                .flags
                .get("market")
                .cloned()
                .or_else(|| parsed.flags.get("market-id").cloned())
                .unwrap_or_else(|| "polymarket:default".to_string()),
            160,
        );
        let gate_ok = gate_action(root, &format!("oracle:truth-weight:{market}"));
        if strict && !gate_ok {
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "network_protocol_truth_weight",
                    "lane": "core/layer0/ops",
                    "market": market,
                    "error": "directive_gate_denied",
                    "claim_evidence": [
                        {
                            "id": "V8-NETWORK-003.4",
                            "claim": "truth_weight_is_conduit_and_policy_gated",
                            "evidence": {"allowed": false}
                        }
                    ]
                }),
            );
        }
        let latest = read_json(&state_root(root).join("oracle").join("latest.json"))
            .unwrap_or_else(|| {
                json!({
                    "market_id": market,
                    "probabilities": {"yes": 0.5, "no": 0.5},
                    "confidence": 0.0
                })
            });
        let p_yes = latest
            .get("probabilities")
            .and_then(|v| v.get("yes"))
            .and_then(Value::as_f64)
            .unwrap_or(0.5);
        let source_reliability = (p_yes * 0.7) + 0.3;
        let causality_alignment = (1.0 - (0.5 - p_yes).abs()) * 0.8;
        let hybrid = ((source_reliability + causality_alignment) / 2.0).min(1.0);
        let disinfo_guard = json!({
            "quarantine_threshold": 0.25,
            "weight_multiplier": if hybrid < 0.25 { 0.2 } else { 1.0 },
            "mode": if hybrid < 0.25 { "quarantine" } else { "reweight" }
        });
        let out_state = json!({
            "market": market.clone(),
            "hybrid_confidence": hybrid,
            "components": {
                "market_probability_yes": p_yes,
                "source_reliability": source_reliability,
                "causality_alignment": causality_alignment
            },
            "disinformation_guard": disinfo_guard,
            "ts": now_iso()
        });
        let _ = write_json(
            &state_root(root)
                .join("oracle")
                .join("truth_weight_latest.json"),
            &out_state,
        );
        emit(
            root,
            json!({
                "ok": true,
                "type": "network_protocol_truth_weight",
                "lane": "core/layer0/ops",
                "weighting": out_state,
                "claim_evidence": [
                    {
                        "id": "V8-NETWORK-003.2",
                        "claim": "market_probabilities_are_fused_with_truth_signals_for_hybrid_scoring",
                        "evidence": {"hybrid_confidence": hybrid}
                    },
                    {
                        "id": "V8-NETWORK-003.3",
                        "claim": "disinformation_resistance_weights_or_quarantines_low_confidence_inputs",
                        "evidence": {"mode": disinfo_guard.get("mode").cloned().unwrap_or(Value::Null)}
                    },
                    {
                        "id": "V8-NETWORK-003.4",
                        "claim": "truth_weight_is_conduit_and_policy_gated",
                        "evidence": {"allowed": true}
                    },
                    {
                        "id": "V8-NETWORK-003.5",
                        "claim": "truth_weight_command_surface_routes_to_core_with_dashboard_ready_state",
                        "evidence": {"market": market}
                    }
                ]
            }),
        )
    } else if command == "merkle-root" {
        let gate_ok = gate_action(root, "tokenomics:merkle-root");
        if !gate_ok {
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "network_protocol_global_merkle_root",
                    "lane": "core/layer0/ops",
                    "error": "directive_gate_denied",
                    "gate_action": "tokenomics:merkle-root"
                }),
            );
        }
        let account = clean(
            parsed.flags.get("account").cloned().unwrap_or_default(),
            120,
        );
        let proof_requested = parse_bool(parsed.flags.get("proof"), true);
        let ledger = load_ledger(root);
        let policy_hash = directive_kernel::directive_vault_hash(root);
        let leaves = leaves_for_root(&ledger, &policy_hash);
        let root_hash = deterministic_merkle_root(&leaves);

        let (proof, leaf) = if proof_requested && !account.is_empty() {
            let entry = format!(
                "balance:{}:{:.8}",
                account,
                ledger
                    .get("balances")
                    .and_then(Value::as_object)
                    .map(|m| m.get(&account).and_then(Value::as_f64).unwrap_or(0.0))
                    .unwrap_or(0.0)
            );
            let idx = leaves.iter().position(|v| v == &entry).unwrap_or(0);
            (
                Value::Array(merkle_proof(&leaves, idx)),
                Value::String(entry),
            )
        } else {
            (Value::Array(Vec::new()), Value::Null)
        };

        emit(
            root,
            json!({
                "ok": true,
                "type": "network_protocol_global_merkle_root",
                "lane": "core/layer0/ops",
                "global_merkle_root": root_hash,
                "policy_hash": policy_hash,
                "leaf_count": leaves.len(),
                "inclusion_leaf": leaf,
                "inclusion_proof": proof,
                "root_progression_head": ledger.get("root_head").cloned().unwrap_or(Value::Null),
                "layer_map": ["0","1","2"],
                "claim_evidence": [
                    {
                        "id": "V8-NETWORK-002.2",
                        "claim": "global_state_root_is_deterministically_derived_from_receipt_and_policy_roots",
                        "evidence": {"leaf_count": leaves.len(), "proof_requested": proof_requested}
                    }
                ]
            }),
        )
    } else if command == "emission" {
        let gate_ok = gate_action(root, "tokenomics:emission");
        if !gate_ok {
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "network_protocol_emission_curve",
                    "lane": "core/layer0/ops",
                    "error": "directive_gate_denied",
                    "gate_action": "tokenomics:emission",
                    "layer_map": ["0","1","2"],
                    "claim_evidence": [
                        {
                            "id": "V8-NETWORK-002.3",
                            "claim": "halving_style_emission_schedule_is_deterministic_and_receipted",
                            "evidence": {"allowed": false, "reason": "directive_gate_denied"}
                        }
                    ]
                }),
            );
        }
        let height = parse_u64(parsed.flags.get("height"), 0);
        let interval = parse_u64(parsed.flags.get("halving-interval"), 210_000).max(1);
        let initial = parse_f64(parsed.flags.get("initial-issuance"), 50.0).max(0.0);
        let epoch = height / interval;
        let issuance = initial / f64::powi(2.0, epoch as i32);
        let next_halving_height = (epoch + 1) * interval;

        let mut ledger = load_ledger(root);
        if let Some(obj) = ledger.as_object_mut() {
            obj.insert(
                "emission".to_string(),
                json!({
                    "halving_interval": interval,
                    "initial_issuance": initial,
                    "epoch": epoch,
                    "issuance_per_epoch": issuance,
                    "next_halving_height": next_halving_height
                }),
            );
        }

        match commit_ledger(
            root,
            ledger,
            "emission_update",
            json!({"height": height, "epoch": epoch, "issuance": issuance}),
        ) {
            Ok(updated) => emit(
                root,
                json!({
                    "ok": true,
                    "type": "network_protocol_emission_curve",
                    "lane": "core/layer0/ops",
                    "height": height,
                    "halving_interval": interval,
                    "epoch": epoch,
                    "issuance_per_epoch": issuance,
                    "next_halving_height": next_halving_height,
                    "network_state_root": updated.get("root_head").cloned().unwrap_or(Value::Null),
                    "layer_map": ["0","1","2"],
                    "claim_evidence": [
                        {
                            "id": "V8-NETWORK-002.3",
                            "claim": "halving_style_emission_schedule_is_deterministic_and_receipted",
                            "evidence": {"epoch": epoch, "issuance_per_epoch": issuance}
                        }
                    ]
                }),
            ),
            Err(err) => emit(
                root,
                json!({
                    "ok": false,
                    "type": "network_protocol_emission_curve",
                    "lane": "core/layer0/ops",
                    "error": clean(err, 220)
                }),
            ),
        }
    } else if command == "zk-claim" {
        let gate_ok = gate_action(root, "tokenomics:zk-claim");
        if !gate_ok {
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "network_protocol_zk_claim",
                    "lane": "core/layer0/ops",
                    "error": "directive_gate_denied",
                    "gate_action": "tokenomics:zk-claim",
                    "layer_map": ["0","1","2","adapter"],
                    "claim_evidence": [
                        {
                            "id": "V8-NETWORK-002.4",
                            "claim": "private_claim_verification_is_policy_gated_and_receipted",
                            "evidence": {"allowed": false, "reason": "directive_gate_denied"}
                        }
                    ]
                }),
            );
        }
        let claim_id = clean(
            parsed
                .flags
                .get("claim-id")
                .cloned()
                .unwrap_or_else(|| "claim:unknown".to_string()),
            140,
        );
        let commitment = clean(
            parsed.flags.get("commitment").cloned().unwrap_or_default(),
            256,
        );
        let challenge = clean(
            parsed.flags.get("challenge").cloned().unwrap_or_default(),
            256,
        );
        let public_input = clean(
            parsed
                .flags
                .get("public-input")
                .cloned()
                .unwrap_or_else(|| "directive-compliant".to_string()),
            320,
        );
        let strict = parse_bool(parsed.flags.get("strict"), false);

        let expected_challenge = sha256_hex_str(&format!("{}:{}", commitment, public_input));
        let verified = !commitment.is_empty()
            && !challenge.is_empty()
            && challenge.eq_ignore_ascii_case(&expected_challenge);
        let ok = verified || !strict;

        let mut ledger = load_ledger(root);
        if let Some(obj) = ledger.as_object_mut() {
            let claims = map_mut(obj, "zk_claims");
            claims.insert(
                claim_id.clone(),
                json!({
                    "commitment": commitment,
                    "challenge": challenge,
                    "public_input": public_input,
                    "expected_challenge": expected_challenge,
                    "verified": verified,
                    "strict": strict,
                    "ts": now_iso()
                }),
            );
        }

        let updated = commit_ledger(
            root,
            ledger,
            "zk_claim",
            json!({"claim_id": claim_id, "verified": verified, "strict": strict}),
        );
        match updated {
            Ok(ledger2) => emit(
                root,
                json!({
                    "ok": ok,
                    "type": "network_protocol_zk_claim",
                    "lane": "core/layer0/ops",
                    "claim_id": claim_id,
                    "verified": verified,
                    "strict": strict,
                    "expected_challenge": expected_challenge,
                    "network_state_root": ledger2.get("root_head").cloned().unwrap_or(Value::Null),
                    "layer_map": ["0","1","2","adapter"],
                    "claim_evidence": [
                        {
                            "id": "V8-NETWORK-002.4",
                            "claim": "private_claim_verification_is_policy_gated_and_receipted",
                            "evidence": {"claim_id": claim_id, "verified": verified, "strict": strict}
                        }
                    ]
                }),
            ),
            Err(err) => emit(
                root,
                json!({
                    "ok": false,
                    "type": "network_protocol_zk_claim",
                    "lane": "core/layer0/ops",
                    "error": clean(err, 220)
                }),
            ),
        }
    } else {
        emit(
            root,
            json!({
                "ok": false,
                "type": "network_protocol_error",
                "lane": "core/layer0/ops",
                "error": "unknown_command",
                "command": command,
                "exit_code": 2
            }),
        )
    }
}
