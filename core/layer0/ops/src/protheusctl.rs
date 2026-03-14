// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use persona_dispatch_security_gate::{
    evaluate_persona_dispatch_gate, CHECK_ID as PERSONA_DISPATCH_SECURITY_GATE_CHECK_ID,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::{clean, client_state_root};
#[path = "protheusctl_routes.rs"]
mod protheusctl_routes;

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

fn resolve_workspace_root(start: &Path) -> Option<PathBuf> {
    let mut cursor = Some(start);
    while let Some(path) = cursor {
        if path
            .join("core")
            .join("layer0")
            .join("ops")
            .join("Cargo.toml")
            .exists()
            && path.join("client").join("runtime").exists()
        {
            return Some(path.to_path_buf());
        }
        cursor = path.parent();
    }
    None
}

fn effective_workspace_root(start: &Path) -> PathBuf {
    resolve_workspace_root(start).unwrap_or_else(|| start.to_path_buf())
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
        "actor": "client/runtime/systems/ops/protheusctl",
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
        "state_root": clean(client_state_root(root).to_string_lossy().to_string(), 500)
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

    let workspace_root = effective_workspace_root(root);
    let req = security_request(&workspace_root, script_rel, args);
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

    let manifest = workspace_root.join("core/layer0/security/Cargo.toml");
    if !manifest.exists() {
        return DispatchSecurity {
            ok: false,
            reason: "security_gate_blocked:manifest_missing".to_string(),
        };
    }

    let output = Command::new("cargo")
        .arg("run")
        .arg("--quiet")
        .arg("--manifest-path")
        .arg(manifest)
        .arg("--bin")
        .arg("security_core")
        .arg("--")
        .arg("check")
        .arg(format!("--request-base64={request_base64}"))
        .current_dir(workspace_root)
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
    let workspace_root = effective_workspace_root(root);
    if let Some(domain) = script_rel.strip_prefix("core://") {
        return run_core_domain(&workspace_root, domain, args, forward_stdin);
    }

    let script_abs = workspace_root.join(script_rel);
    let mut cmd = Command::new(node_bin());
    cmd.arg(script_abs)
        .args(args)
        .current_dir(workspace_root)
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

fn run_core_domain(root: &Path, domain: &str, args: &[String], forward_stdin: bool) -> i32 {
    let exe = match env::current_exe() {
        Ok(path) => path,
        Err(err) => {
            eprintln!(
                "{}",
                json!({
                    "ok": false,
                    "type": "protheusctl_dispatch",
                    "error": clean(format!("current_exe_failed:{err}"), 220)
                })
            );
            return 1;
        }
    };

    let mut cmd = Command::new(exe);
    cmd.arg(domain)
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
                    "error": clean(format!("core_spawn_failed:{err}"), 220),
                    "domain": domain
                })
            );
            1
        }
    }
}

fn enforce_command_center_boundary(cmd: &str, route: &Route) -> Result<(), String> {
    if route
        .script_rel
        .contains("client/runtime/systems/red_legion/command_center")
    {
        return Err("red_legion_client_authority_forbidden".to_string());
    }
    if cmd == "session"
        && !route
            .script_rel
            .starts_with("core://command-center-session")
    {
        return Err("session_route_must_be_core_authoritative".to_string());
    }
    Ok(())
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
            | "status"
    ) {
        return;
    }
    let suggestion_script = root.join("client/runtime/systems/tools/cli_suggestion_engine.js");
    let suggestion_ts = root.join("client/runtime/systems/tools/cli_suggestion_engine.ts");
    if !suggestion_script.exists() || !suggestion_ts.exists() {
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
    let script = root.join("client/runtime/systems/ops/protheus_version_cli.js");
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
                script_rel: "client/runtime/systems/edge/mobile_lifecycle_resilience.ts"
                    .to_string(),
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
                script_rel: "client/runtime/systems/spawn/mobile_edge_swarm_bridge.ts".to_string(),
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
                script_rel: "client/runtime/systems/ops/mobile_wrapper_distribution_pack.js"
                    .to_string(),
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
                script_rel: "client/runtime/systems/ops/mobile_competitive_benchmark_matrix.js"
                    .to_string(),
                args: std::iter::once(action)
                    .chain(rest.iter().skip(2).cloned())
                    .collect(),
                forward_stdin: false,
            }
        }
        "top" => Route {
            script_rel: "client/runtime/systems/edge/mobile_ops_top.ts".to_string(),
            args: std::iter::once("status".to_string())
                .chain(rest.iter().skip(1).cloned())
                .collect(),
            forward_stdin: false,
        },
        _ => Route {
            script_rel: "client/runtime/systems/edge/protheus_edge_runtime.ts".to_string(),
            args: std::iter::once(sub)
                .chain(rest.iter().skip(1).cloned())
                .collect(),
            forward_stdin: false,
        },
    }
}

fn resolve_core_shortcuts(cmd: &str, rest: &[String]) -> Option<Route> {
    protheusctl_routes::resolve_core_shortcuts(cmd, rest)
}

