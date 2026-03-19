// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::research_plane (authoritative)

use crate::research_batch6;
use crate::research_batch7;
use crate::research_batch8;
use crate::v8_kernel::{
    parse_bool, parse_u64, read_json, scoped_state_root, sha256_hex_str, write_receipt,
};
use crate::{clean, parse_args, ParsedArgs};
use crate::{crawl_console, crawl_middleware, crawl_pipeline, crawl_signals, crawl_spider};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

const STATE_ENV: &str = "RESEARCH_PLANE_STATE_ROOT";
const STATE_SCOPE: &str = "research_plane";

const CONTRACT_PATH: &str = "planes/contracts/research/research_plane_v1.json";
const POLICY_PATH: &str = "client/runtime/config/research_plane_policy.json";

fn usage() {
    println!("Usage:");
    println!("  protheus-ops research-plane status");
    println!("  protheus-ops research-plane diagnostics [--strict=1|0]");
    println!("  protheus-ops research-plane fetch --url=<url> [--mode=auto|http|stealth|browser] [--timeout-ms=<n>] [--max-bytes=<n>] [--strict=1|0]");
    println!("  protheus-ops research-plane fetch --stealth --url=<url> [--timeout-ms=<n>] [--strict=1|0]");
    println!("  protheus-ops research-plane recover-selectors [--html=<text>|--html-base64=<b64>|--html-path=<path>] [--selectors=a,b,c] [--target-text=<text>] [--strict=1|0]");
    println!("  protheus-ops research-plane crawl --seed-urls=<u1,u2> [--max-pages=<n>] [--max-concurrency=<n>] [--max-retries=<n>] [--per-domain-qps=<n>] [--checkpoint-path=<path>] [--resume=1|0] [--strict=1|0]");
    println!("  protheus-ops research-plane mcp-extract [--payload=<html>|--payload-path=<path>] [--source=<url>] [--query=<text>] [--strict=1|0]");
    println!("  protheus-ops research-plane spider|crawl-spider [--graph-json=<json>|--graph-path=<path>] --seed-urls=<u1,u2> [--allow-rules=a,b] [--deny-rules=a,b] [--allowed-domains=a,b] [--max-depth=<n>] [--max-links=<n>] [--strict=1|0]");
    println!("  protheus-ops research-plane middleware|crawl-middleware [--request-json=<json>] [--response-json=<json>] [--stack-json=<json>] [--strict=1|0]");
    println!("  protheus-ops research-plane pipeline|crawl-pipeline [--items-json=<json>] [--pipeline-json=<json>] [--export-format=json|csv] [--export-path=<path>] [--strict=1|0]");
    println!("  protheus-ops research-plane signals|crawl-signals [--events-json=<json>] [--handlers-json=<json>] [--strict=1|0]");
    println!("  protheus-ops research-plane console|crawl-console --op=<status|stats|queue|pause|resume|enqueue> --auth-token=<token> [--url=<u>] [--strict=1|0]");
    println!("  protheus-ops research-plane template-governance [--manifest=<path>] [--templates-root=<dir>] [--strict=1|0]");
    println!("  protheus-ops research-plane goal-crawl --goal=<text> [--max-pages=<n>] [--max-discovery=<n>] [--catalog-json=<json>|--catalog-path=<path>] [--strict=1|0]");
    println!("  protheus-ops research-plane map-site --domain=<host|url> [--depth=<n>] [--graph-json=<json>|--graph-path=<path>] [--strict=1|0]");
    println!("  protheus-ops research-plane extract-structured [--payload=<html>|--payload-path=<path>] [--schema-json=<json>|--schema-path=<path>|--prompt=<text>] [--strict=1|0]");
    println!("  protheus-ops research-plane monitor --url=<url> [--content=<text>|--content-path=<path>] [--strict=1|0]");
    println!("  protheus-ops research-plane firecrawl-template-governance [--manifest=<path>] [--templates-root=<dir>] [--strict=1|0]");
    println!("  protheus-ops research-plane js-scrape --url=<url> [--mode=js-render|stealth-js] [--wait-ms=<n>] [--selector=<s>] [--form-json=<json>|--form-path=<path>] [--strict=1|0]");
    println!("  protheus-ops research-plane auth-session --op=<open|login|status|close> [--session-id=<id>] [--username=<u> --password=<p>] [--strict=1|0]");
    println!("  protheus-ops research-plane proxy-rotate [--proxies=a,b] [--attempt-signals=s1,s2] [--strict=1|0]");
    println!("  protheus-ops research-plane parallel-scrape-workers [--targets=u1,u2|--targets-file=<path>] [--session-ids=s1,s2] [--max-concurrency=<n>] [--max-retries=<n>] [--strict=1|0]");
    println!("  protheus-ops research-plane book-patterns-template-governance [--manifest=<path>] [--templates-root=<dir>] [--strict=1|0]");
    println!("  protheus-ops research-plane decode-news-url --url=<news-url> [--proxy-mode=none|http|https|socks] [--proxy=<url>|--proxies=a,b] [--interval-ms=<n>] [--backoff-ms=<n>] [--max-attempts=<n>] [--strict=1|0]");
    println!("  protheus-ops research-plane decode-news-urls [--urls=u1,u2|--urls-file=<path>] [--continue-on-error=1|0] [--proxy-mode=none|http|https|socks] [--proxy=<url>|--proxies=a,b] [--interval-ms=<n>] [--backoff-ms=<n>] [--max-attempts=<n>] [--strict=1|0]");
    println!("  protheus-ops research-plane decoder-template-governance [--manifest=<path>] [--templates-root=<dir>] [--strict=1|0]");
}

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn history_path(root: &Path) -> PathBuf {
    state_root(root).join("history.jsonl")
}

