// SPDX-License-Identifier: Apache-2.0
// Layer ownership: client/pure-workspace (thin Rust client surface)

use protheus_pure_workspace::{profile, tiny_max_profile};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn usage() {
    println!("Usage:");
    println!(
        "  protheus-pure-workspace init [--pure=1|0] [--tiny-max=1|0] [--target-dir=<path>] [--template=<name>] [--dry-run=1|0]"
    );
    println!("  protheus-pure-workspace status [--json=1|0] [--tiny-max=1|0]");
    println!(
        "  protheus-pure-workspace conduit [status|start|stop|restart|attach|subscribe|tick|diagnostics]"
    );
    println!(
        "  protheus-pure-workspace think --prompt=<text> [--session-id=<id>] [--memory-limit=<n>]"
    );
    println!("  protheus-pure-workspace research [status|fetch|diagnostics] [flags]");
    println!("  protheus-pure-workspace memory [status|write|query] [flags]");
    println!("  protheus-pure-workspace orchestration <invoke|help> [flags]");
    println!("  protheus-pure-workspace swarm-runtime <status|spawn|sessions|results|tick|metrics|test> [flags]");
    println!("  protheus-pure-workspace capability-profile [--hardware-class=<mcu|legacy|standard|high>] [--memory-mb=<n>] [--cpu-cores=<n>] [--tiny-max=1|0]");
    println!("  protheus-pure-workspace probe [--sleep-ms=<n>] [--tiny-max=1|0]");
    println!("  protheus-pure-workspace benchmark-ping [--tiny-max=1|0]");
}

fn init_usage() {
    println!(
        "protheus-pure-workspace init [--pure=1|0] [--tiny-max=1|0] [--target-dir=<path>] [--template=<name>] [--dry-run=1|0]"
    );
}

fn parse_flag_value(args: &[String], key: &str) -> Option<String> {
    let inline = format!("{key}=");
    let mut idx = 0usize;
    while idx < args.len() {
        let token = args[idx].trim();
        if token == key {
            if let Some(next) = args.get(idx + 1) {
                return Some(next.trim().to_string());
            }
        } else if let Some(value) = token.strip_prefix(&inline) {
            return Some(value.trim().to_string());
        }
        idx += 1;
    }
    None
}

fn parse_bool(raw: Option<&str>, default: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        Some(v) if v.is_empty() => default,
        Some(_) => default,
        None => default,
    }
}

fn now_iso() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{ts}")
}

fn crate_name_from_target(target: &Path) -> String {
    let name = target
        .file_name()
        .and_then(|segment| segment.to_str())
        .unwrap_or("pure-workspace-app");
    let mut out = String::new();
    for ch in name.chars() {
        let allowed = ch.is_ascii_alphanumeric() || ch == '_';
        let mapped = if allowed {
            ch.to_ascii_lowercase()
        } else {
            '_'
        };
        out.push(mapped);
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "pure_workspace_app".to_string()
    } else {
        trimmed
    }
}

fn write_file(path: &Path, body: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create_dir_failed:{}:{err}", parent.display()))?;
    }
    fs::write(path, body).map_err(|err| format!("write_failed:{}:{err}", path.display()))
}

