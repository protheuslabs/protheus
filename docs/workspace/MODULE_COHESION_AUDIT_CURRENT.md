# Module Cohesion Audit (Current)

Generated: 2026-03-13T23:58:11.103Z
Revision: `b7d07765fa56778f503b952ee8cdb13a7bb0440e`
Policy: `client/runtime/config/module_cohesion_policy.json`

## Summary
- pass: true
- scanned_files: 785
- violations: 0
- new_over_cap: 0
- legacy_growth_violations: 0
- legacy_debt_files: 96
- warning_attention_files(>800): 71
- exempt_over_cap_files: 0

## Warning Attention (>800 lines)
| File | Lines | Cap |
| --- | ---: | ---: |
| `core/layer2/execution/src/autoscale.rs` | 27826 | 600 |
| `core/layer2/execution/src/inversion.rs` | 12542 | 600 |
| `core/layer0/ops/src/model_router.rs` | 4689 | 600 |
| `core/layer1/security/src/security_wave1.rs` | 3983 | 600 |
| `core/layer2/execution/src/decompose.rs` | 3264 | 600 |
| `core/layer0/memory_runtime/src/main.rs` | 3149 | 600 |
| `core/layer0/ops/src/protheusctl.rs` | 3021 | 600 |
| `core/layer0/ops/src/autotest_controller.rs` | 2800 | 600 |
| `core/layer0/ops/src/metakernel.rs` | 2419 | 600 |
| `core/layer1/security/src/security_planes.rs` | 2304 | 600 |
| `core/layer0/ops/src/health_status.rs` | 2103 | 600 |
| `core/layer2/conduit/src/lib.rs` | 2048 | 600 |
| `core/layer0/memory_runtime/src/rag_runtime.rs` | 2027 | 600 |
| `core/layer0/ops/src/substrate_plane.rs` | 1985 | 600 |
| `core/layer0/ops/src/research_batch7.rs` | 1973 | 600 |
| `core/layer0/ops/src/skills_plane.rs` | 1949 | 600 |
| `core/layer1/security/src/lib.rs` | 1878 | 600 |
| `core/layer0/ops/src/spine.rs` | 1848 | 600 |
| `core/layer0/ops/src/app_plane.rs` | 1763 | 600 |
| `core/layer0/ops/src/protheusctl_routes.rs` | 1755 | 600 |
| `core/layer0/ops/src/autotest_doctor.rs` | 1745 | 600 |
| `core/layer0/ops/src/attention_queue.rs` | 1743 | 600 |
| `core/layer0/ops/src/duality_seed.rs` | 1732 | 600 |
| `core/layer0/ops/src/parse_plane.rs` | 1694 | 600 |
| `core/layer0/ops/src/assimilation_controller.rs` | 1663 | 600 |
| `core/layer0/ops/src/memory_ambient.rs` | 1621 | 600 |
| `core/layer0/ops/src/research_batch6.rs` | 1475 | 600 |
| `core/layer0/ops/src/flow_plane.rs` | 1402 | 600 |
| `core/layer0/ops/src/llm_economy_organ.rs` | 1377 | 600 |
| `core/layer0/ops/src/top1_assurance.rs` | 1357 | 600 |
| `core/layer0/ops/src/f100_readiness_program.rs` | 1346 | 600 |
| `core/layer0/ops/src/binary_vuln_plane.rs` | 1325 | 600 |
| `core/layer0/memory_runtime/src/wave1.rs` | 1303 | 600 |
| `core/layer0/ops/src/company_plane.rs` | 1301 | 600 |
| `core/layer0/ops/src/backlog_registry.rs` | 1261 | 600 |
| `core/layer0/ops/src/seed_protocol.rs` | 1261 | 600 |
| `core/layer0/ops/src/mcp_plane.rs` | 1248 | 600 |
| `core/layer0/ops/src/observability_plane.rs` | 1239 | 600 |
| `core/layer0/ops/src/research_batch8.rs` | 1233 | 600 |
| `core/layer0/ops/src/strategy_mode_governor.rs` | 1232 | 600 |
| `core/layer0/ops/src/strategy_resolver.rs` | 1223 | 600 |
| `core/layer0/ops/src/research_plane.rs` | 1204 | 600 |
| `core/layer0/ops/src/spawn_broker.rs` | 1159 | 600 |
| `core/layer0/ops/src/fluxlattice_program.rs` | 1157 | 600 |
| `core/layer0/ops/src/snowball_plane.rs` | 1144 | 600 |
| `core/layer0/ops/src/enterprise_hardening.rs` | 1112 | 600 |
| `core/layer0/ops/src/asm_plane.rs` | 1101 | 600 |
| `core/layer0/ops/src/lib.rs` | 1096 | 600 |
| `core/layer0/ops/src/directive_kernel.rs` | 1093 | 600 |
| `client/runtime/lib/secret_broker.ts` | 1040 | 400 |
| `client/lib/trit_shadow_control.ts` | 1039 | 400 |
| `core/layer0/ops/src/contract_check.rs` | 1014 | 600 |
| `core/layer2/autonomy/src/simulation.rs` | 1014 | 600 |
| `core/layer0/memory_abstraction/src/main.rs` | 1013 | 600 |
| `core/layer0/ops/src/hermes_plane.rs` | 1005 | 600 |
| `core/layer0/ops/src/scale_readiness.rs` | 999 | 600 |
| `scripts/memory/rebuild_exclusive.ts` | 998 | 600 |
| `core/layer0/ops/src/collab_plane.rs` | 955 | 600 |
| `core/layer0/ops/src/f100_reliability_certification.rs` | 947 | 600 |
| `core/layer2/ops/src/autophagy_auto_approval.rs` | 930 | 600 |
| `client/runtime/lib/spine_conduit_bridge.ts` | 913 | 400 |
| `core/layer2/ops/src/command_center_session.rs` | 890 | 600 |
| `core/layer0/ops/src/persona_ambient.rs` | 882 | 600 |
| `core/layer0/ops/src/supply_chain_provenance_v2.rs` | 871 | 600 |
| `core/layer1/memory_runtime/adaptive/strategy_store.ts` | 861 | 600 |
| `core/layer0/ops/src/agency_plane.rs` | 847 | 600 |
| `core/layer2/autonomy/src/multi_agent_debate.rs` | 846 | 600 |
| `core/layer0/memory_runtime/src/transition_lane.rs` | 833 | 600 |
| `core/layer0/ops/src/vbrowser_plane.rs` | 827 | 600 |
| `core/layer0/security/src/lib.rs` | 822 | 600 |
| `core/layer0/ops/src/main.rs` | 821 | 600 |