fn print_payload(payload: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(payload)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn emit(root: &Path, payload: Value) -> i32 {
    match write_receipt(root, STATE_ENV, STATE_SCOPE, payload) {
        Ok(out) => {
            print_payload(&out);
            if out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                0
            } else {
                1
            }
        }
        Err(err) => {
            print_payload(&json!({
                "ok": false,
                "type": "research_plane_error",
                "error": clean(err, 240)
            }));
            1
        }
    }
}

fn load_json_or(root: &Path, rel: &str, fallback: Value) -> Value {
    read_json(&root.join(rel)).unwrap_or(fallback)
}

fn status(root: &Path) -> Value {
    json!({
        "ok": true,
        "type": "research_plane_status",
        "lane": "core/layer0/ops",
        "latest_path": latest_path(root).display().to_string(),
        "history_path": history_path(root).display().to_string(),
        "safety_counters_path": state_root(root).join("safety").join("gate_counters.json").display().to_string(),
        "latest": read_json(&latest_path(root))
    })
}

fn diagnostics(root: &Path) -> Value {
    let policy = load_json_or(
        root,
        POLICY_PATH,
        json!({
            "version": "v1",
            "kind": "research_plane_policy",
            "safety_plane": {
                "enabled": true,
                "required_modes": ["stealth", "browser"],
                "allow_actions": ["research_*:*", "research:*"],
                "max_requests_per_mode": {"stealth": 20000, "browser": 5000}
            }
        }),
    );
    let safety = read_json(&state_root(root).join("safety").join("gate_counters.json"))
        .unwrap_or_else(|| json!({"total":0_u64,"modes":{}}));
    json!({
        "ok": true,
        "type": "research_plane_diagnostics",
        "lane": "core/layer0/ops",
        "policy_path": POLICY_PATH,
        "contract_path": CONTRACT_PATH,
        "safety_plane_policy": policy.get("safety_plane").cloned().unwrap_or(Value::Null),
        "safety_plane_counters": safety,
        "developer_dx": {
            "stealth_entrypoint": "protheus research --stealth --url=<url>",
            "console_entrypoint": "protheus-ops research-plane console --op=stats --auth-token=<token>"
        },
        "claim_evidence": [
            {
                "id": "V6-RESEARCH-001.6",
                "claim": "developer_facing_stealth_diagnostics_surface_is_available_from_cli",
                "evidence": {"diagnostics": true}
            }
        ]
    })
}

fn parse_headers(node: Option<&Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::<String, String>::new();
    if let Some(Value::Object(map)) = node {
        for (k, v) in map {
            if let Some(val) = v.as_str() {
                let key = k.trim();
                let value = val.trim();
                if !key.is_empty() && !value.is_empty() {
                    out.insert(key.to_string(), value.to_string());
                }
            }
        }
    }
    out
}

fn protection_detected(body: &str, status_code: i64, signals: &[String]) -> bool {
    if matches!(status_code, 401 | 403 | 429 | 503) {
        return true;
    }
    let body_lc = body.to_ascii_lowercase();
    signals
        .iter()
        .any(|signal| body_lc.contains(&signal.to_ascii_lowercase()))
}

fn fetch_file_url(url: &str, max_bytes: usize) -> Value {
    let path = url.trim_start_matches("file://");
    let read = fs::read(path);
    match read {
        Ok(bytes) => {
            let clipped = bytes.iter().take(max_bytes).copied().collect::<Vec<_>>();
            let body = String::from_utf8_lossy(&clipped).to_string();
            json!({
                "ok": true,
                "status": 200,
                "body": body,
                "headers": {},
                "error": Value::Null
            })
        }
        Err(err) => json!({
            "ok": false,
            "status": 0,
            "body": "",
            "headers": {},
            "error": format!("file_read_failed:{err}")
        }),
    }
}