fn run_init(args: &[String]) -> Result<(), String> {
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        init_usage();
        return Ok(());
    }
    let pure_requested = parse_bool(parse_flag_value(args, "--pure").as_deref(), true);
    if !pure_requested {
        return Err("pure_workspace_requires_pure_flag".to_string());
    }
    let dry_run = args.iter().any(|arg| arg == "--dry-run")
        || parse_bool(parse_flag_value(args, "--dry-run").as_deref(), false);
    let tiny_max = parse_bool(parse_flag_value(args, "--tiny-max").as_deref(), false)
        || parse_bool(parse_flag_value(args, "--tiny_max").as_deref(), false);
    let target = parse_flag_value(args, "--target-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("pure-workspace")
        });
    let template = parse_flag_value(args, "--template")
        .unwrap_or_else(|| "pure-rust".to_string())
        .trim()
        .to_string();
    let crate_name = crate_name_from_target(&target);

    let readme_path = target.join("README.md");
    let cargo_path = target.join("Cargo.toml");
    let source_path = target.join("src").join("main.rs");
    let manifest_path = target.join("protheus.init.json");

    if !dry_run {
        let readme = format!(
            "# Protheus Pure Workspace\n\nMode: pure (Rust-only)\nTiny-max: {tiny_max}\nTemplate: {template}\n\nThis workspace intentionally excludes Node/TypeScript surfaces.\n"
        );
        let cargo = format!(
            "[package]\nname = \"{crate_name}\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\n"
        );
        let source = "fn main() {\n    println!(\"pure workspace ready\");\n}\n";
        let manifest = format!(
            "{{\n  \"mode\": \"{}\",\n  \"template\": \"{}\",\n  \"created_at\": \"{}\",\n  \"components\": [\"pure_client\", \"daemon\"],\n  \"tiny_max\": {}\n}}\n",
            if tiny_max { "pure-tiny-max" } else { "pure" },
            template,
            now_iso(),
            if tiny_max { "true" } else { "false" }
        );
        write_file(&readme_path, &readme)?;
        write_file(&cargo_path, &cargo)?;
        write_file(&source_path, source)?;
        write_file(&manifest_path, &manifest)?;
    }

    let p = if tiny_max {
        tiny_max_profile()
    } else {
        profile()
    };
    println!(
        "{{\"ok\":true,\"type\":\"pure_workspace_init\",\"mode\":\"{}\",\"tiny_max\":{},\"dry_run\":{},\"target_dir\":\"{}\",\"template\":\"{}\",\"files\":[\"{}\",\"{}\",\"{}\",\"{}\"],\"install_size_target_mb\":{},\"cold_start_target_ms\":{},\"idle_memory_target_mb\":{}}}",
        p.mode,
        if tiny_max { "true" } else { "false" },
        if dry_run { "true" } else { "false" },
        target.display(),
        template,
        readme_path.display(),
        cargo_path.display(),
        source_path.display(),
        manifest_path.display(),
        p.install_size_target_mb,
        p.cold_start_target_ms,
        p.idle_memory_target_mb
    );
    Ok(())
}

fn run_status(args: &[String]) {
    let json_mode = parse_bool(parse_flag_value(args, "--json").as_deref(), true);
    let tiny_max = parse_bool(parse_flag_value(args, "--tiny-max").as_deref(), false)
        || parse_bool(parse_flag_value(args, "--tiny_max").as_deref(), false);
    let p = if tiny_max {
        tiny_max_profile()
    } else {
        profile()
    };
    if json_mode {
        println!(
            "{{\"ok\":true,\"type\":\"pure_workspace_status\",\"mode\":\"{}\",\"tiny_max\":{},\"rust_only\":{},\"conduit_required\":{},\"cold_start_target_ms\":{},\"idle_memory_target_mb\":{},\"install_size_target_mb\":{}}}",
            p.mode,
            if tiny_max { "true" } else { "false" },
            if p.rust_only { "true" } else { "false" },
            if p.conduit_required { "true" } else { "false" },
            p.cold_start_target_ms,
            p.idle_memory_target_mb,
            p.install_size_target_mb
        );
    } else {
        println!("mode: {}", p.mode);
        println!("tiny_max: {}", tiny_max);
        println!("rust_only: {}", p.rust_only);
        println!("conduit_required: {}", p.conduit_required);
        println!("cold_start_target_ms: {}", p.cold_start_target_ms);
        println!("idle_memory_target_mb: {}", p.idle_memory_target_mb);
        println!("install_size_target_mb: {}", p.install_size_target_mb);
    }
}

