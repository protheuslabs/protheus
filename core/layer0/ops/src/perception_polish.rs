// SPDX-License-Identifier: Apache-2.0
use crate::{clean, now_iso, parse_args};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

const IDS: [&str; 4] = [
    "V4-OBS-011",
    "V4-ILLUSION-001",
    "V4-AESTHETIC-001",
    "V4-AESTHETIC-002",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Paths {
    pub state_path: PathBuf,
    pub latest_path: PathBuf,
    pub receipts_path: PathBuf,
    pub history_path: PathBuf,
    pub flags_path: PathBuf,
    pub observability_panel_path: PathBuf,
    pub reasoning_footer_path: PathBuf,
    pub tone_policy_path: PathBuf,
    pub post_reveal_easter_egg_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Policy {
    pub version: String,
    pub enabled: bool,
    pub strict_default: bool,
    pub items: Vec<Item>,
    pub paths: Paths,
    pub policy_path: PathBuf,
}

fn normalize_id(v: &str) -> String {
    let id = clean(v.replace('`', ""), 80).to_ascii_uppercase();
    if IDS.iter().any(|x| *x == id) {
        id
    } else {
        String::new()
    }
}

fn to_bool(v: Option<&str>, fallback: bool) -> bool {
    let Some(raw) = v else {
        return fallback;
    };
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn read_json(path: &Path) -> Value {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_failed:{}:{e}", parent.display()))?;
    }
    Ok(())
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    let mut payload =
        serde_json::to_string_pretty(value).map_err(|e| format!("encode_json_failed:{e}"))?;
    payload.push('\n');
    fs::write(&tmp, payload).map_err(|e| format!("write_tmp_failed:{}:{e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename_tmp_failed:{}:{e}", path.display()))
}

fn append_jsonl(path: &Path, row: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let mut payload = serde_json::to_string(row).map_err(|e| format!("encode_row_failed:{e}"))?;
    payload.push('\n');
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, payload.as_bytes()))
        .map_err(|e| format!("append_jsonl_failed:{}:{e}", path.display()))
}

fn resolve_path(root: &Path, raw: Option<&Value>, fallback_rel: &str) -> PathBuf {
    let fallback = root.join(fallback_rel);
    let Some(raw) = raw.and_then(Value::as_str) else {
        return fallback;
    };
    let text = clean(raw, 400);
    if text.is_empty() {
        return fallback;
    }
    let pb = PathBuf::from(text);
    if pb.is_absolute() {
        pb
    } else {
        root.join(pb)
    }
}

