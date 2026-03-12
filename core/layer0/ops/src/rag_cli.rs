// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)
use crate::{deterministic_receipt_hash, memory_ambient, now_iso};
use serde_json::{json, Value};
use std::path::Path;

#[derive(Debug, Clone)]
enum Invocation {
    AmbientStatus,
    MemoryRun {
        memory_command: String,
        memory_args: Vec<String>,
    },
}

fn usage() {
    eprintln!("Usage:");
    eprintln!("  protheus-ops rag status");
    eprintln!("  protheus-ops rag start");
    eprintln!("  protheus-ops rag ingest [--path=<path>] [--chunk-size=<n>] [--chunk-overlap=<n>]");
    eprintln!("  protheus-ops rag search --q=<query> [--top=<n>]");
    eprintln!("  protheus-ops rag chat --q=<query> [--top=<n>]");
    eprintln!("  protheus-ops rag chat nano [--q=<query>] [--top=<n>]");
    eprintln!("  protheus-ops rag train nano [--depth=<n>] [--profile=<name>]");
    eprintln!("  protheus-ops rag nano fork [--target=<path>]");
    eprintln!("  protheus-ops rag merge-vault [--max-merge=<n>]");
    eprintln!("  protheus-ops rag memory status");
    eprintln!("  protheus-ops rag memory search --q=<query> [--top=<n>]");
    eprintln!("  protheus-ops rag memory get-node --node-id=<id> | --uid=<uid>");
    eprintln!("  protheus-ops rag memory build-index");
    eprintln!("  protheus-ops rag memory upgrade byterover");
    eprintln!("  protheus-ops rag memory taxonomy");
    eprintln!("  protheus-ops rag memory enable metacognitive");
    eprintln!("  protheus-ops rag memory enable causality");
    eprintln!("  protheus-ops rag memory benchmark ama");
    eprintln!("  protheus-ops rag memory share --persona=<id> --scope=task|step --consent=true");
    eprintln!("  protheus-ops rag memory evolve [--generation=<n>]");
    eprintln!("  protheus-ops rag memory causal-retrieve --q=<query> [--depth=<n>]");
    eprintln!("  protheus-ops rag memory fuse");
    eprintln!("  protheus-ops rag memory library enable stable");
}

fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value).unwrap_or_else(|_| "{\"ok\":false}".to_string())
    );
}

fn clean(v: &str, max_len: usize) -> String {
    v.split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
        .chars()
        .take(max_len)
        .collect::<String>()
        .trim()
        .to_string()
}

fn has_flag(argv: &[String], key: &str) -> bool {
    let exact = format!("--{key}");
    let pref = format!("--{key}=");
    argv.iter()
        .any(|row| row == &exact || row.starts_with(&pref))
}

fn normalize_search_args(argv: &[String]) -> Vec<String> {
    if has_flag(argv, "q") {
        return argv.to_vec();
    }
    let mut flags = Vec::new();
    let mut positional = Vec::new();
    for row in argv {
        if row.starts_with("--") {
            flags.push(row.clone());
        } else {
            positional.push(row.clone());
        }
    }
    if !positional.is_empty() {
        let query = clean(&positional.join(" "), 1600);
        if !query.is_empty() {
            flags.push(format!("--q={query}"));
        }
    }
    flags
}

fn normalize_ingest_args(argv: &[String]) -> Vec<String> {
    if has_flag(argv, "path") {
        return argv.to_vec();
    }
    let mut out = Vec::new();
    let mut used_path = false;
    for row in argv {
        if !used_path && !row.starts_with("--") {
            out.push(format!("--path={}", clean(row, 600)));
            used_path = true;
        } else {
            out.push(row.clone());
        }
    }
    out
}

