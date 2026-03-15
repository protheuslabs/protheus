// Layer ownership: core/layer0/ops (authoritative)
// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{
    daemon_control, deterministic_receipt_hash, now_iso, parse_os_args,
    status_runtime_efficiency_floor,
};
use serde_json::{json, Value};
use std::env;
use std::path::{Path, PathBuf};

#[cfg(feature = "embedded-minimal-core")]
type PlaneRunner = fn(&Path, &[String]) -> i32;

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
    #[cfg(feature = "embedded-minimal-core")]
    println!("  protheusd embedded-core-status");
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

#[cfg(feature = "embedded-minimal-core")]
fn embedded_minimal_core_planes() -> [(&'static str, &'static str, PlaneRunner); 5] {
    [
        (
            "layer0-directives",
            "directive_kernel",
            protheus_ops_core::directive_kernel::run,
        ),
        (
            "layer0-attention",
            "attention_queue",
            protheus_ops_core::attention_queue::run,
        ),
        (
            "layer0-receipts",
            "metakernel",
            protheus_ops_core::metakernel::run,
        ),
        (
            "layer0-min-memory",
            "memory_plane",
            protheus_ops_core::memory_plane::run,
        ),
        (
            "layer-1-substrate-detector",
            "substrate_plane",
            protheus_ops_core::substrate_plane::run,
        ),
    ]
}

#[cfg(feature = "embedded-minimal-core")]
fn embedded_minimal_core_status() -> Value {
    let planes = embedded_minimal_core_planes();
    let lane_entries: Vec<Value> = planes
        .iter()
        .map(|(feature, lane, runner)| {
            json!({
                "feature": feature,
                "lane": lane,
                "runner_ptr": format!("{:p}", *runner as *const ())
            })
        })
        .collect();
    let runner_ptr_fingerprint = deterministic_receipt_hash(&json!(lane_entries));
    let mut out = json!({
        "ok": true,
        "type": "protheusd_embedded_minimal_core_status",
        "ts": now_iso(),
        "embedded_feature": "embedded-minimal-core",
        "planes_embedded": lane_entries,
        "runner_ptr_fingerprint": runner_ptr_fingerprint,
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
        #[cfg(feature = "embedded-minimal-core")]
        "embedded-core-status" => {
            print_json(&embedded_minimal_core_status());
            std::process::exit(0);
        }
        _ => {
            usage();
            print_json(&cli_error("unknown_command", command.as_str()));
            std::process::exit(1);
        }
    }
}
