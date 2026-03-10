// SPDX-License-Identifier: Apache-2.0
use crate::{clean, deterministic_receipt_hash, now_iso, parse_args};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn state_root(root: &Path) -> PathBuf {
    if let Ok(v) = std::env::var("ORGAN_ATROPHY_STATE_ROOT") {
        let s = v.trim();
        if !s.is_empty() {
            return PathBuf::from(s);
        }
    }
    root.join("client").join("local").join("state").join("ops").join("organ_atrophy")
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn history_path(root: &Path) -> PathBuf {
    state_root(root).join("history.jsonl")
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut body) = serde_json::to_string_pretty(value) {
        body.push('\n');
        let _ = fs::write(path, body);
    }
}

fn append_jsonl(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(line) = serde_json::to_string(value) {
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| std::io::Write::write_all(&mut file, format!("{line}\n").as_bytes()));
    }
}

fn parse_i64(raw: Option<&String>, fallback: i64, lo: i64, hi: i64) -> i64 {
    raw.and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(fallback)
        .clamp(lo, hi)
}

fn parse_bool(raw: Option<&String>, fallback: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

fn parse_date(raw: Option<&String>) -> String {
    let candidate = raw.map(|v| v.trim().to_string()).unwrap_or_default();
    if !candidate.is_empty()
        && chrono::NaiveDate::parse_from_str(&candidate, "%Y-%m-%d").is_ok()
    {
        return candidate;
    }
    now_iso().chars().take(10).collect()
}

fn print_receipt(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
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
        let mut out = json!({
            "ok": true,
            "type": "organ_atrophy_controller_status",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "latest": read_json(&latest)
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        print_receipt(&out);
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
            let mut out = json!({
                "ok": false,
                "type": "organ_atrophy_controller_error",
                "error": "missing_organ_id",
                "lane": "core/layer0/ops",
                "ts": now_iso()
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            print_receipt(&out);
            return 1;
        }

        let persist = parse_bool(parsed.flags.get("persist"), true);
        let mut out = json!({
            "ok": true,
            "type": "organ_atrophy_controller_revive",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "organ_id": organ_id,
            "reason": clean(parsed.flags.get("reason").cloned().unwrap_or_default(), 280),
            "persist": persist
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        if persist {
            write_json(&latest, &out);
            append_jsonl(&history, &out);
        }
        print_receipt(&out);
        return 0;
    }

    let date = parse_date(
        parsed
            .positional
            .get(1)
            .or_else(|| parsed.positional.first())
            .and_then(|v| if v == "scan" { None } else { Some(v) })
            .or_else(|| parsed.flags.get("date")),
    );
    let window_days = parse_i64(parsed.flags.get("window-days").or_else(|| parsed.flags.get("window_days")), 21, 1, 365);
    let max_candidates = parse_i64(
        parsed
            .flags
            .get("max-candidates")
            .or_else(|| parsed.flags.get("max_candidates")),
        24,
        1,
        500,
    );
    let persist = parse_bool(parsed.flags.get("persist"), true);

    let mut out = json!({
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
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    if persist {
        write_json(&latest, &out);
        append_jsonl(&history, &out);
    }
    print_receipt(&out);
    0
}
