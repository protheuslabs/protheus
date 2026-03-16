// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::runtime_system_contracts (authoritative)
use std::collections::BTreeMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeSystemContractProfile {
    pub id: &'static str,
    pub family: &'static str,
    pub objective: &'static str,
    pub strict_conduit_only: bool,
    pub strict_fail_closed: bool,
}

#[derive(Debug, Clone, Copy)]
struct RuntimeSystemContractFamily {
    ids: &'static [&'static str],
    family: &'static str,
    objective: &'static str,
}

const NEW_ACTIONABLE_IDS: &[&str] = &[
    "V9-AUDIT-026.1",
    "V9-AUDIT-026.2",
    "V9-AUDIT-026.3",
    "V9-AUDIT-026.4",
    "V10-ULTIMATE-001.1",
    "V10-ULTIMATE-001.2",
    "V10-ULTIMATE-001.3",
    "V10-ULTIMATE-001.4",
    "V10-ULTIMATE-001.5",
    "V10-ULTIMATE-001.6",
    "V8-AUTOMATION-016.1",
    "V8-AUTOMATION-016.2",
    "V8-AUTOMATION-016.3",
    "V8-AUTOMATION-016.4",
    "V8-AUTOMATION-016.5",
    "V8-AUTONOMY-012.1",
    "V8-AUTONOMY-012.2",
    "V8-AUTONOMY-012.3",
    "V8-AUTONOMY-012.4",
    "V8-CLI-001.1",
    "V8-CLI-001.2",
    "V8-CLI-001.3",
    "V8-CLI-001.4",
    "V8-CLI-001.5",
    "V8-CLIENT-010.3",
    "V8-CLIENT-010.4",
    "V8-COMPETE-001.1",
    "V8-COMPETE-001.10",
    "V8-COMPETE-001.2",
    "V8-COMPETE-001.3",
    "V8-COMPETE-001.4",
    "V8-COMPETE-001.5",
    "V8-COMPETE-001.6",
    "V8-COMPETE-001.7",
    "V8-COMPETE-001.8",
    "V8-COMPETE-001.9",
    "V8-EYES-009.1",
    "V8-EYES-009.2",
    "V8-EYES-009.3",
    "V8-EYES-009.4",
    "V8-EYES-010.1",
    "V8-EYES-010.2",
    "V8-EYES-010.3",
    "V8-EYES-010.4",
    "V8-EYES-010.5",
    "V8-EYES-011.1",
    "V8-EYES-011.2",
    "V8-EYES-011.3",
    "V8-EYES-011.4",
    "V8-LEARNING-004.1",
    "V8-LEARNING-004.2",
    "V8-LEARNING-004.3",
    "V8-LEARNING-004.4",
    "V8-LEARNING-005.1",
    "V8-LEARNING-005.2",
    "V8-LEARNING-005.3",
    "V8-LEARNING-005.4",
    "V8-LEARNING-006.1",
    "V8-LEARNING-006.2",
    "V8-LEARNING-006.3",
    "V8-LEARNING-008.1",
    "V8-LEARNING-008.2",
    "V8-LEARNING-008.3",
    "V8-LEARNING-008.4",
    "V8-MEMORY-017.1",
    "V8-MEMORY-017.2",
    "V8-MEMORY-017.3",
    "V8-MEMORY-017.4",
    "V8-MEMORY-018.1",
    "V8-MEMORY-018.2",
    "V8-MEMORY-018.3",
    "V8-MEMORY-018.4",
    "V8-MEMORY-019.1",
    "V8-MEMORY-019.2",
    "V8-MEMORY-019.3",
    "V8-MEMORY-019.4",
    "V8-MEMORY-022.4",
    "V8-MEMORY-022.5",
    "V8-ORGANISM-015.1",
    "V8-ORGANISM-015.2",
    "V8-ORGANISM-015.3",
    "V8-ORGANISM-015.4",
    "V8-ORGANISM-022.1",
    "V8-ORGANISM-022.3",
    "V8-ORGANISM-023.1",
    "V8-ORGANISM-023.2",
    "V8-ORGANISM-023.3",
    "V8-ORGANISM-023.4",
    "V8-PERSONA-015.1",
    "V8-PERSONA-015.2",
    "V8-PERSONA-015.3",
    "V8-PERSONA-015.4",
    "V8-SAFETY-022.2",
    "V8-SECURITY-020.1",
    "V8-SECURITY-020.2",
    "V8-SECURITY-020.3",
    "V8-SECURITY-024.1",
    "V8-SECURITY-024.2",
    "V8-SECURITY-024.3",
    "V8-SKILLS-011.1",
    "V8-SKILLS-011.2",
    "V8-SKILLS-011.3",
    "V8-SKILLS-011.4",
    "V8-SKILLS-012.1",
    "V8-SKILLS-012.2",
    "V8-SKILLS-012.3",
    "V8-SKILLS-012.4",
    "V8-SKILLS-013.1",
    "V8-SKILLS-013.2",
    "V8-SKILLS-013.3",
    "V8-SKILLS-013.4",
    "V8-SKILLS-013.5",
    "V8-SKILLS-014.1",
    "V8-SKILLS-014.2",
    "V8-SKILLS-014.3",
    "V8-SKILLS-014.4",
    "V8-SWARM-009.1",
    "V8-SWARM-009.2",
    "V8-SWARM-009.3",
    "V8-SWARM-009.4",
    "V8-SWARM-010.1",
    "V8-SWARM-010.2",
    "V8-SWARM-010.3",
    "V8-SWARM-010.4",
    "V8-SWARM-011.1",
    "V8-SWARM-011.2",
    "V8-SWARM-011.3",
    "V8-SWARM-011.4",
    "V8-SWARM-012.1",
    "V8-SWARM-012.10",
    "V8-SWARM-012.2",
    "V8-SWARM-012.3",
    "V8-SWARM-012.4",
    "V8-SWARM-012.5",
    "V8-SWARM-012.6",
    "V8-SWARM-012.7",
    "V8-SWARM-012.8",
    "V8-SWARM-012.9",
    "V9-CLIENT-020.1",
    "V9-CLIENT-020.2",
    "V9-CLIENT-020.3",
    "V9-CLIENT-020.4",
    "V9-ORGANISM-025.1",
    "V9-ORGANISM-025.2",
    "V9-ORGANISM-025.3",
    "V9-ORGANISM-025.4",
    "V9-TINYMAX-021.1",
    "V9-TINYMAX-021.2",
];

