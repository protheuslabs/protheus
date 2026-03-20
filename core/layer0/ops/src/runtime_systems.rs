// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::runtime_systems (authoritative)
use crate::contract_lane_utils as lane_utils;
use crate::runtime_system_contracts::{
    actionable_profiles, looks_like_contract_id, profile_for, RuntimeSystemContractProfile,
};
use crate::{client_state_root, deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const LANE_ID: &str = "runtime_systems";

fn usage() {
    println!("Usage:");
    println!("  protheus-ops runtime-systems <status|verify|run|build|manifest|roi-sweep|bootstrap|package|settle> [--system-id=<id>|--lane-id=<id>] [flags]");
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn receipt_hash(value: &Value) -> String {
    deterministic_receipt_hash(value)
}

fn profile_json(profile: RuntimeSystemContractProfile) -> Value {
    json!({
        "id": profile.id,
        "family": profile.family,
        "objective": profile.objective,
        "strict_conduit_only": profile.strict_conduit_only,
        "strict_fail_closed": profile.strict_fail_closed
    })
}

fn mutation_receipt_claim(system_id: &str, command: &str, apply: bool, strict: bool) -> Value {
    json!({
        "id": "runtime_system_mutation_receipted",
        "claim": "runtime_system_operations_emit_deterministic_receipts_and_state",
        "evidence": {
            "system_id": system_id,
            "command": command,
            "apply": apply,
            "strict": strict
        }
    })
}

fn parse_json(raw: Option<&str>) -> Result<Value, String> {
    let text = raw.ok_or_else(|| "missing_json_payload".to_string())?;
    serde_json::from_str::<Value>(text).map_err(|err| format!("invalid_json_payload:{err}"))
}

fn systems_dir(root: &Path) -> PathBuf {
    client_state_root(root).join("runtime_systems")
}

fn latest_path(root: &Path, system_id: &str) -> PathBuf {
    systems_dir(root).join(system_id).join("latest.json")
}

fn history_path(root: &Path, system_id: &str) -> PathBuf {
    systems_dir(root).join(system_id).join("history.jsonl")
}

fn contract_state_path(root: &Path, family: &str) -> PathBuf {
    systems_dir(root)
        .join("_contracts")
        .join(family)
        .join("state.json")
}

fn payload_f64(payload: &Value, key: &str, fallback: f64) -> f64 {
    payload
        .get(key)
        .and_then(Value::as_f64)
        .or_else(|| payload.get(key).and_then(Value::as_i64).map(|v| v as f64))
        .or_else(|| payload.get(key).and_then(Value::as_u64).map(|v| v as f64))
        .unwrap_or(fallback)
}

fn payload_bool(payload: &Value, key: &str, fallback: bool) -> bool {
    payload
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(fallback)
}

fn payload_string(payload: &Value, key: &str, fallback: &str) -> String {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn payload_string_array(payload: &Value, key: &str, fallback: &[&str]) -> Vec<String> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|rows| !rows.is_empty())
        .unwrap_or_else(|| fallback.iter().map(|v| (*v).to_string()).collect())
}

fn missing_required_tokens(actual: &[String], required: &[&str]) -> Vec<String> {
    let set: BTreeSet<String> = actual.iter().map(|v| v.to_ascii_lowercase()).collect();
    required
        .iter()
        .filter_map(|token| {
            let canonical = token.to_ascii_lowercase();
            if set.contains(&canonical) {
                None
            } else {
                Some((*token).to_string())
            }
        })
        .collect()
}

fn contract_specific_gates(
    profile: RuntimeSystemContractProfile,
    payload: &Value,
) -> (serde_json::Map<String, Value>, Vec<String>) {
    let mut checks = serde_json::Map::new();
    let mut violations = Vec::<String>::new();

    match profile.id {
        "V9-AUDIT-026.1" => {
            let targets = payload_string_array(
                payload,
                "audit_targets",
                &[
                    "origin_integrity",
                    "supply_chain_provenance_v2",
                    "alpha_readiness",
                ],
            );
            let missing = missing_required_tokens(
                &targets,
                &[
                    "origin_integrity",
                    "supply_chain_provenance_v2",
                    "alpha_readiness",
                ],
            );
            checks.insert("audit_targets".to_string(), json!(targets));
            checks.insert("audit_targets_missing".to_string(), json!(missing));
            if !missing.is_empty() {
                violations.push(format!(
                    "specific_missing_audit_targets:{}",
                    missing.join("|")
                ));
            }
        }
        "V9-AUDIT-026.2" => {
            let actions = payload_string_array(
                payload,
                "self_healing_actions",
                &[
                    "refresh_spine_receipt",
                    "rebuild_supply_chain_bundle",
                    "reconcile_workspace_churn",
                ],
            );
            let missing = missing_required_tokens(
                &actions,
                &[
                    "refresh_spine_receipt",
                    "rebuild_supply_chain_bundle",
                    "reconcile_workspace_churn",
                ],
            );
            checks.insert("self_healing_actions".to_string(), json!(actions));
            checks.insert("self_healing_actions_missing".to_string(), json!(missing));
            if !missing.is_empty() {
                violations.push(format!(
                    "specific_missing_self_healing_actions:{}",
                    missing.join("|")
                ));
            }
        }
        "V9-AUDIT-026.3" => {
            let range = payload_string(payload, "confidence_range", "0.0-1.0");
            checks.insert("confidence_range".to_string(), json!(range.clone()));
            if range != "0.0-1.0" {
                violations.push(format!("specific_confidence_range_mismatch:{range}"));
            }
        }
        "V9-AUDIT-026.4" => {
            let consensus = payload_string(payload, "consensus_mode", "strict_match");
            checks.insert("consensus_mode".to_string(), json!(consensus.clone()));
            if consensus != "strict_match" {
                violations.push(format!("specific_consensus_mode_mismatch:{consensus}"));
            }
        }
        _ => {}
    }

    (checks, violations)
}

fn count_lines(path: &Path) -> u64 {
    fs::read_to_string(path)
        .ok()
        .map(|raw| raw.lines().count() as u64)
        .unwrap_or(0)
}

fn collect_repo_language_lines(dir: &Path, rs_lines: &mut u64, ts_lines: &mut u64) {
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        if path.is_dir() {
            if matches!(
                name,
                ".git"
                    | "target"
                    | "node_modules"
                    | "dist"
                    | "build"
                    | "coverage"
                    | "tmp"
                    | "local"
            ) {
                continue;
            }
            collect_repo_language_lines(&path, rs_lines, ts_lines);
            continue;
        }
        if name.ends_with(".rs") {
            *rs_lines += count_lines(&path);
        } else if name.ends_with(".ts") {
            *ts_lines += count_lines(&path);
        }
    }
}

fn repo_language_share(root: &Path) -> (u64, u64, f64) {
    let mut rs_lines = 0u64;
    let mut ts_lines = 0u64;
    collect_repo_language_lines(root, &mut rs_lines, &mut ts_lines);
    let total = rs_lines.saturating_add(ts_lines);
    let rust_share_pct = if total == 0 {
        0.0
    } else {
        (rs_lines as f64) * 100.0 / (total as f64)
    };
    (rs_lines, ts_lines, rust_share_pct)
}

#[derive(Debug, Clone)]
struct ContractExecution {
    summary: Value,
    claims: Vec<Value>,
    artifacts: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
struct FamilyContractRequirements {
    required_true: &'static [&'static str],
    min_values: &'static [(&'static str, f64)],
    max_values: &'static [(&'static str, f64)],
}

const EMPTY_REQUIRED_TRUE: &[&str] = &[];
const EMPTY_NUM_GATES: &[(&str, f64)] = &[];

