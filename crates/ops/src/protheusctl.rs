use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use persona_dispatch_security_gate::{
    evaluate_persona_dispatch_gate, CHECK_ID as PERSONA_DISPATCH_SECURITY_GATE_CHECK_ID,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::io::IsTerminal;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::clean;

#[derive(Debug, Clone)]
pub struct Route {
    pub script_rel: String,
    pub args: Vec<String>,
    pub forward_stdin: bool,
}

#[derive(Debug, Clone)]
pub struct DispatchSecurity {
    pub ok: bool,
    pub reason: String,
}

const PERSONA_VALID_LENSES_ENV: &str = "PROTHEUS_CTL_PERSONA_VALID_LENSES";
const PERSONA_VALID_LENSES_DEFAULT: &str = "operator,guardian,analyst";
const PERSONA_BLOCKED_PATHS_ENV: &str = "PROTHEUS_CTL_PERSONA_BLOCKED_PATHS";

fn bool_env(name: &str, fallback: bool) -> bool {
    match env::var(name) {
        Ok(v) => match v.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => fallback,
        },
        Err(_) => fallback,
    }
}

fn csv_list_env(name: &str, fallback_csv: &str) -> Vec<String> {
    env::var(name)
        .unwrap_or_else(|_| fallback_csv.to_string())
        .split(',')
        .map(|row| row.trim())
        .filter(|row| !row.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn requested_lens_arg(args: &[String]) -> Option<String> {
    let mut idx = 0usize;
    while idx < args.len() {
        let token = args[idx].trim();
        if let Some((_, value)) = token.split_once('=') {
            if token.starts_with("--lens=") || token.starts_with("--persona-lens=") {
                let lens = value.trim();
                if !lens.is_empty() {
                    return Some(lens.to_string());
                }
            }
        } else if token == "--lens" || token == "--persona-lens" {
            if let Some(value) = args.get(idx + 1) {
                let lens = value.trim();
                if !lens.is_empty() {
                    return Some(lens.to_string());
                }
            }
        }
        idx += 1;
    }
    None
}

fn should_offer_setup(root: &Path, skip_setup: bool) -> bool {
    if skip_setup
        || bool_env("PROTHEUS_SKIP_SETUP", false)
        || bool_env("PROTHEUS_SETUP_DISABLE", false)
    {
        return false;
    }
    if bool_env("PROTHEUS_SETUP_FORCE", false) {
        return true;
    }
    let latest_path = root
        .join("state")
        .join("ops")
        .join("protheus_setup_wizard")
        .join("latest.json");
    let Ok(raw) = std::fs::read_to_string(latest_path) else {
        return true;
    };
    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    !parsed
        .get("completed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn node_bin() -> String {
    env::var("PROTHEUS_NODE_BINARY").unwrap_or_else(|_| "node".to_string())
}

fn parse_json(raw: &str) -> Option<Value> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return Some(v);
    }
    let lines = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    for line in lines.iter().rev() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            return Some(v);
        }
    }
    None
}

fn security_request(root: &Path, script_rel: &str, args: &[String]) -> Value {
    let digest_seed = serde_json::to_string(&json!({
        "script": script_rel,
        "args": args
    }))
    .unwrap_or_else(|_| "{}".to_string());
    let mut hasher = Sha256::new();
    hasher.update(digest_seed.as_bytes());
    let digest = hex::encode(hasher.finalize());
    let now_ms = chrono::Utc::now().timestamp_millis();

    json!({
        "operation_id": clean(format!("protheusctl_dispatch_{}_{}", now_ms, &digest[..10]), 160),
        "subsystem": "ops",
        "action": "cli_dispatch",
        "actor": "systems/ops/protheusctl",
        "risk_class": if bool_env("PROTHEUS_CTL_SECURITY_HIGH_RISK", false) { "high" } else { "normal" },
        "payload_digest": format!("sha256:{digest}"),
        "tags": ["protheusctl", "dispatch", "foundation_lock"],
        "covenant_violation": bool_env("PROTHEUS_CTL_SECURITY_COVENANT_VIOLATION", false),
        "tamper_signal": bool_env("PROTHEUS_CTL_SECURITY_TAMPER_SIGNAL", false),
        "key_age_hours": env::var("PROTHEUS_CTL_SECURITY_KEY_AGE_HOURS").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(1),
        "operator_quorum": env::var("PROTHEUS_CTL_SECURITY_OPERATOR_QUORUM").ok().and_then(|v| v.parse::<u8>().ok()).unwrap_or(2),
        "audit_receipt_nonce": clean(format!("nonce-{}-{}", &digest[..12], now_ms), 120),
        "zk_proof": clean(env::var("PROTHEUS_CTL_SECURITY_ZK_PROOF").unwrap_or_else(|_| "zk-protheusctl-dispatch".to_string()), 220),
        "ciphertext_digest": clean(format!("sha256:{}", &digest[..32]), 220),
        "state_root": clean(env::var("PROTHEUS_SECURITY_STATE_ROOT").unwrap_or_else(|_| root.join("state").to_string_lossy().to_string()), 500)
    })
}

