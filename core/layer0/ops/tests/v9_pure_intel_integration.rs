use serde_json::Value;
use std::fs;
use std::path::Path;
use std::process::Command;

fn run_protheusd(root: &Path, args: &[&str]) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_protheusd"))
        .current_dir(root)
        .args(args)
        .output()
        .expect("run protheusd");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("parse json output")
}

#[test]
// V9-PURE-INTEL-001.1
fn v9_pure_intel_001_1_think_emits_structured_receipt_and_memory_hits() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path();

    let write = run_protheusd(
        root,
        &[
            "memory",
            "write",
            "--text=research rust safety constraints",
            "--session-id=alpha",
        ],
    );
    assert_eq!(
        write.get("type").and_then(Value::as_str),
        Some("pure_memory_write")
    );

    let think = run_protheusd(
        root,
        &[
            "think",
            "--prompt=Can you research safety constraints?",
            "--session-id=alpha",
        ],
    );
    assert_eq!(think.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        think.get("type").and_then(Value::as_str),
        Some("pure_think")
    );
    assert!(think
        .get("response")
        .and_then(Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false));
    assert!(think
        .get("receipt_hash")
        .and_then(Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false));
    assert!(think
        .get("memory_hits")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false));
}

#[test]
// V9-PURE-INTEL-001.2
fn v9_pure_intel_001_2_research_status_fetch_and_diagnostics_run_in_rust_core() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path();
    let fixture = root.join("fixture.html");
    fs::write(
        &fixture,
        "<html><body><h1>pure intelligence fixture</h1></body></html>",
    )
    .expect("write fixture");
    let url = format!("file://{}", fixture.display());

    let status = run_protheusd(root, &["research", "status"]);
    assert_eq!(status.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        status.get("type").and_then(Value::as_str),
        Some("research_plane_status")
    );

    let diagnostics = run_protheusd(root, &["research", "diagnostics"]);
    assert_eq!(diagnostics.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        diagnostics.get("type").and_then(Value::as_str),
        Some("research_plane_diagnostics")
    );

    let fetch = run_protheusd(root, &["research", "fetch", &format!("--url={url}")]);
    assert_eq!(fetch.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        fetch.get("type").and_then(Value::as_str),
        Some("research_plane_fetch")
    );
    assert_eq!(fetch.get("status").and_then(Value::as_u64), Some(200));
    assert!(fetch
        .get("body_sha256")
        .and_then(Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false));
    assert!(fetch
        .get("body_preview")
        .and_then(Value::as_str)
        .map(|value| value.contains("pure intelligence fixture"))
        .unwrap_or(false));
}

#[test]
// V9-PURE-INTEL-001.3
fn v9_pure_intel_001_3_memory_status_write_and_query_round_trip_through_core_state() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path();

    let status = run_protheusd(root, &["memory", "status"]);
    assert_eq!(status.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        status.get("type").and_then(Value::as_str),
        Some("pure_memory_status")
    );

    let write = run_protheusd(
        root,
        &[
            "memory",
            "write",
            "--text=remember the deterministic pure mode contract",
            "--session-id=beta",
            "--tags=pure,intel",
        ],
    );
    assert_eq!(write.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        write.get("type").and_then(Value::as_str),
        Some("pure_memory_write")
    );
    assert!(write
        .get("path")
        .and_then(Value::as_str)
        .map(|value| value.ends_with("memory/pure_workspace_memory_v1.jsonl"))
        .unwrap_or(false));

    let query = run_protheusd(
        root,
        &[
            "memory",
            "query",
            "--q=deterministic pure mode",
            "--session-id=beta",
        ],
    );
    assert_eq!(query.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        query.get("type").and_then(Value::as_str),
        Some("pure_memory_query")
    );
    assert!(query
        .get("matches")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().any(|row| {
            row.get("text")
                .and_then(Value::as_str)
                .map(|text| text.contains("deterministic pure mode contract"))
                .unwrap_or(false)
        }))
        .unwrap_or(false));
    assert!(query
        .get("receipt_hash")
        .and_then(Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false));
}
