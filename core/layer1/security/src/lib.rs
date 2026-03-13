// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer1/security (authoritative)

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use walkdir::WalkDir;

type HmacSha256 = Hmac<Sha256>;

mod security_planes;
mod security_wave1;

pub use security_planes::{
    run_anti_sabotage_shield, run_constitution_guardian, run_guard, run_remote_emergency_halt,
    run_soul_token_guard,
};
pub use security_wave1::{
    run_abac_policy_plane, run_black_box_ledger, run_capability_switchboard,
    run_directive_hierarchy_controller, run_dream_warden_guard, run_goal_preservation_kernel,
    run_truth_seeking_gate,
};

#[derive(Debug, Clone, Default)]
pub struct ParsedArgs {
    pub positional: Vec<String>,
    pub flags: HashMap<String, String>,
}

pub fn parse_args(raw: &[String]) -> ParsedArgs {
    let mut out = ParsedArgs::default();
    for token in raw {
        if !token.starts_with("--") {
            out.positional.push(token.clone());
            continue;
        }
        match token.split_once('=') {
            Some((k, v)) => {
                out.flags
                    .insert(k.trim_start_matches("--").to_string(), v.to_string());
            }
            None => {
                out.flags.insert(
                    token.trim_start_matches("--").to_string(),
                    "true".to_string(),
                );
            }
        }
    }
    out
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

fn state_root(repo_root: &Path) -> PathBuf {
    if let Ok(v) = std::env::var("PROTHEUS_SECURITY_STATE_ROOT") {
        let t = v.trim();
        if !t.is_empty() {
            return PathBuf::from(t);
        }
    }
    repo_root.join("client").join("local").join("state")
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

fn hmac_sha256_hex(secret: &str, payload: &str) -> Result<String, String> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|err| format!("hmac_key_invalid:{err}"))?;
    mac.update(payload.as_bytes());
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct IntegrityPolicy {
    version: String,
    target_roots: Vec<String>,
    target_extensions: Vec<String>,
    protected_files: Vec<String>,
    exclude_paths: Vec<String>,
    hashes: BTreeMap<String, String>,
}

impl Default for IntegrityPolicy {
    fn default() -> Self {
        Self {
            version: "1.0".to_string(),
            target_roots: vec![
                "systems/security".to_string(),
                "config/directives".to_string(),
            ],
            target_extensions: vec![".js".to_string(), ".yaml".to_string(), ".yml".to_string()],
            protected_files: vec!["lib/directive_resolver.js".to_string()],
            exclude_paths: Vec::new(),
            hashes: BTreeMap::new(),
        }
    }
}

fn normalize_integrity_policy(raw: IntegrityPolicy) -> IntegrityPolicy {
    let normalize_rows = |rows: Vec<String>| -> Vec<String> {
        let mut dedupe = BTreeSet::<String>::new();
        for row in rows {
            let clean_row = normalize_rel(row);
            if !clean_row.is_empty() {
                dedupe.insert(clean_row);
            }
        }
        dedupe.into_iter().collect()
    };

    let mut normalized_hashes = BTreeMap::new();
    for (path, hash) in raw.hashes {
        let rel = normalize_rel(path);
        let digest = clean(hash, 200).to_ascii_lowercase();
        if rel.is_empty() || rel.starts_with("..") || digest.is_empty() {
            continue;
        }
        normalized_hashes.insert(rel, digest);
    }

    IntegrityPolicy {
        version: clean(raw.version, 40),
        target_roots: normalize_rows(raw.target_roots),
        target_extensions: normalize_rows(raw.target_extensions)
            .into_iter()
            .map(|v| v.to_ascii_lowercase())
            .collect(),
        protected_files: normalize_rows(raw.protected_files),
        exclude_paths: normalize_rows(raw.exclude_paths),
        hashes: normalized_hashes,
    }
}

fn load_integrity_policy(policy_path: &Path) -> IntegrityPolicy {
    let fallback = IntegrityPolicy::default();
    if !policy_path.exists() {
        return fallback;
    }
    let raw = match fs::read_to_string(policy_path) {
        Ok(v) => v,
        Err(_) => return fallback,
    };
    match serde_json::from_str::<IntegrityPolicy>(&raw) {
        Ok(parsed) => normalize_integrity_policy(parsed),
        Err(_) => fallback,
    }
}

fn integrity_path_match(rel: &str, rule: &str) -> bool {
    let clean_rule = normalize_rel(rule);
    if clean_rule.is_empty() {
        return false;
    }
    if let Some(prefix) = clean_rule.strip_suffix("/**") {
        return rel.starts_with(prefix);
    }
    rel == clean_rule
}

fn integrity_is_excluded(rel: &str, policy: &IntegrityPolicy) -> bool {
    policy
        .exclude_paths
        .iter()
        .any(|rule| integrity_path_match(rel, rule))
}

fn integrity_has_allowed_extension(rel: &str, policy: &IntegrityPolicy) -> bool {
    if policy.target_extensions.is_empty() {
        return true;
    }
    let ext = Path::new(rel)
        .extension()
        .map(|v| format!(".{}", v.to_string_lossy().to_ascii_lowercase()));
    match ext {
        Some(v) => policy.target_extensions.iter().any(|want| want == &v),
        None => false,
    }
}

fn collect_integrity_present_files(runtime_root: &Path, policy: &IntegrityPolicy) -> Vec<String> {
    let mut files = BTreeSet::<String>::new();
    for root_rel in &policy.target_roots {
        let abs = runtime_root.join(root_rel);
        if !abs.exists() {
            continue;
        }
        for entry in WalkDir::new(abs).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = normalize_rel(
                entry
                    .path()
                    .strip_prefix(runtime_root)
                    .unwrap_or(entry.path())
                    .to_string_lossy(),
            );
            if rel.is_empty() || rel.starts_with("..") {
                continue;
            }
            if integrity_is_excluded(&rel, policy) {
                continue;
            }
            if !integrity_has_allowed_extension(&rel, policy) {
                continue;
            }
            files.insert(rel);
        }
    }

    for rel in &policy.protected_files {
        let abs = runtime_root.join(rel);
        if abs.is_file() && !integrity_is_excluded(rel, policy) {
            files.insert(normalize_rel(rel));
        }
    }

    files.into_iter().collect()
}