fn fetch_with_curl(
    url: &str,
    mode: &str,
    timeout_ms: u64,
    headers: &BTreeMap<String, String>,
    max_bytes: usize,
) -> Value {
    if url.starts_with("file://") {
        return fetch_file_url(url, max_bytes);
    }

    let timeout_sec = ((timeout_ms as f64) / 1000.0).ceil() as u64;
    let mut args = vec![
        "-sS".to_string(),
        "-L".to_string(),
        "--max-time".to_string(),
        timeout_sec.max(1).to_string(),
        "--compressed".to_string(),
        "-A".to_string(),
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36".to_string(),
    ];
    for (key, value) in headers {
        args.push("-H".to_string());
        args.push(format!("{key}: {value}"));
    }
    args.push("-w".to_string());
    args.push("\n__STATUS__:%{http_code}".to_string());
    args.push(url.to_string());

    let started = Instant::now();
    let output = Command::new("curl").args(args).output();
    match output {
        Ok(run) => {
            let stdout = String::from_utf8_lossy(&run.stdout).to_string();
            let stderr = String::from_utf8_lossy(&run.stderr).to_string();
            let marker = "\n__STATUS__:";
            let (body_raw, status_raw) = match stdout.rsplit_once(marker) {
                Some((body, status)) => (body.to_string(), status.trim().to_string()),
                None => (stdout, "0".to_string()),
            };
            let body = body_raw.chars().take(max_bytes).collect::<String>();
            let status = status_raw.parse::<i64>().unwrap_or(0);
            json!({
                "ok": run.status.success(),
                "status": status,
                "body": body,
                "headers": {},
                "error": if run.status.success() { Value::Null } else { Value::String(clean(stderr, 220)) },
                "elapsed_ms": started.elapsed().as_millis(),
                "mode": mode
            })
        }
        Err(err) => json!({
            "ok": false,
            "status": 0,
            "body": "",
            "headers": {},
            "error": format!("curl_spawn_failed:{err}"),
            "mode": mode
        }),
    }
}

fn fetch_auto(
    root: &Path,
    url: &str,
    selected_mode: &str,
    timeout_ms: u64,
    max_bytes: usize,
    policy: &Value,
    contract: &Value,
    strict: bool,
) -> Value {
    let signals = contract
        .get("protection_signals")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(ToString::to_string))
        .collect::<Vec<_>>();
    let headers_http = parse_headers(policy.get("headers").and_then(|h| h.get("http")));
    let headers_stealth = parse_headers(policy.get("headers").and_then(|h| h.get("stealth")));
    let headers_browser = parse_headers(policy.get("headers").and_then(|h| h.get("browser")));

    let mut attempts = Vec::<Value>::new();
    let mut safety_receipts = Vec::<Value>::new();
    let mut run_mode = |mode: &str, headers: &BTreeMap<String, String>| -> Value {
        let safety = research_batch6::safety_gate_receipt(
            root,
            policy,
            mode,
            "research_fetch:auto",
            url,
            strict,
        );
        let safety_ok = safety.get("ok").and_then(Value::as_bool).unwrap_or(false);
        safety_receipts.push(safety.clone());
        if strict && !safety_ok {
            let out = json!({
                "mode": mode,
                "ok": false,
                "status": 0,
                "protected": true,
                "error": "safety_plane_denied",
                "body_sha256": Value::Null,
                "safety_receipt_hash": safety.get("receipt_hash").cloned().unwrap_or(Value::Null)
            });
            attempts.push(out);
            return json!({
                "ok": false,
                "status": 0,
                "body": "",
                "headers": {},
                "error": "safety_plane_denied",
                "mode": mode
            });
        }
        let row = fetch_with_curl(url, mode, timeout_ms, headers, max_bytes);
        let status = row.get("status").and_then(Value::as_i64).unwrap_or(0);
        let body = row.get("body").and_then(Value::as_str).unwrap_or_default();
        let protected = protection_detected(body, status, &signals);
        let out = json!({
            "mode": mode,
            "ok": row.get("ok").and_then(Value::as_bool).unwrap_or(false),
            "status": status,
            "protected": protected,
            "error": row.get("error").cloned().unwrap_or(Value::Null),
            "body_sha256": sha256_hex_str(body),
            "safety_receipt_hash": safety.get("receipt_hash").cloned().unwrap_or(Value::Null)
        });
        attempts.push(out.clone());
        row
    };

    let mut selected = selected_mode.to_ascii_lowercase();
    let final_row = if selected == "auto" {
        let first = run_mode("http", &headers_http);
        let first_ok = first.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let first_status = first.get("status").and_then(Value::as_i64).unwrap_or(0);
        let first_body = first
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let first_protected = protection_detected(first_body, first_status, &signals);
        if first_ok && !first_protected {
            selected = "http".to_string();
            first
        } else {
            let second = run_mode("stealth", &headers_stealth);
            let second_ok = second.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let second_status = second.get("status").and_then(Value::as_i64).unwrap_or(0);
            let second_body = second
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let second_protected = protection_detected(second_body, second_status, &signals);
            if second_ok && !second_protected {
                selected = "stealth".to_string();
                second
            } else {
                selected = "browser".to_string();
                run_mode("browser", &headers_browser)
            }
        }
    } else if selected == "http" {
        run_mode("http", &headers_http)
    } else if selected == "stealth" {
        run_mode("stealth", &headers_stealth)
    } else {
        selected = "browser".to_string();
        run_mode("browser", &headers_browser)
    };

    let status = final_row.get("status").and_then(Value::as_i64).unwrap_or(0);
    let body = final_row
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let ok = final_row
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let protected = protection_detected(&body, status, &signals);
    json!({
        "ok": ok && !protected && (200..=299).contains(&status),
        "selected_mode": selected,
        "status": status,
        "body": body,
        "body_sha256": sha256_hex_str(final_row.get("body").and_then(Value::as_str).unwrap_or_default()),
        "attempts": attempts,
        "error": final_row.get("error").cloned().unwrap_or(Value::Null),
        "protected": protected,
        "safety_plane_receipts": safety_receipts
    })
}

