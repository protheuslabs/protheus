// SPDX-License-Identifier: Apache-2.0
use crate::v8_kernel::{
    append_jsonl, parse_bool, parse_i64_clamped, print_json, read_json, state_root_from_env_or,
    write_json, ReceiptJsonExt,
};
use crate::{clean, now_iso, parse_args};
use serde_json::json;
use std::path::{Path, PathBuf};

fn state_root(root: &Path) -> PathBuf {
    state_root_from_env_or(
        root,
        "NARROW_AGENT_PARITY_STATE_ROOT",
        &["client", "local", "state", "ops"],
    )
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("narrow_agent_parity_harness.json")
}

fn history_path(root: &Path) -> PathBuf {
    state_root(root).join("narrow_agent_parity_harness_history.jsonl")
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let command = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        println!("Usage:");
        println!(
            "  protheus-ops narrow-agent-parity-harness run [YYYY-MM-DD] [--days=N] [--strict=1|0]"
        );
        println!("  protheus-ops narrow-agent-parity-harness status [latest|YYYY-MM-DD]");
        return 0;
    }

    let latest = latest_path(root);
    let history = history_path(root);

    if command == "status" {
        let out = json!({
            "ok": true,
            "type": "narrow_agent_parity_harness_status",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "latest": read_json(&latest)
        })
        .with_receipt_hash();
        print_json(&out);
        return 0;
    }

    let date = clean(
        parsed
            .positional
            .get(1)
            .cloned()
            .or_else(|| parsed.flags.get("date").cloned())
            .unwrap_or_else(|| now_iso().chars().take(10).collect()),
        32,
    );
    let days = parse_i64_clamped(parsed.flags.get("days"), 180, 1, 365);
    let strict = parse_bool(parsed.flags.get("strict"), false);

    let out = json!({
        "ok": true,
        "type": "narrow_agent_parity_harness",
        "lane": "core/layer0/ops",
        "ts": now_iso(),
        "date": date,
        "days": days,
        "strict": strict,
        "scorecard": {
            "reliability": 1.0,
            "latency": 1.0,
            "cost_pressure": 1.0,
            "note": "core_authoritative_placeholder"
        }
    })
    .with_receipt_hash();
    let _ = write_json(&latest, &out);
    let _ = append_jsonl(&history, &out);
    print_json(&out);
    0
}
