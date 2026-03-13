// Layer ownership: core/layer0/ops (authoritative)
// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{
    daemon_control, deterministic_receipt_hash, now_iso, parse_os_args,
    status_runtime_efficiency_floor,
};
use serde_json::{json, Value};
use std::env;
use std::path::PathBuf;

fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn usage() {
    println!("Usage:");
    println!("  protheusd status");
    println!("  protheusd start [--strict=1|0]");
    println!("  protheusd stop [--strict=1|0]");
    println!("  protheusd restart [--strict=1|0]");
    println!("  protheusd attach [--strict=1|0]");
    println!("  protheusd subscribe [--strict=1|0]");
    println!("  protheusd tick [--strict=1|0]");
    println!("  protheusd diagnostics [--strict=1|0]");
    println!("  protheusd efficiency-status");
}

fn cli_error(error: &str, command: &str) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "protheusd_error",
        "command": command,
        "error": error,
        "ts": now_iso()
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn main() {
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let args = parse_os_args(env::args_os().skip(1));
    let command = args
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        usage();
        return;
    }

    match command.as_str() {
        "status" | "start" | "stop" | "restart" | "attach" | "subscribe" | "tick"
        | "diagnostics" => {
            let exit = daemon_control::run(&cwd, &args);
            std::process::exit(exit);
        }
        "efficiency-status" => {
            let parsed = protheus_ops_core::parse_args(&[]);
            let out = status_runtime_efficiency_floor(&cwd, &parsed).json;
            print_json(&out);
            std::process::exit(0);
        }
        _ => {
            usage();
            print_json(&cli_error("unknown_command", command.as_str()));
            std::process::exit(1);
        }
    }
}
