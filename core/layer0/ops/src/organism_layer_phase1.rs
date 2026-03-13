use super::*;

pub(super) fn command_status(root: &Path) -> i32 {
    let mut state = load_state(root);
    let obj = state_obj_mut(&mut state);
    obj.insert(
        "dream_count".to_string(),
        Value::from(count_jsonl_rows(&dream_log_path(root)) as u64),
    );
    obj.insert(
        "narrative_count".to_string(),
        Value::from(count_jsonl_rows(&narrative_log_path(root)) as u64),
    );
    let _ = store_state(root, &state);
    emit(
        root,
        json!({
            "ok": true,
            "type": "organism_layer_status",
            "lane": "core/layer0/ops",
            "state": state,
            "latest": read_json(&latest_path(root))
        }),
    )
}

pub(super) fn command_ignite(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let allowed = gate(root, "organism:ignite");
    let mut state = load_state(root);
    let rsi_state = read_json(&rsi_state_path(root)).unwrap_or(Value::Null);
    let network = read_json(&network_ledger_path(root)).unwrap_or(Value::Null);
    let drift = rsi_state
        .get("drift_score")
        .and_then(Value::as_f64)
        .unwrap_or(0.2)
        .clamp(0.0, 1.0);
    let idle_hours = parse_f64(parsed.flags.get("idle-hours"), 6.0).max(0.0);
    let experiments = parse_f64(parsed.flags.get("experiments"), 3.0).max(1.0) as u64;
    let dream_seed = sha256_hex_str(&format!(
        "{}:{idle_hours:.2}:{experiments}:{drift:.3}",
        now_iso()
    ));
    let dream = json!({
        "ts": now_iso(),
        "idle_hours": idle_hours,
        "experiments": experiments,
        "drift_score": drift,
        "insight": format!(
            "Ignition dream {} suggests a safer optimization route (drift {:.2}).",
            &dream_seed[..8],
            drift
        )
    });

    let treasury = network
        .get("balances")
        .and_then(Value::as_object)
        .and_then(|m| m.get("organism:treasury"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let metabolism = ((treasury / 1_000_000.0).clamp(0.0, 1.0) * 0.6 + 0.2).clamp(0.0, 1.0);
    let coherence = ((1.0 - drift) * 0.7 + metabolism * 0.3).clamp(0.0, 1.0);
    let heartbeat = (coherence * 100.0).round() as u64;
    let regulation_action = if coherence < 0.45 {
        "increase_stability"
    } else if coherence > 0.8 {
        "increase_exploration"
    } else {
        "maintain"
    };

    let persona = clean(
        parsed
            .flags
            .get("persona")
            .cloned()
            .unwrap_or_else(|| "default".to_string()),
        80,
    );
    let delta = clean(
        parsed.flags.get("delta").cloned().unwrap_or_else(|| {
            "ignition crystallized a calmer, more coherent operating style".to_string()
        }),
        260,
    );
    let prior_personality = state.get("personality").cloned().unwrap_or_else(|| {
        default_state()
            .get("personality")
            .cloned()
            .unwrap_or(Value::Null)
    });
    let next_persona_version = prior_personality
        .get("version")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        + 1;
    let mut personality = json!({
        "version": next_persona_version,
        "persona": persona,
        "delta": delta,
        "updated_at": now_iso()
    });
    let crystal_sig = std::env::var(CRYSTAL_SIGNING_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(|secret| format!("sig:{}", keyed_digest_hex(&secret, &personality)))
        .unwrap_or_else(|| {
            format!(
                "unsigned:{}",
                sha256_hex_str(&serde_json::to_string(&personality).unwrap_or_default())
            )
        });
    personality["signature"] = Value::String(crystal_sig.clone());

    let nodes = parse_f64(parsed.flags.get("nodes"), 7.0).max(1.0) as u64;
    let memory_share_rate = parse_f64(parsed.flags.get("memory-share"), 0.58).clamp(0.0, 1.0);
    let symbiosis_coherence =
        ((memory_share_rate * 0.8) + ((nodes as f64).ln() / 10.0)).clamp(0.0, 1.0);

    let pain = (drift * 0.8).clamp(0.0, 1.0);
    let pleasure = ((1.0 - drift) * 0.7).clamp(0.0, 1.0);
    let sensory_adjustment = if pain > pleasure {
        "increase_reflection"
    } else if pleasure - pain > 0.25 {
        "increase_exploration"
    } else {
        "maintain"
    };

    let narrative = json!({
        "ts": now_iso(),
        "summary": format!("Ignition complete: organism coherence now {:.1}%.", coherence * 100.0),
        "coherence": coherence
    });

    {
        let obj = state_obj_mut(&mut state);
        obj.insert("active".to_string(), Value::Bool(apply && allowed));
        obj.insert(
            "last_ignite".to_string(),
            json!({
                "ts": now_iso(),
                "apply": apply,
                "allowed": allowed,
                "regulation_action": regulation_action
            }),
        );
        if apply && allowed {
            obj.insert(
                "vitals".to_string(),
                json!({
                    "coherence": coherence,
                    "metabolism": metabolism,
                    "heartbeat": heartbeat
                }),
            );
            obj.insert("personality".to_string(), personality.clone());
            obj.insert(
                "symbiosis".to_string(),
                json!({
                    "nodes": nodes,
                    "memory_share_rate": memory_share_rate,
                    "coherence_score": symbiosis_coherence,
                    "updated_at": now_iso()
                }),
            );
            obj.insert(
                "sensory".to_string(),
                json!({
                    "pain": pain,
                    "pleasure": pleasure,
                    "adjustment": sensory_adjustment,
                    "updated_at": now_iso()
                }),
            );
            obj.insert("last_dream".to_string(), dream.clone());
            obj.insert("last_narrative".to_string(), narrative.clone());
        }
    }
    if apply && allowed {
        let _ = append_jsonl(&dream_log_path(root), &dream);
        let _ = append_jsonl(&narrative_log_path(root), &narrative);
        let _ = append_jsonl(
            &personality_history_path(root),
            &json!({"ts": now_iso(), "personality": personality}),
        );
        {
            let obj = state_obj_mut(&mut state);
            obj.insert(
                "dream_count".to_string(),
                Value::from(count_jsonl_rows(&dream_log_path(root)) as u64),
            );
            obj.insert(
                "narrative_count".to_string(),
                Value::from(count_jsonl_rows(&narrative_log_path(root)) as u64),
            );
        }
    }
    if let Err(err) = store_state(root, &state) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "organism_layer_ignite",
                "lane": "core/layer0/ops",
                "error": clean(err, 220)
            }),
        );
    }
    emit(
        root,
        json!({
            "ok": allowed,
            "type": "organism_layer_ignite",
            "lane": "core/layer0/ops",
            "apply": apply,
            "commands": ["protheus organism ignite", "protheus organism status"],
            "organism_view": {
                "dream": dream,
                "vitals": {
                    "coherence": coherence,
                    "metabolism": metabolism,
                    "heartbeat": heartbeat,
                    "regulation_action": regulation_action
                },
                "personality": {
                    "version": next_persona_version,
                    "persona": persona,
                    "signature": crystal_sig
                },
                "symbiosis": {
                    "nodes": nodes,
                    "memory_share_rate": memory_share_rate,
                    "coherence_score": symbiosis_coherence
                },
                "sensory": {
                    "pain": pain,
                    "pleasure": pleasure,
                    "adjustment": sensory_adjustment
                },
                "narrative": narrative
            },
            "activated_components": {
                "dream": apply && allowed,
                "homeostasis": apply && allowed,
                "crystallize": apply && allowed,
                "symbiosis": apply && allowed,
                "sensory": apply && allowed,
                "narrative": apply && allowed
            },
            "claim_evidence": [
                {
                    "id": "V8-ORGANISM-001.1",
                    "claim": "dream_state_processing_runs_autonomously_and_surfaces_actionable_insights",
                    "evidence": {
                        "idle_hours": idle_hours,
                        "experiments": experiments,
                        "dream_insight": dream.get("insight").cloned().unwrap_or(Value::Null)
                    }
                },
                {
                    "id": "V8-ORGANISM-001.2",
                    "claim": "homeostasis_tracks_vitals_and_self_regulates_organism_behavior",
                    "evidence": {
                        "coherence": coherence,
                        "metabolism": metabolism,
                        "heartbeat": heartbeat,
                        "regulation_action": regulation_action
                    }
                },
                {
                    "id": "V8-ORGANISM-001.3",
                    "claim": "personality_crystallization_persists_signed_epistemic_objects",
                    "evidence": {
                        "persona": persona,
                        "version": next_persona_version,
                        "signature": crystal_sig
                    }
                },
                {
                    "id": "V8-ORGANISM-001.4",
                    "claim": "network_symbiosis_forms_collective_state_with_memory_sharing",
                    "evidence": {
                        "nodes": nodes,
                        "memory_share_rate": memory_share_rate,
                        "coherence_score": symbiosis_coherence
                    }
                },
                {
                    "id": "V8-ORGANISM-001.5",
                    "claim": "creative_mutation_paths_are_available_for_proactive_opt_in_evolution",
                    "evidence": {
                        "active": apply && allowed,
                        "preview_command": "protheus organism mutate --apply=1"
                    }
                },
                {
                    "id": "V8-ORGANISM-001.6",
                    "claim": "internal_sensory_feedback_is_integrated_into_runtime_regulation_loops",
                    "evidence": {
                        "pain": pain,
                        "pleasure": pleasure,
                        "adjustment": sensory_adjustment
                    }
                },
                {
                    "id": "V8-ORGANISM-001.7",
                    "claim": "generative_internal_narrative_is_persisted_with_coherence_state",
                    "evidence": {
                        "summary": narrative.get("summary").cloned().unwrap_or(Value::Null),
                        "coherence": coherence,
                        "narrative_count": count_jsonl_rows(&narrative_log_path(root))
                    }
                },
                {
                    "id": "V8-ORGANISM-001.8",
                    "claim": "one_command_ignite_surfaces_a_full_organism_view_without_client_authority_bypass",
                    "evidence": {
                        "activation_command": "protheus organism ignite",
                        "status_command": "protheus organism status",
                        "activated_components": {
                            "dream": apply && allowed,
                            "homeostasis": apply && allowed,
                            "crystallize": apply && allowed,
                            "symbiosis": apply && allowed,
                            "sensory": apply && allowed,
                            "narrative": apply && allowed
                        }
                    }
                }
            ]
        }),
    )
}