fn evaluate_persona_dispatch_security(
    script_rel: &str,
    args: &[String],
    req: &Value,
) -> DispatchSecurity {
    let requested_lens = requested_lens_arg(args);
    let valid_lenses = csv_list_env(PERSONA_VALID_LENSES_ENV, PERSONA_VALID_LENSES_DEFAULT);
    let blocked_paths = csv_list_env(PERSONA_BLOCKED_PATHS_ENV, "");
    let valid_lens_refs = valid_lenses.iter().map(String::as_str).collect::<Vec<_>>();
    let blocked_path_refs = blocked_paths.iter().map(String::as_str).collect::<Vec<_>>();
    let covenant_violation = req
        .get("covenant_violation")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let tamper_signal = req
        .get("tamper_signal")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let decision = evaluate_persona_dispatch_gate(
        script_rel,
        requested_lens.as_deref(),
        &valid_lens_refs,
        &blocked_path_refs,
        covenant_violation,
        tamper_signal,
    );
    if !decision.ok {
        return DispatchSecurity {
            ok: false,
            reason: format!(
                "security_gate_blocked:{PERSONA_DISPATCH_SECURITY_GATE_CHECK_ID}:{}",
                decision.code
            ),
        };
    }

    DispatchSecurity {
        ok: true,
        reason: "ok".to_string(),
    }
}

pub fn evaluate_dispatch_security(
    root: &Path,
    script_rel: &str,
    args: &[String],
) -> DispatchSecurity {
    if bool_env("PROTHEUS_CTL_SECURITY_GATE_DISABLED", false) {
        return DispatchSecurity {
            ok: true,
            reason: "protheusctl_dispatch_gate_disabled".to_string(),
        };
    }

    let req = security_request(root, script_rel, args);
    let persona_gate = evaluate_persona_dispatch_security(script_rel, args, &req);
    if !persona_gate.ok {
        return persona_gate;
    }
    if req
        .get("covenant_violation")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || req
            .get("tamper_signal")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return DispatchSecurity {
            ok: false,
            reason: "security_gate_blocked:local_fail_closed_signal".to_string(),
        };
    }

    let request_json = serde_json::to_string(&req).unwrap_or_else(|_| "{}".to_string());
    let request_base64 = BASE64_STANDARD.encode(request_json.as_bytes());

    let output = Command::new("cargo")
        .arg("run")
        .arg("--quiet")
        .arg("--manifest-path")
        .arg("crates/security/Cargo.toml")
        .arg("--bin")
        .arg("security_core")
        .arg("--")
        .arg("check")
        .arg(format!("--request-base64={request_base64}"))
        .current_dir(root)
        .output();

    let Ok(out) = output else {
        return DispatchSecurity {
            ok: false,
            reason: "security_gate_blocked:spawn_failed".to_string(),
        };
    };

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let msg = if stderr.trim().is_empty() {
            stdout.to_string()
        } else {
            stderr.to_string()
        };
        return DispatchSecurity {
            ok: false,
            reason: format!("security_gate_blocked:{}", clean(msg, 220)),
        };
    }

    let payload = parse_json(&String::from_utf8_lossy(&out.stdout));
    let Some(payload) = payload else {
        return DispatchSecurity {
            ok: false,
            reason: "security_gate_blocked:invalid_security_payload".to_string(),
        };
    };

    let decision = payload.get("decision").cloned().unwrap_or(Value::Null);
    let ok = decision.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let fail_closed = decision
        .get("fail_closed")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !ok || fail_closed {
        let reason = decision
            .get("reasons")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(Value::as_str)
            .unwrap_or("dispatch_security_gate_blocked")
            .to_string();
        return DispatchSecurity {
            ok: false,
            reason: format!("security_gate_blocked:{}", clean(reason, 220)),
        };
    }

    DispatchSecurity {
        ok: true,
        reason: "ok".to_string(),
    }
}

