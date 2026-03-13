// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{memory_ambient, rag_cli};
use serde_json::Value;
use std::fs;
use std::path::Path;

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read json");
    serde_json::from_str(&raw).expect("decode json")
}

fn has_claim(receipt: &Value, claim_id: &str) -> bool {
    receipt
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some(claim_id))
}

fn has_any_claim(receipt: &Value, claim_ids: &[&str]) -> bool {
    claim_ids.iter().any(|id| has_claim(receipt, id))
}

fn root_flag(root: &Path) -> String {
    format!("--root={}", root.to_string_lossy())
}

fn run_rag(root: &Path, args: &[String]) -> i32 {
    rag_cli::run(root, args)
}

fn write_memory_ambient_policy(root: &Path) {
    let policy_path = root.join("config/mech_suit_mode_policy.json");
    fs::create_dir_all(policy_path.parent().expect("policy parent")).expect("mkdir policy");
    fs::write(
        &policy_path,
        r#"{
  "enabled": true,
  "memory": {
    "push_attention_queue": false,
    "quiet_non_critical": true,
    "surface_levels": ["warn", "critical"]
  }
}
"#,
    )
    .expect("write policy");
}

#[test]
fn v6_memory_batch22_taxonomy_and_causality_lanes_are_receipted() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();
    write_memory_ambient_policy(root);
    let docs = root.join("docs");
    fs::create_dir_all(&docs).expect("mkdir docs");
    fs::write(
        docs.join("2026-03-12-policy.md"),
        "Policy update: deterministic receipts cause downstream planning updates.",
    )
    .expect("write policy");
    fs::write(
        docs.join("2026-03-13-causality.md"),
        "Causality graph construction enables benchmark quality checks.",
    )
    .expect("write causality");

    let root_arg = root_flag(root);

    assert_eq!(
        run_rag(
            root,
            &[
                "ingest".to_string(),
                root_arg.clone(),
                "--path=docs".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        run_rag(
            root,
            &[
                "search".to_string(),
                root_arg.clone(),
                "--q=policy".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        run_rag(
            root,
            &[
                "chat".to_string(),
                root_arg.clone(),
                "--q=causality".to_string(),
            ],
        ),
        0
    );

    let latest = root.join("state/client/memory/ambient/latest.json");

    assert_eq!(
        run_rag(
            root,
            &[
                "memory".to_string(),
                "enable".to_string(),
                "metacognitive".to_string(),
                root_arg.clone(),
                "--note=batch22".to_string(),
            ],
        ),
        0
    );
    let metacognitive = read_json(&latest);
    assert_eq!(
        metacognitive
            .get("memory_payload")
            .and_then(|v| v.get("type"))
            .and_then(Value::as_str),
        Some("memory_metacognitive_enable")
    );
    assert!(has_claim(&metacognitive, "V6-MEMORY-011.2"));

    assert_eq!(
        run_rag(
            root,
            &[
                "memory".to_string(),
                "taxonomy".to_string(),
                root_arg.clone(),
            ],
        ),
        0
    );
    let taxonomy = read_json(&latest);
    assert_eq!(
        taxonomy
            .get("memory_payload")
            .and_then(|v| v.get("type"))
            .and_then(Value::as_str),
        Some("memory_taxonomy_4w")
    );
    assert!(has_claim(&taxonomy, "V6-MEMORY-011.1"));
    assert!(has_claim(&taxonomy, "V6-MEMORY-011.5"));

    assert_eq!(
        run_rag(
            root,
            &[
                "memory".to_string(),
                "enable".to_string(),
                "causality".to_string(),
                root_arg.clone(),
            ],
        ),
        0
    );
    let causality = read_json(&latest);
    assert_eq!(
        causality
            .get("memory_payload")
            .and_then(|v| v.get("type"))
            .and_then(Value::as_str),
        Some("memory_causality_enable")
    );
    assert!(has_claim(&causality, "V6-MEMORY-012.1"));
    assert!(has_claim(&causality, "V6-MEMORY-012.5"));

    assert_eq!(
        run_rag(
            root,
            &[
                "memory".to_string(),
                "benchmark".to_string(),
                "ama".to_string(),
                root_arg.clone(),
            ],
        ),
        0
    );
    let ama = read_json(&latest);
    assert_eq!(
        ama.get("memory_payload")
            .and_then(|v| v.get("type"))
            .and_then(Value::as_str),
        Some("memory_benchmark_ama")
    );
    assert!(has_claim(&ama, "V6-MEMORY-012.3"));
    assert!(has_claim(&ama, "V6-MEMORY-012.5"));

    assert_eq!(
        run_rag(
            root,
            &[
                "memory".to_string(),
                "share".to_string(),
                root_arg.clone(),
                "--persona=peer-shadow".to_string(),
                "--scope=task".to_string(),
                "--consent=true".to_string(),
            ],
        ),
        0
    );
    let share = read_json(&latest);
    assert_eq!(
        share
            .get("memory_payload")
            .and_then(|v| v.get("type"))
            .and_then(Value::as_str),
        Some("memory_share")
    );
    assert!(has_claim(&share, "V6-MEMORY-011.3"));

    assert_eq!(
        run_rag(
            root,
            &[
                "memory".to_string(),
                "evolve".to_string(),
                root_arg.clone(),
                "--generation=7".to_string(),
            ],
        ),
        0
    );
    let evolve = read_json(&latest);
    assert_eq!(
        evolve
            .get("memory_payload")
            .and_then(|v| v.get("type"))
            .and_then(Value::as_str),
        Some("memory_evolve")
    );
    assert!(has_claim(&evolve, "V6-MEMORY-011.4"));

    assert_eq!(
        run_rag(
            root,
            &[
                "memory".to_string(),
                "causal-retrieve".to_string(),
                root_arg.clone(),
                "--q=policy".to_string(),
                "--depth=2".to_string(),
            ],
        ),
        0
    );
    let retrieve = read_json(&latest);
    assert_eq!(
        retrieve
            .get("memory_payload")
            .and_then(|v| v.get("type"))
            .and_then(Value::as_str),
        Some("memory_causal_retrieve")
    );
    assert!(has_claim(&retrieve, "V6-MEMORY-012.2"));

    assert_eq!(
        run_rag(
            root,
            &["memory".to_string(), "fuse".to_string(), root_arg.clone(),],
        ),
        0
    );
    let fuse = read_json(&latest);
    assert_eq!(
        fuse.get("memory_payload")
            .and_then(|v| v.get("type"))
            .and_then(Value::as_str),
        Some("memory_fuse")
    );
    assert!(has_claim(&fuse, "V6-MEMORY-012.4"));

    assert!(root.join("state/ops/local_rag/taxonomy_4w.json").exists());
    assert!(root
        .join("state/ops/local_rag/metacognitive_config.json")
        .exists());
    assert!(root
        .join("state/ops/local_rag/causality_graph.json")
        .exists());
    assert!(root
        .join("state/ops/local_rag/ama_benchmark_latest.json")
        .exists());
    assert!(root
        .join("state/ops/local_rag/sharing_ledger.jsonl")
        .exists());
    assert!(root
        .join("state/ops/local_rag/evolution_state.json")
        .exists());
    assert!(root
        .join("state/ops/local_rag/fusion_snapshot.json")
        .exists());
}

#[test]
fn v6_memory_batch22_rejects_strict_conduit_bypass() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();
    write_memory_ambient_policy(root);
    let root_arg = root_flag(root);

    assert_eq!(
        memory_ambient::run(
            root,
            &[
                "run".to_string(),
                "--memory-command=stable-memory-taxonomy".to_string(),
                format!("--memory-arg={root_arg}"),
                "--memory-arg=--strict=1".to_string(),
                "--memory-arg=--bypass=1".to_string(),
            ],
        ),
        1
    );
    let latest = root.join("state/client/memory/ambient/latest.json");
    let taxonomy_gate = read_json(&latest);
    assert_eq!(
        taxonomy_gate.get("type").and_then(Value::as_str),
        Some("memory_ambient_conduit_gate")
    );
    assert!(has_claim(&taxonomy_gate, "V6-MEMORY-011.1"));

    assert_eq!(
        memory_ambient::run(
            root,
            &[
                "run".to_string(),
                "--memory-command=stable-memory-enable-causality".to_string(),
                format!("--memory-arg={root_arg}"),
                "--memory-arg=--strict=1".to_string(),
                "--memory-arg=--bypass=1".to_string(),
            ],
        ),
        1
    );
    let causality_gate = read_json(&latest);
    assert_eq!(
        causality_gate.get("type").and_then(Value::as_str),
        Some("memory_ambient_conduit_gate")
    );
    assert!(has_any_claim(
        &causality_gate,
        &["V6-MEMORY-012.1", "V6-MEMORY-012.5"]
    ));
}
