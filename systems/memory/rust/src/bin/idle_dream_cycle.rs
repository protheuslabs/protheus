#[path = "../idle_dream_lane.rs"]
mod idle_dream_lane;
use std::path::PathBuf;

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<String>>();
    let repo_root = std::env::var("PROTHEUS_ROOT")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    if let Some(code) = idle_dream_lane::maybe_run(&repo_root, &args) {
        std::process::exit(code);
    }
    eprintln!(
        "{{\"ok\":false,\"type\":\"idle_dream_cycle_cli_error\",\"error\":\"unknown_command\",\"argv\":{:?}}}",
        args
    );
    std::process::exit(2);
}
