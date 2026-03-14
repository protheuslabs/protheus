// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::model_router;
use protheus_ops_core_v1::p2p_gossip_seed;
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

fn has_infring_receipt(receipt: &Value) -> bool {
    let has_ts = receipt.get("ts").and_then(Value::as_str).is_some()
        || receipt.get("ts_epoch_ms").and_then(Value::as_u64).is_some();
    receipt.get("ok").and_then(Value::as_bool).is_some()
        && receipt
            .get("receipt_hash")
            .and_then(Value::as_str)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
        && receipt
            .get("type")
            .and_then(Value::as_str)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
        && receipt
            .get("lane")
            .and_then(Value::as_str)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
        && has_ts
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .ok()
        .map(|raw| {
            raw.lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

#[test]
fn v6_batch20_model_and_network_lanes_are_receipted() {
    let root = tempfile::tempdir().expect("tempdir");

    assert_eq!(
        model_router::run(
            root.path(),
            &[
                "adapt-repo".to_string(),
                "--repo=https://github.com/protheuslabs/InfRing".to_string(),
                "--strategy=reuse-first".to_string(),
            ],
        ),
        0
    );
    let model_latest = root.path().join("local/state/ops/model_router/latest.json");
    let adapt = read_json(&model_latest);
    assert_eq!(
        adapt.get("type").and_then(Value::as_str),
        Some("model_router_adapt_repo")
    );
    assert!(has_infring_receipt(&adapt));
    assert!(has_claim(&adapt, "V6-MODEL-003.3"));
    assert!(adapt
        .pointer("/adaptation_plan/plan_digest")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false));

    assert_eq!(
        model_router::run(
            root.path(),
            &[
                "reset-agent".to_string(),
                "--preserve-identity=1".to_string(),
                "--scope=routing+session-cache".to_string(),
            ],
        ),
        0
    );
    let reset = read_json(&model_latest);
    assert_eq!(
        reset.get("type").and_then(Value::as_str),
        Some("model_router_agent_reset")
    );
    assert!(has_infring_receipt(&reset));
    assert_eq!(
        reset.pointer("/state_preservation/previous_receipt_hash")
            .and_then(Value::as_str),
        adapt.get("receipt_hash").and_then(Value::as_str)
    );
    assert!(has_claim(&reset, "V6-MODEL-003.4"));
    assert!(reset
        .get("reset_state_path")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false));

    assert_eq!(
        model_router::run(
            root.path(),
            &[
                "optimize".to_string(),
                "minimax".to_string(),
                "--compact-lines=20".to_string(),
            ],
        ),
        0
    );
    let optimize = read_json(&model_latest);
    assert_eq!(
        optimize.get("type").and_then(Value::as_str),
        Some("model_router_optimize_cheap")
    );
    assert!(has_infring_receipt(&optimize));
    assert!(has_claim(&optimize, "V6-MODEL-003.5"));
    assert!(optimize
        .pointer("/plan/profile_digest")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false));

    assert_eq!(
        model_router::run(
            root.path(),
            &[
                "night-schedule".to_string(),
                "--start-hour=0".to_string(),
                "--end-hour=6".to_string(),
                "--cheap-model=minimax/m2.5".to_string(),
            ],
        ),
        0
    );
    let night = read_json(&model_latest);
    assert_eq!(
        night.get("type").and_then(Value::as_str),
        Some("model_router_night_schedule")
    );
    assert!(has_infring_receipt(&night));
    assert!(has_claim(&night, "V6-MODEL-003.6"));
    assert!(night
        .pointer("/schedule/window_hours")
        .and_then(Value::as_i64)
        .map(|v| v > 0)
        .unwrap_or(false));
    assert!(night
        .get("night_schedule_path")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false));

    assert_eq!(
        p2p_gossip_seed::run(
            root.path(),
            &[
                "discover".to_string(),
                "--profile=hyperspace".to_string(),
                "--node=alpha".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    let network_latest = root.path().join("local/state/ops/p2p_gossip_seed/latest.json");
    let join = read_json(&network_latest);
    assert_eq!(
        join.get("type").and_then(Value::as_str),
        Some("p2p_gossip_seed_join")
    );
    assert!(has_infring_receipt(&join));
    assert!(has_claim(&join, "V6-NETWORK-004.2"));
    assert!(has_claim(&join, "V6-NETWORK-004.6"));

    assert_eq!(
        p2p_gossip_seed::run(
            root.path(),
            &[
                "compute-proof".to_string(),
                "--share=1".to_string(),
                "--node=alpha".to_string(),
                "--matmul-size=1024".to_string(),
                "--credits=2.5".to_string(),
            ],
        ),
        0
    );
    let compute = read_json(&network_latest);
    assert_eq!(
        compute.get("type").and_then(Value::as_str),
        Some("p2p_gossip_seed_compute_proof")
    );
    assert!(has_infring_receipt(&compute));
    assert!(has_claim(&compute, "V6-NETWORK-004.1"));
    assert!(has_claim(&compute, "V6-NETWORK-004.2"));
    assert!(has_claim(&compute, "V6-NETWORK-004.6"));
    assert!(compute
        .pointer("/proof/challenge_id")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false));

    assert_eq!(
        p2p_gossip_seed::run(
            root.path(),
            &[
                "gossip".to_string(),
                "--topic=ranking".to_string(),
                "--breakthrough=listwise_patch_v2".to_string(),
            ],
        ),
        0
    );
    let gossip = read_json(&network_latest);
    assert_eq!(
        gossip.get("type").and_then(Value::as_str),
        Some("p2p_gossip_seed_breakthrough")
    );
    assert!(has_infring_receipt(&gossip));
    assert!(has_claim(&gossip, "V6-NETWORK-004.3"));
    assert!(gossip
        .get("gossip_id")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false));

    assert_eq!(
        p2p_gossip_seed::run(
            root.path(),
            &[
                "idle-rss".to_string(),
                "--feed=ai-news".to_string(),
                "--note=tracking ranking papers".to_string(),
            ],
        ),
        0
    );
    let rss = read_json(&network_latest);
    assert_eq!(
        rss.get("type").and_then(Value::as_str),
        Some("p2p_gossip_seed_idle_rss")
    );
    assert!(has_infring_receipt(&rss));
    assert!(has_claim(&rss, "V6-NETWORK-004.4"));
    assert!(rss
        .get("comment_id")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false));

    assert_eq!(
        p2p_gossip_seed::run(
            root.path(),
            &[
                "ranking-evolve".to_string(),
                "--metric=ndcg@10".to_string(),
                "--delta=0.03".to_string(),
            ],
        ),
        0
    );
    let ranking = read_json(&network_latest);
    assert_eq!(
        ranking.get("type").and_then(Value::as_str),
        Some("p2p_gossip_seed_ranking_evolve")
    );
    assert!(has_infring_receipt(&ranking));
    assert!(has_claim(&ranking, "V6-NETWORK-004.5"));
    assert!(ranking
        .get("ranking_state_path")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false));

    assert_eq!(
        p2p_gossip_seed::run(root.path(), &["dashboard".to_string()]),
        0
    );
    let dashboard = read_json(&network_latest);
    assert_eq!(
        dashboard.get("type").and_then(Value::as_str),
        Some("p2p_gossip_seed_dashboard")
    );
    assert!(has_infring_receipt(&dashboard));
    assert!(has_claim(&dashboard, "V6-NETWORK-004.2"));
    assert!(has_claim(&dashboard, "V6-NETWORK-004.6"));
    assert!(dashboard
        .get("contribution_ledger")
        .and_then(Value::as_object)
        .is_some());
    assert_eq!(
        dashboard
            .pointer("/latest_event/receipt_hash")
            .and_then(Value::as_str),
        ranking.get("receipt_hash").and_then(Value::as_str)
    );

    let model_history = read_jsonl(&root.path().join("local/state/ops/model_router/history.jsonl"));
    assert!(model_history.len() >= 4, "expected model router history entries");
    for row in &model_history {
        assert!(has_infring_receipt(row));
    }
    for pair in model_history.windows(2) {
        assert_ne!(
            pair[0].get("receipt_hash").and_then(Value::as_str),
            pair[1].get("receipt_hash").and_then(Value::as_str)
        );
    }

    let network_history = read_jsonl(&root.path().join("local/state/ops/p2p_gossip_seed/history.jsonl"));
    assert!(
        network_history.len() >= 6,
        "expected network history rows for join/compute/gossip/rss/ranking/dashboard"
    );
    for row in &network_history {
        assert!(has_infring_receipt(row));
        assert!(
            row.get("claim_evidence")
                .and_then(Value::as_array)
                .map(|rows| !rows.is_empty())
                .unwrap_or(false),
            "network rows must emit claim evidence"
        );
    }
    assert_eq!(
        network_history
            .get(network_history.len().saturating_sub(2))
            .and_then(|row| row.get("receipt_hash"))
            .and_then(Value::as_str),
        ranking.get("receipt_hash").and_then(Value::as_str)
    );
}

