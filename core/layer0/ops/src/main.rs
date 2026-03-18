// Layer ownership: core/layer0/ops (authoritative)
// SPDX-License-Identifier: Apache-2.0
use protheus_ops_core::{
    configure_low_memory_allocator_env, deterministic_receipt_hash, parse_args, parse_os_args,
    run_runtime_efficiency_floor, status_runtime_efficiency_floor,
};
use serde_json::{json, Value};
use std::env;
use std::path::PathBuf;
#[path = "ops_main_usage.rs"]
mod ops_main_usage;

fn usage() {
    ops_main_usage::print_usage();
}

fn print_json(value: &serde_json::Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

macro_rules! exit_domain {
    ($cwd:expr, $args:expr, $runner:path) => {{
        let rest = $args.iter().skip(1).cloned().collect::<Vec<_>>();
        let exit = $runner($cwd, &rest);
        std::process::exit(exit);
    }};
}

fn cli_error_receipt(
    error: &str,
    exit_code: i32,
    domain: Option<&str>,
    command: Option<&str>,
) -> Value {
    let ts = protheus_ops_core::now_iso();
    let mut out = json!({
        "ok": false,
        "type": "protheus_ops_cli_error",
        "ts": ts,
        "date": ts[..10].to_string(),
        "error": error,
        "exit_code": exit_code,
        "domain": domain,
        "command": command,
        "claim_evidence": [
            {
                "id": "fail_closed_cli",
                "claim": "top_level_cli_errors_emit_deterministic_receipts",
                "evidence": {
                    "error": error,
                    "domain_present": domain.is_some(),
                    "command_present": command.is_some()
                }
            }
        ],
        "persona_lenses": {
            "operator": {
                "entrypoint": "main",
                "domain": domain
            },
            "auditor": {
                "deterministic_receipt": true
            }
        }
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn main() {
    configure_low_memory_allocator_env();
    if std::env::var("PROTHEUS_OPS_TRACE_BOOT")
        .ok()
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
    {
        eprintln!("protheus_ops_boot:main_enter");
    }
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if std::env::var("PROTHEUS_OPS_TRACE_BOOT")
        .ok()
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
    {
        eprintln!("protheus_ops_boot:cwd={}", cwd.display());
    }
    let args = parse_os_args(env::args_os().skip(1));
    if args.is_empty() {
        usage();
        print_json(&cli_error_receipt("missing_domain", 1, None, None));
        std::process::exit(1);
    }

    let domain = args.first().map(String::as_str).unwrap_or("");
    match domain {
        "runtime-efficiency-floor" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let parsed = parse_args(&rest);
            let cmd = parsed
                .positional
                .first()
                .map(|v| v.to_ascii_lowercase())
                .unwrap_or_else(|| "run".to_string());

            match cmd.as_str() {
                "run" => match run_runtime_efficiency_floor(&cwd, &parsed) {
                    Ok(out) => {
                        print_json(&out.json);
                        std::process::exit(out.exit_code);
                    }
                    Err(err) => {
                        print_json(&cli_error_receipt(
                            &format!("runtime_efficiency_floor_run_failed:{err}"),
                            1,
                            Some(domain),
                            Some("run"),
                        ));
                        std::process::exit(1);
                    }
                },
                "status" => {
                    let out = status_runtime_efficiency_floor(&cwd, &parsed);
                    print_json(&out.json);
                    std::process::exit(out.exit_code);
                }
                _ => {
                    usage();
                    print_json(&cli_error_receipt(
                        "runtime_efficiency_floor_unknown_command",
                        1,
                        Some(domain),
                        Some(cmd.as_str()),
                    ));
                    std::process::exit(1);
                }
            }
        }
        "benchmark-autonomy-gate" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::benchmark_autonomy_gate::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "approval-gate-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::approval_gate_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "secret-broker-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::secret_broker_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "passport-iteration-chain-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::passport_iteration_chain_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "egress-gateway-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::egress_gateway_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "adaptive-layer-store-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::adaptive_layer_store_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "focus-trigger-store-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::focus_trigger_store_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "symbiosis-coherence-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::symbiosis_coherence_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "ternary-belief-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::ternary_belief_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "trit-shadow-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::trit_shadow_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "model-router" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::model_router::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "intelligence-nexus" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::intelligence_nexus::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "network-protocol" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::network_protocol::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "seed-protocol" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::seed_protocol::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "binary-blob-runtime" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::binary_blob_runtime::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "directive-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::directive_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "action-envelope-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::action_envelope_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "action-receipts-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::action_receipts_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "success-criteria-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::success_criteria_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "success-criteria-compiler-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::success_criteria_compiler_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "outcome-fitness-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::outcome_fitness_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "training-conduit-schema-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::training_conduit_schema_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "tool-response-compactor-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::tool_response_compactor_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "trit-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::trit_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "request-envelope-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::request_envelope_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "autonomy-receipt-schema-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::autonomy_receipt_schema_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "quorum-validator-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::quorum_validator_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "mutation-provenance-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::mutation_provenance_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "ops-domain-conduit-runner-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::ops_domain_conduit_runner_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "local-runtime-partitioner" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::local_runtime_partitioner::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "strategy-store-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::strategy_store_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "habit-store-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::habit_store_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "reflex-store-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::reflex_store_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "strategy-campaign-scheduler-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::strategy_campaign_scheduler_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "queued-backlog-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::queued_backlog_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "queue-sqlite-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::queue_sqlite_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "upgrade-lane-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::upgrade_lane_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "mech-suit-mode-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::mech_suit_mode_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "rsi-ignition" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::rsi_ignition::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "continuity-runtime" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::continuity_runtime::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "memory-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::memory_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "memory-policy-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::memory_policy_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "memory-session-isolation-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::memory_session_isolation_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "readiness-bridge-pack-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::readiness_bridge_pack_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "security-integrity-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::security_integrity_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "runtime-systems" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::runtime_systems::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "child-organ-runtime" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::child_organ_runtime::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "organism-layer" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::organism_layer::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "graph-toolkit" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::graph_toolkit::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "asm-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::asm_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "research-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::research_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "parse-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::parse_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "flow-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::flow_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "app-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::app_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "snowball-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::snowball_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "mcp-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::mcp_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "skills-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::skills_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "vbrowser-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::vbrowser_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "agency-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::agency_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "collab-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::collab_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "company-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::company_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "business-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::business_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "canyon-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::canyon_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "government-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::government_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "finance-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::finance_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "healthcare-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::healthcare_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "vertical-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::vertical_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "nexus-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::nexus_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "substrate-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::substrate_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "observability-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::observability_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "persist-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::persist_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "binary-vuln-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::binary_vuln_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "hermes-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::hermes_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "eval-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::eval_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "ab-lane-eval" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::ab_lane_eval::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "benchmark-matrix" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::benchmark_matrix::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "f100-reliability-certification" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::f100_reliability_certification::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "sdlc-change-control" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::sdlc_change_control::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "system-health-audit-runner-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::system_health_audit_runner_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "supply-chain-provenance-v2" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::supply_chain_provenance_v2::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "f100-readiness-program" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::f100_readiness_program::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "identity-federation" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::identity_federation::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "audit-log-export" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::audit_log_export::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "contract-check" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::contract_check::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "security-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::security_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "enterprise-hardening" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::enterprise_hardening::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "rollout-rings" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::rollout_rings::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "strategy-mode-governor" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::strategy_mode_governor::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "strategy-resolver" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::strategy_resolver::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "status" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::health_status::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "daemon-control" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::daemon_control::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "command-center-session" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core_v1::command_center_session::run
            );
        }
        "organ-atrophy-controller" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::organ_atrophy_controller::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "narrow-agent-parity-harness" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::narrow_agent_parity_harness::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "offsite-backup" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::offsite_backup::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "settlement-program" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::settlement_program::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "llm-economy-organ" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::llm_economy_organ::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "metakernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::metakernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "top1-assurance" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::top1_assurance::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "backlog-queue-executor" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::backlog_queue_executor::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "backlog-delivery-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::backlog_delivery_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "backlog-runtime-anchor" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::backlog_runtime_anchor::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "legacy-retired-lane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::legacy_retired_lane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "inversion-controller" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::inversion_controller::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "health-status" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::health_status::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "alpha-readiness" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::alpha_readiness::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "foundation-contract-gate" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::foundation_contract_gate::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "origin-integrity" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::origin_integrity::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "state-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::state_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "shadow-budget-governance" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::shadow_budget_governance::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "adaptive-runtime" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::adaptive_runtime::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "adaptive-intelligence" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::adaptive_intelligence::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "offline-runtime-guard" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::offline_runtime_guard::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "hardware-route-hardening" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::hardware_route_hardening::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "autonomy-controller" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::autonomy_controller::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "autotest-controller" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::autotest_controller::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "autotest-doctor" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::autotest_doctor::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "autonomy-proposal-enricher" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::proposal_enricher::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "spine" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::spine::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "attention-queue" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::attention_queue::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "memory-ambient" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::memory_ambient::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "duality-seed" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::duality_seed::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "persona-ambient" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::persona_ambient::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "dopamine-ambient" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::dopamine_ambient::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "persona-schema-contract" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::persona_schema_contract::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "protheusctl" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::protheusctl::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "rag" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::rag_cli::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "personas-cli" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::personas_cli::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "autophagy-auto-approval" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core_v1::autophagy_auto_approval::run
            );
        }
        "adaptive-contract-version-governance" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core_v1::adaptive_contract_version_governance::run
            );
        }
        "assimilation-controller" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::assimilation_controller::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "collector-cache" => {
            exit_domain!(&cwd, &args, protheus_ops_core_v1::collector_cache::run);
        }
        "contribution-oracle" => {
            exit_domain!(&cwd, &args, protheus_ops_core_v1::contribution_oracle::run);
        }
        "sensory-eyes-intake" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::sensory_eyes_intake::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "spawn-broker" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::spawn_broker::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "swarm-runtime" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::swarm_runtime::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "execution-yield-recovery" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::execution_yield_recovery::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "orchestration" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::orchestration::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "protheus-control-plane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::protheus_control_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "rust50-migration-program" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::rust50_migration_program::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "venom-containment-layer" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::venom_containment_layer::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "dynamic-burn-budget-oracle" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core::dynamic_burn_budget_oracle::run
            );
        }
        "dynamic-burn-budget-signal-kernel" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core::dynamic_burn_budget_signal_kernel::run
            );
        }
        "conversation-eye-synthesizer-kernel" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core::conversation_eye_synthesizer_kernel::run
            );
        }
        "trainability-matrix-kernel" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core::trainability_matrix_kernel::run
            );
        }
        "policy-runtime-kernel" => {
            exit_domain!(&cwd, &args, protheus_ops_core::policy_runtime_kernel::run);
        }
        "camel-bridge" => {
            exit_domain!(&cwd, &args, protheus_ops_core::camel_bridge::run);
        }
        "semantic-kernel-bridge" => {
            exit_domain!(&cwd, &args, protheus_ops_core::semantic_kernel_bridge::run);
        }
        "google-adk-bridge" => {
            exit_domain!(&cwd, &args, protheus_ops_core::google_adk_bridge::run);
        }
        "haystack-bridge" => {
            exit_domain!(&cwd, &args, protheus_ops_core::haystack_bridge::run);
        }
        "langchain-bridge" => {
            exit_domain!(&cwd, &args, protheus_ops_core::langchain_bridge::run);
        }
        "pydantic-ai-bridge" => {
            exit_domain!(&cwd, &args, protheus_ops_core::pydantic_ai_bridge::run);
        }
        "mastra-bridge" => {
            exit_domain!(&cwd, &args, protheus_ops_core::mastra_bridge::run);
        }
        "llamaindex-bridge" => {
            exit_domain!(&cwd, &args, protheus_ops_core::llamaindex_bridge::run);
        }
        "integrity-hash-utility-kernel" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core::integrity_hash_utility_kernel::run
            );
        }
        "redaction-classification-kernel" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core::redaction_classification_kernel::run
            );
        }
        "runtime-path-registry-kernel" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core::runtime_path_registry_kernel::run
            );
        }
        "proposal-type-classifier-kernel" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core::proposal_type_classifier_kernel::run
            );
        }
        "catalog-store-kernel" => {
            exit_domain!(&cwd, &args, protheus_ops_core::catalog_store_kernel::run);
        }
        "state-artifact-contract-kernel" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core::state_artifact_contract_kernel::run
            );
        }
        "uid-kernel" => {
            exit_domain!(&cwd, &args, protheus_ops_core::uid_kernel::run);
        }
        "backlog-registry" => {
            exit_domain!(&cwd, &args, protheus_ops_core::backlog_registry::run);
        }
        "rust-enterprise-productivity-program" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core::rust_enterprise_productivity_program::run
            );
        }
        "backlog-github-sync" => {
            exit_domain!(&cwd, &args, protheus_ops_core::backlog_github_sync::run);
        }
        "workflow-controller" => {
            exit_domain!(&cwd, &args, protheus_ops_core::workflow_controller::run);
        }
        "workflow-executor" => {
            exit_domain!(&cwd, &args, protheus_ops_core::workflow_executor::run);
        }
        "fluxlattice-program" => {
            exit_domain!(&cwd, &args, protheus_ops_core::fluxlattice_program::run);
        }
        "perception-polish-program" => {
            exit_domain!(&cwd, &args, protheus_ops_core::perception_polish::run);
        }
        "scale-readiness-program" => {
            exit_domain!(&cwd, &args, protheus_ops_core::scale_readiness::run);
        }
        "opendev-dual-agent" => {
            exit_domain!(&cwd, &args, protheus_ops_core_v1::opendev_dual_agent::run);
        }
        "company-layer-orchestration" => {
            let mut rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            if rest.is_empty() {
                rest.push("orchestrate-agency".to_string());
            }
            let exit = protheus_ops_core::company_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "wifi-csi-engine" => {
            let mut rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            if rest.is_empty() {
                rest.push("csi-capture".to_string());
            }
            let exit = protheus_ops_core::substrate_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "biological-computing-adapter" => {
            let mut rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            if rest.is_empty() {
                rest.extend(["bio-interface".to_string(), "--op=status".to_string()]);
            }
            let exit = protheus_ops_core::substrate_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "observability-automation-engine" => {
            let mut rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            if rest.is_empty() {
                rest.extend([
                    "workflow".to_string(),
                    "--op=upsert".to_string(),
                    "--workflow-id=default-observability".to_string(),
                ]);
            }
            let exit = protheus_ops_core::observability_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "observability-slo-runbook-closure" => {
            let mut rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            if rest.is_empty() {
                rest.extend([
                    "incident".to_string(),
                    "--op=resolve".to_string(),
                    "--incident-id=default-incident".to_string(),
                ]);
            }
            let exit = protheus_ops_core::observability_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "persistent-background-runtime" => {
            let mut rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            if rest.is_empty() {
                rest.extend(["schedule".to_string(), "--op=list".to_string()]);
            }
            let exit = protheus_ops_core::persist_plane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "workspace-gateway-runtime" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core_v1::workspace_gateway_runtime::run
            );
        }
        "p2p-gossip-seed" => {
            exit_domain!(&cwd, &args, protheus_ops_core_v1::p2p_gossip_seed::run);
        }
        "startup-agency-builder" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core_v1::startup_agency_builder::run
            );
        }
        "timeseries-receipt-engine" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core_v1::timeseries_receipt_engine::run
            );
        }
        "webgpu-inference-adapter" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core_v1::webgpu_inference_adapter::run
            );
        }
        "context-doctor" => {
            exit_domain!(&cwd, &args, protheus_ops_core_v1::context_doctor::run);
        }
        "discord-swarm-orchestration" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core_v1::discord_swarm_orchestration::run
            );
        }
        "bookmark-knowledge-pipeline" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core_v1::bookmark_knowledge_pipeline::run
            );
        }
        "public-api-catalog" => {
            exit_domain!(&cwd, &args, protheus_ops_core_v1::public_api_catalog::run);
        }
        "decentralized-data-marketplace" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core_v1::decentralized_data_marketplace::run
            );
        }
        "autoresearch-loop" => {
            exit_domain!(&cwd, &args, protheus_ops_core_v1::autoresearch_loop::run);
        }
        "intel-sweep-router" => {
            exit_domain!(&cwd, &args, protheus_ops_core_v1::intel_sweep_router::run);
        }
        "gui-drift-manager" => {
            exit_domain!(&cwd, &args, protheus_ops_core_v1::gui_drift_manager::run);
        }
        "release-gate-canary-rollback-enforcer" => {
            exit_domain!(
                &cwd,
                &args,
                protheus_ops_core_v1::release_gate_canary_rollback_enforcer::run
            );
        }
        "srs-contract-runtime" => {
            exit_domain!(&cwd, &args, protheus_ops_core_v1::srs_contract_runtime::run);
        }
        _ => {
            print_json(&cli_error_receipt("unknown_domain", 1, Some(domain), None));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
#[path = "ops_main_tests.rs"]
mod tests;
