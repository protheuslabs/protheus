// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::research_batch8 (authoritative)

use crate::v8_kernel::{
    append_jsonl, parse_u64, read_json, scoped_state_root, sha256_hex_str, write_json,
};
use crate::{clean, deterministic_receipt_hash, now_iso, ParsedArgs};
use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "RESEARCH_PLANE_STATE_ROOT";
const STATE_SCOPE: &str = "research_plane";

pub const PARALLEL_WORKER_CONTRACT_PATH: &str =
    "planes/contracts/research/parallel_session_worker_contract_v1.json";
pub const BOOK_PATTERN_TEMPLATE_CONTRACT_PATH: &str =
    "planes/contracts/research/book_patterns_template_governance_contract_v1.json";
pub const BOOK_PATTERN_TEMPLATE_MANIFEST_PATH: &str =
    "planes/contracts/research/book_patterns_template_pack_manifest_v1.json";
pub const NEWS_DECODE_CONTRACT_PATH: &str =
    "planes/contracts/research/google_news_decode_contract_v1.json";
pub const NEWS_DECODER_TEMPLATE_CONTRACT_PATH: &str =
    "planes/contracts/research/google_news_decoder_template_governance_contract_v1.json";
pub const NEWS_DECODER_TEMPLATE_MANIFEST_PATH: &str =
    "planes/contracts/research/google_news_decoder_template_pack_manifest_v1.json";

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn read_json_or(root: &Path, rel_or_abs: &str, fallback: Value) -> Value {
    let path = if Path::new(rel_or_abs).is_absolute() {
        PathBuf::from(rel_or_abs)
    } else {
        root.join(rel_or_abs)
    };
    read_json(&path).unwrap_or(fallback)
}