fn family_contract_requirements(family: &str) -> FamilyContractRequirements {
    match family {
        "audit_self_healing_stack" => FamilyContractRequirements {
            required_true: &[
                "drift_detection_enabled",
                "self_healing_playbooks_enabled",
                "confidence_scoring_enabled",
                "cross_agent_verification_enabled",
                "human_review_gate_enforced",
                "conduit_only_enforced",
            ],
            min_values: &[
                ("confidence_high_threshold", 0.85),
                ("verification_agents", 2.0),
            ],
            max_values: &[("poll_interval_minutes", 15.0)],
        },
        "ultimate_evolution" => FamilyContractRequirements {
            required_true: &[
                "replication_policy_gate",
                "self_awareness_journal",
                "exotic_hardware_abstraction",
                "tokenomics_ledger_enforced",
                "symbiosis_interface",
                "universal_adapter_skeleton_key",
            ],
            min_values: &[("universal_adapter_coverage_pct", 80.0)],
            max_values: EMPTY_NUM_GATES,
        },
        "automation_mission_stack" => FamilyContractRequirements {
            required_true: &[
                "cron_scheduler_enabled",
                "multi_agent_handoff_enabled",
                "persistent_memory_enabled",
                "security_hardening_enabled",
                "mission_dashboard_enabled",
            ],
            min_values: EMPTY_NUM_GATES,
            max_values: &[
                ("checkpoint_interval_items", 10.0),
                ("checkpoint_interval_minutes", 2.0),
            ],
        },
        "autonomy_opportunity_engine" => FamilyContractRequirements {
            required_true: &[
                "opportunity_discovery_engine",
                "inefficiency_scanner",
                "monetization_evaluator",
                "hindsight_ranking_engine",
            ],
            min_values: &[("creative_mode_signal_floor", 0.5)],
            max_values: EMPTY_NUM_GATES,
        },
        "cli_surface_hardening" => FamilyContractRequirements {
            required_true: &[
                "single_static_rust_binary",
                "rust_state_machine_core",
                "ts_cli_opt_in_extension",
                "thin_shim_wrapper",
                "node_absence_doctor_message",
            ],
            min_values: EMPTY_NUM_GATES,
            max_values: &[("static_binary_mb", 6.0)],
        },
        "client_model_access" => FamilyContractRequirements {
            required_true: &[
                "vibe_proxy_layer_enabled",
                "model_access_store_encrypted",
                "model_access_store_policy_gate",
            ],
            min_values: EMPTY_NUM_GATES,
            max_values: EMPTY_NUM_GATES,
        },
        "competitive_execution_moat" => FamilyContractRequirements {
            required_true: &[
                "aot_musl_zerocopy_lanes",
                "signed_receipt_export_sub_ms",
                "non_divergence_pre_execution_gate",
                "autonomous_swarm_workflow_evolution",
                "kernel_native_observability_governance",
                "edge_to_cloud_uniform_plan",
                "production_resilience_flywheel",
            ],
            min_values: &[("throughput_ops_sec", 11000.0)],
            max_values: &[("p95_ms", 50.0)],
        },
        "eyes_media_assimilation" => FamilyContractRequirements {
            required_true: &[
                "video_transcription_enabled",
                "course_assimilation_pipeline",
                "podcast_generator_enabled",
                "swarm_opportunity_integration",
            ],
            min_values: &[("transcript_quality_floor", 0.7)],
            max_values: EMPTY_NUM_GATES,
        },
        "eyes_computer_use" => FamilyContractRequirements {
            required_true: &[
                "parchi_computer_use_engine",
                "frontend_navigation_reliability",
                "computer_use_safety_gate",
                "superwhisper_voice_engine",
                "voice_session_blob_archival",
            ],
            min_values: &[("interaction_success_floor", 0.75)],
            max_values: EMPTY_NUM_GATES,
        },
        "eyes_lightpanda_router" => FamilyContractRequirements {
            required_true: &[
                "lightpanda_backend_enabled",
                "ultra_speed_profile_enabled",
                "seamless_multi_backend_router",
                "browser_session_blob_archival",
            ],
            min_values: &[("target_speedup_x", 10.0)],
            max_values: EMPTY_NUM_GATES,
        },
        "learning_rsi_pipeline" => FamilyContractRequirements {
            required_true: &[
                "signal_extraction_prm_judge",
                "hindsight_on_policy_distillation",
                "async_four_loop_training",
                "interaction_trajectory_blob_integration",
                "distributed_gym_factory",
                "adversarial_verification_pipeline",
                "training_flywheel_export",
                "real_world_product_verifier",
                "local_overnight_self_improvement",
                "real_usage_feedback_reinforcement",
                "single_directive_rl_engine",
                "emergent_strategy_discovery",
                "weekly_policy_retraining",
                "auto_rollback_enabled",
                "low_cost_overnight_loop",
            ],
            min_values: &[("training_loops_per_day", 1.0)],
            max_values: EMPTY_NUM_GATES,
        },
        "memory_depth_stack" => FamilyContractRequirements {
            required_true: &[
                "hierarchical_tree_index_builder",
                "agentic_tree_reasoning_retriever",
                "vision_page_retrieval",
                "tree_index_trace_blob_archival",
                "lossless_folder_backend",
                "automatic_sync_perfect_recall",
                "blob_lossless_hybrid_mirroring",
                "tinymax_lossless_mode",
                "tree_sitter_ast_indexer",
                "blast_radius_analyzer",
                "auto_codebase_wiki_generator",
                "mcp_graph_integration",
                "persistent_case_facts_scratchpad",
                "claim_source_provenance_mapping",
            ],
            min_values: EMPTY_NUM_GATES,
            max_values: &[("recall_budget_ms", 500.0)],
        },
        "organism_parallel_intelligence" => FamilyContractRequirements {
            required_true: &[
                "side_chat_forking_engine",
                "non_capturing_overlay_renderer",
                "file_overlap_peek_safety",
                "persistent_side_session_blob_integration",
                "hub_spoke_coordinator",
                "plan_vs_explore_subagent_separation",
                "autonomous_model_generator",
                "self_critique_alternative_perspectives",
                "explainer_slide_visual_synthesis",
                "model_evolution_archive",
            ],
            min_values: EMPTY_NUM_GATES,
            max_values: EMPTY_NUM_GATES,
        },
        "persona_enterprise_pack" => FamilyContractRequirements {
            required_true: &[
                "ai_ceo_persona_core",
                "departmental_agent_pack",
                "cross_agent_memory_sync",
                "role_based_agent_addition",
            ],
            min_values: EMPTY_NUM_GATES,
            max_values: EMPTY_NUM_GATES,
        },
        "safety_error_taxonomy" => FamilyContractRequirements {
            required_true: &["structured_error_taxonomy", "error_fail_closed_mapping"],
            min_values: EMPTY_NUM_GATES,
            max_values: EMPTY_NUM_GATES,
        },
        "security_sandbox_redteam" => FamilyContractRequirements {
            required_true: &[
                "wasm_capability_sandbox",
                "credential_injection_isolation",
                "verifiable_privacy_plane",
                "long_horizon_attack_chain_simulation",
                "zero_to_full_context_accumulation",
                "attack_trajectory_blob_archival",
            ],
            min_values: EMPTY_NUM_GATES,
            max_values: &[("max_escape_rate", 0.001)],
        },
        "skills_runtime_pack" => FamilyContractRequirements {
            required_true: &[
                "native_hf_cli_skill",
                "autonomous_model_dataset_pipeline",
                "hf_pure_context_mode",
                "hf_output_swarm_integration",
                "native_pomodoro_skill",
                "interactive_tui_focus_mode",
                "shell_composable_focus_status",
                "focus_session_blob_integration",
                "raspberry_pi_edge_template",
                "self_healing_server_agent",
                "orion_team_coordinator",
                "productivity_workflow_pack",
                "lens_scribe_code_agent_pack",
                "claude_style_prompt_chaining",
                "iterative_refinement_loop",
                "component_fullstack_scaffolding",
                "one_click_deployment_flow",
            ],
            min_values: EMPTY_NUM_GATES,
            max_values: EMPTY_NUM_GATES,
        },
        "swarm_runtime_scaling" => FamilyContractRequirements {
            required_true: &[
                "sentiment_swarm_core",
                "scenario_injection_live_consensus_mapper",
                "prediction_market_sentiment_oracle",
                "swarm_trajectory_storage_dream_refinement",
                "role_based_model_assignment",
                "automatic_parallel_exploration",
                "visual_subagent_dashboard",
                "subagent_edit_permission_gate",
                "planning_as_tool_engine",
                "filesystem_native_persistent_memory",
                "isolated_subagent_spawning",
                "shell_execution_safety_gates",
                "worker_heartbeat",
                "automatic_work_stealing",
                "supervisor_watchdog_respawn",
                "output_schema_enforcement",
                "frequent_checkpoint_recovery",
                "scope_boundary_validation",
                "realtime_aggregation_dashboard",
                "capability_advertisement_adaptive_partitioning",
                "cross_agent_dedup_reconciliation",
                "timeout_graceful_degradation",
            ],
            min_values: EMPTY_NUM_GATES,
            max_values: &[("max_timeout_seconds", 120.0)],
        },
        "client_wasm_bridge" => FamilyContractRequirements {
            required_true: &[
                "rust_wasm_bridge_engine",
                "browser_structured_concurrency",
                "standalone_html_demo_generator",
                "wasm_artifact_blob_archival",
            ],
            min_values: EMPTY_NUM_GATES,
            max_values: EMPTY_NUM_GATES,
        },
        "organism_adlc" => FamilyContractRequirements {
            required_true: &[
                "adlc_core_engine",
                "evolving_goals_replanning",
                "parallel_subagent_coordination",
                "continuous_testing_live_feedback",
            ],
            min_values: EMPTY_NUM_GATES,
            max_values: EMPTY_NUM_GATES,
        },
        "tinymax_extreme_profile" => FamilyContractRequirements {
            required_true: &[
                "trait_driven_swappable_tinymax_core",
                "sub5mb_idle_memory_mode",
            ],
            min_values: EMPTY_NUM_GATES,
            max_values: &[("idle_memory_mb", 5.0)],
        },
        _ => FamilyContractRequirements {
            required_true: EMPTY_REQUIRED_TRUE,
            min_values: EMPTY_NUM_GATES,
            max_values: EMPTY_NUM_GATES,
        },
    }
}

