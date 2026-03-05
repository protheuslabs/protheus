use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use execution_core::{
    apply_governance_json, compose_micro_tasks_json, decompose_goal_json, dispatch_rows_json,
    evaluate_directive_gate_json, evaluate_heroic_gate_json, evaluate_route_complexity_json,
    evaluate_route_decision_json, evaluate_route_habit_readiness_json, evaluate_route_json,
    evaluate_route_match_json, evaluate_route_primitives_json, evaluate_route_reflex_match_json,
    queue_rows_json, run_autoscale_json, run_inversion_json, run_sprint_contract_json,
    run_workflow, run_workflow_json, summarize_dispatch_json, summarize_tasks_json,
};
use std::env;
use std::fs;

fn usage() {
    eprintln!("Usage:");
    eprintln!("  execution_core run --yaml=<payload>");
    eprintln!("  execution_core run --yaml-base64=<base64_payload>");
    eprintln!("  execution_core run --yaml-file=<path>");
    eprintln!("  execution_core decompose --payload=<json_payload>");
    eprintln!("  execution_core decompose --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core decompose --payload-file=<path>");
    eprintln!("  execution_core compose --payload=<json_payload>");
    eprintln!("  execution_core compose --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core compose --payload-file=<path>");
    eprintln!("  execution_core task-summary --payload=<json_payload>");
    eprintln!("  execution_core task-summary --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core task-summary --payload-file=<path>");
    eprintln!("  execution_core dispatch-summary --payload=<json_payload>");
    eprintln!("  execution_core dispatch-summary --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core dispatch-summary --payload-file=<path>");
    eprintln!("  execution_core queue-rows --payload=<json_payload>");
    eprintln!("  execution_core queue-rows --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core queue-rows --payload-file=<path>");
    eprintln!("  execution_core dispatch-rows --payload=<json_payload>");
    eprintln!("  execution_core dispatch-rows --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core dispatch-rows --payload-file=<path>");
    eprintln!("  execution_core directive-gate --payload=<json_payload>");
    eprintln!("  execution_core directive-gate --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core directive-gate --payload-file=<path>");
    eprintln!("  execution_core route-primitives --payload=<json_payload>");
    eprintln!("  execution_core route-primitives --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core route-primitives --payload-file=<path>");
    eprintln!("  execution_core route-match --payload=<json_payload>");
    eprintln!("  execution_core route-match --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core route-match --payload-file=<path>");
    eprintln!("  execution_core route-reflex-match --payload=<json_payload>");
    eprintln!("  execution_core route-reflex-match --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core route-reflex-match --payload-file=<path>");
    eprintln!("  execution_core route-complexity --payload=<json_payload>");
    eprintln!("  execution_core route-complexity --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core route-complexity --payload-file=<path>");
    eprintln!("  execution_core route-evaluate --payload=<json_payload>");
    eprintln!("  execution_core route-evaluate --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core route-evaluate --payload-file=<path>");
    eprintln!("  execution_core route-decision --payload=<json_payload>");
    eprintln!("  execution_core route-decision --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core route-decision --payload-file=<path>");
    eprintln!("  execution_core route-habit-readiness --payload=<json_payload>");
    eprintln!("  execution_core route-habit-readiness --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core route-habit-readiness --payload-file=<path>");
    eprintln!("  execution_core heroic-gate --payload=<json_payload>");
    eprintln!("  execution_core heroic-gate --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core heroic-gate --payload-file=<path>");
    eprintln!("  execution_core apply-governance --payload=<json_payload>");
    eprintln!("  execution_core apply-governance --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core apply-governance --payload-file=<path>");
    eprintln!("  execution_core sprint-contract --payload=<json_payload>");
    eprintln!("  execution_core sprint-contract --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core sprint-contract --payload-file=<path>");
    eprintln!("  execution_core autoscale --payload=<json_payload>");
    eprintln!("  execution_core autoscale --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core autoscale --payload-file=<path>");
    eprintln!("  execution_core inversion --payload=<json_payload>");
    eprintln!("  execution_core inversion --payload-base64=<base64_json_payload>");
    eprintln!("  execution_core inversion --payload-file=<path>");
    eprintln!("  execution_core demo");
}

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
            .map_err(|err| format!("base64_decode_failed:{}", err))?;
        let text = String::from_utf8(bytes).map_err(|err| format!("utf8_decode_failed:{}", err))?;
        return Ok(text);
    }
    if let Some(v) = parse_arg(args, "--yaml-file") {
        let content = fs::read_to_string(v.as_str())
            .map_err(|err| format!("yaml_file_read_failed:{}", err))?;
        return Ok(content);
    }
    Err("missing_yaml_payload".to_string())
}

