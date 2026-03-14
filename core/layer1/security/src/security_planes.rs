// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer1/security (authoritative)

use crate::{parse_args, ParsedArgs};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use chrono::{SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;
use walkdir::WalkDir;

type HmacSha256 = Hmac<Sha256>;

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn clean(v: impl ToString, max_len: usize) -> String {
    v.to_string()
        .trim()
        .chars()
        .take(max_len)
        .collect::<String>()
}

fn normalize_rel(raw: impl AsRef<str>) -> String {
    raw.as_ref()
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string()
}

fn runtime_root(repo_root: &Path) -> PathBuf {
    repo_root.join("client").join("runtime")
}

fn local_state_root(repo_root: &Path) -> PathBuf {
    if let Ok(v) = std::env::var("PROTHEUS_SECURITY_STATE_ROOT") {
        let t = v.trim();
        if !t.is_empty() {
            return PathBuf::from(t);
        }
    }
    repo_root.join("client").join("local").join("state")
}

fn runtime_config_path(repo_root: &Path, file_name: &str) -> PathBuf {
    runtime_root(repo_root).join("config").join(file_name)
}

fn resolve_runtime_or_state(repo_root: &Path, raw: &str) -> PathBuf {
    let trimmed = clean(raw, 600);
    if trimmed.is_empty() {
        return runtime_root(repo_root);
    }
    let candidate = PathBuf::from(&trimmed);
    if candidate.is_absolute() {
        return candidate;
    }
    let rel = normalize_rel(trimmed);
    if rel.starts_with("local/state/") {
        let stripped = rel.trim_start_matches("local/state/").to_string();
        return local_state_root(repo_root).join(stripped);
    }
    runtime_root(repo_root).join(rel)
}

fn read_json_or(path: &Path, fallback: Value) -> Value {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or(fallback),
        Err(_) => fallback,
    }
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create_dir_failed:{}:{err}", parent.display()))?;
    }
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        Utc::now().timestamp_millis()
    ));
    let payload = serde_json::to_vec_pretty(value)
        .map_err(|err| format!("encode_json_failed:{}:{err}", path.display()))?;
    fs::write(&tmp, payload).map_err(|err| format!("write_tmp_failed:{}:{err}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|err| {
        format!(
            "rename_tmp_failed:{}:{}:{err}",
            tmp.display(),
            path.display()
        )
    })
}

fn append_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create_dir_failed:{}:{err}", parent.display()))?;
    }
    let line = serde_json::to_string(value)
        .map_err(|err| format!("encode_jsonl_failed:{}:{err}", path.display()))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("open_jsonl_failed:{}:{err}", path.display()))?;
    writeln!(file, "{line}").map_err(|err| format!("append_jsonl_failed:{}:{err}", path.display()))
}

fn flag<'a>(parsed: &'a ParsedArgs, key: &str) -> Option<&'a str> {
    parsed.flags.get(key).map(String::as_str)
}

fn bool_flag(parsed: &ParsedArgs, key: &str, fallback: bool) -> bool {
    match flag(parsed, key) {
        Some(raw) => match raw.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => fallback,
        },
        None => fallback,
    }
}

fn split_csv(raw: &str, max: usize) -> Vec<String> {
    raw.split(',')
        .map(|v| normalize_rel(v))
        .filter(|v| !v.is_empty())
        .take(max)
        .collect::<Vec<_>>()
}

fn sha256_hex_bytes(input: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input);
    hex::encode(hasher.finalize())
}

fn sha256_hex_file(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|err| format!("read_file_failed:{}:{err}", path.display()))?;
    Ok(sha256_hex_bytes(&bytes))
}

fn stable_json_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(v) => {
            if *v {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(rows) => format!(
            "[{}]",
            rows.iter()
                .map(stable_json_string)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            let mut out = String::from("{");
            for (idx, key) in keys.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()));
                out.push(':');
                out.push_str(&stable_json_string(map.get(*key).unwrap_or(&Value::Null)));
            }
            out.push('}');
            out
        }
    }
}

