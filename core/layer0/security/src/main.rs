// SPDX-License-Identifier: Apache-2.0
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use protheus_security_core_v1::{
    audit_json, enforce_operation_json, evaluate_operation_json, rotate_all_json, seal_json,
    vault_evaluate_json, vault_load_policy_json, SecurityOperationRequest,
};
use std::env;
use std::fs;
use std::path::Path;

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

fn demo_request() -> SecurityOperationRequest {
    SecurityOperationRequest {
        operation_id: "security_demo_001".to_string(),
        subsystem: "memory".to_string(),
        action: "recall".to_string(),
        actor: "operator".to_string(),
        risk_class: "normal".to_string(),
        payload_digest: Some("sha256:demo".to_string()),
        tags: vec!["runtime.guardrails".to_string()],
        covenant_violation: false,
        tamper_signal: false,
        key_age_hours: 2,
        operator_quorum: 2,
        audit_receipt_nonce: Some("nonce-demo".to_string()),
        zk_proof: Some("zkp-demo".to_string()),
        ciphertext_digest: Some("sha256:cipher-demo".to_string()),
    }
}

fn usage() {
    eprintln!("Usage:");
    eprintln!("  security_core check --request-json=<payload>");
    eprintln!("  security_core check --request-base64=<payload>");
    eprintln!("  security_core check --request-file=<path>");
    eprintln!("  security_core enforce --request-json=<payload> [--state-root=<path>]");
    eprintln!("  security_core vault-load-policy");
    eprintln!("  security_core vault-evaluate --request-json=<vault_request>");
    eprintln!("  security_core seal --request-json=<seal_request> [--state-root=<path>]");
    eprintln!("  security_core rotate-all --request-json=<rotate_request> [--state-root=<path>]");
    eprintln!("  security_core audit --request-json=<audit_request> [--state-root=<path>]");
    eprintln!("  security_core demo");
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("demo");

    match command {
        "check" => match load_request_json(&args[1..]) {
            Ok(request_json) => match evaluate_operation_json(&request_json) {
                Ok(payload) => println!("{}", payload),
                Err(err) => {
                    eprintln!(
                        "{}",
                        serde_json::json!({
                            "ok": false,
                            "error": err.to_string()
                        })
                    );
                    std::process::exit(1);
                }
            },
            Err(err) => {
                eprintln!(
                    "{}",
                    serde_json::json!({
                        "ok": false,
                        "error": err
                    })
                );
                std::process::exit(1);
            }
        },
        "enforce" => match load_request_json(&args[1..]) {
            Ok(request_json) => {
                let state_root =
                    parse_arg(&args[1..], "--state-root").unwrap_or_else(|| ".".to_string());
                match enforce_operation_json(&request_json, Path::new(&state_root)) {
                    Ok(payload) => println!("{}", payload),
                    Err(err) => {
                        eprintln!(
                            "{}",
                            serde_json::json!({
                                "ok": false,
                                "error": err.to_string()
                            })
                        );
                        std::process::exit(1);
                    }
                }
            }
            Err(err) => {
                eprintln!(
                    "{}",
                    serde_json::json!({
                        "ok": false,
                        "error": err
                    })
                );
                std::process::exit(1);
            }
        },
        "vault-load-policy" => match vault_load_policy_json() {
            Ok(payload) => println!("{}", payload),
            Err(err) => {
                eprintln!(
                    "{}",
                    serde_json::json!({
                        "ok": false,
                        "error": err.to_string()
                    })
                );
                std::process::exit(1);
            }
        },
        "vault-evaluate" => match load_request_json(&args[1..]) {
            Ok(request_json) => match vault_evaluate_json(&request_json) {
                Ok(payload) => println!("{}", payload),
                Err(err) => {
                    eprintln!(
                        "{}",
                        serde_json::json!({
                            "ok": false,
                            "error": err.to_string()
                        })
                    );
                    std::process::exit(1);
                }
            },
            Err(err) => {
                eprintln!(
                    "{}",
                    serde_json::json!({
                        "ok": false,
                        "error": err
                    })
                );
                std::process::exit(1);
            }
        },
        "seal" => match load_request_json(&args[1..]) {
            Ok(request_json) => {
                let state_root =
                    parse_arg(&args[1..], "--state-root").unwrap_or_else(|| ".".to_string());
                match seal_json(&request_json, Path::new(&state_root)) {
                    Ok(payload) => println!("{}", payload),
                    Err(err) => {
                        eprintln!(
                            "{}",
                            serde_json::json!({
                                "ok": false,
                                "error": err.to_string()
                            })
                        );
                        std::process::exit(1);
                    }
                }
            }
            Err(err) => {
                eprintln!(
                    "{}",
                    serde_json::json!({
                        "ok": false,
                        "error": err
                    })
                );
                std::process::exit(1);
            }
        },
        "rotate-all" => match load_request_json(&args[1..]) {
            Ok(request_json) => {
                let state_root =
                    parse_arg(&args[1..], "--state-root").unwrap_or_else(|| ".".to_string());
                match rotate_all_json(&request_json, Path::new(&state_root)) {
                    Ok(payload) => println!("{}", payload),
                    Err(err) => {
                        eprintln!(
                            "{}",
                            serde_json::json!({
                                "ok": false,
                                "error": err.to_string()
                            })
                        );
                        std::process::exit(1);
                    }
                }
            }
            Err(err) => {
                eprintln!(
                    "{}",
                    serde_json::json!({
                        "ok": false,
                        "error": err
                    })
                );
                std::process::exit(1);
            }
        },
        "audit" => match load_request_json(&args[1..]) {
            Ok(request_json) => {
                let state_root =
                    parse_arg(&args[1..], "--state-root").unwrap_or_else(|| ".".to_string());
                match audit_json(&request_json, Path::new(&state_root)) {
                    Ok(payload) => println!("{}", payload),
                    Err(err) => {
                        eprintln!(
                            "{}",
                            serde_json::json!({
                                "ok": false,
                                "error": err.to_string()
                            })
                        );
                        std::process::exit(1);
                    }
                }
            }
            Err(err) => {
                eprintln!(
                    "{}",
                    serde_json::json!({
                        "ok": false,
                        "error": err
                    })
                );
                std::process::exit(1);
            }
        },
        "demo" => {
            let request = demo_request();
            let request_json = serde_json::to_string(&request).unwrap_or_else(|_| "{}".to_string());
            match evaluate_operation_json(&request_json) {
                Ok(payload) => println!("{}", payload),
                Err(err) => {
                    eprintln!(
                        "{}",
                        serde_json::json!({
                            "ok": false,
                            "error": err.to_string()
                        })
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