fn build_memory_library_invocation(argv: &[String]) -> Result<Invocation, String> {
    if argv.is_empty() {
        return Ok(Invocation::MemoryRun {
            memory_command: "stable-status".to_string(),
            memory_args: vec![],
        });
    }
    let section = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    match section.as_str() {
        "status" => Ok(Invocation::MemoryRun {
            memory_command: "stable-status".to_string(),
            memory_args: vec![],
        }),
        "search" => Ok(Invocation::MemoryRun {
            memory_command: "stable-search".to_string(),
            memory_args: normalize_search_args(&argv[1..]),
        }),
        "get-node" => Ok(Invocation::MemoryRun {
            memory_command: "stable-get-node".to_string(),
            memory_args: argv.iter().skip(1).cloned().collect(),
        }),
        "build-index" => Ok(Invocation::MemoryRun {
            memory_command: "stable-build-index".to_string(),
            memory_args: argv.iter().skip(1).cloned().collect(),
        }),
        "taxonomy" => Ok(Invocation::MemoryRun {
            memory_command: "stable-memory-taxonomy".to_string(),
            memory_args: argv.iter().skip(1).cloned().collect(),
        }),
        "enable" => {
            let target = argv
                .get(1)
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_default();
            match target.as_str() {
                "metacognitive" => Ok(Invocation::MemoryRun {
                    memory_command: "stable-memory-enable-metacognitive".to_string(),
                    memory_args: argv.iter().skip(2).cloned().collect(),
                }),
                "causality" => Ok(Invocation::MemoryRun {
                    memory_command: "stable-memory-enable-causality".to_string(),
                    memory_args: argv.iter().skip(2).cloned().collect(),
                }),
                _ => Err("memory_enable_unknown_target".to_string()),
            }
        }
        "benchmark" => {
            let target = argv
                .get(1)
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_default();
            if target == "ama" {
                Ok(Invocation::MemoryRun {
                    memory_command: "stable-memory-benchmark-ama".to_string(),
                    memory_args: argv.iter().skip(2).cloned().collect(),
                })
            } else {
                Err("memory_benchmark_unknown_target".to_string())
            }
        }
        "share" => Ok(Invocation::MemoryRun {
            memory_command: "stable-memory-share".to_string(),
            memory_args: argv.iter().skip(1).cloned().collect(),
        }),
        "evolve" => Ok(Invocation::MemoryRun {
            memory_command: "stable-memory-evolve".to_string(),
            memory_args: argv.iter().skip(1).cloned().collect(),
        }),
        "causal-retrieve" => Ok(Invocation::MemoryRun {
            memory_command: "stable-memory-causal-retrieve".to_string(),
            memory_args: normalize_search_args(&argv.iter().skip(1).cloned().collect::<Vec<_>>()),
        }),
        "fuse" => Ok(Invocation::MemoryRun {
            memory_command: "stable-memory-fuse".to_string(),
            memory_args: argv.iter().skip(1).cloned().collect(),
        }),
        "upgrade" => {
            let target = argv
                .get(1)
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_default();
            if target == "byterover" {
                Ok(Invocation::MemoryRun {
                    memory_command: "stable-memory-upgrade-byterover".to_string(),
                    memory_args: argv.iter().skip(2).cloned().collect(),
                })
            } else {
                Err("memory_upgrade_unknown_target".to_string())
            }
        }
        "library" => {
            let action = argv
                .get(1)
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_default();
            let value = argv
                .get(2)
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_default();
            if action == "enable" && value == "stable" {
                Ok(Invocation::MemoryRun {
                    memory_command: "stable-status".to_string(),
                    memory_args: vec![],
                })
            } else {
                Err("memory_library_unknown_action".to_string())
            }
        }
        _ => Err("memory_unknown_command".to_string()),
    }
}