fn run_fetch(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "research_plane_contract",
            "fetch_modes": ["http","stealth","browser","auto"],
            "protection_signals": ["captcha","cloudflare","bot detected","access denied"]
        }),
    );
    let policy = load_json_or(
        root,
        POLICY_PATH,
        json!({
            "version": "v1",
            "kind": "research_plane_policy",
            "default_mode": "auto",
            "timeouts": {"fetch_ms": 12000}
        }),
    );
    let url = clean(parsed.flags.get("url").cloned().unwrap_or_default(), 2000);
    let mode = parsed
        .flags
        .get("mode")
        .map(|v| v.to_ascii_lowercase())
        .or_else(|| {
            if parse_bool(parsed.flags.get("stealth"), false) {
                Some("stealth".to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| {
            policy
                .get("default_mode")
                .and_then(Value::as_str)
                .unwrap_or("auto")
                .to_ascii_lowercase()
        });
    let timeout_ms = parse_u64(
        parsed.flags.get("timeout-ms"),
        policy
            .get("timeouts")
            .and_then(|v| v.get("fetch_ms"))
            .and_then(Value::as_u64)
            .unwrap_or(12_000),
    )
    .clamp(1_000, 120_000);
    let max_bytes = parse_u64(parsed.flags.get("max-bytes"), 400_000).clamp(1_024, 4_000_000);
    let mut errors = Vec::<String>::new();

    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("research_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "research_plane_contract"
    {
        errors.push("research_contract_kind_invalid".to_string());
    }
    if policy
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("research_policy_version_must_be_v1".to_string());
    }
    if url.is_empty() {
        errors.push("missing_url".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "research_plane_fetch",
            "errors": errors
        });
    }

    let fetched = fetch_auto(
        root,
        &url,
        &mode,
        timeout_ms,
        max_bytes as usize,
        &policy,
        &contract,
        strict,
    );
    let ok = fetched.get("ok").and_then(Value::as_bool).unwrap_or(false);
    json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "type": "research_plane_fetch",
        "lane": "core/layer0/ops",
        "url": url,
        "mode_requested": mode,
        "mode_selected": fetched.get("selected_mode").cloned().unwrap_or(Value::String("unknown".to_string())),
        "status": fetched.get("status").cloned().unwrap_or(Value::Number(0_u64.into())),
        "protected": fetched.get("protected").cloned().unwrap_or(Value::Bool(false)),
        "attempts": fetched.get("attempts").cloned().unwrap_or(Value::Array(Vec::new())),
        "safety_plane_receipts": fetched.get("safety_plane_receipts").cloned().unwrap_or(Value::Array(Vec::new())),
        "body_sha256": fetched.get("body_sha256").cloned().unwrap_or(Value::Null),
        "body_preview": fetched
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .take(220)
            .collect::<String>(),
        "error": fetched.get("error").cloned().unwrap_or(Value::Null),
        "claim_evidence": [
            {
                "id": "V6-RESEARCH-001.1",
                "claim": "multi_mode_fetcher_switches_http_stealth_browser_based_on_protection_signals",
                "evidence": {
                    "mode_selected": fetched.get("selected_mode").cloned().unwrap_or(Value::Null),
                    "attempt_count": fetched.get("attempts").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0)
                }
            },
            {
                "id": "V6-RESEARCH-001.5",
                "claim": "stealth_and_browser_paths_are_safety_plane_routed_with_deterministic_receipts",
                "evidence": {
                    "safety_receipt_count": fetched.get("safety_plane_receipts").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0)
                }
            }
        ]
    })
}

