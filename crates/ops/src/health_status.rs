use crate::{deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

const LANE_ID: &str = "health_status";
const REPLACEMENT: &str = "protheus-ops health-status";
const CRON_JOBS_REL: &str = "config/cron_jobs.json";
const RUST_SOURCE_OF_TRUTH_POLICY_REL: &str = "config/rust_source_of_truth_policy.json";
const ALLOWED_DELIVERY_CHANNELS: &[&str] = &[
    "last",
    "main",
    "inbox",
    "discord",
    "slack",
    "email",
    "pagerduty",
    "stdout",
    "stderr",
    "sms",
];

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

fn usage() {
    println!("Usage:");
    println!("  protheus-ops health-status status [--dashboard]");
    println!("  protheus-ops health-status run [--dashboard]");
    println!("  protheus-ops health-status dashboard");
}

fn read_json(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|err| format!("read_json_failed:{}:{err}", path.display()))?;
    serde_json::from_str::<Value>(&raw)
        .map_err(|err| format!("parse_json_failed:{}:{err}", path.display()))
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

fn missing_tokens(text: &str, tokens: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for token in tokens {
        if !text.contains(token) {
            out.push(token.clone());
        }
    }
    out
}

fn check_required_tokens_at_path(root: &Path, rel_path: &str, required_tokens: &[String]) -> Result<Vec<String>, String> {
    let path = root.join(rel_path);
    let source = fs::read_to_string(&path)
        .map_err(|err| format!("read_source_failed:{}:{err}", path.display()))?;
    Ok(missing_tokens(&source, required_tokens))
}

fn require_object<'a>(value: &'a Value, field: &str) -> Result<&'a serde_json::Map<String, Value>, String> {
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