fn build_invocation(argv: &[String]) -> Result<Invocation, String> {
    let section = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    match section.as_str() {
        "status" => Ok(Invocation::MemoryRun {
            memory_command: "rag-status".to_string(),
            memory_args: vec![],
        }),
        "start" => Ok(Invocation::MemoryRun {
            memory_command: "stable-status".to_string(),
            memory_args: vec![],
        }),
        "ingest" => Ok(Invocation::MemoryRun {
            memory_command: "stable-rag-ingest".to_string(),
            memory_args: normalize_ingest_args(&argv.iter().skip(1).cloned().collect::<Vec<_>>()),
        }),
        "search" => Ok(Invocation::MemoryRun {
            memory_command: "stable-rag-search".to_string(),
            memory_args: normalize_search_args(&argv.iter().skip(1).cloned().collect::<Vec<_>>()),
        }),
        "chat" => Ok(Invocation::MemoryRun {
            memory_command: if argv
                .get(1)
                .map(|v| v.trim().eq_ignore_ascii_case("nano"))
                .unwrap_or(false)
            {
                "stable-nano-chat".to_string()
            } else {
                "stable-rag-chat".to_string()
            },
            memory_args: normalize_search_args(
                &argv
                    .iter()
                    .skip(if argv
                        .get(1)
                        .map(|v| v.trim().eq_ignore_ascii_case("nano"))
                        .unwrap_or(false)
                    {
                        2
                    } else {
                        1
                    })
                    .cloned()
                    .collect::<Vec<_>>(),
            ),
        }),
        "train" => {
            let target = argv
                .get(1)
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_default();
            if target == "nano" {
                Ok(Invocation::MemoryRun {
                    memory_command: "stable-nano-train".to_string(),
                    memory_args: argv.iter().skip(2).cloned().collect(),
                })
            } else {
                Err("train_unknown_target".to_string())
            }
        }
        "nano" => {
            let action = argv
                .get(1)
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "chat".to_string());
            match action.as_str() {
                "fork" => Ok(Invocation::MemoryRun {
                    memory_command: "stable-nano-fork".to_string(),
                    memory_args: argv.iter().skip(2).cloned().collect(),
                }),
                "chat" => Ok(Invocation::MemoryRun {
                    memory_command: "stable-nano-chat".to_string(),
                    memory_args: normalize_search_args(&argv.iter().skip(2).cloned().collect::<Vec<_>>()),
                }),
                _ => Err("nano_unknown_action".to_string()),
            }
        }
        "merge" | "merge-vault" => Ok(Invocation::MemoryRun {
            memory_command: "rag-merge-vault".to_string(),
            memory_args: argv.iter().skip(1).cloned().collect(),
        }),
        "upgrade" => {
            let target = argv
                .get(1)
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_default();
            if target == "byterover" {
                Ok(Invocation::MemoryRun {
                    memory_command: "stable-memory-upgrade-byterover".to_string(),
                    memory_args: argv.iter().skip(2).cloned().collect(),
                })
            } else {
                Err("upgrade_unknown_target".to_string())
            }
        }
        "ambient-status" => Ok(Invocation::AmbientStatus),
        "memory" => {
            build_memory_library_invocation(&argv.iter().skip(1).cloned().collect::<Vec<_>>())
        }
        "help" | "--help" | "-h" => Err("help".to_string()),
        _ => Err("unknown_command".to_string()),
    }
}

