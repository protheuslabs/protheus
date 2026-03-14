// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso};
use foundation_hook_enforcer::{
    evaluate_source_hook_coverage, HookCoverageReceipt, CHECK_ID_FOUNDATION_HOOKS,
    CHECK_ID_GUARD_REGISTRY_CONSUMPTION,
};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::process::Command;
use walkdir::WalkDir;

const CHECK_IDS_FLAG_PREFIX: &str = "--rust-contract-check-ids=";
const GUARD_REGISTRY_REL: &str = "client/runtime/config/guard_check_registry.json";
const CONTRACT_CHECK_SOURCE_REL: &str = "core/layer0/ops/src/contract_check.rs";
const RUNTIME_MODE_STATE_REL: &str = "local/state/ops/runtime_mode.json";
const RUST_SOURCE_OF_TRUTH_POLICY_REL: &str =
    "client/runtime/config/rust_source_of_truth_policy.json";
const PROBE_EYES_INTAKE_HELP_TOKENS: &[&str] =
    &["eyes_intake.js", "create", "validate", "list-directives"];
const PROBE_CONFLICT_MARKER_HELP_TOKENS: &[&str] = &["conflict_marker_guard.js", "run", "status"];
const CHECK_ID_RUST_SOURCE_OF_TRUTH: &str = "rust_source_of_truth_contract";
pub const GUARD_REGISTRY_REQUIRED_TOKENS: &[&str] =
    &["guard_check_registry", "required_merge_guard_ids"];
pub const FOUNDATION_HOOK_REQUIRED_TOKENS: &[&str] = &[
    "foundation_contract_gate.js",
    "scale_envelope_baseline.js",
    "simplicity_budget_gate.js",
    "phone_seed_profile.js",
    "surface_budget_controller.js",
    "compression_transfer_plane.js",
    "opportunistic_offload_plane.js",
    "gated_account_creation_organ.js",
    "siem_bridge.js",
    "soc2_type2_track.js",
    "predictive_capacity_forecast.js",
    "execution_sandbox_envelope.js",
    "organ_state_encryption_plane.js",
    "remote_tamper_heartbeat.js",
    "secure_heartbeat_endpoint.js",
    "gated_self_improvement_loop.js",
    "helix_admission_gate.js",
    "venom_containment_layer.js",
    "adaptive_defense_expansion.js",
    "confirmed_malice_quarantine.js",
    "helix_controller.js",
    "ant_colony_controller.js",
    "neural_dormant_seed.js",
    "pre_neuralink_interface.js",
    "client_relationship_manager.js",
    "capital_allocation_organ.js",
    "economic_entity_manager.js",
    "drift_aware_revenue_optimizer.js",
];

pub fn run(root: &Path, args: &[String]) -> i32 {
    let args = with_contract_check_ids(args);
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_usage();
        return 0;
    }

    match execute_contract_checks(root, &args) {
        Ok(mut receipt) => {
            println!("contract_check: OK");
            receipt["receipt_hash"] = Value::String(deterministic_receipt_hash(&receipt));
            println!(
                "{}",
                serde_json::to_string_pretty(&receipt).unwrap_or_else(|_| "{}".to_string())
            );
            0
        }
        Err(error) => {
            eprintln!("contract_check: FAILED");
            eprintln!(" reason: {error}");
            let mut receipt = json!({
                "ok": false,
                "type": "contract_check",
                "error": error,
                "ts": now_iso(),
                "required_check_ids": contract_check_ids_from_args(&args),
            });
            receipt["receipt_hash"] = Value::String(deterministic_receipt_hash(&receipt));
            eprintln!(
                "{}",
                serde_json::to_string_pretty(&receipt).unwrap_or_else(|_| "{}".to_string())
            );
            1
        }
    }
}

pub fn with_contract_check_ids(args: &[String]) -> Vec<String> {
    if args
        .iter()
        .any(|arg| arg.starts_with(CHECK_IDS_FLAG_PREFIX))
    {
        return args.to_vec();
    }

    let mut out = args.to_vec();
    out.push(format!(
        "{CHECK_IDS_FLAG_PREFIX}{}",
        crate::foundation_contract_gate::FOUNDATION_CONTRACT_CHECK_IDS.join(",")
    ));
    out
}