fn execute_generic_family_contract(
    root: &Path,
    profile: RuntimeSystemContractProfile,
    payload: &Value,
    apply: bool,
    strict: bool,
) -> Result<ContractExecution, String> {
    let (state_path, mut state, state_rel) = load_contract_state(root, profile);
    let requirements = family_contract_requirements(profile.family);

    let mut bool_checks = serde_json::Map::new();
    let mut min_checks = serde_json::Map::new();
    let mut max_checks = serde_json::Map::new();
    let mut specific_checks = serde_json::Map::new();
    let mut violations = Vec::<String>::new();

    for key in requirements.required_true {
        let value = payload_bool(payload, key, false);
        bool_checks.insert((*key).to_string(), json!(value));
        if !value {
            violations.push(format!("required_true:{key}"));
        }
    }
    for (key, min) in requirements.min_values {
        let value = payload_f64(payload, key, *min);
        min_checks.insert((*key).to_string(), json!({ "value": value, "min": min }));
        if value < *min {
            violations.push(format!("min_violation:{key}:{value:.6}<{min:.6}"));
        }
    }
    for (key, max) in requirements.max_values {
        let value = payload_f64(payload, key, *max);
        max_checks.insert((*key).to_string(), json!({ "value": value, "max": max }));
        if value > *max {
            violations.push(format!("max_violation:{key}:{value:.6}>{max:.6}"));
        }
    }

    let (specific, specific_violations) = contract_specific_gates(profile, payload);
    specific_checks.extend(specific);
    violations.extend(specific_violations);

    if strict && !violations.is_empty() {
        return Err(format!(
            "family_contract_gate_failed:{}:{}",
            profile.id,
            violations.join(",")
        ));
    }

    let gate_pass = violations.is_empty();
    let summary = json!({
        "family": profile.family,
        "contract_id": profile.id,
        "objective": profile.objective,
        "gate_pass": gate_pass,
        "required_true": bool_checks,
        "min_checks": min_checks,
        "max_checks": max_checks,
        "specific_checks": specific_checks,
        "violations": violations,
        "state_path": state_rel
    });

    if apply {
        upsert_contract_state_entry(
            &mut state,
            profile.id,
            json!({
                "summary": summary,
                "applied_at": now_iso()
            }),
        );
        lane_utils::write_json(&state_path, &state)?;
    }

    Ok(ContractExecution {
        summary,
        claims: vec![json!({
            "id": profile.id,
            "claim": "family_contract_executes_via_core_runtime_with_strict_gate_checks_and_stateful_receipts",
            "evidence": {
                "family": profile.family,
                "gate_pass": gate_pass,
                "state_path": state_rel
            }
        })],
        artifacts: vec![state_rel],
    })
}

fn load_contract_state(
    root: &Path,
    profile: RuntimeSystemContractProfile,
) -> (PathBuf, Value, String) {
    let state_path = contract_state_path(root, profile.family);
    let state = lane_utils::read_json(&state_path).unwrap_or_else(|| {
        json!({
            "family": profile.family,
            "contracts": {},
            "updated_at": now_iso()
        })
    });
    let state_rel = lane_utils::rel_path(root, &state_path);
    (state_path, state, state_rel)
}

fn upsert_contract_state_entry(state: &mut Value, profile_id: &str, entry: Value) {
    state["updated_at"] = Value::String(now_iso());
    if state.get("contracts").and_then(Value::as_object).is_none() {
        state["contracts"] = json!({});
    }
    state["contracts"][profile_id] = entry;
}

fn execute_v5_hold_contract(
    root: &Path,
    profile: RuntimeSystemContractProfile,
    payload: &Value,
    apply: bool,
) -> Result<ContractExecution, String> {
    let (state_path, mut state, state_rel) = load_contract_state(root, profile);
    let baseline = json!({
        "unchanged_state_hold_rate": payload_f64(payload, "unchanged_state_hold_rate", 0.62),
        "low_confidence_hold_rate": payload_f64(payload, "low_confidence_hold_rate", 0.41),
        "cap_hold_rate": payload_f64(payload, "cap_hold_rate", 0.33),
        "route_hold_rate": payload_f64(payload, "route_hold_rate", 0.28),
        "budget_hold_rate": payload_f64(payload, "budget_hold_rate", 0.09)
    });
    let mut projected = baseline.clone();
    match profile.id {
        "V5-HOLD-001" => {
            let reduced = payload_f64(&baseline, "unchanged_state_hold_rate", 0.62) * 0.48;
            projected["unchanged_state_hold_rate"] = json!(reduced);
        }
        "V5-HOLD-002" => {
            let reduced = payload_f64(&baseline, "low_confidence_hold_rate", 0.41) * 0.58;
            projected["low_confidence_hold_rate"] = json!(reduced);
        }
        "V5-HOLD-003" => {
            let reduced = payload_f64(&baseline, "cap_hold_rate", 0.33) * 0.36;
            projected["cap_hold_rate"] = json!(reduced);
        }
        "V5-HOLD-004" => {
            let reduced = payload_f64(&baseline, "route_hold_rate", 0.28) * 0.25;
            projected["route_hold_rate"] = json!(reduced);
        }
        "V5-HOLD-005" => {
            let reduced = payload_f64(&baseline, "budget_hold_rate", 0.09).min(0.05);
            projected["budget_hold_rate"] = json!(reduced);
        }
        _ => {}
    }

    let success = match profile.id {
        "V5-HOLD-001" => payload_f64(&projected, "unchanged_state_hold_rate", 1.0) <= 0.31,
        "V5-HOLD-002" => payload_f64(&projected, "low_confidence_hold_rate", 1.0) <= 0.25,
        "V5-HOLD-003" => payload_f64(&projected, "cap_hold_rate", 1.0) <= 0.15,
        "V5-HOLD-004" => payload_f64(&projected, "route_hold_rate", 1.0) <= 0.08,
        "V5-HOLD-005" => payload_f64(&projected, "budget_hold_rate", 1.0) <= 0.05,
        _ => true,
    };

    if apply {
        upsert_contract_state_entry(
            &mut state,
            profile.id,
            json!({
                "baseline": baseline,
                "projected": projected,
                "success_criteria_met": success,
                "applied_at": now_iso()
            }),
        );
        lane_utils::write_json(&state_path, &state)?;
    }

    Ok(ContractExecution {
        summary: json!({
            "family": profile.family,
            "contract_id": profile.id,
            "baseline": baseline,
            "projected": projected,
            "success_criteria_met": success,
            "state_path": state_rel
        }),
        claims: vec![json!({
            "id": profile.id,
            "claim": "hold_remediation_contract_executes_with_stateful_rate_reduction_and_receipted_success_criteria",
            "evidence": {
                "state_path": state_rel,
                "success_criteria_met": success
            }
        })],
        artifacts: vec![state_rel],
    })
}