const ACT_IDS: &[&str] = &[
    "V8-ACT-001.1",
    "V8-ACT-001.2",
    "V8-ACT-001.3",
    "V8-ACT-001.4",
    "V8-ACT-001.5",
];

const COMPANY_IDS: &[&str] = &[
    "V6-COMPANY-002.1",
    "V6-COMPANY-002.2",
    "V6-COMPANY-002.3",
    "V6-COMPANY-002.4",
    "V6-COMPANY-002.5",
    "V6-COMPANY-003.1",
    "V6-COMPANY-003.2",
    "V6-COMPANY-003.3",
    "V6-COMPANY-003.4",
    "V6-COMPANY-003.5",
];

const COMPETITOR_IDS: &[&str] = &[
    "V10-COMPETITOR-001.1",
    "V10-COMPETITOR-001.2",
    "V10-COMPETITOR-001.3",
    "V10-COMPETITOR-001.4",
    "V10-COMPETITOR-001.5",
];

const CRUSH_IDS: &[&str] = &[
    "V10-CRUSH-001.1",
    "V10-CRUSH-001.2",
    "V10-CRUSH-001.3",
    "V10-CRUSH-001.4",
    "V10-CRUSH-001.5",
    "V10-CRUSH-001.6",
    "V10-CRUSH-001.7",
    "V10-CRUSH-001.8",
];

const MOLE_IDS: &[&str] = &[
    "V11-MOLE-001.1",
    "V11-MOLE-001.2",
    "V11-MOLE-001.3",
    "V11-MOLE-001.4",
];

const POWER_IDS: &[&str] = &[
    "V10-POWER-001.1",
    "V10-POWER-001.2",
    "V10-POWER-001.3",
    "V10-POWER-001.4",
    "V10-POWER-001.5",
    "V10-POWER-001.6",
];

const SWARM_IDS: &[&str] = &[
    "V8-SWARM-002.1",
    "V8-SWARM-002.2",
    "V8-SWARM-002.3",
    "V8-SWARM-002.4",
    "V8-SWARM-002.5",
];

const ECOSYSTEM_V11_IDS: &[&str] = &[
    "V11-ECOSYSTEM-001.1",
    "V11-ECOSYSTEM-001.2",
    "V11-ECOSYSTEM-001.3",
    "V11-ECOSYSTEM-001.4",
    "V11-ECOSYSTEM-001.5",
    "V11-ECOSYSTEM-001.6",
    "V11-ECOSYSTEM-001.7",
];

