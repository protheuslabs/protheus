// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::research_batch6 (authoritative)

use crate::v8_kernel::{
    append_jsonl, parse_u64, read_json, scoped_state_root, sha256_hex_str, write_json,
};
use crate::{clean, deterministic_receipt_hash, now_iso, ParsedArgs};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "RESEARCH_PLANE_STATE_ROOT";
const STATE_SCOPE: &str = "research_plane";

pub const MCP_CONTRACT_PATH: &str = "planes/contracts/research/mcp_extraction_contract_v1.json";
pub const SPIDER_CONTRACT_PATH: &str = "planes/contracts/research/rule_spider_contract_v1.json";
pub const MIDDLEWARE_CONTRACT_PATH: &str =
    "planes/contracts/research/middleware_stack_contract_v1.json";
pub const PIPELINE_CONTRACT_PATH: &str = "planes/contracts/research/item_pipeline_contract_v1.json";
pub const SIGNAL_BUS_CONTRACT_PATH: &str = "planes/contracts/research/signal_bus_contract_v1.json";
pub const CONSOLE_CONTRACT_PATH: &str = "planes/contracts/research/crawl_console_contract_v1.json";
pub const TEMPLATE_GOVERNANCE_CONTRACT_PATH: &str =
    "planes/contracts/research/template_governance_contract_v1.json";
pub const TEMPLATE_MANIFEST_PATH: &str = "planes/contracts/research/template_pack_manifest_v1.json";

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

fn parse_json_flag_or_path(
    root: &Path,
    parsed: &ParsedArgs,
    json_key: &str,
    path_key: &str,
    fallback: Value,
) -> Result<Value, String> {
    if let Some(raw) = parsed.flags.get(json_key) {
        return serde_json::from_str::<Value>(raw)
            .map_err(|err| format!("invalid_json_flag:{json_key}:{err}"));
    }
    if let Some(rel) = parsed.flags.get(path_key) {
        let path = if Path::new(rel).is_absolute() {
            PathBuf::from(rel)
        } else {
            root.join(rel)
        };
        return read_json(&path).ok_or_else(|| format!("json_path_not_found:{}", path.display()));
    }
    Ok(fallback)
}