fn decode_html_payload(parsed: &ParsedArgs, root: &Path) -> Result<String, String> {
    if let Some(raw) = parsed.flags.get("html") {
        return Ok(raw.to_string());
    }
    if let Some(raw_b64) = parsed.flags.get("html-base64") {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("decode_html_base64_failed:{err}"))?;
        return Ok(String::from_utf8_lossy(&bytes).to_string());
    }
    if let Some(rel) = parsed.flags.get("html-path") {
        let path = if Path::new(rel).is_absolute() {
            PathBuf::from(rel)
        } else {
            root.join(rel)
        };
        return fs::read_to_string(&path)
            .map_err(|err| format!("read_html_path_failed:{}:{err}", path.display()));
    }
    Err("missing_html_input".to_string())
}

fn selector_exists(html_lc: &str, selector: &str) -> bool {
    let sel = selector.trim().to_ascii_lowercase();
    if sel.is_empty() {
        return false;
    }
    if let Some(id) = sel.strip_prefix('#') {
        return html_lc.contains(&format!("id=\"{}\"", id))
            || html_lc.contains(&format!("id='{}'", id));
    }
    if let Some(class) = sel.strip_prefix('.') {
        return html_lc.contains(&format!("class=\"{}\"", class))
            || html_lc.contains(&format!("class='{}'", class))
            || html_lc.contains(&format!(" {} ", class));
    }
    if let Some(xpath) = sel.strip_prefix("//") {
        let tag = xpath
            .split(['[', '/', ' '])
            .next()
            .unwrap_or_default()
            .trim();
        if !tag.is_empty() {
            return html_lc.contains(&format!("<{}", tag));
        }
    }
    html_lc.contains(&format!("<{}", sel))
}

fn token_similarity(left: &str, right: &str) -> f64 {
    let mut left_counts = BTreeMap::<char, u64>::new();
    for ch in left.chars() {
        if ch.is_ascii_alphanumeric() {
            *left_counts.entry(ch).or_insert(0) += 1;
        }
    }
    let mut right_counts = BTreeMap::<char, u64>::new();
    for ch in right.chars() {
        if ch.is_ascii_alphanumeric() {
            *right_counts.entry(ch).or_insert(0) += 1;
        }
    }
    let mut intersection = 0_u64;
    let mut union = 0_u64;
    let mut keys = left_counts
        .keys()
        .chain(right_counts.keys())
        .copied()
        .collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    for key in keys {
        let l = left_counts.get(&key).copied().unwrap_or(0);
        let r = right_counts.get(&key).copied().unwrap_or(0);
        intersection += l.min(r);
        union += l.max(r);
    }
    if union == 0 {
        0.0
    } else {
        intersection as f64 / union as f64
    }
}