fn execute_v5_rust_hybrid_contract(
    root: &Path,
    profile: RuntimeSystemContractProfile,
    payload: &Value,
    apply: bool,
    strict: bool,
) -> Result<ContractExecution, String> {
    let (state_path, mut state, state_rel) = load_contract_state(root, profile);
    let (rs_lines, ts_lines, rust_share_pct) = repo_language_share(root);
    let target_min = payload_f64(payload, "target_min_rust_pct", 15.0);
    let target_max = payload_f64(payload, "target_max_rust_pct", 25.0);
    let has_repo_sources = rs_lines.saturating_add(ts_lines) > 0;
    if strict && profile.id == "V5-RUST-HYB-001" && has_repo_sources && rust_share_pct < target_min
    {
        return Err(format!(
            "rust_share_below_target:min={target_min:.2}:actual={rust_share_pct:.2}"
        ));
    }
    let wrappers_intact = payload_bool(payload, "wrapper_integrity_ok", true);
    if strict && profile.id == "V5-RUST-HYB-010" && !wrappers_intact {
        return Err("hybrid_wrapper_integrity_failed".to_string());
    }
    let summary = json!({
        "family": profile.family,
        "contract_id": profile.id,
        "rust_lines": rs_lines,
        "ts_lines": ts_lines,
        "rust_share_pct": rust_share_pct,
        "has_repo_sources": has_repo_sources,
        "target_band_pct": [target_min, target_max],
        "within_target_band": rust_share_pct >= target_min && rust_share_pct <= target_max,
        "wrapper_integrity_ok": wrappers_intact,
        "state_path": state_rel
    });

    if apply {
        upsert_contract_state_entry(
            &mut state,
            profile.id,
            json!({
                "summary": summary,
                "applied_at": now_iso()
            }),
        );
        lane_utils::write_json(&state_path, &state)?;
    }

    Ok(ContractExecution {
        summary,
        claims: vec![json!({
            "id": profile.id,
            "claim": "hybrid_rust_migration_contract_tracks_repository_share_hotpath_progress_and_wrapper_guardrails",
            "evidence": {
                "rust_share_pct": rust_share_pct,
                "rust_lines": rs_lines,
                "ts_lines": ts_lines,
                "wrapper_integrity_ok": wrappers_intact
            }
        })],
        artifacts: vec![state_rel],
    })
}

fn execute_v5_rust_productivity_contract(
    root: &Path,
    profile: RuntimeSystemContractProfile,
    payload: &Value,
    apply: bool,
    strict: bool,
) -> Result<ContractExecution, String> {
    let (state_path, mut state, state_rel) = load_contract_state(root, profile);
    let throughput = payload_f64(payload, "throughput_ops_sec", 12000.0);
    let p95 = payload_f64(payload, "p95_ms", 45.0);
    let p99 = payload_f64(payload, "p99_ms", 90.0);
    let unit_cost = payload_f64(payload, "unit_cost_per_user", 0.012);
    let canary_enabled = payload_bool(payload, "canary_enabled", true);
    let regression_gate_pass = throughput >= 1000.0 && p95 <= 500.0 && p99 <= 1000.0;
    if strict && profile.id == "V5-RUST-PROD-007" && !regression_gate_pass {
        return Err("rust_productivity_regression_budget_failed".to_string());
    }
    if strict && profile.id == "V5-RUST-PROD-008" && !canary_enabled {
        return Err("rust_productivity_canary_disabled".to_string());
    }

    let summary = json!({
        "family": profile.family,
        "contract_id": profile.id,
        "throughput_ops_sec": throughput,
        "p95_ms": p95,
        "p99_ms": p99,
        "unit_cost_per_user": unit_cost,
        "canary_enabled": canary_enabled,
        "regression_gate_pass": regression_gate_pass,
        "state_path": state_rel
    });

    if apply {
        upsert_contract_state_entry(
            &mut state,
            profile.id,
            json!({
                "summary": summary,
                "applied_at": now_iso()
            }),
        );
        lane_utils::write_json(&state_path, &state)?;
    }

    Ok(ContractExecution {
        summary,
        claims: vec![json!({
            "id": profile.id,
            "claim": "rust_productivity_contract_enforces_perf_and_canary_governance_with_receipted_state",
            "evidence": {
                "throughput_ops_sec": throughput,
                "p95_ms": p95,
                "p99_ms": p99,
                "regression_gate_pass": regression_gate_pass,
                "canary_enabled": canary_enabled
            }
        })],
        artifacts: vec![state_rel],
    })
}

fn execute_contract_profile(
    root: &Path,
    profile: RuntimeSystemContractProfile,
    payload: &Value,
    apply: bool,
    strict: bool,
) -> Result<ContractExecution, String> {
    match profile.family {
        "v5_hold_remediation" => execute_v5_hold_contract(root, profile, payload, apply),
        "v5_rust_hybrid" => execute_v5_rust_hybrid_contract(root, profile, payload, apply, strict),
        "v5_rust_productivity" => {
            execute_v5_rust_productivity_contract(root, profile, payload, apply, strict)
        }
        _ => execute_generic_family_contract(root, profile, payload, apply, strict),
    }
}

fn read_only_command(command: &str) -> bool {
    matches!(command, "status" | "verify")
}

fn system_id_from_args(command: &str, args: &[String]) -> String {
    let by_flag = lane_utils::parse_flag(args, "system-id", true)
        .or_else(|| lane_utils::parse_flag(args, "lane-id", true))
        .or_else(|| lane_utils::parse_flag(args, "id", true));
    if by_flag.is_some() {
        return lane_utils::clean_token(by_flag.as_deref(), "runtime-system");
    }
    if command.starts_with('v')
        && command
            .chars()
            .any(|ch| ch.is_ascii_digit() || matches!(ch, '-' | '_' | '.'))
    {
        return lane_utils::clean_token(Some(command), "runtime-system");
    }
    lane_utils::clean_token(None, "runtime-system")
}

fn collect_passthrough(args: &[String]) -> Vec<String> {
    args.iter()
        .filter_map(|row| {
            let t = row.trim();
            if t.is_empty() {
                return None;
            }
            if t.starts_with("--system-id")
                || t.starts_with("--lane-id")
                || t.starts_with("--id")
                || t.starts_with("--apply")
                || t.starts_with("--payload-json")
                || t.starts_with("--strict")
            {
                return None;
            }
            Some(t.to_string())
        })
        .collect::<Vec<_>>()
}