pub fn guard_registry_contract_receipt(source: &str) -> HookCoverageReceipt {
    evaluate_source_hook_coverage(
        CHECK_ID_GUARD_REGISTRY_CONSUMPTION,
        GUARD_REGISTRY_REQUIRED_TOKENS,
        source,
    )
}

pub fn foundation_hook_coverage_receipt(source: &str) -> HookCoverageReceipt {
    evaluate_source_hook_coverage(
        CHECK_ID_FOUNDATION_HOOKS,
        FOUNDATION_HOOK_REQUIRED_TOKENS,
        source,
    )
}

fn print_usage() {
    println!("Usage:");
    println!("  protheus-ops contract-check [status] [--help] [--rust-contract-check-ids=<ids>]");
    println!("Environment:");
    println!("  PROTHEUS_RUNTIME_MODE=dist|source");
    println!("  PROTHEUS_RUNTIME_DIST_REQUIRED=1 (required when mode=dist)");
    println!("  CONTRACT_CHECK_DIST_WRAPPER_STRICT=1 (enable dist wrapper existence checks)");
    println!("  CONTRACT_CHECK_DEEP_PROBES=1 (run runtime help probes)");
}

fn contract_check_ids_from_args(args: &[String]) -> Vec<String> {
    args.iter()
        .find_map(|arg| arg.strip_prefix(CHECK_IDS_FLAG_PREFIX))
        .map(|raw| {
            raw.split(',')
                .map(|id| id.trim())
                .filter(|id| !id.is_empty())
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn should_run_rust_subcheck(selected: &HashSet<String>, id: &str) -> bool {
    selected.is_empty() || selected.contains(CHECK_ID_RUST_SOURCE_OF_TRUTH) || selected.contains(id)
}

fn execute_contract_checks(root: &Path, args: &[String]) -> Result<Value, String> {
    let status_only = args.iter().any(|arg| arg == "status");
    let deep_probes = env_flag("CONTRACT_CHECK_DEEP_PROBES", false);
    let selected_ids = contract_check_ids_from_args(args)
        .into_iter()
        .collect::<HashSet<_>>();
    let mut checks = vec![
        check_dist_runtime_guardrails(root)?,
        check_rust_source_of_truth_contract(root, &selected_ids)?,
        check_guard_registry_contracts(root)?,
        check_source_tokens(
            root,
            CONTRACT_CHECK_SOURCE_REL,
            GUARD_REGISTRY_REQUIRED_TOKENS,
            CHECK_ID_GUARD_REGISTRY_CONSUMPTION,
        )?,
        check_source_tokens(
            root,
            CONTRACT_CHECK_SOURCE_REL,
            FOUNDATION_HOOK_REQUIRED_TOKENS,
            CHECK_ID_FOUNDATION_HOOKS,
        )?,
    ];

    if !status_only && deep_probes {
        checks.push(check_script_help_tokens(
            root,
            "client/runtime/systems/sensory/eyes_intake.js",
            PROBE_EYES_INTAKE_HELP_TOKENS,
        )?);
        checks.push(check_script_help_tokens(
            root,
            "client/runtime/systems/security/conflict_marker_guard.js",
            PROBE_CONFLICT_MARKER_HELP_TOKENS,
        )?);
    }

    Ok(json!({
        "ok": true,
        "type": "contract_check",
        "mode": if status_only { "status" } else { "run" },
        "deep_probes": deep_probes,
        "ts": now_iso(),
        "required_check_ids": contract_check_ids_from_args(args),
        "checks": checks,
    }))
}

fn require_object<'a>(
    value: &'a Value,
    field: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    value
        .get(field)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("rust_source_of_truth_policy_missing_object:{field}"))
}

fn require_rel_path(section: &serde_json::Map<String, Value>, key: &str) -> Result<String, String> {
    let rel = section
        .get(key)
        .and_then(Value::as_str)
        .map(|raw| raw.trim().to_string())
        .unwrap_or_default();
    if rel.is_empty() {
        return Err(format!("rust_source_of_truth_policy_missing_path:{key}"));
    }
    Ok(rel)
}

fn require_string_array(
    section: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Vec<String>, String> {
    let arr = section
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("rust_source_of_truth_policy_missing_array:{key}"))?;
    let values = arr
        .iter()
        .filter_map(Value::as_str)
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .collect::<Vec<_>>();
    if values.is_empty() {
        return Err(format!("rust_source_of_truth_policy_empty_array:{key}"));
    }
    Ok(values)
}

fn check_required_tokens_at_path(
    root: &Path,
    rel_path: &str,
    required_tokens: &[String],
    context: &str,
) -> Result<(), String> {
    let path = root.join(rel_path);
    let source = fs::read_to_string(&path)
        .map_err(|err| format!("read_source_failed:{}:{err}", path.display()))?;
    let missing = missing_tokens(&source, required_tokens);
    if !missing.is_empty() {
        return Err(format!(
            "missing_source_tokens:{}:{}:{}",
            context,
            rel_path,
            missing.join(",")
        ));
    }
    Ok(())
}

fn check_rust_source_of_truth_contract(
    root: &Path,
    selected: &HashSet<String>,
) -> Result<Value, String> {
    let policy_path = root.join(RUST_SOURCE_OF_TRUTH_POLICY_REL);
    let raw = fs::read_to_string(&policy_path).map_err(|err| {
        format!(
            "read_rust_source_of_truth_policy_failed:{}:{err}",
            policy_path.display()
        )
    })?;
    let policy = serde_json::from_str::<Value>(&raw).map_err(|err| {
        format!(
            "parse_rust_source_of_truth_policy_failed:{}:{err}",
            policy_path.display()
        )
    })?;

    let run_entrypoint = should_run_rust_subcheck(selected, "rust_entrypoint_gate");
    let run_conduit = should_run_rust_subcheck(selected, "conduit_strict_gate");
    let run_conduit_budget = should_run_rust_subcheck(selected, "conduit_budget_gate");
    let run_status_dashboard = should_run_rust_subcheck(selected, "status_dashboard_gate");
    let run_js_wrapper = should_run_rust_subcheck(selected, "js_wrapper_contract");
    let run_rust_shim = should_run_rust_subcheck(selected, "rust_shim_contract");
    let run_primitive_wrapper = should_run_rust_subcheck(selected, "primitive_ts_wrapper_contract");

    let mut entrypoint_path: Option<String> = None;
    if run_entrypoint {
        let entrypoint_gate = require_object(&policy, "rust_entrypoint_gate")?;
        let path = require_rel_path(entrypoint_gate, "path")?;
        let tokens = require_string_array(entrypoint_gate, "required_tokens")?;
        if !path.ends_with(".rs") {
            return Err(format!(
                "rust_source_of_truth_path_extension_mismatch:rust_entrypoint_gate:{path}"
            ));
        }
        check_required_tokens_at_path(root, &path, &tokens, "rust_entrypoint_gate")?;
        entrypoint_path = Some(path);
    }

    let mut conduit_path: Option<String> = None;
    if run_conduit {
        let conduit_gate = require_object(&policy, "conduit_strict_gate")?;
        let path = require_rel_path(conduit_gate, "path")?;
        let tokens = require_string_array(conduit_gate, "required_tokens")?;
        if !path.ends_with(".ts") {
            return Err(format!(
                "rust_source_of_truth_path_extension_mismatch:conduit_strict_gate:{path}"
            ));
        }
        check_required_tokens_at_path(root, &path, &tokens, "conduit_strict_gate")?;
        conduit_path = Some(path);
    }

    let mut conduit_budget_path: Option<String> = None;
    if run_conduit_budget {
        let conduit_budget_gate = require_object(&policy, "conduit_budget_gate")?;
        let path = require_rel_path(conduit_budget_gate, "path")?;
        let tokens = require_string_array(conduit_budget_gate, "required_tokens")?;
        if !path.ends_with(".rs") {
            return Err(format!(
                "rust_source_of_truth_path_extension_mismatch:conduit_budget_gate:{path}"
            ));
        }
        check_required_tokens_at_path(root, &path, &tokens, "conduit_budget_gate")?;
        conduit_budget_path = Some(path);
    }

    let mut status_dashboard_path: Option<String> = None;
    if run_status_dashboard {
        let status_dashboard_gate = require_object(&policy, "status_dashboard_gate")?;
        let path = require_rel_path(status_dashboard_gate, "path")?;
        let tokens = require_string_array(status_dashboard_gate, "required_tokens")?;
        if !path.ends_with(".ts") {
            return Err(format!(
                "rust_source_of_truth_path_extension_mismatch:status_dashboard_gate:{path}"
            ));
        }
        check_required_tokens_at_path(root, &path, &tokens, "status_dashboard_gate")?;
        status_dashboard_path = Some(path);
    }

    let mut wrapper_paths_checked = 0usize;
    if run_js_wrapper {
        let wrapper_contract = require_object(&policy, "js_wrapper_contract")?;
        let wrapper_paths = require_string_array(wrapper_contract, "required_wrapper_paths")?;
        for rel in &wrapper_paths {
            if !rel.ends_with(".js") {
                return Err(format!("required_wrapper_must_be_js:{rel}"));
            }
            let path = root.join(rel);
            let source = fs::read_to_string(&path)
                .map_err(|err| format!("read_wrapper_failed:{}:{err}", path.display()))?;
            if !is_ts_bootstrap_wrapper(&source) {
                return Err(format!("required_wrapper_not_bootstrap:{rel}"));
            }
        }
        wrapper_paths_checked = wrapper_paths.len();
    }

    let mut rust_shim_checked = 0usize;
    if run_rust_shim {
        let rust_shim_contract = require_object(&policy, "rust_shim_contract")?;
        let rust_shim_entries = rust_shim_contract
            .get("entries")
            .and_then(Value::as_array)
            .ok_or_else(|| "rust_source_of_truth_policy_missing_array:entries".to_string())?;
        if rust_shim_entries.is_empty() {
            return Err("rust_source_of_truth_policy_empty_array:entries".to_string());
        }
        for entry in rust_shim_entries {
            let section = entry
                .as_object()
                .ok_or_else(|| "rust_source_of_truth_policy_invalid_entry:entries".to_string())?;
            let shim_path = require_rel_path(section, "path")?;
            if !shim_path.ends_with(".js") {
                return Err(format!("rust_shim_must_be_js:{shim_path}"));
            }
            let shim_tokens = require_string_array(section, "required_tokens")?;
            check_required_tokens_at_path(root, &shim_path, &shim_tokens, "rust_shim_contract")?;
            rust_shim_checked += 1;
        }
    }

    let mut primitive_ts_wrappers_checked = 0usize;
    if run_primitive_wrapper {
        let primitive_wrapper_contract = require_object(&policy, "primitive_ts_wrapper_contract")?;
        let primitive_wrapper_entries = primitive_wrapper_contract
            .get("entries")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                "rust_source_of_truth_policy_missing_array:primitive_ts_wrapper_contract.entries"
                    .to_string()
            })?;
        if primitive_wrapper_entries.is_empty() {
            return Err(
                "rust_source_of_truth_policy_empty_array:primitive_ts_wrapper_contract.entries"
                    .to_string(),
            );
        }

        for entry in primitive_wrapper_entries {
            let section = entry.as_object().ok_or_else(|| {
                "rust_source_of_truth_policy_invalid_entry:primitive_ts_wrapper_contract.entries"
                    .to_string()
            })?;
            let wrapper_path = require_rel_path(section, "path")?;
            if !wrapper_path.ends_with(".ts") {
                return Err(format!("primitive_ts_wrapper_must_be_ts:{wrapper_path}"));
            }

            let required_tokens = require_string_array(section, "required_tokens")?;
            check_required_tokens_at_path(
                root,
                &wrapper_path,
                &required_tokens,
                "primitive_ts_wrapper_contract",
            )?;

            let forbidden_tokens = section
                .get("forbidden_tokens")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(Value::as_str)
                        .map(|row| row.trim().to_string())
                        .filter(|row| !row.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            if !forbidden_tokens.is_empty() {
                let wrapper_source =
                    fs::read_to_string(root.join(&wrapper_path)).map_err(|err| {
                        format!(
                            "read_source_failed:{}:{err}",
                            root.join(&wrapper_path).display()
                        )
                    })?;
                let found_forbidden = forbidden_tokens
                    .iter()
                    .filter(|token| wrapper_source.contains(token.as_str()))
                    .cloned()
                    .collect::<Vec<_>>();
                if !found_forbidden.is_empty() {
                    return Err(format!(
                        "forbidden_source_tokens:primitive_ts_wrapper_contract:{}:{}",
                        wrapper_path,
                        found_forbidden.join(",")
                    ));
                }
            }

            primitive_ts_wrappers_checked += 1;
        }
    }

    let mut ts_surface_allowlist_prefixes: Vec<String> = Vec::new();
    if run_conduit || run_status_dashboard {
        ts_surface_allowlist_prefixes = policy
            .get("ts_surface_allowlist_prefixes")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                "rust_source_of_truth_policy_missing_array:ts_surface_allowlist_prefixes"
                    .to_string()
            })?
            .iter()
            .filter_map(Value::as_str)
            .map(|row| row.trim().to_string())
            .filter(|row| !row.is_empty())
            .collect::<Vec<_>>();
        if ts_surface_allowlist_prefixes.is_empty() {
            return Err(
                "rust_source_of_truth_policy_empty_array:ts_surface_allowlist_prefixes".to_string(),
            );
        }

        let mut ts_paths_to_validate: Vec<String> = Vec::new();
        if let Some(path) = conduit_path.clone() {
            ts_paths_to_validate.push(path);
        }
        if let Some(path) = status_dashboard_path.clone() {
            ts_paths_to_validate.push(path);
        }
        for ts_path in ts_paths_to_validate {
            let allowed = ts_surface_allowlist_prefixes
                .iter()
                .any(|prefix| ts_path.starts_with(prefix));
            if !allowed {
                return Err(format!(
                    "ts_path_outside_surface_allowlist:{ts_path}:{}",
                    ts_surface_allowlist_prefixes.join(",")
                ));
            }
        }
    }

    let mut scoped_check_ids = selected.iter().cloned().collect::<Vec<_>>();
    scoped_check_ids.sort();

    Ok(json!({
        "id": CHECK_ID_RUST_SOURCE_OF_TRUTH,
        "ok": true,
        "policy_path": RUST_SOURCE_OF_TRUTH_POLICY_REL,
        "entrypoint_path": entrypoint_path,
        "conduit_path": conduit_path,
        "conduit_budget_path": conduit_budget_path,
        "status_dashboard_path": status_dashboard_path,
        "wrapper_paths_checked": wrapper_paths_checked,
        "rust_shims_checked": rust_shim_checked,
        "primitive_ts_wrappers_checked": primitive_ts_wrappers_checked,
        "ts_surface_allowlist_prefixes": ts_surface_allowlist_prefixes,
        "scoped_check_ids": scoped_check_ids,
    }))
}

