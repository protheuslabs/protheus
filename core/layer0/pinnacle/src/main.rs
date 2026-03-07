// SPDX-License-Identifier: Apache-2.0
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use protheus_pinnacle_core_v1::{get_sovereignty_index, merge_delta, merge_delta_json};
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

fn decode_payload(raw: String) -> Result<String, String> {
    let bytes = BASE64_STANDARD
        .decode(raw.as_bytes())
        .map_err(|e| format!("base64_decode_failed:{e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("utf8_decode_failed:{e}"))
}

fn load_json_arg(
    args: &[String],
    raw_key: &str,
    b64_key: &str,
    file_key: &str,
) -> Result<String, String> {
    if let Some(v) = parse_arg(args, raw_key) {
        return Ok(v);
    }
    if let Some(v) = parse_arg(args, b64_key) {
        return decode_payload(v);
    }
    if let Some(v) = parse_arg(args, file_key) {
        return fs::read_to_string(v.as_str()).map_err(|e| format!("file_read_failed:{e}"));
    }
    Err(format!("missing_payload:{}", raw_key))
}

fn usage() {
    eprintln!("Usage:");
    eprintln!("  pinnacle_core merge --left-json=<payload> --right-json=<payload>");
    eprintln!("  pinnacle_core merge --left-b64=<base64> --right-b64=<base64>");
    eprintln!("  pinnacle_core index --left-json=<payload> --right-json=<payload>");
    eprintln!("  pinnacle_core demo");
}

fn demo_delta(node: &str, value: i64, clock: u64) -> String {
    serde_json::json!({
        "node_id": node,
        "changes": {
            "topic/revenue": {
                "payload": { "score": value },
                "vector_clock": { node: clock },
                "signed": true
            }
        }
    })
    .to_string()
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("demo");

    match command {
        "merge" => {
            let left = load_json_arg(&args[1..], "--left-json", "--left-b64", "--left-file");
            let right = load_json_arg(&args[1..], "--right-json", "--right-b64", "--right-file");
            match (left, right) {
                (Ok(l), Ok(r)) => match merge_delta_json(&l, &r) {
                    Ok(v) => println!("{}", v),
                    Err(err) => {
                        eprintln!("{}", serde_json::json!({ "ok": false, "error": err }));
                        std::process::exit(1);
                    }
                },
                (Err(err), _) | (_, Err(err)) => {
                    eprintln!("{}", serde_json::json!({ "ok": false, "error": err }));
                    std::process::exit(1);
                }
            }
        }
        "index" => {
            let left = load_json_arg(&args[1..], "--left-json", "--left-b64", "--left-file");
            let right = load_json_arg(&args[1..], "--right-json", "--right-b64", "--right-file");
            match (left, right) {
                (Ok(l), Ok(r)) => match get_sovereignty_index(&l, &r) {
                    Ok(v) => println!("{}", serde_json::json!({ "sovereignty_index_pct": v })),
                    Err(err) => {
                        eprintln!("{}", serde_json::json!({ "ok": false, "error": err }));
                        std::process::exit(1);
                    }
                },
                (Err(err), _) | (_, Err(err)) => {
                    eprintln!("{}", serde_json::json!({ "ok": false, "error": err }));
                    std::process::exit(1);
                }
            }
        }
        "demo" => {
            let left = demo_delta("device_a", 42, 2);
            let right = demo_delta("device_b", 45, 2);
            let merged = merge_delta(&left, &right).expect("demo_merge");
            println!(
                "{}",
                serde_json::to_string(&merged).unwrap_or_else(|_| "{}".to_string())
            );
        }
        _ => {
            usage();
            std::process::exit(1);
        }
    }
}
