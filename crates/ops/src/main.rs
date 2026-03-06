use protheus_ops_core::{
    deterministic_receipt_hash, parse_args, parse_os_args, run_runtime_efficiency_floor,
    status_runtime_efficiency_floor,
};
use serde_json::{json, Value};
use std::env;
use std::path::PathBuf;

fn usage() {
    println!("Usage:");
    println!("  protheus-ops runtime-efficiency-floor run [--strict=1|0] [--policy=<path>]");
    println!("  protheus-ops runtime-efficiency-floor status [--policy=<path>]");
    println!("  protheus-ops benchmark-matrix <run|status> [--snapshot=<path>] [--refresh-runtime=1|0] [--bar-width=44]");
    println!("  protheus-ops model-router <args>");
    println!("  protheus-ops ab-lane-eval <status|run> [flags]");
    println!("  protheus-ops contract-check <args>");
    println!("  protheus-ops enterprise-hardening <run|status> [--strict=1|0] [--policy=<path>]");
    println!("  protheus-ops rollout-rings <status|evaluate> [flags]");
    println!("  protheus-ops strategy-mode-governor <args>");
    println!("  protheus-ops status [--dashboard]");
    println!("  protheus-ops backlog-runtime-anchor <build|verify> --lane-id=<V3-RACE-XXX>");
    println!("  protheus-ops legacy-retired-lane <build|verify> --lane-id=<SYSTEMS-OPS-...>");
    println!("  protheus-ops inversion-controller <command> [flags]");
    println!("  protheus-ops health-status <command> [flags]");
    println!("  protheus-ops foundation-contract-gate <run|status> [flags]");
    println!("  protheus-ops state-kernel <command> [flags]");
    println!("  protheus-ops autonomy-controller <command> [flags]");
    println!("  protheus-ops autotest-controller <command> [flags]");
    println!("  protheus-ops autotest-doctor <command> [flags]");
    println!("  protheus-ops autonomy-proposal-enricher <command> [flags]");
    println!("  protheus-ops spine <mode> [date] [flags]");
    println!("  protheus-ops protheusctl <command> [flags]");
    println!("  protheus-ops personas-cli <command> [flags]");
    println!("  protheus-ops workflow-executor <command> [flags]");
    println!("  protheus-ops fluxlattice-program <list|run|run-all|status> [flags]");
    println!("  protheus-ops perception-polish-program <list|run|run-all|status> [flags]");
    println!("  protheus-ops scale-readiness-program <list|run|run-all|status> [flags]");
}

fn print_json(value: &serde_json::Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn cli_error_receipt(
    error: &str,
    exit_code: i32,
    domain: Option<&str>,
    command: Option<&str>,
) -> Value {
    let ts = protheus_ops_core::now_iso();
    let mut out = json!({
        "ok": false,
        "type": "protheus_ops_cli_error",
        "ts": ts,
        "date": ts[..10].to_string(),
        "error": error,
        "exit_code": exit_code,
        "domain": domain,
        "command": command,
        "claim_evidence": [
            {
                "id": "fail_closed_cli",
                "claim": "top_level_cli_errors_emit_deterministic_receipts",
                "evidence": {
                    "error": error,
                    "domain_present": domain.is_some(),
                    "command_present": command.is_some()
                }
            }
        ],
        "persona_lenses": {
            "operator": {
                "entrypoint": "main",
                "domain": domain
            },
            "auditor": {
                "deterministic_receipt": true
            }
        }
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn main() {
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let args = parse_os_args(env::args_os().skip(1));
    if args.is_empty() {
        usage();
        print_json(&cli_error_receipt("missing_domain", 1, None, None));
        std::process::exit(1);
    }

    let domain = args.first().map(String::as_str).unwrap_or("");
    match domain {
        "runtime-efficiency-floor" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let parsed = parse_args(&rest);
            let cmd = parsed
                .positional
                .first()
                .map(|v| v.to_ascii_lowercase())
                .unwrap_or_else(|| "run".to_string());

            match cmd.as_str() {
                "run" => match run_runtime_efficiency_floor(&cwd, &parsed) {
                    Ok(out) => {
                        print_json(&out.json);
                        std::process::exit(out.exit_code);
                    }
                    Err(err) => {
                        print_json(&cli_error_receipt(
                            &format!("runtime_efficiency_floor_run_failed:{err}"),
                            1,
                            Some(domain),
                            Some("run"),
                        ));
                        std::process::exit(1);
                    }
                },
                "status" => {
                    let out = status_runtime_efficiency_floor(&cwd, &parsed);
                    print_json(&out.json);
                    std::process::exit(out.exit_code);
                }
                _ => {
                    usage();
                    print_json(&cli_error_receipt(
                        "runtime_efficiency_floor_unknown_command",
                        1,
                        Some(domain),
                        Some(cmd.as_str()),
                    ));
                    std::process::exit(1);
                }
            }
        }
        "model-router" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::model_router::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "ab-lane-eval" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::ab_lane_eval::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "benchmark-matrix" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::benchmark_matrix::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "contract-check" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::contract_check::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "enterprise-hardening" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::enterprise_hardening::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "rollout-rings" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::rollout_rings::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "strategy-mode-governor" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::strategy_mode_governor::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "status" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::health_status::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "backlog-runtime-anchor" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::backlog_runtime_anchor::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "legacy-retired-lane" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::legacy_retired_lane::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "inversion-controller" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::inversion_controller::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "health-status" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::health_status::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "foundation-contract-gate" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::foundation_contract_gate::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "state-kernel" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::state_kernel::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "autonomy-controller" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::autonomy_controller::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "autotest-controller" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::autotest_controller::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "autotest-doctor" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::autotest_doctor::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "autonomy-proposal-enricher" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::proposal_enricher::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "spine" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::spine::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "protheusctl" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::protheusctl::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "personas-cli" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::personas_cli::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "workflow-executor" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::workflow_executor::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "fluxlattice-program" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::fluxlattice_program::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "perception-polish-program" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::perception_polish::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "scale-readiness-program" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::scale_readiness::run(&cwd, &rest);
            std::process::exit(exit);
        }
        _ => {
            print_json(&cli_error_receipt("unknown_domain", 1, Some(domain), None));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_error_receipt_is_deterministic() {
        let out = cli_error_receipt("unknown_domain", 1, Some("nope"), None);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            out.get("type").and_then(Value::as_str),
            Some("protheus_ops_cli_error")
        );
        assert!(out.get("claim_evidence").is_some());
        assert!(out.get("persona_lenses").is_some());
        let ts = out
            .get("ts")
            .and_then(Value::as_str)
            .expect("ts");
        let date = out
            .get("date")
            .and_then(Value::as_str)
            .expect("date");
        assert!(ts.starts_with(date));

        let expected_hash = out
            .get("receipt_hash")
            .and_then(Value::as_str)
            .expect("hash")
            .to_string();
        let mut unhashed = out.clone();
        unhashed
            .as_object_mut()
            .expect("object")
            .remove("receipt_hash");
        assert_eq!(deterministic_receipt_hash(&unhashed), expected_hash);
    }
}
