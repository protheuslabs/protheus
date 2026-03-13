pub(super) fn print_usage() {
    println!("Usage:");
    println!("  protheus-ops runtime-efficiency-floor run [--strict=1|0] [--policy=<path>]");
    println!("  protheus-ops runtime-efficiency-floor status [--policy=<path>]");
    println!("  protheus-ops benchmark-matrix <run|status> [--snapshot=<path>] [--refresh-runtime=1|0] [--bar-width=44]");
    println!("  protheus-ops f100-reliability-certification <run|status> [--strict=1|0] [--policy=<path>]");
    println!("  protheus-ops sdlc-change-control <run|status> [--strict=1|0] [--policy=<path>] [--pr-body-path=<path>] [--changed-paths-path=<path>]");
    println!("  protheus-ops supply-chain-provenance-v2 <run|status> [--strict=1|0] [--policy=<path>] [--bundle-path=<path>] [--vuln-summary-path=<path>]");
    println!("  protheus-ops f100-readiness-program <run|run-all|status> [--lane=<V6-F100-XXX>] [--strict=1|0] [--apply=1|0] [--policy=<path>]");
    println!("  protheus-ops identity-federation <authorize|scim-lifecycle|status> [flags]");
    println!("  protheus-ops audit-log-export <export|status> [flags]");
    println!("  protheus-ops model-router <args>");
    println!("  protheus-ops intelligence-nexus <status|open|add-key|credits-status|buy-credits|autobuy-evaluate> [flags]");
    println!("  protheus-ops network-protocol <status|ignite-bitcoin|stake|merkle-root|emission|zk-claim> [flags]");
    println!("  protheus-ops seed-protocol <status|deploy|migrate|enforce|select|archive|defend|monitor> [flags]");
    println!("  protheus-ops binary-blob-runtime <status|migrate|settle|mutate|substrate-probe|debug-access> [flags]");
    println!("  protheus-ops directive-kernel <status|prime-sign|derive|supersede|compliance-check|bridge-rsi|migrate> [flags]");
    println!("  protheus-ops rsi-ignition <status|ignite|reflect|swarm|evolve> [flags]");
    println!("  protheus-ops continuity-runtime <resurrection-protocol|session-continuity-vault> [flags]");
    println!("  protheus-ops memory-plane <causal-temporal-graph|memory-federation-plane> [flags]");
    println!("  protheus-ops runtime-systems <status|verify|run|build|manifest|bootstrap|package|settle> [flags]");
    println!("  protheus-ops child-organ-runtime <plan|spawn|status> [flags]");
    println!("  protheus-ops organism-layer <status|ignite|dream|homeostasis|crystallize|symbiosis|mutate|sensory|narrative> [flags]");
    println!("  protheus-ops graph-toolkit <status|pagerank|louvain|jaccard|label-propagation|betweenness|predict-links|centrality|communities> [flags]");
    println!("  protheus-ops asm-plane <status|wasm-dual-meter|hands-runtime|crdt-adapter|trust-chain|fastpath|industrial-pack> [flags]");
    println!("  protheus-ops research-plane <status|diagnostics|fetch|recover-selectors|crawl|mcp-extract|spider|middleware|pipeline|signals|console|template-governance|goal-crawl|map-site|extract-structured|monitor|firecrawl-template-governance|js-scrape|auth-session|proxy-rotate|parallel-scrape-workers|book-patterns-template-governance|decode-news-url|decode-news-urls|decoder-template-governance> [flags]");
    println!("  protheus-ops parse-plane <status|parse-doc|visualize|postprocess-table|flatten|template-governance> [flags]");
    println!("  protheus-ops flow-plane <status|compile|playground|component-marketplace|export|template-governance> [flags]");
    println!("  protheus-ops app-plane <status|run|history|replay|switch-provider|build|ingress|template-governance> [flags]");
    println!("  protheus-ops snowball-plane <status|start|melt-refine|compact|backlog-pack|control> [flags]");
    println!("  protheus-ops mcp-plane <status|capability-matrix|workflow|expose|pattern-pack|template-governance> [flags]");
    println!("  protheus-ops skills-plane <status|list|dashboard|create|activate|chain-validate|install|run|share|gallery|react-minimal|tot-deliberate> [flags]");
    println!("  protheus-ops vbrowser-plane <status|session-start|session-control|automate|privacy-guard> [flags]");
    println!("  protheus-ops agency-plane <status|create-shadow|topology|orchestrate|workflow-bind> [flags]");
    println!(
        "  protheus-ops collab-plane <status|dashboard|launch-role|schedule|continuity> [flags]"
    );
    println!("  protheus-ops company-plane <status|orchestrate-agency|budget-enforce|ticket|heartbeat> [flags]");
    println!("  protheus-ops substrate-plane <status|csi-capture|csi-module|csi-embedded-profile|csi-policy|eye-bind|bio-interface|bio-feedback|bio-adapter-template|bioethics-policy|bio-enable> [flags]");
    println!(
        "  protheus-ops observability-plane <status|monitor|workflow|incident|selfhost> [flags]"
    );
    println!("  protheus-ops persist-plane <status|schedule|mobile-cockpit|continuity|connector|cowork> [flags]");
    println!("  protheus-ops binary-vuln-plane <status|scan|mcp-analyze> [flags]");
    println!("  protheus-ops hermes-plane <status|discover|continuity|delegate|cockpit> [flags]");
    println!(
        "  protheus-ops eval-plane <status|enable-neuralavb|experiment-loop|benchmark|run> [flags]"
    );
    println!("  protheus-ops ab-lane-eval <status|run> [flags]");
    println!("  protheus-ops contract-check <args>");
    println!("  protheus-ops security-plane <guard|anti-sabotage-shield|constitution-guardian|remote-emergency-halt|soul-token-guard|integrity-reseal|integrity-reseal-assistant|capability-lease|startup-attestation|truth-seeking-gate|abac-policy-plane|status> [flags]");
    println!("  protheus-ops enterprise-hardening <run|status> [--strict=1|0] [--policy=<path>]");
    println!("  protheus-ops rollout-rings <status|evaluate> [flags]");
    println!("  protheus-ops strategy-mode-governor <args>");
    println!(
        "  protheus-ops strategy-resolver <status|invoke> [--payload=<json>|--payload-file=<path>]"
    );
    println!("  protheus-ops status [--dashboard]");
    println!("  protheus-ops daemon-control <start|stop|restart|status|attach|subscribe|tick|diagnostics> [flags]");
    println!("  protheus-ops command-center-session <register|resume|send|status|list> [flags]");
    println!("  protheus-ops organ-atrophy-controller <scan|status|revive> [flags]");
    println!("  protheus-ops narrow-agent-parity-harness <run|status> [flags]");
    println!("  protheus-ops offsite-backup <sync|restore-drill|status|diagnose|list> [flags]");
    println!("  protheus-ops settlement-program <list|run|run-all|settle|revert|edit-core|edit-module|status> [flags]");
    println!("  protheus-ops llm-economy-organ <run|enable|dashboard|status> [flags]");
    println!("  protheus-ops metakernel <status|registry|manifest|worlds|capability-taxonomy|budget-admission|epistemic-object|effect-journal|substrate-registry|radix-guard|quantum-broker|neural-consent|attestation-graph|degradation-contracts|execution-profiles|variant-profiles|mpu-compartments|invariants> [flags]");
    println!("  protheus-ops top1-assurance <status|proof-coverage|proof-vm|size-gate|benchmark-thresholds|comparison-matrix|run-all> [flags]");
    println!("  protheus-ops backlog-queue-executor <run|status> [flags]");
    println!("  protheus-ops backlog-runtime-anchor <build|verify> --lane-id=<V3-RACE-XXX>");
    println!("  protheus-ops legacy-retired-lane <build|verify> --lane-id=<SYSTEMS-OPS-...>");
    println!("  protheus-ops inversion-controller <command> [flags]");
    println!("  protheus-ops health-status <command> [flags]");
    println!("  protheus-ops foundation-contract-gate <run|status> [flags]");
    println!(
        "  protheus-ops origin-integrity <run|status|certificate|seed-bootstrap-verify> [flags]"
    );
    println!("  protheus-ops state-kernel <command> [flags]");
    println!("  protheus-ops shadow-budget-governance <evaluate|status> [flags]");
    println!("  protheus-ops adaptive-runtime <tick|status> [flags]");
    println!("  protheus-ops offline-runtime-guard <evaluate|status> [flags]");
    println!("  protheus-ops hardware-route-hardening <evaluate|status> [flags]");
    println!("  protheus-ops autonomy-controller <command> [flags]");
    println!("  protheus-ops autotest-controller <command> [flags]");
    println!("  protheus-ops autotest-doctor <command> [flags]");
    println!("  protheus-ops autonomy-proposal-enricher <command> [flags]");
    println!("  protheus-ops spine <mode> [date] [flags]");
    println!("  protheus-ops attention-queue <enqueue|status> [flags]");
    println!("  protheus-ops memory-ambient <run|status> [flags]");
    println!(
        "  protheus-ops duality-seed <status|invoke> [--payload=<json>|--payload-file=<path>]"
    );
    println!("  protheus-ops persona-ambient <apply|status> [flags]");
    println!("  protheus-ops dopamine-ambient <closeout|status|evaluate> [flags]");
    println!("  protheus-ops persona-schema-contract <validate|status> [--strict=1|0] [--schema-mode=<id>] [--payload=<json>|--input=<path>]");
    println!("  protheus-ops protheusctl <command> [flags]");
    println!("  protheus-ops rag <status|start|ingest|search|chat|merge-vault|memory> [flags]");
    println!("  protheus-ops personas-cli <command> [flags]");
    println!(
        "  protheus-ops autophagy-auto-approval <evaluate|monitor|commit|rollback|status> [flags]"
    );
    println!("  protheus-ops adaptive-contract-version-governance <run|status> [flags]");
    println!("  protheus-ops assimilation-controller <command> [flags]");
    println!("  protheus-ops collector-cache <load|save|status> [flags]");
    println!("  protheus-ops contribution-oracle <validate|status> [flags]");
    println!("  protheus-ops sensory-eyes-intake <command> [flags]");
    println!("  protheus-ops spawn-broker <status|request|release> [flags]");
    println!("  protheus-ops execution-yield-recovery <command> [flags]");
    println!("  protheus-ops protheus-control-plane <command> [flags]");
    println!("  protheus-ops rust50-migration-program <command> [flags]");
    println!("  protheus-ops venom-containment-layer <command> [flags]");
    println!("  protheus-ops dynamic-burn-budget-oracle <command> [flags]");
    println!("  protheus-ops backlog-registry <command> [flags]");
    println!("  protheus-ops rust-enterprise-productivity-program <command> [flags]");
    println!("  protheus-ops backlog-github-sync <command> [flags]");
    println!("  protheus-ops workflow-controller <command> [flags]");
    println!("  protheus-ops workflow-executor <command> [flags]");
    println!("  protheus-ops fluxlattice-program <list|run|run-all|status> [flags]");
    println!("  protheus-ops perception-polish-program <list|run|run-all|status> [flags]");
    println!("  protheus-ops scale-readiness-program <list|run|run-all|status> [flags]");
    println!("  protheus-ops opendev-dual-agent <run|status> [flags]");
    println!("  protheus-ops company-layer-orchestration <run|status> [flags]");
    println!("  protheus-ops wifi-csi-engine <run|status> [flags]");
    println!("  protheus-ops biological-computing-adapter <run|status> [flags]");
    println!("  protheus-ops observability-automation-engine <workflow|status> [flags]");
    println!("  protheus-ops observability-slo-runbook-closure <incident|status> [flags]");
    println!("  protheus-ops persistent-background-runtime <schedule|status> [flags]");
    println!("  protheus-ops workspace-gateway-runtime <run|status> [flags]");
    println!("  protheus-ops p2p-gossip-seed <run|status> [flags]");
    println!("  protheus-ops startup-agency-builder <run|status> [flags]");
    println!("  protheus-ops timeseries-receipt-engine <run|status> [flags]");
    println!("  protheus-ops webgpu-inference-adapter <run|status> [flags]");
    println!("  protheus-ops context-doctor <run|status> [flags]");
    println!("  protheus-ops discord-swarm-orchestration <run|status> [flags]");
    println!("  protheus-ops bookmark-knowledge-pipeline <run|status> [flags]");
    println!("  protheus-ops public-api-catalog <run|status> [flags]");
    println!("  protheus-ops decentralized-data-marketplace <run|status> [flags]");
    println!("  protheus-ops autoresearch-loop <run|status> [flags]");
    println!("  protheus-ops intel-sweep-router <run|status> [flags]");
    println!("  protheus-ops gui-drift-manager <run|status> [flags]");
    println!("  protheus-ops release-gate-canary-rollback-enforcer <gate|status> [flags]");
    println!("  protheus-ops srs-contract-runtime <run|run-many|status> [--id=<V6-...>|--ids=<csv>|--ids-file=<path>] [flags]");
}
