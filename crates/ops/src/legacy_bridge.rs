use crate::{deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use std::path::Path;
use std::process::{Command, Stdio};

fn print_json(value: &serde_json::Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn bridge_error_receipt(
    domain: &str,
    script_rel: &str,
    error: &str,
    reason: Option<&str>,
) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "legacy_bridge_error",
        "ts": now_iso(),
        "domain": domain,
        "script": script_rel,
        "error": error,
        "reason": reason,
        "claim_evidence": [
            {
                "id": "fail_closed_bridge",
                "claim": "legacy_bridge_errors_emit_deterministic_receipts",
                "evidence": {
                    "domain": domain,
                    "script": script_rel,
                    "error": error
                }
            }
        ],
        "persona_lenses": {
            "guardian": {
                "fallback_mode": "legacy_bridge",
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

fn resolve_node_binary() -> String {
    std::env::var("PROTHEUS_NODE_BINARY")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "node".to_string())
}

pub(crate) fn run_legacy_script_with_node(
    root: &Path,
    script_rel: &str,
    argv: &[String],
    domain: &str,
    node_binary: &str,
    extra_env: &[(String, String)],
) -> i32 {
    let script_path = root.join(script_rel);
    if !script_path.exists() {
        print_json(&bridge_error_receipt(
            domain,
            script_rel,
            "legacy_script_missing",
            None,
        ));
        return 1;
    }

    let mut cmd = Command::new(node_binary);
    cmd.arg(&script_path)
        .args(argv)
        .current_dir(root)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .env("PROTHEUS_RUST_LEGACY_BRIDGE", "1");
    for (k, v) in extra_env {
        cmd.env(k, v);
    }

    match cmd.status() {
        Ok(status) => {
            if let Some(code) = status.code() {
                code
            } else {
                print_json(&bridge_error_receipt(
                    domain,
                    script_rel,
                    "legacy_exit_by_signal",
                    Some(&format!("{status:?}")),
                ));
                1
            }
        }
        Err(err) => {
            print_json(&bridge_error_receipt(
                domain,
                script_rel,
                "legacy_spawn_failed",
                Some(&err.to_string()),
            ));
            1
        }
    }
}

pub fn run_legacy_script(root: &Path, script_rel: &str, argv: &[String], domain: &str) -> i32 {
    let node_binary = resolve_node_binary();
    run_legacy_script_with_node(root, script_rel, argv, domain, &node_binary, &[])
}

fn parse_bool_flag(v: Option<&str>) -> bool {
    let Some(raw) = v else {
        return false;
    };
    parse_bool_literal(raw).unwrap_or(false)
}

fn parse_bool_literal(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn resolve_fallback_choice(
    fallback_from_arg: Option<bool>,
    module_env: Option<&str>,
    global_env: Option<&str>,
) -> bool {
    fallback_from_arg
        .unwrap_or_else(|| parse_bool_flag(module_env) || parse_bool_flag(global_env))
}

pub fn split_legacy_fallback_flag(argv: &[String], module_env_key: &str) -> (bool, Vec<String>) {
    let mut fallback_from_arg = None::<bool>;
    let mut cleaned = Vec::with_capacity(argv.len());

    let mut i = 0usize;
    while i < argv.len() {
        let tok = argv[i].trim().to_string();
        if let Some((k, v)) = tok.split_once('=') {
            if k == "--legacy-fallback" {
                fallback_from_arg = Some(parse_bool_literal(v).unwrap_or(true));
                i += 1;
                continue;
            }
        }
        if tok == "--legacy-fallback" {
            if let Some(next) = argv.get(i + 1) {
                if !next.starts_with("--") {
                    if let Some(v) = parse_bool_literal(next) {
                        fallback_from_arg = Some(v);
                        i += 2;
                        continue;
                    }
                }
            }
            fallback_from_arg = Some(true);
            i += 1;
            continue;
        }
        cleaned.push(argv[i].clone());
        i += 1;
    }

    let module_env = std::env::var(module_env_key).ok();
    let global_env = std::env::var("PROTHEUS_OPS_LEGACY_FALLBACK").ok();
    let fallback = resolve_fallback_choice(
        fallback_from_arg,
        module_env.as_deref(),
        global_env.as_deref(),
    );

    (fallback, cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write_script(root: &Path, script_rel: &str, content: &str) {
        let script_path = root.join(script_rel);
        fs::create_dir_all(script_path.parent().expect("parent")).expect("mkdir");
        fs::write(script_path, content).expect("write script");
    }

    #[test]
    fn missing_script_fails_closed() {
        let dir = tempdir().expect("tempdir");
        let exit = run_legacy_script_with_node(
            dir.path(),
            "systems/ops/autotest_controller_legacy.js",
            &[],
            "autotest_controller",
            "/bin/sh",
            &[],
        );
        assert_eq!(exit, 1);
    }

    #[test]
    fn forwards_args_and_exit_code() {
        let dir = tempdir().expect("tempdir");
        let args_path = dir.path().join("args.txt");
        write_script(
            dir.path(),
            "systems/ops/autotest_controller_legacy.js",
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$BRIDGE_ARGS_OUT\"\nexit \"${BRIDGE_EXIT_CODE:-0}\"\n",
        );

        let argv = vec![
            "run".to_string(),
            "latest".to_string(),
            "--apply=0".to_string(),
        ];
        let extra_env = vec![
            (
                "BRIDGE_ARGS_OUT".to_string(),
                args_path.to_string_lossy().into_owned(),
            ),
            ("BRIDGE_EXIT_CODE".to_string(), "7".to_string()),
        ];

        let exit = run_legacy_script_with_node(
            dir.path(),
            "systems/ops/autotest_controller_legacy.js",
            &argv,
            "autotest_controller",
            "/bin/sh",
            &extra_env,
        );

        assert_eq!(exit, 7);
        let got = fs::read_to_string(args_path)
            .expect("args output")
            .lines()
            .map(|line| line.to_string())
            .collect::<Vec<_>>();
        assert_eq!(got, argv);
    }

    #[test]
    fn splits_and_detects_fallback_flag() {
        let args = vec![
            "run".to_string(),
            "--legacy-fallback=1".to_string(),
            "--strict=1".to_string(),
        ];
        let (fallback, cleaned) = split_legacy_fallback_flag(&args, "NO_SUCH_ENV");
        assert!(fallback);
        assert_eq!(cleaned, vec!["run".to_string(), "--strict=1".to_string()]);
    }

    #[test]
    fn bridge_error_receipt_is_deterministic() {
        let out = bridge_error_receipt(
            "autotest_controller",
            "systems/ops/autotest_controller_legacy.js",
            "legacy_script_missing",
            None,
        );
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            out.get("type").and_then(Value::as_str),
            Some("legacy_bridge_error")
        );
        assert!(out.get("claim_evidence").is_some());
        assert!(out.get("persona_lenses").is_some());

        let expected_hash = out
            .get("receipt_hash")
            .and_then(Value::as_str)
            .expect("hash")
            .to_string();
        let mut unhashed = out.clone();
        unhashed
            .as_object_mut()
            .expect("object")
            .remove("receipt_hash");
        assert_eq!(deterministic_receipt_hash(&unhashed), expected_hash);
    }

    #[test]
    fn resolve_fallback_prefers_cli_over_env() {
        let fallback = resolve_fallback_choice(Some(false), Some("1"), Some("1"));
        assert!(!fallback);
        let fallback_true = resolve_fallback_choice(Some(true), Some("0"), Some("0"));
        assert!(fallback_true);
    }

    #[test]
    fn resolve_fallback_uses_module_env_then_global_env() {
        let module_enabled = resolve_fallback_choice(None, Some("true"), Some("0"));
        assert!(module_enabled);

        let global_enabled = resolve_fallback_choice(None, Some("0"), Some("yes"));
        assert!(global_enabled);
    }

    #[test]
    fn resolve_fallback_defaults_to_false() {
        let fallback = resolve_fallback_choice(None, None, None);
        assert!(!fallback);
    }

    #[test]
    fn split_legacy_flag_does_not_consume_positional_command() {
        let args = vec![
            "--legacy-fallback".to_string(),
            "run".to_string(),
            "latest".to_string(),
        ];
        let (fallback, cleaned) = split_legacy_fallback_flag(&args, "NO_SUCH_ENV");
        assert!(fallback);
        assert_eq!(cleaned, vec!["run".to_string(), "latest".to_string()]);
    }

    #[test]
    fn split_legacy_flag_consumes_explicit_boolean_value() {
        let args = vec![
            "--legacy-fallback".to_string(),
            "0".to_string(),
            "run".to_string(),
        ];
        let (fallback, cleaned) = split_legacy_fallback_flag(&args, "NO_SUCH_ENV");
        assert!(!fallback);
        assert_eq!(cleaned, vec!["run".to_string()]);
    }

    #[test]
    fn split_legacy_flag_inline_false_is_respected() {
        let args = vec!["--legacy-fallback=false".to_string(), "run".to_string()];
        let (fallback, cleaned) = split_legacy_fallback_flag(&args, "NO_SUCH_ENV");
        assert!(!fallback);
        assert_eq!(cleaned, vec!["run".to_string()]);
    }

    #[test]
    fn split_legacy_flag_inline_invalid_defaults_true() {
        let args = vec!["--legacy-fallback=latest".to_string(), "run".to_string()];
        let (fallback, cleaned) = split_legacy_fallback_flag(&args, "NO_SUCH_ENV");
        assert!(fallback);
        assert_eq!(cleaned, vec!["run".to_string()]);
    }

    #[test]
    fn signal_terminated_script_fails_closed() {
        let dir = tempdir().expect("tempdir");
        write_script(
            dir.path(),
            "systems/ops/autotest_controller_legacy.js",
            "kill -9 $$\n",
        );
        let exit = run_legacy_script_with_node(
            dir.path(),
            "systems/ops/autotest_controller_legacy.js",
            &[],
            "autotest_controller",
            "/bin/sh",
            &[],
        );
        assert_eq!(exit, 1);
    }
}
