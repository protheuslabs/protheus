// SPDX-License-Identifier: Apache-2.0
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use protheus_graph_core_v1::{run_workflow_json, viz_dot};
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

fn load_yaml(args: &[String]) -> Result<String, String> {
    if let Some(v) = parse_arg(args, "--yaml") {
        return Ok(v);
    }
    if let Some(v) = parse_arg(args, "--yaml-base64") {
        let bytes = BASE64_STANDARD
            .decode(v.as_bytes())
            .map_err(|e| format!("base64_decode_failed:{e}"))?;
        let text = String::from_utf8(bytes).map_err(|e| format!("utf8_decode_failed:{e}"))?;
        return Ok(text);
    }
    if let Some(v) = parse_arg(args, "--yaml-file") {
        return fs::read_to_string(v.as_str()).map_err(|e| format!("yaml_file_read_failed:{e}"));
    }
    Err("missing_yaml_payload".to_string())
}

fn usage() {
    eprintln!("Usage:");
    eprintln!("  graph_core run --yaml=<payload>");
    eprintln!("  graph_core viz --yaml=<payload>");
    eprintln!("  graph_core demo");
}

fn demo_yaml() -> String {
    serde_json::json!({
        "workflow_id": "graph_demo",
        "nodes": [
            {"id": "collect", "kind": "task"},
            {"id": "score", "kind": "task"},
            {"id": "ship", "kind": "task"}
        ],
        "edges": [
            {"from": "collect", "to": "score"},
            {"from": "score", "to": "ship"}
        ]
    })
    .to_string()
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("demo");

    match command {
        "run" => match load_yaml(&args[1..]) {
            Ok(yaml) => match run_workflow_json(&yaml) {
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
        "viz" => match load_yaml(&args[1..]) {
            Ok(yaml) => match viz_dot(&yaml) {
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
            let yaml = demo_yaml();
            println!(
                "{}",
                run_workflow_json(&yaml).unwrap_or_else(|_| "{}".to_string())
            );
        }
        _ => {
            usage();
            std::process::exit(1);
        }
    }
}
