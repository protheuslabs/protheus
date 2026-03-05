use protheus_ops_core::{
    parse_args, parse_os_args, run_runtime_efficiency_floor, status_runtime_efficiency_floor,
};
use serde_json::json;
use std::env;
use std::path::PathBuf;

fn usage() {
    println!("Usage:");
    println!("  protheus-ops runtime-efficiency-floor run [--strict=1|0] [--policy=<path>]");
    println!("  protheus-ops runtime-efficiency-floor status [--policy=<path>]");
    println!("  protheus-ops model-router <args>");
    println!("  protheus-ops contract-check <args>");
    println!("  protheus-ops strategy-mode-governor <args>");
    println!("  protheus-ops foundation-contract-gate <run|status> [flags]");
    println!("  protheus-ops state-kernel <command> [flags]");
    println!("  protheus-ops autotest-controller <command> [flags]");
    println!("  protheus-ops autotest-doctor <command> [flags]");
    println!("  protheus-ops autonomy-proposal-enricher <command> [flags]");
    println!("  protheus-ops spine <mode> [date] [flags]");
    println!("  protheus-ops protheusctl <command> [flags]");
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

fn main() {
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let args = parse_os_args(env::args_os().skip(1));
    if args.is_empty() {
        usage();
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
                        print_json(&json!({
                            "ok": false,
                            "type": "runtime_efficiency_floor",
                            "error": err
                        }));
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
                    std::process::exit(1);
                }
            }
        }
        "model-router" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::model_router::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "contract-check" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::contract_check::run(&cwd, &rest);
            std::process::exit(exit);
        }
        "strategy-mode-governor" => {
            let rest = args.iter().skip(1).cloned().collect::<Vec<_>>();
            let exit = protheus_ops_core::strategy_mode_governor::run(&cwd, &rest);
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
            print_json(&json!({
                "ok": false,
                "error": "unknown_domain",
                "domain": domain
            }));
            std::process::exit(1);
        }
    }
}
