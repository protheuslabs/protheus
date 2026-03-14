// SPDX-License-Identifier: Apache-2.0
use crate::v8_kernel::{
    append_jsonl, date_or_today, parse_bool, parse_i64_clamped, print_json, read_json,
    state_root_from_env_or, write_json, ReceiptJsonExt,
};
use crate::{clean, now_iso, parse_args};
use serde_json::json;
use std::path::{Path, PathBuf};

fn state_root(root: &Path) -> PathBuf {
    state_root_from_env_or(
        root,
        "ORGAN_ATROPHY_STATE_ROOT",
        &["client", "local", "state", "ops", "organ_atrophy"],
    )
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn history_path(root: &Path) -> PathBuf {
    state_root(root).join("history.jsonl")
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
        println!("  protheus-ops organ-atrophy-controller scan [YYYY-MM-DD] [--window-days=N] [--max-candidates=N] [--persist=1|0]");
        println!("  protheus-ops organ-atrophy-controller status [latest|YYYY-MM-DD]");
        println!("  protheus-ops organ-atrophy-controller revive --organ-id=<id> [--reason=<txt>] [--persist=1|0]");
        return 0;
    }

    let latest = latest_path(root);
    let history = history_path(root);

    if command == "status" {
        let out = json!({
            "ok": true,
            "type": "organ_atrophy_controller_status",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "latest": read_json(&latest)
        })
        .with_receipt_hash();
        print_json(&out);
        return 0;
    }

    if command == "revive" {
        let organ_id = clean(
            parsed
                .flags
                .get("organ-id")
                .or_else(|| parsed.flags.get("organ_id"))
                .cloned()
                .unwrap_or_default(),
            160,
        );
        if organ_id.is_empty() {
            let out = json!({
                "ok": false,
                "type": "organ_atrophy_controller_error",
                "error": "missing_organ_id",
                "lane": "core/layer0/ops",
                "ts": now_iso()
            })
            .with_receipt_hash();
            print_json(&out);
            return 1;
        }

        let persist = parse_bool(parsed.flags.get("persist"), true);
        let out = json!({
            "ok": true,
            "type": "organ_atrophy_controller_revive",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "organ_id": organ_id,
            "reason": clean(parsed.flags.get("reason").cloned().unwrap_or_default(), 280),
            "persist": persist
        })
        .with_receipt_hash();
        if persist {
            let _ = write_json(&latest, &out);
            let _ = append_jsonl(&history, &out);
        }
        print_json(&out);
        return 0;
    }

    let date = date_or_today(
        parsed
            .positional
            .get(1)
            .or_else(|| parsed.positional.first())
            .and_then(|v| if v == "scan" { None } else { Some(v) })
            .or_else(|| parsed.flags.get("date")),
    );
    let window_days = parse_i64_clamped(
        parsed
            .flags
            .get("window-days")
            .or_else(|| parsed.flags.get("window_days")),
        21,
        1,
        365,
    );
    let max_candidates = parse_i64_clamped(
        parsed
            .flags
            .get("max-candidates")
            .or_else(|| parsed.flags.get("max_candidates")),
        24,
        1,
        500,
    );
    let persist = parse_bool(parsed.flags.get("persist"), true);

    let out = json!({
        "ok": true,
        "type": "organ_atrophy_controller_scan",
        "lane": "core/layer0/ops",
        "ts": now_iso(),
        "date": date,
        "window_days": window_days,
        "max_candidates": max_candidates,
        "persist": persist,
        "summary": {
            "candidates": [],
            "count": 0,
            "note": "core_authoritative_placeholder"
        }
    })
    .with_receipt_hash();
    if persist {
        let _ = write_json(&latest, &out);
        let _ = append_jsonl(&history, &out);
    }
    print_json(&out);
    0
}
