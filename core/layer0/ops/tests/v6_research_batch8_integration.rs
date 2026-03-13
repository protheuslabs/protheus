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

fn write_signed_manifest(
    manifest_path: &Path,
    templates: Vec<Value>,
    kind: &str,
    signing_key: &str,
) {
    let mut manifest = json!({
        "version": "v1",
        "kind": kind,
        "pack": "integration-pack",
        "updated_at": "2026-03-13T00:00:00Z",
        "templates": templates,
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
    write_json(manifest_path, &manifest);
}

#[test]
fn v6_research_batch8_strict_lanes_execute_with_receipts() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let parallel_exit = research_plane::run(
        root,
        &[
            "parallel-scrape-workers".to_string(),
            "--strict=1".to_string(),
            "--targets=https://a.test/one,https://a.test/retry-two".to_string(),
            "--session-ids=s-alpha,s-beta".to_string(),
            "--max-concurrency=2".to_string(),
            "--max-retries=1".to_string(),
        ],
    );
    assert_eq!(parallel_exit, 0);
    let parallel_latest = read_json(&latest_path(root));
    assert_eq!(
        parallel_latest.get("type").and_then(Value::as_str),
        Some("research_plane_parallel_scrape_workers")
    );
    assert_eq!(
        parallel_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&parallel_latest, "V6-RESEARCH-005.4");
    assert_claim(&parallel_latest, "V6-RESEARCH-005.6");

    let book_root = root
        .join("planes")
        .join("contracts")
        .join("research")
        .join("book_patterns_templates");
    fs::create_dir_all(&book_root).expect("mkdir book templates");
    let b1 = book_root.join("login_form_pattern.json");
    let b2 = book_root.join("paginated_listing_pattern.json");
    fs::write(
        &b1,
        "{\"name\":\"login_form_pattern\",\"actions\":[{\"op\":\"fill\"}]}\n",
    )
    .expect("write b1");
    fs::write(
        &b2,
        "{\"name\":\"paginated_listing_pattern\",\"actions\":[{\"op\":\"next_page\"}]}\n",
    )
    .expect("write b2");
    let h1 = sha256_hex_str(&fs::read_to_string(&b1).expect("read b1"));
    let h2 = sha256_hex_str(&fs::read_to_string(&b2).expect("read b2"));
    let book_signing_key = "batch8-book-signing-key";
    write_signed_manifest(
        &root
            .join("planes")
            .join("contracts")
            .join("research")
            .join("book_patterns_template_pack_manifest_v1.json"),
        vec![
            json!({
                "path": "login_form_pattern.json",
                "human_reviewed": true,
                "reviewed_by": "operator",
                "review_cadence_days": 90,
                "sha256": h1
            }),
            json!({
                "path": "paginated_listing_pattern.json",
                "human_reviewed": true,
                "reviewed_by": "operator",
                "review_cadence_days": 90,
                "sha256": h2
            }),
        ],
        "book_patterns_template_pack_manifest",
        book_signing_key,
    );
    std::env::set_var("BOOK_PATTERNS_TEMPLATE_SIGNING_KEY", book_signing_key);

    let book_exit = research_plane::run(
        root,
        &[
            "book-patterns-template-governance".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(book_exit, 0);
    let book_latest = read_json(&latest_path(root));
    assert_eq!(
        book_latest.get("type").and_then(Value::as_str),
        Some("research_plane_book_patterns_template_governance")
    );
    assert_eq!(book_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&book_latest, "V6-RESEARCH-005.5");

    let decode_single_exit = research_plane::run(
        root,
        &[
            "decode-news-url".to_string(),
            "--strict=1".to_string(),
            "--url=https://news.google.com/read/ABC?continue=https%3A%2F%2Fexample.com%2Ffallback"
                .to_string(),
            "--proxy-mode=https".to_string(),
            "--proxies=p1,p2".to_string(),
            "--interval-ms=200".to_string(),
            "--backoff-ms=400".to_string(),
        ],
    );
    assert_eq!(decode_single_exit, 0);
    let decode_single_latest = read_json(&latest_path(root));
    assert_eq!(
        decode_single_latest.get("type").and_then(Value::as_str),
        Some("research_plane_decode_news_url")
    );
    assert_eq!(
        decode_single_latest
            .get("decoded_url")
            .and_then(Value::as_str),
        Some("https://example.com/fallback")
    );
    assert_claim(&decode_single_latest, "V6-RESEARCH-006.2");
    assert_claim(&decode_single_latest, "V6-RESEARCH-006.3");

    let urls_file = root.join("fixtures").join("decode_urls.txt");
    if let Some(parent) = urls_file.parent() {
        fs::create_dir_all(parent).expect("mkdir decode fixture");
    }
    fs::write(
        &urls_file,
        "https://news.google.com/read/AAA?continue=https%3A%2F%2Fgood.example%2Fstory\nhttps://news.google.com/read/not-decodable\n",
    )
    .expect("write urls file");
    let decode_batch_exit = research_plane::run(
        root,
        &[
            "decode-news-urls".to_string(),
            "--strict=0".to_string(),
            format!("--urls-file={}", urls_file.display()),
            "--continue-on-error=1".to_string(),
            "--proxy-mode=http".to_string(),
            "--proxy=http://proxy.local:8080".to_string(),
        ],
    );
    assert_eq!(decode_batch_exit, 0);
    let decode_batch_latest = read_json(&latest_path(root));
    assert_eq!(
        decode_batch_latest.get("type").and_then(Value::as_str),
        Some("research_plane_decode_news_urls")
    );
    assert_eq!(
        decode_batch_latest
            .get("summary")
            .and_then(|v| v.get("processed"))
            .and_then(Value::as_u64),
        Some(2)
    );
    assert_eq!(
        decode_batch_latest
            .get("summary")
            .and_then(|v| v.get("failed"))
            .and_then(Value::as_u64),
        Some(1)
    );
    assert_claim(&decode_batch_latest, "V6-RESEARCH-006.4");
    assert_claim(&decode_batch_latest, "V6-RESEARCH-006.6");

    let decoder_root = root
        .join("planes")
        .join("contracts")
        .join("research")
        .join("news_decoder_templates");
    fs::create_dir_all(&decoder_root).expect("mkdir decoder templates");
    let d1 = decoder_root.join("articles_decode_template.json");
    let d2 = decoder_root.join("rss_fallback_template.json");
    fs::write(&d1, "{\"name\":\"articles_decode_template\"}\n").expect("write d1");
    fs::write(&d2, "{\"name\":\"rss_fallback_template\"}\n").expect("write d2");
    let dh1 = sha256_hex_str(&fs::read_to_string(&d1).expect("read d1"));
    let dh2 = sha256_hex_str(&fs::read_to_string(&d2).expect("read d2"));
    let decoder_signing_key = "batch8-decoder-signing-key";
    write_signed_manifest(
        &root
            .join("planes")
            .join("contracts")
            .join("research")
            .join("google_news_decoder_template_pack_manifest_v1.json"),
        vec![
            json!({
                "path": "articles_decode_template.json",
                "human_reviewed": true,
                "reviewed_by": "operator",
                "review_cadence_days": 90,
                "sha256": dh1
            }),
            json!({
                "path": "rss_fallback_template.json",
                "human_reviewed": true,
                "reviewed_by": "operator",
                "review_cadence_days": 90,
                "sha256": dh2
            }),
        ],
        "google_news_decoder_template_pack_manifest",
        decoder_signing_key,
    );
    std::env::set_var("NEWS_DECODER_TEMPLATE_SIGNING_KEY", decoder_signing_key);

    let decoder_template_exit = research_plane::run(
        root,
        &[
            "decoder-template-governance".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(decoder_template_exit, 0);
    let decoder_template_latest = read_json(&latest_path(root));
    assert_eq!(
        decoder_template_latest.get("type").and_then(Value::as_str),
        Some("research_plane_decoder_template_governance")
    );
    assert_eq!(
        decoder_template_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&decoder_template_latest, "V6-RESEARCH-006.5");

    std::env::remove_var("BOOK_PATTERNS_TEMPLATE_SIGNING_KEY");
    std::env::remove_var("NEWS_DECODER_TEMPLATE_SIGNING_KEY");
}

#[test]
fn v6_research_batch8_rejects_conduit_bypass_in_strict_mode() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let workers_exit = research_plane::run(
        root,
        &[
            "parallel-scrape-workers".to_string(),
            "--strict=1".to_string(),
            "--targets=https://a.test/one".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(workers_exit, 1);
    let workers_latest = read_json(&latest_path(root));
    assert_eq!(
        workers_latest.get("type").and_then(Value::as_str),
        Some("research_plane_parallel_scrape_workers")
    );
    assert!(workers_latest
        .get("errors")
        .and_then(Value::as_array)
        .map(|rows| rows
            .iter()
            .any(|r| r.as_str() == Some("conduit_bypass_rejected")))
        .unwrap_or(false));

    let decode_exit = research_plane::run(
        root,
        &[
            "decode-news-urls".to_string(),
            "--strict=1".to_string(),
            "--urls=https://news.google.com/read/a".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(decode_exit, 1);
    let decode_latest = read_json(&latest_path(root));
    assert_eq!(
        decode_latest.get("type").and_then(Value::as_str),
        Some("research_plane_decode_news_urls")
    );
    assert!(decode_latest
        .get("errors")
        .and_then(Value::as_array)
        .map(|rows| rows
            .iter()
            .any(|r| r.as_str() == Some("conduit_bypass_rejected")))
        .unwrap_or(false));
}