fn summarize_violation_counts(violations: &[Value]) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::<String, u64>::new();
    for row in violations {
        let k = row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        *out.entry(k).or_insert(0) += 1;
    }
    out
}

fn verify_integrity_policy(repo_root: &Path, policy_path: &Path) -> Value {
    let runtime = runtime_root(repo_root);
    let policy = load_integrity_policy(policy_path);
    let present_files = collect_integrity_present_files(&runtime, &policy);
    let mut violations = Vec::<Value>::new();

    if policy.hashes.is_empty() {
        violations.push(json!({
            "type": "policy_unsealed",
            "file": Value::Null,
            "detail": "hashes_empty"
        }));
    }

    for (rel, expected) in &policy.hashes {
        let abs = runtime.join(rel);
        if !abs.exists() {
            violations.push(json!({"type":"missing_sealed_file","file":rel}));
            continue;
        }
        let digest = expected.to_ascii_lowercase();
        if digest.len() != 64 || !digest.chars().all(|ch| ch.is_ascii_hexdigit()) {
            violations.push(json!({"type":"invalid_hash_entry","file":rel,"expected":digest}));
            continue;
        }
        match sha256_hex_file(&abs) {
            Ok(actual) => {
                if actual != digest {
                    violations.push(
                        json!({"type":"hash_mismatch","file":rel,"expected":digest,"actual":actual}),
                    );
                }
            }
            Err(_) => violations.push(json!({"type":"read_failed","file":rel})),
        }
    }

    let expected_set = policy
        .hashes
        .keys()
        .map(|v| normalize_rel(v))
        .collect::<BTreeSet<_>>();
    let present_set = present_files
        .iter()
        .map(normalize_rel)
        .collect::<BTreeSet<_>>();

    for rel in &present_files {
        if !expected_set.contains(rel) {
            violations.push(json!({"type":"unsealed_file","file":rel}));
        }
    }

    for rel in expected_set {
        if !present_set.contains(&rel) {
            let already_missing = violations.iter().any(|row| {
                row.get("type").and_then(Value::as_str) == Some("missing_sealed_file")
                    && row.get("file").and_then(Value::as_str) == Some(rel.as_str())
            });
            if !already_missing {
                violations.push(json!({"type":"sealed_file_outside_scope","file":rel}));
            }
        }
    }

    let counts = summarize_violation_counts(&violations);
    json!({
        "ok": violations.is_empty(),
        "ts": now_iso(),
        "policy_path": policy_path.to_string_lossy(),
        "policy_version": policy.version,
        "checked_present_files": present_files.len(),
        "expected_files": policy.hashes.len(),
        "violations": violations,
        "violation_counts": counts
    })
}

fn git_changed_paths(repo_root: &Path, staged: bool) -> Vec<String> {
    let args = if staged {
        vec![
            "diff".to_string(),
            "--name-only".to_string(),
            "--cached".to_string(),
        ]
    } else {
        vec!["diff".to_string(), "--name-only".to_string()]
    };
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_root)
        .output();
    let Ok(out) = output else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(normalize_rel)
        .filter(|row| !row.is_empty())
        .map(|row| {
            row.strip_prefix("client/runtime/")
                .map(|v| v.to_string())
                .unwrap_or(row)
        })
        .collect::<Vec<_>>()
}

fn seal_integrity_policy(
    repo_root: &Path,
    policy_path: &Path,
    approval_note: Option<&str>,
    sealed_by: Option<&str>,
) -> Result<Value, String> {
    let runtime = runtime_root(repo_root);
    let mut policy = load_integrity_policy(policy_path);
    let present = collect_integrity_present_files(&runtime, &policy);
    let mut hashes = BTreeMap::<String, String>::new();
    for rel in &present {
        let digest = sha256_hex_file(&runtime.join(rel))?;
        hashes.insert(rel.clone(), digest);
    }

    policy.hashes = hashes;
    let mut out = serde_json::to_value(&policy)
        .map_err(|err| format!("encode_integrity_policy_failed:{err}"))?;
    let sealed_by_value = sealed_by
        .map(ToString::to_string)
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_else(|| "unknown".to_string());
    if let Some(obj) = out.as_object_mut() {
        obj.insert("sealed_at".to_string(), Value::String(now_iso()));
        obj.insert(
            "sealed_by".to_string(),
            Value::String(clean(sealed_by_value, 120)),
        );
        if let Some(note) = approval_note {
            let clean_note = clean(note, 240);
            if !clean_note.is_empty() {
                obj.insert("last_approval_note".to_string(), Value::String(clean_note));
            }
        }
    }
    write_json_atomic(policy_path, &out)?;

    Ok(json!({
        "ok": true,
        "policy_path": policy_path.to_string_lossy(),
        "policy_version": policy.version,
        "sealed_files": present.len(),
        "sealed_at": now_iso()
    }))
}