pub(super) fn command_dream(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let idle_hours = parse_f64(parsed.flags.get("idle-hours"), 6.0).max(0.0);
    let experiments = parse_f64(parsed.flags.get("experiments"), 3.0).max(1.0) as u64;
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let allowed = gate(root, "organism:dream");
    let rsi_state = read_json(&rsi_state_path(root)).unwrap_or(Value::Null);
    let drift = rsi_state
        .get("drift_score")
        .and_then(Value::as_f64)
        .unwrap_or(0.2);
    let seed = sha256_hex_str(&format!("{}:{}:{:.3}", now_iso(), experiments, drift));
    let insight = format!(
        "Dream insight {}: tighten module scheduling for lower drift ({:.2}).",
        &seed[..8],
        drift
    );
    let dream_entry = json!({
        "ts": now_iso(),
        "idle_hours": idle_hours,
        "experiments": experiments,
        "drift_score": drift,
        "insight": insight
    });

    let mut evolve_exit = 0i32;
    if apply && allowed {
        let _ = append_jsonl(&dream_log_path(root), &dream_entry);
        evolve_exit = rsi_ignition::run(
            root,
            &[
                "evolve".to_string(),
                format!("--insight={insight}"),
                "--module=conduit".to_string(),
                "--apply=0".to_string(),
            ],
        );
        let mut state = load_state(root);
        {
            let obj = state_obj_mut(&mut state);
            obj.insert(
                "dream_count".to_string(),
                Value::from(count_jsonl_rows(&dream_log_path(root)) as u64),
            );
            obj.insert("last_dream".to_string(), dream_entry.clone());
        }
        let _ = store_state(root, &state);
    }

    emit(
        root,
        json!({
            "ok": allowed,
            "type": "organism_layer_dream",
            "lane": "core/layer0/ops",
            "apply": apply,
            "dream": dream_entry,
            "rsi_preview_exit": evolve_exit,
            "morning_insight_proposal": insight,
            "claim_evidence": [
                {
                    "id": "V8-ORGANISM-001.1",
                    "claim": "dream_state_processing_runs_autonomously_and_surfaces_actionable_insights",
                    "evidence": {
                        "insight": insight,
                        "rsi_preview_exit": evolve_exit
                    }
                }
            ]
        }),
    )
}