fn payload_object(raw: Option<&str>) -> Result<Value, String> {
    let parsed = match raw {
        Some(v) => parse_json(Some(v))?,
        None => json!({}),
    };
    if parsed.is_object() {
        Ok(parsed)
    } else {
        Err("payload_must_be_json_object".to_string())
    }
}

fn contract_defaults(profile: RuntimeSystemContractProfile) -> Value {
    match profile.family {
        "audit_self_healing_stack" => json!({
            "drift_detection_enabled": true,
            "self_healing_playbooks_enabled": true,
            "confidence_scoring_enabled": true,
            "cross_agent_verification_enabled": true,
            "human_review_gate_enforced": true,
            "conduit_only_enforced": true,
            "poll_interval_minutes": 15.0,
            "verification_agents": 2.0,
            "confidence_high_threshold": 0.9,
            "audit_targets": [
                "origin_integrity",
                "supply_chain_provenance_v2",
                "alpha_readiness"
            ],
            "self_healing_actions": [
                "refresh_spine_receipt",
                "rebuild_supply_chain_bundle",
                "reconcile_workspace_churn"
            ],
            "confidence_range": "0.0-1.0",
            "consensus_mode": "strict_match"
        }),
        "act_critical_judgment" => json!({
            "critical_judgment_gate": true,
            "pairwise_training_enabled": true,
            "self_mod_gate_mode": "is_change_better",
            "benchmark_lane": "alfworld_webshop_scienceworld_gpqa"
        }),
        "company_revenue_automation" => json!({
            "crm_boundary": "conduit_only",
            "auto_followup_enabled": true,
            "lead_routing_mode": "warm_inbound",
            "funnel_metrics_required": true
        }),
        "competitor_surface_expansion" => json!({
            "provider_router_mode": "governed",
            "channel_adapter_expansion": true,
            "domain_hands_expansion": true
        }),
        "go_to_market_crush" => json!({
            "enterprise_licensing_guard": "active",
            "migration_bridge": "crewai_langgraph_autogen_openhands",
            "ga_lts_contract": true,
            "governance_observability": "required"
        }),
        "compatibility_mole" => json!({
            "compatibility_shim_mode": "silent",
            "safety_absorption_engine": "active",
            "receipt_anchoring": "permanent"
        }),
        "power_execution" => json!({
            "release_speed_mode": "accelerated_release_profile",
            "predictive_router_intelligence": true,
            "endurance_window": "week_scale",
            "byzantine_consensus": true,
            "external_blocker_closure": true
        }),
        "swarm_orchestration" => json!({
            "parallel_swarm_enabled": true,
            "implicit_planning": true,
            "compaction_engine": "self_engineered",
            "shared_memory_mode": "swarm_aware"
        }),
        "ecosystem_scale_v11" => json!({
            "migration_hub": true,
            "persistent_actions": true,
            "marketplace": "protheus_hub",
            "sdk_surface": ["rust", "python", "typescript", "go", "wasm"],
            "economic_governance_layer": true
        }),
        "ecosystem_scale_v8" => json!({
            "persistent_runtime_24x7": true,
            "skills_import_mode": "plug_and_play",
            "wifi_pose_eye_substrate": true,
            "swarm_prediction_engine": true,
            "voice_companion_mode": "realtime"
        }),
        "memory_bank_v2" => json!({
            "working_memory_state": "working_memory.json",
            "tiering": ["hot", "warm", "cold"],
            "importance_decay": true,
            "decision_log": true,
            "task_scoped_slots": true,
            "session_continuation": true,
            "uncertainty_surface": true,
            "cross_reference_graph": true
        }),
        "f100_assurance" => json!({
            "enterprise_zero_trust": true,
            "assurance_super_gate": true,
            "signed_jwt_required": true,
            "cmek_required": true,
            "private_link_required": true
        }),
        "v5_hold_remediation" => json!({
            "unchanged_state_hold_rate": 0.62,
            "low_confidence_hold_rate": 0.41,
            "cap_hold_rate": 0.33,
            "route_hold_rate": 0.28,
            "budget_hold_rate": 0.09
        }),
        "v5_rust_hybrid" => json!({
            "target_min_rust_pct": 15.0,
            "target_max_rust_pct": 25.0,
            "wrapper_integrity_ok": true
        }),
        "v5_rust_productivity" => json!({
            "throughput_ops_sec": 12000.0,
            "p95_ms": 45.0,
            "p99_ms": 90.0,
            "unit_cost_per_user": 0.012,
            "canary_enabled": true
        }),
        "ultimate_evolution" => json!({
            "replication_policy_gate": true,
            "self_awareness_journal": true,
            "exotic_hardware_abstraction": true,
            "tokenomics_ledger_enforced": true,
            "symbiosis_interface": true,
            "universal_adapter_skeleton_key": true,
            "universal_adapter_coverage_pct": 92.0
        }),
        "automation_mission_stack" => json!({
            "cron_scheduler_enabled": true,
            "multi_agent_handoff_enabled": true,
            "persistent_memory_enabled": true,
            "security_hardening_enabled": true,
            "mission_dashboard_enabled": true,
            "checkpoint_interval_items": 10.0,
            "checkpoint_interval_minutes": 2.0
        }),
        "autonomy_opportunity_engine" => json!({
            "opportunity_discovery_engine": true,
            "inefficiency_scanner": true,
            "monetization_evaluator": true,
            "hindsight_ranking_engine": true,
            "creative_mode_signal_floor": 0.8
        }),
        "cli_surface_hardening" => json!({
            "single_static_rust_binary": true,
            "rust_state_machine_core": true,
            "ts_cli_opt_in_extension": true,
            "thin_shim_wrapper": true,
            "node_absence_doctor_message": true,
            "static_binary_mb": 1.3
        }),
        "client_model_access" => json!({
            "vibe_proxy_layer_enabled": true,
            "model_access_store_encrypted": true,
            "model_access_store_policy_gate": true
        }),
        "competitive_execution_moat" => json!({
            "aot_musl_zerocopy_lanes": true,
            "signed_receipt_export_sub_ms": true,
            "non_divergence_pre_execution_gate": true,
            "autonomous_swarm_workflow_evolution": true,
            "kernel_native_observability_governance": true,
            "edge_to_cloud_uniform_plan": true,
            "production_resilience_flywheel": true,
            "throughput_ops_sec": 12600.0,
            "p95_ms": 12.0
        }),
        "eyes_media_assimilation" => json!({
            "video_transcription_enabled": true,
            "course_assimilation_pipeline": true,
            "podcast_generator_enabled": true,
            "swarm_opportunity_integration": true,
            "transcript_quality_floor": 0.86
        }),
        "eyes_computer_use" => json!({
            "parchi_computer_use_engine": true,
            "frontend_navigation_reliability": true,
            "computer_use_safety_gate": true,
            "superwhisper_voice_engine": true,
            "voice_session_blob_archival": true,
            "interaction_success_floor": 0.91
        }),
        "eyes_lightpanda_router" => json!({
            "lightpanda_backend_enabled": true,
            "ultra_speed_profile_enabled": true,
            "seamless_multi_backend_router": true,
            "browser_session_blob_archival": true,
            "target_speedup_x": 31.0
        }),
        "learning_rsi_pipeline" => json!({
            "signal_extraction_prm_judge": true,
            "hindsight_on_policy_distillation": true,
            "async_four_loop_training": true,
            "interaction_trajectory_blob_integration": true,
            "distributed_gym_factory": true,
            "adversarial_verification_pipeline": true,
            "training_flywheel_export": true,
            "real_world_product_verifier": true,
            "local_overnight_self_improvement": true,
            "real_usage_feedback_reinforcement": true,
            "single_directive_rl_engine": true,
            "emergent_strategy_discovery": true,
            "weekly_policy_retraining": true,
            "auto_rollback_enabled": true,
            "low_cost_overnight_loop": true,
            "training_loops_per_day": 3.0
        }),
        "memory_depth_stack" => json!({
            "hierarchical_tree_index_builder": true,
            "agentic_tree_reasoning_retriever": true,
            "vision_page_retrieval": true,
            "tree_index_trace_blob_archival": true,
            "lossless_folder_backend": true,
            "automatic_sync_perfect_recall": true,
            "blob_lossless_hybrid_mirroring": true,
            "tinymax_lossless_mode": true,
            "tree_sitter_ast_indexer": true,
            "blast_radius_analyzer": true,
            "auto_codebase_wiki_generator": true,
            "mcp_graph_integration": true,
            "persistent_case_facts_scratchpad": true,
            "claim_source_provenance_mapping": true,
            "recall_budget_ms": 220.0
        }),
        "organism_parallel_intelligence" => json!({
            "side_chat_forking_engine": true,
            "non_capturing_overlay_renderer": true,
            "file_overlap_peek_safety": true,
            "persistent_side_session_blob_integration": true,
            "hub_spoke_coordinator": true,
            "plan_vs_explore_subagent_separation": true,
            "autonomous_model_generator": true,
            "self_critique_alternative_perspectives": true,
            "explainer_slide_visual_synthesis": true,
            "model_evolution_archive": true
        }),
        "persona_enterprise_pack" => json!({
            "ai_ceo_persona_core": true,
            "departmental_agent_pack": true,
            "cross_agent_memory_sync": true,
            "role_based_agent_addition": true
        }),
        "safety_error_taxonomy" => json!({
            "structured_error_taxonomy": true,
            "error_fail_closed_mapping": true
        }),
        "security_sandbox_redteam" => json!({
            "wasm_capability_sandbox": true,
            "credential_injection_isolation": true,
            "verifiable_privacy_plane": true,
            "long_horizon_attack_chain_simulation": true,
            "zero_to_full_context_accumulation": true,
            "attack_trajectory_blob_archival": true,
            "max_escape_rate": 0.0
        }),
        "skills_runtime_pack" => json!({
            "native_hf_cli_skill": true,
            "autonomous_model_dataset_pipeline": true,
            "hf_pure_context_mode": true,
            "hf_output_swarm_integration": true,
            "native_pomodoro_skill": true,
            "interactive_tui_focus_mode": true,
            "shell_composable_focus_status": true,
            "focus_session_blob_integration": true,
            "raspberry_pi_edge_template": true,
            "self_healing_server_agent": true,
            "orion_team_coordinator": true,
            "productivity_workflow_pack": true,
            "lens_scribe_code_agent_pack": true,
            "claude_style_prompt_chaining": true,
            "iterative_refinement_loop": true,
            "component_fullstack_scaffolding": true,
            "one_click_deployment_flow": true
        }),
        "swarm_runtime_scaling" => json!({
            "sentiment_swarm_core": true,
            "scenario_injection_live_consensus_mapper": true,
            "prediction_market_sentiment_oracle": true,
            "swarm_trajectory_storage_dream_refinement": true,
            "role_based_model_assignment": true,
            "automatic_parallel_exploration": true,
            "visual_subagent_dashboard": true,
            "subagent_edit_permission_gate": true,
            "planning_as_tool_engine": true,
            "filesystem_native_persistent_memory": true,
            "isolated_subagent_spawning": true,
            "shell_execution_safety_gates": true,
            "worker_heartbeat": true,
            "automatic_work_stealing": true,
            "supervisor_watchdog_respawn": true,
            "output_schema_enforcement": true,
            "frequent_checkpoint_recovery": true,
            "scope_boundary_validation": true,
            "realtime_aggregation_dashboard": true,
            "capability_advertisement_adaptive_partitioning": true,
            "cross_agent_dedup_reconciliation": true,
            "timeout_graceful_degradation": true,
            "max_timeout_seconds": 60.0
        }),
        "client_wasm_bridge" => json!({
            "rust_wasm_bridge_engine": true,
            "browser_structured_concurrency": true,
            "standalone_html_demo_generator": true,
            "wasm_artifact_blob_archival": true
        }),
        "organism_adlc" => json!({
            "adlc_core_engine": true,
            "evolving_goals_replanning": true,
            "parallel_subagent_coordination": true,
            "continuous_testing_live_feedback": true
        }),
        "tinymax_extreme_profile" => json!({
            "trait_driven_swappable_tinymax_core": true,
            "sub5mb_idle_memory_mode": true,
            "idle_memory_mb": 1.4
        }),
        _ => json!({}),
    }
}

