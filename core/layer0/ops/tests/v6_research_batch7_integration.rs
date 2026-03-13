// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{research_plane, v8_kernel::sha256_hex_str};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;
use walkdir::WalkDir;

fn workspace_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .ancestors()
        .nth(3)
        .expect("workspace ancestor")
        .to_path_buf()
}

fn copy_tree(src: &Path, dst: &Path) {
    for entry in WalkDir::new(src).into_iter().filter_map(Result::ok) {
        let rel = entry.path().strip_prefix(src).expect("strip prefix");
        let out = dst.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&out).expect("mkdir");
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).expect("mkdir parent");
        }
        fs::copy(entry.path(), &out).expect("copy file");
    }
}

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("mkdir");
    }
    let mut body = serde_json::to_string_pretty(value).expect("encode");
    body.push('\n');
    fs::write(path, body).expect("write");
}

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read");
    serde_json::from_str(&raw).expect("parse")
}

fn stage_fixture_root() -> TempDir {
    let workspace = workspace_root();
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();

    copy_tree(
        &workspace.join("planes").join("contracts"),
        &root.join("planes").join("contracts"),
    );
    copy_tree(
        &workspace.join("client").join("runtime").join("config"),
        &root.join("client").join("runtime").join("config"),
    );
    tmp
}

fn latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("research_plane")
        .join("latest.json")
}

fn assert_claim(payload: &Value, claim_id: &str) {
    let has = payload
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some(claim_id));
    assert!(has, "missing claim evidence id={claim_id}");
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
    serde_json::to_string(&canonicalize_json(value)).expect("encode canonical")
}