fn run_node_script(root: &Path, script_rel: &str, args: &[String], forward_stdin: bool) -> i32 {
    let script_abs = root.join(script_rel);
    let mut cmd = Command::new(node_bin());
    cmd.arg(script_abs)
        .args(args)
        .current_dir(root)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    if forward_stdin {
        cmd.stdin(Stdio::inherit());
    } else {
        cmd.stdin(Stdio::null());
    }

    match cmd.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(err) => {
            eprintln!(
                "{}",
                json!({
                    "ok": false,
                    "type": "protheusctl_dispatch",
                    "error": clean(format!("spawn_failed:{err}"), 220)
                })
            );
            1
        }
    }
}

fn maybe_run_cli_suggestion_engine(root: &Path, cmd: &str, rest: &[String]) {
    if bool_env("PROTHEUS_GLOBAL_QUIET", false) {
        return;
    }
    if !bool_env("PROTHEUS_CLI_SUGGESTIONS", true) {
        return;
    }
    if matches!(
        cmd,
        "assimilate"
            | "research"
            | "tutorial"
            | "list"
            | "help"
            | "--help"
            | "-h"
            | "demo"
            | "examples"
            | "version"
            | "update"
            | "diagram"
            | "shadow"
            | "debug"
            | "setup"
            | "completion"
            | "repl"
    ) {
        return;
    }
    let suggestion_script = root.join("systems/tools/cli_suggestion_engine.js");
    if !suggestion_script.exists() {
        return;
    }
    let request_json = serde_json::to_string(&json!({
        "cmd": cmd,
        "args": rest
    }))
    .unwrap_or_else(|_| "{}".to_string());
    let _ = Command::new(node_bin())
        .arg(suggestion_script)
        .arg("suggest")
        .arg("--origin=main_cli")
        .arg(format!("--cmd={}", clean(cmd, 60)))
        .arg(format!("--argv-json={request_json}"))
        .current_dir(root)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();
}

fn maybe_run_update_checker(root: &Path, cmd: &str) {
    if bool_env("PROTHEUS_GLOBAL_QUIET", false) {
        return;
    }
    if bool_env("PROTHEUS_UPDATE_CHECKER_DISABLED", false) {
        return;
    }
    if matches!(cmd, "version" | "update" | "help" | "--help" | "-h") {
        return;
    }
    let script = root.join("systems/ops/protheus_version_cli.js");
    if !script.exists() {
        return;
    }
    let _ = Command::new(node_bin())
        .arg(script)
        .arg("check-quiet")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();
}

fn route_edge(rest: &[String]) -> Route {
    let sub = rest
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    match sub.as_str() {
        "lifecycle" => {
            let action = rest
                .get(1)
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            Route {
                script_rel: "systems/edge/mobile_lifecycle_resilience.js".to_string(),
                args: std::iter::once(action)
                    .chain(rest.iter().skip(2).cloned())
                    .collect(),
                forward_stdin: false,
            }
        }
        "swarm" => {
            let action = rest
                .get(1)
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            Route {
                script_rel: "systems/spawn/mobile_edge_swarm_bridge.js".to_string(),
                args: std::iter::once(action)
                    .chain(rest.iter().skip(2).cloned())
                    .collect(),
                forward_stdin: false,
            }
        }
        "wrapper" => {
            let action = rest
                .get(1)
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            Route {
                script_rel: "systems/ops/mobile_wrapper_distribution_pack.js".to_string(),
                args: std::iter::once(action)
                    .chain(rest.iter().skip(2).cloned())
                    .collect(),
                forward_stdin: false,
            }
        }
        "benchmark" => {
            let action = rest
                .get(1)
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            Route {
                script_rel: "systems/ops/mobile_competitive_benchmark_matrix.js".to_string(),
                args: std::iter::once(action)
                    .chain(rest.iter().skip(2).cloned())
                    .collect(),
                forward_stdin: false,
            }
        }
        "top" => Route {
            script_rel: "systems/edge/mobile_ops_top.js".to_string(),
            args: std::iter::once("status".to_string())
                .chain(rest.iter().skip(1).cloned())
                .collect(),
            forward_stdin: false,
        },
        _ => Route {
            script_rel: "systems/edge/protheus_edge_runtime.js".to_string(),
            args: std::iter::once(sub)
                .chain(rest.iter().skip(1).cloned())
                .collect(),
            forward_stdin: false,
        },
    }
}

