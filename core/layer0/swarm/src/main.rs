// SPDX-License-Identifier: Apache-2.0
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use protheus_swarm_core_v1::{orchestrate_swarm, orchestrate_swarm_json, SwarmRequest};
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

fn load_request(args: &[String]) -> Result<String, String> {
    if let Some(v) = parse_arg(args, "--request-json") {
        return Ok(v);
    }
    if let Some(v) = parse_arg(args, "--request-base64") {
        let bytes = BASE64_STANDARD
            .decode(v.as_bytes())
            .map_err(|e| format!("base64_decode_failed:{e}"))?;
        let text = String::from_utf8(bytes).map_err(|e| format!("utf8_decode_failed:{e}"))?;
        return Ok(text);
    }
    if let Some(v) = parse_arg(args, "--request-file") {
        return fs::read_to_string(v.as_str()).map_err(|e| format!("request_file_read_failed:{e}"));
    }
    Err("missing_request_payload".to_string())
}

fn demo_request() -> SwarmRequest {
    SwarmRequest {
        swarm_id: "swarm_demo".to_string(),
        mode: "deterministic".to_string(),
        agents: vec![
            protheus_swarm_core_v1::SwarmAgent {
                id: "a1".to_string(),
                skills: vec!["research".to_string(), "coding".to_string()],
                capacity: 3,
                reliability_pct: 91.0,
            },
            protheus_swarm_core_v1::SwarmAgent {
                id: "a2".to_string(),
                skills: vec!["coding".to_string()],
                capacity: 2,
                reliability_pct: 84.0,
            },
        ],
        tasks: vec![
            protheus_swarm_core_v1::SwarmTask {
                id: "t1".to_string(),
                required_skill: "coding".to_string(),
                weight: 2,
                priority: 8,
            },
            protheus_swarm_core_v1::SwarmTask {
                id: "t2".to_string(),
                required_skill: "research".to_string(),
                weight: 1,
                priority: 6,
            },
        ],
    }
}

fn usage() {
    eprintln!("Usage:");
    eprintln!("  swarm_core run --request-json=<payload>");
    eprintln!("  swarm_core run --request-base64=<payload>");
    eprintln!("  swarm_core demo");
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("demo");

    match command {
        "run" => match load_request(&args[1..]) {
            Ok(payload) => match orchestrate_swarm_json(&payload) {
                Ok(v) => println!("{}", v),
                Err(err) => {
                    eprintln!("{}", serde_json::json!({"ok": false, "error": err}));
                    std::process::exit(1);
                }
            },
            Err(err) => {
                eprintln!("{}", serde_json::json!({"ok": false, "error": err}));
                std::process::exit(1);
            }
        },
        "demo" => {
            let receipt = orchestrate_swarm(&demo_request()).expect("demo");
            println!(
                "{}",
                serde_json::to_string(&receipt).unwrap_or_else(|_| "{}".to_string())
            );
        }
        _ => {
            usage();
            std::process::exit(1);
        }
    }
}