fn load_payload(args: &[String]) -> Result<String, String> {
    if let Some(v) = parse_arg(args, "--payload") {
        return Ok(v);
    }
    if let Some(v) = parse_arg(args, "--payload-base64") {
        let bytes = BASE64_STANDARD
            .decode(v.as_bytes())
            .map_err(|err| format!("base64_decode_failed:{}", err))?;
        let text = String::from_utf8(bytes).map_err(|err| format!("utf8_decode_failed:{}", err))?;
        return Ok(text);
    }
    if let Some(v) = parse_arg(args, "--payload-file") {
        let content = fs::read_to_string(v.as_str())
            .map_err(|err| format!("payload_file_read_failed:{}", err))?;
        return Ok(content);
    }
    Err("missing_json_payload".to_string())
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("demo");

    match command {
        "run" => match load_yaml(&args[1..]) {
            Ok(yaml) => {
                println!("{}", run_workflow_json(&yaml));
            }
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "decompose" => match load_payload(&args[1..]) {
            Ok(payload) => match decompose_goal_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "compose" => match load_payload(&args[1..]) {
            Ok(payload) => match compose_micro_tasks_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "task-summary" => match load_payload(&args[1..]) {
            Ok(payload) => match summarize_tasks_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "dispatch-summary" => match load_payload(&args[1..]) {
            Ok(payload) => match summarize_dispatch_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "queue-rows" => match load_payload(&args[1..]) {
            Ok(payload) => match queue_rows_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "dispatch-rows" => match load_payload(&args[1..]) {
            Ok(payload) => match dispatch_rows_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "directive-gate" => match load_payload(&args[1..]) {
            Ok(payload) => match evaluate_directive_gate_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "route-primitives" => match load_payload(&args[1..]) {
            Ok(payload) => match evaluate_route_primitives_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "route-match" => match load_payload(&args[1..]) {
            Ok(payload) => match evaluate_route_match_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "route-reflex-match" => match load_payload(&args[1..]) {
            Ok(payload) => match evaluate_route_reflex_match_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "route-complexity" => match load_payload(&args[1..]) {
            Ok(payload) => match evaluate_route_complexity_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "route-evaluate" => match load_payload(&args[1..]) {
            Ok(payload) => match evaluate_route_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "route-decision" => match load_payload(&args[1..]) {
            Ok(payload) => match evaluate_route_decision_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "route-habit-readiness" => match load_payload(&args[1..]) {
            Ok(payload) => match evaluate_route_habit_readiness_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "heroic-gate" => match load_payload(&args[1..]) {
            Ok(payload) => match evaluate_heroic_gate_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "apply-governance" => match load_payload(&args[1..]) {
            Ok(payload) => match apply_governance_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "sprint-contract" => match load_payload(&args[1..]) {
            Ok(payload) => match run_sprint_contract_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "autoscale" => match load_payload(&args[1..]) {
            Ok(payload) => match run_autoscale_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "inversion" => match load_payload(&args[1..]) {
            Ok(payload) => match run_inversion_json(&payload) {
                Ok(out) => println!("{}", out),
                Err(err) => {
                    let payload = serde_json::json!({ "ok": false, "error": err });
                    eprintln!("{}", payload);
                    std::process::exit(1);
                }
            },
            Err(err) => {
                let payload = serde_json::json!({ "ok": false, "error": err });
                eprintln!("{}", payload);
                std::process::exit(1);
            }
        },
        "demo" => {
            let demo = serde_json::json!({
                "workflow_id": "execution_demo",
                "deterministic_seed": "demo_seed",
                "pause_after_step": "score",
                "steps": [
                    {
                        "id": "collect",
                        "kind": "task",
                        "action": "collect_data",
                        "command": "collect --source=eyes"
                    },
                    {
                        "id": "score",
                        "kind": "task",
                        "action": "score",
                        "command": "score --strategy=deterministic"
                    },
                    {
                        "id": "ship",
                        "kind": "task",
                        "action": "ship",
                        "command": "ship --mode=canary"
                    }
                ]
            })
            .to_string();
            let receipt = run_workflow(&demo);
            println!(
                "{}",
                serde_json::to_string(&receipt).unwrap_or_else(|_| "{\"ok\":false}".to_string())
            );
        }
        _ => {
            usage();
            std::process::exit(1);
        }
    }
}