const ECOSYSTEM_V8_IDS: &[&str] = &[
    "V8-ECOSYSTEM-001.1",
    "V8-ECOSYSTEM-001.2",
    "V8-ECOSYSTEM-001.3",
    "V8-ECOSYSTEM-001.4",
    "V8-ECOSYSTEM-001.5",
    "V8-ECOSYSTEM-001.6",
    "V8-ECOSYSTEM-001.7",
    "V8-ECOSYSTEM-001.8",
];

const MEMORY_BANK_IDS: &[&str] = &[
    "V8-MEMORY-BANK-002.1",
    "V8-MEMORY-BANK-002.2",
    "V8-MEMORY-BANK-002.3",
    "V8-MEMORY-BANK-002.4",
    "V8-MEMORY-BANK-002.5",
    "V8-MEMORY-BANK-002.6",
    "V8-MEMORY-BANK-002.7",
    "V8-MEMORY-BANK-002.8",
];

const F100_IDS: &[&str] = &["V7-F100-002.3", "V7-F100-002.7"];

const V5_HOLD_IDS: &[&str] = &[
    "V5-HOLD-001",
    "V5-HOLD-002",
    "V5-HOLD-003",
    "V5-HOLD-004",
    "V5-HOLD-005",
];

const V5_RUST_HYB_IDS: &[&str] = &[
    "V5-RUST-HYB-001",
    "V5-RUST-HYB-002",
    "V5-RUST-HYB-003",
    "V5-RUST-HYB-004",
    "V5-RUST-HYB-005",
    "V5-RUST-HYB-006",
    "V5-RUST-HYB-007",
    "V5-RUST-HYB-008",
    "V5-RUST-HYB-009",
    "V5-RUST-HYB-010",
];

const V5_RUST_PROD_IDS: &[&str] = &[
    "V5-RUST-PROD-001",
    "V5-RUST-PROD-002",
    "V5-RUST-PROD-003",
    "V5-RUST-PROD-004",
    "V5-RUST-PROD-005",
    "V5-RUST-PROD-006",
    "V5-RUST-PROD-007",
    "V5-RUST-PROD-008",
    "V5-RUST-PROD-009",
    "V5-RUST-PROD-010",
    "V5-RUST-PROD-011",
    "V5-RUST-PROD-012",
];

const CONTRACT_FAMILIES: &[RuntimeSystemContractFamily] = &[
    RuntimeSystemContractFamily {
        ids: ACT_IDS,
        family: "act_critical_judgment",
        objective: "pairwise_critical_judgment_and_self_modification_gate",
    },
    RuntimeSystemContractFamily {
        ids: COMPANY_IDS,
        family: "company_revenue_automation",
        objective: "crm_and_growth_automation_with_conduit_only_boundaries",
    },
    RuntimeSystemContractFamily {
        ids: COMPETITOR_IDS,
        family: "competitor_surface_expansion",
        objective: "provider_adapter_and_domain_hand_expansion_with_production_controls",
    },
    RuntimeSystemContractFamily {
        ids: CRUSH_IDS,
        family: "go_to_market_crush",
        objective: "enterprise_grade_distribution_migration_and_governance_flywheel",
    },
    RuntimeSystemContractFamily {
        ids: MOLE_IDS,
        family: "compatibility_mole",
        objective: "silent_protocol_compatibility_and_import_safety_absorption",
    },
    RuntimeSystemContractFamily {
        ids: POWER_IDS,
        family: "power_execution",
        objective: "release_speed_predictive_router_endurance_and_blocker_closure",
    },
    RuntimeSystemContractFamily {
        ids: SWARM_IDS,
        family: "swarm_orchestration",
        objective: "parallel_swarm_planning_and_shared_memory_under_conduit_enforcement",
    },
    RuntimeSystemContractFamily {
        ids: ECOSYSTEM_V11_IDS,
        family: "ecosystem_scale_v11",
        objective: "adoption_hub_marketplace_sdk_and_governance_economy",
    },
    RuntimeSystemContractFamily {
        ids: ECOSYSTEM_V8_IDS,
        family: "ecosystem_scale_v8",
        objective: "always_on_runtime_skills_import_and_realtime_companion_capabilities",
    },
    RuntimeSystemContractFamily {
        ids: MEMORY_BANK_IDS,
        family: "memory_bank_v2",
        objective: "multi_tier_memory_bank_with_decay_cross_reference_and_session_continuation",
    },
    RuntimeSystemContractFamily {
        ids: F100_IDS,
        family: "f100_assurance",
        objective: "zero_trust_enterprise_profile_and_super_gate_assurance_enforcement",
    },
    RuntimeSystemContractFamily {
        ids: V5_HOLD_IDS,
        family: "v5_hold_remediation",
        objective: "hold_category_reduction_with_fail_closed_routeability_and_budget_controls",
    },
    RuntimeSystemContractFamily {
        ids: V5_RUST_HYB_IDS,
        family: "v5_rust_hybrid",
        objective: "bounded_hybrid_rust_migration_with_hotpath_cutovers_and_guardrails",
    },
    RuntimeSystemContractFamily {
        ids: V5_RUST_PROD_IDS,
        family: "v5_rust_productivity",
        objective: "enterprise_rust_productivity_lane_with_perf_canary_and_unit_economics_controls",
    },
];