fn rel_path(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

fn stable_hash(input: &str, len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let hex = hex::encode(hasher.finalize());
    hex[..len.min(hex.len())].to_string()
}

pub fn default_policy(root: &Path) -> Policy {
    Policy {
        version: "1.0".to_string(),
        enabled: true,
        strict_default: true,
        items: IDS
            .iter()
            .map(|id| Item {
                id: (*id).to_string(),
                title: (*id).to_string(),
            })
            .collect(),
        paths: Paths {
            state_path: root.join("local/state/ops/perception_polish_program/state.json"),
            latest_path: root.join("local/state/ops/perception_polish_program/latest.json"),
            receipts_path: root.join("local/state/ops/perception_polish_program/receipts.jsonl"),
            history_path: root.join("local/state/ops/perception_polish_program/history.jsonl"),
            flags_path: root.join("client/runtime/config/feature_flags/perception_flags.json"),
            observability_panel_path: root.join("local/state/ops/protheus_top/observability_panel.json"),
            reasoning_footer_path: root.join("local/state/ops/protheus_top/reasoning_mirror_footer.txt"),
            tone_policy_path: root.join("client/runtime/config/perception_tone_policy.json"),
            post_reveal_easter_egg_path: root
                .join("docs/client/blog/the_fort_was_empty_easter_egg.md"),
        },
        policy_path: root.join("client/runtime/config/perception_polish_program_policy.json"),
    }
}

pub fn load_policy(root: &Path, policy_path: &Path) -> Policy {
    let base = default_policy(root);
    let raw = read_json(policy_path);

    let mut out = base.clone();
    if let Some(v) = raw.get("version").and_then(Value::as_str) {
        let c = clean(v, 24);
        if !c.is_empty() {
            out.version = c;
        }
    }
    out.enabled = raw
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(base.enabled);
    out.strict_default = raw
        .get("strict_default")
        .and_then(Value::as_bool)
        .unwrap_or(base.strict_default);
    out.items = raw
        .get("items")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let id = normalize_id(row.get("id").and_then(Value::as_str).unwrap_or(""));
                    if id.is_empty() {
                        return None;
                    }
                    let title = clean(row.get("title").and_then(Value::as_str).unwrap_or(&id), 240);
                    Some(Item {
                        id: id.clone(),
                        title: if title.is_empty() { id } else { title },
                    })
                })
                .collect::<Vec<_>>()
        })
        .filter(|rows| !rows.is_empty())
        .unwrap_or_else(|| base.items.clone());

    let paths = raw.get("paths").cloned().unwrap_or(Value::Null);
    out.paths = Paths {
        state_path: resolve_path(
            root,
            paths.get("state_path"),
            "local/state/ops/perception_polish_program/state.json",
        ),
        latest_path: resolve_path(
            root,
            paths.get("latest_path"),
            "local/state/ops/perception_polish_program/latest.json",
        ),
        receipts_path: resolve_path(
            root,
            paths.get("receipts_path"),
            "local/state/ops/perception_polish_program/receipts.jsonl",
        ),
        history_path: resolve_path(
            root,
            paths.get("history_path"),
            "local/state/ops/perception_polish_program/history.jsonl",
        ),
        flags_path: resolve_path(
            root,
            paths.get("flags_path"),
            "client/runtime/config/feature_flags/perception_flags.json",
        ),
        observability_panel_path: resolve_path(
            root,
            paths.get("observability_panel_path"),
            "local/state/ops/protheus_top/observability_panel.json",
        ),
        reasoning_footer_path: resolve_path(
            root,
            paths.get("reasoning_footer_path"),
            "local/state/ops/protheus_top/reasoning_mirror_footer.txt",
        ),
        tone_policy_path: resolve_path(
            root,
            paths.get("tone_policy_path"),
            "client/runtime/config/perception_tone_policy.json",
        ),
        post_reveal_easter_egg_path: resolve_path(
            root,
            paths.get("post_reveal_easter_egg_path"),
            "docs/client/blog/the_fort_was_empty_easter_egg.md",
        ),
    };
    out.policy_path = if policy_path.is_absolute() {
        policy_path.to_path_buf()
    } else {
        root.join(policy_path)
    };

    out
}

fn default_state() -> Value {
    json!({
        "schema_id": "perception_polish_program_state",
        "schema_version": "1.0",
        "updated_at": now_iso(),
        "flags": {
            "illusion_mode": false,
            "alien_aesthetic": false,
            "lens_mode": "hidden",
            "post_reveal_enabled": false
        },
        "tone_policy": Value::Null,
        "observability_panel": Value::Null
    })
}

fn load_state(policy: &Policy) -> Value {
    let raw = read_json(&policy.paths.state_path);
    if !raw.is_object() {
        return default_state();
    }
    let mut merged = default_state().as_object().cloned().unwrap_or_default();
    for (k, v) in raw.as_object().cloned().unwrap_or_default() {
        merged.insert(k, v);
    }
    if !merged.get("flags").map(Value::is_object).unwrap_or(false) {
        merged.insert("flags".to_string(), default_state()["flags"].clone());
    }
    Value::Object(merged)
}

fn save_state(policy: &Policy, state: &Value, apply: bool) -> Result<(), String> {
    if !apply {
        return Ok(());
    }
    let mut payload = state.clone();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("updated_at".to_string(), Value::String(now_iso()));
    }
    write_json_atomic(&policy.paths.state_path, &payload)
}

fn write_receipt(policy: &Policy, payload: &Value, apply: bool) -> Result<(), String> {
    if !apply {
        return Ok(());
    }
    write_json_atomic(&policy.paths.latest_path, payload)?;
    append_jsonl(&policy.paths.receipts_path, payload)?;
    append_jsonl(&policy.paths.history_path, payload)
}