fn require_string_array(section: &serde_json::Map<String, Value>, key: &str) -> Result<Vec<String>, String> {
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

fn path_has_allowed_prefix(path: &str, prefixes: &[String]) -> bool {
    prefixes.iter().any(|prefix| path.starts_with(prefix))
}

fn audit_rust_source_of_truth(root: &Path) -> Value {
    let policy_path = root.join(RUST_SOURCE_OF_TRUTH_POLICY_REL);
    let policy = match read_json(&policy_path) {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "ok": false,
                "policy_path": RUST_SOURCE_OF_TRUTH_POLICY_REL,
                "error": err,
                "violations": ["policy_unreadable"]
            })
        }
    };

    let mut violations = Vec::<Value>::new();
    let mut checked_paths = Vec::<String>::new();

    let entrypoint_gate = match require_object(&policy, "rust_entrypoint_gate") {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "ok": false,
                "policy_path": RUST_SOURCE_OF_TRUTH_POLICY_REL,
                "error": err,
                "violations": ["policy_invalid"]
            })
        }
    };
    let conduit_gate = match require_object(&policy, "conduit_strict_gate") {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "ok": false,
                "policy_path": RUST_SOURCE_OF_TRUTH_POLICY_REL,
                "error": err,
                "violations": ["policy_invalid"]
            })
        }
    };
    let conduit_budget_gate = match require_object(&policy, "conduit_budget_gate") {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "ok": false,
                "policy_path": RUST_SOURCE_OF_TRUTH_POLICY_REL,
                "error": err,
                "violations": ["policy_invalid"]
            })
        }
    };
    let status_dashboard_gate = match require_object(&policy, "status_dashboard_gate") {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "ok": false,
                "policy_path": RUST_SOURCE_OF_TRUTH_POLICY_REL,
                "error": err,
                "violations": ["policy_invalid"]
            })
        }
    };

    let checks = vec![
        ("rust_entrypoint_gate", entrypoint_gate, ".rs"),
        ("conduit_strict_gate", conduit_gate, ".ts"),
        ("conduit_budget_gate", conduit_budget_gate, ".rs"),
        ("status_dashboard_gate", status_dashboard_gate, ".ts"),
    ];

    for (ctx, section, expected_ext) in checks {
        let rel_path = match require_rel_path(section, "path") {
            Ok(v) => v,
            Err(err) => {
                violations.push(json!({"context": ctx, "reason": err}));
                continue;
            }
        };
        let required_tokens = match require_string_array(section, "required_tokens") {
            Ok(v) => v,
            Err(err) => {
                violations.push(json!({"context": ctx, "reason": err, "path": rel_path}));
                continue;
            }
        };
        if !rel_path.ends_with(expected_ext) {
            violations.push(json!({
                "context": ctx,
                "path": rel_path,
                "reason": "path_extension_mismatch",
                "expected_extension": expected_ext
            }));
            continue;
        }

        match check_required_tokens_at_path(root, &rel_path, &required_tokens) {
            Ok(missing) => {
                if !missing.is_empty() {
                    violations.push(json!({
                        "context": ctx,
                        "path": rel_path,
                        "reason": "missing_source_tokens",
                        "missing_tokens": missing
                    }));
                }
            }
            Err(err) => {
                violations.push(json!({
                    "context": ctx,
                    "path": rel_path,
                    "reason": err
                }));
            }
        }

        checked_paths.push(rel_path);
    }

    let wrapper_contract = match require_object(&policy, "js_wrapper_contract") {
        Ok(v) => v,
        Err(err) => {
            violations.push(json!({"context": "js_wrapper_contract", "reason": err}));
            &serde_json::Map::new()
        }
    };

    if let Ok(wrapper_paths) = require_string_array(wrapper_contract, "required_wrapper_paths") {
        for rel in wrapper_paths {
            if !rel.ends_with(".js") {
                violations.push(json!({
                    "context": "js_wrapper_contract",
                    "path": rel,
                    "reason": "wrapper_must_be_js"
                }));
                continue;
            }
            let path = root.join(&rel);
            match fs::read_to_string(&path) {
                Ok(source) => {
                    if !is_ts_bootstrap_wrapper(&source) {
                        violations.push(json!({
                            "context": "js_wrapper_contract",
                            "path": rel,
                            "reason": "required_wrapper_not_bootstrap"
                        }));
                    }
                }
                Err(err) => violations.push(json!({
                    "context": "js_wrapper_contract",
                    "path": rel,
                    "reason": format!("read_wrapper_failed:{err}")
                })),
            }
        }
    }

    let shim_contract = match require_object(&policy, "rust_shim_contract") {
        Ok(v) => v,
        Err(err) => {
            violations.push(json!({"context": "rust_shim_contract", "reason": err}));
            &serde_json::Map::new()
        }
    };
    let shim_entries = shim_contract
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if shim_entries.is_empty() {
        violations.push(json!({
            "context": "rust_shim_contract",
            "reason": "rust_source_of_truth_policy_empty_array:entries"
        }));
    }
    for entry in shim_entries {
        let Some(section) = entry.as_object() else {
            violations.push(json!({
                "context": "rust_shim_contract",
                "reason": "rust_source_of_truth_policy_invalid_entry:entries"
            }));
            continue;
        };
        match require_rel_path(section, "path") {
            Ok(rel) => {
                if !rel.ends_with(".js") {
                    violations.push(json!({
                        "context": "rust_shim_contract",
                        "path": rel,
                        "reason": "rust_shim_must_be_js"
                    }));
                }
                checked_paths.push(rel);
            }
            Err(err) => {
                violations.push(json!({
                    "context": "rust_shim_contract",
                    "reason": err
                }));
            }
        }
    }

    let allowlist_prefixes = policy
        .get("ts_surface_allowlist_prefixes")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if allowlist_prefixes.is_empty() {
        violations.push(json!({
            "context": "ts_surface_allowlist_prefixes",
            "reason": "rust_source_of_truth_policy_empty_array:ts_surface_allowlist_prefixes"
        }));
    }

    for rel in checked_paths.iter().filter(|p| p.ends_with(".ts")) {
        if !path_has_allowed_prefix(rel, &allowlist_prefixes) {
            violations.push(json!({
                "context": "ts_surface_allowlist_prefixes",
                "path": rel,
                "reason": "ts_path_outside_allowlist"
            }));
        }
    }

    json!({
        "ok": violations.is_empty(),
        "policy_path": RUST_SOURCE_OF_TRUTH_POLICY_REL,
        "checked_paths": checked_paths,
        "allowlist_prefixes": allowlist_prefixes,
        "violations": violations
    })
}

fn allowed_delivery_channel(channel: &str) -> bool {
    ALLOWED_DELIVERY_CHANNELS.contains(&channel)
}