fn run_probe(args: &[String]) {
    let tiny_max = parse_bool(parse_flag_value(args, "--tiny-max").as_deref(), false)
        || parse_bool(parse_flag_value(args, "--tiny_max").as_deref(), false);
    let default_sleep = if tiny_max { 120 } else { 500 };
    let sleep_ms = parse_flag_value(args, "--sleep-ms")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default_sleep)
        .clamp(1, 10_000);
    thread::sleep(Duration::from_millis(sleep_ms));
    println!(
        "{{\"ok\":true,\"type\":\"pure_workspace_probe\",\"tiny_max\":{},\"sleep_ms\":{sleep_ms},\"ts\":\"{}\"}}",
        if tiny_max { "true" } else { "false" },
        now_iso()
    );
}

fn run_daemon(command: &str, args: &[String]) -> i32 {
    let mut candidates = Vec::new();
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("protheusd"));
            candidates.push(dir.join("infringd"));
        }
    }
    // PATH fallbacks for installed wrappers.
    candidates.push(PathBuf::from("protheusd"));
    candidates.push(PathBuf::from("infringd"));

    let mut last_err = String::new();
    for candidate in candidates {
        let result = Command::new(&candidate).arg(command).args(args).status();
        match result {
            Ok(status) => return status.code().unwrap_or(1),
            Err(err) => {
                last_err = format!("{}:{}", candidate.display(), err);
            }
        }
    }
    eprintln!(
        "{{\"ok\":false,\"type\":\"pure_workspace_daemon_error\",\"command\":\"{}\",\"error\":\"spawn_failed:{}\"}}",
        command, last_err
    );
    1
}

fn run_conduit(args: &[String]) -> i32 {
    let action = args
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let passthrough = args.iter().skip(1).cloned().collect::<Vec<_>>();
    run_daemon(action.as_str(), &passthrough)
}

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let cmd = args
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    match cmd.as_str() {
        "help" | "--help" | "-h" => {
            usage();
        }
        "init" => {
            if let Err(err) = run_init(&args[1..]) {
                eprintln!(
                    "{{\"ok\":false,\"type\":\"pure_workspace_init_error\",\"error\":\"{}\"}}",
                    err
                );
                std::process::exit(1);
            }
        }
        "status" => run_status(&args[1..]),
        "probe" => run_probe(&args[1..]),
        "conduit" => {
            let code = run_conduit(&args[1..]);
            std::process::exit(code);
        }
        "think" => {
            let code = run_daemon("think", &args[1..]);
            std::process::exit(code);
        }
        "research" => {
            let mut passthrough = args.iter().skip(1).cloned().collect::<Vec<_>>();
            if passthrough.is_empty() {
                passthrough.push("status".to_string());
            }
            let code = run_daemon("research", &passthrough);
            std::process::exit(code);
        }
        "memory" => {
            let mut passthrough = args.iter().skip(1).cloned().collect::<Vec<_>>();
            if passthrough.is_empty() {
                passthrough.push("status".to_string());
            }
            let code = run_daemon("memory", &passthrough);
            std::process::exit(code);
        }
        "orchestration" => {
            let mut passthrough = args.iter().skip(1).cloned().collect::<Vec<_>>();
            if passthrough.is_empty() {
                passthrough.push("help".to_string());
            }
            let code = run_daemon("orchestration", &passthrough);
            std::process::exit(code);
        }
        "swarm-runtime" | "swarm" => {
            let mut passthrough = args.iter().skip(1).cloned().collect::<Vec<_>>();
            if passthrough.is_empty() {
                passthrough.push("status".to_string());
            }
            let code = run_daemon("swarm-runtime", &passthrough);
            std::process::exit(code);
        }
        "capability-profile" => {
            let code = run_daemon("capability-profile", &args[1..]);
            std::process::exit(code);
        }
        "benchmark-ping" => {}
        _ => {
            usage();
            eprintln!(
                "{{\"ok\":false,\"type\":\"pure_workspace_error\",\"error\":\"unknown_command\",\"command\":\"{}\"}}",
                cmd
            );
            std::process::exit(2);
        }
    }
}