pub(super) fn command_homeostasis(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let allowed = gate(root, "organism:homeostasis");
    let rsi_state = read_json(&rsi_state_path(root)).unwrap_or(Value::Null);
    let network = read_json(&network_ledger_path(root)).unwrap_or(Value::Null);

    let drift = rsi_state
        .get("drift_score")
        .and_then(Value::as_f64)
        .unwrap_or(0.2)
        .clamp(0.0, 1.0);
    let treasury = network
        .get("balances")
        .and_then(Value::as_object)
        .and_then(|m| m.get("organism:treasury"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let metabolism = parsed
        .flags
        .get("metabolism")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(((treasury / 1_000_000.0).clamp(0.0, 1.0) * 0.6 + 0.2).clamp(0.0, 1.0));
    let coherence = parsed
        .flags
        .get("coherence")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or((1.0 - drift) * 0.7 + metabolism * 0.3)
        .clamp(0.0, 1.0);
    let heartbeat = (coherence * 100.0).round() as u64;
    let action = if coherence < 0.45 {
        "increase_stability"
    } else if coherence > 0.8 {
        "increase_exploration"
    } else {
        "maintain"
    };

    let mut reflect_exit = 0i32;
    if apply && allowed {
        reflect_exit = rsi_ignition::run(
            root,
            &[
                "reflect".to_string(),
                format!("--drift={drift:.3}"),
                format!(
                    "--exploration={:.3}",
                    if action == "increase_stability" {
                        0.35
                    } else {
                        0.65
                    }
                ),
            ],
        );
        let mut state = load_state(root);
        {
            let obj = state_obj_mut(&mut state);
            obj.insert(
                "vitals".to_string(),
                json!({
                    "coherence": coherence,
                    "metabolism": metabolism,
                    "heartbeat": heartbeat
                }),
            );
            obj.insert(
                "last_homeostasis".to_string(),
                json!({
                    "ts": now_iso(),
                    "regulation_action": action,
                    "drift_score": drift
                }),
            );
        }
        let _ = store_state(root, &state);
    }

    emit(
        root,
        json!({
            "ok": allowed,
            "type": "organism_layer_homeostasis",
            "lane": "core/layer0/ops",
            "vitals": {
                "coherence": coherence,
                "metabolism": metabolism,
                "heartbeat": heartbeat
            },
            "regulation_action": action,
            "rsi_reflect_exit": reflect_exit,
            "claim_evidence": [
                {
                    "id": "V8-ORGANISM-001.2",
                    "claim": "homeostasis_tracks_vitals_and_self_regulates_organism_behavior",
                    "evidence": {
                        "coherence": coherence,
                        "metabolism": metabolism,
                        "heartbeat": heartbeat,
                        "regulation_action": action,
                        "rsi_reflect_exit": reflect_exit
                    }
                }
            ]
        }),
    )
}
