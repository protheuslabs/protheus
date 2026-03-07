// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;

fn receipt_hash(v: &Value) -> String {
    deterministic_receipt_hash(v)
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn flag_value(argv: &[String], key: &str) -> Option<String> {
    let pref = format!("--{key}=");
    let mut i = 0usize;
    while i < argv.len() {
        let tok = argv[i].trim();
        if let Some(v) = tok.strip_prefix(&pref) {
            return Some(v.to_string());
        }
        if tok == format!("--{key}") {
            if let Some(next) = argv.get(i + 1) {
                if !next.starts_with("--") {
                    return Some(next.clone());
                }
            }
        }
        i += 1;
    }
    None
}

fn parse_bool(value: Option<String>, fallback: bool) -> bool {
    let Some(raw) = value else {
        return fallback;
    };
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn parse_u32(value: Option<String>, fallback: u32, min: u32, max: u32) -> u32 {
    value
        .and_then(|v| v.parse::<u32>().ok())
        .map(|v| v.clamp(min, max))
        .unwrap_or(fallback)
}

pub fn run(root: &Path, args: &[String]) -> i32 {
    let cmd = args
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(cmd.as_str(), "help" | "--help" | "-h") {
        println!("Usage:");
        println!("  protheus-ops strategy-mode-governor status");
        println!("  protheus-ops strategy-mode-governor evaluate [--mode=score_only|canary_execute|execute] [--ready=1|0] [--failed-checks=a,b] [--canary-preview-ready=1|0] [--canary-ready=1|0] [--quality-lock=1|0]");
        return 0;
    }

    if !matches!(cmd.as_str(), "status" | "evaluate" | "run") {
        let mut out = json!({
            "ok": false,
            "type": "strategy_mode_governor_cli_error",
            "ts": now_iso(),
            "command": cmd,
            "argv": args,
            "error": "unknown_command",
            "exit_code": 2
        });
        out["receipt_hash"] = Value::String(receipt_hash(&out));
        print_json_line(&out);
        return 2;
    }

    let current_mode = flag_value(args, "mode").unwrap_or_else(|| "score_only".to_string());
    let strict_ready = parse_bool(flag_value(args, "ready"), false);
    let failed_checks = flag_value(args, "failed-checks")
        .unwrap_or_default()
        .split(',')
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>();
    let relax_checks = flag_value(args, "canary-relax-checks")
        .unwrap_or_else(|| "success_criteria_pass_rate".to_string())
        .split(',')
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect::<HashSet<_>>();
    let readiness = readiness_state(
        &current_mode,
        strict_ready,
        &failed_checks,
        true,
        &relax_checks,
    );

    let canary = CanaryState {
        preview_ready_for_canary: parse_bool(flag_value(args, "canary-preview-ready"), readiness.ready_for_canary),
        ready_for_execute: parse_bool(flag_value(args, "canary-ready"), readiness.ready_for_execute),
        quality_lock_active: parse_bool(flag_value(args, "quality-lock"), true),
    };

    let policy = GovernorPolicy {
        promote_canary: parse_bool(flag_value(args, "promote-canary"), true),
        promote_execute: parse_bool(flag_value(args, "promote-execute"), true),
        demote_not_ready: parse_bool(flag_value(args, "demote-not-ready"), true),
        min_escalate_streak: parse_u32(flag_value(args, "min-escalate-streak"), 1, 1, 100),
        min_demote_streak: parse_u32(flag_value(args, "min-demote-streak"), 1, 1, 100),
        canary_require_quality_lock_for_execute: parse_bool(flag_value(args, "require-quality-lock"), true),
        require_spc: parse_bool(flag_value(args, "require-spc"), true),
    };

    let streak = StreakState {
        escalate_ready_streak: parse_u32(flag_value(args, "escalate-streak"), 1, 0, 1000),
        demote_not_ready_streak: parse_u32(flag_value(args, "demote-streak"), 0, 0, 1000),
    };

    let spc_pass = parse_bool(flag_value(args, "spc-pass"), true);
    let spc_hold_escalation = parse_bool(flag_value(args, "spc-hold"), false);
    let transition = decide_transition(
        &current_mode,
        &readiness,
        &canary,
        &policy,
        spc_pass,
        spc_hold_escalation,
        &streak,
    );

    let mut out = json!({
        "ok": true,
        "type": "strategy_mode_governor",
        "ts": now_iso(),
        "command": cmd,
        "argv": args,
        "root": root.to_string_lossy(),
        "current_mode": current_mode,
        "readiness": readiness,
        "canary": canary,
        "policy": policy,
        "streak": streak,
        "transition": transition,
        "claim_evidence": [
            {
                "id": "native_strategy_mode_governor_lane",
                "claim": "strategy mode transition logic executes natively in rust",
                "evidence": {
                    "transition_present": transition.is_some()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    print_json_line(&out);
    0
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadinessState {
    pub strict_ready: bool,
    pub canary_relaxed: bool,
    pub ready_for_canary: bool,
    pub ready_for_execute: bool,
    pub effective_ready: bool,
    pub failed_checks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CanaryState {
    pub preview_ready_for_canary: bool,
    pub ready_for_execute: bool,
    pub quality_lock_active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GovernorPolicy {
    pub promote_canary: bool,
    pub promote_execute: bool,
    pub demote_not_ready: bool,
    pub min_escalate_streak: u32,
    pub min_demote_streak: u32,
    pub canary_require_quality_lock_for_execute: bool,
    pub require_spc: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StreakState {
    pub escalate_ready_streak: u32,
    pub demote_not_ready_streak: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Transition {
    pub to_mode: String,
    pub reason: String,
    pub cooldown_exempt: bool,
}

pub fn canary_failed_checks_allowed(
    failed_checks: &[String],
    allowed_checks: &HashSet<String>,
) -> bool {
    if failed_checks.is_empty() || allowed_checks.is_empty() {
        return false;
    }
    failed_checks.iter().all(|check| {
        let normalized = check.trim();
        !normalized.is_empty() && allowed_checks.contains(normalized)
    })
}

pub fn readiness_state(
    mode: &str,
    ready_for_execute: bool,
    failed_checks: &[String],
    canary_relax_enabled: bool,
    canary_relax_checks: &HashSet<String>,
) -> ReadinessState {
    let failed = failed_checks
        .iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>();
    let canary_relaxed = canary_relax_enabled && canary_failed_checks_allowed(&failed, canary_relax_checks);
    let ready_for_canary = ready_for_execute || canary_relaxed;
    let effective_ready = if mode.trim() == "execute" {
        ready_for_execute
    } else {
        ready_for_canary
    };

    ReadinessState {
        strict_ready: ready_for_execute,
        canary_relaxed,
        ready_for_canary,
        ready_for_execute,
        effective_ready,
        failed_checks: failed,
    }
}

fn spc_allows_escalation(spc_pass: bool, spc_hold_escalation: bool, policy: &GovernorPolicy) -> bool {
    if !policy.require_spc {
        return true;
    }
    spc_pass && !spc_hold_escalation
}

pub fn decide_transition(
    current_mode: &str,
    readiness: &ReadinessState,
    canary: &CanaryState,
    policy: &GovernorPolicy,
    spc_pass: bool,
    spc_hold_escalation: bool,
    streak: &StreakState,
) -> Option<Transition> {
    let mode = current_mode.trim();
    let escalate_ready = streak.escalate_ready_streak >= policy.min_escalate_streak.max(1);
    let demote_ready = streak.demote_not_ready_streak >= policy.min_demote_streak.max(1);

    if mode == "score_only" {
        if !policy.promote_canary {
            return None;
        }
        if readiness.ready_for_canary
            && canary.preview_ready_for_canary
            && spc_allows_escalation(spc_pass, spc_hold_escalation, policy)
            && escalate_ready
        {
            return Some(Transition {
                to_mode: "canary_execute".to_string(),
                reason: "readiness_pass_promote_canary".to_string(),
                cooldown_exempt: false,
            });
        }
        return None;
    }

    if mode == "canary_execute" {
        if policy.demote_not_ready && !readiness.ready_for_canary && demote_ready {
            return Some(Transition {
                to_mode: "score_only".to_string(),
                reason: "readiness_fail_demote_score_only".to_string(),
                cooldown_exempt: true,
            });
        }

        if policy.promote_execute
            && readiness.ready_for_execute
            && canary.ready_for_execute
            && spc_allows_escalation(spc_pass, spc_hold_escalation, policy)
            && escalate_ready
        {
            return Some(Transition {
                to_mode: "execute".to_string(),
                reason: "canary_metrics_pass_promote_execute".to_string(),
                cooldown_exempt: false,
            });
        }

        return None;
    }

    if mode == "execute" {
        let quality_lock_required = policy.canary_require_quality_lock_for_execute;
        let needs_demotion = !readiness.ready_for_execute
            || (quality_lock_required && !canary.quality_lock_active);

        if policy.demote_not_ready && needs_demotion && demote_ready {
            return Some(Transition {
                to_mode: "canary_execute".to_string(),
                reason: if !readiness.ready_for_execute {
                    "readiness_fail_demote_canary".to_string()
                } else {
                    "quality_lock_inactive_demote_canary".to_string()
                },
                cooldown_exempt: true,
            });
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_policy() -> GovernorPolicy {
        GovernorPolicy {
            promote_canary: true,
            promote_execute: true,
            demote_not_ready: true,
            min_escalate_streak: 2,
            min_demote_streak: 1,
            canary_require_quality_lock_for_execute: true,
            require_spc: true,
        }
    }

    #[test]
    fn readiness_state_relaxes_only_for_allowed_checks() {
        let allow = HashSet::from(["success_criteria_pass_rate".to_string()]);
        let state = readiness_state(
            "score_only",
            false,
            &["success_criteria_pass_rate".to_string()],
            true,
            &allow,
        );
        assert!(state.canary_relaxed);
        assert!(state.ready_for_canary);
        assert!(!state.ready_for_execute);

        let blocked = readiness_state(
            "score_only",
            false,
            &["verified_rate".to_string()],
            true,
            &allow,
        );
        assert!(!blocked.canary_relaxed);
        assert!(!blocked.ready_for_canary);
    }

    #[test]
    fn readiness_state_execute_mode_stays_fail_closed_without_strict_ready() {
        let allow = HashSet::from(["success_criteria_pass_rate".to_string()]);
        let state = readiness_state(
            "execute",
            false,
            &["success_criteria_pass_rate".to_string()],
            true,
            &allow,
        );
        assert!(state.canary_relaxed);
        assert!(state.ready_for_canary);
        assert!(!state.ready_for_execute);
        assert!(!state.effective_ready);
    }

    #[test]
    fn transition_promotes_score_only_to_canary_when_evidence_passes() {
        let policy = base_policy();
        let readiness = ReadinessState {
            strict_ready: true,
            canary_relaxed: false,
            ready_for_canary: true,
            ready_for_execute: true,
            effective_ready: true,
            failed_checks: vec![],
        };
        let canary = CanaryState {
            preview_ready_for_canary: true,
            ready_for_execute: true,
            quality_lock_active: true,
        };
        let streak = StreakState {
            escalate_ready_streak: 2,
            demote_not_ready_streak: 0,
        };

        let tr = decide_transition(
            "score_only",
            &readiness,
            &canary,
            &policy,
            true,
            false,
            &streak,
        )
        .expect("transition");

        assert_eq!(tr.to_mode, "canary_execute");
        assert_eq!(tr.reason, "readiness_pass_promote_canary");
        assert!(!tr.cooldown_exempt);
    }

    #[test]
    fn transition_demotes_execute_when_quality_lock_drops() {
        let policy = base_policy();
        let readiness = ReadinessState {
            strict_ready: true,
            canary_relaxed: false,
            ready_for_canary: true,
            ready_for_execute: true,
            effective_ready: true,
            failed_checks: vec![],
        };
        let canary = CanaryState {
            preview_ready_for_canary: true,
            ready_for_execute: true,
            quality_lock_active: false,
        };
        let streak = StreakState {
            escalate_ready_streak: 0,
            demote_not_ready_streak: 1,
        };

        let tr = decide_transition(
            "execute",
            &readiness,
            &canary,
            &policy,
            true,
            false,
            &streak,
        )
        .expect("transition");

        assert_eq!(tr.to_mode, "canary_execute");
        assert_eq!(tr.reason, "quality_lock_inactive_demote_canary");
        assert!(tr.cooldown_exempt);
    }

    #[test]
    fn transition_requires_escalate_streak_threshold() {
        let policy = base_policy();
        let readiness = ReadinessState {
            strict_ready: true,
            canary_relaxed: false,
            ready_for_canary: true,
            ready_for_execute: true,
            effective_ready: true,
            failed_checks: vec![],
        };
        let canary = CanaryState {
            preview_ready_for_canary: true,
            ready_for_execute: true,
            quality_lock_active: true,
        };
        let streak = StreakState {
            escalate_ready_streak: 1,
            demote_not_ready_streak: 0,
        };

        let tr = decide_transition(
            "score_only",
            &readiness,
            &canary,
            &policy,
            true,
            false,
            &streak,
        );

        assert!(tr.is_none());
    }

    #[test]
    fn transition_blocks_promotion_when_spc_holds_escalation() {
        let policy = base_policy();
        let readiness = ReadinessState {
            strict_ready: true,
            canary_relaxed: false,
            ready_for_canary: true,
            ready_for_execute: true,
            effective_ready: true,
            failed_checks: vec![],
        };
        let canary = CanaryState {
            preview_ready_for_canary: true,
            ready_for_execute: true,
            quality_lock_active: true,
        };
        let streak = StreakState {
            escalate_ready_streak: 5,
            demote_not_ready_streak: 0,
        };

        let tr = decide_transition(
            "score_only",
            &readiness,
            &canary,
            &policy,
            true,
            true,
            &streak,
        );
        assert!(tr.is_none());
    }

    #[test]
    fn transition_skips_demotion_when_policy_disables_demote() {
        let mut policy = base_policy();
        policy.demote_not_ready = false;

        let readiness = ReadinessState {
            strict_ready: false,
            canary_relaxed: false,
            ready_for_canary: false,
            ready_for_execute: false,
            effective_ready: false,
            failed_checks: vec!["verified_rate".to_string()],
        };
        let canary = CanaryState {
            preview_ready_for_canary: false,
            ready_for_execute: false,
            quality_lock_active: false,
        };
        let streak = StreakState {
            escalate_ready_streak: 0,
            demote_not_ready_streak: 10,
        };

        let tr = decide_transition(
            "canary_execute",
            &readiness,
            &canary,
            &policy,
            false,
            false,
            &streak,
        );
        assert!(tr.is_none());
    }

    #[test]
    fn canary_failed_checks_allowed_rejects_blank_entries() {
        let allow = HashSet::from(["success_criteria_pass_rate".to_string()]);
        let failed = vec!["success_criteria_pass_rate".to_string(), "   ".to_string()];
        assert!(!canary_failed_checks_allowed(&failed, &allow));
    }

    #[test]
    fn canary_failed_checks_allowed_fails_closed_for_empty_inputs() {
        let allow = HashSet::from(["success_criteria_pass_rate".to_string()]);
        let failed: Vec<String> = vec![];
        assert!(!canary_failed_checks_allowed(&failed, &allow));

        let allowed_none: HashSet<String> = HashSet::new();
        let failed_one = vec!["success_criteria_pass_rate".to_string()];
        assert!(!canary_failed_checks_allowed(&failed_one, &allowed_none));
    }

    #[test]
    fn transition_canary_promotion_ignores_spc_when_policy_disabled() {
        let mut policy = base_policy();
        policy.require_spc = false;

        let readiness = ReadinessState {
            strict_ready: true,
            canary_relaxed: false,
            ready_for_canary: true,
            ready_for_execute: true,
            effective_ready: true,
            failed_checks: vec![],
        };
        let canary = CanaryState {
            preview_ready_for_canary: true,
            ready_for_execute: true,
            quality_lock_active: true,
        };
        let streak = StreakState {
            escalate_ready_streak: 2,
            demote_not_ready_streak: 0,
        };

        let tr = decide_transition(
            "score_only",
            &readiness,
            &canary,
            &policy,
            false,
            true,
            &streak,
        )
        .expect("transition");
        assert_eq!(tr.to_mode, "canary_execute");
    }

    #[test]
    fn transition_demotes_canary_execute_when_not_ready_and_streak_met() {
        let policy = base_policy();
        let readiness = ReadinessState {
            strict_ready: false,
            canary_relaxed: false,
            ready_for_canary: false,
            ready_for_execute: false,
            effective_ready: false,
            failed_checks: vec!["verified_rate".to_string()],
        };
        let canary = CanaryState {
            preview_ready_for_canary: false,
            ready_for_execute: false,
            quality_lock_active: false,
        };
        let streak = StreakState {
            escalate_ready_streak: 0,
            demote_not_ready_streak: 1,
        };

        let tr = decide_transition(
            "canary_execute",
            &readiness,
            &canary,
            &policy,
            true,
            false,
            &streak,
        )
        .expect("transition");
        assert_eq!(tr.to_mode, "score_only");
        assert_eq!(tr.reason, "readiness_fail_demote_score_only");
        assert!(tr.cooldown_exempt);
    }

    #[test]
    fn transition_execute_skips_quality_lock_demotion_when_not_required() {
        let mut policy = base_policy();
        policy.canary_require_quality_lock_for_execute = false;

        let readiness = ReadinessState {
            strict_ready: true,
            canary_relaxed: false,
            ready_for_canary: true,
            ready_for_execute: true,
            effective_ready: true,
            failed_checks: vec![],
        };
        let canary = CanaryState {
            preview_ready_for_canary: true,
            ready_for_execute: true,
            quality_lock_active: false,
        };
        let streak = StreakState {
            escalate_ready_streak: 0,
            demote_not_ready_streak: 2,
        };

        let tr = decide_transition(
            "execute",
            &readiness,
            &canary,
            &policy,
            true,
            false,
            &streak,
        );
        assert!(tr.is_none());
    }

    #[test]
    fn transition_score_only_zero_min_escalate_still_requires_one_streak() {
        let mut policy = base_policy();
        policy.min_escalate_streak = 0;

        let readiness = ReadinessState {
            strict_ready: true,
            canary_relaxed: false,
            ready_for_canary: true,
            ready_for_execute: true,
            effective_ready: true,
            failed_checks: vec![],
        };
        let canary = CanaryState {
            preview_ready_for_canary: true,
            ready_for_execute: true,
            quality_lock_active: true,
        };
        let streak = StreakState {
            escalate_ready_streak: 0,
            demote_not_ready_streak: 0,
        };

        let tr = decide_transition(
            "score_only",
            &readiness,
            &canary,
            &policy,
            true,
            false,
            &streak,
        );
        assert!(tr.is_none());
    }

    #[test]
    fn transition_execute_zero_min_demote_still_requires_one_streak() {
        let mut policy = base_policy();
        policy.min_demote_streak = 0;

        let readiness = ReadinessState {
            strict_ready: false,
            canary_relaxed: false,
            ready_for_canary: false,
            ready_for_execute: false,
            effective_ready: false,
            failed_checks: vec!["verified_rate".to_string()],
        };
        let canary = CanaryState {
            preview_ready_for_canary: false,
            ready_for_execute: false,
            quality_lock_active: false,
        };
        let streak = StreakState {
            escalate_ready_streak: 0,
            demote_not_ready_streak: 0,
        };

        let tr = decide_transition(
            "execute",
            &readiness,
            &canary,
            &policy,
            true,
            false,
            &streak,
        );
        assert!(tr.is_none());
    }

    #[test]
    fn transition_canary_execute_respects_demote_streak_threshold() {
        let mut policy = base_policy();
        policy.min_demote_streak = 2;

        let readiness = ReadinessState {
            strict_ready: false,
            canary_relaxed: false,
            ready_for_canary: false,
            ready_for_execute: false,
            effective_ready: false,
            failed_checks: vec!["verified_rate".to_string()],
        };
        let canary = CanaryState {
            preview_ready_for_canary: false,
            ready_for_execute: false,
            quality_lock_active: false,
        };
        let streak = StreakState {
            escalate_ready_streak: 0,
            demote_not_ready_streak: 1,
        };

        let tr = decide_transition(
            "canary_execute",
            &readiness,
            &canary,
            &policy,
            true,
            false,
            &streak,
        );
        assert!(tr.is_none());
    }

    #[test]
    fn transition_canary_execute_blocks_promotion_when_spc_fails() {
        let policy = base_policy();
        let readiness = ReadinessState {
            strict_ready: true,
            canary_relaxed: false,
            ready_for_canary: true,
            ready_for_execute: true,
            effective_ready: true,
            failed_checks: vec![],
        };
        let canary = CanaryState {
            preview_ready_for_canary: true,
            ready_for_execute: true,
            quality_lock_active: true,
        };
        let streak = StreakState {
            escalate_ready_streak: 5,
            demote_not_ready_streak: 0,
        };

        let tr = decide_transition(
            "canary_execute",
            &readiness,
            &canary,
            &policy,
            false,
            false,
            &streak,
        );
        assert!(tr.is_none());
    }

    #[test]
    fn readiness_state_trims_and_filters_failed_checks_deterministically() {
        let allow = HashSet::from([
            "success_criteria_pass_rate".to_string(),
            "verified_rate".to_string(),
        ]);
        let state = readiness_state(
            "score_only",
            false,
            &[
                " success_criteria_pass_rate ".to_string(),
                "".to_string(),
                "  ".to_string(),
                "verified_rate".to_string(),
            ],
            true,
            &allow,
        );
        assert_eq!(
            state.failed_checks,
            vec![
                "success_criteria_pass_rate".to_string(),
                "verified_rate".to_string()
            ]
        );
        assert!(state.canary_relaxed);
        assert!(state.ready_for_canary);
    }

    #[test]
    fn transition_unknown_mode_is_fail_closed_no_transition() {
        let policy = base_policy();
        let readiness = ReadinessState {
            strict_ready: true,
            canary_relaxed: false,
            ready_for_canary: true,
            ready_for_execute: true,
            effective_ready: true,
            failed_checks: vec![],
        };
        let canary = CanaryState {
            preview_ready_for_canary: true,
            ready_for_execute: true,
            quality_lock_active: true,
        };
        let streak = StreakState {
            escalate_ready_streak: 10,
            demote_not_ready_streak: 10,
        };

        let tr = decide_transition(
            "unexpected_mode",
            &readiness,
            &canary,
            &policy,
            true,
            false,
            &streak,
        );
        assert!(tr.is_none());
    }

    #[test]
    fn transition_score_only_mode_is_trimmed_before_matching() {
        let policy = base_policy();
        let readiness = ReadinessState {
            strict_ready: true,
            canary_relaxed: false,
            ready_for_canary: true,
            ready_for_execute: true,
            effective_ready: true,
            failed_checks: vec![],
        };
        let canary = CanaryState {
            preview_ready_for_canary: true,
            ready_for_execute: true,
            quality_lock_active: true,
        };
        let streak = StreakState {
            escalate_ready_streak: 3,
            demote_not_ready_streak: 0,
        };

        let tr = decide_transition(
            "  score_only  ",
            &readiness,
            &canary,
            &policy,
            true,
            false,
            &streak,
        )
        .expect("transition");
        assert_eq!(tr.to_mode, "canary_execute");
    }

    #[test]
    fn transition_execute_mode_is_trimmed_before_matching() {
        let policy = base_policy();
        let readiness = ReadinessState {
            strict_ready: false,
            canary_relaxed: false,
            ready_for_canary: false,
            ready_for_execute: false,
            effective_ready: false,
            failed_checks: vec!["verified_rate".to_string()],
        };
        let canary = CanaryState {
            preview_ready_for_canary: false,
            ready_for_execute: false,
            quality_lock_active: true,
        };
        let streak = StreakState {
            escalate_ready_streak: 0,
            demote_not_ready_streak: 2,
        };

        let tr = decide_transition(
            "  execute  ",
            &readiness,
            &canary,
            &policy,
            true,
            false,
            &streak,
        )
        .expect("transition");
        assert_eq!(tr.to_mode, "canary_execute");
        assert_eq!(tr.reason, "readiness_fail_demote_canary");
        assert!(tr.cooldown_exempt);
    }

    #[test]
    fn transition_score_only_skips_when_promote_canary_disabled() {
        let mut policy = base_policy();
        policy.promote_canary = false;

        let readiness = ReadinessState {
            strict_ready: true,
            canary_relaxed: false,
            ready_for_canary: true,
            ready_for_execute: true,
            effective_ready: true,
            failed_checks: vec![],
        };
        let canary = CanaryState {
            preview_ready_for_canary: true,
            ready_for_execute: true,
            quality_lock_active: true,
        };
        let streak = StreakState {
            escalate_ready_streak: 3,
            demote_not_ready_streak: 0,
        };

        let tr = decide_transition(
            "score_only",
            &readiness,
            &canary,
            &policy,
            true,
            false,
            &streak,
        );
        assert!(tr.is_none());
    }

    #[test]
    fn transition_canary_execute_skips_when_promote_execute_disabled() {
        let mut policy = base_policy();
        policy.promote_execute = false;

        let readiness = ReadinessState {
            strict_ready: true,
            canary_relaxed: false,
            ready_for_canary: true,
            ready_for_execute: true,
            effective_ready: true,
            failed_checks: vec![],
        };
        let canary = CanaryState {
            preview_ready_for_canary: true,
            ready_for_execute: true,
            quality_lock_active: true,
        };
        let streak = StreakState {
            escalate_ready_streak: 3,
            demote_not_ready_streak: 0,
        };

        let tr = decide_transition(
            "canary_execute",
            &readiness,
            &canary,
            &policy,
            true,
            false,
            &streak,
        );
        assert!(tr.is_none());
    }

    #[test]
    fn canary_failed_checks_allowed_trims_whitespace_for_allow_match() {
        let allow = HashSet::from(["verified_rate".to_string()]);
        let failed = vec![" verified_rate ".to_string()];
        assert!(canary_failed_checks_allowed(&failed, &allow));
    }

    #[test]
    fn transition_canary_execute_prefers_demotion_when_both_paths_are_true() {
        let policy = base_policy();
        let readiness = ReadinessState {
            strict_ready: true,
            canary_relaxed: false,
            ready_for_canary: false,
            ready_for_execute: true,
            effective_ready: true,
            failed_checks: vec![],
        };
        let canary = CanaryState {
            preview_ready_for_canary: true,
            ready_for_execute: true,
            quality_lock_active: true,
        };
        let streak = StreakState {
            escalate_ready_streak: 5,
            demote_not_ready_streak: 1,
        };

        let tr = decide_transition(
            "canary_execute",
            &readiness,
            &canary,
            &policy,
            true,
            false,
            &streak,
        )
        .expect("transition");
        assert_eq!(tr.to_mode, "score_only");
        assert_eq!(tr.reason, "readiness_fail_demote_score_only");
        assert!(tr.cooldown_exempt);
    }

    #[test]
    fn readiness_state_trims_execute_mode_before_effective_ready_eval() {
        let allow = HashSet::from(["success_criteria_pass_rate".to_string()]);
        let state = readiness_state(
            "  execute  ",
            false,
            &["success_criteria_pass_rate".to_string()],
            true,
            &allow,
        );
        assert!(state.canary_relaxed);
        assert!(state.ready_for_canary);
        assert!(!state.ready_for_execute);
        assert!(!state.effective_ready);
    }

    #[test]
    fn transition_execute_reason_prefers_readiness_when_quality_lock_also_fails() {
        let policy = base_policy();
        let readiness = ReadinessState {
            strict_ready: false,
            canary_relaxed: false,
            ready_for_canary: false,
            ready_for_execute: false,
            effective_ready: false,
            failed_checks: vec!["verified_rate".to_string()],
        };
        let canary = CanaryState {
            preview_ready_for_canary: false,
            ready_for_execute: false,
            quality_lock_active: false,
        };
        let streak = StreakState {
            escalate_ready_streak: 0,
            demote_not_ready_streak: 2,
        };

        let tr = decide_transition(
            "execute",
            &readiness,
            &canary,
            &policy,
            true,
            false,
            &streak,
        )
        .expect("transition");
        assert_eq!(tr.to_mode, "canary_execute");
        assert_eq!(tr.reason, "readiness_fail_demote_canary");
        assert!(tr.cooldown_exempt);
    }

    #[test]
    fn transition_canary_execute_blocks_promotion_when_spc_hold_is_true() {
        let policy = base_policy();
        let readiness = ReadinessState {
            strict_ready: true,
            canary_relaxed: false,
            ready_for_canary: true,
            ready_for_execute: true,
            effective_ready: true,
            failed_checks: vec![],
        };
        let canary = CanaryState {
            preview_ready_for_canary: true,
            ready_for_execute: true,
            quality_lock_active: true,
        };
        let streak = StreakState {
            escalate_ready_streak: 3,
            demote_not_ready_streak: 0,
        };

        let tr = decide_transition(
            "canary_execute",
            &readiness,
            &canary,
            &policy,
            true,
            true,
            &streak,
        );
        assert!(tr.is_none());
    }

    #[test]
    fn transition_execute_stays_put_when_ready_even_with_high_demote_streak() {
        let policy = base_policy();
        let readiness = ReadinessState {
            strict_ready: true,
            canary_relaxed: false,
            ready_for_canary: true,
            ready_for_execute: true,
            effective_ready: true,
            failed_checks: vec![],
        };
        let canary = CanaryState {
            preview_ready_for_canary: true,
            ready_for_execute: true,
            quality_lock_active: true,
        };
        let streak = StreakState {
            escalate_ready_streak: 0,
            demote_not_ready_streak: 99,
        };

        let tr = decide_transition(
            "execute",
            &readiness,
            &canary,
            &policy,
            true,
            false,
            &streak,
        );
        assert!(tr.is_none());
    }

    #[test]
    fn readiness_state_does_not_relax_when_flag_disabled_even_if_checks_allowed() {
        let allow = HashSet::from(["success_criteria_pass_rate".to_string()]);
        let state = readiness_state(
            "score_only",
            false,
            &["success_criteria_pass_rate".to_string()],
            false,
            &allow,
        );
        assert!(!state.canary_relaxed);
        assert!(!state.ready_for_canary);
        assert!(!state.effective_ready);
    }

    #[test]
    fn transition_canary_execute_promotes_when_spc_disabled_even_if_hold_is_true() {
        let mut policy = base_policy();
        policy.require_spc = false;

        let readiness = ReadinessState {
            strict_ready: true,
            canary_relaxed: false,
            ready_for_canary: true,
            ready_for_execute: true,
            effective_ready: true,
            failed_checks: vec![],
        };
        let canary = CanaryState {
            preview_ready_for_canary: true,
            ready_for_execute: true,
            quality_lock_active: true,
        };
        let streak = StreakState {
            escalate_ready_streak: 3,
            demote_not_ready_streak: 0,
        };

        let tr = decide_transition(
            "canary_execute",
            &readiness,
            &canary,
            &policy,
            false,
            true,
            &streak,
        )
        .expect("transition");
        assert_eq!(tr.to_mode, "execute");
        assert_eq!(tr.reason, "canary_metrics_pass_promote_execute");
        assert!(!tr.cooldown_exempt);
    }
}
