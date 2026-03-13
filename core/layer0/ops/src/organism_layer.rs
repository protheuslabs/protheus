// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use crate::directive_kernel;
use crate::rsi_ignition;
use crate::v8_kernel::{
    append_jsonl, keyed_digest_hex, parse_bool, parse_f64, print_json, read_json,
    scoped_state_root, sha256_hex_str, write_json, write_receipt,
};
use crate::{clean, now_iso, parse_args};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "ORGANISM_LAYER_STATE_ROOT";
const STATE_SCOPE: &str = "organism_layer";
const CRYSTAL_SIGNING_ENV: &str = "ORGANISM_CRYSTAL_SIGNING_KEY";

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn organism_state_path(root: &Path) -> PathBuf {
    state_root(root).join("organism_state.json")
}

fn dream_log_path(root: &Path) -> PathBuf {
    state_root(root).join("dream_log.jsonl")
}

fn narrative_log_path(root: &Path) -> PathBuf {
    state_root(root).join("narrative_log.jsonl")
}

fn personality_history_path(root: &Path) -> PathBuf {
    state_root(root).join("personality_history.jsonl")
}

fn default_state() -> Value {
    json!({
        "version": "1.0",
        "active": false,
        "dream_count": 0,
        "narrative_count": 0,
        "vitals": {
            "coherence": 0.75,
            "metabolism": 0.50,
            "heartbeat": 75
        },
        "personality": {
            "version": 0,
            "persona": "default",
            "delta": "",
            "signature": "unsigned",
            "updated_at": now_iso()
        },
        "symbiosis": {
            "nodes": 0,
            "memory_share_rate": 0.0,
            "coherence_score": 0.0
        },
        "sensory": {
            "pain": 0.0,
            "pleasure": 0.0,
            "adjustment": "maintain"
        },
        "created_at": now_iso()
    })
}

fn load_state(root: &Path) -> Value {
    read_json(&organism_state_path(root)).unwrap_or_else(default_state)
}

fn store_state(root: &Path, state: &Value) -> Result<(), String> {
    write_json(&organism_state_path(root), state)
}

fn state_obj_mut(state: &mut Value) -> &mut Map<String, Value> {
    if !state.is_object() {
        *state = default_state();
    }
    state.as_object_mut().expect("state_object")
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
                "type": "organism_layer_error",
                "lane": "core/layer0/ops",
                "error": clean(err, 220),
                "exit_code": 2
            });
            out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
            print_json(&out);
            2
        }
    }
}

fn gate(root: &Path, action: &str) -> bool {
    directive_kernel::action_allowed(root, action)
}

fn rsi_state_path(root: &Path) -> PathBuf {
    crate::core_state_root(root)
        .join("ops")
        .join("rsi_ignition")
        .join("loop_state.json")
}

fn network_ledger_path(root: &Path) -> PathBuf {
    crate::core_state_root(root)
        .join("ops")
        .join("network_protocol")
        .join("ledger.json")
}

fn count_jsonl_rows(path: &Path) -> usize {
    fs::read_to_string(path)
        .ok()
        .map(|raw| raw.lines().filter(|line| !line.trim().is_empty()).count())
        .unwrap_or(0)
}

fn command_status(root: &Path) -> i32 {
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

fn command_ignite(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
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
    let dream_seed = sha256_hex_str(&format!("{}:{idle_hours:.2}:{experiments}:{drift:.3}", now_iso()));
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
        parsed
            .flags
            .get("delta")
            .cloned()
            .unwrap_or_else(|| "ignition crystallized a calmer, more coherent operating style".to_string()),
        260,
    );
    let prior_personality = state
        .get("personality")
        .cloned()
        .unwrap_or_else(|| default_state().get("personality").cloned().unwrap_or(Value::Null));
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
    let symbiosis_coherence = ((memory_share_rate * 0.8) + ((nodes as f64).ln() / 10.0)).clamp(0.0, 1.0);

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
            }
        }),
    )
}

fn command_dream(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
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
            "rsi_preview_exit": evolve_exit
        }),
    )
}

fn command_homeostasis(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
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
            "rsi_reflect_exit": reflect_exit
        }),
    )
}

fn command_crystallize(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
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
    let mut personality = state
        .get("personality")
        .cloned()
        .unwrap_or_else(|| default_state().get("personality").cloned().unwrap_or(Value::Null));
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
            "version": next_version
        }),
    )
}

fn command_symbiosis(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
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
            "rsi_swarm_exit": swarm_exit
        }),
    )
}

fn command_mutate(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
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
    let allowed = gate(root, "organism:mutate");
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
            "ignite_exit": ignite_exit
        }),
    )
}

