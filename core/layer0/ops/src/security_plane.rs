// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer1/security (authoritative)

use crate::clean;
use crate::{deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use std::path::Path;

fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn compatibility_security_command(command: &str, argv: &[String]) -> (Value, i32) {
    let mut out = json!({
        "ok": true,
        "type": "security_plane_compat_command",
        "lane": "core/layer1/security",
        "command": command,
        "argv": argv,
        "ts": now_iso(),
        "compatibility_only": true,
        "authority": "rust_security_plane"
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    (out, 0)
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let cmd = argv
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let rest = if argv.is_empty() { &[][..] } else { &argv[1..] };

    let (payload, code) = match cmd.as_str() {
        "guard" => infring_layer1_security::run_guard(root, rest),
        "anti-sabotage-shield" | "anti_sabotage_shield" => {
            infring_layer1_security::run_anti_sabotage_shield(root, rest)
        }
        "constitution-guardian" | "constitution_guardian" => {
            infring_layer1_security::run_constitution_guardian(root, rest)
        }
        "remote-emergency-halt" | "remote_emergency_halt" => {
            infring_layer1_security::run_remote_emergency_halt(root, rest)
        }
        "soul-token-guard" | "soul_token_guard" => {
            infring_layer1_security::run_soul_token_guard(root, rest)
        }
        "integrity-reseal" | "integrity_reseal" => {
            infring_layer1_security::run_integrity_reseal(root, rest)
        }
        "integrity-reseal-assistant" | "integrity_reseal_assistant" => {
            infring_layer1_security::run_integrity_reseal_assistant(root, rest)
        }
        "capability-lease" | "capability_lease" => {
            infring_layer1_security::run_capability_lease(root, rest)
        }
        "startup-attestation" | "startup_attestation" => {
            infring_layer1_security::run_startup_attestation(root, rest)
        }
        "directive-hierarchy-controller" | "directive_hierarchy_controller" => {
            infring_layer1_security::run_directive_hierarchy_controller(root, rest)
        }
        "capability-switchboard" | "capability_switchboard" => {
            infring_layer1_security::run_capability_switchboard(root, rest)
        }
        "black-box-ledger" | "black_box_ledger" => {
            infring_layer1_security::run_black_box_ledger(root, rest)
        }
        "goal-preservation-kernel" | "goal_preservation_kernel" => {
            infring_layer1_security::run_goal_preservation_kernel(root, rest)
        }
        "dream-warden-guard" | "dream_warden_guard" => {
            infring_layer1_security::run_dream_warden_guard(root, rest)
        }
        "copy-hardening-pack" | "copy_hardening_pack" => {
            compatibility_security_command("copy-hardening-pack", rest)
        }
        "governance-hardening-pack" | "governance_hardening_pack" => {
            compatibility_security_command("governance-hardening-pack", rest)
        }
        "repository-access-auditor" | "repository_access_auditor" => {
            compatibility_security_command("repository-access-auditor", rest)
        }
        "operator-terms-ack" | "operator_terms_ack" => {
            compatibility_security_command("operator-terms-ack", rest)
        }
        "governance-hardening-lane" | "governance_hardening_lane" => {
            compatibility_security_command("governance-hardening-lane", rest)
        }
        "skill-install-path-enforcer" | "skill_install_path_enforcer" => {
            compatibility_security_command("skill-install-path-enforcer", rest)
        }
        "skill-quarantine" | "skill_quarantine" => {
            compatibility_security_command("skill-quarantine", rest)
        }
        "autonomous-skill-necessity-audit" | "autonomous_skill_necessity_audit" => {
            compatibility_security_command("autonomous-skill-necessity-audit", rest)
        }
        "formal-invariant-engine" | "formal_invariant_engine" => {
            compatibility_security_command("formal-invariant-engine", rest)
        }
        "repo-hygiene-guard" | "repo_hygiene_guard" => {
            compatibility_security_command("repo-hygiene-guard", rest)
        }
        "capability-envelope-guard" | "capability_envelope_guard" => {
            compatibility_security_command("capability-envelope-guard", rest)
        }
        "ip-posture-review" | "ip_posture_review" => {
            compatibility_security_command("ip-posture-review", rest)
        }
        "habit-hygiene-guard" | "habit_hygiene_guard" => {
            compatibility_security_command("habit-hygiene-guard", rest)
        }
        "enterprise-access-gate" | "enterprise_access_gate" => {
            compatibility_security_command("enterprise-access-gate", rest)
        }
        "model-vaccine-sandbox" | "model_vaccine_sandbox" => {
            compatibility_security_command("model-vaccine-sandbox", rest)
        }
        "skill-install-enforcer" | "skill_install_enforcer" => {
            compatibility_security_command("skill-install-enforcer", rest)
        }
        "execution-sandbox-envelope" | "execution_sandbox_envelope" => {
            compatibility_security_command("execution-sandbox-envelope", rest)
        }
        "workspace-dump-guard" | "workspace_dump_guard" => {
            compatibility_security_command("workspace-dump-guard", rest)
        }
        "external-security-cycle" | "external_security_cycle" => {
            compatibility_security_command("external-security-cycle", rest)
        }
        "log-redaction-guard" | "log_redaction_guard" => {
            compatibility_security_command("log-redaction-guard", rest)
        }
        "rsi-git-patch-self-mod-gate" | "rsi_git_patch_self_mod_gate" => {
            compatibility_security_command("rsi-git-patch-self-mod-gate", rest)
        }
        "request-ingress" | "request_ingress" => {
            compatibility_security_command("request-ingress", rest)
        }
        "startup-attestation-boot-gate" | "startup_attestation_boot_gate" => {
            compatibility_security_command("startup-attestation-boot-gate", rest)
        }
        "conflict-marker-guard" | "conflict_marker_guard" => {
            compatibility_security_command("conflict-marker-guard", rest)
        }
        "llm-gateway-guard" | "llm_gateway_guard" => {
            compatibility_security_command("llm-gateway-guard", rest)
        }
        "required-checks-policy-guard" | "required_checks_policy_guard" => {
            compatibility_security_command("required-checks-policy-guard", rest)
        }
        "mcp-a2a-venom-contract-gate" | "mcp_a2a_venom_contract_gate" => {
            compatibility_security_command("mcp-a2a-venom-contract-gate", rest)
        }
        "critical-runtime-formal-depth-pack" | "critical_runtime_formal_depth_pack" => {
            compatibility_security_command("critical-runtime-formal-depth-pack", rest)
        }
        "dire-case-emergency-autonomy-protocol" | "dire_case_emergency_autonomy_protocol" => {
            compatibility_security_command("dire-case-emergency-autonomy-protocol", rest)
        }
        "delegated-authority-branching" | "delegated_authority_branching" => {
            compatibility_security_command("delegated-authority-branching", rest)
        }
        "organ-state-encryption-plane" | "organ_state_encryption_plane" => {
            compatibility_security_command("organ-state-encryption-plane", rest)
        }
        "remote-tamper-heartbeat" | "remote_tamper_heartbeat" => {
            compatibility_security_command("remote-tamper-heartbeat", rest)
        }
        "skin-protection-layer" | "skin_protection_layer" => {
            compatibility_security_command("skin-protection-layer", rest)
        }
        "critical-path-formal-verifier" | "critical_path_formal_verifier" => {
            compatibility_security_command("critical-path-formal-verifier", rest)
        }
        "key-lifecycle-governor" | "key_lifecycle_governor" => {
            compatibility_security_command("key-lifecycle-governor", rest)
        }
        "supply-chain-trust-plane" | "supply_chain_trust_plane" => {
            compatibility_security_command("supply-chain-trust-plane", rest)
        }
        "post-quantum-migration-lane" | "post_quantum_migration_lane" => {
            compatibility_security_command("post-quantum-migration-lane", rest)
        }
        "safety-resilience-guard" | "safety_resilience_guard" => {
            compatibility_security_command("safety-resilience-guard", rest)
        }
        "status" => (
            json!({
                "ok": true,
                "type": "security_plane_status",
                "lane": "core/layer1/security",
                "commands": [
                    "guard",
                    "anti-sabotage-shield",
                    "constitution-guardian",
                    "remote-emergency-halt",
                    "soul-token-guard",
                    "integrity-reseal",
                    "integrity-reseal-assistant",
                    "capability-lease",
                    "startup-attestation",
                    "directive-hierarchy-controller",
                    "capability-switchboard",
                    "black-box-ledger",
                    "goal-preservation-kernel",
                    "dream-warden-guard",
                    "delegated-authority-branching",
                    "organ-state-encryption-plane",
                    "remote-tamper-heartbeat",
                    "skin-protection-layer",
                    "critical-path-formal-verifier",
                    "key-lifecycle-governor",
                    "supply-chain-trust-plane",
                    "post-quantum-migration-lane",
                    "safety-resilience-guard",
                    "rsi-git-patch-self-mod-gate",
                    "request-ingress",
                    "startup-attestation-boot-gate",
                    "conflict-marker-guard",
                    "llm-gateway-guard",
                    "required-checks-policy-guard",
                    "mcp-a2a-venom-contract-gate",
                    "critical-runtime-formal-depth-pack",
                    "dire-case-emergency-autonomy-protocol"
                ]
            }),
            0,
        ),
        _ => (
            json!({
                "ok": false,
                "type": "security_plane_error",
                "error": format!("unknown_command:{}", clean(cmd, 120)),
                "usage": [
                    "protheus-ops security-plane guard [--files=<a,b,c>] [--strict=1|0]",
                    "protheus-ops security-plane anti-sabotage-shield <snapshot|verify|watch|status> [flags]",
                    "protheus-ops security-plane constitution-guardian <init-genesis|propose-change|approve-change|veto-change|run-gauntlet|activate-change|enforce-inheritance|emergency-rollback|status> [flags]",
                    "protheus-ops security-plane remote-emergency-halt <status|sign-halt|sign-purge|receive|receive-b64> [flags]",
                    "protheus-ops security-plane soul-token-guard <issue|stamp-build|verify|status> [flags]",
                    "protheus-ops security-plane integrity-reseal <check|apply> [flags]",
                    "protheus-ops security-plane integrity-reseal-assistant <run|status> [flags]",
                    "protheus-ops security-plane capability-lease <issue|verify|consume> [flags]",
                    "protheus-ops security-plane startup-attestation <issue|verify|status> [flags]",
                    "protheus-ops security-plane directive-hierarchy-controller <status|decompose> [flags]",
                    "protheus-ops security-plane capability-switchboard <status|evaluate|set> [flags]",
                    "protheus-ops security-plane black-box-ledger <rollup|verify|status> [flags]",
                    "protheus-ops security-plane goal-preservation-kernel <evaluate|status> [flags]",
                    "protheus-ops security-plane dream-warden-guard <run|status> [flags]",
                    "protheus-ops security-plane copy-hardening-pack <command> [flags]",
                    "protheus-ops security-plane governance-hardening-pack <command> [flags]",
                    "protheus-ops security-plane repository-access-auditor <command> [flags]",
                    "protheus-ops security-plane operator-terms-ack <command> [flags]",
                    "protheus-ops security-plane governance-hardening-lane <command> [flags]",
                    "protheus-ops security-plane skill-install-path-enforcer <command> [flags]",
                    "protheus-ops security-plane skill-quarantine <command> [flags]",
                    "protheus-ops security-plane autonomous-skill-necessity-audit <command> [flags]",
                    "protheus-ops security-plane formal-invariant-engine <command> [flags]",
                    "protheus-ops security-plane repo-hygiene-guard <command> [flags]",
                    "protheus-ops security-plane rsi-git-patch-self-mod-gate <command> [flags]",
                    "protheus-ops security-plane request-ingress <command> [flags]",
                    "protheus-ops security-plane startup-attestation-boot-gate <command> [flags]",
                    "protheus-ops security-plane conflict-marker-guard <command> [flags]",
                    "protheus-ops security-plane llm-gateway-guard <command> [flags]",
                    "protheus-ops security-plane required-checks-policy-guard <command> [flags]",
                    "protheus-ops security-plane mcp-a2a-venom-contract-gate <command> [flags]",
                    "protheus-ops security-plane critical-runtime-formal-depth-pack <command> [flags]",
                    "protheus-ops security-plane dire-case-emergency-autonomy-protocol <command> [flags]"
                ]
            }),
            2,
        ),
    };

    print_json(&payload);
    code
}
