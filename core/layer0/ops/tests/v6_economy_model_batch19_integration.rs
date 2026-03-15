// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{llm_economy_organ, model_router};
use serde_json::Value;
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

fn stage_fixture_root() -> TempDir {
    let workspace = workspace_root();
    let tmp = tempfile::tempdir().expect("tempdir");
    copy_tree(
        &workspace.join("planes").join("contracts"),
        &tmp.path().join("planes").join("contracts"),
    );
    tmp
}

fn economy_latest_path(root: &Path) -> PathBuf {
    root.join("client")
        .join("local")
        .join("state")
        .join("ops")
        .join("llm_economy_organ")
        .join("latest.json")
}

fn model_latest_path(root: &Path) -> PathBuf {
    root.join("local")
        .join("state")
        .join("ops")
        .join("model_router")
        .join("latest.json")
}

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read");
    serde_json::from_str(&raw).expect("parse")
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
fn v6_batch19_economy_and_model_lanes_are_receipted() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let enable_exit = llm_economy_organ::run(
        root,
        &[
            "enable".to_string(),
            "all".to_string(),
            "--strict=1".to_string(),
            "--apply=1".to_string(),
        ],
    );
    assert_eq!(enable_exit, 0);
    let enable_latest = read_json(&economy_latest_path(root));
    assert_eq!(
        enable_latest.get("type").and_then(Value::as_str),
        Some("llm_economy_organ_enable")
    );
    assert_claim(&enable_latest, "V6-ECONOMY-001.8");

    let dashboard_exit = llm_economy_organ::run(root, &["dashboard".to_string()]);
    assert_eq!(dashboard_exit, 0);
    let dashboard_latest = read_json(&economy_latest_path(root));
    assert_eq!(
        dashboard_latest.get("type").and_then(Value::as_str),
        Some("llm_economy_organ_dashboard")
    );
    assert_claim(&dashboard_latest, "V6-ECONOMY-001.8");

    let fairscale_exit = llm_economy_organ::run(
        root,
        &[
            "fairscale-credit".to_string(),
            "--strict=1".to_string(),
            "--identity=seed-alpha".to_string(),
            "--delta=2.0".to_string(),
        ],
    );
    assert_eq!(fairscale_exit, 0);
    let fairscale_latest = read_json(&economy_latest_path(root));
    assert_eq!(
        fairscale_latest.get("type").and_then(Value::as_str),
        Some("llm_economy_fairscale_credit")
    );
    assert_claim(&fairscale_latest, "V6-ECONOMY-001.5");

    let mining_exit = llm_economy_organ::run(
        root,
        &[
            "mining-hand".to_string(),
            "--strict=1".to_string(),
            "--network=litcoin".to_string(),
            "--hours=5".to_string(),
            "--schedule=*/15 * * * *".to_string(),
        ],
    );
    assert_eq!(mining_exit, 0);
    let mining_latest = read_json(&economy_latest_path(root));
    assert_eq!(
        mining_latest.get("type").and_then(Value::as_str),
        Some("llm_economy_mining_hand")
    );
    assert_claim(&mining_latest, "V6-ECONOMY-001.6");
    assert!(
        mining_latest
            .pointer("/schedule_runtime/interval_minutes")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            > 0
    );
    assert!(mining_latest
        .get("mining_runtime_path")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false));

    let trade_exit = llm_economy_organ::run(
        root,
        &[
            "trade-router".to_string(),
            "--strict=1".to_string(),
            "--chain=solana".to_string(),
            "--symbol=SOL/USDC".to_string(),
            "--side=buy".to_string(),
            "--qty=1.5".to_string(),
        ],
    );
    assert_eq!(trade_exit, 0);
    let trade_latest = read_json(&economy_latest_path(root));
    assert_eq!(
        trade_latest.get("type").and_then(Value::as_str),
        Some("llm_economy_trade_router")
    );
    assert_claim(&trade_latest, "V6-ECONOMY-001.7");
    assert_eq!(
        trade_latest
            .get("non_custodial_intent")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert!(trade_latest
        .get("order_intent_id")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false));

    let upgrade_exit = llm_economy_organ::run(
        root,
        &[
            "upgrade-trading-hand".to_string(),
            "--strict=1".to_string(),
            "--mode=paper".to_string(),
            "--symbol=QQQ".to_string(),
        ],
    );
    assert_eq!(upgrade_exit, 0);
    let upgrade_latest = read_json(&economy_latest_path(root));
    assert_eq!(
        upgrade_latest.get("type").and_then(Value::as_str),
        Some("llm_economy_organ_trading_hand_upgrade")
    );
    assert_claim(&upgrade_latest, "V6-ECONOMY-002.1");
    assert_claim(&upgrade_latest, "V6-ECONOMY-002.4");
    assert!(upgrade_latest
        .get("settings_inventory")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false));
    assert!(upgrade_latest
        .get("metrics_inventory")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false));

    let debate_exit = llm_economy_organ::run(
        root,
        &[
            "debate-bullbear".to_string(),
            "--strict=1".to_string(),
            "--symbol=BTCUSD".to_string(),
            "--bull-score=0.61".to_string(),
            "--bear-score=0.39".to_string(),
        ],
    );
    assert_eq!(debate_exit, 0);
    let debate_latest = read_json(&economy_latest_path(root));
    assert_eq!(
        debate_latest.get("type").and_then(Value::as_str),
        Some("llm_economy_organ_bullbear_debate")
    );
    assert_claim(&debate_latest, "V6-ECONOMY-002.2");

    let alpaca_exit = llm_economy_organ::run(
        root,
        &[
            "alpaca-execute".to_string(),
            "--strict=1".to_string(),
            "--mode=paper".to_string(),
            "--symbol=BTCUSD".to_string(),
            "--side=buy".to_string(),
            "--qty=2".to_string(),
            "--max-qty=5".to_string(),
        ],
    );
    assert_eq!(alpaca_exit, 0);
    let alpaca_latest = read_json(&economy_latest_path(root));
    assert_eq!(
        alpaca_latest.get("type").and_then(Value::as_str),
        Some("llm_economy_organ_alpaca_execute")
    );
    assert_claim(&alpaca_latest, "V6-ECONOMY-002.3");

    let refresh_exit = llm_economy_organ::run(
        root,
        &[
            "model-support-refresh".to_string(),
            "--strict=1".to_string(),
            "--apply=1".to_string(),
        ],
    );
    assert_eq!(refresh_exit, 0);
    let refresh_latest = read_json(&economy_latest_path(root));
    assert_eq!(
        refresh_latest.get("type").and_then(Value::as_str),
        Some("llm_economy_model_support_refresh")
    );
    assert_claim(&refresh_latest, "V6-ECONOMY-002.5");
    let provider_count = refresh_latest
        .get("provider_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let provider_rows = refresh_latest
        .get("provider_matrix")
        .and_then(Value::as_array)
        .map(|rows| rows.len() as u64)
        .unwrap_or(0);
    assert!(provider_count >= 1);
    assert_eq!(provider_count, provider_rows);

    let compact_exit = model_router::run(
        root,
        &[
            "compact-context".to_string(),
            "--max-lines=16".to_string(),
            "--source=soul,memory,task,receipts".to_string(),
        ],
    );
    assert_eq!(compact_exit, 0);
    let compact_latest = read_json(&model_latest_path(root));
    assert_eq!(
        compact_latest.get("type").and_then(Value::as_str),
        Some("model_router_compact_context")
    );
    assert_claim(&compact_latest, "V6-MODEL-003.1");
    assert!(compact_latest
        .get("compacted_text")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false));
    assert!(compact_latest
        .get("compaction_ratio")
        .and_then(Value::as_f64)
        .map(|v| v > 0.0 && v <= 1.0)
        .unwrap_or(false));

    let decompose_exit = model_router::run(
        root,
        &[
            "decompose-task".to_string(),
            "--task=ship compact model lane".to_string(),
        ],
    );
    assert_eq!(decompose_exit, 0);
    let decompose_latest = read_json(&model_latest_path(root));
    assert_eq!(
        decompose_latest.get("type").and_then(Value::as_str),
        Some("model_router_decompose_task")
    );
    assert_claim(&decompose_latest, "V6-MODEL-003.2");
    assert!(decompose_latest
        .get("subtasks")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false));
}

#[test]
fn v6_batch19_economy_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = llm_economy_organ::run(
        root,
        &[
            "trade-router".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&economy_latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("llm_economy_organ_conduit_gate")
    );
}
