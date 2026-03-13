use super::*;

pub(super) fn command_crystallize(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let allowed = gate(root, "organism:crystallize");
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let persona = clean(
        parsed
            .flags
            .get("persona")
            .cloned()
            .unwrap_or_else(|| "default".to_string()),
        80,
    );
    let delta = clean(
        parsed
            .flags
            .get("delta")
            .cloned()
            .unwrap_or_else(|| "became slightly more concise and safety-focused".to_string()),
        260,
    );
    let mut state = load_state(root);
    let mut personality = state.get("personality").cloned().unwrap_or_else(|| {
        default_state()
            .get("personality")
            .cloned()
            .unwrap_or(Value::Null)
    });
    let next_version = personality
        .get("version")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        + 1;
    personality["version"] = Value::from(next_version);
    personality["persona"] = Value::String(persona.clone());
    personality["delta"] = Value::String(delta.clone());
    personality["updated_at"] = Value::String(now_iso());
    let signature = std::env::var(CRYSTAL_SIGNING_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(|secret| format!("sig:{}", keyed_digest_hex(&secret, &personality)))
        .unwrap_or_else(|| {
            format!(
                "unsigned:{}",
                sha256_hex_str(&serde_json::to_string(&personality).unwrap_or_default())
            )
        });
    personality["signature"] = Value::String(signature.clone());

    if apply && allowed {
        {
            let obj = state_obj_mut(&mut state);
            obj.insert("personality".to_string(), personality.clone());
        }
        let _ = append_jsonl(
            &personality_history_path(root),
            &json!({
                "ts": now_iso(),
                "personality": personality
            }),
        );
        let _ = store_state(root, &state);
    }

    emit(
        root,
        json!({
            "ok": allowed,
            "type": "organism_layer_crystallize",
            "lane": "core/layer0/ops",
            "apply": apply,
            "persona": persona,
            "delta": delta,
            "signature": signature,
            "version": next_version,
            "claim_evidence": [
                {
                    "id": "V8-ORGANISM-001.3",
                    "claim": "personality_crystallization_persists_signed_epistemic_objects",
                    "evidence": {
                        "persona": persona,
                        "version": next_version,
                        "signature": signature
                    }
                }
            ]
        }),
    )
}

pub(super) fn command_symbiosis(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let allowed = gate(root, "organism:symbiosis");
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let nodes = parse_f64(parsed.flags.get("nodes"), 7.0).max(1.0) as u64;
    let memory_share = parse_f64(parsed.flags.get("memory-share"), 0.58).clamp(0.0, 1.0);
    let convergence = ((memory_share * 0.8) + ((nodes as f64).ln() / 10.0)).clamp(0.0, 1.0);
    let mut swarm_exit = 0i32;

    if apply && allowed {
        swarm_exit = rsi_ignition::run(
            root,
            &[
                "swarm".to_string(),
                format!("--nodes={nodes}"),
                format!("--share-rate={memory_share:.3}"),
                "--apply=1".to_string(),
            ],
        );
        let mut state = load_state(root);
        {
            let obj = state_obj_mut(&mut state);
            obj.insert(
                "symbiosis".to_string(),
                json!({
                    "nodes": nodes,
                    "memory_share_rate": memory_share,
                    "coherence_score": convergence,
                    "updated_at": now_iso()
                }),
            );
        }
        let _ = store_state(root, &state);
    }

    emit(
        root,
        json!({
            "ok": allowed,
            "type": "organism_layer_symbiosis",
            "lane": "core/layer0/ops",
            "nodes": nodes,
            "memory_share_rate": memory_share,
            "coherence_score": convergence,
            "rsi_swarm_exit": swarm_exit,
            "claim_evidence": [
                {
                    "id": "V8-ORGANISM-001.4",
                    "claim": "network_symbiosis_forms_collective_state_with_memory_sharing",
                    "evidence": {
                        "nodes": nodes,
                        "memory_share_rate": memory_share,
                        "coherence_score": convergence,
                        "rsi_swarm_exit": swarm_exit
                    }
                }
            ]
        }),
    )
}

pub(super) fn command_mutate(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let proposal = clean(
        parsed
            .flags
            .get("proposal")
            .cloned()
            .unwrap_or_else(|| "try adaptive workflow compression pattern".to_string()),
        260,
    );
    let module = clean(
        parsed
            .flags
            .get("module")
            .cloned()
            .unwrap_or_else(|| "conduit".to_string()),
        120,
    )
    .to_ascii_lowercase();
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let gate_eval = directive_kernel::evaluate_action(root, "organism:mutate");
    let allowed = gate_eval
        .get("allowed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut ignite_exit = 0i32;
    if apply && allowed {
        ignite_exit = rsi_ignition::run(
            root,
            &[
                "ignite".to_string(),
                format!("--proposal={proposal}"),
                format!("--module={module}"),
                "--apply=1".to_string(),
            ],
        );
    }

    if apply {
        let mut state = load_state(root);
        {
            let obj = state_obj_mut(&mut state);
            obj.insert(
                "last_mutation".to_string(),
                json!({
                    "ts": now_iso(),
                    "proposal": proposal,
                    "module": module,
                    "allowed": allowed,
                    "ignite_exit": ignite_exit
                }),
            );
        }
        let _ = store_state(root, &state);
    }

    emit(
        root,
        json!({
            "ok": allowed && (!apply || ignite_exit == 0),
            "type": "organism_layer_mutation",
            "lane": "core/layer0/ops",
            "proposal": proposal,
            "module": module,
            "apply": apply,
            "allowed": allowed,
            "ignite_exit": ignite_exit,
            "directive_gate_evaluation": gate_eval,
            "rsi_ignite_latest": read_json(&rsi_state_path(root).parent().unwrap_or(root).join("latest.json")),
            "claim_evidence": [
                {
                    "id": "V8-ORGANISM-001.5",
                    "claim": "creative_mutation_proposals_are_inversion_simulated_and_directive_compliant",
                    "evidence": {
                        "allowed": allowed,
                        "ignite_exit": ignite_exit,
                        "proposal": proposal,
                        "module": module
                    }
                }
            ]
        }),
    )
}

pub(super) fn command_sensory(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let allowed = gate(root, "organism:sensory");
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let rsi_state = read_json(&rsi_state_path(root)).unwrap_or(Value::Null);
    let drift = rsi_state
        .get("drift_score")
        .and_then(Value::as_f64)
        .unwrap_or(0.2)
        .clamp(0.0, 1.0);
    let pain = parsed
        .flags
        .get("pain")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or((drift * 0.8).clamp(0.0, 1.0))
        .clamp(0.0, 1.0);
    let pleasure = parsed
        .flags
        .get("pleasure")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or((1.0 - drift) * 0.7)
        .clamp(0.0, 1.0);
    let adjustment = if pain > pleasure {
        "increase_reflection"
    } else if pleasure - pain > 0.25 {
        "increase_exploration"
    } else {
        "maintain"
    };

    if apply && allowed {
        let _ = rsi_ignition::run(
            root,
            &[
                "reflect".to_string(),
                format!("--drift={:.3}", pain.max(drift)),
                format!(
                    "--exploration={:.3}",
                    if adjustment == "increase_reflection" {
                        0.30
                    } else {
                        0.70
                    }
                ),
            ],
        );
        let mut state = load_state(root);
        {
            let obj = state_obj_mut(&mut state);
            obj.insert(
                "sensory".to_string(),
                json!({
                    "pain": pain,
                    "pleasure": pleasure,
                    "adjustment": adjustment,
                    "updated_at": now_iso()
                }),
            );
        }
        let _ = store_state(root, &state);
    }

    emit(
        root,
        json!({
            "ok": allowed,
            "type": "organism_layer_sensory",
            "lane": "core/layer0/ops",
            "pain": pain,
            "pleasure": pleasure,
            "adjustment": adjustment,
            "claim_evidence": [
                {
                    "id": "V8-ORGANISM-001.6",
                    "claim": "internal_sensory_feedback_is_integrated_into_runtime_regulation_loops",
                    "evidence": {
                        "pain": pain,
                        "pleasure": pleasure,
                        "adjustment": adjustment,
                        "reflect_invoked": apply && allowed
                    }
                }
            ]
        }),
    )
}

pub(super) fn command_narrative(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let allowed = gate(root, "organism:narrative");
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let state = load_state(root);
    let coherence = parsed
        .flags
        .get("coherence")
        .and_then(|v| v.parse::<f64>().ok())
        .or_else(|| {
            state
                .get("vitals")
                .and_then(|v| v.get("coherence"))
                .and_then(Value::as_f64)
        })
        .unwrap_or(0.7)
        .clamp(0.0, 1.0);
    let summary = clean(
        parsed.flags.get("summary").cloned().unwrap_or_else(|| {
            format!(
                "Today I became {:.1}% more coherent.",
                (coherence * 100.0) - 50.0
            )
        }),
        360,
    );
    let entry = json!({
        "ts": now_iso(),
        "summary": summary,
        "coherence": coherence
    });

    if apply && allowed {
        let _ = append_jsonl(&narrative_log_path(root), &entry);
        let mut next_state = load_state(root);
        {
            let obj = state_obj_mut(&mut next_state);
            obj.insert(
                "narrative_count".to_string(),
                Value::from(count_jsonl_rows(&narrative_log_path(root)) as u64),
            );
            obj.insert("last_narrative".to_string(), entry.clone());
        }
        let _ = store_state(root, &next_state);
    }

    emit(
        root,
        json!({
            "ok": allowed,
            "type": "organism_layer_narrative",
            "lane": "core/layer0/ops",
            "apply": apply,
            "entry": entry,
            "claim_evidence": [
                {
                    "id": "V8-ORGANISM-001.7",
                    "claim": "generative_internal_narrative_is_persisted_with_coherence_state",
                    "evidence": {
                        "summary": summary,
                        "coherence": coherence,
                        "narrative_count": count_jsonl_rows(&narrative_log_path(root))
                    }
                }
            ]
        }),
    )
}