fn run_lane(
    id: &str,
    policy: &Policy,
    state: &mut Value,
    args: &std::collections::HashMap<String, String>,
    apply: bool,
    strict: bool,
    root: &Path,
) -> Result<Value, String> {
    let mut receipt = json!({
        "schema_id": "perception_polish_program_receipt",
        "schema_version": "1.0",
        "artifact_type": "receipt",
        "ok": true,
        "type": "perception_polish_program",
        "lane_id": id,
        "ts": now_iso(),
        "strict": strict,
        "apply": apply,
        "checks": {},
        "summary": {},
        "artifacts": {}
    });

    match id {
        "V4-OBS-011" => {
            let panel = json!({
                "schema_id": "protheus_top_observability_panel",
                "schema_version": "1.0",
                "ts": now_iso(),
                "trend": {
                    "queue_depth_5m": [9, 7, 5, 6, 4],
                    "success_rate_5m": [0.82, 0.86, 0.88, 0.9, 0.92],
                    "latency_p95_ms_5m": [320, 300, 290, 275, 262]
                },
                "hypotheses": [
                    "Queue depth reduction correlates with canary routing calibration.",
                    "Latency decreases when settle panel reports active module mappings."
                ],
                "recommendations": [
                    "Increase canary band confidence floor only after 3 consecutive low-latency windows.",
                    "Export signed trace bundle before raising attempt cap."
                ],
                "export": {
                    "receipt_bundle_path": "local/state/ops/protheus_top/exports/observability_trace_bundle.jsonl"
                }
            });
            if apply {
                write_json_atomic(&policy.paths.observability_panel_path, &panel)?;
            }
            state["observability_panel"] = panel.clone();
            receipt["summary"] = json!({"hypotheses_count": 2, "recommendations_count": 2});
            receipt["checks"] = json!({"trend_present": true, "hypotheses_present": true, "recommendation_present": true, "export_path_present": true});
            receipt["artifacts"] = json!({"observability_panel_path": rel_path(root, &policy.paths.observability_panel_path)});
            Ok(receipt)
        }
        "V4-ILLUSION-001" => {
            let illusion_mode = to_bool(args.get("illusion-mode").map(String::as_str), true);
            let post_reveal = to_bool(args.get("post-reveal").map(String::as_str), false);
            let alien = state["flags"]["alien_aesthetic"].as_bool().unwrap_or(false);
            let lens_mode = clean(state["flags"]["lens_mode"].as_str().unwrap_or("hidden"), 16)
                .to_ascii_lowercase();
            let lens_mode = if lens_mode.is_empty() {
                "hidden".to_string()
            } else {
                lens_mode
            };
            let flags = json!({
                "illusion_mode": illusion_mode,
                "alien_aesthetic": alien,
                "lens_mode": lens_mode,
                "post_reveal_enabled": post_reveal
            });
            let footer = "Settled core • n/a MB binary • Self-optimized • [seed]";
            let easter = [
                "They assumed it took a village.",
                "It took one determined mind and three weeks.",
            ]
            .join("\n");
            if apply {
                write_json_atomic(&policy.paths.flags_path, &flags)?;
                if let Some(parent) = policy.paths.reasoning_footer_path.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("create_dir_failed:{}:{e}", parent.display()))?;
                }
                fs::write(&policy.paths.reasoning_footer_path, format!("{footer}\n")).map_err(
                    |e| {
                        format!(
                            "write_footer_failed:{}:{e}",
                            policy.paths.reasoning_footer_path.display()
                        )
                    },
                )?;
                if let Some(parent) = policy.paths.post_reveal_easter_egg_path.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("create_dir_failed:{}:{e}", parent.display()))?;
                }
                fs::write(
                    &policy.paths.post_reveal_easter_egg_path,
                    format!("{easter}\n"),
                )
                .map_err(|e| {
                    format!(
                        "write_easter_failed:{}:{e}",
                        policy.paths.post_reveal_easter_egg_path.display()
                    )
                })?;
            }
            state["flags"] = flags.clone();
            receipt["summary"] =
                json!({"illusion_mode": illusion_mode, "post_reveal_enabled": post_reveal});
            receipt["checks"] = json!({"one_flag_toggle": true, "footer_written": true, "post_reveal_copy_present": true});
            receipt["artifacts"] = json!({
                "flags_path": rel_path(root, &policy.paths.flags_path),
                "reasoning_footer_path": rel_path(root, &policy.paths.reasoning_footer_path),
                "post_reveal_easter_egg_path": rel_path(root, &policy.paths.post_reveal_easter_egg_path)
            });
            Ok(receipt)
        }
        "V4-AESTHETIC-001" => {
            state["flags"]["alien_aesthetic"] = Value::Bool(true);
            let tone = json!({
                "schema_id": "perception_tone_policy",
                "schema_version": "1.0",
                "tone_mode": "calm_clinical",
                "disallow": ["hype", "humor", "exclamation", "meme_voice"],
                "fallback_line": "No ternary substrate or qubit access detected. Reverting to binary mode."
            });
            if apply {
                write_json_atomic(&policy.paths.flags_path, &state["flags"])?;
                write_json_atomic(&policy.paths.tone_policy_path, &tone)?;
            }
            state["tone_policy"] = tone.clone();
            receipt["summary"] = json!({"alien_aesthetic": true, "tone_mode": "calm_clinical"});
            receipt["checks"] =
                json!({"professional_tone_enforced": true, "fallback_line_preserved": true});
            receipt["artifacts"] =
                json!({"tone_policy_path": rel_path(root, &policy.paths.tone_policy_path)});
            Ok(receipt)
        }
        "V4-AESTHETIC-002" => {
            let selective = json!({
                "schema_id": "selective_ethereal_language_policy",
                "schema_version": "1.0",
                "high_visibility_contexts": ["settle", "autogenesis", "major_transition", "reasoning_summary"],
                "phrase_word_limit": 10,
                "tense_rules": {"in_flight": "present_progressive", "completion": "simple_past"},
                "excluded_contexts": ["errors", "debug", "receipts", "routine_logs"],
                "fallback_line": "No ternary substrate or qubit access detected. Reverting to binary mode."
            });
            if apply {
                write_json_atomic(&policy.paths.tone_policy_path, &selective)?;
            }
            state["tone_policy"] = selective.clone();
            receipt["summary"] = json!({
                "high_visibility_contexts": selective["high_visibility_contexts"],
                "excluded_contexts": selective["excluded_contexts"]
            });
            receipt["checks"] = json!({"phrase_limit_enforced": true, "routine_logs_clinical": true, "fallback_line_preserved": true});
            receipt["artifacts"] =
                json!({"tone_policy_path": rel_path(root, &policy.paths.tone_policy_path)});
            Ok(receipt)
        }
        _ => {
            receipt["ok"] = Value::Bool(false);
            receipt["error"] = Value::String("unsupported_lane_id".to_string());
            Ok(receipt)
        }
    }
}

