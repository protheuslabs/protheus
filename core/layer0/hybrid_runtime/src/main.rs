mod crdt_merge;
mod econ_crypto;
mod execution_replay;
mod hybrid_envelope;
mod hybrid_plan;
mod memory_hotpath;
mod red_chaos;
mod security_vault;
mod telemetry_emit;
mod wasm_bridge;

use serde_json::{json, Value};
use std::env;
use std::path::Path;

fn parse_arg<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    let prefix = format!("--{}=", key);
    args.iter().find_map(|arg| arg.strip_prefix(&prefix))
}

fn parse_bool(v: Option<&str>, fallback: bool) -> bool {
    match v.unwrap_or("").trim().to_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn parse_u32(v: Option<&str>, fallback: u32) -> u32 {
    v.and_then(|raw| raw.trim().parse::<u32>().ok())
        .unwrap_or(fallback)
}

fn parse_usize(v: Option<&str>, fallback: usize) -> usize {
    v.and_then(|raw| raw.trim().parse::<usize>().ok())
        .unwrap_or(fallback)
}

fn parse_f64(v: Option<&str>, fallback: f64) -> f64 {
    v.and_then(|raw| raw.trim().parse::<f64>().ok())
        .unwrap_or(fallback)
}

fn events_from_arg(v: Option<&str>) -> Vec<String> {
    let raw = v.unwrap_or("start,hydrate,execute,receipt,commit");
    raw.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn print_json(v: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(v)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn help() -> Value {
    json!({
        "ok": true,
        "commands": [
            "hybrid-plan --root=. --min=15 --max=25",
            "memory-hotpath",
            "execution-replay --events=a,b,c",
            "security-vault --tampered=0|1",
            "crdt-merge",
            "econ-crypto",
            "red-chaos --cycles=100000",
            "telemetry-emit",
            "wasm-bridge",
            "hybrid-envelope --within-target=0|1 --completed=9"
        ]
    })
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let cmd = args.get(0).map(String::as_str).unwrap_or("help");

    let out = match cmd {
        "help" | "--help" | "-h" => help(),
        "hybrid-plan" => {
            let root = hybrid_plan::resolve_root(parse_arg(&args, "root"));
            let min = parse_f64(parse_arg(&args, "min"), 15.0);
            let max = parse_f64(parse_arg(&args, "max"), 25.0);
            hybrid_plan::scan_language_share(Path::new(&root), min, max)
        }
        "memory-hotpath" => memory_hotpath::sample_report(),
        "execution-replay" => {
            let events = events_from_arg(parse_arg(&args, "events"));
            execution_replay::replay_report(&events)
        }
        "security-vault" => {
            let tampered = parse_bool(parse_arg(&args, "tampered"), false);
            let mut report = security_vault::sample_report();
            let allowed = security_vault::fail_closed_attestation(tampered);
            if let Some(obj) = report.as_object_mut() {
                obj.insert("ok".to_string(), Value::Bool(allowed));
                obj.insert(
                    "attestation".to_string(),
                    json!({"tamper_detected": tampered, "allowed": allowed, "mode": "fail_closed"}),
                );
            }
            report
        }
        "crdt-merge" => crdt_merge::sample_report(),
        "econ-crypto" => econ_crypto::sample_report(),
        "red-chaos" => {
            let cycles = parse_u32(parse_arg(&args, "cycles"), 50_000);
            red_chaos::sample_report(cycles)
        }
        "telemetry-emit" => telemetry_emit::sample_report(),
        "wasm-bridge" => wasm_bridge::sample_report(),
        "hybrid-envelope" => {
            let within_target = parse_bool(parse_arg(&args, "within-target"), false);
            let completed = parse_usize(parse_arg(&args, "completed"), 9);
            hybrid_envelope::build_envelope(within_target, completed)
        }
        other => json!({"ok": false, "error": "unknown_command", "command": other}),
    };

    print_json(&out);
}
