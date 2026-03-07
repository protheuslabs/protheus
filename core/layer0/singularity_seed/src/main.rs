// SPDX-License-Identifier: Apache-2.0
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use protheus_singularity_seed_core_v1::{
    freeze_seed, run_guarded_cycle, show_seed_state_json, CycleRequest, DriftOverride,
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

fn parse_request(args: &[String]) -> Result<CycleRequest, String> {
    if let Some(v) = parse_arg(args, "--request-json") {
        return serde_json::from_str(&v).map_err(|err| format!("request_parse_failed:{err}"));
    }
    if let Some(v) = parse_arg(args, "--request-base64") {
        let bytes = BASE64_STANDARD
            .decode(v.as_bytes())
            .map_err(|err| format!("base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes).map_err(|err| format!("utf8_decode_failed:{err}"))?;
        return serde_json::from_str(&text).map_err(|err| format!("request_parse_failed:{err}"));
    }
    if let Some(v) = parse_arg(args, "--request-file") {
        let text =
            fs::read_to_string(v).map_err(|err| format!("request_file_read_failed:{err}"))?;
        return serde_json::from_str(&text).map_err(|err| format!("request_parse_failed:{err}"));
    }

    let mut request = CycleRequest::default();
    if let Some(v) = parse_arg(args, "--inject-drift") {
        let mut overrides = Vec::new();
        for part in v.split(',') {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                continue;
            }
            let (loop_id, drift) = trimmed
                .split_once(':')
                .ok_or_else(|| format!("invalid_inject_drift:{trimmed}"))?;
            let drift_pct = drift
                .parse::<f64>()
                .map_err(|_| format!("invalid_drift_value:{drift}"))?;
            overrides.push(DriftOverride {
                loop_id: loop_id.trim().to_string(),
                drift_pct,
            });
        }
        request.drift_overrides = overrides;
    }

    Ok(request)
}

fn usage() {
    eprintln!("Usage:");
    eprintln!("  singularity_seed_core freeze");
    eprintln!("  singularity_seed_core cycle [--request-json=<json>] [--request-base64=<base64>] [--request-file=<path>] [--inject-drift=<loop:drift,...>]");
    eprintln!("  singularity_seed_core show");
    eprintln!("  singularity_seed_core demo");
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("demo");

    match command {
        "freeze" => match freeze_seed() {
            Ok(report) => println!(
                "{}",
                serde_json::to_string(&report).unwrap_or_else(|_| "{}".to_string())
            ),
            Err(err) => {
                eprintln!(
                    "{}",
                    serde_json::json!({ "ok": false, "error": err.to_string() })
                );
                std::process::exit(1);
            }
        },
        "cycle" => match parse_request(&args[1..]) {
            Ok(request) => match run_guarded_cycle(&request) {
                Ok(report) => println!(
                    "{}",
                    serde_json::to_string(&report).unwrap_or_else(|_| "{}".to_string())
                ),
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
        "show" => match show_seed_state_json() {
            Ok(payload) => println!("{payload}"),
            Err(err) => {
                eprintln!(
                    "{}",
                    serde_json::json!({ "ok": false, "error": err.to_string() })
                );
                std::process::exit(1);
            }
        },
        "demo" => match run_guarded_cycle(&CycleRequest::default()) {
            Ok(report) => println!(
                "{}",
                serde_json::to_string(&report).unwrap_or_else(|_| "{}".to_string())
            ),
            Err(err) => {
                eprintln!(
                    "{}",
                    serde_json::json!({ "ok": false, "error": err.to_string() })
                );
                std::process::exit(1);
            }
        },
        _ => {
            usage();
            std::process::exit(1);
        }
    }
}