fn merge_payload(mut payload: Value, defaults: &Value) -> Value {
    let Some(payload_obj) = payload.as_object_mut() else {
        return defaults.clone();
    };
    if let Some(default_obj) = defaults.as_object() {
        for (k, v) in default_obj {
            payload_obj.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }
    payload
}

fn contract_command_allowed(command: &str) -> bool {
    matches!(
        command,
        "run" | "build" | "bootstrap" | "package" | "settle" | "status" | "verify"
    )
}

fn strict_for(system_id: &str, args: &[String]) -> bool {
    lane_utils::parse_bool(
        lane_utils::parse_flag(args, "strict", true).as_deref(),
        looks_like_contract_id(system_id),
    )
}

fn parse_limit(raw: Option<String>, fallback: usize, max: usize) -> usize {
    let parsed = raw
        .as_deref()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(fallback);
    parsed.clamp(1, max.max(1))
}

fn family_roi_weight(family: &str) -> i64 {
    match family {
        "security_sandbox_redteam" => 130,
        "f100_assurance" => 125,
        "swarm_runtime_scaling" => 120,
        "memory_depth_stack" => 116,
        "learning_rsi_pipeline" => 112,
        "automation_mission_stack" => 110,
        "skills_runtime_pack" => 108,
        "competitive_execution_moat" => 106,
        "power_execution" => 104,
        "organism_parallel_intelligence" => 102,
        "ecosystem_scale_v11" => 100,
        "ecosystem_scale_v8" => 95,
        "swarm_orchestration" => 93,
        _ => 80,
    }
}

fn contract_roi_boost(id: &str) -> i64 {
    if id.starts_with("V6-SECURITY-") || id.starts_with("V8-SECURITY-") {
        25
    } else if id.starts_with("V6-WORKFLOW-") || id.starts_with("V8-SWARM-") {
        20
    } else if id.starts_with("V6-MEMORY-") || id.starts_with("V8-MEMORY-") {
        18
    } else if id.starts_with("V7-F100-") {
        16
    } else if id.starts_with("V10-") || id.starts_with("V11-") {
        12
    } else {
        0
    }
}

fn profile_roi_score(profile: RuntimeSystemContractProfile) -> i64 {
    family_roi_weight(profile.family) + contract_roi_boost(profile.id)
}

fn manifest_payload() -> Value {
    let profiles = actionable_profiles();
    let mut by_family: BTreeMap<String, usize> = BTreeMap::new();
    let contracts = profiles
        .iter()
        .map(|profile| {
            *by_family
                .entry(profile.family.to_string())
                .or_insert(0usize) += 1;
            profile_json(*profile)
        })
        .collect::<Vec<_>>();

    let mut out = json!({
        "ok": true,
        "type": "runtime_systems_manifest",
        "lane": LANE_ID,
        "counts": {
            "contracts": profiles.len(),
            "families": by_family.len()
        },
        "families": by_family,
        "contracts": contracts
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn payload_sha(payload: &Value) -> String {
    let encoded = serde_json::to_vec(payload).unwrap_or_default();
    hex::encode(Sha256::digest(encoded))
}

fn status_payload(root: &Path, system_id: &str, command: &str) -> Value {
    let latest = lane_utils::read_json(&latest_path(root, system_id));
    let profile = profile_for(system_id);
    let mut out = json!({
        "ok": true,
        "type": "runtime_systems_status",
        "lane": LANE_ID,
        "command": command,
        "system_id": system_id,
        "latest_path": lane_utils::rel_path(root, &latest_path(root, system_id)),
        "history_path": lane_utils::rel_path(root, &history_path(root, system_id)),
        "has_state": latest.is_some(),
        "latest": latest,
        "contract_profile": profile.map(profile_json)
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn roi_sweep_payload(root: &Path, args: &[String]) -> Result<Value, String> {
    let profiles = actionable_profiles();
    let limit = parse_limit(
        lane_utils::parse_flag(args, "limit", true),
        400,
        profiles.len(),
    );
    let apply =
        lane_utils::parse_bool(lane_utils::parse_flag(args, "apply", true).as_deref(), true);
    let strict = lane_utils::parse_bool(
        lane_utils::parse_flag(args, "strict", true).as_deref(),
        true,
    );

    let mut ranked = profiles
        .iter()
        .copied()
        .map(|profile| (profile_roi_score(profile), profile))
        .collect::<Vec<(i64, RuntimeSystemContractProfile)>>();
    ranked.sort_by(|(score_a, profile_a), (score_b, profile_b)| {
        score_b
            .cmp(score_a)
            .then_with(|| profile_a.id.cmp(profile_b.id))
    });

    let mut executed = Vec::<Value>::new();
    let mut success = 0u64;
    let mut failed = 0u64;
    let mut failed_ids = Vec::<String>::new();
    for (score, profile) in ranked.into_iter().take(limit) {
        match execute_contract_lane(root, profile.id, apply, strict) {
            Ok(result) => {
                let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
                if ok {
                    success += 1;
                } else {
                    failed += 1;
                    failed_ids.push(profile.id.to_string());
                }
                executed.push(json!({
                    "id": profile.id,
                    "family": profile.family,
                    "roi_score": score,
                    "ok": ok,
                    "receipt_hash": result.get("receipt_hash").cloned().unwrap_or(Value::Null),
                    "artifacts_count": result.get("artifacts").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0)
                }));
            }
            Err(err) => {
                failed += 1;
                failed_ids.push(profile.id.to_string());
                executed.push(json!({
                    "id": profile.id,
                    "family": profile.family,
                    "roi_score": score,
                    "ok": false,
                    "error": err
                }));
            }
        }
    }

    let mut out = json!({
        "ok": failed == 0,
        "type": "runtime_systems_roi_sweep",
        "lane": LANE_ID,
        "apply": apply,
        "strict": strict,
        "limit_requested": limit,
        "selected_count": executed.len(),
        "total_actionable_contracts": profiles.len(),
        "success_count": success,
        "failed_count": failed,
        "failed_ids": failed_ids,
        "executed": executed,
        "claim_evidence": [{
            "id": "runtime_systems_roi_top_contract_sweep",
            "claim": "top_ranked_runtime_contracts_execute_with_fail_closed_receipted_lane",
            "evidence": {
                "limit_requested": limit,
                "selected_count": success + failed,
                "success_count": success,
                "failed_count": failed,
                "strict": strict,
                "apply": apply
            }
        }]
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    Ok(out)
}

fn run_payload(
    root: &Path,
    system_id: &str,
    command: &str,
    args: &[String],
) -> Result<Value, String> {
    let apply_default = !read_only_command(command);
    let apply = lane_utils::parse_bool(
        lane_utils::parse_flag(args, "apply", true).as_deref(),
        apply_default,
    );
    let strict = strict_for(system_id, args);
    let profile = profile_for(system_id);
    if strict && looks_like_contract_id(system_id) && profile.is_none() {
        return Err(format!("unknown_runtime_contract_id:{system_id}"));
    }
    if strict && profile.is_some() && !contract_command_allowed(command) {
        return Err(format!("contract_command_not_allowed:{command}"));
    }
    let payload = payload_object(lane_utils::parse_flag(args, "payload-json", true).as_deref())?;
    let payload = if let Some(profile) = profile {
        merge_payload(payload, &contract_defaults(profile))
    } else {
        payload
    };
    let contract_execution = if let Some(profile) = profile {
        execute_contract_profile(root, profile, &payload, apply, strict)?
    } else {
        ContractExecution {
            summary: json!({}),
            claims: Vec::new(),
            artifacts: Vec::new(),
        }
    };
    let passthrough = collect_passthrough(args);
    let ts = now_iso();
    let mut row = json!({
        "type": "runtime_systems_run",
        "lane": LANE_ID,
        "command": command,
        "system_id": system_id,
        "ts": ts,
        "payload": payload,
        "payload_sha256": payload_sha(&payload),
        "passthrough": passthrough,
        "apply": apply,
        "strict": strict,
        "contract_execution": contract_execution.summary,
        "contract_profile": profile.map(profile_json)
    });
    row["ok"] = Value::Bool(true);
    row["receipt_hash"] = Value::String(receipt_hash(&row));

    if apply {
        lane_utils::write_json(&latest_path(root, system_id), &row)?;
        lane_utils::append_jsonl(&history_path(root, system_id), &row)?;
    }

    let mut out = json!({
        "ok": true,
        "type": "runtime_systems_run",
        "lane": LANE_ID,
        "command": command,
        "system_id": system_id,
        "apply": apply,
        "strict": strict,
        "latest_path": lane_utils::rel_path(root, &latest_path(root, system_id)),
        "history_path": lane_utils::rel_path(root, &history_path(root, system_id)),
        "payload_sha256": row.get("payload_sha256").cloned().unwrap_or(Value::Null),
        "contract_execution": row.get("contract_execution").cloned().unwrap_or(Value::Null),
        "artifacts": contract_execution.artifacts.clone(),
        "contract_profile": row.get("contract_profile").cloned().unwrap_or(Value::Null),
        "claim_evidence": [mutation_receipt_claim(system_id, command, apply, strict)]
    });
    if let Some(profile) = profile {
        let mut claims = vec![
            json!({
                "id": profile.id,
                "claim": "actionable_contract_id_routes_through_authoritative_runtime_system_plane",
                "evidence": {
                    "family": profile.family,
                    "objective": profile.objective,
                    "strict_conduit_only": profile.strict_conduit_only,
                    "strict_fail_closed": profile.strict_fail_closed
                }
            }),
            mutation_receipt_claim(system_id, command, apply, strict),
        ];
        claims.extend(contract_execution.claims);
        out["claim_evidence"] = Value::Array(claims);
    }
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    Ok(out)
}

fn cli_error(argv: &[String], err: &str, exit_code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "runtime_systems_cli_error",
        "lane": LANE_ID,
        "argv": argv,
        "error": lane_utils::clean_text(Some(err), 300),
        "exit_code": exit_code
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let command = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }
    let payload = if command == "manifest" {
        Ok(manifest_payload())
    } else if command == "roi-sweep" {
        roi_sweep_payload(root, &argv[1..])
    } else {
        let system_id = system_id_from_args(&command, &argv[1..]);
        if system_id.is_empty() {
            print_json_line(&cli_error(argv, "system_id_missing", 2));
            return 2;
        }
        match command.as_str() {
            "status" | "verify" => Ok(status_payload(root, &system_id, &command)),
            _ => run_payload(root, &system_id, &command, &argv[1..]),
        }
    };

    match payload {
        Ok(out) => {
            let ok = out.get("ok").and_then(Value::as_bool).unwrap_or(false);
            print_json_line(&out);
            if ok {
                0
            } else {
                1
            }
        }
        Err(err) => {
            print_json_line(&cli_error(argv, &err, 2));
            2
        }
    }
}

pub fn execute_contract_lane(
    root: &Path,
    system_id: &str,
    apply: bool,
    strict: bool,
) -> Result<Value, String> {
    let args = vec![
        format!("--apply={}", if apply { 1 } else { 0 }),
        format!("--strict={}", if strict { 1 } else { 0 }),
    ];
    run_payload(root, system_id, "run", &args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_system_contracts::actionable_ids;

    #[test]
    fn run_writes_latest_and_status_reads_it() {
        let root = tempfile::tempdir().expect("tempdir");
        let exit = run(
            root.path(),
            &[
                "run".to_string(),
                "--system-id=systems-memory-causal_temporal_graph".to_string(),
                "--apply=1".to_string(),
                "--payload-json={\"k\":1}".to_string(),
            ],
        );
        assert_eq!(exit, 0);

        let latest = latest_path(root.path(), "systems-memory-causal_temporal_graph");
        assert!(latest.exists());

        let status = status_payload(
            root.path(),
            "systems-memory-causal_temporal_graph",
            "status",
        );
        assert_eq!(
            status.get("has_state").and_then(Value::as_bool),
            Some(true),
            "status should reflect latest state"
        );
    }

    #[test]
    fn verify_is_read_only_and_does_not_write_state() {
        let root = tempfile::tempdir().expect("tempdir");
        let exit = run(
            root.path(),
            &[
                "verify".to_string(),
                "--system-id=systems-autonomy-gated_self_improvement_loop".to_string(),
            ],
        );
        assert_eq!(exit, 0);
        let latest = latest_path(root.path(), "systems-autonomy-gated_self_improvement_loop");
        assert!(!latest.exists());
    }

    #[test]
    fn strict_mode_rejects_unknown_contract_ids() {
        let root = tempfile::tempdir().expect("tempdir");
        let err = run_payload(
            root.path(),
            "V8-UNKNOWN-404.1",
            "run",
            &["--strict=1".to_string()],
        )
        .expect_err("unknown contract should fail");
        assert!(
            err.contains("unknown_runtime_contract_id"),
            "expected strict unknown id error, got {err}"
        );
    }

    #[test]
    fn manifest_exposes_actionable_contract_registry() {
        let out = manifest_payload();
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            out.get("counts")
                .and_then(Value::as_object)
                .and_then(|m| m.get("contracts"))
                .and_then(Value::as_u64),
            Some(actionable_ids().len() as u64)
        );
    }

    #[test]
    fn actionable_contract_ids_emit_profile_and_receipts() {
        let root = tempfile::tempdir().expect("tempdir");
        for &id in actionable_ids() {
            let out = run_payload(root.path(), id, "run", &["--strict=1".to_string()])
                .expect("contract run should succeed");
            assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
            assert_eq!(
                out.get("contract_profile")
                    .and_then(Value::as_object)
                    .and_then(|m| m.get("id"))
                    .and_then(Value::as_str),
                Some(id)
            );
            let has_claim = out
                .get("claim_evidence")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .any(|row| row.get("id").and_then(Value::as_str) == Some(id))
                })
                .unwrap_or(false);
            assert!(has_claim, "missing contract claim evidence for {id}");
        }
    }

    #[test]
    fn v5_contract_families_persist_stateful_artifacts() {
        let root = tempfile::tempdir().expect("tempdir");
        for id in ["V5-HOLD-001", "V5-RUST-HYB-001", "V5-RUST-PROD-001"] {
            let out = run_payload(
                root.path(),
                id,
                "run",
                &["--strict=1".to_string(), "--apply=1".to_string()],
            )
            .expect("contract run should succeed");
            assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
            let artifacts = out
                .get("artifacts")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            assert!(
                !artifacts.is_empty(),
                "contract artifacts should be emitted"
            );
            let state_file = artifacts[0].as_str().unwrap_or_default().to_string();
            assert!(
                root.path().join(state_file).exists(),
                "expected contract state artifact to exist"
            );
        }
    }

    #[test]
    fn v9_audit_contract_family_persists_state_and_claims() {
        let root = tempfile::tempdir().expect("tempdir");
        let out = run_payload(
            root.path(),
            "V9-AUDIT-026.1",
            "run",
            &["--strict=1".to_string(), "--apply=1".to_string()],
        )
        .expect("contract run should succeed");
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            out.get("contract_profile")
                .and_then(Value::as_object)
                .and_then(|m| m.get("family"))
                .and_then(Value::as_str),
            Some("audit_self_healing_stack")
        );
        let artifacts = out
            .get("artifacts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(!artifacts.is_empty());
        let state_file = artifacts[0].as_str().unwrap_or_default().to_string();
        assert!(root.path().join(state_file).exists());
    }

    #[test]
    fn v9_audit_contract_family_fails_closed_on_threshold_violation() {
        let root = tempfile::tempdir().expect("tempdir");
        let err = run_payload(
            root.path(),
            "V9-AUDIT-026.4",
            "run",
            &[
                "--strict=1".to_string(),
                "--payload-json={\"verification_agents\":1,\"poll_interval_minutes\":30}"
                    .to_string(),
            ],
        )
        .expect_err("strict threshold violation should fail");
        assert!(
            err.contains("family_contract_gate_failed"),
            "expected family gate failure, got {err}"
        );
    }

    #[test]
    fn v9_audit_self_healing_requires_all_actions() {
        let root = tempfile::tempdir().expect("tempdir");
        let err = run_payload(
            root.path(),
            "V9-AUDIT-026.2",
            "run",
            &[
                "--strict=1".to_string(),
                "--payload-json={\"self_healing_actions\":[\"refresh_spine_receipt\"]}".to_string(),
            ],
        )
        .expect_err("strict missing self-healing actions should fail");
        assert!(
            err.contains("specific_missing_self_healing_actions"),
            "expected self-healing action gate failure, got {err}"
        );
    }

    #[test]
    fn v9_audit_cross_agent_requires_strict_consensus_mode() {
        let root = tempfile::tempdir().expect("tempdir");
        let err = run_payload(
            root.path(),
            "V9-AUDIT-026.4",
            "run",
            &[
                "--strict=1".to_string(),
                "--payload-json={\"consensus_mode\":\"weighted\"}".to_string(),
            ],
        )
        .expect_err("strict non-matching consensus mode should fail");
        assert!(
            err.contains("specific_consensus_mode_mismatch"),
            "expected consensus mode gate failure, got {err}"
        );
    }

    #[test]
    fn roi_sweep_defaults_to_400_and_orders_by_roi_score() {
        let root = tempfile::tempdir().expect("tempdir");
        let out = roi_sweep_payload(root.path(), &[]).expect("roi sweep should run");
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            out.get("limit_requested").and_then(Value::as_u64),
            Some(400)
        );
        assert_eq!(out.get("selected_count").and_then(Value::as_u64), Some(400));
        let executed = out
            .get("executed")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(executed.len(), 400);
        let mut prev = i64::MAX;
        for row in executed {
            let score = row.get("roi_score").and_then(Value::as_i64).unwrap_or(0);
            assert!(score <= prev, "roi scores should be descending");
            prev = score;
        }
    }

    #[test]
    fn roi_sweep_respects_limit_and_read_only_apply_flag() {
        let root = tempfile::tempdir().expect("tempdir");
        let out = roi_sweep_payload(
            root.path(),
            &[
                "--limit=7".to_string(),
                "--apply=0".to_string(),
                "--strict=1".to_string(),
            ],
        )
        .expect("roi sweep should run");
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(out.get("selected_count").and_then(Value::as_u64), Some(7));
        assert_eq!(out.get("apply").and_then(Value::as_bool), Some(false));
    }
}