fn cli_error_receipt(root: &Path, argv: &[String], error: &str, exit_code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "rag_cli_error",
        "ts": now_iso(),
        "root": root.to_string_lossy().to_string(),
        "argv": argv,
        "error": error,
        "exit_code": exit_code
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let invocation = match build_invocation(argv) {
        Ok(v) => v,
        Err(reason) if reason == "help" => {
            usage();
            return 0;
        }
        Err(reason) => {
            usage();
            print_json(&cli_error_receipt(root, argv, &reason, 2));
            return 2;
        }
    };

    match invocation {
        Invocation::AmbientStatus => memory_ambient::run(root, &["status".to_string()]),
        Invocation::MemoryRun {
            memory_command,
            memory_args,
        } => {
            let mut args = vec![
                "run".to_string(),
                format!("--memory-command={memory_command}"),
            ];
            for row in memory_args {
                let trimmed = clean(&row, 1600);
                if !trimmed.is_empty() {
                    args.push(format!("--memory-arg={trimmed}"));
                }
            }
            memory_ambient::run(root, &args)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rag_search_promotes_positional_query() {
        let inv = build_invocation(&[
            "search".to_string(),
            "what".to_string(),
            "is".to_string(),
            "conduit".to_string(),
            "--top=3".to_string(),
        ])
        .expect("invocation");
        match inv {
            Invocation::MemoryRun {
                memory_command,
                memory_args,
            } => {
                assert_eq!(memory_command, "stable-rag-search");
                assert!(memory_args.iter().any(|v| v == "--top=3"));
                assert!(memory_args.iter().any(|v| v == "--q=what is conduit"));
            }
            _ => panic!("expected memory run"),
        }
    }

    #[test]
    fn ingest_promotes_first_positional_path() {
        let inv =
            build_invocation(&["ingest".to_string(), "docs/rag".to_string()]).expect("invocation");
        match inv {
            Invocation::MemoryRun { memory_args, .. } => {
                assert!(memory_args.iter().any(|v| v == "--path=docs/rag"));
            }
            _ => panic!("expected memory run"),
        }
    }

    #[test]
    fn memory_library_enable_stable_routes_to_stable_status() {
        let inv = build_invocation(&[
            "memory".to_string(),
            "library".to_string(),
            "enable".to_string(),
            "stable".to_string(),
        ])
        .expect("invocation");
        match inv {
            Invocation::MemoryRun {
                memory_command,
                memory_args,
            } => {
                assert_eq!(memory_command, "stable-status");
                assert!(memory_args.is_empty());
            }
            _ => panic!("expected memory run"),
        }
    }

    #[test]
    fn memory_upgrade_byterover_routes_to_stable_command() {
        let inv = build_invocation(&[
            "memory".to_string(),
            "upgrade".to_string(),
            "byterover".to_string(),
        ])
        .expect("invocation");
        match inv {
            Invocation::MemoryRun { memory_command, .. } => {
                assert_eq!(memory_command, "stable-memory-upgrade-byterover");
            }
            _ => panic!("expected memory run"),
        }
    }

    #[test]
    fn unknown_command_is_rejected() {
        let err = build_invocation(&["explode".to_string()]).expect_err("must fail");
        assert_eq!(err, "unknown_command");
    }

    #[test]
    fn memory_taxonomy_routes_to_stable_taxonomy() {
        let inv = build_invocation(&["memory".to_string(), "taxonomy".to_string()])
            .expect("invocation");
        match inv {
            Invocation::MemoryRun { memory_command, .. } => {
                assert_eq!(memory_command, "stable-memory-taxonomy");
            }
            _ => panic!("expected memory run"),
        }
    }

    #[test]
    fn memory_enable_causality_routes_to_stable_enable_command() {
        let inv = build_invocation(&[
            "memory".to_string(),
            "enable".to_string(),
            "causality".to_string(),
        ])
        .expect("invocation");
        match inv {
            Invocation::MemoryRun { memory_command, .. } => {
                assert_eq!(memory_command, "stable-memory-enable-causality");
            }
            _ => panic!("expected memory run"),
        }
    }

    #[test]
    fn memory_share_routes_to_stable_share_command() {
        let inv = build_invocation(&[
            "memory".to_string(),
            "share".to_string(),
            "--persona=peer".to_string(),
            "--scope=task".to_string(),
            "--consent=true".to_string(),
        ])
        .expect("invocation");
        match inv {
            Invocation::MemoryRun { memory_command, .. } => {
                assert_eq!(memory_command, "stable-memory-share");
            }
            _ => panic!("expected memory run"),
        }
    }

    #[test]
    fn memory_fuse_routes_to_stable_fuse_command() {
        let inv = build_invocation(&["memory".to_string(), "fuse".to_string()]).expect("inv");
        match inv {
            Invocation::MemoryRun { memory_command, .. } => {
                assert_eq!(memory_command, "stable-memory-fuse");
            }
            _ => panic!("expected memory run"),
        }
    }

    #[test]
    fn memory_benchmark_ama_routes_to_stable_benchmark_command() {
        let inv = build_invocation(&[
            "memory".to_string(),
            "benchmark".to_string(),
            "ama".to_string(),
            "--threshold=0.8".to_string(),
        ])
        .expect("invocation");
        match inv {
            Invocation::MemoryRun {
                memory_command,
                memory_args,
            } => {
                assert_eq!(memory_command, "stable-memory-benchmark-ama");
                assert!(memory_args.iter().any(|v| v == "--threshold=0.8"));
            }
            _ => panic!("expected memory run"),
        }
    }

    #[test]
    fn chat_nano_routes_to_stable_nano_chat() {
        let inv = build_invocation(&[
            "chat".to_string(),
            "nano".to_string(),
            "--q=teach me".to_string(),
        ])
        .expect("invocation");
        match inv {
            Invocation::MemoryRun {
                memory_command,
                memory_args,
            } => {
                assert_eq!(memory_command, "stable-nano-chat");
                assert!(memory_args.iter().any(|v| v == "--q=teach me"));
            }
            _ => panic!("expected memory run"),
        }
    }

    #[test]
    fn train_nano_routes_to_stable_nano_train() {
        let inv = build_invocation(&[
            "train".to_string(),
            "nano".to_string(),
            "--depth=12".to_string(),
        ])
        .expect("invocation");
        match inv {
            Invocation::MemoryRun {
                memory_command,
                memory_args,
            } => {
                assert_eq!(memory_command, "stable-nano-train");
                assert!(memory_args.iter().any(|v| v == "--depth=12"));
            }
            _ => panic!("expected memory run"),
        }
    }

    #[test]
    fn nano_fork_routes_to_stable_nano_fork() {
        let inv = build_invocation(&[
            "nano".to_string(),
            "fork".to_string(),
            "--target=.nanochat/fork".to_string(),
        ])
        .expect("invocation");
        match inv {
            Invocation::MemoryRun {
                memory_command,
                memory_args,
            } => {
                assert_eq!(memory_command, "stable-nano-fork");
                assert!(memory_args.iter().any(|v| v == "--target=.nanochat/fork"));
            }
            _ => panic!("expected memory run"),
        }
    }
}