pub fn run_integrity_reseal(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "help".to_string());
    let policy_path = flag(&parsed, "policy")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            runtime_root(repo_root)
                .join("config")
                .join("security_integrity_policy.json")
        });

    match cmd.as_str() {
        "check" | "status" | "run" => {
            let staged = bool_flag(&parsed, "staged", true);
            let verify = verify_integrity_policy(repo_root, &policy_path);
            let protected_set = {
                let policy = load_integrity_policy(&policy_path);
                let present = collect_integrity_present_files(&runtime_root(repo_root), &policy);
                let expected = policy.hashes.keys().map(normalize_rel).collect::<Vec<_>>();
                present
                    .into_iter()
                    .chain(expected.into_iter())
                    .collect::<BTreeSet<_>>()
            };
            let changed = git_changed_paths(repo_root, staged)
                .into_iter()
                .filter(|row| protected_set.contains(row))
                .collect::<Vec<_>>();

            let ok = verify.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let out = json!({
                "ok": ok,
                "ts": now_iso(),
                "type": "integrity_reseal_check",
                "policy_path": policy_path.to_string_lossy(),
                "staged": staged,
                "protected_changes": changed,
                "reseal_required": !ok,
                "violation_counts": verify.get("violation_counts").cloned().unwrap_or_else(|| json!({})),
                "violations": verify
                    .get("violations")
                    .and_then(Value::as_array)
                    .map(|rows| rows.iter().take(12).cloned().collect::<Vec<_>>())
                    .unwrap_or_default()
            });
            let code = if ok { 0 } else { 1 };
            (out, code)
        }
        "apply" | "reseal" | "seal" => {
            let force = bool_flag(&parsed, "force", false);
            let note = flag(&parsed, "approval-note")
                .or_else(|| flag(&parsed, "approval_note"))
                .map(ToString::to_string)
                .or_else(|| std::env::var("INTEGRITY_RESEAL_NOTE").ok())
                .unwrap_or_default();
            let verify_before = verify_integrity_policy(repo_root, &policy_path);
            let already_ok = verify_before
                .get("ok")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if already_ok && !force {
                return (
                    json!({
                        "ok": true,
                        "ts": now_iso(),
                        "type": "integrity_reseal_apply",
                        "policy_path": policy_path.to_string_lossy(),
                        "applied": false,
                        "reason": "already_sealed"
                    }),
                    0,
                );
            }
            if clean(&note, 500).len() < 10 {
                return (
                    json!({
                        "ok": false,
                        "type": "integrity_reseal_apply",
                        "error": "approval_note_too_short",
                        "min_len": 10
                    }),
                    2,
                );
            }
            match seal_integrity_policy(
                repo_root,
                &policy_path,
                Some(&note),
                std::env::var("USER").ok().as_deref(),
            ) {
                Ok(seal) => {
                    let verify_after = verify_integrity_policy(repo_root, &policy_path);
                    let ok = verify_after
                        .get("ok")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    (
                        json!({
                            "ok": ok,
                            "ts": now_iso(),
                            "type": "integrity_reseal_apply",
                            "policy_path": policy_path.to_string_lossy(),
                            "applied": true,
                            "seal": seal,
                            "verify": {
                                "ok": ok,
                                "violation_counts": verify_after.get("violation_counts").cloned().unwrap_or_else(|| json!({})),
                                "violations": verify_after
                                    .get("violations")
                                    .and_then(Value::as_array)
                                    .map(|rows| rows.iter().take(12).cloned().collect::<Vec<_>>())
                                    .unwrap_or_default()
                            }
                        }),
                        if ok { 0 } else { 1 },
                    )
                }
                Err(err) => (
                    json!({
                        "ok": false,
                        "type": "integrity_reseal_apply",
                        "error": clean(err, 220)
                    }),
                    1,
                ),
            }
        }
        _ => (
            json!({
                "ok": false,
                "type": "integrity_reseal",
                "error": "unknown_command",
                "usage": [
                    "integrity-reseal check [--policy=<path>] [--staged=1|0]",
                    "integrity-reseal apply [--policy=<path>] [--approval-note=<text>] [--force=1]"
                ]
            }),
            2,
        ),
    }
}

pub fn run_integrity_reseal_assistant(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "help".to_string());
    match cmd.as_str() {
        "run" => {
            let mut check_args = vec!["check".to_string(), "--staged=0".to_string()];
            if let Some(policy) = flag(&parsed, "policy") {
                check_args.push(format!("--policy={policy}"));
            }
            let (check_out, _) = run_integrity_reseal(repo_root, &check_args);
            let reseal_required = !check_out
                .get("ok")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || check_out
                    .get("reseal_required")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            let apply = bool_flag(&parsed, "apply", true);
            let strict = bool_flag(&parsed, "strict", false);
            let mut applied = false;
            let mut apply_result = Value::Null;
            let mut ok = true;
            if reseal_required && apply {
                let auto_note = {
                    let violations = check_out
                        .get("violations")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let files = violations
                        .iter()
                        .filter_map(|row| row.get("file").and_then(Value::as_str))
                        .map(|v| clean(v, 120))
                        .filter(|v| !v.is_empty())
                        .take(8)
                        .collect::<Vec<_>>();
                    let focus = if files.is_empty() {
                        "files=none".to_string()
                    } else {
                        format!("files={}", files.join(","))
                    };
                    format!(
                        "Automated integrity reseal assistant run ({focus}) at {}",
                        now_iso()
                    )
                };
                let note = flag(&parsed, "note")
                    .map(ToString::to_string)
                    .unwrap_or(auto_note);
                let mut apply_args = vec!["apply".to_string(), format!("--approval-note={note}")];
                if let Some(policy) = flag(&parsed, "policy") {
                    apply_args.push(format!("--policy={policy}"));
                }
                let (apply_out, apply_code) = run_integrity_reseal(repo_root, &apply_args);
                applied = true;
                apply_result = apply_out.clone();
                ok = apply_code == 0;
            }
            let out = json!({
                "ok": ok,
                "type": "integrity_reseal_assistant",
                "ts": now_iso(),
                "apply": apply,
                "strict": strict,
                "policy": flag(&parsed, "policy"),
                "reseal_required": reseal_required,
                "check": check_out,
                "applied": applied,
                "apply_result": if applied { apply_result } else { Value::Null }
            });
            let code = if strict && !ok {
                1
            } else if ok {
                0
            } else {
                1
            };
            (out, code)
        }
        "status" => {
            let mut args = vec!["check".to_string()];
            if let Some(policy) = flag(&parsed, "policy") {
                args.push(format!("--policy={policy}"));
            }
            let (check_out, code) = run_integrity_reseal(repo_root, &args);
            let ok = code == 0;
            (
                json!({
                    "ok": ok,
                    "type": "integrity_reseal_assistant_status",
                    "ts": now_iso(),
                    "reseal_required": !ok || check_out.get("reseal_required").and_then(Value::as_bool).unwrap_or(false),
                    "check": check_out
                }),
                if ok { 0 } else { 1 },
            )
        }
        _ => (
            json!({
                "ok": false,
                "type": "integrity_reseal_assistant",
                "error": "unknown_command",
                "usage": [
                    "integrity-reseal-assistant run [--apply=1|0] [--policy=<path>] [--note=<text>] [--strict=1|0]",
                    "integrity-reseal-assistant status [--policy=<path>]"
                ]
            }),
            2,
        ),
    }
}

fn emergency_stop_state_path(repo_root: &Path) -> PathBuf {
    runtime_root(repo_root)
        .join("state")
        .join("security")
        .join("emergency_stop.json")
}

