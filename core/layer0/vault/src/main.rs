// SPDX-License-Identifier: Apache-2.0
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use protheus_vault_core_v1::{
    evaluate_vault_policy_json, load_embedded_vault_policy_json, VaultOperationRequest,
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

fn demo_request() -> VaultOperationRequest {
    VaultOperationRequest {
        operation_id: "vault_demo_001".to_string(),
        key_id: "vault_key_primary".to_string(),
        action: "seal".to_string(),
        zk_proof: Some("zkp:demo-proof".to_string()),
        ciphertext_digest: Some("sha256:demo-cipher".to_string()),
        fhe_noise_budget: 24,
        key_age_hours: 8,
        tamper_signal: false,
        operator_quorum: 2,
        audit_receipt_nonce: Some("nonce-demo".to_string()),
    }
}

fn usage() {
    eprintln!("Usage:");
    eprintln!("  vault_core load-policy");
    eprintln!("  vault_core evaluate --request-json=<payload>");
    eprintln!("  vault_core evaluate --request-base64=<base64_payload>");
    eprintln!("  vault_core evaluate --request-file=<path>");
    eprintln!("  vault_core demo");
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("demo");

    match command {
        "load-policy" => match load_embedded_vault_policy_json() {
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
        "evaluate" => match load_request_json(&args[1..]) {
            Ok(request_json) => match evaluate_vault_policy_json(&request_json) {
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
        "demo" => {
            let request = demo_request();
            let request_json = serde_json::to_string(&request).unwrap_or_else(|_| "{}".to_string());
            match evaluate_vault_policy_json(&request_json) {
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
