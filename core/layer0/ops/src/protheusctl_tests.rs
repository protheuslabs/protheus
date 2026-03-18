use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

fn env_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .expect("lock_env")
}

#[test]
fn resolve_workspace_root_walks_up_to_repo_marker() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let base = std::env::temp_dir().join(format!("protheusctl_root_resolve_{nonce}"));
    let nested = base.join("tmp").join("nested").join("cwd");
    fs::create_dir_all(base.join("core/layer0/ops")).expect("ops dir");
    fs::create_dir_all(base.join("client/runtime")).expect("client runtime dir");
    fs::create_dir_all(&nested).expect("nested dir");
    fs::write(
        base.join("core/layer0/ops/Cargo.toml"),
        "[package]\nname=\"dummy\"\n",
    )
    .expect("manifest");

    let resolved = resolve_workspace_root(&nested).expect("resolved");
    assert_eq!(resolved, base);
    let _ = fs::remove_dir_all(base);
}

#[test]
fn route_edge_swarm_maps_correctly() {
    let route = route_edge(&[
        "swarm".to_string(),
        "enroll".to_string(),
        "--owner=operator".to_string(),
    ]);
    assert_eq!(
        route.script_rel,
        "client/runtime/systems/spawn/mobile_edge_swarm_bridge.ts"
    );
    assert_eq!(route.args.first().map(String::as_str), Some("enroll"));
}

#[test]
fn core_shortcut_routes_rag_command() {
    let route = resolve_core_shortcuts("rag", &["search".to_string(), "--q=proof".to_string()])
        .expect("route");
    assert_eq!(route.script_rel, "core://rag");
    assert_eq!(route.args.first().map(String::as_str), Some("search"));
}

#[test]
fn core_shortcut_routes_swarm_command() {
    let route = resolve_core_shortcuts("swarm", &["test".to_string(), "recursive".to_string()])
        .expect("route");
    assert_eq!(route.script_rel, "core://swarm-runtime");
    assert_eq!(route.args, vec!["test", "recursive"]);
}

#[test]
fn core_shortcut_routes_memory_command() {
    let route = resolve_core_shortcuts("memory", &["search".to_string(), "--q=ledger".to_string()])
        .expect("route");
    assert_eq!(route.script_rel, "core://rag");
    assert_eq!(route.args.first().map(String::as_str), Some("memory"));
    assert_eq!(route.args.get(1).map(String::as_str), Some("search"));
}

#[test]
fn core_shortcut_routes_alpha_check_to_alpha_readiness_domain() {
    let route = resolve_core_shortcuts("alpha-check", &[]).expect("route");
    assert_eq!(route.script_rel, "core://alpha-readiness");
    assert_eq!(route.args, vec!["run"]);
}

#[test]
fn core_shortcut_routes_alpha_check_flags_default_to_run_subcommand() {
    let route = resolve_core_shortcuts("alpha-check", &["--strict=1".to_string()]).expect("route");
    assert_eq!(route.script_rel, "core://alpha-readiness");
    assert_eq!(route.args, vec!["run", "--strict=1"]);
}