fn emergency_stop_valid_scopes() -> Vec<&'static str> {
    vec!["all", "autonomy", "routing", "actuation", "spine"]
}

fn emergency_stop_normalize_scopes(raw: Option<&str>) -> Vec<String> {
    let valid = emergency_stop_valid_scopes();
    let mut out = Vec::<String>::new();
    let input = raw.unwrap_or("all");
    for seg in input.split(',') {
        let scope = clean(seg, 64).to_ascii_lowercase();
        if scope.is_empty() {
            continue;
        }
        if !valid.iter().any(|row| *row == scope) {
            continue;
        }
        if !out.iter().any(|row| row == &scope) {
            out.push(scope);
        }
    }
    if out.is_empty() {
        out.push("all".to_string());
    }
    if out.iter().any(|row| row == "all") {
        return vec!["all".to_string()];
    }
    out.sort();
    out
}

fn emergency_stop_state_default() -> Value {
    json!({
        "engaged": false,
        "scopes": [],
        "updated_at": Value::Null,
        "reason": Value::Null,
        "actor": Value::Null,
        "approval_note": Value::Null
    })
}

fn emergency_stop_load_state(repo_root: &Path) -> Value {
    let path = emergency_stop_state_path(repo_root);
    let raw = read_json_or(&path, emergency_stop_state_default());
    let engaged = raw.get("engaged").and_then(Value::as_bool).unwrap_or(false);
    let scopes = if engaged {
        emergency_stop_normalize_scopes(
            raw.get("scopes")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .as_deref(),
        )
    } else {
        Vec::new()
    };
    json!({
        "engaged": engaged,
        "scopes": scopes,
        "updated_at": raw.get("updated_at").cloned().unwrap_or(Value::Null),
        "reason": raw.get("reason").cloned().unwrap_or(Value::Null),
        "actor": raw.get("actor").cloned().unwrap_or(Value::Null),
        "approval_note": raw.get("approval_note").cloned().unwrap_or(Value::Null)
    })
}

pub fn run_emergency_stop(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "help".to_string());
    let state_path = emergency_stop_state_path(repo_root);

    match cmd.as_str() {
        "status" => (
            json!({
                "ok": true,
                "type": "emergency_stop_status",
                "ts": now_iso(),
                "state": emergency_stop_load_state(repo_root)
            }),
            0,
        ),
        "engage" => {
            let note = flag(&parsed, "approval-note")
                .or_else(|| flag(&parsed, "approval_note"))
                .map(|v| clean(v, 240))
                .unwrap_or_default();
            if note.len() < 10 {
                return (
                    json!({
                        "ok": false,
                        "error": "approval_note_too_short",
                        "min_len": 10
                    }),
                    2,
                );
            }

            let scopes = emergency_stop_normalize_scopes(flag(&parsed, "scope"));
            let reason = flag(&parsed, "reason")
                .map(|v| clean(v, 240))
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "manual_emergency_stop".to_string());
            let actor = flag(&parsed, "actor")
                .map(|v| clean(v, 120))
                .filter(|v| !v.is_empty())
                .or_else(|| std::env::var("USER").ok())
                .unwrap_or_else(|| "unknown".to_string());
            let next = json!({
                "engaged": true,
                "scopes": scopes,
                "updated_at": now_iso(),
                "reason": reason,
                "actor": actor,
                "approval_note": note
            });
            if let Err(err) = write_json_atomic(&state_path, &next) {
                return (
                    json!({
                        "ok": false,
                        "error": clean(err, 220)
                    }),
                    1,
                );
            }
            (
                json!({
                    "ok": true,
                    "result": "engaged",
                    "ts": now_iso(),
                    "valid_scopes": emergency_stop_valid_scopes(),
                    "state": next
                }),
                0,
            )
        }
        "release" => {
            let note = flag(&parsed, "approval-note")
                .or_else(|| flag(&parsed, "approval_note"))
                .map(|v| clean(v, 240))
                .unwrap_or_default();
            if note.len() < 10 {
                return (
                    json!({
                        "ok": false,
                        "error": "approval_note_too_short",
                        "min_len": 10
                    }),
                    2,
                );
            }

            let reason = flag(&parsed, "reason")
                .map(|v| clean(v, 240))
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "manual_release".to_string());
            let actor = flag(&parsed, "actor")
                .map(|v| clean(v, 120))
                .filter(|v| !v.is_empty())
                .or_else(|| std::env::var("USER").ok())
                .unwrap_or_else(|| "unknown".to_string());
            let next = json!({
                "engaged": false,
                "scopes": [],
                "updated_at": now_iso(),
                "reason": reason,
                "actor": actor,
                "approval_note": note
            });
            if let Err(err) = write_json_atomic(&state_path, &next) {
                return (
                    json!({
                        "ok": false,
                        "error": clean(err, 220)
                    }),
                    1,
                );
            }
            (
                json!({
                    "ok": true,
                    "result": "released",
                    "ts": now_iso(),
                    "state": next
                }),
                0,
            )
        }
        _ => (
            json!({
                "ok": false,
                "error": "unknown_command",
                "usage": [
                    "emergency-stop status",
                    "emergency-stop engage --scope=<all|autonomy|routing|actuation|spine[,..]> --approval-note=<text>",
                    "emergency-stop release --approval-note=<text>"
                ]
            }),
            2,
        ),
    }
}