fn env_flag(name: &str, fallback: bool) -> bool {
    let Ok(raw) = std::env::var(name) else {
        return fallback;
    };
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn check_source_tokens(
    root: &Path,
    rel_path: &str,
    required_tokens: &[&str],
    check_id: &str,
) -> Result<Value, String> {
    let path = root.join(rel_path);
    let source = resolve_contract_source(&path)?;
    let tokens = required_tokens
        .iter()
        .map(|token| token.to_string())
        .collect::<Vec<_>>();
    let missing = missing_tokens(&source, &tokens);
    if !missing.is_empty() {
        return Err(format!(
            "missing_source_tokens:{}:{}",
            rel_path,
            missing.join(",")
        ));
    }

    Ok(json!({
        "id": check_id,
        "ok": true,
        "path": rel_path,
        "required_tokens": required_tokens.len(),
    }))
}

fn resolve_contract_source(path: &Path) -> Result<String, String> {
    let source = fs::read_to_string(path)
        .map_err(|err| format!("read_source_failed:{}:{err}", path.display()))?;
    if !is_ts_bootstrap_wrapper(&source) {
        return Ok(source);
    }
    if path.extension().and_then(|ext| ext.to_str()) != Some("js") {
        return Ok(source);
    }
    let ts_path = path.with_extension("ts");
    if !ts_path.exists() {
        return Ok(source);
    }
    fs::read_to_string(&ts_path).map_err(|err| {
        format!(
            "read_bootstrap_ts_source_failed:{}:{err}",
            ts_path.display()
        )
    })
}

fn is_ts_bootstrap_wrapper(source: &str) -> bool {
    let mut normalized = source.replace("\r\n", "\n");
    if normalized.starts_with("#!") {
        if let Some((_, rest)) = normalized.split_once('\n') {
            normalized = rest.to_string();
        }
    }
    let trimmed = normalized.trim();
    let without_use_strict = trimmed
        .strip_prefix("\"use strict\";")
        .or_else(|| trimmed.strip_prefix("'use strict';"))
        .unwrap_or(trimmed)
        .trim();
    without_use_strict.contains("ts_bootstrap")
        && without_use_strict.contains(".bootstrap(__filename, module)")
}

fn effective_runtime_mode(root: &Path) -> String {
    let env_mode = std::env::var("PROTHEUS_RUNTIME_MODE")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if env_mode == "dist" || env_mode == "source" {
        return env_mode;
    }

    let state_path = std::env::var("PROTHEUS_RUNTIME_MODE_STATE_PATH")
        .map(|v| root.join(v))
        .unwrap_or_else(|_| root.join(RUNTIME_MODE_STATE_REL));
    let Ok(raw) = fs::read_to_string(&state_path) else {
        return "source".to_string();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return "source".to_string();
    };
    let mode = parsed
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("source")
        .trim()
        .to_ascii_lowercase();
    if mode == "dist" || mode == "source" {
        return mode;
    }
    "source".to_string()
}

fn check_dist_runtime_guardrails(root: &Path) -> Result<Value, String> {
    let mode = effective_runtime_mode(root);
    if mode != "dist" {
        return Ok(json!({
            "id": "dist_runtime_guardrails",
            "ok": true,
            "mode": mode,
            "strict_wrapper_check": false,
            "wrappers_checked": 0,
        }));
    }

    if std::env::var("PROTHEUS_RUNTIME_DIST_REQUIRED").unwrap_or_default() != "1" {
        return Err(
            "dist_mode_requires_PROTHEUS_RUNTIME_DIST_REQUIRED=1_to_prevent_source_fallback"
                .to_string(),
        );
    }

    if !env_flag("CONTRACT_CHECK_DIST_WRAPPER_STRICT", false) {
        return Ok(json!({
            "id": "dist_runtime_guardrails",
            "ok": true,
            "mode": mode,
            "strict_wrapper_check": false,
            "wrappers_checked": 0,
        }));
    }

    let mut wrappers_checked = 0usize;
    let mut missing = Vec::<String>::new();
    for root_dir in ["systems", "lib"] {
        let walk_root = root.join(root_dir);
        if !walk_root.exists() {
            continue;
        }
        for entry in WalkDir::new(&walk_root)
            .into_iter()
            .filter_entry(|entry| {
                let name = entry.file_name().to_string_lossy();
                name != "node_modules" && name != ".git" && name != "dist"
            })
            .flatten()
        {
            if !entry.file_type().is_file() {
                continue;
            }
            if entry.path().extension().and_then(|ext| ext.to_str()) != Some("js") {
                continue;
            }
            let Ok(source) = fs::read_to_string(entry.path()) else {
                continue;
            };
            if !is_ts_bootstrap_wrapper(&source) {
                continue;
            }
            wrappers_checked += 1;
            let Ok(rel) = entry.path().strip_prefix(root) else {
                continue;
            };
            let dist_path = root.join("dist").join(rel);
            if !dist_path.exists() {
                missing.push(rel.to_string_lossy().to_string());
            }
        }
    }

    if !missing.is_empty() {
        missing.sort();
        return Err(format!(
            "missing_dist_wrappers:{}:{}",
            missing.len(),
            missing
                .iter()
                .take(10)
                .cloned()
                .collect::<Vec<_>>()
                .join(",")
        ));
    }

    Ok(json!({
        "id": "dist_runtime_guardrails",
        "ok": true,
        "mode": mode,
        "strict_wrapper_check": true,
        "wrappers_checked": wrappers_checked,
    }))
}

fn check_guard_registry_contracts(root: &Path) -> Result<Value, String> {
    let path = root.join(GUARD_REGISTRY_REL);
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("read_guard_registry_failed:{}:{err}", path.display()))?;
    let parsed = serde_json::from_str::<Value>(&raw)
        .map_err(|err| format!("parse_guard_registry_failed:{}:{err}", path.display()))?;
    let checks = parsed
        .pointer("/merge_guard/checks")
        .and_then(Value::as_array)
        .ok_or_else(|| "guard_registry_missing_merge_guard_checks".to_string())?;

    let mut merge_guard_ids = HashSet::<String>::new();
    let mut node_script_count = 0usize;
    for check in checks {
        if let Some(id) = check.get("id").and_then(Value::as_str) {
            let id = id.trim();
            if !id.is_empty() {
                merge_guard_ids.insert(id.to_string());
            }
        }
        if check.get("command").and_then(Value::as_str) != Some("node") {
            continue;
        }
        let rel_script = check
            .get("args")
            .and_then(Value::as_array)
            .and_then(|args| args.first())
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if rel_script.is_empty() {
            return Err("guard_registry_node_check_missing_script_path".to_string());
        }
        let script_path = root.join(&rel_script);
        if !script_path.exists() {
            return Err(format!(
                "guard_registry_missing_script:{}:{}",
                check.get("id").and_then(Value::as_str).unwrap_or("unknown"),
                rel_script
            ));
        }
        node_script_count += 1;
    }

    let required_ids = parsed
        .pointer("/contract_check/required_merge_guard_ids")
        .and_then(Value::as_array)
        .ok_or_else(|| "guard_registry_missing_contract_check_required_ids".to_string())?
        .iter()
        .filter_map(Value::as_str)
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();

    let mut missing_ids = required_ids
        .iter()
        .filter(|id| !merge_guard_ids.contains((*id).as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !missing_ids.is_empty() {
        missing_ids.sort();
        return Err(format!(
            "required_merge_guard_ids_missing:{}",
            missing_ids.join(",")
        ));
    }

    Ok(json!({
        "id": "guard_registry_contracts",
        "ok": true,
        "required_merge_guard_ids": required_ids,
        "node_script_checks": node_script_count,
    }))
}

fn check_script_help_tokens(
    root: &Path,
    rel_path: &str,
    required_tokens: &[&str],
) -> Result<Value, String> {
    let script_path = root.join(rel_path);
    if !script_path.exists() {
        return Err(format!("missing_probe_script:{rel_path}"));
    }
    let node_bin = std::env::var("PROTHEUS_NODE_BINARY").unwrap_or_else(|_| "node".to_string());
    let output = Command::new(&node_bin)
        .arg(&script_path)
        .arg("--help")
        .current_dir(root)
        .output()
        .map_err(|err| format!("probe_spawn_failed:{rel_path}:{err}"))?;

    let mut text = String::new();
    text.push_str(&String::from_utf8_lossy(&output.stdout));
    text.push(' ');
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    let tokens = required_tokens
        .iter()
        .map(|token| token.to_string())
        .collect::<Vec<_>>();
    let missing = missing_tokens(&text, &tokens);
    if !output.status.success() || !missing.is_empty() {
        return Err(format!(
            "probe_failed:{}:exit={}:missing={}",
            rel_path,
            output.status.code().unwrap_or(1),
            missing.join(",")
        ));
    }

    Ok(json!({
        "id": format!("probe:{rel_path}"),
        "ok": true,
        "path": rel_path,
        "required_tokens": required_tokens.len(),
    }))
}

fn compact_json_spacing(token: &str) -> String {
    let mut out = String::with_capacity(token.len());
    let mut chars = token.chars().peekable();
    while let Some(ch) = chars.next() {
        out.push(ch);
        if ch == ':' && out.ends_with("\":") {
            while let Some(next) = chars.peek() {
                if next.is_whitespace() {
                    chars.next();
                } else {
                    break;
                }
            }
        }
    }
    out
}

pub fn missing_tokens(text: &str, tokens: &[String]) -> Vec<String> {
    let mut missing = Vec::new();
    for token in tokens {
        if text.contains(token) {
            continue;
        }
        let compact_json_token = compact_json_spacing(token);
        if compact_json_token != *token && text.contains(&compact_json_token) {
            continue;
        }
        missing.push(token.clone());
    }
    missing
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_json_spacing_only_compacts_key_colon_whitespace() {
        let token = r#""schema":   {"id": "x"} value:  keep"#;
        let compacted = compact_json_spacing(token);
        assert_eq!(compacted, r#""schema":{"id":"x"} value:  keep"#);
    }

    #[test]
    fn injects_contract_check_ids_when_missing() {
        let args = vec!["run".to_string()];
        let resolved = with_contract_check_ids(&args);
        assert_eq!(resolved.len(), 2);
        assert!(resolved[1].starts_with(CHECK_IDS_FLAG_PREFIX));
        assert!(resolved[1].contains("burn_oracle_budget_gate"));
        assert!(resolved[1].contains("persona_dispatch_security_gate"));
    }

    #[test]
    fn respects_existing_contract_check_id_flag() {
        let args = vec![
            "run".to_string(),
            format!("{CHECK_IDS_FLAG_PREFIX}already-set"),
        ];
        let resolved = with_contract_check_ids(&args);
        assert_eq!(resolved, args);
    }

    #[test]
    fn missing_tokens_accepts_compact_json_variant() {
        let text = r#"{"schema":{"id":"x"}}"#;
        let tokens = vec!["\"schema\": {".to_string()];
        let missing = missing_tokens(text, &tokens);
        assert!(missing.is_empty());
    }

    #[test]
    fn missing_tokens_reports_absent_tokens() {
        let text = "usage run --help";
        let tokens = vec!["status".to_string(), "run".to_string()];
        let missing = missing_tokens(text, &tokens);
        assert_eq!(missing, vec!["status".to_string()]);
    }

    #[test]
    fn missing_tokens_preserves_missing_order() {
        let text = "run --help";
        let tokens = vec![
            "status".to_string(),
            "run".to_string(),
            "contract".to_string(),
        ];
        let missing = missing_tokens(text, &tokens);
        assert_eq!(missing, vec!["status".to_string(), "contract".to_string()]);
    }

    #[test]
    fn missing_tokens_does_not_loosen_non_json_colon_spacing() {
        let text = "value: keep";
        let tokens = vec!["value:  keep".to_string()];
        let missing = missing_tokens(text, &tokens);
        assert_eq!(missing, vec!["value:  keep".to_string()]);
    }

    #[test]
    fn missing_tokens_accepts_multiple_compacted_json_tokens() {
        let text = r#"{"schema":{"id":"x","checks":[1,2]}}"#;
        let tokens = vec![
            "\"schema\": {".to_string(),
            "\"id\":   \"x\"".to_string(),
            "\"checks\":   [1,2]".to_string(),
        ];
        let missing = missing_tokens(text, &tokens);
        assert!(missing.is_empty());
    }

    #[test]
    fn compact_json_spacing_removes_all_whitespace_after_json_key_colon() {
        let token = "\"schema\":\n\t  {\"id\":\n \"x\"}";
        let compacted = compact_json_spacing(token);
        assert_eq!(compacted, "\"schema\":{\"id\":\"x\"}");
    }

    #[test]
    fn missing_tokens_treats_empty_token_as_present_like_str_contains() {
        let text = "anything";
        let tokens = vec!["".to_string(), "absent".to_string()];
        let missing = missing_tokens(text, &tokens);
        assert_eq!(missing, vec!["absent".to_string()]);
    }

    #[test]
    fn compact_json_spacing_leaves_non_json_colon_patterns_untouched() {
        let token = "url:http://example.com key: value";
        let compacted = compact_json_spacing(token);
        assert_eq!(compacted, token);
    }

    #[test]
    fn missing_tokens_preserves_duplicate_missing_entries() {
        let text = "run";
        let tokens = vec![
            "missing".to_string(),
            "run".to_string(),
            "missing".to_string(),
        ];
        let missing = missing_tokens(text, &tokens);
        assert_eq!(missing, vec!["missing".to_string(), "missing".to_string()]);
    }

    #[test]
    fn guard_registry_contract_receipt_matches_expected_tokens() {
        let source = "guard_check_registry required_merge_guard_ids";
        let receipt = guard_registry_contract_receipt(source);
        assert!(receipt.ok);
        assert!(!receipt.fail_closed);
        assert!(receipt.missing_hooks.is_empty());
    }

    #[test]
    fn foundation_hook_coverage_receipt_detects_missing_tokens() {
        let source = "foundation_contract_gate.js";
        let receipt = foundation_hook_coverage_receipt(source);
        assert!(!receipt.ok);
        assert!(!receipt.fail_closed);
        assert!(!receipt.missing_hooks.is_empty());
        assert!(receipt
            .missing_hooks
            .contains(&"scale_envelope_baseline.js".to_string()));
    }

    #[test]
    fn foundation_hook_coverage_receipt_succeeds_when_all_hooks_are_present() {
        let source = FOUNDATION_HOOK_REQUIRED_TOKENS.join(" ");
        let receipt = foundation_hook_coverage_receipt(&source);
        assert!(receipt.ok);
        assert_eq!(
            receipt.observed_hooks.len(),
            FOUNDATION_HOOK_REQUIRED_TOKENS.len()
        );
    }
}