fn mode_requires_safety(mode: &str, policy: &Value) -> bool {
    let mode_norm = clean(mode, 64).to_ascii_lowercase();
    let defaults = vec!["stealth".to_string(), "browser".to_string()];
    let required = policy
        .get("safety_plane")
        .and_then(|v| v.get("required_modes"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| defaults.iter().map(|v| Value::String(v.clone())).collect());
    required
        .iter()
        .filter_map(Value::as_str)
        .map(|v| v.to_ascii_lowercase())
        .any(|v| v == mode_norm)
}

fn pattern_match(action: &str, pattern: &str) -> bool {
    let a = action.to_ascii_lowercase();
    let p = pattern.to_ascii_lowercase();
    if p.is_empty() || p == "*" || p == "all" {
        return true;
    }
    if p.contains('*') {
        let parts = p
            .split('*')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>();
        if parts.is_empty() {
            return true;
        }
        return parts.iter().all(|part| a.contains(part));
    }
    a == p || a.contains(&p)
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
                "id": "V6-RESEARCH-002.6",
                "claim": "research_template_and_crawler_controls_are_conduit_routed_with_fail_closed_bypass_rejection",
                "evidence": {
                    "required_path": "core/layer0/ops/research_plane",
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

pub fn safety_gate_receipt(
    root: &Path,
    policy: &Value,
    mode: &str,
    action: &str,
    target: &str,
    strict: bool,
) -> Value {
    let mode_norm = clean(mode, 64).to_ascii_lowercase();
    let action_norm = clean(action, 160).to_ascii_lowercase();
    let target_norm = clean(target, 400);
    let enabled = policy
        .get("safety_plane")
        .and_then(|v| v.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let safety_required = mode_requires_safety(&mode_norm, policy);
    let allowed_patterns = policy
        .get("safety_plane")
        .and_then(|v| v.get("allow_actions"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| {
            vec![
                Value::String("research:*".to_string()),
                Value::String("research_fetch:*".to_string()),
                Value::String("research_crawl:*".to_string()),
            ]
        });
    let action_allowed = allowed_patterns
        .iter()
        .filter_map(Value::as_str)
        .any(|pattern| pattern_match(&action_norm, pattern));

    let counters_path = state_root(root).join("safety").join("gate_counters.json");
    let mut counters = read_json(&counters_path).unwrap_or_else(|| {
        json!({
            "total": 0_u64,
            "modes": {}
        })
    });
    let mode_limit = policy
        .get("safety_plane")
        .and_then(|v| v.get("max_requests_per_mode"))
        .and_then(|v| v.get(&mode_norm))
        .and_then(Value::as_u64)
        .unwrap_or(20_000);
    let mode_used = counters
        .get("modes")
        .and_then(|v| v.get(&mode_norm))
        .and_then(Value::as_u64)
        .unwrap_or(0);

    let mut errors = Vec::<String>::new();
    if safety_required && !enabled {
        errors.push("safety_plane_disabled_for_required_mode".to_string());
    }
    if safety_required && !action_allowed {
        errors.push("safety_plane_action_not_allowed".to_string());
    }
    if safety_required && mode_used >= mode_limit {
        errors.push("safety_plane_budget_exhausted".to_string());
    }

    let ok = errors.is_empty() && enabled;
    if ok {
        let next_total = counters
            .get("total")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_add(1);
        counters["total"] = Value::Number(next_total.into());
        if !counters.get("modes").map(Value::is_object).unwrap_or(false) {
            counters["modes"] = Value::Object(Map::new());
        }
        let next_mode = mode_used.saturating_add(1);
        counters["modes"][mode_norm.clone()] = Value::Number(next_mode.into());
        let _ = write_json(&counters_path, &counters);
    }

    let mut out = json!({
        "ok": if strict { ok } else { true },
        "type": "research_safety_gate",
        "ts": now_iso(),
        "mode": mode_norm,
        "action": action_norm,
        "target": target_norm,
        "enabled": enabled,
        "required": safety_required,
        "action_allowed": action_allowed,
        "mode_budget": {"used": mode_used, "limit": mode_limit},
        "errors": errors,
        "claim_evidence": [
            {
                "id": "V6-RESEARCH-001.5",
                "claim": "stealth_and_browser_paths_are_fail_closed_through_safety_plane_gate",
                "evidence": {
                    "mode": mode,
                    "required": safety_required
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    let history_path = state_root(root).join("safety").join("history.jsonl");
    let _ = append_jsonl(&history_path, &out);
    out
}

fn strip_tags(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in html.chars() {
        if ch == '<' {
            in_tag = true;
            continue;
        }
        if ch == '>' {
            in_tag = false;
            out.push(' ');
            continue;
        }
        if !in_tag {
            out.push(ch);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn extract_links(html: &str) -> Vec<String> {
    let mut out = Vec::<String>::new();
    for token in ["href=\"", "href='"] {
        let mut start = 0usize;
        while let Some(found) = html[start..].find(token) {
            let begin = start + found + token.len();
            let rest = &html[begin..];
            let end = rest.find(|c| c == '"' || c == '\'').unwrap_or(rest.len());
            let value = clean(&rest[..end], 1024);
            if !value.is_empty() {
                out.push(value);
            }
            start = begin.saturating_add(end);
            if start >= html.len() {
                break;
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

fn parse_title(html: &str) -> String {
    let low = html.to_ascii_lowercase();
    if let Some(start) = low.find("<title>") {
        let body = &html[start + 7..];
        if let Some(end) = body.to_ascii_lowercase().find("</title>") {
            return clean(&body[..end], 200);
        }
    }
    "untitled".to_string()
}

pub fn run_mcp_extract(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let contract = read_json_or(
        root,
        MCP_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "mcp_extraction_contract",
            "required_artifacts": ["summary","links","entities","provenance"],
            "max_summary_chars": 600
        }),
    );
    let payload = parsed
        .flags
        .get("payload")
        .cloned()
        .or_else(|| parsed.flags.get("html").cloned())
        .or_else(|| {
            parsed.flags.get("payload-path").and_then(|p| {
                let path = if Path::new(p).is_absolute() {
                    PathBuf::from(p)
                } else {
                    root.join(p)
                };
                fs::read_to_string(path).ok()
            })
        })
        .unwrap_or_default();
    let source = clean(
        parsed
            .flags
            .get("source")
            .cloned()
            .or_else(|| parsed.flags.get("url").cloned())
            .unwrap_or_else(|| "unknown".to_string()),
        1200,
    );
    let query = clean(parsed.flags.get("query").cloned().unwrap_or_default(), 280);

    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("mcp_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "mcp_extraction_contract"
    {
        errors.push("mcp_contract_kind_invalid".to_string());
    }
    if payload.trim().is_empty() {
        errors.push("missing_payload".to_string());
    }

    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "research_plane_mcp_extract",
            "errors": errors
        });
    }

    let title = parse_title(&payload);
    let text = strip_tags(&payload);
    let max_summary_chars = contract
        .get("max_summary_chars")
        .and_then(Value::as_u64)
        .unwrap_or(600) as usize;
    let summary = clean(&text, max_summary_chars);
    let links = extract_links(&payload);
    let words = text
        .split_whitespace()
        .map(|w| clean(w, 64).to_ascii_lowercase())
        .filter(|w| w.len() >= 4)
        .collect::<Vec<_>>();
    let mut freq = BTreeMap::<String, u64>::new();
    for token in words {
        *freq.entry(token).or_insert(0) += 1;
    }
    let entities = freq
        .iter()
        .rev()
        .take(8)
        .map(|(token, count)| json!({"token": token, "count": count}))
        .collect::<Vec<_>>();

    let artifacts = json!({
        "title": title,
        "summary": summary,
        "links": links,
        "entities": entities
    });
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "research_plane_mcp_extract",
        "lane": "core/layer0/ops",
        "source": source,
        "query": query,
        "artifacts": artifacts,
        "provenance": {
            "source_hash": sha256_hex_str(&payload),
            "artifact_hash": sha256_hex_str(&artifacts.to_string()),
            "contract_path": MCP_CONTRACT_PATH
        },
        "claim_evidence": [
            {
                "id": "V6-RESEARCH-001.4",
                "claim": "mcp_extraction_returns_structured_artifacts_and_provenance_before_model_invocation",
                "evidence": {"source_hash": sha256_hex_str(&payload)}
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn parse_graph(value: Value) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::<String, Vec<String>>::new();
    let Some(obj) = value.as_object() else {
        return out;
    };
    for (url, node) in obj {
        let links = node
            .get("links")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .map(|v| clean(v, 1600))
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>();
        out.insert(clean(url, 1600), links);
    }
    out
}

fn domain_of(url: &str) -> String {
    if url.starts_with("file://") {
        return "file".to_string();
    }
    clean(
        url.split("://")
            .nth(1)
            .unwrap_or(url)
            .split('/')
            .next()
            .unwrap_or("unknown"),
        120,
    )
    .to_ascii_lowercase()
}

pub fn run_spider(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let contract = read_json_or(
        root,
        SPIDER_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "rule_spider_contract",
            "default_max_depth": 3,
            "default_max_links": 512
        }),
    );
    let graph_json =
        match parse_json_flag_or_path(root, parsed, "graph-json", "graph-path", json!({})) {
            Ok(v) => v,
            Err(err) => {
                return json!({
                    "ok": false,
                    "strict": strict,
                    "type": "research_plane_rule_spider",
                    "errors": [err]
                });
            }
        };
    let graph = parse_graph(graph_json);
    let seeds = parse_list_flag(parsed, "seed-urls", 1800);
    let allow_rules = parse_list_flag(parsed, "allow-rules", 220);
    let deny_rules = parse_list_flag(parsed, "deny-rules", 220);
    let allowed_domains = parse_list_flag(parsed, "allowed-domains", 220)
        .into_iter()
        .map(|v| v.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let max_depth = parse_u64(
        parsed.flags.get("max-depth"),
        contract
            .get("default_max_depth")
            .and_then(Value::as_u64)
            .unwrap_or(3),
    )
    .clamp(1, 20);
    let max_links = parse_u64(
        parsed.flags.get("max-links"),
        contract
            .get("default_max_links")
            .and_then(Value::as_u64)
            .unwrap_or(512),
    )
    .clamp(1, 50_000);

    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("rule_spider_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "rule_spider_contract"
    {
        errors.push("rule_spider_contract_kind_invalid".to_string());
    }
    if seeds.is_empty() {
        errors.push("missing_seed_urls".to_string());
    }
    if graph.is_empty() {
        errors.push("missing_graph_fixture".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "research_plane_rule_spider",
            "errors": errors
        });
    }

    let mut queue = VecDeque::<(String, u64)>::new();
    for seed in seeds {
        queue.push_back((seed, 0));
    }
    let mut visited = BTreeSet::<String>::new();
    let mut per_link = Vec::<Value>::new();

    while let Some((url, depth)) = queue.pop_front() {
        if visited.len() as u64 >= max_links {
            break;
        }
        if depth > max_depth || visited.contains(&url) {
            continue;
        }
        visited.insert(url.clone());
        let links = graph.get(&url).cloned().unwrap_or_default();
        for next in links {
            let next_domain = domain_of(&next);
            let denied = deny_rules.iter().any(|rule| pattern_match(&next, rule));
            let allow_match = if allow_rules.is_empty() {
                true
            } else {
                allow_rules.iter().any(|rule| pattern_match(&next, rule))
            };
            let domain_allowed = if allowed_domains.is_empty() {
                true
            } else {
                allowed_domains.iter().any(|d| d == &next_domain)
            };
            let decision = !denied && allow_match && domain_allowed && depth < max_depth;
            let reason = if denied {
                "deny_rule"
            } else if !allow_match {
                "allow_rule_miss"
            } else if !domain_allowed {
                "domain_not_allowed"
            } else if depth >= max_depth {
                "max_depth_reached"
            } else {
                "accepted"
            };
            per_link.push(json!({
                "from": url,
                "to": next,
                "depth": depth.saturating_add(1),
                "decision": if decision { "enqueue" } else { "drop" },
                "reason": reason
            }));
            if decision {
                queue.push_back((next, depth.saturating_add(1)));
            }
        }
    }

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "research_plane_rule_spider",
        "lane": "core/layer0/ops",
        "visited_count": visited.len(),
        "visited": visited,
        "per_link_receipts": per_link,
        "limits": {"max_depth": max_depth, "max_links": max_links},
        "claim_evidence": [
            {
                "id": "V6-RESEARCH-002.1",
                "claim": "rule_based_spider_enforces_allow_deny_depth_domain_with_per_link_receipts",
                "evidence": {"visited_count": visited.len()}
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run_middleware(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let contract = read_json_or(
        root,
        MIDDLEWARE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "middleware_stack_contract",
            "ordered_hooks": ["before_request","after_response"]
        }),
    );
    let request_json = parse_json_flag_or_path(
        root,
        parsed,
        "request-json",
        "request-path",
        json!({"url":"https://example.com","headers":{}}),
    );
    let response_json = parse_json_flag_or_path(
        root,
        parsed,
        "response-json",
        "response-path",
        json!({"status":200,"body":"<html></html>"}),
    );
    let stack_json = parse_json_flag_or_path(
        root,
        parsed,
        "stack-json",
        "stack-path",
        json!([
            {"id":"ua_injector","hook":"before_request","set_header":{"User-Agent":"InfRing/1.0"}},
            {"id":"html_compact","hook":"after_response","compact_body":true}
        ]),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("middleware_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "middleware_stack_contract"
    {
        errors.push("middleware_contract_kind_invalid".to_string());
    }
    let mut request = request_json.unwrap_or_else(|err| {
        errors.push(err);
        json!({})
    });
    let mut response = response_json.unwrap_or_else(|err| {
        errors.push(err);
        json!({})
    });
    let stack = stack_json.unwrap_or_else(|err| {
        errors.push(err);
        json!([])
    });
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "research_plane_middleware",
            "errors": errors
        });
    }
    let mut lifecycle = Vec::<Value>::new();
    for row in stack.as_array().cloned().unwrap_or_default() {
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .map(|v| clean(v, 120))
            .unwrap_or_else(|| "unnamed".to_string());
        let hook = row
            .get("hook")
            .and_then(Value::as_str)
            .map(|v| clean(v, 64).to_ascii_lowercase())
            .unwrap_or_else(|| "before_request".to_string());
        if hook == "before_request" {
            if let Some(set_header) = row.get("set_header").and_then(Value::as_object) {
                if !request
                    .get("headers")
                    .map(Value::is_object)
                    .unwrap_or(false)
                {
                    request["headers"] = Value::Object(Map::new());
                }
                for (k, v) in set_header {
                    request["headers"][clean(k, 120)] = Value::String(clean(v.to_string(), 240));
                }
            }
        } else if hook == "after_response" {
            let compact_from_str = row
                .get("compact_body")
                .and_then(Value::as_str)
                .map(|v| {
                    matches!(
                        v.trim().to_ascii_lowercase().as_str(),
                        "1" | "true" | "yes" | "on"
                    )
                })
                .unwrap_or(false);
            let compact_from_bool = row
                .get("compact_body")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if compact_from_str || compact_from_bool {
                let compact = response
                    .get("body")
                    .and_then(Value::as_str)
                    .map(strip_tags)
                    .unwrap_or_default();
                response["body_compact"] = Value::String(clean(compact, 4000));
            }
        }
        lifecycle.push(json!({
            "middleware_id": id,
            "hook": hook,
            "ts": now_iso()
        }));
    }

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "research_plane_middleware",
        "lane": "core/layer0/ops",
        "request": request,
        "response": response,
        "lifecycle_receipts": lifecycle,
        "claim_evidence": [
            {
                "id": "V6-RESEARCH-002.2",
                "claim": "ordered_downloader_and_spider_middleware_hooks_emit_deterministic_lifecycle_receipts",
                "evidence": {"hooks": lifecycle.len()}
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run_pipeline(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let contract = read_json_or(
        root,
        PIPELINE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "item_pipeline_contract",
            "stages": ["validate","dedupe","enrich"],
            "allowed_export_formats": ["json","csv"]
        }),
    );
    let items_json = parse_json_flag_or_path(root, parsed, "items-json", "items-path", json!([]));
    let pipeline_json = parse_json_flag_or_path(
        root,
        parsed,
        "pipeline-json",
        "pipeline-path",
        json!([
            {"stage":"validate","required_fields":["url","title"]},
            {"stage":"dedupe","key":"url"},
            {"stage":"enrich","add":{"source":"research"}}
        ]),
    );
    let export_format = clean(
        parsed
            .flags
            .get("export-format")
            .cloned()
            .unwrap_or_else(|| "json".to_string()),
        16,
    )
    .to_ascii_lowercase();
    let export_path_rel = parsed.flags.get("export-path").cloned().unwrap_or_else(|| {
        state_root(root)
            .join("pipeline")
            .join(format!("latest.{export_format}"))
            .display()
            .to_string()
    });
    let export_path = if Path::new(&export_path_rel).is_absolute() {
        PathBuf::from(&export_path_rel)
    } else {
        root.join(&export_path_rel)
    };

    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("pipeline_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "item_pipeline_contract"
    {
        errors.push("pipeline_contract_kind_invalid".to_string());
    }
    let allowed_formats = contract
        .get("allowed_export_formats")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|v| v.to_ascii_lowercase())
        .collect::<Vec<_>>();
    if !allowed_formats.iter().any(|v| v == &export_format) {
        errors.push("export_format_not_allowed".to_string());
    }
    let mut items = items_json.unwrap_or_else(|err| {
        errors.push(err);
        json!([])
    });
    let pipeline = pipeline_json.unwrap_or_else(|err| {
        errors.push(err);
        json!([])
    });
    if !items.is_array() {
        errors.push("items_payload_must_be_array".to_string());
        items = json!([]);
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "research_plane_item_pipeline",
            "errors": errors
        });
    }

    let mut stage_receipts = Vec::<Value>::new();
    let mut rows = items.as_array().cloned().unwrap_or_default();
    for stage in pipeline.as_array().cloned().unwrap_or_default() {
        let stage_name = stage
            .get("stage")
            .and_then(Value::as_str)
            .map(|v| v.to_ascii_lowercase())
            .unwrap_or_else(|| "unknown".to_string());
        let before = rows.len();
        if stage_name == "validate" {
            let required = stage
                .get("required_fields")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(Value::as_str)
                .map(|v| v.to_string())
                .collect::<Vec<_>>();
            rows.retain(|row| {
                required
                    .iter()
                    .all(|k| row.get(k).map(|v| !v.is_null()).unwrap_or(false))
            });
        } else if stage_name == "dedupe" {
            let key = stage
                .get("key")
                .and_then(Value::as_str)
                .map(|v| v.to_string())
                .unwrap_or_else(|| "url".to_string());
            let mut seen = BTreeSet::<String>::new();
            rows.retain(|row| {
                let v = row
                    .get(&key)
                    .map(|x| clean(x.to_string(), 600))
                    .unwrap_or_default();
                if v.is_empty() || seen.contains(&v) {
                    false
                } else {
                    seen.insert(v);
                    true
                }
            });
        } else if stage_name == "enrich" {
            let add = stage
                .get("add")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for row in &mut rows {
                if !row.is_object() {
                    continue;
                }
                for (k, v) in &add {
                    row[k] = v.clone();
                }
            }
        }
        stage_receipts.push(json!({
            "stage": stage_name,
            "before": before,
            "after": rows.len()
        }));
    }
    if let Some(parent) = export_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let export_body = if export_format == "csv" {
        let headers = rows
            .iter()
            .filter_map(Value::as_object)
            .flat_map(|row| row.keys().cloned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let mut lines = vec![headers.join(",")];
        for row in &rows {
            let obj = row.as_object().cloned().unwrap_or_default();
            let line = headers
                .iter()
                .map(|h| clean(obj.get(h).cloned().unwrap_or(Value::Null).to_string(), 600))
                .collect::<Vec<_>>()
                .join(",");
            lines.push(line);
        }
        lines.join("\n")
    } else {
        serde_json::to_string_pretty(&rows).unwrap_or_else(|_| "[]".to_string())
    };
    let _ = fs::write(&export_path, format!("{export_body}\n"));

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "research_plane_item_pipeline",
        "lane": "core/layer0/ops",
        "stage_receipts": stage_receipts,
        "item_count": rows.len(),
        "export": {
            "format": export_format,
            "path": export_path.display().to_string(),
            "sha256": sha256_hex_str(&export_body)
        },
        "claim_evidence": [
            {
                "id": "V6-RESEARCH-002.3",
                "claim": "item_pipeline_stages_and_feed_exporters_are_governed_and_receipted",
                "evidence": {"stages": stage_receipts.len()}
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run_signals(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let contract = read_json_or(
        root,
        SIGNAL_BUS_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "signal_bus_contract",
            "supported_signals": ["spider_opened","item_scraped","spider_closed"]
        }),
    );
    let events_json = parse_json_flag_or_path(
        root,
        parsed,
        "events-json",
        "events-path",
        json!([
            {"signal":"spider_opened","payload":{"spider_id":"default"}},
            {"signal":"item_scraped","payload":{"url":"https://example.com"}}
        ]),
    );
    let handlers_json = parse_json_flag_or_path(
        root,
        parsed,
        "handlers-json",
        "handlers-path",
        json!([
            {"id":"metrics","signal":"item_scraped"},
            {"id":"lifecycle","signal":"spider_opened"}
        ]),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("signal_bus_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "signal_bus_contract"
    {
        errors.push("signal_bus_contract_kind_invalid".to_string());
    }
    let events = events_json.unwrap_or_else(|err| {
        errors.push(err);
        json!([])
    });
    let handlers = handlers_json.unwrap_or_else(|err| {
        errors.push(err);
        json!([])
    });
    if !events.is_array() || !handlers.is_array() {
        errors.push("signal_payloads_must_be_arrays".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "research_plane_signal_bus",
            "errors": errors
        });
    }

    let supported = contract
        .get("supported_signals")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|v| v.to_string())
        .collect::<BTreeSet<_>>();

    let mut dispatch = Vec::<Value>::new();
    for event in events.as_array().cloned().unwrap_or_default() {
        let signal = event
            .get("signal")
            .and_then(Value::as_str)
            .map(|v| v.to_string())
            .unwrap_or_default();
        if !supported.contains(&signal) {
            dispatch.push(json!({
                "signal": signal,
                "status": "rejected",
                "reason": "unsupported_signal"
            }));
            continue;
        }
        let matched = handlers
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|h| h.get("signal").and_then(Value::as_str) == Some(signal.as_str()))
            .map(|h| {
                json!({
                    "handler_id": h.get("id").and_then(Value::as_str).unwrap_or("anonymous"),
                    "signal": signal
                })
            })
            .collect::<Vec<_>>();
        dispatch.push(json!({
            "signal": signal,
            "status": "dispatched",
            "handler_count": matched.len(),
            "handlers": matched
        }));
    }

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "research_plane_signal_bus",
        "lane": "core/layer0/ops",
        "dispatch_receipts": dispatch,
        "claim_evidence": [
            {
                "id": "V6-RESEARCH-002.4",
                "claim": "signal_bus_dispatches_policy_gated_events_with_deterministic_receipts",
                "evidence": {"events": events.as_array().map(|v| v.len()).unwrap_or(0)}
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run_console(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let contract = read_json_or(
        root,
        CONSOLE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "crawl_console_contract",
            "default_token_env": "RESEARCH_CONSOLE_TOKEN",
            "allow_ops": ["status","stats","queue","pause","resume","enqueue"]
        }),
    );
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "status".to_string()),
        64,
    )
    .to_ascii_lowercase();
    let token_env = contract
        .get("default_token_env")
        .and_then(Value::as_str)
        .unwrap_or("RESEARCH_CONSOLE_TOKEN");
    let expected = std::env::var(token_env).unwrap_or_else(|_| "local-dev-token".to_string());
    let supplied = parsed.flags.get("auth-token").cloned().unwrap_or_default();
    let auth_ok = !expected.is_empty() && supplied == expected;

    let allowed_ops = contract
        .get("allow_ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|v| v.to_ascii_lowercase())
        .collect::<Vec<_>>();
    if !allowed_ops.iter().any(|v| v == &op) {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "research_plane_console",
            "errors": ["console_op_not_allowed"]
        });
    }

    let console_state_path = state_root(root).join("console").join("state.json");
    let mut state = read_json(&console_state_path).unwrap_or_else(|| {
        json!({
            "paused": false,
            "queue": [],
            "last_op": "init",
            "updated_at": now_iso()
        })
    });
    if !auth_ok {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "research_plane_console",
            "op": op,
            "auth": "denied",
            "errors": ["auth_failed"],
            "claim_evidence": [
                {
                    "id": "V6-RESEARCH-002.5",
                    "claim": "crawl_console_requires_authenticated_control_path",
                    "evidence": {"op": op}
                }
            ]
        });
    }

    if op == "pause" {
        state["paused"] = Value::Bool(true);
    } else if op == "resume" {
        state["paused"] = Value::Bool(false);
    } else if op == "enqueue" {
        let url = clean(parsed.flags.get("url").cloned().unwrap_or_default(), 1800);
        if !url.is_empty() {
            if !state.get("queue").map(Value::is_array).unwrap_or(false) {
                state["queue"] = Value::Array(Vec::new());
            }
            state["queue"]
                .as_array_mut()
                .expect("queue array")
                .push(Value::String(url));
        }
    }
    state["last_op"] = Value::String(op.clone());
    state["updated_at"] = Value::String(now_iso());
    let _ = write_json(&console_state_path, &state);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "research_plane_console",
        "lane": "core/layer0/ops",
        "op": op,
        "auth": "ok",
        "state": state,
        "stats": {
            "paused": state.get("paused").and_then(Value::as_bool).unwrap_or(false),
            "queue_len": state.get("queue").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0)
        },
        "claim_evidence": [
            {
                "id": "V6-RESEARCH-002.5",
                "claim": "authenticated_console_controls_pause_resume_queue_with_receipts",
                "evidence": {"op": op}
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run_template_governance(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let conduit = conduit_enforcement(root, parsed, strict, "template_governance");
    if strict && !conduit.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "research_plane_template_governance",
            "errors": ["conduit_bypass_rejected"],
            "conduit_enforcement": conduit
        });
    }

    let contract = read_json_or(
        root,
        TEMPLATE_GOVERNANCE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "template_governance_contract",
            "required_human_review": true,
            "required_reviewer": "operator",
            "signature_env": "RESEARCH_TEMPLATE_SIGNING_KEY"
        }),
    );
    let manifest_rel = parsed
        .flags
        .get("manifest")
        .cloned()
        .unwrap_or_else(|| TEMPLATE_MANIFEST_PATH.to_string());
    let manifest = read_json_or(root, &manifest_rel, Value::Null);
    let templates_root = parsed
        .flags
        .get("templates-root")
        .map(|v| {
            if Path::new(v).is_absolute() {
                PathBuf::from(v)
            } else {
                root.join(v)
            }
        })
        .unwrap_or_else(|| {
            root.join("planes")
                .join("contracts")
                .join("research")
                .join("templates")
        });

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
        != "template_governance_contract"
    {
        errors.push("template_governance_contract_kind_invalid".to_string());
    }
    if manifest.is_null() {
        errors.push("template_manifest_missing".to_string());
    }
    let required_reviewer = contract
        .get("required_reviewer")
        .and_then(Value::as_str)
        .unwrap_or("operator")
        .to_string();
    let required_human_review = contract
        .get("required_human_review")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let signature_env = contract
        .get("signature_env")
        .and_then(Value::as_str)
        .unwrap_or("RESEARCH_TEMPLATE_SIGNING_KEY")
        .to_string();
    let signature_required = contract
        .get("signature_required")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let signing_key = std::env::var(&signature_env).unwrap_or_default();

    let templates = manifest
        .get("templates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if templates.is_empty() {
        errors.push("template_manifest_entries_required".to_string());
    }

    let mut checks = Vec::<Value>::new();
    for row in templates {
        let rel = row
            .get("path")
            .and_then(Value::as_str)
            .map(|v| clean(v, 400))
            .unwrap_or_default();
        let reviewer = row
            .get("reviewed_by")
            .and_then(Value::as_str)
            .map(|v| clean(v, 120))
            .unwrap_or_default();
        let approved = row
            .get("human_reviewed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let path = templates_root.join(&rel);
        let exists = path.exists();
        let file_hash = fs::read_to_string(&path)
            .ok()
            .map(|raw| sha256_hex_str(&raw))
            .unwrap_or_default();
        let expected_hash = row
            .get("sha256")
            .and_then(Value::as_str)
            .map(|v| clean(v, 128))
            .unwrap_or_default();
        let hash_ok = !expected_hash.is_empty() && file_hash.eq_ignore_ascii_case(&expected_hash);
        if !exists {
            errors.push(format!("missing_template::{rel}"));
        }
        if required_human_review && (!approved || reviewer != required_reviewer) {
            errors.push(format!("review_gate_failed::{rel}"));
        }
        if !hash_ok {
            errors.push(format!("hash_mismatch::{rel}"));
        }
        checks.push(json!({
            "path": rel,
            "exists": exists,
            "hash_ok": hash_ok,
            "approved": approved,
            "reviewed_by": reviewer
        }));
    }

    let signature = manifest
        .get("signature")
        .and_then(Value::as_str)
        .map(|v| clean(v, 300))
        .unwrap_or_default();
    if signature_required && signing_key.is_empty() {
        errors.push("manifest_signature_key_missing".to_string());
    } else if !signing_key.is_empty() {
        let mut basis = manifest.clone();
        if let Some(obj) = basis.as_object_mut() {
            obj.remove("signature");
        }
        let expected = format!(
            "sig:{}",
            sha256_hex_str(&format!("{signing_key}:{}", basis))
        );
        if expected != signature {
            errors.push("manifest_signature_invalid".to_string());
        }
    }

    let ok = errors.is_empty();
    let mut out = json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "type": "research_plane_template_governance",
        "lane": "core/layer0/ops",
        "manifest_path": manifest_rel,
        "templates_root": templates_root.display().to_string(),
        "checks": checks,
        "conduit_enforcement": conduit,
        "errors": errors,
        "claim_evidence": [
            {
                "id": "V6-RESEARCH-002.6",
                "claim": "template_pack_updates_are_governed_by_review_provenance_and_conduit_only_boundary_checks",
                "evidence": {
                    "manifest_path": manifest_rel,
                    "conduit": true
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safety_gate_denies_when_budget_exhausted() {
        let root = tempfile::tempdir().expect("tempdir");
        let policy = json!({
            "safety_plane": {
                "enabled": true,
                "required_modes": ["stealth"],
                "allow_actions": ["research_fetch:*"],
                "max_requests_per_mode": {"stealth": 1}
            }
        });
        let first = safety_gate_receipt(
            root.path(),
            &policy,
            "stealth",
            "research_fetch:auto",
            "x",
            true,
        );
        let second = safety_gate_receipt(
            root.path(),
            &policy,
            "stealth",
            "research_fetch:auto",
            "x",
            true,
        );
        assert_eq!(first.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(second.get("ok").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn spider_enqueues_links_with_rules() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = crate::parse_args(&[
            "spider".to_string(),
            "--graph-json={\"https://a.test\":{\"links\":[\"https://a.test/x\",\"https://b.test/y\"]},\"https://a.test/x\":{\"links\":[]},\"https://b.test/y\":{\"links\":[]}}".to_string(),
            "--seed-urls=https://a.test".to_string(),
            "--allowed-domains=a.test".to_string(),
        ]);
        let out = run_spider(root.path(), &parsed, true);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(out.get("visited_count").and_then(Value::as_u64), Some(2));
    }
}
