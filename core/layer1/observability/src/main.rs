// SPDX-License-Identifier: Apache-2.0
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use protheus_observability_core_v1::{
    load_embedded_observability_profile_json, run_chaos_resilience_json, ChaosScenarioRequest,
    TraceEvent,
};
use std::env;
use std::fs;

fn parse_arg(args: &[String], key: &str) -> Option<String> {
    for arg in args {
        if let Some((k, v)) = arg.split_once('=') {
            if k == key {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn load_request_json(args: &[String]) -> Result<String, String> {
    if let Some(v) = parse_arg(args, "--request-json") {
        return Ok(v);
    }
    if let Some(v) = parse_arg(args, "--request-base64") {
        let bytes = BASE64_STANDARD
            .decode(v.as_bytes())
            .map_err(|err| format!("base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes).map_err(|err| format!("utf8_decode_failed:{err}"))?;
        return Ok(text);
    }
    if let Some(v) = parse_arg(args, "--request-file") {
        return fs::read_to_string(v.as_str())
            .map_err(|err| format!("request_file_read_failed:{err}"));
    }
    Err("missing_request_payload".to_string())
}

fn demo_request() -> ChaosScenarioRequest {
    ChaosScenarioRequest {
        scenario_id: "observability_demo".to_string(),
        events: vec![
            TraceEvent {
                trace_id: "e1".to_string(),
                ts_millis: 1_000,
                source: "client/systems/observability".to_string(),
                operation: "trace.capture".to_string(),
                severity: "low".to_string(),
                tags: vec!["runtime.guardrails".to_string()],
                payload_digest: "sha256:e1".to_string(),
                signed: true,
            },
            TraceEvent {
                trace_id: "e2".to_string(),
                ts_millis: 1_120,
                source: "client/systems/red_legion".to_string(),
                operation: "chaos.replay".to_string(),
                severity: "medium".to_string(),
                tags: vec!["chaos.replay".to_string(), "drift".to_string()],
                payload_digest: "sha256:e2".to_string(),
                signed: true,
            },
        ],
        cycles: 200000,
        inject_fault_every: 500,
        enforce_fail_closed: true,
    }
}

fn usage() {
    eprintln!("Usage:");
    eprintln!("  observability_core load-profile");
    eprintln!("  observability_core run-chaos --request-json=<payload>");
    eprintln!("  observability_core run-chaos --request-base64=<base64_payload>");
    eprintln!("  observability_core run-chaos --request-file=<path>");
    eprintln!("  observability_core demo");
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("demo");

    match command {
        "load-profile" => match load_embedded_observability_profile_json() {
            Ok(payload) => println!("{}", payload),
            Err(err) => {
                eprintln!(
                    "{}",
                    serde_json::json!({ "ok": false, "error": err.to_string() })
                );
                std::process::exit(1);
            }
        },
        "run-chaos" => match load_request_json(&args[1..]) {
            Ok(request_json) => match run_chaos_resilience_json(&request_json) {
                Ok(payload) => println!("{}", payload),
                Err(err) => {
                    eprintln!(
                        "{}",
                        serde_json::json!({ "ok": false, "error": err.to_string() })
                    );
                    std::process::exit(1);
                }
            },
            Err(err) => {
                eprintln!("{}", serde_json::json!({ "ok": false, "error": err }));
                std::process::exit(1);
            }
        },
        "demo" => {
            let request_json =
                serde_json::to_string(&demo_request()).unwrap_or_else(|_| "{}".to_string());
            match run_chaos_resilience_json(&request_json) {
                Ok(payload) => println!("{}", payload),
                Err(err) => {
                    eprintln!(
                        "{}",
                        serde_json::json!({ "ok": false, "error": err.to_string() })
                    );
                    std::process::exit(1);
                }
            }
        }
        _ => {
            usage();
            std::process::exit(1);
        }
    }
}