fn command_sensory(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
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
            "adjustment": adjustment
        }),
    )
}

fn command_narrative(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
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
        parsed
            .flags
            .get("summary")
            .cloned()
            .unwrap_or_else(|| {
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
            "entry": entry
        }),
    )
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
        println!("  protheus-ops organism-layer status");
        println!("  protheus-ops organism-layer ignite [--apply=1|0]");
        println!("  protheus-ops organism-layer dream [--idle-hours=<n>] [--experiments=<n>] [--apply=1|0]");
        println!("  protheus-ops organism-layer homeostasis [--coherence=<0..1>] [--metabolism=<0..1>] [--apply=1|0]");
        println!("  protheus-ops organism-layer crystallize [--persona=<id>] [--delta=<text>] [--apply=1|0]");
        println!("  protheus-ops organism-layer symbiosis [--nodes=<n>] [--memory-share=<0..1>] [--apply=1|0]");
        println!("  protheus-ops organism-layer mutate [--proposal=<text>] [--module=<id>] [--apply=1|0]");
        println!("  protheus-ops organism-layer sensory [--pain=<0..1>] [--pleasure=<0..1>] [--apply=1|0]");
        println!("  protheus-ops organism-layer narrative [--summary=<text>] [--coherence=<0..1>] [--apply=1|0]");
        return 0;
    }

    match command.as_str() {
        "status" => command_status(root),
        "ignite" => command_ignite(root, &parsed),
        "dream" => command_dream(root, &parsed),
        "homeostasis" => command_homeostasis(root, &parsed),
        "crystallize" => command_crystallize(root, &parsed),
        "symbiosis" => command_symbiosis(root, &parsed),
        "mutate" => command_mutate(root, &parsed),
        "sensory" => command_sensory(root, &parsed),
        "narrative" => command_narrative(root, &parsed),
        _ => emit(
            root,
            json!({
                "ok": false,
                "type": "organism_layer_error",
                "lane": "core/layer0/ops",
                "error": "unknown_command",
                "command": command,
                "exit_code": 2
            }),
        ),
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
        let root = std::env::temp_dir().join(format!("protheus_organism_layer_{name}_{nonce}"));
        fs::create_dir_all(&root).expect("mkdir");
        root
    }

    fn allow(root: &Path, directive: &str) {
        std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "test-sign-key");
        assert_eq!(
            crate::directive_kernel::run(
                root,
                &[
                    "prime-sign".to_string(),
                    format!("--directive={directive}"),
                    "--signer=tester".to_string(),
                ]
            ),
            0
        );
    }

    #[test]
    fn dream_writes_log_when_allowed() {
        let root = temp_root("dream");
        allow(&root, "allow:organism:dream");
        let exit = run(
            &root,
            &[
                "dream".to_string(),
                "--idle-hours=7".to_string(),
                "--experiments=4".to_string(),
                "--apply=1".to_string(),
            ],
        );
        assert_eq!(exit, 0);
        assert!(dream_log_path(&root).exists());
        std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ignite_materializes_full_view_when_allowed() {
        let root = temp_root("ignite_full");
        allow(&root, "allow:organism:ignite");
        let exit = run(
            &root,
            &[
                "ignite".to_string(),
                "--apply=1".to_string(),
                "--idle-hours=7".to_string(),
                "--experiments=4".to_string(),
                "--persona=operator".to_string(),
            ],
        );
        assert_eq!(exit, 0);
        let latest = read_json(&latest_path(&root)).expect("latest");
        assert_eq!(
            latest
                .get("activated_components")
                .and_then(|v| v.get("dream"))
                .and_then(Value::as_bool),
            Some(true)
        );
        assert!(dream_log_path(&root).exists());
        assert!(narrative_log_path(&root).exists());
        assert!(personality_history_path(&root).exists());
        std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn mutate_routes_into_rsi_pipeline_when_allowed() {
        let root = temp_root("mutate");
        allow(&root, "allow:organism:mutate");
        allow(&root, "allow:rsi:ignite");
        allow(&root, "allow:blob_mutate");
        let exit = run(
            &root,
            &[
                "mutate".to_string(),
                "--proposal=safer plan".to_string(),
                "--module=conduit".to_string(),
                "--apply=1".to_string(),
            ],
        );
        assert_eq!(exit, 0);
        let latest = read_json(&latest_path(&root)).expect("latest");
        assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(true));
        std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn narrative_fails_closed_without_gate() {
        let root = temp_root("narrative_gate");
        let exit = run(
            &root,
            &[
                "narrative".to_string(),
                "--summary=test".to_string(),
                "--apply=1".to_string(),
            ],
        );
        assert_eq!(exit, 2);
        let _ = fs::remove_dir_all(root);
    }
}