fn hmac_sha256_hex(secret: &str, payload: &Value) -> Result<String, String> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|err| format!("hmac_key_invalid:{err}"))?;
    mac.update(stable_json_string(payload).as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn secure_eq_hex(a: &str, b: &str) -> bool {
    let a_norm = a.trim().to_ascii_lowercase();
    let b_norm = b.trim().to_ascii_lowercase();
    if a_norm.len() != b_norm.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a_norm.as_bytes().iter().zip(b_norm.as_bytes().iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn parse_last_json_line(raw: &str) -> Option<Value> {
    let lines = raw.lines().collect::<Vec<_>>();
    for line in lines.iter().rev() {
        let candidate = line.trim();
        if !candidate.starts_with('{') {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(candidate) {
            return Some(value);
        }
    }
    None
}

#[derive(Debug, Clone)]
struct GuardZone {
    prefix: &'static str,
    min_clearance: i64,
    label: &'static str,
}

fn guard_zones() -> Vec<GuardZone> {
    vec![
        GuardZone {
            prefix: "systems/",
            min_clearance: 3,
            label: "infrastructure",
        },
        GuardZone {
            prefix: "config/",
            min_clearance: 3,
            label: "configuration",
        },
        GuardZone {
            prefix: "memory/",
            min_clearance: 3,
            label: "memory_tools",
        },
        GuardZone {
            prefix: "habits/",
            min_clearance: 2,
            label: "habits_reflexes",
        },
        GuardZone {
            prefix: "local/state/",
            min_clearance: 1,
            label: "state_data",
        },
    ]
}

fn guard_protected_files() -> Vec<&'static str> {
    vec![
        "docs/workspace/AGENT-CONSTITUTION.md",
        "config/constitution_guardian_policy.json",
    ]
}

fn guard_match_zone(file_rel: &str) -> (i64, String) {
    if guard_protected_files().contains(&file_rel) {
        return (4, "protected_core".to_string());
    }
    for zone in guard_zones() {
        if file_rel.starts_with(zone.prefix) {
            return (zone.min_clearance, zone.label.to_string());
        }
    }
    (3, "default_protect".to_string())
}

fn guard_state_logs(repo_root: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let base = local_state_root(repo_root).join("security");
    (
        base.join("break_glass.jsonl"),
        base.join("remote_request_gate.jsonl"),
        base.join("risky_env_toggle_gate.jsonl"),
    )
}

pub fn run_guard(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let parsed = parse_args(argv);
    let first = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "run".to_string());
    if first == "status" {
        return (
            json!({
                "ok": true,
                "type": "security_guard_status",
                "ts": now_iso(),
                "zones": guard_zones().iter().map(|z| json!({"prefix": z.prefix, "min_clearance": z.min_clearance, "label": z.label})).collect::<Vec<_>>(),
                "protected_files": guard_protected_files(),
                "default_clearance": 2
            }),
            0,
        );
    }

    let files = if let Some(csv) = flag(&parsed, "files") {
        split_csv(csv, 200)
    } else {
        parsed
            .positional
            .iter()
            .filter(|v| *v != "run")
            .map(normalize_rel)
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>()
    };
    if files.is_empty() {
        return (
            json!({
                "ok": false,
                "blocked": true,
                "type": "security_guard",
                "error": "files_required",
                "usage": "security-plane guard --files=<path1,path2,...>"
            }),
            2,
        );
    }

    let clearance = std::env::var("CLEARANCE")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(2)
        .clamp(1, 4);
    let break_glass = std::env::var("BREAK_GLASS")
        .ok()
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false);
    let approval_note = clean(
        std::env::var("APPROVAL_NOTE")
            .or_else(|_| std::env::var("SECOND_APPROVAL_NOTE"))
            .unwrap_or_default(),
        400,
    );
    let request_source = clean(
        std::env::var("REQUEST_SOURCE").unwrap_or_else(|_| "local".to_string()),
        60,
    )
    .to_ascii_lowercase();
    let request_action = clean(
        std::env::var("REQUEST_ACTION").unwrap_or_else(|_| "apply".to_string()),
        60,
    )
    .to_ascii_lowercase();
    let remote_source = matches!(
        request_source.as_str(),
        "slack" | "discord" | "webhook" | "email" | "api" | "remote" | "moltbook"
    );
    let proposal_action = matches!(
        request_action.as_str(),
        "propose" | "proposal" | "dry_run" | "dry-run" | "audit"
    );

    // Integrity gate remains authoritative before clearance checks.
    let (integrity, _) =
        crate::run_integrity_reseal(repo_root, &["check".to_string(), "--staged=0".to_string()]);
    let integrity_ok = integrity
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !integrity_ok {
        return (
            json!({
                "ok": false,
                "blocked": true,
                "break_glass": false,
                "reason": "integrity_violation",
                "ts": now_iso(),
                "integrity": integrity
            }),
            1,
        );
    }

    let mut requirements = Vec::<Value>::new();
    let mut required_max = 1i64;
    for file in &files {
        let (min_clearance, label) = guard_match_zone(file);
        required_max = required_max.max(min_clearance);
        requirements.push(json!({
            "file": file,
            "min_clearance": min_clearance,
            "label": label
        }));
    }
    let clearance_ok = clearance >= required_max;

    let break_glass_allowed = break_glass
        && approval_note.len() >= 12
        && (!remote_source
            || proposal_action
            || (std::env::var("REMOTE_DIRECT_OVERRIDE").ok().as_deref() == Some("1")
                && !clean(std::env::var("APPROVER_ID").unwrap_or_default(), 120).is_empty()
                && !clean(std::env::var("SECOND_APPROVER_ID").unwrap_or_default(), 120)
                    .is_empty()));

    let blocked = !clearance_ok && !break_glass_allowed;
    let ok = !blocked;
    let reason = if blocked {
        "clearance_insufficient"
    } else if !clearance_ok && break_glass_allowed {
        "break_glass"
    } else {
        "approved"
    };

    let (break_glass_log, remote_log, risky_log) = guard_state_logs(repo_root);
    if break_glass {
        let _ = append_jsonl(
            &break_glass_log,
            &json!({
                "ts": now_iso(),
                "type": "break_glass_attempt",
                "ok": ok,
                "reason": reason,
                "request_source": request_source,
                "request_action": request_action,
                "approval_note_len": approval_note.len(),
                "required_clearance": required_max,
                "clearance": clearance,
                "files": files
            }),
        );
    }
    if remote_source {
        let _ = append_jsonl(
            &remote_log,
            &json!({
                "ts": now_iso(),
                "type": "remote_request_gate",
                "ok": ok,
                "reason": reason,
                "request_source": request_source,
                "request_action": request_action,
                "proposal_action": proposal_action
            }),
        );
    }
    let risky_toggles = [
        "AUTONOMY_ENABLED",
        "AUTONOMY_MODEL_CATALOG_AUTO_APPLY",
        "AUTONOMY_MODEL_CATALOG_AUTO_BREAK_GLASS",
        "REMOTE_DIRECT_OVERRIDE",
        "BREAK_GLASS",
    ]
    .iter()
    .filter_map(|k| {
        std::env::var(k)
            .ok()
            .map(|v| (k.to_string(), v))
            .filter(|(_, v)| {
                matches!(
                    v.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
    })
    .collect::<Vec<_>>();
    if !risky_toggles.is_empty() {
        let _ = append_jsonl(
            &risky_log,
            &json!({
                "ts": now_iso(),
                "type": "risky_env_toggle_gate",
                "ok": ok,
                "reason": reason,
                "toggles": risky_toggles
            }),
        );
    }

    (
        json!({
            "ok": ok,
            "blocked": blocked,
            "break_glass": reason == "break_glass",
            "reason": reason,
            "ts": now_iso(),
            "request_source": request_source,
            "request_action": request_action,
            "clearance": clearance,
            "required_clearance": required_max,
            "requirements": requirements
        }),
        if ok { 0 } else { 1 },
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct AntiSabotagePolicy {
    version: String,
    protected_roots: Vec<String>,
    extensions: Vec<String>,
    state_dir: String,
    quarantine_dir: String,
    snapshots_dir: String,
    incident_log: String,
    state_file: String,
    watcher_state_file: String,
    watcher_interval_ms: i64,
    max_snapshots: usize,
    verify_strict_default: bool,
    auto_reset_default: bool,
    watcher_strict_default: bool,
    watcher_auto_reset_default: bool,
}

impl Default for AntiSabotagePolicy {
    fn default() -> Self {
        Self {
            version: "1.0".to_string(),
            protected_roots: vec![
                "systems".to_string(),
                "config".to_string(),
                "lib".to_string(),
                "adaptive".to_string(),
            ],
            extensions: vec![
                ".js".to_string(),
                ".ts".to_string(),
                ".json".to_string(),
                ".yaml".to_string(),
                ".yml".to_string(),
            ],
            state_dir: "local/state/security/anti_sabotage".to_string(),
            quarantine_dir: "local/state/security/anti_sabotage/quarantine".to_string(),
            snapshots_dir: "local/state/security/anti_sabotage/snapshots".to_string(),
            incident_log: "local/state/security/anti_sabotage/incidents.jsonl".to_string(),
            state_file: "local/state/security/anti_sabotage/state.json".to_string(),
            watcher_state_file: "local/state/security/anti_sabotage/watcher_state.json".to_string(),
            watcher_interval_ms: 30_000,
            max_snapshots: 20,
            verify_strict_default: true,
            auto_reset_default: true,
            watcher_strict_default: false,
            watcher_auto_reset_default: true,
        }
    }
}

fn load_anti_sabotage_policy(repo_root: &Path, parsed: &ParsedArgs) -> AntiSabotagePolicy {
    let policy_path = flag(parsed, "policy")
        .map(|v| resolve_runtime_or_state(repo_root, v))
        .unwrap_or_else(|| runtime_config_path(repo_root, "anti_sabotage_policy.json"));
    if !policy_path.exists() {
        return AntiSabotagePolicy::default();
    }
    match fs::read_to_string(&policy_path) {
        Ok(raw) => serde_json::from_str::<AntiSabotagePolicy>(&raw).unwrap_or_default(),
        Err(_) => AntiSabotagePolicy::default(),
    }
}

fn anti_sabotage_walk_files(
    repo_root: &Path,
    policy: &AntiSabotagePolicy,
) -> Vec<(String, PathBuf)> {
    let runtime = runtime_root(repo_root);
    let ext_set = policy
        .extensions
        .iter()
        .map(|v| {
            let c = clean(v, 16).to_ascii_lowercase();
            if c.starts_with('.') {
                c
            } else {
                format!(".{c}")
            }
        })
        .collect::<BTreeSet<_>>();
    let mut out = Vec::<(String, PathBuf)>::new();
    for rel_root in &policy.protected_roots {
        let root = runtime.join(normalize_rel(rel_root));
        if !root.exists() {
            continue;
        }
        for entry in WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|v| v.to_str())
                .map(|v| format!(".{}", v.to_ascii_lowercase()))
                .unwrap_or_default();
            if !ext_set.is_empty() && !ext_set.contains(&ext) {
                continue;
            }
            let rel = path
                .strip_prefix(&runtime)
                .ok()
                .map(|v| normalize_rel(v.to_string_lossy()))
                .unwrap_or_else(|| normalize_rel(path.to_string_lossy()));
            out.push((rel, path.to_path_buf()));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn anti_sabotage_paths(
    repo_root: &Path,
    policy: &AntiSabotagePolicy,
) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    (
        resolve_runtime_or_state(repo_root, &policy.state_file),
        resolve_runtime_or_state(repo_root, &policy.incident_log),
        resolve_runtime_or_state(repo_root, &policy.snapshots_dir),
        resolve_runtime_or_state(repo_root, &policy.watcher_state_file),
    )
}

fn anti_sabotage_latest_snapshot_id(snapshots_dir: &Path) -> Option<String> {
    let entries = fs::read_dir(snapshots_dir).ok()?;
    let mut names = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect::<Vec<_>>();
    names.sort();
    names.pop()
}

fn anti_sabotage_snapshot(
    repo_root: &Path,
    policy: &AntiSabotagePolicy,
    label: Option<&str>,
) -> Result<Value, String> {
    let (_state_path, _incident_path, snapshots_dir, _watcher_state_path) =
        anti_sabotage_paths(repo_root, policy);
    fs::create_dir_all(&snapshots_dir).map_err(|err| {
        format!(
            "create_snapshots_dir_failed:{}:{err}",
            snapshots_dir.display()
        )
    })?;
    let ts = Utc::now().format("%Y%m%d%H%M%S").to_string();
    let suffix = label
        .map(|v| clean(v, 40).replace(' ', "_"))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "manual".to_string());
    let snapshot_id = format!("{ts}_{suffix}");
    let snapshot_dir = snapshots_dir.join(&snapshot_id);
    let files_dir = snapshot_dir.join("files");
    fs::create_dir_all(&files_dir)
        .map_err(|err| format!("create_snapshot_files_failed:{}:{err}", files_dir.display()))?;
    let monitored = anti_sabotage_walk_files(repo_root, policy);
    let mut hashes = Map::<String, Value>::new();
    for (rel, abs) in monitored {
        let digest = sha256_hex_file(&abs)?;
        let storage = files_dir.join(&rel);
        if let Some(parent) = storage.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                format!("create_snapshot_parent_failed:{}:{err}", parent.display())
            })?;
        }
        fs::copy(&abs, &storage)
            .map_err(|err| format!("copy_snapshot_file_failed:{}:{err}", abs.display()))?;
        hashes.insert(
            rel.clone(),
            json!({
                "hash": digest,
                "storage_path": normalize_rel(storage.strip_prefix(&snapshot_dir).unwrap_or(&storage).to_string_lossy())
            }),
        );
    }
    let manifest = json!({
        "version": policy.version,
        "snapshot_id": snapshot_id,
        "created_at": now_iso(),
        "hashes": hashes
    });
    write_json_atomic(&snapshot_dir.join("manifest.json"), &manifest)?;
    Ok(json!({
        "ok": true,
        "type": "anti_sabotage_snapshot",
        "snapshot_id": manifest.get("snapshot_id").cloned().unwrap_or(Value::Null),
        "manifest_path": snapshot_dir.join("manifest.json").to_string_lossy(),
        "files": manifest.get("hashes").and_then(Value::as_object).map(|m| m.len()).unwrap_or(0)
    }))
}

fn anti_sabotage_verify(
    repo_root: &Path,
    policy: &AntiSabotagePolicy,
    snapshot_ref: &str,
    strict: bool,
    auto_reset: bool,
) -> Result<(Value, i32), String> {
    let (_state_path, incident_path, snapshots_dir, _watcher_state_path) =
        anti_sabotage_paths(repo_root, policy);
    let snapshot_id = if snapshot_ref == "latest" || snapshot_ref.is_empty() {
        anti_sabotage_latest_snapshot_id(&snapshots_dir).unwrap_or_default()
    } else {
        clean(snapshot_ref, 120)
    };
    if snapshot_id.is_empty() {
        return Ok((
            json!({
                "ok": false,
                "type": "anti_sabotage_verify",
                "error": "snapshot_missing",
                "snapshot": snapshot_ref
            }),
            if strict { 1 } else { 0 },
        ));
    }
    let snapshot_dir = snapshots_dir.join(&snapshot_id);
    let manifest_path = snapshot_dir.join("manifest.json");
    let manifest = read_json_or(&manifest_path, Value::Null);
    let expected = manifest
        .get("hashes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let monitored = anti_sabotage_walk_files(repo_root, policy);
    let mut current = BTreeMap::<String, String>::new();
    for (rel, abs) in monitored {
        if let Ok(hash) = sha256_hex_file(&abs) {
            current.insert(rel, hash);
        }
    }

    let mut mismatch = Vec::<Value>::new();
    let mut missing = Vec::<Value>::new();
    let mut extra = Vec::<Value>::new();

    for (rel, row) in &expected {
        let want = clean(
            row.get("hash")
                .or_else(|| row.get("sha256"))
                .and_then(Value::as_str)
                .unwrap_or(""),
            160,
        );
        if want.is_empty() {
            continue;
        }
        match current.get(rel) {
            None => missing.push(json!({"file": rel})),
            Some(have) => {
                if have != &want {
                    mismatch.push(json!({"file": rel, "expected": want, "current": have}));
                }
            }
        }
    }
    for rel in current.keys() {
        if !expected.contains_key(rel) {
            extra.push(json!({"file": rel}));
        }
    }

    let violated = !mismatch.is_empty() || !missing.is_empty() || !extra.is_empty();
    let mut restored = Vec::<Value>::new();
    if violated && auto_reset {
        for row in mismatch.iter().chain(missing.iter()) {
            let rel = row.get("file").and_then(Value::as_str).unwrap_or("");
            if rel.is_empty() {
                continue;
            }
            let storage_rel = expected
                .get(rel)
                .and_then(|v| v.get("storage_path"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if storage_rel.is_empty() {
                continue;
            }
            let src = snapshot_dir.join(storage_rel);
            let dst = runtime_root(repo_root).join(rel);
            if !src.exists() {
                continue;
            }
            if let Some(parent) = dst.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if fs::copy(&src, &dst).is_ok() {
                restored.push(json!({"file": rel, "restored": true}));
            }
        }
    }
    let rollback_plan_hash = sha256_hex_bytes(
        stable_json_string(&json!({
            "snapshot_id": snapshot_id,
            "mismatch": mismatch,
            "missing": missing
        }))
        .as_bytes(),
    );
    let incident = json!({
        "ts": now_iso(),
        "type": "anti_sabotage_verify",
        "snapshot_id": snapshot_id,
        "violated": violated,
        "mismatch_count": mismatch.len(),
        "missing_count": missing.len(),
        "extra_count": extra.len(),
        "restored_count": restored.len(),
        "rollback_plan": {
            "plan_hash": rollback_plan_hash
        }
    });
    let _ = append_jsonl(&incident_path, &incident);
    let code = if violated && strict { 1 } else { 0 };
    Ok((
        json!({
            "ok": !violated,
            "type": "anti_sabotage_verify",
            "snapshot_id": snapshot_id,
            "violated": violated,
            "strict": strict,
            "auto_reset": auto_reset,
            "mismatch": mismatch,
            "missing": missing,
            "extra": extra,
            "restored": restored,
            "rollback_plan_hash": rollback_plan_hash
        }),
        code,
    ))
}

fn anti_sabotage_status(repo_root: &Path, policy: &AntiSabotagePolicy) -> Value {
    let (state_path, incident_path, snapshots_dir, watcher_state_path) =
        anti_sabotage_paths(repo_root, policy);
    let latest_snapshot_id = anti_sabotage_latest_snapshot_id(&snapshots_dir);
    let latest_snapshot_manifest = latest_snapshot_id
        .as_ref()
        .map(|id| snapshots_dir.join(id).join("manifest.json"))
        .filter(|p| p.exists())
        .map(|p| normalize_rel(p.to_string_lossy()));

    let latest_incident_summary = fs::read_to_string(&incident_path)
        .ok()
        .and_then(|raw| parse_last_json_line(&raw))
        .map(|v| {
            json!({
                "incident_id": v.get("incident_id").cloned().unwrap_or(Value::Null),
                "ts": v.get("ts").cloned().unwrap_or(Value::Null),
                "snapshot_id": v.get("snapshot_id").cloned().unwrap_or(Value::Null),
                "violated": v.get("violated").cloned().unwrap_or(Value::Null),
                "mismatch_count": v.get("mismatch_count").cloned().unwrap_or(Value::Null),
                "missing_count": v.get("missing_count").cloned().unwrap_or(Value::Null),
                "extra_count": v.get("extra_count").cloned().unwrap_or(Value::Null),
                "rollback_plan_hash": v
                    .get("rollback_plan")
                    .and_then(|r| r.get("plan_hash"))
                    .cloned()
                    .unwrap_or(Value::Null)
            })
        })
        .unwrap_or(Value::Null);

    json!({
        "ok": true,
        "type": "anti_sabotage_status",
        "ts": now_iso(),
        "policy_version": policy.version,
        "latest_snapshot": latest_snapshot_id,
        "latest_snapshot_manifest": latest_snapshot_manifest,
        "latest_incident_summary": latest_incident_summary,
        "state_path": normalize_rel(state_path.to_string_lossy()),
        "incident_log": normalize_rel(incident_path.to_string_lossy()),
        "watcher_state_path": normalize_rel(watcher_state_path.to_string_lossy()),
        "watcher_state": read_json_or(&watcher_state_path, Value::Null)
    })
}

pub fn run_anti_sabotage_shield(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let policy = load_anti_sabotage_policy(repo_root, &parsed);
    match cmd.as_str() {
        "snapshot" => match anti_sabotage_snapshot(repo_root, &policy, flag(&parsed, "label")) {
            Ok(out) => (out, 0),
            Err(err) => (
                json!({"ok": false, "type":"anti_sabotage_snapshot", "error": clean(err, 220)}),
                1,
            ),
        },
        "verify" => {
            let strict = bool_flag(&parsed, "strict", policy.verify_strict_default);
            let auto_reset = bool_flag(&parsed, "auto-reset", policy.auto_reset_default);
            let snapshot_ref = flag(&parsed, "snapshot").unwrap_or("latest");
            match anti_sabotage_verify(repo_root, &policy, snapshot_ref, strict, auto_reset) {
                Ok(result) => result,
                Err(err) => (
                    json!({"ok": false, "type":"anti_sabotage_verify", "error": clean(err, 220)}),
                    1,
                ),
            }
        }
        "watch" => {
            let strict = bool_flag(&parsed, "strict", policy.watcher_strict_default);
            let auto_reset = bool_flag(&parsed, "auto-reset", policy.watcher_auto_reset_default);
            let interval_ms = flag(&parsed, "interval-ms")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(policy.watcher_interval_ms.max(250) as u64)
                .clamp(250, 300_000);
            let iterations = flag(&parsed, "iterations")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(1)
                .clamp(1, 1000);
            if bool_flag(&parsed, "bootstrap-snapshot", false) {
                let _ = anti_sabotage_snapshot(repo_root, &policy, Some("watch-bootstrap"));
            }
            let snapshot_ref = flag(&parsed, "snapshot").unwrap_or("latest").to_string();
            let mut last = json!({"ok": true, "type": "anti_sabotage_watch", "iterations": 0});
            let mut last_code = 0;
            for idx in 0..iterations {
                match anti_sabotage_verify(repo_root, &policy, &snapshot_ref, strict, auto_reset) {
                    Ok((verify, code)) => {
                        last = json!({
                            "ok": verify.get("ok").and_then(Value::as_bool).unwrap_or(false),
                            "type": "anti_sabotage_watch",
                            "iteration": idx + 1,
                            "iterations": iterations,
                            "verify": verify
                        });
                        last_code = code;
                    }
                    Err(err) => {
                        last = json!({"ok": false, "type":"anti_sabotage_watch", "error": clean(err, 220)});
                        last_code = 1;
                    }
                }
                if idx + 1 < iterations {
                    thread::sleep(Duration::from_millis(interval_ms));
                }
            }
            (last, last_code)
        }
        "status" => (anti_sabotage_status(repo_root, &policy), 0),
        _ => (
            json!({
                "ok": false,
                "type": "anti_sabotage_shield",
                "error": "unknown_command",
                "usage": [
                    "anti-sabotage-shield snapshot [--label=<id>]",
                    "anti-sabotage-shield verify [--snapshot=latest|<id>] [--strict=1|0] [--auto-reset=1|0]",
                    "anti-sabotage-shield watch [--snapshot=latest|<id>] [--strict=1|0] [--auto-reset=1|0] [--interval-ms=<n>] [--iterations=<n>]",
                    "anti-sabotage-shield status"
                ]
            }),
            2,
        ),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct ConstitutionPolicy {
    version: String,
    constitution_path: String,
    state_dir: String,
    veto_window_days: i64,
    min_approval_note_chars: usize,
    require_dual_approval: bool,
    enforce_inheritance_lock: bool,
    emergency_rollback_requires_approval: bool,
}

impl Default for ConstitutionPolicy {
    fn default() -> Self {
        Self {
            version: "1.0".to_string(),
            constitution_path: "docs/workspace/AGENT-CONSTITUTION.md".to_string(),
            state_dir: "local/state/security/constitution_guardian".to_string(),
            veto_window_days: 14,
            min_approval_note_chars: 12,
            require_dual_approval: true,
            enforce_inheritance_lock: true,
            emergency_rollback_requires_approval: true,
        }
    }
}

fn load_constitution_policy(repo_root: &Path, parsed: &ParsedArgs) -> ConstitutionPolicy {
    let policy_path = flag(parsed, "policy")
        .map(|v| resolve_runtime_or_state(repo_root, v))
        .unwrap_or_else(|| runtime_config_path(repo_root, "constitution_guardian_policy.json"));
    if !policy_path.exists() {
        return ConstitutionPolicy::default();
    }
    match fs::read_to_string(&policy_path) {
        Ok(raw) => serde_json::from_str::<ConstitutionPolicy>(&raw).unwrap_or_default(),
        Err(_) => ConstitutionPolicy::default(),
    }
}

#[derive(Debug, Clone)]
struct ConstitutionPaths {
    constitution: PathBuf,
    state_dir: PathBuf,
    genesis: PathBuf,
    proposals_dir: PathBuf,
    events: PathBuf,
    history_dir: PathBuf,
    active_state: PathBuf,
}

fn constitution_paths(repo_root: &Path, policy: &ConstitutionPolicy) -> ConstitutionPaths {
    let constitution = resolve_runtime_or_state(repo_root, &policy.constitution_path);
    let state_dir = resolve_runtime_or_state(repo_root, &policy.state_dir);
    ConstitutionPaths {
        constitution,
        genesis: state_dir.join("genesis.json"),
        proposals_dir: state_dir.join("proposals"),
        events: state_dir.join("events.jsonl"),
        history_dir: state_dir.join("history"),
        active_state: state_dir.join("active_state.json"),
        state_dir,
    }
}

fn proposal_path(paths: &ConstitutionPaths, proposal_id: &str) -> PathBuf {
    paths.proposals_dir.join(proposal_id).join("proposal.json")
}

fn load_proposal(paths: &ConstitutionPaths, proposal_id: &str) -> Option<Value> {
    let path = proposal_path(paths, proposal_id);
    if !path.exists() {
        return None;
    }
    Some(read_json_or(&path, Value::Null))
}

fn save_proposal(
    paths: &ConstitutionPaths,
    proposal_id: &str,
    value: &Value,
) -> Result<(), String> {
    write_json_atomic(&proposal_path(paths, proposal_id), value)
}

fn proposal_status(value: &Value) -> String {
    clean(
        value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown"),
        64,
    )
}

pub fn run_constitution_guardian(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let policy = load_constitution_policy(repo_root, &parsed);
    let paths = constitution_paths(repo_root, &policy);
    let _ = fs::create_dir_all(&paths.proposals_dir);
    let _ = fs::create_dir_all(&paths.history_dir);

    match cmd.as_str() {
        "init-genesis" => {
            if !paths.constitution.exists() {
                return (
                    json!({
                        "ok": false,
                        "type": "constitution_genesis",
                        "error": "constitution_missing",
                        "constitution_path": normalize_rel(paths.constitution.to_string_lossy())
                    }),
                    1,
                );
            }
            let force = bool_flag(&parsed, "force", false);
            if paths.genesis.exists() && !force {
                return (
                    json!({
                        "ok": true,
                        "type": "constitution_genesis",
                        "already_initialized": true,
                        "genesis_path": normalize_rel(paths.genesis.to_string_lossy())
                    }),
                    0,
                );
            }
            let constitution_sha = match sha256_hex_file(&paths.constitution) {
                Ok(v) => v,
                Err(err) => {
                    return (
                        json!({"ok": false, "type": "constitution_genesis", "error": clean(err, 220)}),
                        1,
                    )
                }
            };
            let genesis = json!({
                "type": "constitution_genesis",
                "ts": now_iso(),
                "constitution_path": normalize_rel(paths.constitution.to_string_lossy()),
                "constitution_sha256": constitution_sha,
                "genesis_id": format!("genesis_{}", &sha256_hex_bytes(now_iso().as_bytes())[0..12])
            });
            if let Err(err) = write_json_atomic(&paths.genesis, &genesis) {
                return (
                    json!({"ok": false, "type": "constitution_genesis", "error": clean(err, 220)}),
                    1,
                );
            }
            let _ = append_jsonl(
                &paths.events,
                &json!({"ts": now_iso(), "type": "constitution_genesis_initialized"}),
            );
            (
                json!({"ok": true, "type": "constitution_genesis", "genesis": genesis}),
                0,
            )
        }
        "propose-change" => {
            let candidate_file = clean(
                flag(&parsed, "candidate-file")
                    .or_else(|| flag(&parsed, "candidate_file"))
                    .unwrap_or(""),
                420,
            );
            let proposer = clean(
                flag(&parsed, "proposer-id")
                    .or_else(|| flag(&parsed, "proposer_id"))
                    .unwrap_or(""),
                120,
            );
            let reason = clean(flag(&parsed, "reason").unwrap_or(""), 400);
            if candidate_file.is_empty() || proposer.is_empty() || reason.is_empty() {
                return (
                    json!({"ok": false, "type": "constitution_propose_change", "error": "candidate_file_proposer_id_reason_required"}),
                    1,
                );
            }
            let candidate_abs = resolve_runtime_or_state(repo_root, &candidate_file);
            if !candidate_abs.exists() {
                return (
                    json!({"ok": false, "type": "constitution_propose_change", "error": "candidate_file_missing"}),
                    1,
                );
            }
            let proposal_id = clean(
                flag(&parsed, "proposal-id")
                    .or_else(|| flag(&parsed, "proposal_id"))
                    .unwrap_or(&format!(
                        "ccp_{}",
                        &sha256_hex_bytes(now_iso().as_bytes())[0..10]
                    )),
                120,
            );
            let proposal_dir = paths.proposals_dir.join(&proposal_id);
            let candidate_copy = proposal_dir.join("candidate_constitution.md");
            if let Some(parent) = candidate_copy.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Err(err) = fs::copy(&candidate_abs, &candidate_copy) {
                return (
                    json!({"ok": false, "type": "constitution_propose_change", "error": clean(format!("copy_candidate_failed:{err}"), 220)}),
                    1,
                );
            }
            let candidate_sha = sha256_hex_file(&candidate_copy).unwrap_or_default();
            let proposal = json!({
                "proposal_id": proposal_id,
                "status": "pending_approval",
                "created_at": now_iso(),
                "proposer_id": proposer,
                "reason": reason,
                "candidate_file": normalize_rel(candidate_copy.to_string_lossy()),
                "candidate_sha256": candidate_sha,
                "approvals": [],
                "veto": null,
                "gauntlet": null,
                "activated_at": null
            });
            if let Err(err) = save_proposal(&paths, &proposal_id, &proposal) {
                return (
                    json!({"ok": false, "type": "constitution_propose_change", "error": clean(err, 220)}),
                    1,
                );
            }
            let _ = append_jsonl(
                &paths.events,
                &json!({"ts": now_iso(), "type": "constitution_proposal_created", "proposal_id": proposal_id}),
            );
            (
                json!({"ok": true, "type": "constitution_propose_change", "proposal": proposal}),
                0,
            )
        }
        "approve-change" => {
            let proposal_id = clean(
                flag(&parsed, "proposal-id")
                    .or_else(|| flag(&parsed, "proposal_id"))
                    .unwrap_or(""),
                120,
            );
            let approver_id = clean(
                flag(&parsed, "approver-id")
                    .or_else(|| flag(&parsed, "approver_id"))
                    .unwrap_or(""),
                120,
            );
            let approval_note = clean(
                flag(&parsed, "approval-note")
                    .or_else(|| flag(&parsed, "approval_note"))
                    .unwrap_or(""),
                500,
            );
            if proposal_id.is_empty()
                || approver_id.is_empty()
                || approval_note.len() < policy.min_approval_note_chars
            {
                return (
                    json!({"ok": false, "type": "constitution_approve_change", "error": "proposal_id_approver_id_and_approval_note_required"}),
                    1,
                );
            }
            let mut proposal = match load_proposal(&paths, &proposal_id) {
                Some(v) if v.is_object() => v,
                _ => {
                    return (
                        json!({"ok": false, "type": "constitution_approve_change", "error": "proposal_missing"}),
                        1,
                    )
                }
            };
            let mut approvals = proposal
                .get("approvals")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            approvals.push(json!({
                "approver_id": approver_id,
                "approval_note": approval_note,
                "ts": now_iso()
            }));
            let approved_count = approvals.len();
            let status = if policy.require_dual_approval && approved_count < 2 {
                "pending_secondary_approval"
            } else {
                "approved"
            };
            if let Some(obj) = proposal.as_object_mut() {
                obj.insert("approvals".to_string(), Value::Array(approvals));
                obj.insert("status".to_string(), Value::String(status.to_string()));
                obj.insert("updated_at".to_string(), Value::String(now_iso()));
            }
            if let Err(err) = save_proposal(&paths, &proposal_id, &proposal) {
                return (
                    json!({"ok": false, "type": "constitution_approve_change", "error": clean(err, 220)}),
                    1,
                );
            }
            let _ = append_jsonl(
                &paths.events,
                &json!({"ts": now_iso(), "type": "constitution_proposal_approved", "proposal_id": proposal_id, "status": status}),
            );
            (
                json!({"ok": true, "type": "constitution_approve_change", "proposal": proposal}),
                0,
            )
        }
        "veto-change" => {
            let proposal_id = clean(
                flag(&parsed, "proposal-id")
                    .or_else(|| flag(&parsed, "proposal_id"))
                    .unwrap_or(""),
                120,
            );
            let veto_by = clean(
                flag(&parsed, "veto-by")
                    .or_else(|| flag(&parsed, "veto_by"))
                    .unwrap_or(""),
                120,
            );
            let note = clean(flag(&parsed, "note").unwrap_or(""), 400);
            if proposal_id.is_empty() || veto_by.is_empty() || note.is_empty() {
                return (
                    json!({"ok": false, "type": "constitution_veto_change", "error": "proposal_id_veto_by_note_required"}),
                    1,
                );
            }
            let mut proposal = match load_proposal(&paths, &proposal_id) {
                Some(v) if v.is_object() => v,
                _ => {
                    return (
                        json!({"ok": false, "type": "constitution_veto_change", "error": "proposal_missing"}),
                        1,
                    )
                }
            };
            if let Some(obj) = proposal.as_object_mut() {
                obj.insert("status".to_string(), Value::String("vetoed".to_string()));
                obj.insert(
                    "veto".to_string(),
                    json!({"veto_by": veto_by, "note": note, "ts": now_iso()}),
                );
            }
            if let Err(err) = save_proposal(&paths, &proposal_id, &proposal) {
                return (
                    json!({"ok": false, "type": "constitution_veto_change", "error": clean(err, 220)}),
                    1,
                );
            }
            let _ = append_jsonl(
                &paths.events,
                &json!({"ts": now_iso(), "type": "constitution_proposal_vetoed", "proposal_id": proposal_id}),
            );
            (
                json!({"ok": true, "type": "constitution_veto_change", "proposal": proposal}),
                0,
            )
        }
        "run-gauntlet" => {
            let proposal_id = clean(
                flag(&parsed, "proposal-id")
                    .or_else(|| flag(&parsed, "proposal_id"))
                    .unwrap_or(""),
                120,
            );
            let critical_failures = flag(&parsed, "critical-failures")
                .or_else(|| flag(&parsed, "critical_failures"))
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0)
                .max(0);
            if proposal_id.is_empty() {
                return (
                    json!({"ok": false, "type": "constitution_run_gauntlet", "error": "proposal_id_required"}),
                    1,
                );
            }
            let mut proposal = match load_proposal(&paths, &proposal_id) {
                Some(v) if v.is_object() => v,
                _ => {
                    return (
                        json!({"ok": false, "type": "constitution_run_gauntlet", "error": "proposal_missing"}),
                        1,
                    )
                }
            };
            let gauntlet = json!({
                "ts": now_iso(),
                "critical_failures": critical_failures,
                "evidence": clean(flag(&parsed, "evidence").unwrap_or(""), 400),
                "passed": critical_failures == 0
            });
            if let Some(obj) = proposal.as_object_mut() {
                obj.insert("gauntlet".to_string(), gauntlet.clone());
                obj.insert(
                    "status".to_string(),
                    Value::String(
                        if critical_failures == 0 {
                            "gauntlet_passed"
                        } else {
                            "gauntlet_failed"
                        }
                        .to_string(),
                    ),
                );
            }
            if let Err(err) = save_proposal(&paths, &proposal_id, &proposal) {
                return (
                    json!({"ok": false, "type": "constitution_run_gauntlet", "error": clean(err, 220)}),
                    1,
                );
            }
            let _ = append_jsonl(
                &paths.events,
                &json!({"ts": now_iso(), "type": "constitution_gauntlet", "proposal_id": proposal_id, "passed": critical_failures == 0}),
            );
            (
                json!({"ok": critical_failures == 0, "type": "constitution_run_gauntlet", "proposal": proposal}),
                if critical_failures == 0 { 0 } else { 1 },
            )
        }
        "activate-change" => {
            let proposal_id = clean(
                flag(&parsed, "proposal-id")
                    .or_else(|| flag(&parsed, "proposal_id"))
                    .unwrap_or(""),
                120,
            );
            let approver_id = clean(
                flag(&parsed, "approver-id")
                    .or_else(|| flag(&parsed, "approver_id"))
                    .unwrap_or(""),
                120,
            );
            let approval_note = clean(
                flag(&parsed, "approval-note")
                    .or_else(|| flag(&parsed, "approval_note"))
                    .unwrap_or(""),
                500,
            );
            if proposal_id.is_empty()
                || approver_id.is_empty()
                || approval_note.len() < policy.min_approval_note_chars
            {
                return (
                    json!({"ok": false, "type": "constitution_activate_change", "error": "proposal_id_approver_id_and_approval_note_required"}),
                    1,
                );
            }
            let mut proposal = match load_proposal(&paths, &proposal_id) {
                Some(v) if v.is_object() => v,
                _ => {
                    return (
                        json!({"ok": false, "type": "constitution_activate_change", "error": "proposal_missing"}),
                        1,
                    )
                }
            };
            let status = proposal_status(&proposal);
            if status != "approved" && status != "gauntlet_passed" {
                return (
                    json!({"ok": false, "type": "constitution_activate_change", "error": "proposal_not_approved", "status": status}),
                    1,
                );
            }
            let gauntlet_passed = proposal
                .get("gauntlet")
                .and_then(|v| v.get("passed"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !gauntlet_passed {
                return (
                    json!({"ok": false, "type": "constitution_activate_change", "error": "gauntlet_not_passed"}),
                    1,
                );
            }
            let candidate_path = proposal
                .get("candidate_file")
                .and_then(Value::as_str)
                .map(|v| resolve_runtime_or_state(repo_root, v))
                .unwrap_or_else(|| PathBuf::from(""));
            if !candidate_path.exists() {
                return (
                    json!({"ok": false, "type": "constitution_activate_change", "error": "candidate_copy_missing"}),
                    1,
                );
            }
            if paths.constitution.exists() {
                let backup_name = format!("{}_constitution.md", Utc::now().format("%Y%m%d%H%M%S"));
                let backup_path = paths.history_dir.join(backup_name);
                if let Some(parent) = backup_path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::copy(&paths.constitution, &backup_path);
            }
            if let Some(parent) = paths.constitution.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Err(err) = fs::copy(&candidate_path, &paths.constitution) {
                return (
                    json!({"ok": false, "type": "constitution_activate_change", "error": clean(format!("activate_copy_failed:{err}"), 220)}),
                    1,
                );
            }
            if let Some(obj) = proposal.as_object_mut() {
                obj.insert("status".to_string(), Value::String("active".to_string()));
                obj.insert("activated_at".to_string(), Value::String(now_iso()));
                obj.insert(
                    "activation".to_string(),
                    json!({"approver_id": approver_id, "approval_note": approval_note}),
                );
            }
            if let Err(err) = save_proposal(&paths, &proposal_id, &proposal) {
                return (
                    json!({"ok": false, "type": "constitution_activate_change", "error": clean(err, 220)}),
                    1,
                );
            }
            if let Err(err) = write_json_atomic(
                &paths.active_state,
                &json!({
                    "active_proposal_id": proposal_id,
                    "activated_at": now_iso(),
                    "constitution_sha256": sha256_hex_file(&paths.constitution).unwrap_or_default()
                }),
            ) {
                return (
                    json!({"ok": false, "type": "constitution_activate_change", "error": clean(err, 220)}),
                    1,
                );
            }
            let _ = append_jsonl(
                &paths.events,
                &json!({"ts": now_iso(), "type": "constitution_activated", "proposal_id": proposal_id}),
            );
            (
                json!({"ok": true, "type": "constitution_activate_change", "proposal": proposal}),
                0,
            )
        }
        "enforce-inheritance" => {
            let actor = clean(flag(&parsed, "actor").unwrap_or("unknown"), 120);
            let target = clean(flag(&parsed, "target").unwrap_or("unknown"), 120);
            let locked = policy.enforce_inheritance_lock;
            let out = json!({
                "ok": true,
                "type": "constitution_enforce_inheritance",
                "actor": actor,
                "target": target,
                "inheritance_lock_enforced": locked,
                "ts": now_iso()
            });
            let _ = append_jsonl(&paths.events, &out);
            (out, 0)
        }
        "emergency-rollback" => {
            let note = clean(flag(&parsed, "note").unwrap_or(""), 400);
            if policy.emergency_rollback_requires_approval
                && note.len() < policy.min_approval_note_chars
            {
                return (
                    json!({"ok": false, "type": "constitution_emergency_rollback", "error": "approval_note_too_short"}),
                    1,
                );
            }
            let mut backups = fs::read_dir(&paths.history_dir)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .collect::<Vec<_>>();
            backups.sort_by_key(|e| e.file_name());
            let Some(entry) = backups.pop() else {
                return (
                    json!({"ok": false, "type": "constitution_emergency_rollback", "error": "no_backup_available"}),
                    1,
                );
            };
            if let Err(err) = fs::copy(entry.path(), &paths.constitution) {
                return (
                    json!({"ok": false, "type": "constitution_emergency_rollback", "error": clean(format!("rollback_copy_failed:{err}"), 220)}),
                    1,
                );
            }
            let _ = append_jsonl(
                &paths.events,
                &json!({
                    "ts": now_iso(),
                    "type": "constitution_emergency_rollback",
                    "rollback_from": normalize_rel(entry.path().to_string_lossy()),
                    "note": note
                }),
            );
            (
                json!({
                    "ok": true,
                    "type": "constitution_emergency_rollback",
                    "rollback_from": normalize_rel(entry.path().to_string_lossy())
                }),
                0,
            )
        }
        "status" => {
            let proposals = fs::read_dir(&paths.proposals_dir)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter_map(|e| e.file_name().into_string().ok())
                .collect::<Vec<_>>();
            (
                json!({
                    "ok": true,
                    "type": "constitution_guardian_status",
                    "ts": now_iso(),
                    "policy_version": policy.version,
                    "constitution_path": normalize_rel(paths.constitution.to_string_lossy()),
                    "genesis": read_json_or(&paths.genesis, Value::Null),
                    "active_state": read_json_or(&paths.active_state, Value::Null),
                    "proposals_count": proposals.len(),
                    "proposals": proposals.into_iter().take(25).collect::<Vec<_>>(),
                    "state_dir": normalize_rel(paths.state_dir.to_string_lossy())
                }),
                0,
            )
        }
        _ => (
            json!({
                "ok": false,
                "type": "constitution_guardian",
                "error": "unknown_command",
                "usage": [
                    "constitution-guardian init-genesis [--force=1|0]",
                    "constitution-guardian propose-change --candidate-file=<path> --proposer-id=<id> --reason=<text>",
                    "constitution-guardian approve-change --proposal-id=<id> --approver-id=<id> --approval-note=<text>",
                    "constitution-guardian veto-change --proposal-id=<id> --veto-by=<id> --note=<text>",
                    "constitution-guardian run-gauntlet --proposal-id=<id> [--critical-failures=<n>] [--evidence=<text>]",
                    "constitution-guardian activate-change --proposal-id=<id> --approver-id=<id> --approval-note=<text>",
                    "constitution-guardian enforce-inheritance --actor=<id> --target=<id>",
                    "constitution-guardian emergency-rollback --note=<text>",
                    "constitution-guardian status"
                ]
            }),
            2,
        ),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct RemoteEmergencyHaltPolicy {
    version: String,
    enabled: bool,
    key_env: String,
    max_ttl_seconds: i64,
    max_clock_skew_seconds: i64,
    replay_nonce_ttl_seconds: i64,
    paths: RemoteEmergencyPaths,
    secure_purge: RemoteEmergencyPurge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct RemoteEmergencyPaths {
    state: String,
    nonce_store: String,
    audit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct RemoteEmergencyPurge {
    enabled: bool,
    allow_live_purge: bool,
    confirm_phrase: String,
    sensitive_paths: Vec<String>,
}

impl Default for RemoteEmergencyPaths {
    fn default() -> Self {
        Self {
            state: "local/state/security/remote_emergency_halt_state.json".to_string(),
            nonce_store: "local/state/security/remote_emergency_halt_nonces.json".to_string(),
            audit: "local/state/security/remote_emergency_halt_audit.jsonl".to_string(),
        }
    }
}

impl Default for RemoteEmergencyPurge {
    fn default() -> Self {
        Self {
            enabled: true,
            allow_live_purge: false,
            confirm_phrase: "I UNDERSTAND THIS PURGES SENSITIVE STATE".to_string(),
            sensitive_paths: vec![
                "local/state/security/soul_token_guard.json".to_string(),
                "local/state/security/release_attestations.jsonl".to_string(),
                "local/state/security/capability_leases.json".to_string(),
                "local/state/security/capability_leases.jsonl".to_string(),
            ],
        }
    }
}

impl Default for RemoteEmergencyHaltPolicy {
    fn default() -> Self {
        Self {
            version: "1.0".to_string(),
            enabled: true,
            key_env: "REMOTE_EMERGENCY_HALT_KEY".to_string(),
            max_ttl_seconds: 300,
            max_clock_skew_seconds: 30,
            replay_nonce_ttl_seconds: 86_400,
            paths: RemoteEmergencyPaths::default(),
            secure_purge: RemoteEmergencyPurge::default(),
        }
    }
}

fn load_remote_emergency_policy(
    repo_root: &Path,
    parsed: &ParsedArgs,
) -> RemoteEmergencyHaltPolicy {
    let policy_path = flag(parsed, "policy")
        .map(|v| resolve_runtime_or_state(repo_root, v))
        .unwrap_or_else(|| runtime_config_path(repo_root, "remote_emergency_halt_policy.json"));
    if !policy_path.exists() {
        return RemoteEmergencyHaltPolicy::default();
    }
    match fs::read_to_string(&policy_path) {
        Ok(raw) => serde_json::from_str::<RemoteEmergencyHaltPolicy>(&raw).unwrap_or_default(),
        Err(_) => RemoteEmergencyHaltPolicy::default(),
    }
}

fn decode_b64_json(raw: &str) -> Option<Value> {
    let bytes = BASE64_STANDARD.decode(raw.as_bytes()).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()
}

fn clean_expired_nonces(store: &mut Map<String, Value>, now_ms: i64) {
    let keys = store
        .iter()
        .filter_map(|(k, v)| {
            let exp = v.as_i64().unwrap_or(0);
            if exp <= now_ms {
                Some(k.clone())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    for key in keys {
        store.remove(&key);
    }
}

pub fn run_remote_emergency_halt(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let policy = load_remote_emergency_policy(repo_root, &parsed);
    let state_path = resolve_runtime_or_state(repo_root, &policy.paths.state);
    let nonce_store_path = resolve_runtime_or_state(repo_root, &policy.paths.nonce_store);
    let audit_path = resolve_runtime_or_state(repo_root, &policy.paths.audit);
    let key = std::env::var(&policy.key_env)
        .ok()
        .map(|v| clean(v, 4096))
        .unwrap_or_default();

    match cmd.as_str() {
        "status" => (
            json!({
                "ok": true,
                "type": "remote_emergency_halt_status",
                "ts": now_iso(),
                "enabled": policy.enabled,
                "key_env": policy.key_env,
                "state_path": normalize_rel(state_path.to_string_lossy()),
                "nonce_store_path": normalize_rel(nonce_store_path.to_string_lossy()),
                "state": read_json_or(&state_path, json!({"halted": false})),
                "nonces": read_json_or(&nonce_store_path, json!({"version":1, "entries": {}}))
                    .get("entries")
                    .and_then(Value::as_object)
                    .map(|m| m.len())
                    .unwrap_or(0)
            }),
            0,
        ),
        "sign-halt" | "sign-purge" => {
            if key.is_empty() {
                return (
                    json!({"ok": false, "type":"remote_emergency_halt_sign", "error":"remote_emergency_halt_key_missing", "key_env": policy.key_env}),
                    1,
                );
            }
            let action = if cmd == "sign-purge" { "purge" } else { "halt" };
            let ttl = flag(&parsed, "ttl-sec")
                .or_else(|| flag(&parsed, "ttl_sec"))
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(120)
                .clamp(10, policy.max_ttl_seconds.max(10));
            let now_ms = Utc::now().timestamp_millis();
            let mut payload = json!({
                "type": "remote_emergency_command",
                "action": action,
                "command_id": format!("reh_{}", &sha256_hex_bytes(format!("{}|{}", now_ms, action).as_bytes())[0..12]),
                "nonce": format!("nonce_{}", &sha256_hex_bytes(format!("{}|{}", now_ms, std::process::id()).as_bytes())[0..10]),
                "issued_at": now_iso(),
                "issued_at_ms": now_ms,
                "expires_at_ms": now_ms + ttl * 1000,
                "scope": clean(flag(&parsed, "scope").unwrap_or("all"), 120),
                "approval_note": clean(flag(&parsed, "approval-note").or_else(|| flag(&parsed, "approval_note")).unwrap_or(""), 400),
                "pending_id": clean(flag(&parsed, "pending-id").or_else(|| flag(&parsed, "pending_id")).unwrap_or(""), 120)
            });
            let signature = match hmac_sha256_hex(&key, &payload) {
                Ok(v) => v,
                Err(err) => return (json!({"ok": false, "error": clean(err, 220)}), 1),
            };
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("signature".to_string(), Value::String(signature));
            }
            (
                json!({
                    "ok": true,
                    "type": "remote_emergency_halt_sign",
                    "action": action,
                    "command": payload.clone(),
                    "command_b64": BASE64_STANDARD.encode(stable_json_string(&payload))
                }),
                0,
            )
        }
        "receive-b64" => {
            let raw = clean(
                flag(&parsed, "command-b64")
                    .or_else(|| flag(&parsed, "command_b64"))
                    .unwrap_or(""),
                16_384,
            );
            if raw.is_empty() {
                return (
                    json!({"ok": false, "type":"remote_emergency_halt_receive", "error":"command_b64_required"}),
                    1,
                );
            }
            let Some(cmd_payload) = decode_b64_json(&raw) else {
                return (
                    json!({"ok": false, "type":"remote_emergency_halt_receive", "error":"command_b64_invalid"}),
                    1,
                );
            };
            let mut next_args = vec!["receive".to_string()];
            next_args.push(format!("--command={}", stable_json_string(&cmd_payload)));
            run_remote_emergency_halt(repo_root, &next_args)
        }
        "receive" => {
            if key.is_empty() {
                return (
                    json!({"ok": false, "type":"remote_emergency_halt_receive", "error":"remote_emergency_halt_key_missing", "key_env": policy.key_env}),
                    1,
                );
            }
            let raw_cmd = clean(flag(&parsed, "command").unwrap_or(""), 32_000);
            if raw_cmd.is_empty() {
                return (
                    json!({"ok": false, "type":"remote_emergency_halt_receive", "error":"command_required"}),
                    1,
                );
            }
            let mut payload = match serde_json::from_str::<Value>(&raw_cmd) {
                Ok(v) => v,
                Err(_) => {
                    return (
                        json!({"ok": false, "type":"remote_emergency_halt_receive", "error":"command_json_invalid"}),
                        1,
                    )
                }
            };
            let Some(signature) = payload
                .get("signature")
                .and_then(Value::as_str)
                .map(|v| clean(v, 240))
            else {
                return (
                    json!({"ok": false, "type":"remote_emergency_halt_receive", "error":"signature_missing"}),
                    1,
                );
            };
            if let Some(obj) = payload.as_object_mut() {
                obj.remove("signature");
            }
            let expected = match hmac_sha256_hex(&key, &payload) {
                Ok(v) => v,
                Err(err) => return (json!({"ok":false, "error": clean(err, 220)}), 1),
            };
            if !secure_eq_hex(&signature, &expected) {
                return (
                    json!({"ok": false, "type":"remote_emergency_halt_receive", "error":"signature_invalid"}),
                    1,
                );
            }
            let now_ms = Utc::now().timestamp_millis();
            let expires_at_ms = payload
                .get("expires_at_ms")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if expires_at_ms <= now_ms - (policy.max_clock_skew_seconds * 1000) {
                return (
                    json!({"ok": false, "type":"remote_emergency_halt_receive", "error":"command_expired"}),
                    1,
                );
            }
            let nonce = clean(
                payload.get("nonce").and_then(Value::as_str).unwrap_or(""),
                180,
            );
            if nonce.is_empty() {
                return (
                    json!({"ok": false, "type":"remote_emergency_halt_receive", "error":"nonce_missing"}),
                    1,
                );
            }
            let mut nonce_doc =
                read_json_or(&nonce_store_path, json!({"version":1, "entries": {}}));
            let entries = nonce_doc
                .get_mut("entries")
                .and_then(Value::as_object_mut)
                .cloned()
                .unwrap_or_default();
            let mut entries_mut = entries;
            clean_expired_nonces(&mut entries_mut, now_ms);
            if entries_mut.contains_key(&nonce) {
                return (
                    json!({"ok": false, "type":"remote_emergency_halt_receive", "error":"nonce_replay"}),
                    1,
                );
            }
            entries_mut.insert(
                nonce.clone(),
                Value::Number((now_ms + policy.replay_nonce_ttl_seconds * 1000).into()),
            );
            if let Some(obj) = nonce_doc.as_object_mut() {
                obj.insert("entries".to_string(), Value::Object(entries_mut));
                obj.insert("updated_at".to_string(), Value::String(now_iso()));
            }
            let _ = write_json_atomic(&nonce_store_path, &nonce_doc);

            let action = clean(
                payload.get("action").and_then(Value::as_str).unwrap_or(""),
                40,
            )
            .to_ascii_lowercase();
            let mut state = read_json_or(
                &state_path,
                json!({"halted": false, "updated_at": null, "last_command_id": null}),
            );
            let mut applied = false;
            let mut purge = json!({"executed": false, "deleted": []});
            if action == "halt" {
                if let Some(obj) = state.as_object_mut() {
                    obj.insert("halted".to_string(), Value::Bool(true));
                    obj.insert("updated_at".to_string(), Value::String(now_iso()));
                    obj.insert(
                        "last_command_id".to_string(),
                        payload.get("command_id").cloned().unwrap_or(Value::Null),
                    );
                }
                applied = true;
            } else if action == "purge" {
                if policy.secure_purge.enabled && policy.secure_purge.allow_live_purge {
                    let mut deleted = Vec::<Value>::new();
                    for rel in &policy.secure_purge.sensitive_paths {
                        let path = resolve_runtime_or_state(repo_root, rel);
                        if path.exists() && fs::remove_file(&path).is_ok() {
                            deleted.push(Value::String(normalize_rel(path.to_string_lossy())));
                        }
                    }
                    purge = json!({"executed": true, "deleted": deleted});
                    applied = true;
                } else if let Some(obj) = state.as_object_mut() {
                    obj.insert("purge_pending".to_string(), payload.clone());
                    obj.insert("updated_at".to_string(), Value::String(now_iso()));
                }
            } else {
                return (
                    json!({"ok": false, "type":"remote_emergency_halt_receive", "error":"unknown_action"}),
                    1,
                );
            }
            let _ = write_json_atomic(&state_path, &state);
            let _ = append_jsonl(
                &audit_path,
                &json!({
                    "ts": now_iso(),
                    "type": "remote_emergency_halt_receive",
                    "action": action,
                    "applied": applied,
                    "command_id": payload.get("command_id").cloned().unwrap_or(Value::Null)
                }),
            );
            (
                json!({
                    "ok": true,
                    "type": "remote_emergency_halt_receive",
                    "action": action,
                    "applied": applied,
                    "state": state,
                    "purge": purge
                }),
                0,
            )
        }
        _ => (
            json!({
                "ok": false,
                "type": "remote_emergency_halt",
                "error": "unknown_command",
                "usage": [
                    "remote-emergency-halt status",
                    "remote-emergency-halt sign-halt --approval-note=<text> [--scope=<scope>] [--ttl-sec=<n>]",
                    "remote-emergency-halt sign-purge --pending-id=<id>",
                    "remote-emergency-halt receive --command=<json>",
                    "remote-emergency-halt receive-b64 --command-b64=<base64>"
                ]
            }),
            2,
        ),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct SoulTokenGuardPolicy {
    version: String,
    enabled: bool,
    enforcement_mode: String,
    bind_to_fingerprint: bool,
    default_attestation_valid_hours: i64,
    key_env: String,
    token_state_path: String,
    audit_path: String,
    attestation_path: String,
}

impl Default for SoulTokenGuardPolicy {
    fn default() -> Self {
        Self {
            version: "1.0".to_string(),
            enabled: true,
            enforcement_mode: "advisory".to_string(),
            bind_to_fingerprint: true,
            default_attestation_valid_hours: 24 * 7,
            key_env: "SOUL_TOKEN_GUARD_KEY".to_string(),
            token_state_path: "local/state/security/soul_token_guard.json".to_string(),
            audit_path: "local/state/security/soul_token_guard_audit.jsonl".to_string(),
            attestation_path: "local/state/security/release_attestations.jsonl".to_string(),
        }
    }
}

fn load_soul_token_policy(repo_root: &Path, parsed: &ParsedArgs) -> SoulTokenGuardPolicy {
    let policy_path = flag(parsed, "policy")
        .map(|v| resolve_runtime_or_state(repo_root, v))
        .unwrap_or_else(|| runtime_config_path(repo_root, "soul_token_guard_policy.json"));
    if !policy_path.exists() {
        return SoulTokenGuardPolicy::default();
    }
    match fs::read_to_string(&policy_path) {
        Ok(raw) => serde_json::from_str::<SoulTokenGuardPolicy>(&raw).unwrap_or_default(),
        Err(_) => SoulTokenGuardPolicy::default(),
    }
}

fn soul_fingerprint(repo_root: &Path) -> String {
    let hostname = std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown-host".to_string());
    let seed = format!(
        "{}|{}|{}|{}",
        hostname,
        std::env::consts::OS,
        std::env::consts::ARCH,
        repo_root.display()
    );
    format!("fp_{}", &sha256_hex_bytes(seed.as_bytes())[0..16])
}

fn read_jsonl_rows(path: &Path) -> Vec<Value> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>()
}

pub fn run_soul_token_guard(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let policy = load_soul_token_policy(repo_root, &parsed);
    let token_state_path = resolve_runtime_or_state(repo_root, &policy.token_state_path);
    let audit_path = resolve_runtime_or_state(repo_root, &policy.audit_path);
    let attestation_path = resolve_runtime_or_state(repo_root, &policy.attestation_path);
    let key = std::env::var(&policy.key_env)
        .ok()
        .map(|v| clean(v, 4096))
        .unwrap_or_default();

    match cmd.as_str() {
        "issue" => {
            if key.is_empty() {
                return (
                    json!({"ok": false, "type":"soul_token_issue", "error":"soul_token_guard_key_missing", "key_env": policy.key_env}),
                    1,
                );
            }
            let instance_id = clean(
                flag(&parsed, "instance-id")
                    .or_else(|| flag(&parsed, "instance_id"))
                    .unwrap_or("default"),
                160,
            );
            let approval_note = clean(
                flag(&parsed, "approval-note")
                    .or_else(|| flag(&parsed, "approval_note"))
                    .unwrap_or(""),
                400,
            );
            let token_id = format!(
                "stg_{}",
                &sha256_hex_bytes(format!("{}|{}", now_iso(), instance_id).as_bytes())[0..12]
            );
            let fingerprint = soul_fingerprint(repo_root);
            let payload = json!({
                "token_id": token_id,
                "instance_id": instance_id,
                "issued_at": now_iso(),
                "fingerprint": fingerprint,
                "approval_note": approval_note
            });
            let signature = match hmac_sha256_hex(&key, &payload) {
                Ok(v) => v,
                Err(err) => return (json!({"ok": false, "error": clean(err, 220)}), 1),
            };
            let state = json!({
                "version": policy.version,
                "token": payload,
                "signature": signature,
                "issued_at": now_iso()
            });
            if let Err(err) = write_json_atomic(&token_state_path, &state) {
                return (
                    json!({"ok": false, "type":"soul_token_issue", "error": clean(err, 220)}),
                    1,
                );
            }
            let _ = append_jsonl(
                &audit_path,
                &json!({"ts": now_iso(), "type": "soul_token_issue", "token_id": state.get("token").and_then(|v| v.get("token_id")).cloned().unwrap_or(Value::Null)}),
            );
            (
                json!({
                    "ok": true,
                    "type": "soul_token_issue",
                    "token_id": state.get("token").and_then(|v| v.get("token_id")).cloned().unwrap_or(Value::Null),
                    "token_state_path": normalize_rel(token_state_path.to_string_lossy())
                }),
                0,
            )
        }
        "stamp-build" => {
            if key.is_empty() {
                return (
                    json!({"ok": false, "type":"soul_token_stamp_build", "error":"soul_token_guard_key_missing", "key_env": policy.key_env}),
                    1,
                );
            }
            let build_id = clean(
                flag(&parsed, "build-id")
                    .or_else(|| flag(&parsed, "build_id"))
                    .unwrap_or(""),
                180,
            );
            if build_id.is_empty() {
                return (
                    json!({"ok": false, "type":"soul_token_stamp_build", "error":"build_id_required"}),
                    1,
                );
            }
            let channel = clean(flag(&parsed, "channel").unwrap_or("default"), 80);
            let valid_hours = flag(&parsed, "valid-hours")
                .or_else(|| flag(&parsed, "valid_hours"))
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(policy.default_attestation_valid_hours)
                .clamp(1, 24 * 365);
            let now_ms = Utc::now().timestamp_millis();
            let attestation = json!({
                "type": "release_attestation",
                "build_id": build_id,
                "channel": channel,
                "issued_at": now_iso(),
                "expires_at_ms": now_ms + valid_hours * 3600 * 1000,
                "token_id": read_json_or(&token_state_path, Value::Null).get("token").and_then(|v| v.get("token_id")).cloned().unwrap_or(Value::Null)
            });
            let signature = match hmac_sha256_hex(&key, &attestation) {
                Ok(v) => v,
                Err(err) => return (json!({"ok": false, "error": clean(err, 220)}), 1),
            };
            let row = json!({"attestation": attestation, "signature": signature});
            if let Err(err) = append_jsonl(&attestation_path, &row) {
                return (
                    json!({"ok": false, "type":"soul_token_stamp_build", "error": clean(err, 220)}),
                    1,
                );
            }
            let _ = append_jsonl(
                &audit_path,
                &json!({"ts": now_iso(), "type": "soul_token_stamp_build", "build_id": build_id}),
            );
            (
                json!({"ok": true, "type": "soul_token_stamp_build", "attestation": row}),
                0,
            )
        }
        "verify" => {
            let strict = bool_flag(&parsed, "strict", false);
            if key.is_empty() {
                let out = json!({"ok": false, "type":"soul_token_verify", "error":"soul_token_guard_key_missing", "key_env": policy.key_env});
                return (out, if strict { 1 } else { 0 });
            }
            let state = read_json_or(&token_state_path, Value::Null);
            let token = state.get("token").cloned().unwrap_or(Value::Null);
            let signature = clean(
                state.get("signature").and_then(Value::as_str).unwrap_or(""),
                240,
            );
            let mut ok = state.is_object() && token.is_object() && !signature.is_empty();
            let mut reason = "verified".to_string();
            if !ok {
                reason = "token_state_missing".to_string();
            } else {
                let expected = hmac_sha256_hex(&key, &token).unwrap_or_default();
                if !secure_eq_hex(&signature, &expected) {
                    ok = false;
                    reason = "signature_mismatch".to_string();
                } else if policy.bind_to_fingerprint {
                    let expected_fp = soul_fingerprint(repo_root);
                    let token_fp = clean(
                        token
                            .get("fingerprint")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        200,
                    );
                    if expected_fp != token_fp {
                        ok = false;
                        reason = "fingerprint_mismatch".to_string();
                    }
                }
            }
            let _ = append_jsonl(
                &audit_path,
                &json!({"ts": now_iso(), "type": "soul_token_verify", "ok": ok, "reason": reason}),
            );
            let out = json!({
                "ok": ok,
                "type": "soul_token_verify",
                "reason": reason,
                "enforcement_mode": policy.enforcement_mode,
                "token_state_path": normalize_rel(token_state_path.to_string_lossy())
            });
            (out.clone(), if ok || !strict { 0 } else { 1 })
        }
        "status" => {
            let rows = read_jsonl_rows(&attestation_path);
            (
                json!({
                    "ok": true,
                    "type": "soul_token_status",
                    "ts": now_iso(),
                    "enabled": policy.enabled,
                    "enforcement_mode": policy.enforcement_mode,
                    "key_env": policy.key_env,
                    "token_state_path": normalize_rel(token_state_path.to_string_lossy()),
                    "token_state": read_json_or(&token_state_path, Value::Null),
                    "attestation_path": normalize_rel(attestation_path.to_string_lossy()),
                    "attestation_count": rows.len(),
                    "latest_attestation": rows.last().cloned().unwrap_or(Value::Null)
                }),
                0,
            )
        }
        _ => (
            json!({
                "ok": false,
                "type": "soul_token_guard",
                "error": "unknown_command",
                "usage": [
                    "soul-token-guard issue [--instance-id=<id>] [--approval-note=<text>]",
                    "soul-token-guard stamp-build --build-id=<id> [--channel=<name>] [--valid-hours=<n>]",
                    "soul-token-guard verify [--strict=1]",
                    "soul-token-guard status"
                ]
            }),
            2,
        ),
    }
}