#[test]
fn core_shortcut_routes_chat_with_files() {
    let route = resolve_core_shortcuts(
        "chat",
        &[
            "with".to_string(),
            "files".to_string(),
            "receipts".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://rag");
    assert_eq!(route.args.first().map(String::as_str), Some("chat"));
    assert_eq!(route.args.get(1).map(String::as_str), Some("receipts"));
}

#[test]
fn core_shortcut_routes_chat_nano_to_rag_domain() {
    let route = resolve_core_shortcuts("chat", &["nano".to_string(), "--q=hello".to_string()])
        .expect("route");
    assert_eq!(route.script_rel, "core://rag");
    assert_eq!(route.args, vec!["chat", "nano", "--q=hello"]);
}

#[test]
fn core_shortcut_routes_train_nano_to_rag_domain() {
    let route = resolve_core_shortcuts("train", &["nano".to_string(), "--depth=12".to_string()])
        .expect("route");
    assert_eq!(route.script_rel, "core://rag");
    assert_eq!(route.args, vec!["train", "nano", "--depth=12"]);
}

#[test]
fn core_shortcut_routes_nano_fork_to_rag_domain() {
    let route = resolve_core_shortcuts(
        "nano",
        &["fork".to_string(), "--target=.nanochat/fork".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://rag");
    assert_eq!(route.args, vec!["nano", "fork", "--target=.nanochat/fork"]);
}

#[test]
fn core_shortcut_routes_eval_enable_neuralavb() {
    let route = resolve_core_shortcuts(
        "eval",
        &[
            "enable".to_string(),
            "neuralavb".to_string(),
            "--enabled=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://eval-plane");
    assert_eq!(route.args, vec!["enable-neuralavb", "--enabled=1"]);
}

#[test]
fn core_shortcut_routes_experiment_loop() {
    let route = resolve_core_shortcuts(
        "experiment",
        &[
            "loop".to_string(),
            "--run-cost-usd=8".to_string(),
            "--baseline-cost-usd=20".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://eval-plane");
    assert_eq!(
        route.args,
        vec![
            "experiment-loop",
            "--run-cost-usd=8",
            "--baseline-cost-usd=20"
        ]
    );
}

#[test]
fn core_shortcut_routes_rl_upgrade_openclaw_v2() {
    let route = resolve_core_shortcuts(
        "rl",
        &[
            "upgrade".to_string(),
            "openclaw-v2".to_string(),
            "--iterations=6".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://eval-plane");
    assert_eq!(route.args, vec!["rl-upgrade", "--iterations=6"]);
}

#[test]
fn core_shortcut_routes_model_optimize_minimax() {
    let route = resolve_core_shortcuts(
        "model",
        &[
            "optimize".to_string(),
            "minimax".to_string(),
            "--compact-lines=20".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://model-router");
    assert_eq!(
        route.args,
        vec!["optimize", "--profile=minimax", "--compact-lines=20"]
    );
}

#[test]
fn core_shortcut_routes_model_use_cheap_to_model_router() {
    let route = resolve_core_shortcuts(
        "model",
        &[
            "use".to_string(),
            "cheap".to_string(),
            "--compact-lines=24".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://model-router");
    assert_eq!(
        route.args,
        vec!["optimize", "--profile=minimax", "--compact-lines=24"]
    );
}

#[test]
fn core_shortcut_routes_model_use_bitnet_to_model_router() {
    let route = resolve_core_shortcuts(
        "model",
        &[
            "use".to_string(),
            "bitnet".to_string(),
            "--source-model=hf://openclaw/bitnet-base".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://model-router");
    assert_eq!(
        route.args,
        vec!["bitnet-use", "--source-model=hf://openclaw/bitnet-base"]
    );
}

#[test]
fn core_shortcut_routes_agent_reset_to_model_router() {
    let route = resolve_core_shortcuts(
        "agent",
        &["reset".to_string(), "--scope=routing".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://model-router");
    assert_eq!(route.args, vec!["reset-agent", "--scope=routing"]);
}

#[test]
fn core_shortcut_routes_economy_to_core_domain() {
    let route = resolve_core_shortcuts(
        "economy",
        &[
            "enable".to_string(),
            "all".to_string(),
            "--apply=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://llm-economy-organ");
    assert_eq!(route.args, vec!["enable", "all", "--apply=1"]);
}

#[test]
fn core_shortcut_routes_economy_upgrade_trading_hand() {
    let route = resolve_core_shortcuts(
        "economy",
        &[
            "upgrade".to_string(),
            "trading-hand".to_string(),
            "--mode=paper".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://llm-economy-organ");
    assert_eq!(route.args, vec!["upgrade-trading-hand", "--mode=paper"]);
}

#[test]
fn core_shortcut_routes_agent_debate_bullbear_to_economy() {
    let route = resolve_core_shortcuts(
        "agent",
        &[
            "debate".to_string(),
            "bullbear".to_string(),
            "--symbol=BTCUSD".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://llm-economy-organ");
    assert_eq!(route.args, vec!["debate-bullbear", "--symbol=BTCUSD"]);
}

#[test]
fn core_shortcut_routes_network_join_hyperspace() {
    let route = resolve_core_shortcuts(
        "network",
        &[
            "join".to_string(),
            "hyperspace".to_string(),
            "--node=alpha".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://network-protocol");
    assert_eq!(route.args, vec!["join-hyperspace", "--node=alpha"]);
}

#[test]
fn core_shortcut_routes_network_dashboard_to_hyperspace_core_lane() {
    let route = resolve_core_shortcuts("network", &["dashboard".to_string()]).expect("route");
    assert_eq!(route.script_rel, "core://network-protocol");
    assert_eq!(route.args, vec!["dashboard"]);
}

#[test]
fn core_shortcut_routes_network_ignite_bitcoin() {
    let route = resolve_core_shortcuts(
        "network",
        &[
            "ignite".to_string(),
            "bitcoin".to_string(),
            "--apply=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://network-protocol");
    assert_eq!(route.args, vec!["ignite-bitcoin", "--apply=1"]);
}

#[test]
fn core_shortcut_routes_network_status_to_network_protocol() {
    let route = resolve_core_shortcuts("network", &["status".to_string()]).expect("route");
    assert_eq!(route.script_rel, "core://network-protocol");
    assert_eq!(route.args, vec!["status"]);
}

#[test]
fn core_shortcut_routes_network_merkle_root_to_network_protocol() {
    let route = resolve_core_shortcuts(
        "network",
        &[
            "merkle-root".to_string(),
            "--account=shadow:alpha".to_string(),
            "--proof=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://network-protocol");
    assert_eq!(
        route.args,
        vec!["merkle-root", "--account=shadow:alpha", "--proof=1"]
    );
}

#[test]
fn core_shortcut_routes_enterprise_compliance_export_to_core_lane() {
    let route = resolve_core_shortcuts(
        "enterprise",
        &[
            "compliance".to_string(),
            "export".to_string(),
            "--profile=auditor".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://enterprise-hardening");
    assert_eq!(route.args, vec!["export-compliance", "--profile=auditor"]);
}

#[test]
fn core_shortcut_routes_enterprise_scale_to_core_lane() {
    let route = resolve_core_shortcuts(
        "enterprise",
        &["scale".to_string(), "--target-nodes=10000".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://enterprise-hardening");
    assert_eq!(route.args, vec!["certify-scale", "--target-nodes=10000"]);
}

#[test]
fn core_shortcut_routes_enterprise_enable_bedrock_to_core_lane() {
    let route = resolve_core_shortcuts(
        "enterprise",
        &[
            "enable".to_string(),
            "bedrock".to_string(),
            "--region=us-west-2".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://enterprise-hardening");
    assert_eq!(route.args, vec!["enable-bedrock", "--region=us-west-2"]);
}

#[test]
fn core_shortcut_routes_enterprise_moat_license_to_core_lane() {
    let route = resolve_core_shortcuts(
        "enterprise",
        &[
            "moat".to_string(),
            "license".to_string(),
            "--primitives=conduit,binary_blob".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://enterprise-hardening");
    assert_eq!(
        route.args,
        vec!["moat-license", "--primitives=conduit,binary_blob"]
    );
}

#[test]
fn core_shortcut_routes_genesis_truth_gate_to_core_lane() {
    let route = resolve_core_shortcuts(
        "genesis",
        &[
            "truth-gate".to_string(),
            "--regression-pass=1".to_string(),
            "--dod-pass=1".to_string(),
            "--verify-pass=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://enterprise-hardening");
    assert_eq!(
        route.args,
        vec![
            "genesis-truth-gate",
            "--regression-pass=1",
            "--dod-pass=1",
            "--verify-pass=1"
        ]
    );
}

#[test]
fn core_shortcut_routes_moat_launch_to_core_lane() {
    let route = resolve_core_shortcuts(
        "moat",
        &["launch-sim".to_string(), "--events=12000".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://enterprise-hardening");
    assert_eq!(route.args, vec!["moat-launch-sim", "--events=12000"]);
}

#[test]
fn core_shortcut_routes_seed_deploy_viral_to_seed_protocol() {
    let route = resolve_core_shortcuts(
        "seed",
        &[
            "deploy".to_string(),
            "viral".to_string(),
            "--targets=node-a,node-b".to_string(),
            "--apply=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://seed-protocol");
    assert_eq!(
        route.args,
        vec![
            "deploy",
            "--profile=viral",
            "--targets=node-a,node-b",
            "--apply=1"
        ]
    );
}

#[test]
fn core_shortcut_routes_seed_ignite_viral_to_seed_protocol() {
    let route = resolve_core_shortcuts(
        "seed",
        &[
            "ignite".to_string(),
            "viral".to_string(),
            "--replication-cap=16".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://seed-protocol");
    assert_eq!(
        route.args,
        vec!["deploy", "--profile=viral", "--replication-cap=16"]
    );
}

#[test]
fn core_shortcut_routes_seed_defaults_to_status() {
    let route = resolve_core_shortcuts("seed", &[]).expect("route");
    assert_eq!(route.script_rel, "core://seed-protocol");
    assert_eq!(route.args, vec!["status"]);
}

#[test]
fn core_shortcut_routes_keys_open_to_intelligence_nexus() {
    let route = resolve_core_shortcuts("keys", &["open".to_string()]).expect("route");
    assert_eq!(route.script_rel, "core://intelligence-nexus");
    assert_eq!(route.args, vec!["open"]);
}

#[test]
fn core_shortcut_routes_keys_add_alias_to_add_key() {
    let route = resolve_core_shortcuts(
        "keys",
        &["add".to_string(), "--provider=openai".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://intelligence-nexus");
    assert_eq!(route.args, vec!["add-key", "--provider=openai"]);
}

#[test]
fn core_shortcut_routes_keys_rotate_alias_to_rotate_key() {
    let route = resolve_core_shortcuts(
        "keys",
        &["rotate".to_string(), "--provider=openai".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://intelligence-nexus");
    assert_eq!(route.args, vec!["rotate-key", "--provider=openai"]);
}

#[test]
fn core_shortcut_routes_keys_revoke_alias_to_revoke_key() {
    let route = resolve_core_shortcuts(
        "keys",
        &["revoke".to_string(), "--provider=openai".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://intelligence-nexus");
    assert_eq!(route.args, vec!["revoke-key", "--provider=openai"]);
}

#[test]
fn core_shortcut_routes_graph_pagerank_to_graph_toolkit() {
    let route = resolve_core_shortcuts(
        "graph",
        &[
            "pagerank".to_string(),
            "--dataset=memory-vault".to_string(),
            "--iterations=32".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://graph-toolkit");
    assert_eq!(
        route.args,
        vec!["pagerank", "--dataset=memory-vault", "--iterations=32"]
    );
}

#[test]
fn core_shortcut_routes_graph_defaults_to_status() {
    let route = resolve_core_shortcuts("graph", &[]).expect("route");
    assert_eq!(route.script_rel, "core://graph-toolkit");
    assert_eq!(route.args, vec!["status"]);
}

#[test]
fn core_shortcut_routes_research_stealth_flags_to_core_plane_fetch() {
    let route = resolve_core_shortcuts(
        "research",
        &[
            "--stealth".to_string(),
            "--url=https://example.com".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://research-plane");
    assert_eq!(
        route.args,
        vec!["fetch", "--url=https://example.com", "--mode=stealth"]
    );
}

#[test]
fn core_shortcut_routes_research_default_fetch_mode_to_auto() {
    let route = resolve_core_shortcuts(
        "research",
        &["fetch".to_string(), "--url=https://example.com".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://research-plane");
    assert_eq!(
        route.args,
        vec!["fetch", "--url=https://example.com", "--mode=auto"]
    );
}

#[test]
fn core_shortcut_routes_research_firmware_to_binary_vuln_lane() {
    let route = resolve_core_shortcuts(
        "research",
        &[
            "--firmware=fw.bin".to_string(),
            "--format=jsonl".to_string(),
            "--strict=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://binary-vuln-plane");
    assert_eq!(
        route.args,
        vec![
            "scan",
            "--dx-source=research-firmware",
            "--input=fw.bin",
            "--format=jsonl",
            "--strict=1"
        ]
    );
}

#[test]
fn core_shortcut_routes_top_level_crawl_goal_to_research_plane() {
    let route = resolve_core_shortcuts(
        "crawl",
        &[
            "memory".to_string(),
            "coherence".to_string(),
            "--max-pages=4".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://research-plane");
    assert_eq!(
        route.args,
        vec!["goal-crawl", "--goal=memory coherence", "--max-pages=4"]
    );
}

#[test]
fn core_shortcut_routes_top_level_map_to_research_plane() {
    let route =
        resolve_core_shortcuts("map", &["example.com".to_string(), "--depth=3".to_string()])
            .expect("route");
    assert_eq!(route.script_rel, "core://research-plane");
    assert_eq!(
        route.args,
        vec!["map-site", "--domain=example.com", "--depth=3"]
    );
}

#[test]
fn core_shortcut_routes_top_level_monitor_to_research_plane() {
    let route = resolve_core_shortcuts(
        "monitor",
        &[
            "https://example.com/feed".to_string(),
            "--strict=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://research-plane");
    assert_eq!(
        route.args,
        vec!["monitor", "--url=https://example.com/feed", "--strict=1"]
    );
}

#[test]
fn core_shortcut_routes_assimilate_scrapy_core_to_research_plane() {
    let route = resolve_core_shortcuts(
        "assimilate",
        &["scrape://scrapy-core".to_string(), "--strict=1".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://research-plane");
    assert_eq!(route.args, vec!["template-governance", "--strict=1"]);
}

#[test]
fn core_shortcut_routes_assimilate_firecrawl_core_to_research_plane() {
    let route = resolve_core_shortcuts(
        "assimilate",
        &[
            "scrape://firecrawl-core".to_string(),
            "--strict=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://research-plane");
    assert_eq!(
        route.args,
        vec!["firecrawl-template-governance", "--strict=1"]
    );
}

#[test]
fn core_shortcut_routes_assimilate_doc2dict_core_to_parse_plane() {
    let route = resolve_core_shortcuts(
        "assimilate",
        &[
            "parse://doc2dict-core".to_string(),
            "--strict=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://parse-plane");
    assert_eq!(route.args, vec!["template-governance", "--strict=1"]);
}

#[test]
fn core_shortcut_routes_assimilate_llamaindex_to_llamaindex_bridge() {
    let route = resolve_core_shortcuts(
        "assimilate",
        &[
            "llamaindex".to_string(),
            "--payload-base64=e30=".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://llamaindex-bridge");
    assert_eq!(
        route.args,
        vec!["register-connector", "--payload-base64=e30="]
    );
}

#[test]
fn core_shortcut_routes_assimilate_google_adk_to_google_adk_bridge() {
    let route = resolve_core_shortcuts(
        "assimilate",
        &[
            "google-adk".to_string(),
            "--payload-base64=e30=".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://google-adk-bridge");
    assert_eq!(
        route.args,
        vec!["register-tool-manifest", "--payload-base64=e30="]
    );
}

#[test]
fn core_shortcut_routes_assimilate_camel_to_camel_bridge() {
    let route = resolve_core_shortcuts(
        "assimilate",
        &["camel".to_string(), "--payload-base64=e30=".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://camel-bridge");
    assert_eq!(route.args, vec!["import-dataset", "--payload-base64=e30="]);
}

#[test]
fn core_shortcut_routes_assimilate_haystack_to_haystack_bridge() {
    let route = resolve_core_shortcuts(
        "assimilate",
        &["haystack".to_string(), "--payload-base64=e30=".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://haystack-bridge");
    assert_eq!(
        route.args,
        vec!["register-pipeline", "--payload-base64=e30="]
    );
}

#[test]
fn core_shortcut_routes_assimilate_langchain_to_langchain_bridge() {
    let route = resolve_core_shortcuts(
        "assimilate",
        &["langchain".to_string(), "--payload-base64=e30=".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://langchain-bridge");
    assert_eq!(
        route.args,
        vec!["import-integration", "--payload-base64=e30="]
    );
}

#[test]
fn core_shortcut_routes_assimilate_pydantic_ai_to_pydantic_ai_bridge() {
    let route = resolve_core_shortcuts(
        "assimilate",
        &["pydantic-ai".to_string(), "--payload-base64=e30=".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://pydantic-ai-bridge");
    assert_eq!(route.args, vec!["register-agent", "--payload-base64=e30="]);
}

#[test]
fn core_shortcut_routes_assimilate_mastra_to_mastra_bridge() {
    let route = resolve_core_shortcuts(
        "assimilate",
        &["mastra".to_string(), "--payload-base64=e30=".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://mastra-bridge");
    assert_eq!(route.args, vec!["register-graph", "--payload-base64=e30="]);
}

#[test]
fn core_shortcut_routes_parse_doc_to_parse_plane() {
    let route = resolve_core_shortcuts(
        "parse",
        &[
            "doc".to_string(),
            "fixtures/report.html".to_string(),
            "--mapping=default".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://parse-plane");
    assert_eq!(
        route.args,
        vec![
            "parse-doc",
            "--file=fixtures/report.html",
            "--mapping=default"
        ]
    );
}

#[test]
fn core_shortcut_routes_parse_export_to_parse_plane() {
    let route = resolve_core_shortcuts(
        "parse",
        &[
            "export".to_string(),
            "core/local/state/ops/parse_plane/flatten/latest.json".to_string(),
            "core/local/artifacts/parse/export.json".to_string(),
            "--format=json".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://parse-plane");
    assert_eq!(
        route.args,
        vec![
            "export",
            "--from-path=core/local/state/ops/parse_plane/flatten/latest.json",
            "--output-path=core/local/artifacts/parse/export.json",
            "--format=json"
        ]
    );
}

#[test]
fn core_shortcut_routes_parse_visualize_to_parse_plane() {
    let route = resolve_core_shortcuts(
        "parse",
        &[
            "visualize".to_string(),
            "core/local/state/ops/parse_plane/parse_doc/latest.json".to_string(),
            "--strict=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://parse-plane");
    assert_eq!(
        route.args,
        vec![
            "visualize",
            "--from-path=core/local/state/ops/parse_plane/parse_doc/latest.json",
            "--strict=1"
        ]
    );
}

#[test]
fn core_shortcut_routes_mcp_status_to_mcp_plane() {
    let route = resolve_core_shortcuts("mcp", &[]).expect("route");
    assert_eq!(route.script_rel, "core://mcp-plane");
    assert_eq!(route.args, vec!["status"]);
}

#[test]
fn core_shortcut_routes_mcp_expose_to_mcp_plane() {
    let route = resolve_core_shortcuts(
        "mcp",
        &[
            "expose".to_string(),
            "research-agent".to_string(),
            "--tools=fetch,extract".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://mcp-plane");
    assert_eq!(
        route.args,
        vec!["expose", "--agent=research-agent", "--tools=fetch,extract"]
    );
}

#[test]
fn core_shortcut_routes_flow_compile_to_flow_plane() {
    let route = resolve_core_shortcuts(
        "flow",
        &[
            "compile".to_string(),
            "core/local/artifacts/flow/canvas.json".to_string(),
            "--strict=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://flow-plane");
    assert_eq!(
        route.args,
        vec![
            "compile",
            "--canvas-path=core/local/artifacts/flow/canvas.json",
            "--strict=1"
        ]
    );
}

#[test]
fn core_shortcut_routes_flow_run_to_flow_plane() {
    let route = resolve_core_shortcuts(
        "flow",
        &[
            "run".to_string(),
            "--run-id=batch29-flow".to_string(),
            "--strict=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://flow-plane");
    assert_eq!(
        route.args,
        vec![
            "playground",
            "--op=play",
            "--run-id=batch29-flow",
            "--strict=1"
        ]
    );
}

#[test]
fn core_shortcut_routes_flow_install_to_flow_plane() {
    let route = resolve_core_shortcuts(
        "flow",
        &[
            "install".to_string(),
            "--manifest=planes/contracts/flow/template_pack_manifest_v1.json".to_string(),
            "--strict=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://flow-plane");
    assert_eq!(
        route.args,
        vec![
            "install",
            "--manifest=planes/contracts/flow/template_pack_manifest_v1.json",
            "--strict=1"
        ]
    );
}

#[test]
fn core_shortcut_routes_blobs_to_binary_blob_runtime() {
    let route = resolve_core_shortcuts("blobs", &["migrate".to_string(), "--apply=1".to_string()])
        .expect("route");
    assert_eq!(route.script_rel, "core://binary-blob-runtime");
    assert_eq!(route.args, vec!["migrate", "--apply=1"]);
}

#[test]
fn core_shortcut_routes_directives_migrate_to_directive_kernel() {
    let route = resolve_core_shortcuts(
        "directives",
        &["migrate".to_string(), "--apply=1".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://directive-kernel");
    assert_eq!(route.args, vec!["migrate", "--apply=1"]);
}

#[test]
fn core_shortcut_routes_directives_dashboard_to_directive_kernel() {
    let route = resolve_core_shortcuts("directives", &["dashboard".to_string()]).expect("route");
    assert_eq!(route.script_rel, "core://directive-kernel");
    assert_eq!(route.args, vec!["dashboard"]);
}

#[test]
fn core_shortcut_routes_prime_sign_to_directive_kernel() {
    let route = resolve_core_shortcuts(
        "prime",
        &["sign".to_string(), "--directive=Always safe".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://directive-kernel");
    assert_eq!(route.args, vec!["prime-sign", "--directive=Always safe"]);
}

#[test]
fn core_shortcut_routes_organism_ignite_to_organism_layer() {
    let route =
        resolve_core_shortcuts("organism", &["ignite".to_string(), "--apply=1".to_string()])
            .expect("route");
    assert_eq!(route.script_rel, "core://organism-layer");
    assert_eq!(route.args, vec!["ignite", "--apply=1"]);
}

#[test]
fn core_shortcut_routes_rsi_ignite_to_rsi_ignition() {
    let route = resolve_core_shortcuts("rsi", &["ignite".to_string(), "--apply=1".to_string()])
        .expect("route");
    assert_eq!(route.script_rel, "core://rsi-ignition");
    assert_eq!(route.args, vec!["ignite", "--apply=1"]);
}

#[test]
fn core_shortcut_routes_veto_to_directive_kernel() {
    let route =
        resolve_core_shortcuts("veto", &["--action=rsi_proposal".to_string()]).expect("route");
    assert_eq!(route.script_rel, "core://directive-kernel");
    assert_eq!(
        route.args,
        vec![
            "compliance-check",
            "--action=veto",
            "--allow=0",
            "--action=rsi_proposal"
        ]
    );
}

#[test]
fn core_shortcut_routes_model_buy_credits_to_intelligence_nexus() {
    let route = resolve_core_shortcuts(
        "model",
        &[
            "buy".to_string(),
            "credits".to_string(),
            "--provider=openai".to_string(),
            "--amount=250".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://intelligence-nexus");
    assert_eq!(
        route.args,
        vec!["buy-credits", "--provider=openai", "--amount=250"]
    );
}

#[test]
fn core_shortcut_routes_compute_share_to_network_compute_proof() {
    let route = resolve_core_shortcuts("compute", &["share".to_string(), "--gpu=1".to_string()])
        .expect("route");
    assert_eq!(route.script_rel, "core://p2p-gossip-seed");
    assert_eq!(route.args, vec!["compute-proof", "--share=1", "--gpu=1"]);
}

#[test]
fn core_shortcut_routes_skills_enable_to_assimilation_controller() {
    let route = resolve_core_shortcuts(
        "skills",
        &[
            "enable".to_string(),
            "perplexity-mode".to_string(),
            "--apply=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://assimilation-controller");
    assert_eq!(
        route.args,
        vec!["skills-enable", "perplexity-mode", "--apply=1"]
    );
}

#[test]
fn core_shortcut_routes_skills_dashboard_to_skills_plane() {
    let route = resolve_core_shortcuts("skills", &["dashboard".to_string()]).expect("route");
    assert_eq!(route.script_rel, "core://skills-plane");
    assert_eq!(route.args, vec!["dashboard"]);
}

#[test]
fn core_shortcut_routes_skills_spawn_to_assimilation_controller() {
    let route = resolve_core_shortcuts(
        "skills",
        &[
            "spawn".to_string(),
            "--task=launch".to_string(),
            "--roles=researcher,executor".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://assimilation-controller");
    assert_eq!(
        route.args,
        vec![
            "skills-spawn-subagents",
            "--task=launch",
            "--roles=researcher,executor"
        ]
    );
}

#[test]
fn core_shortcut_routes_skills_computer_use_to_assimilation_controller() {
    let route = resolve_core_shortcuts(
        "skills",
        &[
            "computer-use".to_string(),
            "--action=open browser".to_string(),
            "--target=desktop".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://assimilation-controller");
    assert_eq!(
        route.args,
        vec![
            "skills-computer-use",
            "--action=open browser",
            "--target=desktop"
        ]
    );
}

#[test]
fn core_shortcut_routes_skills_status_to_skills_plane() {
    let route = resolve_core_shortcuts("skills", &[]).expect("route");
    assert_eq!(route.script_rel, "core://skills-plane");
    assert_eq!(route.args, vec!["status"]);
}

#[test]
fn core_shortcut_routes_skill_create_to_skills_plane() {
    let route = resolve_core_shortcuts(
        "skill",
        &[
            "create".to_string(),
            "weekly".to_string(),
            "growth".to_string(),
            "report".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://skills-plane");
    assert_eq!(route.args, vec!["create", "--name=weekly growth report"]);
}

#[test]
fn core_shortcut_routes_skill_run_to_skills_plane() {
    let route = resolve_core_shortcuts(
        "skill",
        &[
            "run".to_string(),
            "--skill=researcher".to_string(),
            "--input=check".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://skills-plane");
    assert_eq!(
        route.args,
        vec!["run", "--skill=researcher", "--input=check"]
    );
}

#[test]
fn core_shortcut_routes_skill_list_to_skills_plane() {
    let route = resolve_core_shortcuts("skill", &["list".to_string()]).expect("route");
    assert_eq!(route.script_rel, "core://skills-plane");
    assert_eq!(route.args, vec!["list"]);
}

#[test]
fn core_shortcut_routes_binary_vuln_to_core_lane() {
    let route = resolve_core_shortcuts(
        "binary-vuln",
        &["scan".to_string(), "--input=a.bin".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://binary-vuln-plane");
    assert_eq!(route.args, vec!["scan", "--input=a.bin"]);
}

#[test]
fn core_shortcut_routes_business_to_business_plane() {
    let route = resolve_core_shortcuts("business", &[]).expect("route");
    assert_eq!(route.script_rel, "core://business-plane");
    assert_eq!(route.args, vec!["status"]);
}

#[test]
fn core_shortcut_routes_canyon_to_canyon_plane() {
    let route = resolve_core_shortcuts("canyon", &[]).expect("route");
    assert_eq!(route.script_rel, "core://canyon-plane");
    assert_eq!(route.args, vec!["status"]);
}

#[test]
fn core_shortcut_routes_canyon_benchmark_gate_to_canyon_plane() {
    let route = resolve_core_shortcuts(
        "canyon",
        &[
            "benchmark-gate".to_string(),
            "--op=run".to_string(),
            "--milestone=day90".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://canyon-plane");
    assert_eq!(
        route.args,
        vec!["benchmark-gate", "--op=run", "--milestone=day90"]
    );
}

#[test]
fn core_shortcut_routes_init_to_canyon_ecosystem_init() {
    let route = resolve_core_shortcuts(
        "init",
        &[
            "starter-web".to_string(),
            "--target-dir=/tmp/demo".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://canyon-plane");
    assert_eq!(
        route.args,
        vec![
            "ecosystem",
            "--op=init",
            "--template=starter-web",
            "--target-dir=/tmp/demo"
        ]
    );
}

#[test]
fn core_shortcut_routes_init_pure_to_canyon_ecosystem_init() {
    let route = resolve_core_shortcuts(
        "init",
        &[
            "--pure".to_string(),
            "--target-dir=/tmp/pure-demo".to_string(),
            "--dry-run=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://canyon-plane");
    assert_eq!(
        route.args,
        vec![
            "ecosystem",
            "--op=init",
            "--workspace-mode=pure",
            "--pure",
            "--target-dir=/tmp/pure-demo",
            "--dry-run=1"
        ]
    );
}

#[test]
fn core_shortcut_routes_init_tiny_max_forces_pure_workspace_mode() {
    let route = resolve_core_shortcuts(
        "init",
        &[
            "--tiny-max=1".to_string(),
            "--target-dir=/tmp/tiny-max-demo".to_string(),
            "--dry-run=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://canyon-plane");
    assert_eq!(
        route.args,
        vec![
            "ecosystem",
            "--op=init",
            "--workspace-mode=pure",
            "--pure=1",
            "--tiny-max=1",
            "--target-dir=/tmp/tiny-max-demo",
            "--dry-run=1"
        ]
    );
}

#[test]
fn core_shortcut_routes_init_help_to_canyon_help() {
    let route = resolve_core_shortcuts("init", &["--help".to_string()]).expect("route");
    assert_eq!(route.script_rel, "core://canyon-plane");
    assert_eq!(route.args, vec!["help"]);
}

#[test]
fn core_shortcut_routes_marketplace_publish_to_canyon_ecosystem() {
    let route = resolve_core_shortcuts(
        "marketplace",
        &[
            "publish".to_string(),
            "--hand-id=starter".to_string(),
            "--receipt-file=/tmp/r.json".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://canyon-plane");
    assert_eq!(
        route.args,
        vec![
            "ecosystem",
            "--op=marketplace-publish",
            "--hand-id=starter",
            "--receipt-file=/tmp/r.json"
        ]
    );
}

#[test]
fn core_shortcut_routes_replay_to_enterprise_hardening() {
    let route =
        resolve_core_shortcuts("replay", &["--receipt-hash=abc123".to_string()]).expect("route");
    assert_eq!(route.script_rel, "core://enterprise-hardening");
    assert_eq!(route.args, vec!["replay", "--receipt-hash=abc123"]);
}

#[test]
fn core_shortcut_routes_ai_to_enterprise_hardening() {
    let route = resolve_core_shortcuts("ai", &["--model=ollama/llama3.2:latest".to_string()])
        .expect("route");
    assert_eq!(route.script_rel, "core://enterprise-hardening");
    assert_eq!(route.args, vec!["ai", "--model=ollama/llama3.2:latest"]);
}

#[test]
fn core_shortcut_routes_chaos_to_enterprise_hardening() {
    let route = resolve_core_shortcuts("chaos", &["run".to_string(), "--agents=16".to_string()])
        .expect("route");
    assert_eq!(route.script_rel, "core://enterprise-hardening");
    assert_eq!(route.args, vec!["chaos-run", "--agents=16"]);
}

#[test]
fn core_shortcut_routes_chaos_isolate_to_enterprise_hardening() {
    let route = resolve_core_shortcuts("chaos", &["isolate".to_string(), "--agents=4".to_string()])
        .expect("route");
    assert_eq!(route.script_rel, "core://enterprise-hardening");
    assert_eq!(
        route.args,
        vec!["chaos-run", "--suite=isolate", "--agents=4"]
    );
}

#[test]
fn core_shortcut_routes_assistant_to_enterprise_hardening() {
    let route =
        resolve_core_shortcuts("assistant", &["--topic=onboarding".to_string()]).expect("route");
    assert_eq!(route.script_rel, "core://enterprise-hardening");
    assert_eq!(route.args, vec!["assistant-mode", "--topic=onboarding"]);
}

#[test]
fn core_shortcut_routes_adaptive_default_to_adaptive_lane_status() {
    let route = resolve_core_shortcuts("adaptive", &[]).expect("route");
    assert_eq!(route.script_rel, "core://adaptive-intelligence");
    assert_eq!(route.args, vec!["status"]);
}

#[test]
fn core_shortcut_routes_adaptive_propose_to_adaptive_lane() {
    let route = resolve_core_shortcuts(
        "adaptive-intelligence",
        &[
            "propose".to_string(),
            "--prompt=refactor scheduler".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://adaptive-intelligence");
    assert_eq!(route.args, vec!["propose", "--prompt=refactor scheduler"]);
}

#[test]
fn core_shortcut_routes_gov_alias_to_government_plane() {
    let route = resolve_core_shortcuts("gov", &["classification".to_string()]).expect("route");
    assert_eq!(route.script_rel, "core://government-plane");
    assert_eq!(route.args, vec!["classification"]);
}

#[test]
fn core_shortcut_routes_bank_alias_to_finance_plane() {
    let route = resolve_core_shortcuts("bank", &["transaction".to_string()]).expect("route");
    assert_eq!(route.script_rel, "core://finance-plane");
    assert_eq!(route.args, vec!["transaction"]);
}

#[test]
fn core_shortcut_routes_hospital_alias_to_healthcare_plane() {
    let route = resolve_core_shortcuts("hospital", &["cds".to_string()]).expect("route");
    assert_eq!(route.script_rel, "core://healthcare-plane");
    assert_eq!(route.args, vec!["cds"]);
}

#[test]
fn core_shortcut_routes_vertical_to_vertical_plane() {
    let route = resolve_core_shortcuts("vertical", &[]).expect("route");
    assert_eq!(route.script_rel, "core://vertical-plane");
    assert_eq!(route.args, vec!["status"]);
}

#[test]
fn core_shortcut_routes_nexus_to_nexus_plane() {
    let route = resolve_core_shortcuts("nexus", &[]).expect("route");
    assert_eq!(route.script_rel, "core://nexus-plane");
    assert_eq!(route.args, vec!["status"]);
}

#[test]
fn core_shortcut_routes_scan_binary_to_binary_vuln_lane() {
    let route = resolve_core_shortcuts("scan", &["binary".to_string(), "firmware.bin".to_string()])
        .expect("route");
    assert_eq!(route.script_rel, "core://binary-vuln-plane");
    assert_eq!(
        route.args,
        vec!["scan", "--dx-source=scan-binary", "--input=firmware.bin"]
    );
}

#[test]
fn core_shortcut_routes_shadow_discover_to_hermes_lane() {
    let route = resolve_core_shortcuts(
        "shadow",
        &["discover".to_string(), "--shadow=alpha".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://hermes-plane");
    assert_eq!(route.args, vec!["discover", "--shadow=alpha"]);
}

#[test]
fn core_shortcut_routes_top_to_hermes_cockpit() {
    let route = resolve_core_shortcuts("top", &[]).expect("route");
    assert_eq!(route.script_rel, "core://hermes-plane");
    assert_eq!(route.args, vec!["cockpit"]);
}

#[test]
fn core_shortcut_routes_status_dashboard_to_hermes_cockpit() {
    let route = resolve_core_shortcuts("status", &["--dashboard".to_string()]).expect("route");
    assert_eq!(route.script_rel, "core://hermes-plane");
    assert_eq!(route.args, vec!["cockpit"]);
}

#[test]
fn core_shortcut_routes_browser_to_vbrowser_plane() {
    let route = resolve_core_shortcuts(
        "browser",
        &["start".to_string(), "--url=https://example.com".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://vbrowser-plane");
    assert_eq!(
        route.args,
        vec!["session-start", "--url=https://example.com"]
    );
}

#[test]
fn core_shortcut_routes_agency_create_to_agency_plane() {
    let route = resolve_core_shortcuts(
        "agency",
        &[
            "create".to_string(),
            "--template=frontend-wizard".to_string(),
            "--name=ux-shadow".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://agency-plane");
    assert_eq!(
        route.args,
        vec![
            "create-shadow",
            "--template=frontend-wizard",
            "--name=ux-shadow"
        ]
    );
}

#[test]
fn core_shortcut_routes_shadow_browser_flag_to_vbrowser_plane() {
    let route = resolve_core_shortcuts(
        "shadow",
        &[
            "--browser".to_string(),
            "--session-id=live".to_string(),
            "--url=https://example.com".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://vbrowser-plane");
    assert_eq!(
        route.args,
        vec![
            "session-start",
            "--shadow=default-shadow",
            "--session-id=live",
            "--url=https://example.com"
        ]
    );
}

#[test]
fn core_shortcut_routes_shadow_delegate_to_hermes_plane() {
    let route = resolve_core_shortcuts(
        "shadow",
        &[
            "delegate".to_string(),
            "--task=triage".to_string(),
            "--parent=alpha".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://hermes-plane");
    assert_eq!(
        route.args,
        vec!["delegate", "--task=triage", "--parent=alpha"]
    );
}

#[test]
fn core_shortcut_routes_shadow_continuity_to_hermes_plane() {
    let route = resolve_core_shortcuts(
        "shadow",
        &[
            "continuity".to_string(),
            "--op=status".to_string(),
            "--session-id=s1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://hermes-plane");
    assert_eq!(
        route.args,
        vec!["continuity", "--op=status", "--session-id=s1"]
    );
}

#[test]
fn core_shortcut_routes_shadow_create_template_to_agency_plane() {
    let route = resolve_core_shortcuts(
        "shadow",
        &[
            "create".to_string(),
            "--template=security-engineer".to_string(),
            "--name=sec-shadow".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://agency-plane");
    assert_eq!(
        route.args,
        vec![
            "create-shadow",
            "--template=security-engineer",
            "--name=sec-shadow"
        ]
    );
}

#[test]
fn core_shortcut_routes_team_dashboard_to_collab_plane() {
    let route =
        resolve_core_shortcuts("team", &["dashboard".to_string(), "--team=ops".to_string()])
            .expect("route");
    assert_eq!(route.script_rel, "core://collab-plane");
    assert_eq!(route.args, vec!["dashboard", "--team=ops"]);
}

#[test]
fn core_shortcut_routes_team_schedule_to_collab_plane() {
    let route = resolve_core_shortcuts(
        "team",
        &[
            "schedule".to_string(),
            "--op=kickoff".to_string(),
            "--team=ops".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://collab-plane");
    assert_eq!(route.args, vec!["schedule", "--op=kickoff", "--team=ops"]);
}

#[test]
fn core_shortcut_routes_company_budget_to_company_plane() {
    let route = resolve_core_shortcuts(
        "company",
        &[
            "budget".to_string(),
            "--agent=alpha".to_string(),
            "--tokens=100".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://company-plane");
    assert_eq!(
        route.args,
        vec!["budget-enforce", "--agent=alpha", "--tokens=100"]
    );
}

#[test]
fn core_shortcut_routes_company_ticket_to_company_plane() {
    let route = resolve_core_shortcuts(
        "company",
        &[
            "ticket".to_string(),
            "--op=create".to_string(),
            "--title=Fix ingestion".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://company-plane");
    assert_eq!(
        route.args,
        vec!["ticket", "--op=create", "--title=Fix ingestion"]
    );
}

#[test]
fn core_shortcut_routes_company_heartbeat_to_company_plane() {
    let route = resolve_core_shortcuts(
        "company",
        &[
            "heartbeat".to_string(),
            "--op=tick".to_string(),
            "--team=ops".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://company-plane");
    assert_eq!(route.args, vec!["heartbeat", "--op=tick", "--team=ops"]);
}

#[test]
fn core_shortcut_routes_top_level_ticket_to_company_plane() {
    let route = resolve_core_shortcuts(
        "ticket",
        &[
            "--op=create".to_string(),
            "--title=Stability hotfix".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://company-plane");
    assert_eq!(
        route.args,
        vec!["ticket", "--op=create", "--title=Stability hotfix"]
    );
}

#[test]
fn core_shortcut_routes_top_level_heartbeat_to_company_plane() {
    let route = resolve_core_shortcuts(
        "heartbeat",
        &["--op=tick".to_string(), "--team=platform".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://company-plane");
    assert_eq!(
        route.args,
        vec!["heartbeat", "--op=tick", "--team=platform"]
    );
}

#[test]
fn core_shortcut_routes_substrate_capture_to_substrate_plane() {
    let route = resolve_core_shortcuts(
        "substrate",
        &[
            "capture".to_string(),
            "--adapter=wifi-csi-esp32".to_string(),
            "--strict=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://substrate-plane");
    assert_eq!(
        route.args,
        vec!["csi-capture", "--adapter=wifi-csi-esp32", "--strict=1"]
    );
}

#[test]
fn core_shortcut_routes_eye_enable_wifi_to_substrate_plane() {
    let route =
        resolve_core_shortcuts("eye", &["enable".to_string(), "wifi".to_string()]).expect("route");
    assert_eq!(route.script_rel, "core://substrate-plane");
    assert_eq!(route.args, vec!["eye-bind", "--op=enable", "--source=wifi"]);
}

#[test]
fn core_shortcut_routes_substrate_enable_biological_to_substrate_plane() {
    let route = resolve_core_shortcuts(
        "substrate",
        &[
            "enable".to_string(),
            "biological".to_string(),
            "--persona=neural-watch".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://substrate-plane");
    assert_eq!(
        route.args,
        vec!["bio-enable", "--mode=biological", "--persona=neural-watch"]
    );
}

#[test]
fn core_shortcut_routes_observability_monitor_to_observability_plane() {
    let route = resolve_core_shortcuts(
        "observability",
        &[
            "monitor".to_string(),
            "--severity=high".to_string(),
            "--message=latency_spike".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://observability-plane");
    assert_eq!(
        route.args,
        vec!["monitor", "--severity=high", "--message=latency_spike"]
    );
}

#[test]
fn core_shortcut_routes_observability_selfhost_status_without_forced_deploy() {
    let route = resolve_core_shortcuts(
        "observability",
        &["selfhost".to_string(), "status".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://observability-plane");
    assert_eq!(route.args, vec!["selfhost", "status"]);
}

#[test]
fn core_shortcut_routes_observability_enable_acp_provenance() {
    let route = resolve_core_shortcuts(
        "observability",
        &[
            "enable".to_string(),
            "acp-provenance".to_string(),
            "--visibility-mode=meta".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://observability-plane");
    assert_eq!(
        route.args,
        vec!["acp-provenance", "--op=enable", "--visibility-mode=meta"]
    );
}

#[test]
fn core_shortcut_routes_schedule_to_persist_plane() {
    let route = resolve_core_shortcuts(
        "schedule",
        &[
            "--op=upsert".to_string(),
            "--job=nightly".to_string(),
            "--cron=0 2 * * *".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://persist-plane");
    assert_eq!(
        route.args,
        vec![
            "schedule",
            "--op=upsert",
            "--job=nightly",
            "--cron=0 2 * * *"
        ]
    );
}

#[test]
fn core_shortcut_routes_mobile_to_persist_plane() {
    let route = resolve_core_shortcuts(
        "mobile",
        &["--op=publish".to_string(), "--session-id=phone".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://persist-plane");
    assert_eq!(
        route.args,
        vec!["mobile-cockpit", "--op=publish", "--session-id=phone"]
    );
}

#[test]
fn core_shortcut_routes_mobile_daemon_enable_to_persist_plane() {
    let route = resolve_core_shortcuts(
        "mobile",
        &[
            "daemon".to_string(),
            "enable".to_string(),
            "--platform=android".to_string(),
            "--edge-backend=bitnet".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://persist-plane");
    assert_eq!(
        route.args,
        vec![
            "mobile-daemon",
            "--op=enable",
            "--platform=android",
            "--edge-backend=bitnet"
        ]
    );
}

#[test]
fn core_shortcut_routes_connector_add_to_persist_plane() {
    let route = resolve_core_shortcuts("connector", &["add".to_string(), "slack".to_string()])
        .expect("route");
    assert_eq!(route.script_rel, "core://persist-plane");
    assert_eq!(
        route.args,
        vec!["connector", "--op=add", "--provider=slack"]
    );
}

#[test]
fn core_shortcut_routes_cowork_delegate_to_persist_plane() {
    let route = resolve_core_shortcuts(
        "cowork",
        &[
            "delegate".to_string(),
            "--task=ship-batch16".to_string(),
            "--parent=ops-lead".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://persist-plane");
    assert_eq!(
        route.args,
        vec![
            "cowork",
            "--op=delegate",
            "--task=ship-batch16",
            "--parent=ops-lead"
        ]
    );
}

#[test]
fn core_shortcut_routes_app_run_code_engineer_to_app_plane() {
    let route = resolve_core_shortcuts(
        "app",
        &[
            "run".to_string(),
            "code-engineer".to_string(),
            "build".to_string(),
            "an".to_string(),
            "agent".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://app-plane");
    assert_eq!(
        route.args,
        vec!["run", "--app=code-engineer", "--prompt=build an agent"]
    );
}

#[test]
fn core_shortcut_routes_app_run_chat_ui_to_app_plane() {
    let route = resolve_core_shortcuts(
        "app",
        &[
            "run".to_string(),
            "chat-ui".to_string(),
            "--session-id=s1".to_string(),
            "hello".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://app-plane");
    assert_eq!(
        route.args,
        vec!["run", "--app=chat-ui", "--session-id=s1", "--message=hello"]
    );
}

#[test]
fn core_shortcut_routes_top_level_chat_starter_history_action() {
    let route = resolve_core_shortcuts(
        "chat-starter",
        &["history".to_string(), "--session-id=s1".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://app-plane");
    assert_eq!(
        route.args,
        vec!["history", "--app=chat-starter", "--session-id=s1"]
    );
}

#[test]
fn core_shortcut_routes_top_level_chat_starter_plain_message_to_run() {
    let route = resolve_core_shortcuts(
        "chat-starter",
        &[
            "hello".to_string(),
            "from".to_string(),
            "shortcut".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://app-plane");
    assert_eq!(
        route.args,
        vec!["run", "--app=chat-starter", "--message=hello from shortcut"]
    );
}

#[test]
fn core_shortcut_routes_top_level_chat_ui_switch_provider_action() {
    let route = resolve_core_shortcuts(
        "chat-ui",
        &[
            "switch-provider".to_string(),
            "--provider=anthropic".to_string(),
            "--model=claude-sonnet".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://app-plane");
    assert_eq!(
        route.args,
        vec![
            "switch-provider",
            "--app=chat-ui",
            "--provider=anthropic",
            "--model=claude-sonnet"
        ]
    );
}

#[test]
fn core_shortcut_routes_build_goal_to_app_plane() {
    let route = resolve_core_shortcuts(
        "build",
        &[
            "ship".to_string(),
            "a".to_string(),
            "receipted".to_string(),
            "api".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://app-plane");
    assert_eq!(
        route.args,
        vec![
            "build",
            "--app=code-engineer",
            "--goal=ship a receipted api"
        ]
    );
}

#[test]
fn core_shortcut_routes_snowball_start_to_core_plane() {
    let route = resolve_core_shortcuts(
        "snowball",
        &[
            "start".to_string(),
            "--cycle-id=s17".to_string(),
            "--drops=core-hardening,app-refine".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://snowball-plane");
    assert_eq!(
        route.args,
        vec![
            "start",
            "--cycle-id=s17",
            "--drops=core-hardening,app-refine"
        ]
    );
}

#[test]
fn core_shortcut_routes_snowball_regress_alias_to_melt_refine() {
    let route = resolve_core_shortcuts(
        "snowball",
        &[
            "regress".to_string(),
            "--cycle-id=s35".to_string(),
            "--regression-pass=0".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://snowball-plane");
    assert_eq!(
        route.args,
        vec!["melt-refine", "--cycle-id=s35", "--regression-pass=0"]
    );
}

#[test]
fn core_shortcut_routes_orchestrate_agency_to_company_plane() {
    let route = resolve_core_shortcuts(
        "orchestrate",
        &["agency".to_string(), "research".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://company-plane");
    assert_eq!(route.args, vec!["orchestrate-agency", "--team=research"]);
}

#[test]
fn core_shortcut_routes_browser_snapshot_to_vbrowser_plane() {
    let route = resolve_core_shortcuts(
        "browser",
        &[
            "snapshot".to_string(),
            "--session-id=snap-1".to_string(),
            "--refs=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://vbrowser-plane");
    assert_eq!(
        route.args,
        vec!["snapshot", "--session-id=snap-1", "--refs=1"]
    );
}

#[test]
fn core_shortcut_routes_hand_new_to_autonomy_controller() {
    let route = resolve_core_shortcuts(
        "hand",
        &[
            "new".to_string(),
            "--hand-id=alpha".to_string(),
            "--template=researcher".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://autonomy-controller");
    assert_eq!(
        route.args,
        vec!["hand-new", "--hand-id=alpha", "--template=researcher"]
    );
}

#[test]
fn core_shortcut_routes_hands_enable_scheduled_to_assimilation_controller() {
    let route = resolve_core_shortcuts(
        "hands",
        &[
            "enable".to_string(),
            "scheduled".to_string(),
            "--strict=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://assimilation-controller");
    assert_eq!(
        route.args,
        vec!["scheduled-hands", "--op=enable", "--strict=1"]
    );
}

#[test]
fn core_shortcut_routes_oracle_to_network_protocol() {
    let route = resolve_core_shortcuts(
        "oracle",
        &[
            "query".to_string(),
            "--provider=polymarket".to_string(),
            "--event=btc".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://network-protocol");
    assert_eq!(
        route.args,
        vec!["oracle-query", "--provider=polymarket", "--event=btc"]
    );
}

#[test]
fn core_shortcut_routes_truth_weight_to_network_protocol() {
    let route = resolve_core_shortcuts(
        "truth",
        &["weight".to_string(), "--market=pm:btc-100k".to_string()],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://network-protocol");
    assert_eq!(route.args, vec!["truth-weight", "--market=pm:btc-100k"]);
}

#[test]
fn core_shortcut_routes_agent_ephemeral_to_autonomy_controller() {
    let route = resolve_core_shortcuts(
        "agent",
        &[
            "run".to_string(),
            "--ephemeral".to_string(),
            "--goal=triage".to_string(),
            "--domain=research".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://autonomy-controller");
    assert_eq!(
        route.args,
        vec!["ephemeral-run", "--goal=triage", "--domain=research"]
    );
}

#[test]
fn core_shortcut_routes_agent_trunk_status_to_autonomy_controller() {
    let route = resolve_core_shortcuts(
        "agent",
        &[
            "status".to_string(),
            "--trunk".to_string(),
            "--strict=1".to_string(),
        ],
    )
    .expect("route");
    assert_eq!(route.script_rel, "core://autonomy-controller");
    assert_eq!(route.args, vec!["trunk-status", "--strict=1"]);
}

#[test]
fn local_fail_closed_signal_blocks_dispatch() {
    let _guard = env_guard();
    std::env::set_var("PROTHEUS_CTL_SECURITY_GATE_DISABLED", "0");
    std::env::set_var("PROTHEUS_CTL_SECURITY_COVENANT_VIOLATION", "1");
    let root = PathBuf::from(".");
    let verdict = evaluate_dispatch_security(
        &root,
        "client/runtime/systems/ops/protheus_control_plane.js",
        &[],
    );
    assert!(!verdict.ok);
    assert!(verdict.reason.contains("fail_closed"));
    std::env::remove_var("PROTHEUS_CTL_SECURITY_COVENANT_VIOLATION");
    std::env::remove_var("PROTHEUS_CTL_SECURITY_GATE_DISABLED");
}

#[test]
fn persona_blocked_path_fails_closed_before_security_core() {
    let _guard = env_guard();
    std::env::set_var("PROTHEUS_CTL_SECURITY_GATE_DISABLED", "0");
    std::env::set_var(
        "PROTHEUS_CTL_PERSONA_BLOCKED_PATHS",
        "client/runtime/systems/ops/protheus_control_plane.js",
    );
    let root = PathBuf::from(".");
    let verdict = evaluate_dispatch_security(
        &root,
        "client/runtime/systems/ops/protheus_control_plane.js",
        &[],
    );
    assert!(!verdict.ok);
    assert!(verdict
        .reason
        .contains(PERSONA_DISPATCH_SECURITY_GATE_CHECK_ID));
    assert!(verdict.reason.contains("blocked_dispatch_path"));
    std::env::remove_var("PROTHEUS_CTL_PERSONA_BLOCKED_PATHS");
    std::env::remove_var("PROTHEUS_CTL_SECURITY_GATE_DISABLED");
}

#[test]
fn requested_lens_arg_supports_inline_and_pair_forms() {
    let inline = requested_lens_arg(&["--lens=guardian".to_string()]);
    assert_eq!(inline.as_deref(), Some("guardian"));

    let paired = requested_lens_arg(&["--persona-lens".to_string(), "operator".to_string()]);
    assert_eq!(paired.as_deref(), Some("operator"));
}

#[test]
fn command_center_boundary_allows_core_session_route() {
    let route = Route {
        script_rel: "core://command-center-session".to_string(),
        args: vec!["resume".to_string(), "session-1".to_string()],
        forward_stdin: false,
    };
    assert!(enforce_command_center_boundary("session", &route).is_ok());
}

#[test]
fn command_center_boundary_rejects_client_red_legion_authority() {
    let route = Route {
        script_rel: "client/runtime/systems/red_legion/command_center.ts".to_string(),
        args: vec!["resume".to_string(), "session-1".to_string()],
        forward_stdin: false,
    };
    let err = enforce_command_center_boundary("session", &route).expect_err("must reject");
    assert!(err.contains("red_legion_client_authority_forbidden"));
}

#[test]
fn command_center_boundary_rejects_non_core_session_route() {
    let route = Route {
        script_rel: "client/runtime/systems/ops/protheusd.js".to_string(),
        args: vec!["status".to_string()],
        forward_stdin: false,
    };
    let err = enforce_command_center_boundary("session", &route).expect_err("must reject");
    assert!(err.contains("session_route_must_be_core_authoritative"));
}

#[test]
fn session_route_supports_extended_lifecycle_commands() {
    let route = Route {
        script_rel: "core://command-center-session".to_string(),
        args: vec!["kill".to_string(), "session-9".to_string()],
        forward_stdin: false,
    };
    assert!(enforce_command_center_boundary("session", &route).is_ok());
}

#[test]
fn node_missing_fallback_supports_help_surface() {
    let route = Route {
        script_rel: "client/runtime/systems/ops/protheus_command_list.js".to_string(),
        args: vec!["--mode=help".to_string()],
        forward_stdin: false,
    };
    assert_eq!(node_missing_fallback(Path::new("."), &route, true), Some(0));
}

#[test]
fn node_missing_fallback_supports_version_surface() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let base = std::env::temp_dir().join(format!("protheusctl_version_fallback_{nonce}"));
    fs::create_dir_all(&base).expect("mkdir");
    fs::write(base.join("package.json"), r#"{"version":"9.9.9-test"}"#).expect("package");
    assert_eq!(
        workspace_package_version(&base).as_deref(),
        Some("9.9.9-test")
    );
    let route = Route {
        script_rel: "client/runtime/systems/ops/protheus_version_cli.js".to_string(),
        args: vec!["version".to_string()],
        forward_stdin: false,
    };
    assert_eq!(node_missing_fallback(&base, &route, true), Some(0));
    let _ = fs::remove_dir_all(base);
}

#[test]
fn node_missing_fallback_is_none_for_non_fallback_routes() {
    let route = Route {
        script_rel: "client/runtime/systems/ops/protheus_diagram.js".to_string(),
        args: vec!["status".to_string()],
        forward_stdin: false,
    };
    assert_eq!(node_missing_fallback(Path::new("."), &route, false), None);
}

#[test]
fn run_node_script_falls_back_when_command_list_script_is_missing() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let base = std::env::temp_dir().join(format!("protheusctl_missing_script_fallback_{nonce}"));
    fs::create_dir_all(base.join("client/runtime/systems/ops")).expect("mkdir");

    let status = run_node_script(
        &base,
        "client/runtime/systems/ops/protheus_command_list.js",
        &["--mode=list".to_string()],
        false,
    );
    assert_eq!(status, 0, "expected fallback command list to succeed");

    let _ = fs::remove_dir_all(base);
}
