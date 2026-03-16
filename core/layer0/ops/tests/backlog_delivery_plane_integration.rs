// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::backlog_delivery_plane;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_root(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("protheus_backlog_delivery_{name}_{nonce}"));
    fs::create_dir_all(&root).expect("mkdir");
    root
}

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read json");
    serde_json::from_str(&raw).expect("parse json")
}

fn latest_path(root: &Path) -> PathBuf {
    root.join("core/local/state/ops/backlog_delivery_plane/latest.json")
}

fn seed_skill_graph_fixture(root: &Path) {
    let graph_dir = root.join("adapters/cognition/skills/content-skill-graph");
    fs::create_dir_all(&graph_dir).expect("mkdir skill graph");
    fs::write(
        graph_dir.join("index.md"),
        "# Graph\n\n- [[node-a]]\n- [[node-b]]\n",
    )
    .expect("write index");
    fs::write(graph_dir.join("node-a.md"), "# Node A\n\nrefs [[node-b]]\n").expect("write node-a");
    fs::write(graph_dir.join("node-b.md"), "# Node B\n").expect("write node-b");
}

fn all_ids() -> Vec<&'static str> {
    vec![
        "V6-SKILL-001",
        "V7-TOP1-002",
        "V7-CANYON-002.1",
        "V7-CANYON-002.2",
        "V7-CANYON-002.3",
        "V7-CANYON-002.4",
        "V7-CANYON-002.5",
        "V7-CANYON-002.6",
        "V7-F100-002.3",
        "V7-F100-002.4",
        "V7-F100-002.5",
        "V7-F100-002.6",
        "V7-F100-002.7",
        "V7-F100-002.8",
        "V7-MOAT-002.1",
        "V7-MOAT-002.2",
        "V7-MOAT-002.3",
        "V7-MOAT-002.4",
        "V8-MOAT-001.1",
        "V8-MOAT-001.2",
        "V8-MOAT-001.3",
        "V8-MOAT-001.4",
        "V8-MOAT-001.5",
        "V8-MOAT-001.6",
        "V8-MEMORY-BANK-001.1",
        "V8-MEMORY-BANK-001.2",
        "V8-MEMORY-BANK-001.3",
        "V8-MEMORY-BANK-001.4",
        "V8-MEMORY-BANK-001.5",
        "V8-MEMORY-BANK-001.6",
        "V8-SKILL-GRAPH-001.1",
        "V8-SKILL-GRAPH-001.2",
        "V8-SKILL-GRAPH-001.3",
        "V8-SKILL-GRAPH-001.4",
        "V8-SKILL-GRAPH-001.5",
        "V9-XENO-001.1",
        "V9-XENO-001.2",
        "V9-XENO-001.3",
        "V9-XENO-001.4",
        "V9-XENO-001.5",
        "V9-XENO-001.6",
        "V9-XENO-001.7",
        "V9-MERGE-001.1",
        "V9-MERGE-001.2",
        "V9-MERGE-001.3",
        "V9-MERGE-001.4",
        "V9-MERGE-001.5",
        "V9-MERGE-001.6",
        "V9-ESCALATE-001.1",
        "V9-ESCALATE-001.2",
        "V9-ESCALATE-001.3",
        "V9-ESCALATE-001.4",
        "V9-ESCALATE-001.5",
        "V9-ESCALATE-001.6",
    ]
}

#[test]
fn backlog_delivery_plane_executes_all_actionable_ids_with_receipts() {
    let root = temp_root("all");
    seed_skill_graph_fixture(&root);

    for id in all_ids() {
        let exit = backlog_delivery_plane::run(
            &root,
            &["run".to_string(), format!("--id={id}"), "--strict=0".to_string()],
        );
        assert_eq!(exit, 0, "id failed: {id}");
        let latest = read_json(&latest_path(&root));
        assert_eq!(latest.get("id").and_then(Value::as_str), Some(id));
        let has_claim = latest
            .get("claim_evidence")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter().any(|row| {
                    row.get("id")
                        .and_then(Value::as_str)
                        .map(|v| v == id)
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        assert!(has_claim, "missing claim evidence for {id}");
        if id == "V6-SKILL-001" || id == "V8-SKILL-GRAPH-001.1" {
            let node_count = latest
                .pointer("/details/nodes")
                .and_then(Value::as_array)
                .map(|rows| rows.len())
                .unwrap_or(0);
            assert!(
                node_count > 0,
                "skill graph loader should discover markdown nodes from default folder"
            );
        }
    }

    let _ = fs::remove_dir_all(root);
}