pub fn usage() {
    println!("Usage: protheus <command> [flags]");
    println!("Try:");
    println!("  protheus list");
    println!("  protheus --help");
    println!("  protheus setup");
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let workspace_root = effective_workspace_root(root);
    let root = workspace_root.as_path();
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
                        script_rel: "client/runtime/systems/ops/protheus_setup_wizard.js"
                            .to_string(),
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

    let mut route = resolve_core_shortcuts(&cmd, &rest).unwrap_or_else(|| match cmd.as_str() {
        "list" => Route {
            script_rel: "client/runtime/systems/ops/protheus_command_list.js".to_string(),
            args: std::iter::once("--mode=list".to_string())
                .chain(rest)
                .collect(),
            forward_stdin: false,
        },
        "completion" => Route {
            script_rel: "client/runtime/systems/ops/protheus_completion.js".to_string(),
            args: if rest.is_empty() {
                vec!["--help".to_string()]
            } else {
                rest
            },
            forward_stdin: false,
        },
        "repl" => Route {
            script_rel: "client/runtime/systems/ops/protheus_repl.js".to_string(),
            args: rest,
            forward_stdin: true,
        },
        "setup" => Route {
            script_rel: "client/runtime/systems/ops/protheus_setup_wizard.js".to_string(),
            args: if rest.is_empty() {
                vec!["run".to_string()]
            } else {
                rest
            },
            forward_stdin: true,
        },
        "demo" => Route {
            script_rel: "client/runtime/systems/ops/protheus_demo.js".to_string(),
            args: rest,
            forward_stdin: false,
        },
        "examples" => Route {
            script_rel: "client/runtime/systems/ops/protheus_examples.js".to_string(),
            args: rest,
            forward_stdin: false,
        },
        "version" => Route {
            script_rel: "client/runtime/systems/ops/protheus_version_cli.js".to_string(),
            args: std::iter::once("version".to_string()).chain(rest).collect(),
            forward_stdin: false,
        },
        "update" => Route {
            script_rel: "client/runtime/systems/ops/protheus_version_cli.js".to_string(),
            args: std::iter::once("update".to_string()).chain(rest).collect(),
            forward_stdin: false,
        },
        "diagram" => Route {
            script_rel: "client/runtime/systems/ops/protheus_diagram.js".to_string(),
            args: rest,
            forward_stdin: false,
        },
        "shadow" => Route {
            script_rel: "client/runtime/systems/personas/shadow_cli.js".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest
            },
            forward_stdin: false,
        },
        "help" => Route {
            script_rel: "client/runtime/systems/ops/protheus_command_list.js".to_string(),
            args: std::iter::once("--mode=help".to_string())
                .chain(rest)
                .collect(),
            forward_stdin: false,
        },
        "--help" => Route {
            script_rel: "client/runtime/systems/ops/protheus_command_list.js".to_string(),
            args: std::iter::once("--mode=help".to_string())
                .chain(rest)
                .collect(),
            forward_stdin: false,
        },
        "-h" => Route {
            script_rel: "client/runtime/systems/ops/protheus_command_list.js".to_string(),
            args: std::iter::once("--mode=help".to_string())
                .chain(rest)
                .collect(),
            forward_stdin: false,
        },
        "status" => {
            let use_dashboard = rest
                .iter()
                .any(|arg| arg == "--dashboard" || arg == "dashboard");
            if use_dashboard {
                Route {
                    script_rel: "client/runtime/systems/ops/protheus_status_dashboard.js"
                        .to_string(),
                    args: rest,
                    forward_stdin: false,
                }
            } else {
                Route {
                    script_rel: "core://daemon-control".to_string(),
                    args: std::iter::once("status".to_string()).chain(rest).collect(),
                    forward_stdin: false,
                }
            }
        }
        "session" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let normalized = if [
                "register",
                "start",
                "resume",
                "attach",
                "send",
                "steer",
                "kill",
                "terminate",
                "tail",
                "inspect",
                "status",
                "list",
            ]
            .contains(&sub.as_str())
            {
                sub
            } else {
                "status".to_string()
            };
            Route {
                script_rel: "core://command-center-session".to_string(),
                args: std::iter::once(normalized)
                    .chain(rest.into_iter().skip(1))
                    .collect(),
                forward_stdin: false,
            }
        }
        "debug" => Route {
            script_rel: "client/runtime/systems/ops/protheus_debug_diagnostics.js".to_string(),
            args: rest,
            forward_stdin: false,
        },
        "health" => Route {
            script_rel: "client/runtime/systems/ops/protheus_control_plane.js".to_string(),
            args: std::iter::once("health".to_string()).chain(rest).collect(),
            forward_stdin: false,
        },
        "job-submit" => Route {
            script_rel: "client/runtime/systems/ops/protheus_control_plane.js".to_string(),
            args: std::iter::once("job-submit".to_string())
                .chain(rest)
                .collect(),
            forward_stdin: false,
        },
        "protheusctl" => Route {
            script_rel: "client/runtime/systems/ops/protheus_command_list.js".to_string(),
            args: std::iter::once("--mode=help".to_string())
                .chain(rest)
                .collect(),
            forward_stdin: false,
        },
        "skills" if rest.first().map(String::as_str) == Some("discover") => Route {
            script_rel: "client/runtime/systems/ops/protheusctl_skills_discover.js".to_string(),
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
                script_rel: "client/runtime/systems/ops/host_adaptation_operator_surface.js"
                    .to_string(),
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
                script_rel: "client/runtime/systems/ops/platform_socket_runtime.js".to_string(),
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
                script_rel: "client/runtime/systems/economy/donor_mining_dashboard.js".to_string(),
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
                script_rel: "client/runtime/systems/migration/core_migration_bridge.js".to_string(),
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
                script_rel: "client/runtime/systems/migration/universal_importers.js".to_string(),
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
                script_rel: "client/runtime/systems/ops/wasi2_execution_completeness_gate.js"
                    .to_string(),
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
                script_rel: "client/runtime/systems/ops/settlement_program.js".to_string(),
                args,
                forward_stdin: false,
            }
        }
        "edit-core" => Route {
            script_rel: "client/runtime/systems/ops/settlement_program.js".to_string(),
            args: std::iter::once("edit-core".to_string())
                .chain(rest)
                .collect(),
            forward_stdin: false,
        },
        "edit" => Route {
            script_rel: "client/runtime/systems/ops/settlement_program.js".to_string(),
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
                script_rel: "client/runtime/systems/ops/scale_readiness_program.js".to_string(),
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
                script_rel: "client/runtime/systems/ops/perception_polish_program.js".to_string(),
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
                script_rel: "client/runtime/systems/ops/fluxlattice_program.js".to_string(),
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
            script_rel: "client/runtime/systems/personas/cli.js".to_string(),
            args: rest,
            forward_stdin: true,
        },
        "arbitrate" => Route {
            script_rel: "client/runtime/systems/personas/cli.js".to_string(),
            args: std::iter::once("arbitrate".to_string())
                .chain(rest)
                .collect(),
            forward_stdin: true,
        },
        "orchestrate" => Route {
            script_rel: "client/runtime/systems/personas/orchestration.js".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest
            },
            forward_stdin: true,
        },
        "persona" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_default();
            if sub == "ambient" {
                Route {
                    script_rel: "client/runtime/systems/personas/ambient_stance.js".to_string(),
                    args: if rest.len() > 1 {
                        rest.into_iter().skip(1).collect()
                    } else {
                        vec!["status".to_string()]
                    },
                    forward_stdin: false,
                }
            } else {
                Route {
                    script_rel: "client/runtime/systems/personas/cli.js".to_string(),
                    args: if rest.is_empty() {
                        vec!["--help".to_string()]
                    } else {
                        rest
                    },
                    forward_stdin: true,
                }
            }
        }
        "assimilate" => Route {
            script_rel: "client/runtime/systems/tools/assimilate.js".to_string(),
            args: if rest.is_empty() {
                vec!["--help".to_string()]
            } else {
                rest
            },
            forward_stdin: false,
        },
        "research" => Route {
            script_rel: "core://research-plane".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest
            },
            forward_stdin: false,
        },
        "tutorial" => Route {
            script_rel: "client/runtime/systems/tools/cli_suggestion_engine.js".to_string(),
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
            script_rel: "client/runtime/systems/ops/cognitive_toolkit_cli.js".to_string(),
            args: if rest.is_empty() {
                vec!["list".to_string()]
            } else {
                rest
            },
            forward_stdin: true,
        },
        "spine" => Route {
            script_rel: "client/runtime/systems/spine/spine_safe_launcher.js".to_string(),
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
                script_rel: "client/runtime/systems/autonomy/hold_remediation_engine.js"
                    .to_string(),
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
                script_rel:
                    "client/runtime/systems/ops/rust_authoritative_microkernel_acceleration.js"
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
                script_rel: "client/runtime/systems/ops/rust_hybrid_migration_program.js"
                    .to_string(),
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
                script_rel: "client/runtime/systems/ops/productized_suite_program.js".to_string(),
                args: std::iter::once(normalized)
                    .chain(rest.into_iter().skip(1))
                    .collect(),
                forward_stdin: false,
            }
        }
        "rsi" => Route {
            script_rel: "client/cognition/adaptive/rsi/rsi_bootstrap.js".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest
            },
            forward_stdin: false,
        },
        "contract-lane" if rest.first().map(String::as_str) == Some("status") => Route {
            script_rel: "client/cognition/adaptive/rsi/rsi_bootstrap.js".to_string(),
            args: std::iter::once("contract-lane-status".to_string())
                .chain(rest.into_iter().skip(1))
                .collect(),
            forward_stdin: false,
        },
        "approve" if rest.iter().any(|arg| arg == "--rsi") => Route {
            script_rel: "client/cognition/adaptive/rsi/rsi_bootstrap.js".to_string(),
            args: std::iter::once("approve".to_string())
                .chain(rest.into_iter().filter(|arg| arg != "--rsi"))
                .collect(),
            forward_stdin: false,
        },
        _ => Route {
            script_rel: "client/runtime/systems/ops/protheus_unknown_guard.js".to_string(),
            args: std::iter::once(cmd.clone()).chain(rest).collect(),
            forward_stdin: false,
        },
    });

    let supports_json_flag = matches!(
        route.script_rel.as_str(),
        "client/runtime/systems/ops/protheus_command_list.js"
            | "client/runtime/systems/ops/protheus_setup_wizard.js"
            | "client/runtime/systems/ops/protheus_demo.js"
            | "client/runtime/systems/ops/protheus_examples.js"
            | "client/runtime/systems/ops/protheus_version_cli.js"
            | "client/runtime/systems/ops/protheus_diagram.js"
            | "client/runtime/systems/ops/protheus_completion.js"
            | "client/runtime/systems/ops/protheus_status_dashboard.js"
            | "client/runtime/systems/ops/protheus_debug_diagnostics.js"
            | "client/runtime/systems/personas/shadow_cli.js"
            | "client/runtime/systems/tools/cli_suggestion_engine.js"
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
        "client/runtime/systems/ops/protheus_demo.js"
            | "client/runtime/systems/ops/protheus_examples.js"
            | "client/runtime/systems/ops/protheus_version_cli.js"
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

    if let Err(reason) = enforce_command_center_boundary(&cmd, &route) {
        eprintln!(
            "{}",
            json!({
                "ok": false,
                "type": "protheusctl_boundary_guard",
                "error": clean(reason, 220),
                "command": cmd,
                "script_rel": route.script_rel
            })
        );
        return 1;
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
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .expect("lock_env")
    }

    #[test]
    fn resolve_workspace_root_walks_up_to_repo_marker() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let base = std::env::temp_dir().join(format!("protheusctl_root_resolve_{nonce}"));
        let nested = base.join("tmp").join("nested").join("cwd");
        fs::create_dir_all(base.join("core/layer0/ops")).expect("ops dir");
        fs::create_dir_all(base.join("client/runtime")).expect("client runtime dir");
        fs::create_dir_all(&nested).expect("nested dir");
        fs::write(
            base.join("core/layer0/ops/Cargo.toml"),
            "[package]\nname=\"dummy\"\n",
        )
        .expect("manifest");

        let resolved = resolve_workspace_root(&nested).expect("resolved");
        assert_eq!(resolved, base);
        let _ = fs::remove_dir_all(base);
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
            "client/runtime/systems/spawn/mobile_edge_swarm_bridge.ts"
        );
        assert_eq!(route.args.first().map(String::as_str), Some("enroll"));
    }

    #[test]
    fn core_shortcut_routes_rag_command() {
        let route = resolve_core_shortcuts("rag", &["search".to_string(), "--q=proof".to_string()])
            .expect("route");
        assert_eq!(route.script_rel, "core://rag");
        assert_eq!(route.args.first().map(String::as_str), Some("search"));
    }

    #[test]
    fn core_shortcut_routes_memory_command() {
        let route =
            resolve_core_shortcuts("memory", &["search".to_string(), "--q=ledger".to_string()])
                .expect("route");
        assert_eq!(route.script_rel, "core://rag");
        assert_eq!(route.args.first().map(String::as_str), Some("memory"));
        assert_eq!(route.args.get(1).map(String::as_str), Some("search"));
    }

    #[test]
    fn core_shortcut_routes_chat_with_files() {
        let route = resolve_core_shortcuts(
            "chat",
            &[
                "with".to_string(),
                "files".to_string(),
                "receipts".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://rag");
        assert_eq!(route.args.first().map(String::as_str), Some("chat"));
        assert_eq!(route.args.get(1).map(String::as_str), Some("receipts"));
    }

    #[test]
    fn core_shortcut_routes_chat_nano_to_rag_domain() {
        let route = resolve_core_shortcuts("chat", &["nano".to_string(), "--q=hello".to_string()])
            .expect("route");
        assert_eq!(route.script_rel, "core://rag");
        assert_eq!(route.args, vec!["chat", "nano", "--q=hello"]);
    }

    #[test]
    fn core_shortcut_routes_train_nano_to_rag_domain() {
        let route =
            resolve_core_shortcuts("train", &["nano".to_string(), "--depth=12".to_string()])
                .expect("route");
        assert_eq!(route.script_rel, "core://rag");
        assert_eq!(route.args, vec!["train", "nano", "--depth=12"]);
    }

    #[test]
    fn core_shortcut_routes_nano_fork_to_rag_domain() {
        let route = resolve_core_shortcuts(
            "nano",
            &["fork".to_string(), "--target=.nanochat/fork".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://rag");
        assert_eq!(route.args, vec!["nano", "fork", "--target=.nanochat/fork"]);
    }

    #[test]
    fn core_shortcut_routes_eval_enable_neuralavb() {
        let route = resolve_core_shortcuts(
            "eval",
            &[
                "enable".to_string(),
                "neuralavb".to_string(),
                "--enabled=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://eval-plane");
        assert_eq!(route.args, vec!["enable-neuralavb", "--enabled=1"]);
    }

    #[test]
    fn core_shortcut_routes_experiment_loop() {
        let route = resolve_core_shortcuts(
            "experiment",
            &[
                "loop".to_string(),
                "--run-cost-usd=8".to_string(),
                "--baseline-cost-usd=20".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://eval-plane");
        assert_eq!(
            route.args,
            vec![
                "experiment-loop",
                "--run-cost-usd=8",
                "--baseline-cost-usd=20"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_rl_upgrade_openclaw_v2() {
        let route = resolve_core_shortcuts(
            "rl",
            &[
                "upgrade".to_string(),
                "openclaw-v2".to_string(),
                "--iterations=6".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://eval-plane");
        assert_eq!(route.args, vec!["rl-upgrade", "--iterations=6"]);
    }

    #[test]
    fn core_shortcut_routes_model_optimize_minimax() {
        let route = resolve_core_shortcuts(
            "model",
            &[
                "optimize".to_string(),
                "minimax".to_string(),
                "--compact-lines=20".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://model-router");
        assert_eq!(
            route.args,
            vec!["optimize", "--profile=minimax", "--compact-lines=20"]
        );
    }

    #[test]
    fn core_shortcut_routes_model_use_cheap_to_model_router() {
        let route = resolve_core_shortcuts(
            "model",
            &[
                "use".to_string(),
                "cheap".to_string(),
                "--compact-lines=24".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://model-router");
        assert_eq!(
            route.args,
            vec!["optimize", "--profile=minimax", "--compact-lines=24"]
        );
    }

    #[test]
    fn core_shortcut_routes_model_use_bitnet_to_model_router() {
        let route = resolve_core_shortcuts(
            "model",
            &[
                "use".to_string(),
                "bitnet".to_string(),
                "--source-model=hf://openclaw/bitnet-base".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://model-router");
        assert_eq!(
            route.args,
            vec!["bitnet-use", "--source-model=hf://openclaw/bitnet-base"]
        );
    }

    #[test]
    fn core_shortcut_routes_agent_reset_to_model_router() {
        let route = resolve_core_shortcuts(
            "agent",
            &["reset".to_string(), "--scope=routing".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://model-router");
        assert_eq!(route.args, vec!["reset-agent", "--scope=routing"]);
    }

    #[test]
    fn core_shortcut_routes_economy_to_core_domain() {
        let route = resolve_core_shortcuts(
            "economy",
            &[
                "enable".to_string(),
                "all".to_string(),
                "--apply=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://llm-economy-organ");
        assert_eq!(route.args, vec!["enable", "all", "--apply=1"]);
    }

    #[test]
    fn core_shortcut_routes_economy_upgrade_trading_hand() {
        let route = resolve_core_shortcuts(
            "economy",
            &[
                "upgrade".to_string(),
                "trading-hand".to_string(),
                "--mode=paper".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://llm-economy-organ");
        assert_eq!(route.args, vec!["upgrade-trading-hand", "--mode=paper"]);
    }

    #[test]
    fn core_shortcut_routes_agent_debate_bullbear_to_economy() {
        let route = resolve_core_shortcuts(
            "agent",
            &[
                "debate".to_string(),
                "bullbear".to_string(),
                "--symbol=BTCUSD".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://llm-economy-organ");
        assert_eq!(route.args, vec!["debate-bullbear", "--symbol=BTCUSD"]);
    }

    #[test]
    fn core_shortcut_routes_network_join_hyperspace() {
        let route = resolve_core_shortcuts(
            "network",
            &[
                "join".to_string(),
                "hyperspace".to_string(),
                "--node=alpha".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://network-protocol");
        assert_eq!(route.args, vec!["join-hyperspace", "--node=alpha"]);
    }

    #[test]
    fn core_shortcut_routes_network_dashboard_to_hyperspace_core_lane() {
        let route = resolve_core_shortcuts("network", &["dashboard".to_string()]).expect("route");
        assert_eq!(route.script_rel, "core://network-protocol");
        assert_eq!(route.args, vec!["dashboard"]);
    }

    #[test]
    fn core_shortcut_routes_network_ignite_bitcoin() {
        let route = resolve_core_shortcuts(
            "network",
            &[
                "ignite".to_string(),
                "bitcoin".to_string(),
                "--apply=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://network-protocol");
        assert_eq!(route.args, vec!["ignite-bitcoin", "--apply=1"]);
    }

    #[test]
    fn core_shortcut_routes_network_status_to_network_protocol() {
        let route = resolve_core_shortcuts("network", &["status".to_string()]).expect("route");
        assert_eq!(route.script_rel, "core://network-protocol");
        assert_eq!(route.args, vec!["status"]);
    }

    #[test]
    fn core_shortcut_routes_network_merkle_root_to_network_protocol() {
        let route = resolve_core_shortcuts(
            "network",
            &[
                "merkle-root".to_string(),
                "--account=shadow:alpha".to_string(),
                "--proof=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://network-protocol");
        assert_eq!(
            route.args,
            vec!["merkle-root", "--account=shadow:alpha", "--proof=1"]
        );
    }

    #[test]
    fn core_shortcut_routes_enterprise_compliance_export_to_core_lane() {
        let route = resolve_core_shortcuts(
            "enterprise",
            &[
                "compliance".to_string(),
                "export".to_string(),
                "--profile=auditor".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://enterprise-hardening");
        assert_eq!(route.args, vec!["export-compliance", "--profile=auditor"]);
    }

    #[test]
    fn core_shortcut_routes_enterprise_scale_to_core_lane() {
        let route = resolve_core_shortcuts(
            "enterprise",
            &["scale".to_string(), "--target-nodes=10000".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://enterprise-hardening");
        assert_eq!(route.args, vec!["certify-scale", "--target-nodes=10000"]);
    }

    #[test]
    fn core_shortcut_routes_enterprise_enable_bedrock_to_core_lane() {
        let route = resolve_core_shortcuts(
            "enterprise",
            &[
                "enable".to_string(),
                "bedrock".to_string(),
                "--region=us-west-2".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://enterprise-hardening");
        assert_eq!(route.args, vec!["enable-bedrock", "--region=us-west-2"]);
    }

    #[test]
    fn core_shortcut_routes_enterprise_moat_license_to_core_lane() {
        let route = resolve_core_shortcuts(
            "enterprise",
            &[
                "moat".to_string(),
                "license".to_string(),
                "--primitives=conduit,binary_blob".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://enterprise-hardening");
        assert_eq!(
            route.args,
            vec!["moat-license", "--primitives=conduit,binary_blob"]
        );
    }

    #[test]
    fn core_shortcut_routes_genesis_truth_gate_to_core_lane() {
        let route = resolve_core_shortcuts(
            "genesis",
            &[
                "truth-gate".to_string(),
                "--regression-pass=1".to_string(),
                "--dod-pass=1".to_string(),
                "--verify-pass=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://enterprise-hardening");
        assert_eq!(
            route.args,
            vec![
                "genesis-truth-gate",
                "--regression-pass=1",
                "--dod-pass=1",
                "--verify-pass=1"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_moat_launch_to_core_lane() {
        let route = resolve_core_shortcuts(
            "moat",
            &["launch-sim".to_string(), "--events=12000".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://enterprise-hardening");
        assert_eq!(route.args, vec!["moat-launch-sim", "--events=12000"]);
    }

    #[test]
    fn core_shortcut_routes_seed_deploy_viral_to_seed_protocol() {
        let route = resolve_core_shortcuts(
            "seed",
            &[
                "deploy".to_string(),
                "viral".to_string(),
                "--targets=node-a,node-b".to_string(),
                "--apply=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://seed-protocol");
        assert_eq!(
            route.args,
            vec![
                "deploy",
                "--profile=viral",
                "--targets=node-a,node-b",
                "--apply=1"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_seed_ignite_viral_to_seed_protocol() {
        let route = resolve_core_shortcuts(
            "seed",
            &[
                "ignite".to_string(),
                "viral".to_string(),
                "--replication-cap=16".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://seed-protocol");
        assert_eq!(
            route.args,
            vec!["deploy", "--profile=viral", "--replication-cap=16"]
        );
    }

    #[test]
    fn core_shortcut_routes_seed_defaults_to_status() {
        let route = resolve_core_shortcuts("seed", &[]).expect("route");
        assert_eq!(route.script_rel, "core://seed-protocol");
        assert_eq!(route.args, vec!["status"]);
    }

    #[test]
    fn core_shortcut_routes_keys_open_to_intelligence_nexus() {
        let route = resolve_core_shortcuts("keys", &["open".to_string()]).expect("route");
        assert_eq!(route.script_rel, "core://intelligence-nexus");
        assert_eq!(route.args, vec!["open"]);
    }

    #[test]
    fn core_shortcut_routes_keys_add_alias_to_add_key() {
        let route = resolve_core_shortcuts(
            "keys",
            &["add".to_string(), "--provider=openai".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://intelligence-nexus");
        assert_eq!(route.args, vec!["add-key", "--provider=openai"]);
    }

    #[test]
    fn core_shortcut_routes_keys_rotate_alias_to_rotate_key() {
        let route = resolve_core_shortcuts(
            "keys",
            &["rotate".to_string(), "--provider=openai".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://intelligence-nexus");
        assert_eq!(route.args, vec!["rotate-key", "--provider=openai"]);
    }

    #[test]
    fn core_shortcut_routes_keys_revoke_alias_to_revoke_key() {
        let route = resolve_core_shortcuts(
            "keys",
            &["revoke".to_string(), "--provider=openai".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://intelligence-nexus");
        assert_eq!(route.args, vec!["revoke-key", "--provider=openai"]);
    }

    #[test]
    fn core_shortcut_routes_graph_pagerank_to_graph_toolkit() {
        let route = resolve_core_shortcuts(
            "graph",
            &[
                "pagerank".to_string(),
                "--dataset=memory-vault".to_string(),
                "--iterations=32".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://graph-toolkit");
        assert_eq!(
            route.args,
            vec!["pagerank", "--dataset=memory-vault", "--iterations=32"]
        );
    }

    #[test]
    fn core_shortcut_routes_graph_defaults_to_status() {
        let route = resolve_core_shortcuts("graph", &[]).expect("route");
        assert_eq!(route.script_rel, "core://graph-toolkit");
        assert_eq!(route.args, vec!["status"]);
    }

    #[test]
    fn core_shortcut_routes_research_stealth_flags_to_core_plane_fetch() {
        let route = resolve_core_shortcuts(
            "research",
            &[
                "--stealth".to_string(),
                "--url=https://example.com".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://research-plane");
        assert_eq!(
            route.args,
            vec!["fetch", "--url=https://example.com", "--mode=stealth"]
        );
    }

    #[test]
    fn core_shortcut_routes_research_default_fetch_mode_to_auto() {
        let route = resolve_core_shortcuts(
            "research",
            &["fetch".to_string(), "--url=https://example.com".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://research-plane");
        assert_eq!(
            route.args,
            vec!["fetch", "--url=https://example.com", "--mode=auto"]
        );
    }

    #[test]
    fn core_shortcut_routes_research_firmware_to_binary_vuln_lane() {
        let route = resolve_core_shortcuts(
            "research",
            &[
                "--firmware=fw.bin".to_string(),
                "--format=jsonl".to_string(),
                "--strict=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://binary-vuln-plane");
        assert_eq!(
            route.args,
            vec![
                "scan",
                "--dx-source=research-firmware",
                "--input=fw.bin",
                "--format=jsonl",
                "--strict=1"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_top_level_crawl_goal_to_research_plane() {
        let route = resolve_core_shortcuts(
            "crawl",
            &[
                "memory".to_string(),
                "coherence".to_string(),
                "--max-pages=4".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://research-plane");
        assert_eq!(
            route.args,
            vec!["goal-crawl", "--goal=memory coherence", "--max-pages=4"]
        );
    }

    #[test]
    fn core_shortcut_routes_top_level_map_to_research_plane() {
        let route =
            resolve_core_shortcuts("map", &["example.com".to_string(), "--depth=3".to_string()])
                .expect("route");
        assert_eq!(route.script_rel, "core://research-plane");
        assert_eq!(
            route.args,
            vec!["map-site", "--domain=example.com", "--depth=3"]
        );
    }

    #[test]
    fn core_shortcut_routes_top_level_monitor_to_research_plane() {
        let route = resolve_core_shortcuts(
            "monitor",
            &[
                "https://example.com/feed".to_string(),
                "--strict=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://research-plane");
        assert_eq!(
            route.args,
            vec!["monitor", "--url=https://example.com/feed", "--strict=1"]
        );
    }

    #[test]
    fn core_shortcut_routes_assimilate_scrapy_core_to_research_plane() {
        let route = resolve_core_shortcuts(
            "assimilate",
            &["scrape://scrapy-core".to_string(), "--strict=1".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://research-plane");
        assert_eq!(route.args, vec!["template-governance", "--strict=1"]);
    }

    #[test]
    fn core_shortcut_routes_assimilate_firecrawl_core_to_research_plane() {
        let route = resolve_core_shortcuts(
            "assimilate",
            &[
                "scrape://firecrawl-core".to_string(),
                "--strict=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://research-plane");
        assert_eq!(
            route.args,
            vec!["firecrawl-template-governance", "--strict=1"]
        );
    }

    #[test]
    fn core_shortcut_routes_assimilate_doc2dict_core_to_parse_plane() {
        let route = resolve_core_shortcuts(
            "assimilate",
            &[
                "parse://doc2dict-core".to_string(),
                "--strict=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://parse-plane");
        assert_eq!(route.args, vec!["template-governance", "--strict=1"]);
    }

    #[test]
    fn core_shortcut_routes_parse_doc_to_parse_plane() {
        let route = resolve_core_shortcuts(
            "parse",
            &[
                "doc".to_string(),
                "fixtures/report.html".to_string(),
                "--mapping=default".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://parse-plane");
        assert_eq!(
            route.args,
            vec![
                "parse-doc",
                "--file=fixtures/report.html",
                "--mapping=default"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_parse_export_to_parse_plane() {
        let route = resolve_core_shortcuts(
            "parse",
            &[
                "export".to_string(),
                "core/local/state/ops/parse_plane/flatten/latest.json".to_string(),
                "core/local/artifacts/parse/export.json".to_string(),
                "--format=json".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://parse-plane");
        assert_eq!(
            route.args,
            vec![
                "export",
                "--from-path=core/local/state/ops/parse_plane/flatten/latest.json",
                "--output-path=core/local/artifacts/parse/export.json",
                "--format=json"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_parse_visualize_to_parse_plane() {
        let route = resolve_core_shortcuts(
            "parse",
            &[
                "visualize".to_string(),
                "core/local/state/ops/parse_plane/parse_doc/latest.json".to_string(),
                "--strict=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://parse-plane");
        assert_eq!(
            route.args,
            vec![
                "visualize",
                "--from-path=core/local/state/ops/parse_plane/parse_doc/latest.json",
                "--strict=1"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_mcp_status_to_mcp_plane() {
        let route = resolve_core_shortcuts("mcp", &[]).expect("route");
        assert_eq!(route.script_rel, "core://mcp-plane");
        assert_eq!(route.args, vec!["status"]);
    }

    #[test]
    fn core_shortcut_routes_mcp_expose_to_mcp_plane() {
        let route = resolve_core_shortcuts(
            "mcp",
            &[
                "expose".to_string(),
                "research-agent".to_string(),
                "--tools=fetch,extract".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://mcp-plane");
        assert_eq!(
            route.args,
            vec!["expose", "--agent=research-agent", "--tools=fetch,extract"]
        );
    }

    #[test]
    fn core_shortcut_routes_flow_compile_to_flow_plane() {
        let route = resolve_core_shortcuts(
            "flow",
            &[
                "compile".to_string(),
                "core/local/artifacts/flow/canvas.json".to_string(),
                "--strict=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://flow-plane");
        assert_eq!(
            route.args,
            vec![
                "compile",
                "--canvas-path=core/local/artifacts/flow/canvas.json",
                "--strict=1"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_flow_run_to_flow_plane() {
        let route = resolve_core_shortcuts(
            "flow",
            &[
                "run".to_string(),
                "--run-id=batch29-flow".to_string(),
                "--strict=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://flow-plane");
        assert_eq!(
            route.args,
            vec![
                "playground",
                "--op=play",
                "--run-id=batch29-flow",
                "--strict=1"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_flow_install_to_flow_plane() {
        let route = resolve_core_shortcuts(
            "flow",
            &[
                "install".to_string(),
                "--manifest=planes/contracts/flow/template_pack_manifest_v1.json".to_string(),
                "--strict=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://flow-plane");
        assert_eq!(
            route.args,
            vec![
                "install",
                "--manifest=planes/contracts/flow/template_pack_manifest_v1.json",
                "--strict=1"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_blobs_to_binary_blob_runtime() {
        let route =
            resolve_core_shortcuts("blobs", &["migrate".to_string(), "--apply=1".to_string()])
                .expect("route");
        assert_eq!(route.script_rel, "core://binary-blob-runtime");
        assert_eq!(route.args, vec!["migrate", "--apply=1"]);
    }

    #[test]
    fn core_shortcut_routes_directives_migrate_to_directive_kernel() {
        let route = resolve_core_shortcuts(
            "directives",
            &["migrate".to_string(), "--apply=1".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://directive-kernel");
        assert_eq!(route.args, vec!["migrate", "--apply=1"]);
    }

    #[test]
    fn core_shortcut_routes_directives_dashboard_to_directive_kernel() {
        let route =
            resolve_core_shortcuts("directives", &["dashboard".to_string()]).expect("route");
        assert_eq!(route.script_rel, "core://directive-kernel");
        assert_eq!(route.args, vec!["dashboard"]);
    }

    #[test]
    fn core_shortcut_routes_prime_sign_to_directive_kernel() {
        let route = resolve_core_shortcuts(
            "prime",
            &["sign".to_string(), "--directive=Always safe".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://directive-kernel");
        assert_eq!(route.args, vec!["prime-sign", "--directive=Always safe"]);
    }

    #[test]
    fn core_shortcut_routes_organism_ignite_to_organism_layer() {
        let route =
            resolve_core_shortcuts("organism", &["ignite".to_string(), "--apply=1".to_string()])
                .expect("route");
        assert_eq!(route.script_rel, "core://organism-layer");
        assert_eq!(route.args, vec!["ignite", "--apply=1"]);
    }

    #[test]
    fn core_shortcut_routes_rsi_ignite_to_rsi_ignition() {
        let route = resolve_core_shortcuts("rsi", &["ignite".to_string(), "--apply=1".to_string()])
            .expect("route");
        assert_eq!(route.script_rel, "core://rsi-ignition");
        assert_eq!(route.args, vec!["ignite", "--apply=1"]);
    }

    #[test]
    fn core_shortcut_routes_veto_to_directive_kernel() {
        let route =
            resolve_core_shortcuts("veto", &["--action=rsi_proposal".to_string()]).expect("route");
        assert_eq!(route.script_rel, "core://directive-kernel");
        assert_eq!(
            route.args,
            vec![
                "compliance-check",
                "--action=veto",
                "--allow=0",
                "--action=rsi_proposal"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_model_buy_credits_to_intelligence_nexus() {
        let route = resolve_core_shortcuts(
            "model",
            &[
                "buy".to_string(),
                "credits".to_string(),
                "--provider=openai".to_string(),
                "--amount=250".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://intelligence-nexus");
        assert_eq!(
            route.args,
            vec!["buy-credits", "--provider=openai", "--amount=250"]
        );
    }

    #[test]
    fn core_shortcut_routes_compute_share_to_network_compute_proof() {
        let route =
            resolve_core_shortcuts("compute", &["share".to_string(), "--gpu=1".to_string()])
                .expect("route");
        assert_eq!(route.script_rel, "core://p2p-gossip-seed");
        assert_eq!(route.args, vec!["compute-proof", "--share=1", "--gpu=1"]);
    }

    #[test]
    fn core_shortcut_routes_skills_enable_to_assimilation_controller() {
        let route = resolve_core_shortcuts(
            "skills",
            &[
                "enable".to_string(),
                "perplexity-mode".to_string(),
                "--apply=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://assimilation-controller");
        assert_eq!(
            route.args,
            vec!["skills-enable", "perplexity-mode", "--apply=1"]
        );
    }

    #[test]
    fn core_shortcut_routes_skills_dashboard_to_skills_plane() {
        let route = resolve_core_shortcuts("skills", &["dashboard".to_string()]).expect("route");
        assert_eq!(route.script_rel, "core://skills-plane");
        assert_eq!(route.args, vec!["dashboard"]);
    }

    #[test]
    fn core_shortcut_routes_skills_spawn_to_assimilation_controller() {
        let route = resolve_core_shortcuts(
            "skills",
            &[
                "spawn".to_string(),
                "--task=launch".to_string(),
                "--roles=researcher,executor".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://assimilation-controller");
        assert_eq!(
            route.args,
            vec![
                "skills-spawn-subagents",
                "--task=launch",
                "--roles=researcher,executor"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_skills_computer_use_to_assimilation_controller() {
        let route = resolve_core_shortcuts(
            "skills",
            &[
                "computer-use".to_string(),
                "--action=open browser".to_string(),
                "--target=desktop".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://assimilation-controller");
        assert_eq!(
            route.args,
            vec![
                "skills-computer-use",
                "--action=open browser",
                "--target=desktop"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_skills_status_to_skills_plane() {
        let route = resolve_core_shortcuts("skills", &[]).expect("route");
        assert_eq!(route.script_rel, "core://skills-plane");
        assert_eq!(route.args, vec!["status"]);
    }

    #[test]
    fn core_shortcut_routes_skill_create_to_skills_plane() {
        let route = resolve_core_shortcuts(
            "skill",
            &[
                "create".to_string(),
                "weekly".to_string(),
                "growth".to_string(),
                "report".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://skills-plane");
        assert_eq!(route.args, vec!["create", "--name=weekly growth report"]);
    }

    #[test]
    fn core_shortcut_routes_skill_run_to_skills_plane() {
        let route = resolve_core_shortcuts(
            "skill",
            &[
                "run".to_string(),
                "--skill=researcher".to_string(),
                "--input=check".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://skills-plane");
        assert_eq!(
            route.args,
            vec!["run", "--skill=researcher", "--input=check"]
        );
    }

    #[test]
    fn core_shortcut_routes_skill_list_to_skills_plane() {
        let route = resolve_core_shortcuts("skill", &["list".to_string()]).expect("route");
        assert_eq!(route.script_rel, "core://skills-plane");
        assert_eq!(route.args, vec!["list"]);
    }

    #[test]
    fn core_shortcut_routes_binary_vuln_to_core_lane() {
        let route = resolve_core_shortcuts(
            "binary-vuln",
            &["scan".to_string(), "--input=a.bin".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://binary-vuln-plane");
        assert_eq!(route.args, vec!["scan", "--input=a.bin"]);
    }

    #[test]
    fn core_shortcut_routes_business_to_business_plane() {
        let route = resolve_core_shortcuts("business", &[]).expect("route");
        assert_eq!(route.script_rel, "core://business-plane");
        assert_eq!(route.args, vec!["status"]);
    }

    #[test]
    fn core_shortcut_routes_canyon_to_canyon_plane() {
        let route = resolve_core_shortcuts("canyon", &[]).expect("route");
        assert_eq!(route.script_rel, "core://canyon-plane");
        assert_eq!(route.args, vec!["status"]);
    }

    #[test]
    fn core_shortcut_routes_canyon_benchmark_gate_to_canyon_plane() {
        let route = resolve_core_shortcuts(
            "canyon",
            &[
                "benchmark-gate".to_string(),
                "--op=run".to_string(),
                "--milestone=day90".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://canyon-plane");
        assert_eq!(
            route.args,
            vec!["benchmark-gate", "--op=run", "--milestone=day90"]
        );
    }

    #[test]
    fn core_shortcut_routes_init_to_canyon_ecosystem_init() {
        let route = resolve_core_shortcuts(
            "init",
            &["starter-web".to_string(), "--target-dir=/tmp/demo".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://canyon-plane");
        assert_eq!(
            route.args,
            vec![
                "ecosystem",
                "--op=init",
                "--template=starter-web",
                "--target-dir=/tmp/demo"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_marketplace_publish_to_canyon_ecosystem() {
        let route = resolve_core_shortcuts(
            "marketplace",
            &[
                "publish".to_string(),
                "--hand-id=starter".to_string(),
                "--receipt-file=/tmp/r.json".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://canyon-plane");
        assert_eq!(
            route.args,
            vec![
                "ecosystem",
                "--op=marketplace-publish",
                "--hand-id=starter",
                "--receipt-file=/tmp/r.json"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_replay_to_enterprise_hardening() {
        let route = resolve_core_shortcuts("replay", &["--receipt-hash=abc123".to_string()])
            .expect("route");
        assert_eq!(route.script_rel, "core://enterprise-hardening");
        assert_eq!(route.args, vec!["replay", "--receipt-hash=abc123"]);
    }

    #[test]
    fn core_shortcut_routes_ai_to_enterprise_hardening() {
        let route = resolve_core_shortcuts("ai", &["--model=ollama/llama3.2:latest".to_string()])
            .expect("route");
        assert_eq!(route.script_rel, "core://enterprise-hardening");
        assert_eq!(route.args, vec!["ai", "--model=ollama/llama3.2:latest"]);
    }

    #[test]
    fn core_shortcut_routes_chaos_to_enterprise_hardening() {
        let route =
            resolve_core_shortcuts("chaos", &["run".to_string(), "--agents=16".to_string()])
                .expect("route");
        assert_eq!(route.script_rel, "core://enterprise-hardening");
        assert_eq!(route.args, vec!["chaos-run", "--agents=16"]);
    }

    #[test]
    fn core_shortcut_routes_chaos_isolate_to_enterprise_hardening() {
        let route = resolve_core_shortcuts(
            "chaos",
            &["isolate".to_string(), "--agents=4".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://enterprise-hardening");
        assert_eq!(route.args, vec!["chaos-run", "--suite=isolate", "--agents=4"]);
    }

    #[test]
    fn core_shortcut_routes_assistant_to_enterprise_hardening() {
        let route =
            resolve_core_shortcuts("assistant", &["--topic=onboarding".to_string()])
                .expect("route");
        assert_eq!(route.script_rel, "core://enterprise-hardening");
        assert_eq!(route.args, vec!["assistant-mode", "--topic=onboarding"]);
    }

    #[test]
    fn core_shortcut_routes_adaptive_default_to_adaptive_lane_status() {
        let route = resolve_core_shortcuts("adaptive", &[]).expect("route");
        assert_eq!(route.script_rel, "core://adaptive-intelligence");
        assert_eq!(route.args, vec!["status"]);
    }

    #[test]
    fn core_shortcut_routes_adaptive_propose_to_adaptive_lane() {
        let route = resolve_core_shortcuts(
            "adaptive-intelligence",
            &[
                "propose".to_string(),
                "--prompt=refactor scheduler".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://adaptive-intelligence");
        assert_eq!(route.args, vec!["propose", "--prompt=refactor scheduler"]);
    }

    #[test]
    fn core_shortcut_routes_gov_alias_to_government_plane() {
        let route = resolve_core_shortcuts("gov", &["classification".to_string()]).expect("route");
        assert_eq!(route.script_rel, "core://government-plane");
        assert_eq!(route.args, vec!["classification"]);
    }

    #[test]
    fn core_shortcut_routes_bank_alias_to_finance_plane() {
        let route = resolve_core_shortcuts("bank", &["transaction".to_string()]).expect("route");
        assert_eq!(route.script_rel, "core://finance-plane");
        assert_eq!(route.args, vec!["transaction"]);
    }

    #[test]
    fn core_shortcut_routes_hospital_alias_to_healthcare_plane() {
        let route = resolve_core_shortcuts("hospital", &["cds".to_string()]).expect("route");
        assert_eq!(route.script_rel, "core://healthcare-plane");
        assert_eq!(route.args, vec!["cds"]);
    }

    #[test]
    fn core_shortcut_routes_vertical_to_vertical_plane() {
        let route = resolve_core_shortcuts("vertical", &[]).expect("route");
        assert_eq!(route.script_rel, "core://vertical-plane");
        assert_eq!(route.args, vec!["status"]);
    }

    #[test]
    fn core_shortcut_routes_nexus_to_nexus_plane() {
        let route = resolve_core_shortcuts("nexus", &[]).expect("route");
        assert_eq!(route.script_rel, "core://nexus-plane");
        assert_eq!(route.args, vec!["status"]);
    }

    #[test]
    fn core_shortcut_routes_scan_binary_to_binary_vuln_lane() {
        let route =
            resolve_core_shortcuts("scan", &["binary".to_string(), "firmware.bin".to_string()])
                .expect("route");
        assert_eq!(route.script_rel, "core://binary-vuln-plane");
        assert_eq!(
            route.args,
            vec!["scan", "--dx-source=scan-binary", "--input=firmware.bin"]
        );
    }

    #[test]
    fn core_shortcut_routes_shadow_discover_to_hermes_lane() {
        let route = resolve_core_shortcuts(
            "shadow",
            &["discover".to_string(), "--shadow=alpha".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://hermes-plane");
        assert_eq!(route.args, vec!["discover", "--shadow=alpha"]);
    }

    #[test]
    fn core_shortcut_routes_top_to_hermes_cockpit() {
        let route = resolve_core_shortcuts("top", &[]).expect("route");
        assert_eq!(route.script_rel, "core://hermes-plane");
        assert_eq!(route.args, vec!["cockpit"]);
    }

    #[test]
    fn core_shortcut_routes_status_dashboard_to_hermes_cockpit() {
        let route = resolve_core_shortcuts("status", &["--dashboard".to_string()]).expect("route");
        assert_eq!(route.script_rel, "core://hermes-plane");
        assert_eq!(route.args, vec!["cockpit"]);
    }

    #[test]
    fn core_shortcut_routes_browser_to_vbrowser_plane() {
        let route = resolve_core_shortcuts(
            "browser",
            &["start".to_string(), "--url=https://example.com".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://vbrowser-plane");
        assert_eq!(
            route.args,
            vec!["session-start", "--url=https://example.com"]
        );
    }

    #[test]
    fn core_shortcut_routes_agency_create_to_agency_plane() {
        let route = resolve_core_shortcuts(
            "agency",
            &[
                "create".to_string(),
                "--template=frontend-wizard".to_string(),
                "--name=ux-shadow".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://agency-plane");
        assert_eq!(
            route.args,
            vec![
                "create-shadow",
                "--template=frontend-wizard",
                "--name=ux-shadow"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_shadow_browser_flag_to_vbrowser_plane() {
        let route = resolve_core_shortcuts(
            "shadow",
            &[
                "--browser".to_string(),
                "--session-id=live".to_string(),
                "--url=https://example.com".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://vbrowser-plane");
        assert_eq!(
            route.args,
            vec![
                "session-start",
                "--shadow=default-shadow",
                "--session-id=live",
                "--url=https://example.com"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_shadow_delegate_to_hermes_plane() {
        let route = resolve_core_shortcuts(
            "shadow",
            &[
                "delegate".to_string(),
                "--task=triage".to_string(),
                "--parent=alpha".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://hermes-plane");
        assert_eq!(
            route.args,
            vec!["delegate", "--task=triage", "--parent=alpha"]
        );
    }

    #[test]
    fn core_shortcut_routes_shadow_continuity_to_hermes_plane() {
        let route = resolve_core_shortcuts(
            "shadow",
            &[
                "continuity".to_string(),
                "--op=status".to_string(),
                "--session-id=s1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://hermes-plane");
        assert_eq!(
            route.args,
            vec!["continuity", "--op=status", "--session-id=s1"]
        );
    }

    #[test]
    fn core_shortcut_routes_shadow_create_template_to_agency_plane() {
        let route = resolve_core_shortcuts(
            "shadow",
            &[
                "create".to_string(),
                "--template=security-engineer".to_string(),
                "--name=sec-shadow".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://agency-plane");
        assert_eq!(
            route.args,
            vec![
                "create-shadow",
                "--template=security-engineer",
                "--name=sec-shadow"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_team_dashboard_to_collab_plane() {
        let route =
            resolve_core_shortcuts("team", &["dashboard".to_string(), "--team=ops".to_string()])
                .expect("route");
        assert_eq!(route.script_rel, "core://collab-plane");
        assert_eq!(route.args, vec!["dashboard", "--team=ops"]);
    }

    #[test]
    fn core_shortcut_routes_team_schedule_to_collab_plane() {
        let route = resolve_core_shortcuts(
            "team",
            &[
                "schedule".to_string(),
                "--op=kickoff".to_string(),
                "--team=ops".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://collab-plane");
        assert_eq!(route.args, vec!["schedule", "--op=kickoff", "--team=ops"]);
    }

    #[test]
    fn core_shortcut_routes_company_budget_to_company_plane() {
        let route = resolve_core_shortcuts(
            "company",
            &[
                "budget".to_string(),
                "--agent=alpha".to_string(),
                "--tokens=100".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://company-plane");
        assert_eq!(
            route.args,
            vec!["budget-enforce", "--agent=alpha", "--tokens=100"]
        );
    }

    #[test]
    fn core_shortcut_routes_company_ticket_to_company_plane() {
        let route = resolve_core_shortcuts(
            "company",
            &[
                "ticket".to_string(),
                "--op=create".to_string(),
                "--title=Fix ingestion".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://company-plane");
        assert_eq!(
            route.args,
            vec!["ticket", "--op=create", "--title=Fix ingestion"]
        );
    }

    #[test]
    fn core_shortcut_routes_company_heartbeat_to_company_plane() {
        let route = resolve_core_shortcuts(
            "company",
            &[
                "heartbeat".to_string(),
                "--op=tick".to_string(),
                "--team=ops".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://company-plane");
        assert_eq!(route.args, vec!["heartbeat", "--op=tick", "--team=ops"]);
    }

    #[test]
    fn core_shortcut_routes_top_level_ticket_to_company_plane() {
        let route = resolve_core_shortcuts(
            "ticket",
            &[
                "--op=create".to_string(),
                "--title=Stability hotfix".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://company-plane");
        assert_eq!(
            route.args,
            vec!["ticket", "--op=create", "--title=Stability hotfix"]
        );
    }

    #[test]
    fn core_shortcut_routes_top_level_heartbeat_to_company_plane() {
        let route = resolve_core_shortcuts(
            "heartbeat",
            &["--op=tick".to_string(), "--team=platform".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://company-plane");
        assert_eq!(
            route.args,
            vec!["heartbeat", "--op=tick", "--team=platform"]
        );
    }

    #[test]
    fn core_shortcut_routes_substrate_capture_to_substrate_plane() {
        let route = resolve_core_shortcuts(
            "substrate",
            &[
                "capture".to_string(),
                "--adapter=wifi-csi-esp32".to_string(),
                "--strict=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://substrate-plane");
        assert_eq!(
            route.args,
            vec!["csi-capture", "--adapter=wifi-csi-esp32", "--strict=1"]
        );
    }

    #[test]
    fn core_shortcut_routes_eye_enable_wifi_to_substrate_plane() {
        let route = resolve_core_shortcuts("eye", &["enable".to_string(), "wifi".to_string()])
            .expect("route");
        assert_eq!(route.script_rel, "core://substrate-plane");
        assert_eq!(route.args, vec!["eye-bind", "--op=enable", "--source=wifi"]);
    }

    #[test]
    fn core_shortcut_routes_substrate_enable_biological_to_substrate_plane() {
        let route = resolve_core_shortcuts(
            "substrate",
            &[
                "enable".to_string(),
                "biological".to_string(),
                "--persona=neural-watch".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://substrate-plane");
        assert_eq!(
            route.args,
            vec!["bio-enable", "--mode=biological", "--persona=neural-watch"]
        );
    }

    #[test]
    fn core_shortcut_routes_observability_monitor_to_observability_plane() {
        let route = resolve_core_shortcuts(
            "observability",
            &[
                "monitor".to_string(),
                "--severity=high".to_string(),
                "--message=latency_spike".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://observability-plane");
        assert_eq!(
            route.args,
            vec!["monitor", "--severity=high", "--message=latency_spike"]
        );
    }

    #[test]
    fn core_shortcut_routes_observability_selfhost_status_without_forced_deploy() {
        let route = resolve_core_shortcuts(
            "observability",
            &["selfhost".to_string(), "status".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://observability-plane");
        assert_eq!(route.args, vec!["selfhost", "status"]);
    }

    #[test]
    fn core_shortcut_routes_observability_enable_acp_provenance() {
        let route = resolve_core_shortcuts(
            "observability",
            &[
                "enable".to_string(),
                "acp-provenance".to_string(),
                "--visibility-mode=meta".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://observability-plane");
        assert_eq!(
            route.args,
            vec!["acp-provenance", "--op=enable", "--visibility-mode=meta"]
        );
    }

    #[test]
    fn core_shortcut_routes_schedule_to_persist_plane() {
        let route = resolve_core_shortcuts(
            "schedule",
            &[
                "--op=upsert".to_string(),
                "--job=nightly".to_string(),
                "--cron=0 2 * * *".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://persist-plane");
        assert_eq!(
            route.args,
            vec![
                "schedule",
                "--op=upsert",
                "--job=nightly",
                "--cron=0 2 * * *"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_mobile_to_persist_plane() {
        let route = resolve_core_shortcuts(
            "mobile",
            &["--op=publish".to_string(), "--session-id=phone".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://persist-plane");
        assert_eq!(
            route.args,
            vec!["mobile-cockpit", "--op=publish", "--session-id=phone"]
        );
    }

    #[test]
    fn core_shortcut_routes_mobile_daemon_enable_to_persist_plane() {
        let route = resolve_core_shortcuts(
            "mobile",
            &[
                "daemon".to_string(),
                "enable".to_string(),
                "--platform=android".to_string(),
                "--edge-backend=bitnet".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://persist-plane");
        assert_eq!(
            route.args,
            vec![
                "mobile-daemon",
                "--op=enable",
                "--platform=android",
                "--edge-backend=bitnet"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_connector_add_to_persist_plane() {
        let route = resolve_core_shortcuts("connector", &["add".to_string(), "slack".to_string()])
            .expect("route");
        assert_eq!(route.script_rel, "core://persist-plane");
        assert_eq!(
            route.args,
            vec!["connector", "--op=add", "--provider=slack"]
        );
    }

    #[test]
    fn core_shortcut_routes_cowork_delegate_to_persist_plane() {
        let route = resolve_core_shortcuts(
            "cowork",
            &[
                "delegate".to_string(),
                "--task=ship-batch16".to_string(),
                "--parent=ops-lead".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://persist-plane");
        assert_eq!(
            route.args,
            vec![
                "cowork",
                "--op=delegate",
                "--task=ship-batch16",
                "--parent=ops-lead"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_app_run_code_engineer_to_app_plane() {
        let route = resolve_core_shortcuts(
            "app",
            &[
                "run".to_string(),
                "code-engineer".to_string(),
                "build".to_string(),
                "an".to_string(),
                "agent".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://app-plane");
        assert_eq!(
            route.args,
            vec!["run", "--app=code-engineer", "--prompt=build an agent"]
        );
    }

    #[test]
    fn core_shortcut_routes_app_run_chat_ui_to_app_plane() {
        let route = resolve_core_shortcuts(
            "app",
            &[
                "run".to_string(),
                "chat-ui".to_string(),
                "--session-id=s1".to_string(),
                "hello".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://app-plane");
        assert_eq!(
            route.args,
            vec!["run", "--app=chat-ui", "--session-id=s1", "--message=hello"]
        );
    }

    #[test]
    fn core_shortcut_routes_top_level_chat_starter_history_action() {
        let route = resolve_core_shortcuts(
            "chat-starter",
            &["history".to_string(), "--session-id=s1".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://app-plane");
        assert_eq!(
            route.args,
            vec!["history", "--app=chat-starter", "--session-id=s1"]
        );
    }

    #[test]
    fn core_shortcut_routes_top_level_chat_starter_plain_message_to_run() {
        let route = resolve_core_shortcuts(
            "chat-starter",
            &[
                "hello".to_string(),
                "from".to_string(),
                "shortcut".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://app-plane");
        assert_eq!(
            route.args,
            vec!["run", "--app=chat-starter", "--message=hello from shortcut"]
        );
    }

    #[test]
    fn core_shortcut_routes_top_level_chat_ui_switch_provider_action() {
        let route = resolve_core_shortcuts(
            "chat-ui",
            &[
                "switch-provider".to_string(),
                "--provider=anthropic".to_string(),
                "--model=claude-sonnet".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://app-plane");
        assert_eq!(
            route.args,
            vec![
                "switch-provider",
                "--app=chat-ui",
                "--provider=anthropic",
                "--model=claude-sonnet"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_build_goal_to_app_plane() {
        let route = resolve_core_shortcuts(
            "build",
            &[
                "ship".to_string(),
                "a".to_string(),
                "receipted".to_string(),
                "api".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://app-plane");
        assert_eq!(
            route.args,
            vec![
                "build",
                "--app=code-engineer",
                "--goal=ship a receipted api"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_snowball_start_to_core_plane() {
        let route = resolve_core_shortcuts(
            "snowball",
            &[
                "start".to_string(),
                "--cycle-id=s17".to_string(),
                "--drops=core-hardening,app-refine".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://snowball-plane");
        assert_eq!(
            route.args,
            vec![
                "start",
                "--cycle-id=s17",
                "--drops=core-hardening,app-refine"
            ]
        );
    }

    #[test]
    fn core_shortcut_routes_snowball_regress_alias_to_melt_refine() {
        let route = resolve_core_shortcuts(
            "snowball",
            &[
                "regress".to_string(),
                "--cycle-id=s35".to_string(),
                "--regression-pass=0".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://snowball-plane");
        assert_eq!(
            route.args,
            vec!["melt-refine", "--cycle-id=s35", "--regression-pass=0"]
        );
    }

    #[test]
    fn core_shortcut_routes_orchestrate_agency_to_company_plane() {
        let route = resolve_core_shortcuts(
            "orchestrate",
            &["agency".to_string(), "research".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://company-plane");
        assert_eq!(route.args, vec!["orchestrate-agency", "--team=research"]);
    }

    #[test]
    fn core_shortcut_routes_browser_snapshot_to_vbrowser_plane() {
        let route = resolve_core_shortcuts(
            "browser",
            &[
                "snapshot".to_string(),
                "--session-id=snap-1".to_string(),
                "--refs=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://vbrowser-plane");
        assert_eq!(
            route.args,
            vec!["snapshot", "--session-id=snap-1", "--refs=1"]
        );
    }

    #[test]
    fn core_shortcut_routes_hand_new_to_autonomy_controller() {
        let route = resolve_core_shortcuts(
            "hand",
            &[
                "new".to_string(),
                "--hand-id=alpha".to_string(),
                "--template=researcher".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://autonomy-controller");
        assert_eq!(
            route.args,
            vec!["hand-new", "--hand-id=alpha", "--template=researcher"]
        );
    }

    #[test]
    fn core_shortcut_routes_hands_enable_scheduled_to_assimilation_controller() {
        let route = resolve_core_shortcuts(
            "hands",
            &[
                "enable".to_string(),
                "scheduled".to_string(),
                "--strict=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://assimilation-controller");
        assert_eq!(
            route.args,
            vec!["scheduled-hands", "--op=enable", "--strict=1"]
        );
    }

    #[test]
    fn core_shortcut_routes_oracle_to_network_protocol() {
        let route = resolve_core_shortcuts(
            "oracle",
            &[
                "query".to_string(),
                "--provider=polymarket".to_string(),
                "--event=btc".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://network-protocol");
        assert_eq!(
            route.args,
            vec!["oracle-query", "--provider=polymarket", "--event=btc"]
        );
    }

    #[test]
    fn core_shortcut_routes_truth_weight_to_network_protocol() {
        let route = resolve_core_shortcuts(
            "truth",
            &["weight".to_string(), "--market=pm:btc-100k".to_string()],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://network-protocol");
        assert_eq!(route.args, vec!["truth-weight", "--market=pm:btc-100k"]);
    }

    #[test]
    fn core_shortcut_routes_agent_ephemeral_to_autonomy_controller() {
        let route = resolve_core_shortcuts(
            "agent",
            &[
                "run".to_string(),
                "--ephemeral".to_string(),
                "--goal=triage".to_string(),
                "--domain=research".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://autonomy-controller");
        assert_eq!(
            route.args,
            vec!["ephemeral-run", "--goal=triage", "--domain=research"]
        );
    }

    #[test]
    fn core_shortcut_routes_agent_trunk_status_to_autonomy_controller() {
        let route = resolve_core_shortcuts(
            "agent",
            &[
                "status".to_string(),
                "--trunk".to_string(),
                "--strict=1".to_string(),
            ],
        )
        .expect("route");
        assert_eq!(route.script_rel, "core://autonomy-controller");
        assert_eq!(route.args, vec!["trunk-status", "--strict=1"]);
    }

    #[test]
    fn local_fail_closed_signal_blocks_dispatch() {
        let _guard = env_guard();
        std::env::set_var("PROTHEUS_CTL_SECURITY_GATE_DISABLED", "0");
        std::env::set_var("PROTHEUS_CTL_SECURITY_COVENANT_VIOLATION", "1");
        let root = PathBuf::from(".");
        let verdict = evaluate_dispatch_security(
            &root,
            "client/runtime/systems/ops/protheus_control_plane.js",
            &[],
        );
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
            "client/runtime/systems/ops/protheus_control_plane.js",
        );
        let root = PathBuf::from(".");
        let verdict = evaluate_dispatch_security(
            &root,
            "client/runtime/systems/ops/protheus_control_plane.js",
            &[],
        );
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

    #[test]
    fn command_center_boundary_allows_core_session_route() {
        let route = Route {
            script_rel: "core://command-center-session".to_string(),
            args: vec!["resume".to_string(), "session-1".to_string()],
            forward_stdin: false,
        };
        assert!(enforce_command_center_boundary("session", &route).is_ok());
    }

    #[test]
    fn command_center_boundary_rejects_client_red_legion_authority() {
        let route = Route {
            script_rel: "client/runtime/systems/red_legion/command_center.ts".to_string(),
            args: vec!["resume".to_string(), "session-1".to_string()],
            forward_stdin: false,
        };
        let err = enforce_command_center_boundary("session", &route).expect_err("must reject");
        assert!(err.contains("red_legion_client_authority_forbidden"));
    }

    #[test]
    fn command_center_boundary_rejects_non_core_session_route() {
        let route = Route {
            script_rel: "client/runtime/systems/ops/protheusd.js".to_string(),
            args: vec!["status".to_string()],
            forward_stdin: false,
        };
        let err = enforce_command_center_boundary("session", &route).expect_err("must reject");
        assert!(err.contains("session_route_must_be_core_authoritative"));
    }

    #[test]
    fn session_route_supports_extended_lifecycle_commands() {
        let route = Route {
            script_rel: "core://command-center-session".to_string(),
            args: vec!["kill".to_string(), "session-9".to_string()],
            forward_stdin: false,
        };
        assert!(enforce_command_center_boundary("session", &route).is_ok());
    }
}
