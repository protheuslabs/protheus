pub(super) fn print_usage() {
    println!("Usage:");
    println!("  protheus-ops runtime-efficiency-floor run [--strict=1|0] [--policy=<path>]");
    println!("  protheus-ops runtime-efficiency-floor status [--policy=<path>]");
    println!("  protheus-ops benchmark-autonomy-gate <run|status> [--strict=1|0]");
    println!("  protheus-ops approval-gate-kernel <status|queue|approve|deny|was-approved|parse-command|parse-yaml|replace> [flags]");
    println!("  protheus-ops passport-iteration-chain-kernel <record|status> [--payload-base64=<base64_json>]");
    println!("  protheus-ops egress-gateway-kernel <load-policy|load-state|authorize> [--payload-base64=<base64_json>]");
    println!("  protheus-ops adaptive-layer-store-kernel <paths|is-within-root|resolve-path|read-json|ensure-json|set-json|delete-path> [--payload-base64=<base64_json>]");
    println!("  protheus-ops catalog-store-kernel <paths|default-state|normalize-state|read-state|ensure-state|set-state> [--payload-base64=<base64_json>]");
    println!("  protheus-ops focus-trigger-store-kernel <paths|default-state|normalize-state|read-state|ensure-state|set-state> [--payload-base64=<base64_json>]");
    println!("  protheus-ops security-integrity-kernel <load-policy|collect-present-files|verify|seal|append-event> [--payload-base64=<base64_json>]");
    println!("  protheus-ops queue-sqlite-kernel <open|ensure-schema|migrate-history|upsert-item|append-event|insert-receipt|queue-stats> [--payload-base64=<base64_json>]");
    println!("  protheus-ops benchmark-matrix <run|status> [--snapshot=<path>] [--refresh-runtime=1|0] [--bar-width=44]");
    println!("  protheus-ops f100-reliability-certification <run|status> [--strict=1|0] [--policy=<path>]");
    println!("  protheus-ops sdlc-change-control <run|status> [--strict=1|0] [--policy=<path>] [--pr-body-path=<path>] [--changed-paths-path=<path>]");
    println!("  protheus-ops system-health-audit-runner-kernel <run|status> [--strict=1|0] [--policy=<path>]");
    println!("  protheus-ops supply-chain-provenance-v2 <run|status> [--strict=1|0] [--policy=<path>] [--bundle-path=<path>] [--vuln-summary-path=<path>]");
    println!("  protheus-ops f100-readiness-program <run|run-all|status> [--lane=<V6-F100-XXX>] [--strict=1|0] [--apply=1|0] [--policy=<path>]");
    println!("  protheus-ops identity-federation <authorize|scim-lifecycle|status> [flags]");
    println!("  protheus-ops audit-log-export <export|status> [flags]");
    println!("  protheus-ops model-router <args>");
    println!("  protheus-ops intelligence-nexus <status|open|add-key|credits-status|buy-credits|autobuy-evaluate> [flags]");
    println!("  protheus-ops network-protocol <status|ignite-bitcoin|stake|merkle-root|emission|zk-claim> [flags]");
    println!("  protheus-ops seed-protocol <status|deploy|migrate|enforce|select|archive|defend|monitor> [flags]");
    println!("  protheus-ops binary-blob-runtime <status|migrate|settle|mutate|substrate-probe|debug-access> [flags]");
    println!("  protheus-ops directive-kernel <status|dashboard|prime-sign|derive|supersede|compliance-check|bridge-rsi|migrate> [flags]");
    println!("  protheus-ops action-envelope-kernel <create|classify|auto-classify|requires-approval|detect-irreversible|generate-id> [--payload-base64=<base64_json>]");
    println!("  protheus-ops action-receipts-kernel <now-iso|append-jsonl|with-receipt-contract|write-contract-receipt> [--payload-base64=<base64_json>]");
    println!("  protheus-ops conversation-eye-synthesizer-kernel <synthesize-envelope> [--payload-base64=<base64_json>]");
    println!("  protheus-ops trainability-matrix-kernel <default-policy|normalize-policy|load-policy|evaluate> [--payload-base64=<base64_json>]");
    println!("  protheus-ops dynamic-burn-budget-signal-kernel <normalize-pressure|pressure-rank|cost-pressure|load-signal> [--payload-base64=<base64_json>]");
    println!("  protheus-ops policy-runtime-kernel <deep-merge|resolve-policy-path|load-policy-runtime|resolve-policy-value-path> [--payload-base64=<base64_json>]");
    println!("  protheus-ops camel-bridge <status|register-society|run-society|simulate-world|import-dataset|route-conversation|record-crab-benchmark|register-tool-gateway|invoke-tool-gateway|record-scaling-observation|assimilate-intake> [--payload-base64=<base64_json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops semantic-kernel-bridge <status|register-service|register-plugin|invoke-plugin|collaborate|plan|register-vector-connector|retrieve|register-llm-connector|route-llm|validate-structured-output|emit-enterprise-event|register-dotnet-bridge|invoke-dotnet-bridge> [--payload-base64=<base64_json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops google-adk-bridge <status|register-a2a-agent|send-a2a-message|run-llm-agent|register-tool-manifest|invoke-tool-manifest|coordinate-hierarchy|approval-checkpoint|rewind-session|record-evaluation|sandbox-execute|deploy-shell|register-runtime-bridge|route-model> [--payload-base64=<base64_json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops haystack-bridge <status|register-pipeline|run-pipeline|run-agent-toolset|register-template|render-template|register-document-store|retrieve-documents|route-and-rank|record-multimodal-eval|trace-run|import-connector|assimilate-intake> [--payload-base64=<base64_json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops langchain-bridge <status|register-chain|execute-chain|run-deep-agent|register-memory-bridge|recall-memory|import-integration|route-prompt|record-trace|checkpoint-run|assimilate-intake> [--payload-base64=<base64_json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops pydantic-ai-bridge <status|register-agent|validate-output|register-tool-context|invoke-tool-context|bridge-protocol|durable-run|approval-checkpoint|record-logfire|execute-graph|stream-model|record-eval|assimilate-intake|register-runtime-bridge|route-model> [--payload-base64=<base64_json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops mastra-bridge <status|register-graph|execute-graph|run-agent-loop|memory-recall|suspend-run|resume-run|register-mcp-bridge|invoke-mcp-bridge|record-eval-trace|deploy-shell|register-runtime-bridge|route-model|scaffold-intake> [--payload-base64=<base64_json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops llamaindex-bridge <status|register-index|query|run-agent-workflow|ingest-multimodal|record-memory-eval|run-conditional-workflow|emit-trace|register-connector|connector-query> [--payload-base64=<base64_json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops integrity-hash-utility-kernel <stable-stringify|sha256-hex|hash-file-sha256> [--payload-base64=<base64_json>]");
    println!("  protheus-ops redaction-classification-kernel <load-policy|classify-text|redact-text|classify-and-redact> [--payload-base64=<base64_json>]");
    println!("  protheus-ops runtime-path-registry-kernel <constants|normalize-for-root|resolve-canonical|resolve-client-state|resolve-core-state> [--payload-base64=<base64_json>]");
    println!("  protheus-ops proposal-type-classifier-kernel <normalize-type-key|extract-source-eye-id|classify> [--payload-base64=<base64_json>]");
    println!("  protheus-ops state-artifact-contract-kernel <now-iso|decorate-artifact-row|trim-jsonl-rows|write-artifact-set|append-artifact-history> [--payload-base64=<base64_json>]");
    println!("  protheus-ops success-criteria-kernel <status|parse-rows|evaluate> [flags]");
    println!("  protheus-ops success-criteria-compiler-kernel <compile-rows|compile-proposal|to-action-spec-rows> [--payload-base64=<base64_json>]");
    println!("  protheus-ops outcome-fitness-kernel <load-policy|normalize-threshold-overrides|normalize-ranking-weights|normalize-proposal-type-threshold-offsets|normalize-promotion-policy-overrides|normalize-value-currency-policy-overrides|normalize-proposal-type-key|normalize-value-currency-token|proposal-type-threshold-offsets-for> [--payload-base64=<base64_json>]");
    println!("  protheus-ops training-conduit-schema-kernel <default-policy|normalize-policy|load-policy|build-metadata|validate-metadata> [--payload-base64=<base64_json>]");
    println!("  protheus-ops tool-response-compactor-kernel <compact|redact|extract-summary> [--payload-base64=<base64_json>]");
    println!("  protheus-ops trit-kernel <normalize|label|from-label|invert|majority|consensus|propagate|serialize|parse-serialized|serialize-vector|parse-vector> [--payload-base64=<base64_json>]");
    println!("  protheus-ops request-envelope-kernel <envelope-payload|canonical-string|sign|verify|stamp-env|verify-from-env|normalize-files|normalize-key-id|secret-key-env-var-name> [--payload-base64=<base64_json>]");
    println!("  protheus-ops autonomy-receipt-schema-kernel <to-success-criteria-record|with-success-criteria-verification|normalize-receipt|success-criteria-from-receipt> [--payload-base64=<base64_json>]");
    println!("  protheus-ops uid-kernel <normalize-prefix|is-alnum|stable-uid|random-uid> [--payload-base64=<base64_json>]");
    println!("  protheus-ops quorum-validator-kernel <evaluate> [--payload-base64=<base64_json>]");
    println!("  protheus-ops mutation-provenance-kernel <load-policy|normalize-meta|enforce|record-audit> [--payload-base64=<base64_json>]");
    println!("  protheus-ops ops-domain-conduit-runner-kernel <parse-argv|build-pass-args|build-run-options|prepare-run> [--payload-base64=<base64_json>]");
    println!("  protheus-ops local-runtime-partitioner <status|init|reset> [--workspace-root=<path>] [--confirm=RESET_LOCAL]");
    println!("  protheus-ops strategy-store-kernel <paths|default-state|default-draft|normalize-mode|normalize-execution-mode|normalize-profile|validate-profile|normalize-queue-item|recommend-mode|read-state|ensure-state|set-state|upsert-profile|intake-signal|materialize-from-queue|touch-profile-usage|evaluate-gc-candidates|gc-profiles> [--payload-base64=<base64_json>]");
    println!("  protheus-ops habit-store-kernel <default-state|normalize-state|read-state|ensure-state|set-state> [--payload-base64=<base64_json>]");
    println!("  protheus-ops reflex-store-kernel <default-state|normalize-state|read-state|ensure-state|set-state> [--payload-base64=<base64_json>]");
    println!("  protheus-ops strategy-campaign-scheduler-kernel <normalize-campaigns|annotate-priority|build-decomposition-plans> [--payload-base64=<base64_json>]");
    println!("  protheus-ops queued-backlog-kernel <ensure-dir|read-json|write-json-atomic|append-jsonl|read-jsonl|resolve-path|stable-hash|load-policy> [--payload-base64=<base64_json>]");
    println!("  protheus-ops upgrade-lane-kernel <status|record> [--payload-base64=<base64_json>]");
    println!("  protheus-ops mech-suit-mode-kernel <load-policy|approx-token-count|classify-severity|should-emit-console|update-status|append-attention-event> [--payload-base64=<base64_json>]");
    println!("  protheus-ops rsi-ignition <status|ignite|reflect|swarm|evolve> [flags]");
    println!("  protheus-ops continuity-runtime <resurrection-protocol|session-continuity-vault> [flags]");
    println!("  protheus-ops memory-plane <causal-temporal-graph|memory-federation-plane> [flags]");
    println!("  protheus-ops memory-policy-kernel <status|parse-cli|command-name|validate|validate-ranking|validate-lensmap|severity-rank|guard-failure> [--payload-base64=<base64_json>]");
    println!("  protheus-ops memory-session-isolation-kernel <load-state|save-state|validate|failure-result> [--payload-base64=<base64_json>]");
    println!(
        "  protheus-ops readiness-bridge-pack-kernel <run|status> [--strict=1|0] [--policy=<path>]"
    );
    println!("  protheus-ops runtime-systems <status|verify|run|build|manifest|bootstrap|package|settle> [flags]");
    println!("  protheus-ops child-organ-runtime <plan|spawn|status> [flags]");
    println!("  protheus-ops organism-layer <status|ignite|dream|homeostasis|crystallize|symbiosis|mutate|sensory|narrative> [flags]");
    println!("  protheus-ops graph-toolkit <status|pagerank|louvain|jaccard|label-propagation|betweenness|predict-links|centrality|communities> [flags]");
    println!("  protheus-ops asm-plane <status|wasm-dual-meter|hands-runtime|crdt-adapter|trust-chain|fastpath|industrial-pack> [flags]");
    println!("  protheus-ops research-plane <status|diagnostics|fetch|recover-selectors|crawl|mcp-extract|spider|middleware|pipeline|signals|console|template-governance|goal-crawl|map-site|extract-structured|monitor|firecrawl-template-governance|js-scrape|auth-session|proxy-rotate|parallel-scrape-workers|book-patterns-template-governance|decode-news-url|decode-news-urls|decoder-template-governance> [flags]");
    println!("  protheus-ops parse-plane <status|parse-doc|visualize|postprocess-table|flatten|export|template-governance> [flags]");
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
    println!("  protheus-ops business-plane <taxonomy|persona|continuity|alerts|switchboard|external-sync|continuity-audit|archive|status> [flags]");
    println!("  protheus-ops canyon-plane <efficiency|hands-army|evolution|sandbox|ecosystem|workflow|scheduler|control-plane|adoption|benchmark-gate|status> [flags]");
    println!("  protheus-ops government-plane <attestation|classification|nonrepudiation|diode|soc|coop|proofs|interoperability|ato-pack|status> [flags]");
    println!("  protheus-ops finance-plane <transaction|model-governance|aml|kyc|finance-eye|risk-warehouse|custody|zero-trust|availability|regulatory-report|status> [flags]");
    println!("  protheus-ops healthcare-plane <patient|phi-audit|cds|devices|documentation|alerts|coordination|trials|imaging|emergency|status> [flags]");
    println!("  protheus-ops vertical-plane <activate|compile-profile|status> [flags]");
    println!("  protheus-ops nexus-plane <package-domain|bridge|insurance|human-boundary|receipt-v2|merkle-forest|compliance-ledger|status> [flags]");
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
    println!("  protheus-ops enterprise-hardening <run|status|export-compliance|identity-surface|certify-scale|dashboard> [flags]");
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
    println!("  protheus-ops backlog-delivery-plane <run|status> [--id=<Vx-...>] [flags]");
    println!("  protheus-ops backlog-runtime-anchor <build|verify> --lane-id=<V3-RACE-XXX>");
    println!("  protheus-ops legacy-retired-lane <build|verify> --lane-id=<SYSTEMS-OPS-...>");
    println!("  protheus-ops inversion-controller <command> [flags]");
    println!("  protheus-ops health-status <command> [flags]");
    println!("  protheus-ops alpha-readiness <run|status> [--strict=1|0] [--run-gates=1|0]");
    println!("  protheus-ops foundation-contract-gate <run|status> [flags]");
    println!(
        "  protheus-ops origin-integrity <run|status|certificate|seed-bootstrap-verify> [flags]"
    );
    println!("  protheus-ops state-kernel <command> [flags]");
    println!("  protheus-ops shadow-budget-governance <evaluate|status> [flags]");
    println!("  protheus-ops adaptive-runtime <tick|status> [flags]");
    println!("  protheus-ops adaptive-intelligence <status|propose|shadow-train|prioritize|graduate> [flags]");
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
    println!(
        "  protheus-ops swarm-runtime <status|spawn|byzantine-test|consensus-check|test> [flags]"
    );
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