fn run_recover_selectors(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "research_plane_contract",
            "selector_recovery_order": ["css", "xpath", "text", "similarity"]
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("research_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "research_plane_contract"
    {
        errors.push("research_contract_kind_invalid".to_string());
    }
    let html = match decode_html_payload(parsed, root) {
        Ok(v) => v,
        Err(err) => {
            errors.push(err);
            return json!({
                "ok": false,
                "strict": strict,
                "type": "research_plane_selector_recovery",
                "errors": errors
            });
        }
    };
    let html_lc = html.to_ascii_lowercase();
    let mut selectors = parsed
        .flags
        .get("selectors")
        .map(|v| {
            v.split(',')
                .map(|part| clean(part, 160))
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if selectors.is_empty() {
        if let Some(single) = parsed.flags.get("selector").map(|v| clean(v, 160)) {
            if !single.is_empty() {
                selectors.push(single);
            }
        }
    }
    let target_text = clean(
        parsed.flags.get("target-text").cloned().unwrap_or_default(),
        240,
    );
    let mut recovery = Vec::<Value>::new();
    let mut recovered_selector = Value::Null;
    let mut recovered_strategy = "none".to_string();

    for selector in &selectors {
        let ok = selector_exists(&html_lc, selector);
        recovery.push(json!({
            "strategy": "css_or_xpath",
            "selector": selector,
            "ok": ok
        }));
        if ok && recovered_selector.is_null() {
            recovered_selector = Value::String(selector.clone());
            recovered_strategy = "css_or_xpath".to_string();
        }
    }

    if recovered_selector.is_null() && !target_text.is_empty() {
        let text_ok = html_lc.contains(&target_text.to_ascii_lowercase());
        recovery.push(json!({
            "strategy": "text",
            "selector": target_text,
            "ok": text_ok
        }));
        if text_ok {
            recovered_selector = Value::String(target_text.clone());
            recovered_strategy = "text".to_string();
        }
    }

    if recovered_selector.is_null() && !selectors.is_empty() {
        let mut best_score = 0.0_f64;
        let mut best = String::new();
        for selector in &selectors {
            let score = token_similarity(selector, &html_lc);
            if score > best_score {
                best_score = score;
                best = selector.clone();
            }
        }
        recovery.push(json!({
            "strategy": "similarity",
            "selector": best,
            "score": (best_score * 1000.0).round() / 1000.0
        }));
        if best_score >= 0.15 {
            recovered_selector = Value::String(best);
            recovered_strategy = "similarity".to_string();
        }
    }

    if recovered_selector.is_null() {
        errors.push("selector_recovery_failed".to_string());
    }
    let ok = !recovered_selector.is_null() && errors.is_empty();
    json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "type": "research_plane_selector_recovery",
        "lane": "core/layer0/ops",
        "selector_count": selectors.len(),
        "target_text": target_text,
        "recovered_selector": recovered_selector,
        "recovered_strategy": recovered_strategy,
        "steps": recovery,
        "errors": errors,
        "contract_path": CONTRACT_PATH,
        "claim_evidence": [
            {
                "id": "V6-RESEARCH-001.2",
                "claim": "selector_recovery_falls_back_css_xpath_text_similarity",
                "evidence": {
                    "recovered_strategy": recovered_strategy
                }
            }
        ]
    })
}

fn url_domain(url: &str) -> String {
    if url.starts_with("file://") {
        return "file".to_string();
    }
    let cleaned = url
        .split("://")
        .nth(1)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or("unknown");
    clean(cleaned, 120).to_ascii_lowercase()
}

fn parse_seed_urls(parsed: &ParsedArgs) -> Vec<String> {
    let mut out = parsed
        .flags
        .get("seed-urls")
        .map(|v| {
            v.split(',')
                .map(|part| clean(part, 2000))
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if out.is_empty() {
        if let Some(url) = parsed.flags.get("seed-url").map(|v| clean(v, 2000)) {
            if !url.is_empty() {
                out.push(url);
            }
        }
    }
    out
}

fn run_crawl(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "research_plane_contract",
            "crawler": {
                "max_concurrency": 100,
                "per_domain_qps": 2,
                "max_retries": 3,
                "checkpoint_every": 10
            }
        }),
    );
    let policy = load_json_or(
        root,
        POLICY_PATH,
        json!({
            "version": "v1",
            "kind": "research_plane_policy",
            "crawler": {
                "max_concurrency": 100,
                "per_domain_qps": 2,
                "max_retries": 3,
                "checkpoint_every": 10
            },
            "timeouts": {"crawl_fetch_ms": 8000}
        }),
    );
    let max_pages = parse_u64(parsed.flags.get("max-pages"), 100).clamp(1, 10_000) as usize;
    let max_concurrency = parse_u64(
        parsed.flags.get("max-concurrency"),
        policy
            .get("crawler")
            .and_then(|v| v.get("max_concurrency"))
            .and_then(Value::as_u64)
            .unwrap_or(100),
    )
    .clamp(1, 1000) as usize;
    let per_domain_qps = parse_u64(
        parsed.flags.get("per-domain-qps"),
        policy
            .get("crawler")
            .and_then(|v| v.get("per_domain_qps"))
            .and_then(Value::as_u64)
            .unwrap_or(2),
    )
    .clamp(1, 100);
    let max_retries = parse_u64(
        parsed.flags.get("max-retries"),
        policy
            .get("crawler")
            .and_then(|v| v.get("max_retries"))
            .and_then(Value::as_u64)
            .unwrap_or(3),
    )
    .clamp(0, 20);
    let checkpoint_every = parse_u64(
        parsed.flags.get("checkpoint-every"),
        policy
            .get("crawler")
            .and_then(|v| v.get("checkpoint_every"))
            .and_then(Value::as_u64)
            .unwrap_or(10),
    )
    .clamp(1, 1_000) as usize;
    let fetch_timeout = parse_u64(
        parsed.flags.get("timeout-ms"),
        policy
            .get("timeouts")
            .and_then(|v| v.get("crawl_fetch_ms"))
            .and_then(Value::as_u64)
            .unwrap_or(8_000),
    )
    .clamp(1_000, 120_000);
    let checkpoint_rel = parsed
        .flags
        .get("checkpoint-path")
        .cloned()
        .unwrap_or_else(|| {
            state_root(root)
                .join("crawl")
                .join("checkpoint.json")
                .display()
                .to_string()
        });
    let checkpoint_path = if Path::new(&checkpoint_rel).is_absolute() {
        PathBuf::from(&checkpoint_rel)
    } else {
        root.join(&checkpoint_rel)
    };
    let resume = parse_bool(parsed.flags.get("resume"), false);
    let seeds = parse_seed_urls(parsed);
    let mut errors = Vec::<String>::new();

    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("research_contract_version_must_be_v1".to_string());
    }
    if policy
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("research_policy_version_must_be_v1".to_string());
    }

    let mut queue = VecDeque::<Value>::new();
    let mut visited = Vec::<Value>::new();
    let mut failures = Vec::<Value>::new();
    let mut retries = 0_u64;
    let mut clock_ms = 0_u64;

    if resume && checkpoint_path.exists() {
        let checkpoint = read_json(&checkpoint_path).unwrap_or(Value::Null);
        if let Some(rows) = checkpoint.get("queue").and_then(Value::as_array) {
            for row in rows {
                queue.push_back(row.clone());
            }
        }
        if let Some(rows) = checkpoint.get("visited").and_then(Value::as_array) {
            visited = rows.clone();
        }
        if let Some(rows) = checkpoint.get("failures").and_then(Value::as_array) {
            failures = rows.clone();
        }
        retries = checkpoint
            .get("retries")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        clock_ms = checkpoint
            .get("clock_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0);
    } else {
        for url in &seeds {
            queue.push_back(json!({
                "url": url,
                "attempt": 0_u64,
                "ready_at_ms": 0_u64
            }));
        }
    }

    if queue.is_empty() {
        errors.push("crawl_seed_urls_required".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "research_plane_crawl",
            "errors": errors
        });
    }

    let mut domain_next_allowed = BTreeMap::<String, u64>::new();
    let interval_ms = (1000_u64 / per_domain_qps).max(1);
    let started = Instant::now();
    let mut loops_without_progress = 0_u32;

    while visited.len() < max_pages && !queue.is_empty() {
        let mut launched = 0_usize;
        let mut deferred = VecDeque::<Value>::new();
        while let Some(job) = queue.pop_front() {
            if launched >= max_concurrency {
                deferred.push_back(job);
                continue;
            }
            let ready_at = job.get("ready_at_ms").and_then(Value::as_u64).unwrap_or(0);
            if ready_at > clock_ms {
                deferred.push_back(job);
                continue;
            }
            let url = job
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let attempt = job.get("attempt").and_then(Value::as_u64).unwrap_or(0);
            let domain = url_domain(&url);
            let next_allowed = domain_next_allowed.get(&domain).copied().unwrap_or(0);
            if next_allowed > clock_ms {
                let mut shifted = job.clone();
                shifted["ready_at_ms"] = Value::Number(next_allowed.into());
                deferred.push_back(shifted);
                continue;
            }

            launched += 1;
            let fetched = fetch_auto(
                root,
                &url,
                "auto",
                fetch_timeout,
                300_000,
                &policy,
                &contract,
                strict,
            );
            let ok = fetched.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let status = fetched.get("status").and_then(Value::as_i64).unwrap_or(0);
            domain_next_allowed.insert(domain.clone(), clock_ms.saturating_add(interval_ms));

            if ok {
                visited.push(json!({
                    "url": url,
                    "status": status,
                    "domain": domain,
                    "body_sha256": fetched.get("body_sha256").cloned().unwrap_or(Value::Null)
                }));
                loops_without_progress = 0;
            } else if attempt < max_retries {
                retries = retries.saturating_add(1);
                let backoff = 500_u64.saturating_mul(2_u64.saturating_pow(attempt as u32));
                deferred.push_back(json!({
                    "url": url,
                    "attempt": attempt.saturating_add(1),
                    "ready_at_ms": clock_ms.saturating_add(backoff)
                }));
            } else {
                failures.push(json!({
                    "url": url,
                    "status": status,
                    "attempt": attempt,
                    "error": fetched.get("error").cloned().unwrap_or(Value::Null)
                }));
            }
        }
        queue = deferred;
        if launched == 0 {
            loops_without_progress = loops_without_progress.saturating_add(1);
            clock_ms = clock_ms.saturating_add(interval_ms);
            if loops_without_progress > 2000 {
                errors.push("crawl_scheduler_stalled".to_string());
                break;
            }
        } else {
            clock_ms = clock_ms.saturating_add(5);
        }

        if visited.len() % checkpoint_every == 0 || queue.is_empty() {
            if let Some(parent) = checkpoint_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let checkpoint = json!({
                "ts": chrono::Utc::now().to_rfc3339(),
                "queue": queue,
                "visited": visited,
                "failures": failures,
                "retries": retries,
                "clock_ms": clock_ms
            });
            let _ = fs::write(
                &checkpoint_path,
                serde_json::to_string_pretty(&checkpoint).unwrap_or_else(|_| "{}".to_string())
                    + "\n",
            );
        }
    }

    let elapsed_ms = started.elapsed().as_millis();
    let ok = errors.is_empty();
    json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "type": "research_plane_crawl",
        "lane": "core/layer0/ops",
        "seed_count": seeds.len(),
        "visited_count": visited.len(),
        "failure_count": failures.len(),
        "retries": retries,
        "max_pages": max_pages,
        "max_concurrency": max_concurrency,
        "per_domain_qps": per_domain_qps,
        "checkpoint_path": checkpoint_path.display().to_string(),
        "elapsed_ms": elapsed_ms,
        "visited": visited,
        "failures": failures,
        "errors": errors,
        "claim_evidence": [
            {
                "id": "V6-RESEARCH-001.3",
                "claim": "crawler_enforces_domain_throttle_checkpoint_and_backoff_resilience",
                "evidence": {
                    "visited_count": visited.len(),
                    "retries": retries
                }
            },
            {
                "id": "V6-RESEARCH-001.5",
                "claim": "crawl_fetch_paths_including_stealth_browser_fallback_are_safety_plane_routed",
                "evidence": {
                    "visited_count": visited.len()
                }
            }
        ]
    })
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let command = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }
    let strict = parse_bool(parsed.flags.get("strict"), true);
    let payload = match command.as_str() {
        "status" => status(root),
        "diagnostics" => diagnostics(root),
        "fetch" => run_fetch(root, &parsed, strict),
        "recover-selectors" | "recover_selectors" | "selector-recovery" => {
            run_recover_selectors(root, &parsed, strict)
        }
        "crawl" => run_crawl(root, &parsed, strict),
        "mcp-extract" | "mcp_extract" => research_batch6::run_mcp_extract(root, &parsed, strict),
        "spider" | "crawl-spider" | "crawl_spider" => crawl_spider::run(root, &parsed, strict),
        "middleware" | "crawl-middleware" | "crawl_middleware" => {
            crawl_middleware::run(root, &parsed, strict)
        }
        "pipeline" | "crawl-pipeline" | "crawl_pipeline" => {
            crawl_pipeline::run(root, &parsed, strict)
        }
        "signals" | "crawl-signals" | "crawl_signals" => crawl_signals::run(root, &parsed, strict),
        "console" | "crawl-console" | "crawl_console" => crawl_console::run(root, &parsed, strict),
        "template-governance" | "template_governance" => {
            research_batch6::run_template_governance(root, &parsed, strict)
        }
        "goal-crawl" | "goal_crawl" => research_batch7::run_goal_crawl(root, &parsed, strict),
        "map-site" | "map_site" | "map" => research_batch7::run_map_site(root, &parsed, strict),
        "extract-structured" | "extract_structured" => {
            research_batch7::run_extract_structured(root, &parsed, strict)
        }
        "monitor" => research_batch7::run_monitor(root, &parsed, strict),
        "firecrawl-template-governance" | "firecrawl_template_governance" => {
            research_batch7::run_firecrawl_template_governance(root, &parsed, strict)
        }
        "js-scrape" | "js_scrape" => research_batch7::run_js_scrape(root, &parsed, strict),
        "auth-session" | "auth_session" => research_batch7::run_auth_session(root, &parsed, strict),
        "proxy-rotate" | "proxy_rotate" => research_batch7::run_proxy_rotate(root, &parsed, strict),
        "parallel-scrape-workers" | "parallel_scrape_workers" => {
            research_batch8::run_parallel_scrape_workers(root, &parsed, strict)
        }
        "book-patterns-template-governance" | "book_patterns_template_governance" => {
            research_batch8::run_book_patterns_template_governance(root, &parsed, strict)
        }
        "decode-news-url" | "decode_news_url" => {
            research_batch8::run_decode_news_url(root, &parsed, strict)
        }
        "decode-news-urls" | "decode_news_urls" => {
            research_batch8::run_decode_news_urls(root, &parsed, strict)
        }
        "decoder-template-governance" | "decoder_template_governance" => {
            research_batch8::run_decoder_template_governance(root, &parsed, strict)
        }
        _ => json!({
            "ok": false,
            "type": "research_plane_error",
            "error": "unknown_command",
            "command": command
        }),
    };
    if command == "status" {
        print_payload(&payload);
        return 0;
    }
    emit(root, payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selector_recovery_uses_text_fallback() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = parse_args(&[
            "recover-selectors".to_string(),
            "--html=<div>hello world</div>".to_string(),
            "--selectors=#missing,.missing".to_string(),
            "--target-text=hello world".to_string(),
        ]);
        let out = run_recover_selectors(root.path(), &parsed, true);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            out.get("recovered_strategy").and_then(Value::as_str),
            Some("text")
        );
    }

    #[test]
    fn crawl_requires_seed_urls() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = parse_args(&["crawl".to_string()]);
        let out = run_crawl(root.path(), &parsed, true);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    }
}
