// SPDX-License-Identifier: Apache-2.0
use fluxlattice::{init_state, morph, settle, status_map};
use std::env;

fn print_json(map: std::collections::BTreeMap<String, String>) {
    let mut parts: Vec<String> = Vec::new();
    for (k, v) in map.iter() {
        parts.push(format!("\"{}\":\"{}\"", k, v.replace('"', "\\\"")));
    }
    println!("{{{}}}", parts.join(","));
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let cmd = args.get(1).map(|v| v.as_str()).unwrap_or("status");

    let mut state = init_state("fluxlattice_core");
    match cmd {
        "init" => {
            state.metadata.insert("command".into(), "init".into());
            print_json(status_map(&state));
        }
        "settle" => {
            state = settle(state, "binary");
            state.metadata.insert("command".into(), "settle".into());
            print_json(status_map(&state));
        }
        "morph" => {
            let mode = args.get(2).map(|v| v.as_str()).unwrap_or("dynamic");
            state = settle(state, "binary");
            state = morph(state, mode);
            state.metadata.insert("command".into(), "morph".into());
            print_json(status_map(&state));
        }
        "status" => {
            state.metadata.insert("command".into(), "status".into());
            print_json(status_map(&state));
        }
        _ => {
            eprintln!("unsupported command");
            std::process::exit(2);
        }
    }
}