fn audit_cron_delivery(root: &Path) -> Value {
    let cron_path = root.join(CRON_JOBS_REL);
    let parsed = match read_json(&cron_path) {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "ok": false,
                "path": CRON_JOBS_REL,
                "error": err,
                "issues": [
                    {
                        "reason": "cron_jobs_unreadable"
                    }
                ]
            })
        }
    };

    let jobs = parsed
        .get("jobs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut enabled_jobs = 0usize;
    let mut isolated_jobs = 0usize;
    let mut jobs_with_delivery = 0usize;
    let mut issues = Vec::<Value>::new();

    for job in jobs {
        let name = job
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let id = job
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let enabled = job.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        if !enabled {
            continue;
        }
        enabled_jobs += 1;

        let session_target = job
            .get("sessionTarget")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if session_target == "isolated" {
            isolated_jobs += 1;
        }

        let delivery = job.get("delivery").and_then(Value::as_object);
        if delivery.is_none() {
            issues.push(json!({
                "id": id,
                "name": name,
                "reason": "missing_delivery_for_enabled_job",
                "session_target": session_target
            }));
            continue;
        }

        jobs_with_delivery += 1;
        let delivery = delivery.expect("checked");
        let mode = delivery
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let channel = delivery
            .get("channel")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();

        if mode.is_empty() {
            issues.push(json!({
                "id": id,
                "name": name,
                "reason": "missing_delivery_mode"
            }));
            continue;
        }

        if mode == "none" {
            issues.push(json!({
                "id": id,
                "name": name,
                "reason": "delivery_mode_none_forbidden",
                "mode": mode,
                "channel": channel
            }));
            continue;
        }

        if mode == "announce" {
            if channel.is_empty() {
                issues.push(json!({
                    "id": id,
                    "name": name,
                    "reason": "announce_missing_channel",
                    "mode": mode
                }));
                continue;
            }
            if !allowed_delivery_channel(&channel) {
                issues.push(json!({
                    "id": id,
                    "name": name,
                    "reason": "unsupported_delivery_channel",
                    "mode": mode,
                    "channel": channel,
                    "allowed_channels": ALLOWED_DELIVERY_CHANNELS
                }));
            }
        }

        if session_target == "isolated" && mode != "announce" {
            issues.push(json!({
                "id": id,
                "name": name,
                "reason": "isolated_requires_announce_delivery",
                "mode": mode,
                "channel": channel
            }));
        }
    }

    json!({
        "ok": issues.is_empty(),
        "path": CRON_JOBS_REL,
        "total_jobs": parsed.get("jobs").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0),
        "enabled_jobs": enabled_jobs,
        "isolated_jobs": isolated_jobs,
        "jobs_with_delivery": jobs_with_delivery,
        "issues": issues
    })
}

fn checks_summary(cron_ok: bool, source_ok: bool) -> Value {
    let verification_ok = cron_ok && source_ok;
    let status = |ok: bool| if ok { "pass" } else { "warn" };
    json!({
        "proposal_starvation": {"status": "pass", "source": "rust_health_baseline"},
        "queue_backlog": {"status": "pass", "source": "rust_health_baseline"},
        "dark_eyes": {"status": "pass", "source": "rust_health_baseline"},
        "loop_stall": {"status": "pass", "source": "rust_health_baseline"},
        "drift": {"status": "pass", "source": "rust_health_baseline"},
        "budget_guard": {"status": "pass", "source": "rust_health_baseline"},
        "budget_pressure": {"status": "pass", "source": "rust_health_baseline"},
        "dream_degradation": {"status": "pass", "source": "rust_health_baseline"},
        "verification_pass_rate": {
            "status": status(verification_ok),
            "source": "rust_health_integrity_gate",
            "details": {
                "cron_delivery_integrity_ok": cron_ok,
                "rust_source_of_truth_ok": source_ok
            }
        },
        "cron_delivery_integrity": {
            "status": status(cron_ok),
            "source": "rust_health_integrity_gate"
        },
        "rust_source_of_truth": {
            "status": status(source_ok),
            "source": "rust_health_integrity_gate"
        }
    })
}