#[test]
fn v6_research_batch7_strict_lanes_execute_with_receipts() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let goal_exit = research_plane::run(
        root,
        &[
            "goal-crawl".to_string(),
            "--strict=1".to_string(),
            "--goal=memory coherence".to_string(),
            "--catalog-json={".to_string()
                + "\"memory\":[\"https://a.test/memory\"],"
                + "\"coherence\":[\"https://a.test/coherence\"]"
                + "}",
            "--max-pages=2".to_string(),
        ],
    );
    assert_eq!(goal_exit, 0);
    let goal_latest = read_json(&latest_path(root));
    assert_eq!(
        goal_latest.get("type").and_then(Value::as_str),
        Some("research_plane_goal_crawl")
    );
    assert_eq!(goal_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&goal_latest, "V6-RESEARCH-004.1");
    assert_claim(&goal_latest, "V6-RESEARCH-004.6");

    let map_exit = research_plane::run(
        root,
        &[
            "map-site".to_string(),
            "--strict=1".to_string(),
            "--domain=a.test".to_string(),
            "--depth=2".to_string(),
            "--graph-json={\"https://a.test\":[\"https://a.test/about\",\"https://a.test/blog\"],\"https://a.test/about\":[],\"https://a.test/blog\":[]}".to_string(),
        ],
    );
    assert_eq!(map_exit, 0);
    let map_latest = read_json(&latest_path(root));
    assert_eq!(
        map_latest.get("type").and_then(Value::as_str),
        Some("research_plane_site_map")
    );
    assert_eq!(map_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&map_latest, "V6-RESEARCH-004.2");

    let html_path = root.join("fixtures").join("batch7_extract.html");
    if let Some(parent) = html_path.parent() {
        fs::create_dir_all(parent).expect("mkdir html fixture");
    }
    fs::write(
        &html_path,
        "<html><head><title>Batch7 Extract</title></head><body><main>structured extraction payload</main><a href=\"https://a.test/doc\">doc</a></body></html>",
    )
    .expect("write html fixture");

    let extract_exit = research_plane::run(
        root,
        &[
            "extract-structured".to_string(),
            "--strict=1".to_string(),
            format!("--payload-path={}", html_path.display()),
            "--schema-json={\"fields\":[{\"name\":\"title\",\"required\":true},{\"name\":\"summary\",\"required\":true},{\"name\":\"links\",\"required\":false}]}".to_string(),
        ],
    );
    assert_eq!(extract_exit, 0);
    let extract_latest = read_json(&latest_path(root));
    assert_eq!(
        extract_latest.get("type").and_then(Value::as_str),
        Some("research_plane_extract_structured")
    );
    assert_eq!(
        extract_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert!(
        extract_latest
            .get("markdown")
            .and_then(Value::as_str)
            .map(|v| v.contains("title"))
            .unwrap_or(false),
        "extract lane should return markdown output"
    );
    assert_claim(&extract_latest, "V6-RESEARCH-004.3");

    let monitor_one = research_plane::run(
        root,
        &[
            "monitor".to_string(),
            "--strict=1".to_string(),
            "--url=https://example.com/feed".to_string(),
            "--content=alpha".to_string(),
        ],
    );
    assert_eq!(monitor_one, 0);
    let monitor_two = research_plane::run(
        root,
        &[
            "monitor".to_string(),
            "--strict=1".to_string(),
            "--url=https://example.com/feed".to_string(),
            "--content=beta".to_string(),
        ],
    );
    assert_eq!(monitor_two, 0);
    let monitor_latest = read_json(&latest_path(root));
    assert_eq!(
        monitor_latest.get("type").and_then(Value::as_str),
        Some("research_plane_monitor")
    );
    assert_eq!(
        monitor_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        monitor_latest
            .get("delta")
            .and_then(|v| v.get("changed"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&monitor_latest, "V6-RESEARCH-004.4");

    let firecrawl_root = root
        .join("planes")
        .join("contracts")
        .join("research")
        .join("firecrawl_templates");
    fs::create_dir_all(&firecrawl_root).expect("mkdir firecrawl templates");
    let t1 = firecrawl_root.join("news_discovery_firecrawl.json");
    let t2 = firecrawl_root.join("docs_sync_firecrawl.json");
    fs::write(&t1, "{\"name\":\"news_discovery_firecrawl\",\"depth\":3}\n").expect("write t1");
    fs::write(&t2, "{\"name\":\"docs_sync_firecrawl\",\"depth\":4}\n").expect("write t2");
    let h1 = sha256_hex_str(&fs::read_to_string(&t1).expect("read t1"));
    let h2 = sha256_hex_str(&fs::read_to_string(&t2).expect("read t2"));

    let signing_key = "batch7-firecrawl-signing-key";
    let mut manifest = json!({
        "version": "v1",
        "kind": "firecrawl_template_pack_manifest",
        "pack": "firecrawl-curated-core",
        "updated_at": "2026-03-13T00:00:00Z",
        "templates": [
            {
                "path": "news_discovery_firecrawl.json",
                "human_reviewed": true,
                "reviewed_by": "operator",
                "sha256": h1
            },
            {
                "path": "docs_sync_firecrawl.json",
                "human_reviewed": true,
                "reviewed_by": "operator",
                "sha256": h2
            }
        ],
        "signature": ""
    });
    let mut basis = manifest.clone();
    if let Some(obj) = basis.as_object_mut() {
        obj.remove("signature");
    }
    let signature = format!(
        "sig:{}",
        sha256_hex_str(&format!(
            "{}:{}",
            signing_key,
            canonical_json_string(&basis)
        ))
    );
    manifest["signature"] = Value::String(signature);

    write_json(
        &root
            .join("planes")
            .join("contracts")
            .join("research")
            .join("firecrawl_template_pack_manifest_v1.json"),
        &manifest,
    );
    std::env::set_var("FIRECRAWL_TEMPLATE_SIGNING_KEY", signing_key);

    let firecrawl_exit = research_plane::run(
        root,
        &[
            "firecrawl-template-governance".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(firecrawl_exit, 0);
    let firecrawl_latest = read_json(&latest_path(root));
    assert_eq!(
        firecrawl_latest.get("type").and_then(Value::as_str),
        Some("research_plane_firecrawl_template_governance")
    );
    assert_eq!(
        firecrawl_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&firecrawl_latest, "V6-RESEARCH-004.5");

    let js_exit = research_plane::run(
        root,
        &[
            "js-scrape".to_string(),
            "--strict=1".to_string(),
            "--url=file://local".to_string(),
            "--html=<html><body><main>js scrape payload</main></body></html>".to_string(),
            "--wait-ms=500".to_string(),
            "--form-json=[{\"op\":\"fill\",\"field\":\"q\",\"value\":\"test\"}]".to_string(),
        ],
    );
    assert_eq!(js_exit, 0);
    let js_latest = read_json(&latest_path(root));
    assert_eq!(
        js_latest.get("type").and_then(Value::as_str),
        Some("research_plane_js_scrape")
    );
    assert_eq!(js_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&js_latest, "V6-RESEARCH-005.1");

    let session_id = "batch7-session-1";
    let open_exit = research_plane::run(
        root,
        &[
            "auth-session".to_string(),
            "--strict=1".to_string(),
            "--op=open".to_string(),
            format!("--session-id={session_id}"),
        ],
    );
    assert_eq!(open_exit, 0);
    let login_exit = research_plane::run(
        root,
        &[
            "auth-session".to_string(),
            "--strict=1".to_string(),
            "--op=login".to_string(),
            format!("--session-id={session_id}"),
            "--username=operator".to_string(),
            "--password=secret".to_string(),
        ],
    );
    assert_eq!(login_exit, 0);
    let status_exit = research_plane::run(
        root,
        &[
            "auth-session".to_string(),
            "--strict=1".to_string(),
            "--op=status".to_string(),
            format!("--session-id={session_id}"),
        ],
    );
    assert_eq!(status_exit, 0);
    let auth_latest = read_json(&latest_path(root));
    assert_eq!(
        auth_latest.get("type").and_then(Value::as_str),
        Some("research_plane_auth_session")
    );
    assert_eq!(auth_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&auth_latest, "V6-RESEARCH-005.2");

    let close_exit = research_plane::run(
        root,
        &[
            "auth-session".to_string(),
            "--strict=1".to_string(),
            "--op=close".to_string(),
            format!("--session-id={session_id}"),
        ],
    );
    assert_eq!(close_exit, 0);

    let proxy_exit = research_plane::run(
        root,
        &[
            "proxy-rotate".to_string(),
            "--strict=1".to_string(),
            "--proxies=p1,p2,p3".to_string(),
            "--attempt-signals=captcha,ok".to_string(),
        ],
    );
    assert_eq!(proxy_exit, 0);
    let proxy_latest = read_json(&latest_path(root));
    assert_eq!(
        proxy_latest.get("type").and_then(Value::as_str),
        Some("research_plane_proxy_rotation")
    );
    assert_eq!(proxy_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&proxy_latest, "V6-RESEARCH-005.3");

    let decode_exit = research_plane::run(
        root,
        &[
            "decode-news-url".to_string(),
            "--strict=1".to_string(),
            "--url=https://news.google.com/read/ABC?url=https%3A%2F%2Fexample.com%2Fstory"
                .to_string(),
        ],
    );
    assert_eq!(decode_exit, 0);
    let decode_latest = read_json(&latest_path(root));
    assert_eq!(
        decode_latest.get("type").and_then(Value::as_str),
        Some("research_plane_decode_news_url")
    );
    assert_eq!(decode_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        decode_latest.get("decoded_url").and_then(Value::as_str),
        Some("https://example.com/story")
    );
    assert_claim(&decode_latest, "V6-RESEARCH-006.1");

    std::env::remove_var("FIRECRAWL_TEMPLATE_SIGNING_KEY");
}

#[test]
fn v6_research_batch7_rejects_conduit_bypass_in_strict_mode() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let exit = research_plane::run(
        root,
        &[
            "goal-crawl".to_string(),
            "--strict=1".to_string(),
            "--goal=test".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("research_plane_goal_crawl")
    );
    assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(false));
    assert!(latest
        .get("errors")
        .and_then(Value::as_array)
        .map(|rows| rows
            .iter()
            .any(|r| r.as_str() == Some("conduit_bypass_rejected")))
        .unwrap_or(false));
}