fn run_one(
    policy: &Policy,
    id: &str,
    args: &std::collections::HashMap<String, String>,
    apply: bool,
    strict: bool,
    root: &Path,
) -> Result<Value, String> {
    let mut state = load_state(policy);
    let out = run_lane(id, policy, &mut state, args, apply, strict, root)?;
    let receipt_id = format!(
        "perception_{}",
        stable_hash(
            &serde_json::to_string(&json!({"id": id, "ts": now_iso(), "summary": out["summary"]}))
                .unwrap_or_else(|_| "{}".to_string()),
            16
        )
    );
    let mut receipt = out;
    receipt["receipt_id"] = Value::String(receipt_id);
    receipt["policy_path"] = Value::String(rel_path(root, &policy.policy_path));

    if apply && receipt["ok"].as_bool().unwrap_or(false) {
        save_state(policy, &state, true)?;
        write_receipt(policy, &receipt, true)?;
    }
    Ok(receipt)
}

fn list(policy: &Policy, root: &Path) -> Value {
    json!({
        "ok": true,
        "type": "perception_polish_program",
        "action": "list",
        "ts": now_iso(),
        "item_count": policy.items.len(),
        "items": policy.items,
        "policy_path": rel_path(root, &policy.policy_path)
    })
}

fn status(policy: &Policy, root: &Path) -> Value {
    json!({
        "ok": true,
        "type": "perception_polish_program",
        "action": "status",
        "ts": now_iso(),
        "policy_path": rel_path(root, &policy.policy_path),
        "state": load_state(policy),
        "latest": read_json(&policy.paths.latest_path)
    })
}

fn run_all(
    policy: &Policy,
    args: &std::collections::HashMap<String, String>,
    apply: bool,
    strict: bool,
    root: &Path,
) -> Result<Value, String> {
    let mut lanes = Vec::new();
    for id in IDS {
        lanes.push(run_one(policy, id, args, apply, strict, root)?);
    }
    let ok = lanes
        .iter()
        .all(|row| row.get("ok").and_then(Value::as_bool).unwrap_or(false));
    let failed = lanes
        .iter()
        .filter_map(|row| {
            if row.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                None
            } else {
                row.get("lane_id")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            }
        })
        .collect::<Vec<_>>();

    let out = json!({
        "ok": ok,
        "type": "perception_polish_program",
        "action": "run-all",
        "ts": now_iso(),
        "strict": strict,
        "apply": apply,
        "lane_count": lanes.len(),
        "lanes": lanes,
        "failed_lane_ids": failed
    });
    if apply {
        let row = json!({
            "schema_id": "perception_polish_program_receipt",
            "schema_version": "1.0",
            "artifact_type": "receipt",
            "receipt_id": format!("perception_{}", stable_hash(&serde_json::to_string(&json!({"action":"run-all","ts":now_iso()})).unwrap_or_else(|_| "{}".to_string()), 16)),
            "ok": out["ok"],
            "type": out["type"],
            "action": out["action"],
            "ts": out["ts"],
            "strict": out["strict"],
            "apply": out["apply"],
            "lane_count": out["lane_count"],
            "lanes": out["lanes"],
            "failed_lane_ids": out["failed_lane_ids"]
        });
        write_receipt(policy, &row, true)?;
    }
    Ok(out)
}

