// SPDX-License-Identifier: Apache-2.0
use crate::{clean, deterministic_receipt_hash, now_iso, parse_args};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const SETTLE_IDS: &[&str] = &[
    "V4-SETTLE-001",
    "V4-SETTLE-002",
    "V4-SETTLE-003",
    "V4-SETTLE-004",
    "V4-SETTLE-005",
    "V4-SETTLE-006",
    "V4-SETTLE-007",
    "V4-SETTLE-008",
    "V4-SETTLE-009",
    "V4-SETTLE-010",
    "V4-SETTLE-011",
];

fn state_root(root: &Path) -> PathBuf {
    if let Ok(v) = std::env::var("SETTLEMENT_PROGRAM_STATE_ROOT") {
        let s = v.trim();
        if !s.is_empty() {
            return PathBuf::from(s);
        }
    }
    root.join("client").join("local").join("state").join("ops").join("settlement_program")
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

fn parse_bool(raw: Option<&String>, fallback: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
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
        println!("  protheus-ops settlement-program list|status");
        println!("  protheus-ops settlement-program run --id=V4-SETTLE-001 [--apply=1|0] [--strict=1|0]");
        println!("  protheus-ops settlement-program run-all|settle|revert|edit-core|edit-module [flags]");
        return 0;
    }

    let latest = latest_path(root);
    let history = history_path(root);

    if command == "status" {
        let mut out = json!({
            "ok": true,
            "type": "settlement_program_status",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "latest": read_json(&latest)
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        print_receipt(&out);
        return 0;
    }

    if command == "list" {
        let mut out = json!({
            "ok": true,
            "type": "settlement_program_list",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "program_ids": SETTLE_IDS
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        print_receipt(&out);
        return 0;
    }

    let apply = parse_bool(parsed.flags.get("apply"), false);
    let strict = parse_bool(parsed.flags.get("strict"), true);
    let target = clean(parsed.flags.get("target").cloned().unwrap_or_else(|| "binary".to_string()), 80);
    let module_name = clean(parsed.flags.get("module").cloned().unwrap_or_default(), 160);
    let id = clean(parsed.flags.get("id").cloned().unwrap_or_default(), 120);

    let selected = if command == "run" && !id.is_empty() {
        vec![id.clone()]
    } else {
        SETTLE_IDS.iter().map(|v| v.to_string()).collect::<Vec<_>>()
    };

    let mut out = json!({
        "ok": true,
        "type": "settlement_program",
        "lane": "core/layer0/ops",
        "ts": now_iso(),
        "command": command,
        "apply": apply,
        "strict": strict,
        "target": target,
        "module": module_name,
        "selected_ids": selected,
        "summary": {
            "executed": if command == "run" || command == "run-all" || command == "settle" { selected.len() } else { 0 },
            "note": "core_authoritative_placeholder"
        }
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    write_json(&latest, &out);
    append_jsonl(&history, &out);
    print_receipt(&out);
    0
}