pub fn run_integrity_kernel(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "help".to_string());
    let policy = flag(&parsed, "policy").map(ToString::to_string);

    match cmd.as_str() {
        "run" | "status" => {
            let mut args = vec!["check".to_string()];
            if let Some(policy_path) = policy {
                args.push(format!("--policy={policy_path}"));
            }
            let (check, code) = run_integrity_reseal(repo_root, &args);
            (
                json!({
                    "ok": code == 0,
                    "type": "integrity_kernel_status",
                    "ts": now_iso(),
                    "kernel": check
                }),
                code,
            )
        }
        "seal" => {
            let note = flag(&parsed, "approval-note")
                .or_else(|| flag(&parsed, "approval_note"))
                .map(ToString::to_string)
                .unwrap_or_default();
            let mut args = vec![
                "apply".to_string(),
                format!("--approval-note={}", clean(note, 240)),
            ];
            if let Some(policy_path) = policy {
                args.push(format!("--policy={policy_path}"));
            }
            let (apply, code) = run_integrity_reseal(repo_root, &args);
            (
                json!({
                    "ok": code == 0,
                    "type": "integrity_kernel_seal",
                    "ts": now_iso(),
                    "kernel": apply
                }),
                code,
            )
        }
        _ => (
            json!({
                "ok": false,
                "error": "unknown_command",
                "usage": [
                    "integrity-kernel run [--policy=<path>]",
                    "integrity-kernel status [--policy=<path>]",
                    "integrity-kernel seal --approval-note=<text> [--policy=<path>]"
                ]
            }),
            2,
        ),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct LeaseState {
    version: String,
    issued: BTreeMap<String, Value>,
    consumed: BTreeMap<String, Value>,
}

impl Default for LeaseState {
    fn default() -> Self {
        Self {
            version: "1.0".to_string(),
            issued: BTreeMap::new(),
            consumed: BTreeMap::new(),
        }
    }
}

fn lease_state_path(repo_root: &Path) -> PathBuf {
    std::env::var("CAPABILITY_LEASE_STATE_PATH")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            state_root(repo_root)
                .join("security")
                .join("capability_leases.json")
        })
}

fn lease_audit_path(repo_root: &Path) -> PathBuf {
    std::env::var("CAPABILITY_LEASE_AUDIT_PATH")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            state_root(repo_root)
                .join("security")
                .join("capability_leases.jsonl")
        })
}

fn lease_key() -> Option<String> {
    std::env::var("CAPABILITY_LEASE_KEY")
        .ok()
        .map(|v| clean(v, 4096))
        .filter(|v| !v.is_empty())
}

fn load_lease_state(path: &Path) -> LeaseState {
    if !path.exists() {
        return LeaseState::default();
    }
    let raw = match fs::read_to_string(path) {
        Ok(v) => v,
        Err(_) => return LeaseState::default(),
    };
    serde_json::from_str::<LeaseState>(&raw).unwrap_or_default()
}

fn save_lease_state(path: &Path, state: &LeaseState) -> Result<(), String> {
    let payload =
        serde_json::to_value(state).map_err(|err| format!("encode_lease_state_failed:{err}"))?;
    write_json_atomic(path, &payload)
}

fn lease_sign(body: &str, key: &str) -> Result<String, String> {
    hmac_sha256_hex(key, body)
}

fn lease_make_id(scope: &str, target: Option<&str>) -> String {
    let seed = format!(
        "{}|{}|{}|{}",
        now_iso(),
        scope,
        target.unwrap_or("none"),
        std::process::id()
    );
    let digest = sha256_hex_bytes(seed.as_bytes());
    format!("lease_{}", &digest[..16])
}

fn lease_pack_token(payload: &Value, key: &str) -> Result<String, String> {
    let body = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(payload).map_err(|err| format!("encode_lease_payload_failed:{err}"))?,
    );
    let sig = lease_sign(&body, key)?;
    Ok(format!("{body}.{sig}"))
}