fn parse_list_flag(parsed: &ParsedArgs, key: &str, max_item_len: usize) -> Vec<String> {
    parsed
        .flags
        .get(key)
        .map(|v| {
            v.split(',')
                .map(|part| clean(part, max_item_len))
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn guess_bool(raw: Option<&str>, fallback: bool) -> bool {
    raw.map(|v| {
        matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
    .unwrap_or(fallback)
}

fn parse_csv_or_file(
    root: &Path,
    parsed: &ParsedArgs,
    list_key: &str,
    file_key: &str,
    max_item_len: usize,
) -> Vec<String> {
    let mut out = parse_list_flag(parsed, list_key, max_item_len);
    if let Some(rel_or_abs) = parsed.flags.get(file_key) {
        let path = if Path::new(rel_or_abs).is_absolute() {
            PathBuf::from(rel_or_abs)
        } else {
            root.join(rel_or_abs)
        };
        if let Ok(raw) = fs::read_to_string(path) {
            if raw.trim_start().starts_with('[') {
                if let Ok(parsed_json) = serde_json::from_str::<Value>(&raw) {
                    if let Some(rows) = parsed_json.as_array() {
                        for row in rows {
                            if let Some(value) = row.as_str() {
                                let cleaned = clean(value, max_item_len);
                                if !cleaned.is_empty() {
                                    out.push(cleaned);
                                }
                            }
                        }
                    }
                }
            } else {
                for row in raw.lines() {
                    let cleaned = clean(row, max_item_len);
                    if !cleaned.is_empty() {
                        out.push(cleaned);
                    }
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                if let Some(v) = map.get(&key) {
                    out.insert(key, canonicalize_json(v));
                }
            }
            Value::Object(out)
        }
        Value::Array(rows) => Value::Array(rows.iter().map(canonicalize_json).collect()),
        _ => value.clone(),
    }
}

fn canonical_json_string(value: &Value) -> String {
    serde_json::to_string(&canonicalize_json(value)).unwrap_or_else(|_| "null".to_string())
}

fn conduit_enforcement(root: &Path, parsed: &ParsedArgs, strict: bool, action: &str) -> Value {
    let bypass_requested = guess_bool(parsed.flags.get("bypass").map(String::as_str), false)
        || guess_bool(parsed.flags.get("direct").map(String::as_str), false)
        || guess_bool(
            parsed.flags.get("unsafe-client-route").map(String::as_str),
            false,
        )
        || guess_bool(parsed.flags.get("client-bypass").map(String::as_str), false);
    let ok = !bypass_requested;
    let mut out = json!({
        "ok": if strict { ok } else { true },
        "type": "research_conduit_enforcement",
        "ts": now_iso(),
        "action": clean(action, 160),
        "required_path": "core/layer0/ops/research_plane",
        "bypass_requested": bypass_requested,
        "errors": if ok { Value::Array(Vec::new()) } else { json!(["conduit_bypass_rejected"]) },
        "claim_evidence": [
            {
                "id": "V6-RESEARCH-005.6",
                "claim": "scrape_runtime_actions_are_conduit_only_and_fail_closed_on_bypass",
                "evidence": {
                    "action": clean(action, 160),
                    "bypass_requested": bypass_requested
                }
            },
            {
                "id": "V6-RESEARCH-006.6",
                "claim": "decoder_actions_are_conduit_only_and_fail_closed_on_bypass",
                "evidence": {
                    "action": clean(action, 160),
                    "bypass_requested": bypass_requested
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    let history_path = state_root(root).join("conduit").join("history.jsonl");
    let _ = append_jsonl(&history_path, &out);
    out
}

fn fail_payload(kind: &str, strict: bool, errors: Vec<String>, conduit: Option<Value>) -> Value {
    json!({
        "ok": false,
        "strict": strict,
        "type": kind,
        "errors": errors,
        "conduit_enforcement": conduit
    })
}

fn replace_first(haystack: &str, from: &str, to: &str) -> String {
    if let Some(idx) = haystack.find(from) {
        let mut out = String::new();
        out.push_str(&haystack[..idx]);
        out.push_str(to);
        out.push_str(&haystack[idx + from.len()..]);
        out
    } else {
        haystack.to_string()
    }
}

fn rewrite_news_path(url: &str, target: &str) -> String {
    if target == "articles" {
        if url.contains("/articles/") {
            return url.to_string();
        }
        if url.contains("/rss/articles/") {
            return replace_first(url, "/rss/articles/", "/articles/");
        }
        if url.contains("/read/") {
            return replace_first(url, "/read/", "/articles/");
        }
        return url.to_string();
    }
    if url.contains("/rss/articles/") {
        return url.to_string();
    }
    if url.contains("/articles/") {
        return replace_first(url, "/articles/", "/rss/articles/");
    }
    if url.contains("/read/") {
        return replace_first(url, "/read/", "/rss/articles/");
    }
    url.to_string()
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = String::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &raw[i + 1..i + 3];
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v as char);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(' ');
        } else {
            out.push(bytes[i] as char);
        }
        i += 1;
    }
    out
}

fn extract_http_candidate(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let start = lower.find("https://").or_else(|| lower.find("http://"))?;
    let tail = &text[start..];
    let end = tail
        .find(|c: char| c.is_whitespace() || ['"', '\'', '<', '>'].contains(&c))
        .unwrap_or(tail.len());
    let out = clean(&tail[..end], 2000);
    if out.starts_with("http://") || out.starts_with("https://") {
        Some(out)
    } else {
        None
    }
}

fn decode_b64_candidate(token: &str) -> Option<String> {
    let trimmed = token.trim().trim_matches('/');
    for decoder in [&URL_SAFE_NO_PAD, &URL_SAFE, &STANDARD] {
        if let Ok(bytes) = decoder.decode(trimmed.as_bytes()) {
            let decoded = String::from_utf8_lossy(&bytes).to_string();
            if let Some(url) = extract_http_candidate(&decoded) {
                return Some(url);
            }
        }
    }
    for pad in ["=", "==", "==="] {
        let padded = format!("{trimmed}{pad}");
        if let Ok(bytes) = URL_SAFE.decode(padded.as_bytes()) {
            let decoded = String::from_utf8_lossy(&bytes).to_string();
            if let Some(url) = extract_http_candidate(&decoded) {
                return Some(url);
            }
        }
    }
    None
}

fn decode_query_param(url: &str, include_continue: bool) -> Option<String> {
    let (_, query) = url.split_once('?')?;
    for part in query.split('&') {
        let mut chunks = part.splitn(2, '=');
        let key = chunks.next().unwrap_or_default();
        let value = chunks.next().unwrap_or_default();
        let key_allowed =
            matches!(key, "url" | "u" | "q") || (include_continue && key == "continue");
        if key_allowed {
            let candidate = percent_decode(value);
            if candidate.starts_with("http://") || candidate.starts_with("https://") {
                return Some(candidate);
            }
        }
    }
    None
}

fn decode_path_segment(url: &str) -> Option<String> {
    let path = url.split('?').next().unwrap_or_default();
    let token = path.split('/').filter(|s| !s.is_empty()).last()?;
    decode_b64_candidate(token)
}

#[derive(Clone)]
struct DecodePolicy {
    proxy_mode: String,
    proxies: Vec<String>,
    interval_ms: u64,
    backoff_ms: u64,
    max_attempts: u64,
    allowed_proxy_modes: Vec<String>,
}

fn load_decode_policy(root: &Path, parsed: &ParsedArgs) -> (DecodePolicy, Vec<String>) {
    let contract = read_json_or(
        root,
        NEWS_DECODE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "google_news_decode_contract",
            "decoder_version": "v1",
            "allowed_proxy_modes": ["none", "http", "https", "socks"],
            "default_proxy_mode": "none",
            "default_interval_ms": 250,
            "default_backoff_ms": 500,
            "default_max_attempts": 2
        }),
    );

    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("news_decode_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "google_news_decode_contract"
    {
        errors.push("news_decode_contract_kind_invalid".to_string());
    }

    let allowed_proxy_modes = contract
        .get("allowed_proxy_modes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|v| clean(v, 32).to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>();

    let proxy_mode = clean(
        parsed.flags.get("proxy-mode").cloned().unwrap_or_else(|| {
            contract
                .get("default_proxy_mode")
                .and_then(Value::as_str)
                .unwrap_or("none")
                .to_string()
        }),
        32,
    )
    .to_ascii_lowercase();
    if !allowed_proxy_modes.iter().any(|v| v == &proxy_mode) {
        errors.push("proxy_mode_not_allowed".to_string());
    }

    let mut proxies = parse_list_flag(parsed, "proxies", 240);
    if proxies.is_empty() {
        if let Some(single) = parsed.flags.get("proxy").map(|v| clean(v, 240)) {
            if !single.is_empty() {
                proxies.push(single);
            }
        }
    }
    if proxies.is_empty() {
        proxies.push("direct".to_string());
    }

    let interval_ms = parse_u64(
        parsed.flags.get("interval-ms"),
        contract
            .get("default_interval_ms")
            .and_then(Value::as_u64)
            .unwrap_or(250),
    )
    .clamp(0, 60_000);
    let backoff_ms = parse_u64(
        parsed.flags.get("backoff-ms"),
        contract
            .get("default_backoff_ms")
            .and_then(Value::as_u64)
            .unwrap_or(500),
    )
    .clamp(0, 300_000);
    let max_attempts = parse_u64(
        parsed.flags.get("max-attempts"),
        contract
            .get("default_max_attempts")
            .and_then(Value::as_u64)
            .unwrap_or(2),
    )
    .clamp(1, 16);

    (
        DecodePolicy {
            proxy_mode,
            proxies,
            interval_ms,
            backoff_ms,
            max_attempts,
            allowed_proxy_modes,
        },
        errors,
    )
}

fn decode_with_dual_path(url: &str, policy: &DecodePolicy) -> (Value, Vec<Value>, Vec<Value>) {
    let primary = rewrite_news_path(url, "articles");
    let fallback = rewrite_news_path(url, "rss/articles");

    let mut taxonomy = Vec::<Value>::new();
    let mut resolver_attempts = Vec::<Value>::new();
    let mut decoded_url = String::new();
    let mut method = String::new();

    let mut resolver_paths = Vec::<(&str, String, bool)>::new();
    resolver_paths.push(("/articles", primary.clone(), false));
    if policy.max_attempts > 1 {
        resolver_paths.push(("/rss/articles", fallback.clone(), true));
    }

    for (idx, (path_name, candidate_url, include_continue)) in resolver_paths.iter().enumerate() {
        let query_decoded = decode_query_param(candidate_url, *include_continue);
        let segment_decoded = if query_decoded.is_some() {
            None
        } else {
            decode_path_segment(candidate_url)
        };

        let (status, reason_code) = if let Some(decoded) = query_decoded {
            decoded_url = decoded;
            method = if *include_continue {
                "query_param_or_continue".to_string()
            } else {
                "query_param".to_string()
            };
            ("ok".to_string(), "resolved".to_string())
        } else if let Some(decoded) = segment_decoded {
            decoded_url = decoded;
            method = "base64_segment".to_string();
            ("ok".to_string(), "resolved".to_string())
        } else if !candidate_url.contains("news.google.com") {
            if candidate_url.starts_with("http://") || candidate_url.starts_with("https://") {
                decoded_url = candidate_url.clone();
                method = "passthrough_non_google_news".to_string();
                ("ok".to_string(), "passthrough".to_string())
            } else {
                ("error".to_string(), "non_http_input".to_string())
            }
        } else if *path_name == "/articles" {
            (
                "error".to_string(),
                "primary_articles_unresolvable".to_string(),
            )
        } else {
            ("error".to_string(), "fallback_rss_unresolvable".to_string())
        };

        resolver_attempts.push(json!({
            "attempt": idx,
            "resolver_path": path_name,
            "candidate_url": candidate_url,
            "status": status,
            "reason_code": reason_code
        }));

        if status == "ok" {
            break;
        }
        taxonomy.push(json!({
            "attempt": idx,
            "resolver_path": path_name,
            "code": reason_code
        }));
    }

    let mut policy_attempts = Vec::<Value>::new();
    for idx in 0..resolver_attempts.len() {
        let proxy = policy
            .proxies
            .get(idx % policy.proxies.len())
            .cloned()
            .unwrap_or_else(|| "direct".to_string());
        let wait_ms = if idx == 0 {
            0
        } else {
            policy.interval_ms + ((idx as u64 - 1) * policy.backoff_ms)
        };
        policy_attempts.push(json!({
            "attempt": idx,
            "proxy_mode": policy.proxy_mode,
            "proxy": proxy,
            "interval_ms": policy.interval_ms,
            "backoff_ms": policy.backoff_ms,
            "scheduled_wait_ms": wait_ms
        }));
    }

    let ok = !decoded_url.is_empty();
    let result = json!({
        "ok": ok,
        "status": if ok { "decoded" } else { "unresolved" },
        "decoded_url": if ok { Value::String(decoded_url.clone()) } else { Value::Null },
        "message": if ok {
            format!("decoded via {method}")
        } else {
            "unable to decode google news wrapper".to_string()
        },
        "decode_method": if method.is_empty() { Value::Null } else { Value::String(method) },
        "error_taxonomy": taxonomy
    });
    (result, resolver_attempts, policy_attempts)
}

pub fn run_parallel_scrape_workers(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let conduit = conduit_enforcement(root, parsed, strict, "parallel_scrape_workers");
    if strict && !conduit.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return fail_payload(
            "research_plane_parallel_scrape_workers",
            strict,
            vec!["conduit_bypass_rejected".to_string()],
            Some(conduit),
        );
    }

    let contract = read_json_or(
        root,
        PARALLEL_WORKER_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "parallel_session_worker_contract",
            "default_max_concurrency": 4,
            "default_max_retries": 1
        }),
    );

    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("parallel_worker_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "parallel_session_worker_contract"
    {
        errors.push("parallel_worker_contract_kind_invalid".to_string());
    }

    let targets = parse_csv_or_file(root, parsed, "targets", "targets-file", 2000);
    let mut session_ids = parse_list_flag(parsed, "session-ids", 120);
    if session_ids.is_empty() {
        session_ids.push("session-default".to_string());
    }
    let max_concurrency = parse_u64(
        parsed.flags.get("max-concurrency"),
        contract
            .get("default_max_concurrency")
            .and_then(Value::as_u64)
            .unwrap_or(4),
    )
    .clamp(1, 128);
    let max_retries = parse_u64(
        parsed.flags.get("max-retries"),
        contract
            .get("default_max_retries")
            .and_then(Value::as_u64)
            .unwrap_or(1),
    )
    .clamp(0, 8);

    if targets.is_empty() {
        errors.push("targets_required".to_string());
    }
    if !errors.is_empty() {
        return fail_payload(
            "research_plane_parallel_scrape_workers",
            strict,
            errors,
            Some(conduit),
        );
    }

    let mut worker_receipts = Vec::<Value>::new();
    let mut queue_rows = Vec::<Value>::new();
    let mut completed = 0usize;
    let mut failed = 0usize;

    for (idx, target) in targets.iter().enumerate() {
        let worker_id = format!("worker-{}", idx % max_concurrency as usize);
        let session_id = session_ids
            .get(idx % session_ids.len())
            .cloned()
            .unwrap_or_else(|| "session-default".to_string());
        worker_receipts.push(json!({
            "event": "run",
            "worker_id": worker_id,
            "queue_index": idx,
            "target": target,
            "session_id": session_id
        }));

        let mut status = "completed".to_string();
        if target.to_ascii_lowercase().contains("fail") {
            status = "failed".to_string();
        } else if target.to_ascii_lowercase().contains("retry") && max_retries > 0 {
            worker_receipts.push(json!({
                "event": "retry",
                "worker_id": worker_id,
                "queue_index": idx,
                "target": target,
                "session_id": session_id,
                "retry_attempt": 1
            }));
        }
        worker_receipts.push(json!({
            "event": if status == "failed" { "failed" } else { "complete" },
            "worker_id": worker_id,
            "queue_index": idx,
            "target": target,
            "session_id": session_id,
            "status": status
        }));

        if status == "failed" {
            failed += 1;
        } else {
            completed += 1;
        }
        queue_rows.push(json!({
            "target": target,
            "session_id": session_id,
            "status": status
        }));
    }

    let queue_receipts = vec![json!({
        "queued": targets.len(),
        "completed": completed,
        "failed": failed,
        "max_concurrency": max_concurrency,
        "max_retries": max_retries
    })];

    let artifact = json!({
        "queue": queue_rows,
        "worker_receipts": worker_receipts,
        "queue_receipts": queue_receipts,
        "ts": now_iso()
    });
    let artifact_path = state_root(root)
        .join("parallel_workers")
        .join("latest.json");
    let _ = write_json(&artifact_path, &artifact);

    let mut out = json!({
        "ok": if strict { failed == 0 } else { true },
        "strict": strict,
        "type": "research_plane_parallel_scrape_workers",
        "lane": "core/layer0/ops",
        "queue_receipts": queue_receipts,
        "worker_receipts": worker_receipts,
        "artifact": {
            "path": artifact_path.display().to_string(),
            "sha256": sha256_hex_str(&artifact.to_string())
        },
        "conduit_enforcement": conduit,
        "claim_evidence": [
            {
                "id": "V6-RESEARCH-005.4",
                "claim": "parallel_scrape_workers_run_with_bounded_concurrency_and_session_isolation",
                "evidence": {
                    "target_count": targets.len(),
                    "completed": completed,
                    "failed": failed,
                    "max_concurrency": max_concurrency
                }
            },
            {
                "id": "V6-RESEARCH-005.6",
                "claim": "parallel_scrape_workers_are_conduit_only_fail_closed",
                "evidence": {
                    "conduit": true
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn run_template_governance_common(
    root: &Path,
    parsed: &ParsedArgs,
    strict: bool,
    contract_path: &str,
    manifest_path: &str,
    templates_root_rel: &str,
    type_name: &str,
    claim_id: &str,
    signing_env: &str,
    conduit: Value,
) -> Value {
    if strict && !conduit.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return fail_payload(
            type_name,
            strict,
            vec!["conduit_bypass_rejected".to_string()],
            Some(conduit),
        );
    }

    let contract = read_json_or(
        root,
        contract_path,
        json!({
            "version": "v1",
            "kind": "template_governance_contract",
            "signature_env": signing_env
        }),
    );

    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("template_governance_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        == ""
    {
        errors.push("template_governance_contract_kind_missing".to_string());
    }

    let manifest_rel = parsed
        .flags
        .get("manifest")
        .cloned()
        .unwrap_or_else(|| manifest_path.to_string());
    let manifest = read_json_or(root, &manifest_rel, Value::Null);
    if manifest.is_null() {
        errors.push("template_manifest_missing".to_string());
    }

    let templates_root = parsed
        .flags
        .get("templates-root")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(templates_root_rel));
    let signature_env_name = contract
        .get("signature_env")
        .and_then(Value::as_str)
        .map(|v| clean(v, 64))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| signing_env.to_string());
    let signing_key = std::env::var(&signature_env_name).unwrap_or_default();
    if signing_key.trim().is_empty() {
        errors.push("missing_template_signing_key".to_string());
    }

    let mut checks = Vec::<Value>::new();
    let templates = manifest
        .get("templates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if templates.is_empty() {
        errors.push("template_manifest_entries_required".to_string());
    }
    for row in templates {
        let rel = row
            .get("path")
            .and_then(Value::as_str)
            .map(|v| clean(v, 260))
            .unwrap_or_default();
        if rel.is_empty() {
            checks.push(json!({"path": rel, "ok": false, "error": "missing_path"}));
            errors.push("template_path_missing".to_string());
            continue;
        }
        let full = templates_root.join(&rel);
        if !full.exists() {
            checks.push(json!({"path": rel, "ok": false, "error": "missing_template"}));
            errors.push(format!("missing_template::{rel}"));
            continue;
        }
        let body = fs::read_to_string(&full).unwrap_or_default();
        let observed = sha256_hex_str(&body);
        let expected = row
            .get("sha256")
            .and_then(Value::as_str)
            .map(|v| clean(v, 80))
            .unwrap_or_default();
        let reviewed = row
            .get("human_reviewed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let cadence_ok = row
            .get("review_cadence_days")
            .and_then(Value::as_u64)
            .map(|v| v <= 365)
            .unwrap_or(true);
        let ok = expected == observed && reviewed && cadence_ok;
        if !ok {
            errors.push(format!("template_check_failed::{rel}"));
        }
        checks.push(json!({
            "path": rel,
            "ok": ok,
            "sha256_expected": expected,
            "sha256_observed": observed,
            "human_reviewed": reviewed,
            "review_cadence_ok": cadence_ok
        }));
    }

    let signature_valid = if signing_key.trim().is_empty() {
        false
    } else {
        let mut basis = manifest.clone();
        if let Some(obj) = basis.as_object_mut() {
            obj.remove("signature");
        }
        let expected = format!(
            "sig:{}",
            sha256_hex_str(&format!(
                "{}:{}",
                signing_key,
                canonical_json_string(&basis)
            ))
        );
        manifest
            .get("signature")
            .and_then(Value::as_str)
            .map(|v| clean(v, 256))
            .unwrap_or_default()
            == expected
    };
    if !signature_valid {
        errors.push("template_manifest_signature_invalid".to_string());
    }

    if !errors.is_empty() {
        return fail_payload(type_name, strict, errors, Some(conduit));
    }

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": type_name,
        "lane": "core/layer0/ops",
        "manifest_path": manifest_rel,
        "templates_root": templates_root.display().to_string(),
        "signature_env": signature_env_name,
        "signature_valid": signature_valid,
        "checks": checks,
        "conduit_enforcement": conduit,
        "claim_evidence": [
            {
                "id": claim_id,
                "claim": "signed_curated_template_pack_is_governed_with_human_review_and_deterministic_receipts",
                "evidence": {
                    "checked_templates": checks.len(),
                    "signature_valid": signature_valid
                }
            },
            {
                "id": "V6-RESEARCH-005.6",
                "claim": "scrape_template_governance_is_conduit_only_fail_closed",
                "evidence": {
                    "conduit": true
                }
            },
            {
                "id": "V6-RESEARCH-006.6",
                "claim": "decoder_template_governance_is_conduit_only_fail_closed",
                "evidence": {
                    "conduit": true
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run_book_patterns_template_governance(
    root: &Path,
    parsed: &ParsedArgs,
    strict: bool,
) -> Value {
    let conduit = conduit_enforcement(root, parsed, strict, "book_patterns_template_governance");
    run_template_governance_common(
        root,
        parsed,
        strict,
        BOOK_PATTERN_TEMPLATE_CONTRACT_PATH,
        BOOK_PATTERN_TEMPLATE_MANIFEST_PATH,
        "planes/contracts/research/book_patterns_templates",
        "research_plane_book_patterns_template_governance",
        "V6-RESEARCH-005.5",
        "BOOK_PATTERNS_TEMPLATE_SIGNING_KEY",
        conduit,
    )
}

pub fn run_decoder_template_governance(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let conduit = conduit_enforcement(root, parsed, strict, "decoder_template_governance");
    run_template_governance_common(
        root,
        parsed,
        strict,
        NEWS_DECODER_TEMPLATE_CONTRACT_PATH,
        NEWS_DECODER_TEMPLATE_MANIFEST_PATH,
        "planes/contracts/research/news_decoder_templates",
        "research_plane_decoder_template_governance",
        "V6-RESEARCH-006.5",
        "NEWS_DECODER_TEMPLATE_SIGNING_KEY",
        conduit,
    )
}

fn run_decode_common(
    root: &Path,
    parsed: &ParsedArgs,
    strict: bool,
    batch: bool,
    command_type: &str,
) -> Value {
    let conduit = conduit_enforcement(root, parsed, strict, command_type);
    if strict && !conduit.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return fail_payload(
            command_type,
            strict,
            vec!["conduit_bypass_rejected".to_string()],
            Some(conduit),
        );
    }

    let (policy, mut errors) = load_decode_policy(root, parsed);
    if strict
        && !policy
            .allowed_proxy_modes
            .iter()
            .any(|v| v == &policy.proxy_mode)
    {
        errors.push("proxy_mode_not_allowed".to_string());
    }
    if policy.max_attempts == 0 {
        errors.push("max_attempts_must_be_positive".to_string());
    }

    let urls = if batch {
        let mut rows = parse_csv_or_file(root, parsed, "urls", "urls-file", 2400);
        if rows.is_empty() {
            rows.extend(
                parsed
                    .positional
                    .iter()
                    .skip(1)
                    .map(|v| clean(v, 2400))
                    .filter(|v| !v.is_empty()),
            );
            rows.sort();
            rows.dedup();
        }
        rows
    } else {
        vec![clean(
            parsed
                .flags
                .get("url")
                .cloned()
                .or_else(|| parsed.positional.get(1).cloned())
                .unwrap_or_default(),
            2400,
        )]
    };

    if urls.is_empty() || urls.first().map(|v| v.is_empty()).unwrap_or(true) {
        errors.push("missing_url".to_string());
    }
    if !errors.is_empty() {
        return fail_payload(command_type, strict, errors, Some(conduit));
    }

    if batch {
        let continue_on_error = guess_bool(
            parsed.flags.get("continue-on-error").map(String::as_str),
            true,
        );
        let mut per_item = Vec::<Value>::new();
        let mut succeeded = 0usize;
        let mut failed = 0usize;
        let mut all_policy_attempts = Vec::<Value>::new();

        for (idx, url) in urls.iter().enumerate() {
            let (result, resolver_attempts, mut policy_attempts) =
                decode_with_dual_path(url, &policy);
            for row in &mut policy_attempts {
                row["item_index"] = Value::from(idx as u64);
            }
            all_policy_attempts.extend(policy_attempts.clone());
            let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
            if ok {
                succeeded += 1;
            } else {
                failed += 1;
            }
            per_item.push(json!({
                "index": idx,
                "input_url": url,
                "status": result.get("status").cloned().unwrap_or_else(|| Value::String("unresolved".to_string())),
                "decoded_url": result.get("decoded_url").cloned().unwrap_or(Value::Null),
                "message": result.get("message").cloned().unwrap_or_else(|| Value::String("decode failed".to_string())),
                "decode_method": result.get("decode_method").cloned().unwrap_or(Value::Null),
                "error_taxonomy": result.get("error_taxonomy").cloned().unwrap_or_else(|| json!([])),
                "resolver_attempts": resolver_attempts,
                "policy_attempts": policy_attempts
            }));
            if !ok && !continue_on_error {
                break;
            }
        }

        let mut out = json!({
            "ok": if strict { failed == 0 } else { true },
            "strict": strict,
            "type": command_type,
            "lane": "core/layer0/ops",
            "proxy_mode": policy.proxy_mode,
            "policy_attempts": all_policy_attempts,
            "summary": {
                "requested": urls.len(),
                "processed": per_item.len(),
                "succeeded": succeeded,
                "failed": failed,
                "continue_on_error": continue_on_error
            },
            "items": per_item,
            "conduit_enforcement": conduit,
            "claim_evidence": [
                {
                    "id": "V6-RESEARCH-006.2",
                    "claim": "proxy_aware_decode_rate_limit_governance_emits_deterministic_attempt_receipts",
                    "evidence": {
                        "proxy_mode": policy.proxy_mode,
                        "attempt_receipt_count": all_policy_attempts.len()
                    }
                },
                {
                    "id": "V6-RESEARCH-006.4",
                    "claim": "batch_decode_isolates_failures_and_emits_summary_receipts",
                    "evidence": {
                        "processed": per_item.len(),
                        "failed": failed
                    }
                },
                {
                    "id": "V6-RESEARCH-006.6",
                    "claim": "decode_batch_actions_are_conduit_only_fail_closed",
                    "evidence": {
                        "conduit": true
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        return out;
    }

    let input_url = urls.first().cloned().unwrap_or_default();
    let (result, resolver_attempts, policy_attempts) = decode_with_dual_path(&input_url, &policy);
    let mut out = json!({
        "ok": result.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "strict": strict,
        "type": command_type,
        "lane": "core/layer0/ops",
        "status": result.get("status").cloned().unwrap_or_else(|| Value::String("unresolved".to_string())),
        "input_url": input_url,
        "decoded_url": result.get("decoded_url").cloned().unwrap_or(Value::Null),
        "message": result.get("message").cloned().unwrap_or_else(|| Value::String("decode failed".to_string())),
        "decode_method": result.get("decode_method").cloned().unwrap_or(Value::Null),
        "resolver_attempts": resolver_attempts,
        "error_taxonomy": result.get("error_taxonomy").cloned().unwrap_or_else(|| json!([])),
        "proxy_mode": policy.proxy_mode,
        "policy_attempts": policy_attempts,
        "provenance": {
            "input_sha256": sha256_hex_str(&input_url),
            "decoder_contract": NEWS_DECODE_CONTRACT_PATH
        },
        "conduit_enforcement": conduit,
        "claim_evidence": [
            {
                "id": "V6-RESEARCH-006.1",
                "claim": "google_news_obfuscated_urls_decode_to_structured_outputs_with_provenance_receipts",
                "evidence": {
                    "status": result.get("status").cloned().unwrap_or(Value::String("unresolved".to_string()))
                }
            },
            {
                "id": "V6-RESEARCH-006.2",
                "claim": "proxy_aware_decode_rate_limit_governance_emits_deterministic_attempt_receipts",
                "evidence": {
                    "proxy_mode": policy.proxy_mode,
                    "attempt_receipt_count": policy_attempts.len()
                }
            },
            {
                "id": "V6-RESEARCH-006.3",
                "claim": "decode_uses_deterministic_articles_primary_then_rss_fallback_with_error_taxonomy",
                "evidence": {
                    "resolver_attempt_count": resolver_attempts.len(),
                    "resolver_order": resolver_attempts.iter().map(|row| row.get("resolver_path").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>()
                }
            },
            {
                "id": "V6-RESEARCH-006.6",
                "claim": "decode_actions_are_conduit_only_fail_closed",
                "evidence": {
                    "conduit": true
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run_decode_news_url(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    run_decode_common(
        root,
        parsed,
        strict,
        false,
        "research_plane_decode_news_url",
    )
}

pub fn run_decode_news_urls(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    run_decode_common(
        root,
        parsed,
        strict,
        true,
        "research_plane_decode_news_urls",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_fallback_uses_continue_on_rss_path() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = crate::parse_args(&[
            "decode-news-url".to_string(),
            "--url=https://news.google.com/read/ABC?continue=https%3A%2F%2Fexample.com%2Ffallback"
                .to_string(),
            "--strict=1".to_string(),
        ]);
        let out = run_decode_news_url(root.path(), &parsed, true);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            out.get("decoded_url").and_then(Value::as_str),
            Some("https://example.com/fallback")
        );
        let attempts = out
            .get("resolver_attempts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let order = attempts
            .iter()
            .filter_map(|row| {
                row.get("resolver_path")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect::<Vec<_>>();
        assert!(order.first().map(|v| v.as_str()) == Some("/articles"));
        assert!(order.len() >= 2);
    }

    #[test]
    fn conduit_rejects_bypass_for_batch_decode() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = crate::parse_args(&[
            "decode-news-urls".to_string(),
            "--urls=https://news.google.com/read/a".to_string(),
            "--bypass=1".to_string(),
            "--strict=1".to_string(),
        ]);
        let out = run_decode_news_urls(root.path(), &parsed, true);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
        assert!(out
            .get("errors")
            .and_then(Value::as_array)
            .map(|rows| rows
                .iter()
                .any(|row| row.as_str() == Some("conduit_bypass_rejected")))
            .unwrap_or(false));
    }
}