fn inferred_family_for(id: &str) -> Option<(&'static str, &'static str)> {
    if id.starts_with("V9-AUDIT-026.") {
        return Some((
            "audit_self_healing_stack",
            "proactive_drift_detection_self_healing_confidence_scoring_and_cross_agent_verification",
        ));
    }
    if id.starts_with("V10-ULTIMATE-001.") {
        return Some((
            "ultimate_evolution",
            "viral_replication_metacognition_exotic_hardware_tokenomics_and_universal_adapters",
        ));
    }
    if id.starts_with("V8-AUTOMATION-016.") {
        return Some((
            "automation_mission_stack",
            "cron_handoff_memory_security_and_dashboard_hardening",
        ));
    }
    if id.starts_with("V8-AUTONOMY-012.") {
        return Some((
            "autonomy_opportunity_engine",
            "opportunity_scanning_inefficiency_detection_and_monetization_prioritization",
        ));
    }
    if id.starts_with("V8-CLI-001.") {
        return Some((
            "cli_surface_hardening",
            "single_rust_binary_state_machine_and_node_optional_wrapper_hardening",
        ));
    }
    if id.starts_with("V8-CLIENT-010.") {
        return Some((
            "client_model_access",
            "vibe_proxy_and_model_access_store_with_policy_controls",
        ));
    }
    if id.starts_with("V8-COMPETE-001.") {
        return Some((
            "competitive_execution_moat",
            "aot_performance_signed_receipts_non_divergence_and_resilience_flywheel",
        ));
    }
    if id.starts_with("V8-EYES-009.") {
        return Some((
            "eyes_media_assimilation",
            "video_transcription_course_assimilation_podcast_generation_and_swarm_integration",
        ));
    }
    if id.starts_with("V8-EYES-010.") {
        return Some((
            "eyes_computer_use",
            "browser_computer_use_navigation_reliability_voice_and_safety_gate",
        ));
    }
    if id.starts_with("V8-EYES-011.") {
        return Some((
            "eyes_lightpanda_router",
            "lightpanda_speed_profile_and_multi_backend_router_with_session_archival",
        ));
    }
    if id.starts_with("V8-LEARNING-") {
        return Some((
            "learning_rsi_pipeline",
            "signal_extraction_distillation_distributed_training_and_policy_retraining",
        ));
    }
    if id.starts_with("V8-MEMORY-") {
        return Some((
            "memory_depth_stack",
            "hierarchical_retrieval_lossless_sync_ast_indexing_and_provenance_memory",
        ));
    }
    if id.starts_with("V8-ORGANISM-") {
        return Some((
            "organism_parallel_intelligence",
            "side_sessions_hub_spoke_coordination_model_generation_and_evolution_archive",
        ));
    }
    if id.starts_with("V8-PERSONA-015.") {
        return Some((
            "persona_enterprise_pack",
            "ai_ceo_departmental_pack_cross_agent_memory_sync_and_role_extension",
        ));
    }
    if id.starts_with("V8-SAFETY-022.") {
        return Some((
            "safety_error_taxonomy",
            "structured_error_taxonomy_and_fail_closed_safety_receipts",
        ));
    }
    if id.starts_with("V8-SECURITY-") {
        return Some((
            "security_sandbox_redteam",
            "wasm_sandbox_credential_injection_privacy_plane_and_attack_chain_simulation",
        ));
    }
    if id.starts_with("V8-SKILLS-") {
        return Some((
            "skills_runtime_pack",
            "hf_cli_focus_templates_prompt_chaining_scaffolding_and_deployment_pack",
        ));
    }
    if id.starts_with("V8-SWARM-") {
        return Some((
            "swarm_runtime_scaling",
            "sentiment_swarm_role_routing_work_stealing_watchdog_and_real_time_dashboard",
        ));
    }
    if id.starts_with("V9-CLIENT-020.") {
        return Some((
            "client_wasm_bridge",
            "rust_wasm_bridge_structured_concurrency_demo_generation_and_artifact_archival",
        ));
    }
    if id.starts_with("V9-ORGANISM-025.") {
        return Some((
            "organism_adlc",
            "adlc_goals_replanning_parallel_subagents_and_live_feedback_testing",
        ));
    }
    if id.starts_with("V9-TINYMAX-021.") {
        return Some((
            "tinymax_extreme_profile",
            "trait_swappable_tinymax_core_and_sub5mb_idle_memory_mode",
        ));
    }
    None
}