fn lease_unpack_token(token: &str) -> Result<(String, String, Value), String> {
    let mut parts = token.trim().split('.');
    let body = parts.next().unwrap_or_default().to_string();
    let sig = parts.next().unwrap_or_default().to_string();
    if body.is_empty() || sig.is_empty() || parts.next().is_some() {
        return Err("token_malformed".to_string());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(body.as_bytes())
        .map_err(|_| "token_payload_invalid".to_string())?;
    let payload =
        serde_json::from_slice::<Value>(&bytes).map_err(|_| "token_payload_invalid".to_string())?;
    if !payload.is_object() {
        return Err("token_payload_invalid".to_string());
    }
    Ok((body, sig, payload))
}

pub fn run_capability_lease(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "help".to_string());
    let Some(key) = lease_key() else {
        return (
            json!({
                "ok": false,
                "error": "capability_lease_key_missing"
            }),
            1,
        );
    };
    let state_path = lease_state_path(repo_root);
    let audit_path = lease_audit_path(repo_root);
    let min_ttl = std::env::var("CAPABILITY_LEASE_MIN_TTL_SEC")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(30);
    let max_ttl = std::env::var("CAPABILITY_LEASE_MAX_TTL_SEC")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(3600);
    let default_ttl = std::env::var("CAPABILITY_LEASE_DEFAULT_TTL_SEC")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(300);

    match cmd.as_str() {
        "issue" => {
            let scope = clean(flag(&parsed, "scope").unwrap_or(""), 180);
            if scope.is_empty() {
                return (json!({"ok":false,"error":"scope_required"}), 1);
            }
            let target = flag(&parsed, "target")
                .map(|v| clean(v, 240))
                .filter(|v| !v.is_empty());
            let issued_by = clean(
                flag(&parsed, "issued-by")
                    .or_else(|| flag(&parsed, "issued_by"))
                    .unwrap_or("unknown"),
                120,
            );
            let reason = flag(&parsed, "reason")
                .map(|v| clean(v, 240))
                .filter(|v| !v.is_empty());
            let ttl_raw = flag(&parsed, "ttl-sec")
                .or_else(|| flag(&parsed, "ttl_sec"))
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(default_ttl)
                .clamp(min_ttl, max_ttl);
            let issued_at_ms = Utc::now().timestamp_millis();
            let expires_at_ms = issued_at_ms + ttl_raw * 1000;
            let payload = json!({
                "v": "1.0",
                "id": lease_make_id(&scope, target.as_deref()),
                "scope": scope,
                "target": target,
                "issued_at_ms": issued_at_ms,
                "issued_at": now_iso(),
                "expires_at_ms": expires_at_ms,
                "expires_at": chrono::DateTime::<Utc>::from_timestamp_millis(expires_at_ms)
                    .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
                    .unwrap_or_else(now_iso),
                "issued_by": issued_by,
                "reason": reason,
                "nonce": &sha256_hex_bytes(format!("{}:{}", issued_at_ms, std::process::id()).as_bytes())[..16]
            });
            let token = match lease_pack_token(&payload, &key) {
                Ok(v) => v,
                Err(err) => return (json!({"ok":false,"error":clean(err,220)}), 1),
            };
            let id = payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("lease_unknown")
                .to_string();
            let mut state = load_lease_state(&state_path);
            state.issued.insert(
                id.clone(),
                json!({
                    "id": id,
                    "scope": payload.get("scope").cloned().unwrap_or(Value::Null),
                    "target": payload.get("target").cloned().unwrap_or(Value::Null),
                    "issued_at": payload.get("issued_at").cloned().unwrap_or(Value::Null),
                    "expires_at": payload.get("expires_at").cloned().unwrap_or(Value::Null),
                    "issued_by": payload.get("issued_by").cloned().unwrap_or(Value::Null),
                    "reason": payload.get("reason").cloned().unwrap_or(Value::Null)
                }),
            );
            if let Err(err) = save_lease_state(&state_path, &state) {
                return (json!({"ok":false,"error":clean(err,220)}), 1);
            }
            let _ = append_jsonl(
                &audit_path,
                &json!({
                    "ts": now_iso(),
                    "type": "capability_lease_issued",
                    "lease_id": id,
                    "scope": payload.get("scope").cloned().unwrap_or(Value::Null),
                    "target": payload.get("target").cloned().unwrap_or(Value::Null),
                    "ttl_sec": ttl_raw,
                    "issued_by": payload.get("issued_by").cloned().unwrap_or(Value::Null)
                }),
            );
            (
                json!({
                    "ok": true,
                    "lease_id": payload.get("id").cloned().unwrap_or(Value::Null),
                    "scope": payload.get("scope").cloned().unwrap_or(Value::Null),
                    "target": payload.get("target").cloned().unwrap_or(Value::Null),
                    "expires_at": payload.get("expires_at").cloned().unwrap_or(Value::Null),
                    "ttl_sec": ttl_raw,
                    "token": token,
                    "lease_state_path": state_path.to_string_lossy(),
                    "lease_audit_path": audit_path.to_string_lossy()
                }),
                0,
            )
        }
        "verify" | "consume" => {
            let token = clean(flag(&parsed, "token").unwrap_or(""), 16_384);
            if token.is_empty() {
                return (json!({"ok":false,"error":"token_required"}), 1);
            }
            let (body, sig, payload) = match lease_unpack_token(&token) {
                Ok(v) => v,
                Err(err) => return (json!({"ok":false,"error":err}), 1),
            };
            let expected = match lease_sign(&body, &key) {
                Ok(v) => v,
                Err(err) => return (json!({"ok":false,"error":clean(err,220)}), 1),
            };
            if !secure_eq_hex(&sig, &expected) {
                return (json!({"ok":false,"error":"token_signature_invalid"}), 1);
            }

            let lease_id = clean(payload.get("id").and_then(Value::as_str).unwrap_or(""), 120);
            if lease_id.is_empty() {
                return (json!({"ok":false,"error":"token_missing_id"}), 1);
            }
            let lease_scope = clean(
                payload.get("scope").and_then(Value::as_str).unwrap_or(""),
                180,
            );
            let lease_target = payload
                .get("target")
                .and_then(Value::as_str)
                .map(|v| clean(v, 240))
                .filter(|v| !v.is_empty());
            let expires_at_ms = payload
                .get("expires_at_ms")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let now_ms = Utc::now().timestamp_millis();
            if expires_at_ms <= now_ms {
                return (
                    json!({
                        "ok": false,
                        "error": "lease_expired",
                        "lease_id": lease_id,
                        "expires_at": payload.get("expires_at").cloned().unwrap_or(Value::Null)
                    }),
                    1,
                );
            }
            if let Some(want_scope) = flag(&parsed, "scope") {
                if clean(want_scope, 180) != lease_scope {
                    return (
                        json!({
                            "ok": false,
                            "error": "scope_mismatch",
                            "lease_scope": lease_scope,
                            "required_scope": clean(want_scope,180),
                            "lease_id": lease_id
                        }),
                        1,
                    );
                }
            }
            if let Some(want_target) = flag(&parsed, "target") {
                let clean_target = clean(want_target, 240);
                if !clean_target.is_empty()
                    && lease_target.as_deref().unwrap_or_default() != clean_target
                {
                    return (
                        json!({
                            "ok": false,
                            "error": "target_mismatch",
                            "lease_target": lease_target,
                            "required_target": clean_target,
                            "lease_id": lease_id
                        }),
                        1,
                    );
                }
            }

            let mut state = load_lease_state(&state_path);
            if state.consumed.contains_key(&lease_id) {
                return (
                    json!({
                        "ok": false,
                        "error": "lease_already_consumed",
                        "lease_id": lease_id,
                        "consumed_at": state.consumed.get(&lease_id).and_then(|v| v.get("ts")).cloned().unwrap_or(Value::Null)
                    }),
                    1,
                );
            }
            if !state.issued.contains_key(&lease_id) {
                return (
                    json!({"ok":false,"error":"lease_unknown","lease_id":lease_id}),
                    1,
                );
            }

            let consume = cmd == "consume";
            if consume {
                let reason = clean(flag(&parsed, "reason").unwrap_or("consumed"), 180);
                state.consumed.insert(
                    lease_id.clone(),
                    json!({"ts": now_iso(), "reason": reason.clone()}),
                );
                if let Err(err) = save_lease_state(&state_path, &state) {
                    return (json!({"ok":false,"error":clean(err,220)}), 1);
                }
                let _ = append_jsonl(
                    &audit_path,
                    &json!({
                        "ts": now_iso(),
                        "type": "capability_lease_consumed",
                        "lease_id": lease_id,
                        "scope": lease_scope,
                        "target": lease_target,
                        "reason": reason
                    }),
                );
            }

            (
                json!({
                    "ok": true,
                    "lease_id": lease_id,
                    "scope": lease_scope,
                    "target": lease_target,
                    "expires_at": payload.get("expires_at").cloned().unwrap_or(Value::Null),
                    "consumed": consume
                }),
                0,
            )
        }
        _ => (
            json!({
                "ok": false,
                "error": "unknown_command",
                "usage": [
                    "capability-lease issue --scope=<scope> [--target=<target>] [--ttl-sec=<n>] [--issued-by=<id>] [--reason=<text>]",
                    "capability-lease verify --token=<token> [--scope=<scope>] [--target=<target>]",
                    "capability-lease consume --token=<token> [--scope=<scope>] [--target=<target>] [--reason=<text>]"
                ]
            }),
            2,
        ),
    }
}