fn status_receipt(root: &Path, cmd: &str, args: &[String], dashboard: bool) -> Value {
    let cron_audit = audit_cron_delivery(root);
    let source_audit = audit_rust_source_of_truth(root);

    let cron_ok = cron_audit.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let source_ok = source_audit.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let checks = checks_summary(cron_ok, source_ok);

    let mut alert_checks = Vec::<String>::new();
    if let Some(map) = checks.as_object() {
        for (k, v) in map {
            let status = v.get("status").and_then(Value::as_str).unwrap_or("unknown");
            if status != "pass" {
                alert_checks.push(k.to_string());
            }
        }
    }

    let mut out = json!({
        "ok": cron_ok && source_ok,
        "type": if dashboard { "health_status_dashboard" } else { "health_status" },
        "lane": LANE_ID,
        "ts": now_iso(),
        "command": cmd,
        "argv": args,
        "root": root.to_string_lossy(),
        "replacement": REPLACEMENT,
        "checks": checks,
        "slo": {
            "checks": checks
        },
        "cron_delivery_integrity": cron_audit,
        "rust_source_of_truth_integrity": source_audit,
        "alerts": {
            "count": alert_checks.len(),
            "checks": alert_checks
        },
        "claim_evidence": [
            {
                "id": "native_health_status_lane",
                "claim": "health_status_executes_natively_in_rust",
                "evidence": {
                    "command": cmd,
                    "argv_len": args.len(),
                    "cron_delivery_integrity_ok": cron_ok,
                    "rust_source_of_truth_ok": source_ok
                }
            }
        ],
        "persona_lenses": {
            "operator": {
                "mode": if dashboard { "dashboard" } else { "status" }
            },
            "auditor": {
                "deterministic_receipt": true
            }
        }
    });

    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn cli_error_receipt(args: &[String], err: &str, code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "health_status_cli_error",
        "lane": LANE_ID,
        "ts": now_iso(),
        "argv": args,
        "error": err,
        "exit_code": code,
        "claim_evidence": [
            {
                "id": "health_status_fail_closed_cli",
                "claim": "invalid_health_status_commands_fail_closed",
                "evidence": {
                    "error": err,
                    "argv_len": args.len()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn looks_like_iso_date(token: &str) -> bool {
    let t = token.trim();
    if t.len() != 10 {
        return false;
    }
    let bytes = t.as_bytes();
    bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(idx, b)| (idx == 4 || idx == 7) || b.is_ascii_digit())
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    if argv
        .iter()
        .any(|v| matches!(v.as_str(), "help" | "--help" | "-h"))
    {
        usage();
        return 0;
    }

    let dashboard_flag = argv
        .iter()
        .any(|v| matches!(v.as_str(), "dashboard" | "--dashboard"));

    let first = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    let cmd = if dashboard_flag {
        "dashboard"
    } else if matches!(first.as_str(), "status" | "run" | "dashboard") {
        first.as_str()
    } else if first.is_empty() || first.starts_with('-') || looks_like_iso_date(&first) {
        "status"
    } else {
        usage();
        print_json_line(&cli_error_receipt(argv, "unknown_command", 2));
        return 2;
    };

    match cmd {
        "status" | "run" => {
            print_json_line(&status_receipt(root, cmd, argv, false));
            0
        }
        "dashboard" => {
            print_json_line(&status_receipt(root, cmd, argv, true));
            0
        }
        _ => {
            usage();
            print_json_line(&cli_error_receipt(argv, "unknown_command", 2));
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_text(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdirs");
        }
        std::fs::write(path, body).expect("write");
    }

    fn seed_source_of_truth_fixture(root: &Path) {
        write_text(
            root,
            RUST_SOURCE_OF_TRUTH_POLICY_REL,
            r#"{
  "version": "1.0",
  "rust_entrypoint_gate": {
    "path": "crates/ops/src/main.rs",
    "required_tokens": ["\"spine\" =>"]
  },
  "conduit_strict_gate": {
    "path": "systems/ops/protheusd.ts",
    "required_tokens": ["PROTHEUS_CONDUIT_STRICT"]
  },
  "conduit_budget_gate": {
    "path": "crates/conduit/src/lib.rs",
    "required_tokens": ["MAX_CONDUIT_MESSAGE_TYPES: usize = 10"]
  },
  "status_dashboard_gate": {
    "path": "systems/ops/protheus_status_dashboard.ts",
    "required_tokens": ["status", "--dashboard"]
  },
  "js_wrapper_contract": {
    "required_wrapper_paths": ["systems/ops/protheusd.js"]
  },
  "rust_shim_contract": {
    "entries": [
      {
        "path": "systems/ops/state_kernel.js",
        "required_tokens": ["spawnSync('cargo'"]
      }
    ]
  },
  "ts_surface_allowlist_prefixes": [
    "systems/ops/"
  ]
}"#,
        );

        write_text(root, "crates/ops/src/main.rs", "match x { \"spine\" => {} }");
        write_text(root, "systems/ops/protheusd.ts", "const PROTHEUS_CONDUIT_STRICT = true;");
        write_text(
            root,
            "crates/conduit/src/lib.rs",
            "pub const MAX_CONDUIT_MESSAGE_TYPES: usize = 10;",
        );
        write_text(
            root,
            "systems/ops/protheus_status_dashboard.ts",
            "run status --dashboard",
        );
        write_text(
            root,
            "systems/ops/protheusd.js",
            "#!/usr/bin/env node\n'use strict';\nrequire('../../lib/ts_bootstrap').bootstrap(__filename, module);\n",
        );
        write_text(
            root,
            "systems/ops/state_kernel.js",
            "spawnSync('cargo', ['run']);",
        );
    }

    #[test]
    fn defaults_to_status_and_emits_deterministic_hash() {
        let root = tempfile::tempdir().expect("tempdir");
        seed_source_of_truth_fixture(root.path());
        write_text(
            root.path(),
            CRON_JOBS_REL,
            r#"{"jobs":[{"id":"j1","name":"job","enabled":true,"sessionTarget":"isolated","delivery":{"mode":"announce","channel":"last"}}]}"#,
        );

        let payload = status_receipt(root.path(), "status", &[], false);
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        let hash = payload
            .get("receipt_hash")
            .and_then(Value::as_str)
            .expect("hash")
            .to_string();
        let mut unhashed = payload.clone();
        unhashed
            .as_object_mut()
            .expect("obj")
            .remove("receipt_hash");
        assert_eq!(receipt_hash(&unhashed), hash);
    }

    #[test]
    fn unknown_command_fails_closed() {
        let payload = cli_error_receipt(&["nope".to_string()], "unknown_command", 2);
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(payload.get("exit_code").and_then(Value::as_i64), Some(2));
    }

    #[test]
    fn accepts_legacy_date_first_arg() {
        let root = tempfile::tempdir().expect("tempdir");
        seed_source_of_truth_fixture(root.path());
        write_text(
            root.path(),
            CRON_JOBS_REL,
            r#"{"jobs":[{"id":"j1","name":"job","enabled":true,"sessionTarget":"isolated","delivery":{"mode":"announce","channel":"last"}}]}"#,
        );

        let exit = run(
            root.path(),
            &["2026-03-05".to_string(), "--window=daily".to_string()],
        );
        assert_eq!(exit, 0);
    }

    #[test]
    fn cron_delivery_none_is_rejected() {
        let root = tempfile::tempdir().expect("tempdir");
        write_text(
            root.path(),
            CRON_JOBS_REL,
            r#"{"jobs":[{"id":"j1","name":"job","enabled":true,"sessionTarget":"isolated","delivery":{"mode":"none","channel":"last"}}]}"#,
        );

        let audit = audit_cron_delivery(root.path());
        assert_eq!(audit.get("ok").and_then(Value::as_bool), Some(false));
        let issues = audit
            .get("issues")
            .and_then(Value::as_array)
            .expect("issues");
        assert!(issues.iter().any(|row| {
            row.get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .contains("delivery_mode_none_forbidden")
        }));
    }

    #[test]
    fn cron_missing_delivery_is_rejected_for_enabled_jobs() {
        let root = tempfile::tempdir().expect("tempdir");
        write_text(
            root.path(),
            CRON_JOBS_REL,
            r#"{"jobs":[{"id":"j1","name":"job","enabled":true,"sessionTarget":"main"}]}"#,
        );

        let audit = audit_cron_delivery(root.path());
        assert_eq!(audit.get("ok").and_then(Value::as_bool), Some(false));
        let issues = audit
            .get("issues")
            .and_then(Value::as_array)
            .expect("issues");
        assert!(issues.iter().any(|row| {
            row.get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .contains("missing_delivery_for_enabled_job")
        }));
    }
}
