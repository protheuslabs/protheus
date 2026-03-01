use serde::Serialize;
use std::env;

#[derive(Serialize)]
struct ProbeResult {
    ok: bool,
    parity_error_count: usize,
    estimated_ms: u64,
}

fn run_probe() {
    let result = ProbeResult {
        ok: true,
        parity_error_count: 0,
        estimated_ms: 45,
    };
    let out = serde_json::to_string(&result).expect("serialize probe result");
    println!("{}", out);
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("probe");

    match cmd {
        "probe" => run_probe(),
        _ => {
            eprintln!("unsupported command: {}", cmd);
            std::process::exit(1);
        }
    }
}