fn startup_policy_path(repo_root: &Path) -> PathBuf {
    std::env::var("STARTUP_ATTESTATION_POLICY_PATH")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            runtime_root(repo_root)
                .join("config")
                .join("startup_attestation_policy.json")
        })
}

fn startup_state_path(repo_root: &Path) -> PathBuf {
    std::env::var("STARTUP_ATTESTATION_STATE_PATH")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            state_root(repo_root)
                .join("security")
                .join("startup_attestation.json")
        })
}

fn startup_audit_path(repo_root: &Path) -> PathBuf {
    std::env::var("STARTUP_ATTESTATION_AUDIT_PATH")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            state_root(repo_root)
                .join("security")
                .join("startup_attestation_audit.jsonl")
        })
}

fn startup_secret_candidates(repo_root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::<PathBuf>::new();
    if let Ok(v) = std::env::var("STARTUP_ATTESTATION_KEY_PATH") {
        let clean_v = clean(v, 520);
        if !clean_v.is_empty() {
            out.push(PathBuf::from(clean_v));
        }
    }
    if let Ok(v) = std::env::var("SECRET_BROKER_LOCAL_KEY_PATH") {
        let clean_v = clean(v, 520);
        if !clean_v.is_empty() {
            out.push(PathBuf::from(clean_v));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let base = PathBuf::from(home)
            .join(".config")
            .join("protheus")
            .join("secrets");
        out.push(base.join("startup_attestation_key.txt"));
        out.push(base.join("secret_broker_key.txt"));
    }
    out.push(
        state_root(repo_root)
            .join("security")
            .join("secret_broker_key.txt"),
    );
    out.push(
        runtime_root(repo_root)
            .join("state")
            .join("security")
            .join("secret_broker_key.txt"),
    );
    out
}

fn startup_resolve_secret(repo_root: &Path) -> Option<String> {
    if let Ok(v) = std::env::var("STARTUP_ATTESTATION_KEY") {
        let c = clean(v, 4096);
        if !c.is_empty() {
            return Some(c);
        }
    }
    if let Ok(v) = std::env::var("SECRET_BROKER_KEY") {
        let c = clean(v, 4096);
        if !c.is_empty() {
            return Some(c);
        }
    }
    for candidate in startup_secret_candidates(repo_root) {
        if !candidate.exists() {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&candidate) {
            let c = clean(raw, 4096);
            if !c.is_empty() {
                return Some(c);
            }
        }
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct StartupPolicy {
    version: String,
    ttl_hours: i64,
    critical_paths: Vec<String>,
}

impl Default for StartupPolicy {
    fn default() -> Self {
        Self {
            version: "1.0".to_string(),
            ttl_hours: 24,
            critical_paths: Vec::new(),
        }
    }
}

fn load_startup_policy(path: &Path) -> StartupPolicy {
    let mut policy = StartupPolicy::default();
    if path.exists() {
        if let Ok(raw) = fs::read_to_string(path) {
            if let Ok(parsed) = serde_json::from_str::<StartupPolicy>(&raw) {
                policy = parsed;
            }
        }
    }
    policy.version = clean(policy.version, 40);
    if policy.version.is_empty() {
        policy.version = "1.0".to_string();
    }
    policy.ttl_hours = policy.ttl_hours.clamp(1, 240);
    policy.critical_paths = policy
        .critical_paths
        .into_iter()
        .map(normalize_rel)
        .filter(|v| !v.is_empty() && !v.contains(".."))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    policy
}

fn startup_hash_critical_paths(
    repo_root: &Path,
    policy: &StartupPolicy,
) -> (Vec<Value>, Vec<String>) {
    let runtime = runtime_root(repo_root);
    let mut rows = Vec::<Value>::new();
    let mut missing = Vec::<String>::new();
    for rel in &policy.critical_paths {
        let abs = runtime.join(rel);
        if !abs.exists() || !abs.is_file() {
            missing.push(rel.clone());
            continue;
        }
        match sha256_hex_file(&abs) {
            Ok(digest) => {
                let size_bytes = fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
                rows.push(json!({"path": rel, "sha256": digest, "size_bytes": size_bytes}));
            }
            Err(_) => missing.push(rel.clone()),
        }
    }
    rows.sort_by(|a, b| {
        a.get("path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("path").and_then(Value::as_str).unwrap_or(""))
    });
    missing.sort();
    (rows, missing)
}

pub fn run_startup_attestation(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "help".to_string());
    let strict = bool_flag(&parsed, "strict", false);
    let policy_path = startup_policy_path(repo_root);
    let state_path = startup_state_path(repo_root);
    let audit_path = startup_audit_path(repo_root);
    let policy = load_startup_policy(&policy_path);

    match cmd.as_str() {
        "issue" => {
            let Some(secret) = startup_resolve_secret(repo_root) else {
                let out = json!({"ok": false, "reason": "attestation_key_missing"});
                return (out, if strict { 1 } else { 0 });
            };
            let ttl_hours = flag(&parsed, "ttl-hours")
                .or_else(|| flag(&parsed, "ttl_hours"))
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(policy.ttl_hours)
                .clamp(1, 240);
            let ts = now_iso();
            let now_ms = Utc::now().timestamp_millis();
            let expires_at_ms = now_ms + ttl_hours * 3600 * 1000;
            let (critical_hashes, missing_paths) = startup_hash_critical_paths(repo_root, &policy);
            let mut payload = Map::<String, Value>::new();
            payload.insert(
                "type".to_string(),
                Value::String("startup_attestation".to_string()),
            );
            payload.insert("version".to_string(), Value::String(policy.version.clone()));
            payload.insert("ts".to_string(), Value::String(ts.clone()));
            payload.insert(
                "expires_at".to_string(),
                Value::String(
                    chrono::DateTime::<Utc>::from_timestamp_millis(expires_at_ms)
                        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
                        .unwrap_or_else(now_iso),
                ),
            );
            payload.insert("ttl_hours".to_string(), Value::Number(ttl_hours.into()));
            let policy_rel = policy_path
                .strip_prefix(runtime_root(repo_root))
                .unwrap_or(&policy_path)
                .to_string_lossy()
                .replace('\\', "/");
            payload.insert("policy_path".to_string(), Value::String(policy_rel));
            payload.insert(
                "critical_hashes".to_string(),
                Value::Array(critical_hashes.clone()),
            );
            payload.insert(
                "missing_paths".to_string(),
                Value::Array(
                    missing_paths
                        .iter()
                        .map(|v| Value::String(v.clone()))
                        .collect(),
                ),
            );
            let payload_value = Value::Object(payload.clone());
            let signature = match hmac_sha256_hex(&secret, &stable_json_string(&payload_value)) {
                Ok(v) => v,
                Err(err) => return (json!({"ok":false,"error":clean(err,220)}), 1),
            };
            payload.insert("signature".to_string(), Value::String(signature));
            let signed = Value::Object(payload);
            if let Err(err) = write_json_atomic(&state_path, &signed) {
                return (json!({"ok":false,"error":clean(err,220)}), 1);
            }
            let _ = append_jsonl(
                &audit_path,
                &json!({
                    "ts": now_iso(),
                    "type": "startup_attestation_issue",
                    "ok": true,
                    "expires_at": signed.get("expires_at").cloned().unwrap_or(Value::Null),
                    "hashes": critical_hashes.len(),
                    "missing_paths": missing_paths.len()
                }),
            );
            (
                json!({
                    "ok": true,
                    "type": "startup_attestation_issue",
                    "ts": ts,
                    "expires_at": signed.get("expires_at").cloned().unwrap_or(Value::Null),
                    "hashes": critical_hashes.len(),
                    "missing_paths": missing_paths
                }),
                0,
            )
        }
        "verify" | "run" | "check" => {
            let secret = startup_resolve_secret(repo_root);
            let state = read_json_or(&state_path, Value::Null);
            let mut ok = true;
            let mut reason = "verified".to_string();
            let mut drift = Value::Null;
            let mut expires_at = state.get("expires_at").cloned().unwrap_or(Value::Null);

            if !state.is_object()
                || state.get("type").and_then(Value::as_str) != Some("startup_attestation")
            {
                ok = false;
                reason = "attestation_missing_or_invalid".to_string();
            } else if secret.is_none() {
                ok = false;
                reason = "attestation_key_missing".to_string();
            } else {
                let exp = state
                    .get("expires_at")
                    .and_then(Value::as_str)
                    .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                    .map(|dt| dt.timestamp_millis())
                    .unwrap_or(0);
                if exp <= Utc::now().timestamp_millis() {
                    ok = false;
                    reason = "attestation_stale".to_string();
                } else {
                    let signature = clean(
                        state.get("signature").and_then(Value::as_str).unwrap_or(""),
                        240,
                    )
                    .to_ascii_lowercase();
                    if signature.is_empty() {
                        ok = false;
                        reason = "signature_missing".to_string();
                    } else {
                        let mut payload = state.clone();
                        if let Some(obj) = payload.as_object_mut() {
                            obj.remove("signature");
                        }
                        let expected = hmac_sha256_hex(
                            &secret.unwrap_or_default(),
                            &stable_json_string(&payload),
                        )
                        .unwrap_or_default();
                        if !secure_eq_hex(&signature, &expected) {
                            ok = false;
                            reason = "signature_mismatch".to_string();
                        } else {
                            let (current_rows, _) = startup_hash_critical_paths(repo_root, &policy);
                            let expected_rows = state
                                .get("critical_hashes")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default();
                            let mut expected_map = BTreeMap::<String, String>::new();
                            for row in expected_rows {
                                let p = row.get("path").and_then(Value::as_str).unwrap_or("");
                                let h = row.get("sha256").and_then(Value::as_str).unwrap_or("");
                                if !p.is_empty() && !h.is_empty() {
                                    expected_map.insert(p.to_string(), h.to_string());
                                }
                            }
                            let mut drift_rows = Vec::<Value>::new();
                            for row in &current_rows {
                                let p = row.get("path").and_then(Value::as_str).unwrap_or("");
                                let h = row.get("sha256").and_then(Value::as_str).unwrap_or("");
                                let prior = expected_map.get(p).cloned();
                                match prior {
                                    None => {
                                        drift_rows.push(json!({"path": p, "reason": "new_path"}))
                                    }
                                    Some(v) => {
                                        if v != h {
                                            drift_rows.push(
                                                json!({"path": p, "reason": "hash_mismatch"}),
                                            );
                                        }
                                    }
                                }
                            }
                            for p in expected_map.keys() {
                                if !current_rows.iter().any(|row| {
                                    row.get("path").and_then(Value::as_str) == Some(p.as_str())
                                }) {
                                    drift_rows.push(json!({"path": p, "reason": "missing_now"}));
                                }
                            }
                            if !drift_rows.is_empty() {
                                ok = false;
                                reason = "critical_hash_drift".to_string();
                                drift = Value::Array(drift_rows.into_iter().take(50).collect());
                            }
                        }
                    }
                }
            }
            let _ = append_jsonl(
                &audit_path,
                &json!({
                    "ts": now_iso(),
                    "type": "startup_attestation_verify",
                    "ok": ok,
                    "reason": reason
                }),
            );
            let out = json!({
                "ok": ok,
                "type": "startup_attestation_verify",
                "reason": reason,
                "expires_at": expires_at,
                "drift": drift
            });
            let code = if strict && !ok {
                1
            } else if ok {
                0
            } else {
                1
            };
            (out, code)
        }
        "status" => (
            json!({
                "ok": true,
                "type": "startup_attestation_status",
                "policy": policy,
                "state": read_json_or(&state_path, Value::Null),
                "state_path": state_path.to_string_lossy()
            }),
            0,
        ),
        _ => (
            json!({
                "ok": false,
                "error": "unknown_command",
                "usage": [
                    "startup-attestation issue [--ttl-hours=<n>] [--strict=1|0]",
                    "startup-attestation verify [--strict=1|0]",
                    "startup-attestation status"
                ]
            }),
            2,
        ),
    }
}