#[test]
fn v6_batch20_model_and_network_reject_strict_bypass() {
    let root = tempfile::tempdir().expect("tempdir");

    assert_eq!(
        model_router::run(
            root.path(),
            &[
                "adapt-repo".to_string(),
                "--repo=.".to_string(),
                "--strict=1".to_string(),
                "--bypass=1".to_string(),
            ],
        ),
        1
    );

    assert_eq!(
        p2p_gossip_seed::run(
            root.path(),
            &[
                "compute-proof".to_string(),
                "--strict=1".to_string(),
                "--bypass=1".to_string(),
            ],
        ),
        1
    );
}

#[test]
fn v6_batch20_bitnet_backend_routing_and_telemetry_are_receipted() {
    let root = tempfile::tempdir().expect("tempdir");
    let model_latest = root.path().join("local/state/ops/model_router/latest.json");

    assert_eq!(
        model_router::run(
            root.path(),
            &[
                "bitnet-backend".to_string(),
                "--strict=1".to_string(),
                "--kernel=bitnet.cpp".to_string(),
                "--model-format=bitnet-q3".to_string(),
            ],
        ),
        0
    );
    let backend = read_json(&model_latest);
    assert_eq!(
        backend.get("type").and_then(Value::as_str),
        Some("model_router_bitnet_backend")
    );
    assert!(has_infring_receipt(&backend));
    assert!(has_claim(&backend, "V6-MODEL-004.1"));
    assert!(has_claim(&backend, "V6-MODEL-004.5"));

    assert_eq!(
        model_router::run(
            root.path(),
            &[
                "bitnet-auto-route".to_string(),
                "--battery-pct=18".to_string(),
                "--offline=1".to_string(),
                "--edge=1".to_string(),
            ],
        ),
        0
    );
    let route = read_json(&model_latest);
    assert_eq!(
        route.get("type").and_then(Value::as_str),
        Some("model_router_bitnet_auto_route")
    );
    assert!(has_infring_receipt(&route));
    assert!(has_claim(&route, "V6-MODEL-004.2"));
    assert!(has_claim(&route, "V6-MODEL-004.5"));
    assert_eq!(
        route.pointer("/route_policy/reason").and_then(Value::as_str),
        Some("offline_mode")
    );

    assert_eq!(
        model_router::run(
            root.path(),
            &[
                "bitnet-use".to_string(),
                "--source-model=hf://protheus/edge".to_string(),
                "--target-model=bitnet/local-edge".to_string(),
            ],
        ),
        0
    );
    let convert = read_json(&model_latest);
    assert_eq!(
        convert.get("type").and_then(Value::as_str),
        Some("model_router_bitnet_use")
    );
    assert!(has_infring_receipt(&convert));
    assert!(has_claim(&convert, "V6-MODEL-004.3"));
    assert!(has_claim(&convert, "V6-MODEL-004.5"));

    assert_eq!(
        model_router::run(
            root.path(),
            &[
                "bitnet-telemetry".to_string(),
                "--throughput=220".to_string(),
                "--energy-j=4.8".to_string(),
                "--baseline-energy-j=11.0".to_string(),
                "--memory-mb=384".to_string(),
                "--hardware-class=mobile-arm64".to_string(),
            ],
        ),
        0
    );
    let telemetry = read_json(&model_latest);
    assert_eq!(
        telemetry.get("type").and_then(Value::as_str),
        Some("model_router_bitnet_telemetry")
    );
    assert!(has_infring_receipt(&telemetry));
    assert!(has_claim(&telemetry, "V6-MODEL-004.4"));
    assert!(has_claim(&telemetry, "V6-MODEL-004.5"));
    assert!(
        telemetry
            .pointer("/telemetry/energy_delta_pct")
            .and_then(Value::as_f64)
            .map(|v| v > 0.0)
            .unwrap_or(false)
    );
}

#[test]
fn v6_batch20_bitnet_attestation_fails_closed_without_provenance() {
    let root = tempfile::tempdir().expect("tempdir");

    assert_eq!(
        model_router::run(
            root.path(),
            &[
                "bitnet-attest".to_string(),
                "--strict=1".to_string(),
                "--provenance=https://invalid.example/model".to_string(),
            ],
        ),
        1
    );
}
