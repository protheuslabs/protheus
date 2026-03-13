// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{research_plane, v8_kernel::sha256_hex_str};
use serde_json::{json, Value};
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

#[test]
fn v6_research_batch6_strict_commands_emit_receipts_and_contract_behavior() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let page_path = root.join("fixtures").join("batch6_page.html");
    if let Some(parent) = page_path.parent() {
        fs::create_dir_all(parent).expect("mkdir fixture");
    }
    fs::write(
        &page_path,
        "<html><head><title>Batch6 Research</title></head><body><main>adaptive extraction layer</main><a href=\"https://a.test/alpha\">alpha</a><a href=\"https://b.test/beta\">beta</a></body></html>",
    )
    .expect("write page");
    let page_url = format!("file://{}", page_path.display());

    let diagnostics_exit =
        research_plane::run(root, &["diagnostics".to_string(), "--strict=1".to_string()]);
    assert_eq!(diagnostics_exit, 0);
    let diagnostics_latest = read_json(&latest_path(root));
    assert_eq!(
        diagnostics_latest.get("type").and_then(Value::as_str),
        Some("research_plane_diagnostics")
    );
    assert_eq!(
        diagnostics_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&diagnostics_latest, "V6-RESEARCH-001.6");

    let fetch_exit = research_plane::run(
        root,
        &[
            "fetch".to_string(),
            "--strict=1".to_string(),
            "--stealth=1".to_string(),
            format!("--url={page_url}"),
        ],
    );
    assert_eq!(fetch_exit, 0);
    let fetch_latest = read_json(&latest_path(root));
    assert_eq!(
        fetch_latest.get("type").and_then(Value::as_str),
        Some("research_plane_fetch")
    );
    assert_eq!(fetch_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        fetch_latest.get("mode_selected").and_then(Value::as_str),
        Some("stealth")
    );
    assert!(
        fetch_latest
            .get("safety_plane_receipts")
            .and_then(Value::as_array)
            .map(|rows| !rows.is_empty())
            .unwrap_or(false),
        "fetch should emit at least one safety plane receipt"
    );
    assert_claim(&fetch_latest, "V6-RESEARCH-001.5");

    let mcp_exit = research_plane::run(
        root,
        &[
            "mcp-extract".to_string(),
            "--strict=1".to_string(),
            format!("--payload-path={}", page_path.display()),
            "--source=https://example.com/batch6".to_string(),
            "--query=batch6 extraction".to_string(),
        ],
    );
    assert_eq!(mcp_exit, 0);
    let mcp_latest = read_json(&latest_path(root));
    assert_eq!(
        mcp_latest.get("type").and_then(Value::as_str),
        Some("research_plane_mcp_extract")
    );
    assert_eq!(mcp_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert!(
        mcp_latest
            .get("artifacts")
            .and_then(|v| v.get("summary"))
            .and_then(Value::as_str)
            .map(|v| !v.is_empty())
            .unwrap_or(false),
        "mcp extraction must emit structured summary"
    );
    assert_claim(&mcp_latest, "V6-RESEARCH-001.4");

    let spider_exit = research_plane::run(
        root,
        &[
            "spider".to_string(),
            "--strict=1".to_string(),
            "--graph-json={\"https://a.test\":{\"links\":[\"https://a.test/alpha\",\"https://b.test/beta\"]},\"https://a.test/alpha\":{\"links\":[]},\"https://b.test/beta\":{\"links\":[]}}".to_string(),
            "--seed-urls=https://a.test".to_string(),
            "--allowed-domains=a.test".to_string(),
        ],
    );
    assert_eq!(spider_exit, 0);
    let spider_latest = read_json(&latest_path(root));
    assert_eq!(
        spider_latest.get("type").and_then(Value::as_str),
        Some("research_plane_rule_spider")
    );
    assert_eq!(spider_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert!(
        spider_latest
            .get("per_link_receipts")
            .and_then(Value::as_array)
            .map(|rows| !rows.is_empty())
            .unwrap_or(false),
        "spider must emit per-link receipts"
    );
    assert_claim(&spider_latest, "V6-RESEARCH-002.1");

    let middleware_exit = research_plane::run(
        root,
        &[
            "middleware".to_string(),
            "--strict=1".to_string(),
            "--request-json={\"url\":\"https://example.com\",\"headers\":{}}".to_string(),
            "--response-json={\"status\":200,\"body\":\"<html><body>ok</body></html>\"}".to_string(),
            "--stack-json=[{\"id\":\"ua\",\"hook\":\"before_request\",\"set_header\":{\"X-Test\":\"batch6\"}},{\"id\":\"compact\",\"hook\":\"after_response\",\"compact_body\":true}]".to_string(),
        ],
    );
    assert_eq!(middleware_exit, 0);
    let middleware_latest = read_json(&latest_path(root));
    assert_eq!(
        middleware_latest.get("type").and_then(Value::as_str),
        Some("research_plane_middleware")
    );
    assert_eq!(
        middleware_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&middleware_latest, "V6-RESEARCH-002.2");

    let export_path = root
        .join("state")
        .join("research")
        .join("batch6_pipeline.json");
    let pipeline_exit = research_plane::run(
        root,
        &[
            "pipeline".to_string(),
            "--strict=1".to_string(),
            "--items-json=[{\"url\":\"https://a.test\",\"title\":\"alpha\"},{\"url\":\"https://a.test\",\"title\":\"duplicate\"},{\"url\":\"https://b.test\",\"title\":\"beta\"}]".to_string(),
            "--pipeline-json=[{\"stage\":\"validate\",\"required_fields\":[\"url\",\"title\"]},{\"stage\":\"dedupe\",\"key\":\"url\"},{\"stage\":\"enrich\",\"add\":{\"source\":\"batch6\"}}]".to_string(),
            format!("--export-path={}", export_path.display()),
            "--export-format=json".to_string(),
        ],
    );
    assert_eq!(pipeline_exit, 0);
    let pipeline_latest = read_json(&latest_path(root));
    assert_eq!(
        pipeline_latest.get("type").and_then(Value::as_str),
        Some("research_plane_item_pipeline")
    );
    assert_eq!(
        pipeline_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert!(
        export_path.exists(),
        "pipeline exporter must write output artifact"
    );
    assert_claim(&pipeline_latest, "V6-RESEARCH-002.3");

    let signals_exit = research_plane::run(
        root,
        &[
            "signals".to_string(),
            "--strict=1".to_string(),
            "--events-json=[{\"signal\":\"spider_opened\",\"payload\":{}},{\"signal\":\"item_scraped\",\"payload\":{\"url\":\"https://a.test\"}}]".to_string(),
            "--handlers-json=[{\"id\":\"metrics\",\"signal\":\"item_scraped\"},{\"id\":\"lifecycle\",\"signal\":\"spider_opened\"}]".to_string(),
        ],
    );
    assert_eq!(signals_exit, 0);
    let signals_latest = read_json(&latest_path(root));
    assert_eq!(
        signals_latest.get("type").and_then(Value::as_str),
        Some("research_plane_signal_bus")
    );
    assert_eq!(
        signals_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&signals_latest, "V6-RESEARCH-002.4");

    std::env::set_var("RESEARCH_CONSOLE_TOKEN", "batch6-console-token");
    let console_exit = research_plane::run(
        root,
        &[
            "console".to_string(),
            "--strict=1".to_string(),
            "--op=pause".to_string(),
            "--auth-token=batch6-console-token".to_string(),
        ],
    );
    assert_eq!(console_exit, 0);
    let console_latest = read_json(&latest_path(root));
    assert_eq!(
        console_latest.get("type").and_then(Value::as_str),
        Some("research_plane_console")
    );
    assert_eq!(
        console_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        console_latest
            .get("state")
            .and_then(|v| v.get("paused"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&console_latest, "V6-RESEARCH-002.5");

    let templates_root = root
        .join("planes")
        .join("contracts")
        .join("research")
        .join("templates");
    fs::create_dir_all(&templates_root).expect("mkdir templates");
    let template_one_path = templates_root.join("news_monitor_spider.json");
    let template_two_path = templates_root.join("docs_assimilation_spider.json");
    fs::write(
        &template_one_path,
        "{\n  \"name\": \"news_monitor_spider\",\n  \"max_depth\": 3\n}\n",
    )
    .expect("write template one");
    fs::write(
        &template_two_path,
        "{\n  \"name\": \"docs_assimilation_spider\",\n  \"max_depth\": 4\n}\n",
    )
    .expect("write template two");

    let template_one_sha = sha256_hex_str(
        &fs::read_to_string(&template_one_path).expect("read template one for hash"),
    );
    let template_two_sha = sha256_hex_str(
        &fs::read_to_string(&template_two_path).expect("read template two for hash"),
    );

    let signing_key = "batch6-template-signing-key";
    let mut manifest = json!({
        "version": "v1",
        "kind": "research_template_pack_manifest",
        "pack": "scrapy-compatible-core",
        "updated_at": "2026-03-13T00:00:00Z",
        "templates": [
            {
                "path": "news_monitor_spider.json",
                "human_reviewed": true,
                "reviewed_by": "operator",
                "sha256": template_one_sha
            },
            {
                "path": "docs_assimilation_spider.json",
                "human_reviewed": true,
                "reviewed_by": "operator",
                "sha256": template_two_sha
            }
        ],
        "signature": ""
    });
    let mut basis = manifest.clone();
    if let Some(obj) = basis.as_object_mut() {
        obj.remove("signature");
    }
    let signature = format!("sig:{}", sha256_hex_str(&format!("{signing_key}:{basis}")));
    manifest["signature"] = Value::String(signature);

    write_json(
        &root
            .join("planes")
            .join("contracts")
            .join("research")
            .join("template_pack_manifest_v1.json"),
        &manifest,
    );
    std::env::set_var("RESEARCH_TEMPLATE_SIGNING_KEY", signing_key);

    let template_exit = research_plane::run(
        root,
        &["template-governance".to_string(), "--strict=1".to_string()],
    );
    assert_eq!(template_exit, 0);
    let template_latest = read_json(&latest_path(root));
    assert_eq!(
        template_latest.get("type").and_then(Value::as_str),
        Some("research_plane_template_governance")
    );
    assert_eq!(
        template_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert!(
        template_latest
            .get("checks")
            .and_then(Value::as_array)
            .map(|rows| rows.len() == 2)
            .unwrap_or(false),
        "template governance must validate both curated templates"
    );
    assert_claim(&template_latest, "V6-RESEARCH-002.6");
    assert_eq!(
        template_latest
            .get("conduit_enforcement")
            .and_then(|v| v.get("ok"))
            .and_then(Value::as_bool),
        Some(true),
        "template governance should report conduit enforcement success"
    );

    let mut invalid_manifest = manifest.clone();
    invalid_manifest["signature"] = Value::String("sig:invalid".to_string());
    write_json(
        &root
            .join("planes")
            .join("contracts")
            .join("research")
            .join("template_pack_manifest_v1.json"),
        &invalid_manifest,
    );
    let invalid_signature_exit = research_plane::run(
        root,
        &["template-governance".to_string(), "--strict=1".to_string()],
    );
    assert_eq!(invalid_signature_exit, 1);
    let invalid_signature_latest = read_json(&latest_path(root));
    assert_eq!(
        invalid_signature_latest.get("type").and_then(Value::as_str),
        Some("research_plane_template_governance")
    );
    assert_eq!(
        invalid_signature_latest.get("ok").and_then(Value::as_bool),
        Some(false)
    );
    assert!(
        invalid_signature_latest
            .get("errors")
            .and_then(Value::as_array)
            .map(|rows| rows
                .iter()
                .any(|row| row.as_str() == Some("manifest_signature_invalid")))
            .unwrap_or(false),
        "invalid template signature should fail strict governance"
    );

    // Restore valid manifest for subsequent boundary checks.
    write_json(
        &root
            .join("planes")
            .join("contracts")
            .join("research")
            .join("template_pack_manifest_v1.json"),
        &manifest,
    );

    let template_bypass_exit = research_plane::run(
        root,
        &[
            "template-governance".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(
        template_bypass_exit, 1,
        "strict template governance must fail-closed on conduit bypass"
    );
    let template_bypass_latest = read_json(&latest_path(root));
    assert_eq!(
        template_bypass_latest.get("type").and_then(Value::as_str),
        Some("research_plane_template_governance")
    );
    assert_eq!(
        template_bypass_latest.get("ok").and_then(Value::as_bool),
        Some(false)
    );
    assert!(
        template_bypass_latest
            .get("errors")
            .and_then(Value::as_array)
            .map(|rows| rows
                .iter()
                .any(|row| row.as_str() == Some("conduit_bypass_rejected")))
            .unwrap_or(false),
        "bypass rejection reason should be explicit"
    );

    std::env::remove_var("RESEARCH_CONSOLE_TOKEN");
    std::env::remove_var("RESEARCH_TEMPLATE_SIGNING_KEY");
}