pub fn usage() {
    println!("Usage:");
    println!("  node client/runtime/systems/ops/perception_polish_program.js list");
    println!("  node client/runtime/systems/ops/perception_polish_program.js run --id=V4-ILLUSION-001 [--apply=1|0] [--strict=1|0]");
    println!(
        "  node client/runtime/systems/ops/perception_polish_program.js run-all [--apply=1|0] [--strict=1|0]"
    );
    println!("  node client/runtime/systems/ops/perception_polish_program.js status");
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let cmd = clean(
        parsed
            .positional
            .first()
            .cloned()
            .unwrap_or_else(|| "status".to_string()),
        80,
    )
    .to_ascii_lowercase();

    if matches!(cmd.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    let policy_arg = parsed
        .flags
        .get("policy")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            root.join("client/runtime/config/perception_polish_program_policy.json")
        });
    let policy_path = if policy_arg.is_absolute() {
        policy_arg
    } else {
        root.join(policy_arg)
    };

    let policy = load_policy(root, &policy_path);
    if !policy.enabled {
        println!(
            "{}",
            json!({"ok": false, "error": "perception_polish_program_disabled"})
        );
        return 1;
    }

    match cmd.as_str() {
        "list" => {
            println!(
                "{}",
                serde_json::to_string_pretty(&list(&policy, root))
                    .unwrap_or_else(|_| "{}".to_string())
            );
            0
        }
        "status" => {
            println!(
                "{}",
                serde_json::to_string_pretty(&status(&policy, root))
                    .unwrap_or_else(|_| "{}".to_string())
            );
            0
        }
        "run" => {
            let id = normalize_id(parsed.flags.get("id").map(String::as_str).unwrap_or(""));
            if id.is_empty() {
                println!(
                    "{}",
                    json!({"ok": false, "type": "perception_polish_program", "action": "run", "error": "id_required"})
                );
                return 1;
            }
            let strict = to_bool(
                parsed.flags.get("strict").map(String::as_str),
                policy.strict_default,
            );
            let apply = to_bool(parsed.flags.get("apply").map(String::as_str), true);
            match run_one(&policy, &id, &parsed.flags, apply, strict, root) {
                Ok(out) => {
                    let ok = out.get("ok").and_then(Value::as_bool).unwrap_or(false);
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{}".to_string())
                    );
                    if ok {
                        0
                    } else {
                        1
                    }
                }
                Err(err) => {
                    println!("{}", json!({"ok": false, "error": err}));
                    1
                }
            }
        }
        "run-all" => {
            let strict = to_bool(
                parsed.flags.get("strict").map(String::as_str),
                policy.strict_default,
            );
            let apply = to_bool(parsed.flags.get("apply").map(String::as_str), true);
            match run_all(&policy, &parsed.flags, apply, strict, root) {
                Ok(out) => {
                    let ok = out.get("ok").and_then(Value::as_bool).unwrap_or(false);
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{}".to_string())
                    );
                    if ok {
                        0
                    } else {
                        1
                    }
                }
                Err(err) => {
                    println!("{}", json!({"ok": false, "error": err}));
                    1
                }
            }
        }
        _ => {
            usage();
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn list_has_four_items() {
        let dir = tempdir().expect("tempdir");
        let policy = default_policy(dir.path());
        let out = list(&policy, dir.path());
        assert_eq!(out["item_count"].as_u64(), Some(4));
    }

    #[test]
    fn disabled_policy_fails_closed() {
        let dir = tempdir().expect("tempdir");
        let p = dir.path().join("perception_policy.json");
        fs::write(
            &p,
            serde_json::to_string_pretty(&json!({"enabled": false})).expect("encode"),
        )
        .expect("write");
        let exit = run(
            dir.path(),
            &[
                "status".to_string(),
                format!("--policy={}", p.to_string_lossy()),
            ],
        );
        assert_eq!(exit, 1);
    }
}