## Legacy Debt (Tracked, Not New)
| File | Current | Baseline | Allowed Max | Cap |
| --- | ---: | ---: | ---: | ---: |
| `core/layer2/execution/src/autoscale.rs` | 27826 | 27826 | 27851 | 600 |
| `core/layer2/execution/src/inversion.rs` | 12542 | 12542 | 12567 | 600 |
| `core/layer0/ops/src/model_router.rs` | 4689 | 4689 | 4714 | 600 |
| `core/layer1/security/src/security_wave1.rs` | 3983 | 3983 | 4008 | 600 |
| `core/layer2/execution/src/decompose.rs` | 3264 | 3264 | 3289 | 600 |
| `core/layer0/memory_runtime/src/main.rs` | 3149 | 3149 | 3174 | 600 |
| `core/layer0/ops/src/protheusctl.rs` | 3021 | 3021 | 3046 | 600 |
| `core/layer0/ops/src/autotest_controller.rs` | 2800 | 2800 | 2825 | 600 |
| `core/layer0/ops/src/metakernel.rs` | 2419 | 2419 | 2444 | 600 |
| `core/layer1/security/src/security_planes.rs` | 2304 | 2304 | 2329 | 600 |
| `core/layer0/ops/src/health_status.rs` | 2103 | 2103 | 2128 | 600 |
| `core/layer2/conduit/src/lib.rs` | 2048 | 2048 | 2073 | 600 |
| `core/layer0/memory_runtime/src/rag_runtime.rs` | 2027 | 2027 | 2052 | 600 |
| `core/layer0/ops/src/substrate_plane.rs` | 1985 | 1985 | 2010 | 600 |
| `core/layer0/ops/src/research_batch7.rs` | 1973 | 1973 | 1998 | 600 |
| `core/layer0/ops/src/skills_plane.rs` | 1949 | 1949 | 1974 | 600 |
| `core/layer1/security/src/lib.rs` | 1878 | 1878 | 1903 | 600 |
| `core/layer0/ops/src/spine.rs` | 1848 | 1848 | 1873 | 600 |
| `core/layer0/ops/src/app_plane.rs` | 1763 | 1763 | 1788 | 600 |
| `core/layer0/ops/src/protheusctl_routes.rs` | 1755 | 1755 | 1780 | 600 |
| `core/layer0/ops/src/autotest_doctor.rs` | 1745 | 1745 | 1770 | 600 |
| `core/layer0/ops/src/attention_queue.rs` | 1743 | 1743 | 1768 | 600 |
| `core/layer0/ops/src/duality_seed.rs` | 1732 | 1732 | 1757 | 600 |
| `core/layer0/ops/src/parse_plane.rs` | 1694 | 1694 | 1719 | 600 |
| `core/layer0/ops/src/assimilation_controller.rs` | 1663 | 1663 | 1688 | 600 |
| `core/layer0/ops/src/memory_ambient.rs` | 1621 | 1621 | 1646 | 600 |
| `core/layer0/ops/src/research_batch6.rs` | 1475 | 1475 | 1500 | 600 |
| `core/layer0/ops/src/flow_plane.rs` | 1402 | 1402 | 1427 | 600 |
| `core/layer0/ops/src/llm_economy_organ.rs` | 1377 | 1377 | 1402 | 600 |
| `core/layer0/ops/src/top1_assurance.rs` | 1357 | 1357 | 1382 | 600 |
| `core/layer0/ops/src/f100_readiness_program.rs` | 1346 | 1346 | 1371 | 600 |
| `core/layer0/ops/src/binary_vuln_plane.rs` | 1325 | 1325 | 1350 | 600 |
| `core/layer0/memory_runtime/src/wave1.rs` | 1303 | 1303 | 1328 | 600 |
| `core/layer0/ops/src/company_plane.rs` | 1301 | 1301 | 1326 | 600 |
| `core/layer0/ops/src/backlog_registry.rs` | 1261 | 1261 | 1286 | 600 |
| `core/layer0/ops/src/seed_protocol.rs` | 1261 | 1261 | 1286 | 600 |
| `core/layer0/ops/src/mcp_plane.rs` | 1248 | 1248 | 1273 | 600 |
| `core/layer0/ops/src/observability_plane.rs` | 1239 | 1239 | 1264 | 600 |
| `core/layer0/ops/src/research_batch8.rs` | 1233 | 1233 | 1258 | 600 |
| `core/layer0/ops/src/strategy_mode_governor.rs` | 1232 | 1232 | 1257 | 600 |
| `core/layer0/ops/src/strategy_resolver.rs` | 1223 | 1223 | 1248 | 600 |
| `core/layer0/ops/src/research_plane.rs` | 1204 | 1204 | 1229 | 600 |
| `core/layer0/ops/src/spawn_broker.rs` | 1159 | 1159 | 1184 | 600 |
| `core/layer0/ops/src/fluxlattice_program.rs` | 1157 | 1157 | 1182 | 600 |
| `core/layer0/ops/src/snowball_plane.rs` | 1144 | 1144 | 1169 | 600 |
| `core/layer0/ops/src/enterprise_hardening.rs` | 1112 | 1112 | 1137 | 600 |
| `core/layer0/ops/src/asm_plane.rs` | 1101 | 1101 | 1126 | 600 |
| `core/layer0/ops/src/lib.rs` | 1096 | 1096 | 1121 | 600 |
| `core/layer0/ops/src/directive_kernel.rs` | 1093 | 1093 | 1118 | 600 |
| `client/runtime/lib/secret_broker.ts` | 1040 | 1040 | 1065 | 400 |
| `client/lib/trit_shadow_control.ts` | 1039 | 1039 | 1064 | 400 |
| `core/layer0/ops/src/contract_check.rs` | 1014 | 1014 | 1039 | 600 |
| `core/layer2/autonomy/src/simulation.rs` | 1014 | 1014 | 1039 | 600 |
| `core/layer0/memory_abstraction/src/main.rs` | 1013 | 1013 | 1038 | 600 |
| `core/layer0/ops/src/hermes_plane.rs` | 1005 | 1005 | 1030 | 600 |
| `core/layer0/ops/src/scale_readiness.rs` | 999 | 999 | 1024 | 600 |
| `scripts/memory/rebuild_exclusive.ts` | 998 | 998 | 1023 | 600 |
| `core/layer0/ops/src/collab_plane.rs` | 955 | 955 | 980 | 600 |
| `core/layer0/ops/src/f100_reliability_certification.rs` | 947 | 947 | 972 | 600 |
| `core/layer2/ops/src/autophagy_auto_approval.rs` | 930 | 930 | 955 | 600 |
| `client/runtime/lib/spine_conduit_bridge.ts` | 913 | 913 | 938 | 400 |
| `core/layer2/ops/src/command_center_session.rs` | 890 | 890 | 915 | 600 |
| `core/layer0/ops/src/persona_ambient.rs` | 882 | 882 | 907 | 600 |
| `core/layer0/ops/src/supply_chain_provenance_v2.rs` | 871 | 871 | 896 | 600 |
| `core/layer1/memory_runtime/adaptive/strategy_store.ts` | 861 | 861 | 886 | 600 |
| `core/layer0/ops/src/agency_plane.rs` | 847 | 847 | 872 | 600 |
| `core/layer2/autonomy/src/multi_agent_debate.rs` | 846 | 846 | 871 | 600 |
| `core/layer0/memory_runtime/src/transition_lane.rs` | 833 | 833 | 858 | 600 |
| `core/layer0/ops/src/vbrowser_plane.rs` | 827 | 827 | 852 | 600 |
| `core/layer0/security/src/lib.rs` | 822 | 822 | 847 | 600 |
| `core/layer0/ops/src/main.rs` | 821 | 821 | 846 | 600 |
| `core/layer0/ops/src/dopamine_ambient.rs` | 787 | 787 | 812 | 600 |
| `core/layer0/singularity_seed/src/lib.rs` | 761 | 761 | 786 | 600 |
| `core/layer0/ops/src/perception_polish.rs` | 758 | 758 | 783 | 600 |
| `core/layer0/memory/src/blob.rs` | 750 | 750 | 775 | 600 |
| `core/layer0/ops/src/eval_plane.rs` | 746 | 746 | 771 | 600 |
| `core/layer0/ops/src/sdlc_change_control.rs` | 744 | 744 | 769 | 600 |
| `core/layer0/ops/src/origin_integrity.rs` | 738 | 738 | 763 | 600 |
| `core/layer2/ops/src/p2p_gossip_seed.rs` | 738 | 738 | 763 | 600 |
| `core/layer0/ops/src/persist_plane.rs` | 725 | 725 | 750 | 600 |
| `client/runtime/lib/directive_resolver.ts` | 715 | 715 | 740 | 400 |
| `core/layer2/autonomy/src/ethical_reasoning.rs` | 687 | 687 | 712 | 600 |
| `core/layer0/ops/src/directive_kernel_run.rs` | 686 | 686 | 711 | 600 |
| `core/layer0/memory_runtime/src/db.rs` | 682 | 682 | 707 | 600 |
| `core/layer0/ops/src/rsi_ignition.rs` | 674 | 674 | 699 | 600 |
| `core/layer0/ops/src/binary_blob_runtime_run.rs` | 668 | 668 | 693 | 600 |
| `core/layer0/ops/src/rag_cli.rs` | 663 | 663 | 688 | 600 |
| `client/lib/symbiosis_coherence_signal.ts` | 652 | 652 | 677 | 400 |
| `core/layer0/ops/src/binary_blob_runtime.rs` | 640 | 640 | 665 | 600 |
| `core/layer0/memory/src/main.rs` | 625 | 625 | 650 | 600 |
| `core/layer0/ops/src/benchmark_matrix.rs` | 622 | 622 | 647 | 600 |
| `core/layer1/observability/src/lib.rs` | 620 | 620 | 645 | 600 |
| `client/runtime/lib/success_criteria_verifier.ts` | 598 | 598 | 623 | 400 |
| `client/runtime/lib/mech_suit_mode.ts` | 450 | 450 | 475 | 400 |
| `client/runtime/lib/ternary_belief_engine.ts` | 450 | 450 | 475 | 400 |
| `client/runtime/lib/rust_lane_bridge.ts` | 402 | 402 | 427 | 400 |