pub fn usage() {
    println!("Usage: protheus <command> [flags]");
    println!("Try:");
    println!("  protheus list");
    println!("  protheus --help");
    println!("  protheus setup");
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let mut skip_setup_flag = false;
    let mut global_json = false;
    let mut global_quiet = false;
    let mut global_help = false;
    let mut global_version = false;
    let mut global_example = false;
    let mut filtered_argv = Vec::new();
    for arg in argv {
        match arg.as_str() {
            "--skip-setup" => skip_setup_flag = true,
            "--json" | "--json=1" => global_json = true,
            "--quiet" | "--quiet=1" => global_quiet = true,
            "--help" | "-h" => global_help = true,
            "--version" => global_version = true,
            "--example" => global_example = true,
            _ => filtered_argv.push(arg.clone()),
        }
    }

    if global_json {
        env::set_var("PROTHEUS_GLOBAL_JSON", "1");
    }
    if global_quiet {
        env::set_var("PROTHEUS_GLOBAL_QUIET", "1");
    }

    let mut cmd = if filtered_argv.is_empty() {
        if global_version {
            "version".to_string()
        } else if global_help {
            "help".to_string()
        } else {
            let force_repl = bool_env("PROTHEUS_FORCE_REPL", false);
            let repl_disabled = bool_env("PROTHEUS_REPL_DISABLED", false);
            if !repl_disabled && (force_repl || std::io::stdin().is_terminal()) {
                if should_offer_setup(root, skip_setup_flag) {
                    let setup_route = Route {
                        script_rel: "systems/ops/protheus_setup_wizard.js".to_string(),
                        args: vec!["run".to_string()],
                        forward_stdin: true,
                    };
                    let setup_gate = evaluate_dispatch_security(
                        root,
                        &setup_route.script_rel,
                        &setup_route.args,
                    );
                    if !setup_gate.ok {
                        eprintln!(
                            "{}",
                            json!({
                                "ok": false,
                                "type": "protheusctl_dispatch_security_gate",
                                "error": setup_gate.reason
                            })
                        );
                        return 1;
                    }
                    let setup_status = run_node_script(
                        root,
                        &setup_route.script_rel,
                        &setup_route.args,
                        setup_route.forward_stdin,
                    );
                    if setup_status != 0 {
                        return setup_status;
                    }
                }
                "repl".to_string()
            } else {
                "status".to_string()
            }
        }
    } else {
        filtered_argv
            .first()
            .cloned()
            .unwrap_or_else(|| "status".to_string())
    };
    let mut rest = filtered_argv.iter().skip(1).cloned().collect::<Vec<_>>();

    if global_version {
        cmd = "version".to_string();
        rest.clear();
    }

    if global_help
        && !matches!(cmd.as_str(), "help" | "--help" | "-h")
        && !rest
            .iter()
            .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        rest.push("--help".to_string());
    }

    if global_example && !matches!(cmd.as_str(), "examples" | "demo") {
        let target = cmd.clone();
        cmd = "examples".to_string();
        rest = vec![target];
    }

    maybe_run_update_checker(root, &cmd);
    maybe_run_cli_suggestion_engine(root, &cmd, &rest);

    let mut route = match cmd.as_str() {
        "list" => Route {
            script_rel: "systems/ops/protheus_command_list.js".to_string(),
            args: std::iter::once("--mode=list".to_string())
                .chain(rest)
                .collect(),
            forward_stdin: false,
        },
        "completion" => Route {
            script_rel: "systems/ops/protheus_completion.js".to_string(),
            args: if rest.is_empty() {
                vec!["--help".to_string()]
            } else {
                rest
            },
            forward_stdin: false,
        },
        "repl" => Route {
            script_rel: "systems/ops/protheus_repl.js".to_string(),
            args: rest,
            forward_stdin: true,
        },
        "setup" => Route {
            script_rel: "systems/ops/protheus_setup_wizard.js".to_string(),
            args: if rest.is_empty() {
                vec!["run".to_string()]
            } else {
                rest
            },
            forward_stdin: true,
        },
        "demo" => Route {
            script_rel: "systems/ops/protheus_demo.js".to_string(),
            args: rest,
            forward_stdin: false,
        },
        "examples" => Route {
            script_rel: "systems/ops/protheus_examples.js".to_string(),
            args: rest,
            forward_stdin: false,
        },
        "version" => Route {
            script_rel: "systems/ops/protheus_version_cli.js".to_string(),
            args: std::iter::once("version".to_string()).chain(rest).collect(),
            forward_stdin: false,
        },
        "update" => Route {
            script_rel: "systems/ops/protheus_version_cli.js".to_string(),
            args: std::iter::once("update".to_string()).chain(rest).collect(),
            forward_stdin: false,
        },
        "diagram" => Route {
            script_rel: "systems/ops/protheus_diagram.js".to_string(),
            args: rest,
            forward_stdin: false,
        },
        "shadow" => Route {
            script_rel: "systems/personas/shadow_cli.js".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest
            },
            forward_stdin: false,
        },
        "help" => Route {
            script_rel: "systems/ops/protheus_command_list.js".to_string(),
            args: std::iter::once("--mode=help".to_string())
                .chain(rest)
                .collect(),
            forward_stdin: false,
        },
        "--help" => Route {
            script_rel: "systems/ops/protheus_command_list.js".to_string(),
            args: std::iter::once("--mode=help".to_string())
                .chain(rest)
                .collect(),
            forward_stdin: false,
        },
        "-h" => Route {
            script_rel: "systems/ops/protheus_command_list.js".to_string(),
            args: std::iter::once("--mode=help".to_string())
                .chain(rest)
                .collect(),
            forward_stdin: false,
        },
        "status" => Route {
            script_rel: "systems/ops/protheus_status_dashboard.js".to_string(),
            args: rest,
            forward_stdin: false,
        },
        "debug" => Route {
            script_rel: "systems/ops/protheus_debug_diagnostics.js".to_string(),
            args: rest,
            forward_stdin: false,
        },
        "health" => Route {
            script_rel: "systems/ops/protheus_control_plane.js".to_string(),
            args: std::iter::once("health".to_string()).chain(rest).collect(),
            forward_stdin: false,
        },
        "skills" if rest.first().map(String::as_str) == Some("discover") => Route {
            script_rel: "systems/ops/protheusctl_skills_discover.js".to_string(),
            args: rest.into_iter().skip(1).collect(),
            forward_stdin: false,
        },
        "edge" => route_edge(&rest),
        "host" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            Route {
                script_rel: "systems/ops/host_adaptation_operator_surface.js".to_string(),
                args: std::iter::once(sub)
                    .chain(rest.into_iter().skip(1))
                    .collect(),
                forward_stdin: false,
            }
        }
        "socket" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let args = match sub.as_str() {
                "list" => std::iter::once("lifecycle".to_string())
                    .chain(std::iter::once("list".to_string()))
                    .chain(rest.into_iter().skip(1))
                    .collect(),
                "install" | "update" | "test" => std::iter::once("lifecycle".to_string())
                    .chain(std::iter::once(sub))
                    .chain(rest.into_iter().skip(1))
                    .collect(),
                "admission" | "discover" | "activate" | "status" => std::iter::once(sub)
                    .chain(rest.into_iter().skip(1))
                    .collect(),
                _ => std::iter::once("status".to_string()).chain(rest).collect(),
            };
            Route {
                script_rel: "systems/ops/platform_socket_runtime.js".to_string(),
                args,
                forward_stdin: false,
            }
        }
        "mine" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "dashboard".to_string());
            Route {
                script_rel: "systems/economy/donor_mining_dashboard.js".to_string(),
                args: std::iter::once(sub)
                    .chain(rest.into_iter().skip(1))
                    .collect(),
                forward_stdin: false,
            }
        }
        "migrate" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_default();
            let supported = ["run", "status", "rollback", "help", "--help", "-h"];
            let args =
                if sub.is_empty() || sub.starts_with("--") || !supported.contains(&sub.as_str()) {
                    std::iter::once("run".to_string()).chain(rest).collect()
                } else if matches!(sub.as_str(), "help" | "--help" | "-h") {
                    vec!["help".to_string()]
                } else {
                    std::iter::once(sub)
                        .chain(rest.into_iter().skip(1))
                        .collect()
                };
            Route {
                script_rel: "systems/migration/core_migration_bridge.js".to_string(),
                args,
                forward_stdin: false,
            }
        }
        "import" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_default();
            let supported = ["run", "status", "help", "--help", "-h"];
            let args =
                if sub.is_empty() || sub.starts_with("--") || !supported.contains(&sub.as_str()) {
                    std::iter::once("run".to_string()).chain(rest).collect()
                } else if matches!(sub.as_str(), "help" | "--help" | "-h") {
                    vec!["help".to_string()]
                } else {
                    std::iter::once(sub)
                        .chain(rest.into_iter().skip(1))
                        .collect()
                };
            Route {
                script_rel: "systems/migration/universal_importers.js".to_string(),
                args,
                forward_stdin: false,
            }
        }
        "wasi2" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let normalized = if sub == "run" { "run" } else { "status" };
            Route {
                script_rel: "systems/ops/wasi2_execution_completeness_gate.js".to_string(),
                args: std::iter::once(normalized.to_string())
                    .chain(rest.into_iter().skip(1))
                    .collect(),
                forward_stdin: false,
            }
        }
        "settle" => {
            let mut sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_default();
            let has_revert = rest
                .iter()
                .any(|arg| matches!(arg.as_str(), "--revert" | "--revert=1" | "--mode=revert"));
            if has_revert {
                sub = "revert".to_string();
            }
            let supported = [
                "list",
                "run",
                "run-all",
                "status",
                "settle",
                "revert",
                "edit-core",
                "edit-module",
                "edit",
            ];
            let args =
                if sub.is_empty() || sub.starts_with("--") || !supported.contains(&sub.as_str()) {
                    std::iter::once("settle".to_string()).chain(rest).collect()
                } else {
                    std::iter::once(sub)
                        .chain(rest.into_iter().skip(1))
                        .collect()
                };
            Route {
                script_rel: "systems/ops/settlement_program.js".to_string(),
                args,
                forward_stdin: false,
            }
        }
        "edit-core" => Route {
            script_rel: "systems/ops/settlement_program.js".to_string(),
            args: std::iter::once("edit-core".to_string())
                .chain(rest)
                .collect(),
            forward_stdin: false,
        },
        "edit" => Route {
            script_rel: "systems/ops/settlement_program.js".to_string(),
            args: if rest.is_empty() {
                vec!["edit-module".to_string()]
            } else {
                std::iter::once("edit-module".to_string())
                    .chain(rest)
                    .collect()
            },
            forward_stdin: false,
        },
        "scale" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let normalized = if ["list", "run", "run-all", "status"].contains(&sub.as_str()) {
                sub
            } else {
                "status".to_string()
            };
            Route {
                script_rel: "systems/ops/scale_readiness_program.js".to_string(),
                args: std::iter::once(normalized)
                    .chain(rest.into_iter().skip(1))
                    .collect(),
                forward_stdin: false,
            }
        }
        "perception" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let normalized = if ["list", "run", "run-all", "status"].contains(&sub.as_str()) {
                sub
            } else {
                "status".to_string()
            };
            Route {
                script_rel: "systems/ops/perception_polish_program.js".to_string(),
                args: std::iter::once(normalized)
                    .chain(rest.into_iter().skip(1))
                    .collect(),
                forward_stdin: false,
            }
        }
        "fluxlattice" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let normalized = if ["list", "run", "run-all", "status"].contains(&sub.as_str()) {
                sub
            } else {
                "status".to_string()
            };
            Route {
                script_rel: "systems/ops/fluxlattice_program.js".to_string(),
                args: std::iter::once(normalized)
                    .chain(rest.into_iter().skip(1))
                    .collect(),
                forward_stdin: false,
            }
        }
        "lensmap" => Route {
            script_rel: "packages/lensmap/lensmap_cli.js".to_string(),
            args: rest,
            forward_stdin: false,
        },
        "lens" => Route {
            script_rel: "systems/personas/cli.js".to_string(),
            args: rest,
            forward_stdin: true,
        },
        "arbitrate" => Route {
            script_rel: "systems/personas/cli.js".to_string(),
            args: std::iter::once("arbitrate".to_string())
                .chain(rest)
                .collect(),
            forward_stdin: true,
        },
        "orchestrate" => Route {
            script_rel: "systems/personas/orchestration.js".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest
            },
            forward_stdin: true,
        },
        "persona" => Route {
            script_rel: "systems/personas/cli.js".to_string(),
            args: if rest.is_empty() {
                vec!["--help".to_string()]
            } else {
                rest
            },
            forward_stdin: true,
        },
        "assimilate" => Route {
            script_rel: "systems/tools/assimilate.js".to_string(),
            args: if rest.is_empty() {
                vec!["--help".to_string()]
            } else {
                rest
            },
            forward_stdin: false,
        },
        "research" => Route {
            script_rel: "systems/tools/research.js".to_string(),
            args: if rest.is_empty() {
                vec!["--help".to_string()]
            } else {
                rest
            },
            forward_stdin: false,
        },
        "tutorial" => Route {
            script_rel: "systems/tools/cli_suggestion_engine.js".to_string(),
            args: if rest.is_empty() {
                vec!["tutorial".to_string(), "status".to_string()]
            } else {
                std::iter::once("tutorial".to_string())
                    .chain(rest)
                    .collect()
            },
            forward_stdin: false,
        },
        "toolkit" => Route {
            script_rel: "systems/ops/cognitive_toolkit_cli.js".to_string(),
            args: if rest.is_empty() {
                vec!["list".to_string()]
            } else {
                rest
            },
            forward_stdin: true,
        },
        "spine" => Route {
            script_rel: "systems/spine/spine_safe_launcher.js".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest
            },
            forward_stdin: false,
        },
        "hold" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let normalized = if ["admit", "rehydrate", "simulate", "status"].contains(&sub.as_str())
            {
                sub
            } else {
                "status".to_string()
            };
            Route {
                script_rel: "systems/autonomy/hold_remediation_engine.js".to_string(),
                args: std::iter::once(normalized)
                    .chain(rest.into_iter().skip(1))
                    .collect(),
                forward_stdin: false,
            }
        }
        "rust" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let normalized = if ["run", "report", "status"].contains(&sub.as_str()) {
                sub
            } else {
                "status".to_string()
            };
            Route {
                script_rel: "systems/ops/rust_authoritative_microkernel_acceleration.js"
                    .to_string(),
                args: std::iter::once(normalized)
                    .chain(rest.into_iter().skip(1))
                    .collect(),
                forward_stdin: false,
            }
        }
        "rust-hybrid" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let normalized = if ["list", "run", "run-all", "status"].contains(&sub.as_str()) {
                sub
            } else {
                "status".to_string()
            };
            Route {
                script_rel: "systems/ops/rust_hybrid_migration_program.js".to_string(),
                args: std::iter::once(normalized)
                    .chain(rest.into_iter().skip(1))
                    .collect(),
                forward_stdin: false,
            }
        }
        "suite" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let normalized = if ["list", "run", "run-all", "status"].contains(&sub.as_str()) {
                sub
            } else {
                "status".to_string()
            };
            Route {
                script_rel: "systems/ops/productized_suite_program.js".to_string(),
                args: std::iter::once(normalized)
                    .chain(rest.into_iter().skip(1))
                    .collect(),
                forward_stdin: false,
            }
        }
        "rsi" => Route {
            script_rel: "adaptive/rsi/rsi_bootstrap.js".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest
            },
            forward_stdin: false,
        },
        "contract-lane" if rest.first().map(String::as_str) == Some("status") => Route {
            script_rel: "adaptive/rsi/rsi_bootstrap.js".to_string(),
            args: std::iter::once("contract-lane-status".to_string())
                .chain(rest.into_iter().skip(1))
                .collect(),
            forward_stdin: false,
        },
        "approve" if rest.iter().any(|arg| arg == "--rsi") => Route {
            script_rel: "adaptive/rsi/rsi_bootstrap.js".to_string(),
            args: std::iter::once("approve".to_string())
                .chain(rest.into_iter().filter(|arg| arg != "--rsi"))
                .collect(),
            forward_stdin: false,
        },
        _ => Route {
            script_rel: "systems/ops/protheus_unknown_guard.js".to_string(),
            args: std::iter::once(cmd).chain(rest).collect(),
            forward_stdin: false,
        },
    };

    let supports_json_flag = matches!(
        route.script_rel.as_str(),
        "systems/ops/protheus_command_list.js"
            | "systems/ops/protheus_setup_wizard.js"
            | "systems/ops/protheus_demo.js"
            | "systems/ops/protheus_examples.js"
            | "systems/ops/protheus_version_cli.js"
            | "systems/ops/protheus_diagram.js"
            | "systems/ops/protheus_completion.js"
            | "systems/ops/protheus_status_dashboard.js"
            | "systems/ops/protheus_debug_diagnostics.js"
            | "systems/personas/shadow_cli.js"
            | "systems/tools/cli_suggestion_engine.js"
    );
    if global_json
        && supports_json_flag
        && !route
            .args
            .iter()
            .any(|arg| arg == "--json" || arg.starts_with("--json="))
    {
        route.args.push("--json=1".to_string());
    }

    let supports_quiet_flag = matches!(
        route.script_rel.as_str(),
        "systems/ops/protheus_demo.js"
            | "systems/ops/protheus_examples.js"
            | "systems/ops/protheus_version_cli.js"
    );
    if global_quiet
        && supports_quiet_flag
        && !route
            .args
            .iter()
            .any(|arg| arg == "--quiet" || arg.starts_with("--quiet="))
    {
        route.args.push("--quiet=1".to_string());
    }

    let gate = evaluate_dispatch_security(root, &route.script_rel, &route.args);
    if !gate.ok {
        eprintln!(
            "{}",
            json!({
                "ok": false,
                "type": "protheusctl_dispatch_security_gate",
                "error": gate.reason
            })
        );
        return 1;
    }

    run_node_script(root, &route.script_rel, &route.args, route.forward_stdin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .expect("lock_env")
    }

    #[test]
    fn route_edge_swarm_maps_correctly() {
        let route = route_edge(&[
            "swarm".to_string(),
            "enroll".to_string(),
            "--owner=jay".to_string(),
        ]);
        assert_eq!(
            route.script_rel,
            "systems/spawn/mobile_edge_swarm_bridge.js"
        );
        assert_eq!(route.args.first().map(String::as_str), Some("enroll"));
    }

    #[test]
    fn local_fail_closed_signal_blocks_dispatch() {
        let _guard = env_guard();
        std::env::set_var("PROTHEUS_CTL_SECURITY_GATE_DISABLED", "0");
        std::env::set_var("PROTHEUS_CTL_SECURITY_COVENANT_VIOLATION", "1");
        let root = PathBuf::from(".");
        let verdict =
            evaluate_dispatch_security(&root, "systems/ops/protheus_control_plane.js", &[]);
        assert!(!verdict.ok);
        assert!(verdict.reason.contains("fail_closed"));
        std::env::remove_var("PROTHEUS_CTL_SECURITY_COVENANT_VIOLATION");
        std::env::remove_var("PROTHEUS_CTL_SECURITY_GATE_DISABLED");
    }

    #[test]
    fn persona_blocked_path_fails_closed_before_security_core() {
        let _guard = env_guard();
        std::env::set_var("PROTHEUS_CTL_SECURITY_GATE_DISABLED", "0");
        std::env::set_var(
            "PROTHEUS_CTL_PERSONA_BLOCKED_PATHS",
            "systems/ops/protheus_control_plane.js",
        );
        let root = PathBuf::from(".");
        let verdict =
            evaluate_dispatch_security(&root, "systems/ops/protheus_control_plane.js", &[]);
        assert!(!verdict.ok);
        assert!(verdict
            .reason
            .contains(PERSONA_DISPATCH_SECURITY_GATE_CHECK_ID));
        assert!(verdict.reason.contains("blocked_dispatch_path"));
        std::env::remove_var("PROTHEUS_CTL_PERSONA_BLOCKED_PATHS");
        std::env::remove_var("PROTHEUS_CTL_SECURITY_GATE_DISABLED");
    }

    #[test]
    fn requested_lens_arg_supports_inline_and_pair_forms() {
        let inline = requested_lens_arg(&["--lens=guardian".to_string()]);
        assert_eq!(inline.as_deref(), Some("guardian"));

        let paired = requested_lens_arg(&["--persona-lens".to_string(), "operator".to_string()]);
        assert_eq!(paired.as_deref(), Some("operator"));
    }
}