fn build_profiles() -> Vec<RuntimeSystemContractProfile> {
    let mut out = BTreeMap::new();
    for group in CONTRACT_FAMILIES {
        for id in group.ids {
            out.insert(
                *id,
                RuntimeSystemContractProfile {
                    id: *id,
                    family: group.family,
                    objective: group.objective,
                    strict_conduit_only: true,
                    strict_fail_closed: true,
                },
            );
        }
    }
    for id in NEW_ACTIONABLE_IDS {
        let (family, objective) =
            inferred_family_for(id).unwrap_or(("unknown_contract_family", "unknown_objective"));
        out.insert(
            *id,
            RuntimeSystemContractProfile {
                id: *id,
                family,
                objective,
                strict_conduit_only: true,
                strict_fail_closed: true,
            },
        );
    }
    out.into_values().collect()
}

fn profiles_registry() -> &'static [RuntimeSystemContractProfile] {
    static REGISTRY: OnceLock<Vec<RuntimeSystemContractProfile>> = OnceLock::new();
    REGISTRY.get_or_init(build_profiles).as_slice()
}

fn profile_index() -> &'static BTreeMap<&'static str, RuntimeSystemContractProfile> {
    static INDEX: OnceLock<BTreeMap<&'static str, RuntimeSystemContractProfile>> = OnceLock::new();
    INDEX.get_or_init(|| {
        profiles_registry()
            .iter()
            .copied()
            .map(|profile| (profile.id, profile))
            .collect()
    })
}

pub fn actionable_profiles() -> &'static [RuntimeSystemContractProfile] {
    profiles_registry()
}

pub fn actionable_ids() -> &'static [&'static str] {
    static IDS: OnceLock<Vec<&'static str>> = OnceLock::new();
    IDS.get_or_init(|| profiles_registry().iter().map(|row| row.id).collect())
        .as_slice()
}

pub fn profile_for(system_id: &str) -> Option<RuntimeSystemContractProfile> {
    let wanted = system_id.trim();
    profile_index().get(wanted).copied()
}

pub fn looks_like_contract_id(system_id: &str) -> bool {
    let id = system_id.trim();
    id.starts_with('V') && id.contains('-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn actionable_registry_has_expected_cardinality_and_no_duplicates() {
        let profiles = actionable_profiles();
        assert_eq!(
            profiles.len(),
            243,
            "expected 243 actionable runtime contracts"
        );
        let mut seen = BTreeSet::new();
        for profile in profiles {
            assert!(
                seen.insert(profile.id.to_string()),
                "duplicate contract id in runtime registry: {}",
                profile.id
            );
            assert!(profile.strict_conduit_only);
            assert!(profile.strict_fail_closed);
        }
    }

    #[test]
    fn profile_lookup_resolves_known_and_rejects_unknown_ids() {
        assert!(profile_for("V8-ACT-001.1").is_some());
        assert!(profile_for("V11-ECOSYSTEM-001.7").is_some());
        assert!(profile_for("V6-COMPANY-003.5").is_some());
        assert!(profile_for("V5-HOLD-001").is_some());
        assert!(profile_for("V5-RUST-HYB-010").is_some());
        assert!(profile_for("V5-RUST-PROD-012").is_some());
        assert!(profile_for("V10-ULTIMATE-001.6").is_some());
        assert!(profile_for("V9-AUDIT-026.4").is_some());
        assert!(profile_for("V8-SWARM-012.10").is_some());
        assert!(profile_for("V9-TINYMAX-021.2").is_some());
        assert!(profile_for("X-UNKNOWN-404.1").is_none());
    }

    #[test]
    fn inferred_family_covers_every_new_actionable_id() {
        for id in NEW_ACTIONABLE_IDS {
            assert!(
                inferred_family_for(id).is_some(),
                "new actionable id missing inferred family: {id}"
            );
        }
    }
}
