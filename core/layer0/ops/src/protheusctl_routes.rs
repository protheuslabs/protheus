use super::Route;

#[path = "protheusctl_plane_shortcuts.rs"]
mod protheusctl_plane_shortcuts;

fn contains_help_flag(args: &[String]) -> bool {
    args.iter().any(|arg| matches!(arg.trim(), "--help" | "-h"))
}

fn parse_true_flag(args: &[String], key: &str) -> bool {
    let exact = format!("--{key}");
    let prefix = format!("--{key}=");
    for arg in args {
        let token = arg.trim();
        if token == exact {
            return true;
        }
        if let Some(value) = token.strip_prefix(&prefix) {
            let norm = value.trim().to_ascii_lowercase();
            return matches!(norm.as_str(), "1" | "true" | "yes" | "on");
        }
    }
    false
}

fn has_prefix_flag(args: &[String], key: &str) -> bool {
    let prefix = format!("--{key}=");
    args.iter().any(|arg| arg.trim().starts_with(&prefix))
}

pub(super) fn resolve_core_shortcuts(cmd: &str, rest: &[String]) -> Option<Route> {
    match cmd {
        "rag" => Some(Route {
            script_rel: "core://rag".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            },
            forward_stdin: false,
        }),
        "swarm" => Some(Route {
            script_rel: "core://swarm-runtime".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            },
            forward_stdin: false,
        }),
        "memory" => {
            let mut args = vec!["memory".to_string()];
            if rest.is_empty() {
                args.push("status".to_string());
            } else {
                args.extend(rest.iter().cloned());
            }
            Some(Route {
                script_rel: "core://rag".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "chat"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("nano"))
                .unwrap_or(false) =>
        {
            let mut args = vec!["chat".to_string(), "nano".to_string()];
            args.extend(rest.iter().skip(1).cloned());
            Some(Route {
                script_rel: "core://rag".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "train"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("nano"))
                .unwrap_or(false) =>
        {
            let mut args = vec!["train".to_string(), "nano".to_string()];
            args.extend(rest.iter().skip(1).cloned());
            Some(Route {
                script_rel: "core://rag".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "nano" => {
            let mut args = vec!["nano".to_string()];
            if rest.is_empty() {
                args.push("chat".to_string());
            } else {
                args.extend(rest.iter().cloned());
            }
            Some(Route {
                script_rel: "core://rag".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "chat"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("with"))
                .unwrap_or(false)
                && rest
                    .get(1)
                    .map(|v| v.trim().eq_ignore_ascii_case("files"))
                    .unwrap_or(false) =>
        {
            let mut args = vec!["chat".to_string()];
            args.extend(rest.iter().skip(2).cloned());
            Some(Route {
                script_rel: "core://rag".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "business" => Some(Route {
            script_rel: "core://business-plane".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            },
            forward_stdin: false,
        }),
        "canyon" => Some(Route {
            script_rel: "core://canyon-plane".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            },
            forward_stdin: false,
        }),
        "init" => {
            if contains_help_flag(rest) {
                return Some(Route {
                    script_rel: "core://canyon-plane".to_string(),
                    args: vec!["help".to_string()],
                    forward_stdin: false,
                });
            }
            let mut args = vec!["ecosystem".to_string(), "--op=init".to_string()];
            let pure_requested = parse_true_flag(rest, "pure");
            let tiny_max_requested =
                parse_true_flag(rest, "tiny-max") || parse_true_flag(rest, "tiny_max");
            if (pure_requested || tiny_max_requested) && !has_prefix_flag(rest, "workspace-mode") {
                args.push("--workspace-mode=pure".to_string());
            }
            if tiny_max_requested && !has_prefix_flag(rest, "pure") {
                args.push("--pure=1".to_string());
            }
            if let Some(template) = rest.first() {
                if !template.starts_with("--") {
                    args.push(format!("--template={}", template.trim()));
                    args.extend(rest.iter().skip(1).cloned());
                } else {
                    args.extend(rest.iter().cloned());
                }
            }
            Some(Route {
                script_rel: "core://canyon-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "alpha-check" => Some(Route {
            script_rel: "core://alpha-readiness".to_string(),
            args: if rest.is_empty() {
                vec!["run".to_string()]
            } else if rest
                .first()
                .map(|value| value.trim().starts_with("--"))
                .unwrap_or(false)
            {
                std::iter::once("run".to_string())
                    .chain(rest.iter().cloned())
                    .collect::<Vec<_>>()
            } else {
                rest.to_vec()
            },
            forward_stdin: false,
        }),
        "marketplace" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let op = match sub.as_str() {
                "publish" => "marketplace-publish",
                "install" => "marketplace-install",
                _ => "marketplace-status",
            };
            let mut args = vec!["ecosystem".to_string(), format!("--op={op}")];
            if !rest.is_empty() {
                args.extend(rest.iter().skip(1).cloned());
            }
            Some(Route {
                script_rel: "core://canyon-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "government" | "gov" => Some(Route {
            script_rel: "core://government-plane".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            },
            forward_stdin: false,
        }),
        "finance" | "bank" => Some(Route {
            script_rel: "core://finance-plane".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            },
            forward_stdin: false,
        }),
        "healthcare" | "hospital" => Some(Route {
            script_rel: "core://healthcare-plane".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            },
            forward_stdin: false,
        }),
        "vertical" => Some(Route {
            script_rel: "core://vertical-plane".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            },
            forward_stdin: false,
        }),
        "nexus" => Some(Route {
            script_rel: "core://nexus-plane".to_string(),
            args: if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            },
            forward_stdin: false,
        }),
        "adaptive" | "adaptive-intelligence" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let normalized = match sub.as_str() {
                "shadow_train" => "shadow-train",
                "status" | "propose" | "shadow-train" | "prioritize" | "graduate" => sub.as_str(),
                _ => "status",
            };
            let mut args = vec![normalized.to_string()];
            if !rest.is_empty() {
                if normalized == sub {
                    args.extend(rest.iter().skip(1).cloned());
                } else {
                    args.extend(rest.iter().cloned());
                }
            }
            Some(Route {
                script_rel: "core://adaptive-intelligence".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "eval" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "benchmark".to_string());
            let args = match sub.as_str() {
                "enable"
                    if rest
                        .get(1)
                        .map(|v| v.trim().eq_ignore_ascii_case("neuralavb"))
                        .unwrap_or(false) =>
                {
                    std::iter::once("enable-neuralavb".to_string())
                        .chain(rest.iter().skip(2).cloned())
                        .collect::<Vec<_>>()
                }
                "experiment"
                    if rest
                        .get(1)
                        .map(|v| v.trim().eq_ignore_ascii_case("loop"))
                        .unwrap_or(false) =>
                {
                    std::iter::once("experiment-loop".to_string())
                        .chain(rest.iter().skip(2).cloned())
                        .collect::<Vec<_>>()
                }
                "benchmark" => std::iter::once("benchmark".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
                _ => {
                    if rest.is_empty() {
                        vec!["benchmark".to_string()]
                    } else {
                        rest.to_vec()
                    }
                }
            };
            Some(Route {
                script_rel: "core://eval-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "rl" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let args = match sub.as_str() {
                "upgrade"
                    if rest
                        .get(1)
                        .map(|v| v.trim().eq_ignore_ascii_case("openclaw-v2"))
                        .unwrap_or(false) =>
                {
                    std::iter::once("rl-upgrade".to_string())
                        .chain(rest.iter().skip(2).cloned())
                        .collect::<Vec<_>>()
                }
                "status" => std::iter::once("rl-status".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
                _ => {
                    if rest.is_empty() {
                        vec!["rl-status".to_string()]
                    } else {
                        rest.to_vec()
                    }
                }
            };
            Some(Route {
                script_rel: "core://eval-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "experiment"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("loop"))
                .unwrap_or(false) =>
        {
            let mut args = vec!["experiment-loop".to_string()];
            args.extend(rest.iter().skip(1).cloned());
            Some(Route {
                script_rel: "core://eval-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "model" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            if sub == "buy"
                && rest
                    .get(1)
                    .map(|v| v.trim().eq_ignore_ascii_case("credits"))
                    .unwrap_or(false)
            {
                let args = std::iter::once("buy-credits".to_string())
                    .chain(rest.iter().skip(2).cloned())
                    .collect::<Vec<_>>();
                return Some(Route {
                    script_rel: "core://intelligence-nexus".to_string(),
                    args,
                    forward_stdin: false,
                });
            }
            let args = match sub.as_str() {
                "optimize"
                    if rest
                        .get(1)
                        .map(|v| v.trim().eq_ignore_ascii_case("minimax"))
                        .unwrap_or(false) =>
                {
                    std::iter::once("optimize".to_string())
                        .chain(std::iter::once("--profile=minimax".to_string()))
                        .chain(rest.iter().skip(2).cloned())
                        .collect::<Vec<_>>()
                }
                "use"
                    if rest
                        .get(1)
                        .map(|v| v.trim().eq_ignore_ascii_case("bitnet"))
                        .unwrap_or(false) =>
                {
                    std::iter::once("bitnet-use".to_string())
                        .chain(rest.iter().skip(2).cloned())
                        .collect::<Vec<_>>()
                }
                "use"
                    if rest
                        .get(1)
                        .map(|v| v.trim().eq_ignore_ascii_case("cheap"))
                        .unwrap_or(false) =>
                {
                    std::iter::once("optimize".to_string())
                        .chain(std::iter::once("--profile=minimax".to_string()))
                        .chain(rest.iter().skip(2).cloned())
                        .collect::<Vec<_>>()
                }
                _ => {
                    if rest.is_empty() {
                        vec!["status".to_string()]
                    } else {
                        rest.to_vec()
                    }
                }
            };
            Some(Route {
                script_rel: "core://model-router".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "keys" => {
            let args = if rest.is_empty() {
                vec!["open".to_string()]
            } else {
                let sub = rest
                    .first()
                    .map(|v| v.trim().to_ascii_lowercase())
                    .unwrap_or_else(|| "open".to_string());
                match sub.as_str() {
                    "add" => std::iter::once("add-key".to_string())
                        .chain(rest.iter().skip(1).cloned())
                        .collect::<Vec<_>>(),
                    "rotate" => std::iter::once("rotate-key".to_string())
                        .chain(rest.iter().skip(1).cloned())
                        .collect::<Vec<_>>(),
                    "revoke" | "remove" => std::iter::once("revoke-key".to_string())
                        .chain(rest.iter().skip(1).cloned())
                        .collect::<Vec<_>>(),
                    _ => rest.to_vec(),
                }
            };
            Some(Route {
                script_rel: "core://intelligence-nexus".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "graph" => {
            let args = if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            };
            Some(Route {
                script_rel: "core://graph-toolkit".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "research" => {
            let mut firmware_mode = false;
            let mut firmware_input: Option<String> = None;
            let mut passthrough = Vec::<String>::new();
            let mut idx = 0usize;
            while idx < rest.len() {
                let token = rest[idx].trim();
                let lower = token.to_ascii_lowercase();
                if lower == "--firmware" {
                    firmware_mode = true;
                    if let Some(next) = rest.get(idx + 1) {
                        if !next.starts_with("--") {
                            firmware_input = Some(next.clone());
                            idx += 1;
                        }
                    }
                } else if lower.starts_with("--firmware=") {
                    firmware_mode = true;
                    let value = token.split_once('=').map(|(_, v)| v.trim()).unwrap_or("");
                    if !value.is_empty() {
                        firmware_input = Some(value.to_string());
                    }
                } else {
                    passthrough.push(rest[idx].clone());
                }
                idx += 1;
            }
            if firmware_mode {
                let mut args = vec![
                    "scan".to_string(),
                    "--dx-source=research-firmware".to_string(),
                ];
                let input = firmware_input
                    .or_else(|| {
                        passthrough
                            .iter()
                            .find(|arg| arg.starts_with("--input="))
                            .map(|arg| arg.trim_start_matches("--input=").to_string())
                    })
                    .or_else(|| {
                        passthrough
                            .iter()
                            .find(|arg| !arg.starts_with("--"))
                            .cloned()
                    });
                if let Some(path) = input {
                    args.push(format!("--input={path}"));
                }
                args.extend(passthrough.into_iter().filter(|arg| {
                    arg.starts_with("--")
                        && (arg.starts_with("--strict=")
                            || arg.starts_with("--format=")
                            || arg.starts_with("--rulepack=")
                            || arg.starts_with("--allow-raw-path=")
                            || arg.starts_with("--transport="))
                }));
                return Some(Route {
                    script_rel: "core://binary-vuln-plane".to_string(),
                    args,
                    forward_stdin: false,
                });
            }
            let mut args = if rest.is_empty() {
                vec!["status".to_string()]
            } else if rest
                .first()
                .map(|v| {
                    let x = v.trim().to_ascii_lowercase();
                    x.starts_with("--")
                        || x.starts_with("https://")
                        || x.starts_with("http://")
                        || x.starts_with("file://")
                })
                .unwrap_or(false)
            {
                std::iter::once("fetch".to_string())
                    .chain(rest.iter().cloned())
                    .collect::<Vec<_>>()
            } else {
                rest.to_vec()
            };
            let has_mode = args.iter().any(|arg| arg.starts_with("--mode="));
            let stealth_index = args.iter().position(|arg| {
                let value = arg.trim().to_ascii_lowercase();
                value == "--stealth"
                    || value == "--stealth=1"
                    || value == "--stealth=true"
                    || value == "--stealth=yes"
                    || value == "--stealth=on"
            });
            if let Some(idx) = stealth_index {
                args.remove(idx);
                if !has_mode {
                    args.push("--mode=stealth".to_string());
                }
            } else if args.first().map(|v| v.as_str()) == Some("fetch") && !has_mode {
                args.push("--mode=auto".to_string());
            }
            Some(Route {
                script_rel: "core://research-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "crawl" => {
            let mut args = vec!["goal-crawl".to_string()];
            let mut goal_tokens = Vec::<String>::new();
            let mut passthrough = Vec::<String>::new();
            for row in rest {
                if row.starts_with("--") {
                    passthrough.push(row.clone());
                } else {
                    goal_tokens.push(row.clone());
                }
            }
            if !goal_tokens.is_empty() {
                args.push(format!("--goal={}", goal_tokens.join(" ")));
            }
            args.extend(passthrough);
            Some(Route {
                script_rel: "core://research-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "map" => {
            let mut args = vec!["map-site".to_string()];
            if let Some(domain) = rest.first() {
                if !domain.starts_with("--") {
                    args.push(format!("--domain={}", domain.trim()));
                    args.extend(rest.iter().skip(1).cloned());
                } else {
                    args.extend(rest.iter().cloned());
                }
            }
            Some(Route {
                script_rel: "core://research-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "monitor" => {
            let mut args = vec!["monitor".to_string()];
            if let Some(url) = rest.first() {
                if !url.starts_with("--") {
                    args.push(format!("--url={}", url.trim()));
                    args.extend(rest.iter().skip(1).cloned());
                } else {
                    args.extend(rest.iter().cloned());
                }
            }
            Some(Route {
                script_rel: "core://research-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "assimilate" => {
            if rest.is_empty() {
                return None;
            }
            let target = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_default();
            let passthrough = rest.iter().skip(1).cloned().collect::<Vec<_>>();
            match target.as_str() {
                "scrape://scrapy-core" => {
                    let mut args = vec!["template-governance".to_string()];
                    args.extend(passthrough);
                    Some(Route {
                        script_rel: "core://research-plane".to_string(),
                        args,
                        forward_stdin: false,
                    })
                }
                "scrape://firecrawl-core" => {
                    let mut args = vec!["firecrawl-template-governance".to_string()];
                    args.extend(passthrough);
                    Some(Route {
                        script_rel: "core://research-plane".to_string(),
                        args,
                        forward_stdin: false,
                    })
                }
                "parse://doc2dict-core" => {
                    let mut args = vec!["template-governance".to_string()];
                    args.extend(passthrough);
                    Some(Route {
                        script_rel: "core://parse-plane".to_string(),
                        args,
                        forward_stdin: false,
                    })
                }
                "llamaindex" | "rag://llamaindex" => {
                    let args = if passthrough.is_empty()
                        || passthrough
                            .first()
                            .map(|row| row.starts_with("--"))
                            .unwrap_or(false)
                    {
                        let mut args = vec!["register-connector".to_string()];
                        args.extend(passthrough);
                        args
                    } else {
                        passthrough
                    };
                    Some(Route {
                        script_rel: "core://llamaindex-bridge".to_string(),
                        args,
                        forward_stdin: false,
                    })
                }
                "google-adk" | "workflow://google-adk" => {
                    let args = if passthrough.is_empty()
                        || passthrough
                            .first()
                            .map(|row| row.starts_with("--"))
                            .unwrap_or(false)
                    {
                        let mut args = vec!["register-tool-manifest".to_string()];
                        args.extend(passthrough);
                        args
                    } else {
                        passthrough
                    };
                    Some(Route {
                        script_rel: "core://google-adk-bridge".to_string(),
                        args,
                        forward_stdin: false,
                    })
                }
                "camel" | "workflow://camel" | "society://camel" => {
                    let args = if passthrough.is_empty()
                        || passthrough
                            .first()
                            .map(|row| row.starts_with("--"))
                            .unwrap_or(false)
                    {
                        let mut args = vec!["import-dataset".to_string()];
                        args.extend(passthrough);
                        args
                    } else {
                        passthrough
                    };
                    Some(Route {
                        script_rel: "core://camel-bridge".to_string(),
                        args,
                        forward_stdin: false,
                    })
                }
                "haystack" | "workflow://haystack" | "rag://haystack" => {
                    let args = if passthrough.is_empty()
                        || passthrough
                            .first()
                            .map(|row| row.starts_with("--"))
                            .unwrap_or(false)
                    {
                        let mut args = vec!["register-pipeline".to_string()];
                        args.extend(passthrough);
                        args
                    } else {
                        passthrough
                    };
                    Some(Route {
                        script_rel: "core://haystack-bridge".to_string(),
                        args,
                        forward_stdin: false,
                    })
                }
                "langchain" | "workflow://langchain" | "chains://langchain" => {
                    let args = if passthrough.is_empty()
                        || passthrough
                            .first()
                            .map(|row| row.starts_with("--"))
                            .unwrap_or(false)
                    {
                        let mut args = vec!["import-integration".to_string()];
                        args.extend(passthrough);
                        args
                    } else {
                        passthrough
                    };
                    Some(Route {
                        script_rel: "core://langchain-bridge".to_string(),
                        args,
                        forward_stdin: false,
                    })
                }
                "pydantic-ai" | "workflow://pydantic-ai" | "agents://pydantic-ai" => {
                    let args = if passthrough.is_empty()
                        || passthrough
                            .first()
                            .map(|row| row.starts_with("--"))
                            .unwrap_or(false)
                    {
                        let mut args = vec!["register-agent".to_string()];
                        args.extend(passthrough);
                        args
                    } else {
                        passthrough
                    };
                    Some(Route {
                        script_rel: "core://pydantic-ai-bridge".to_string(),
                        args,
                        forward_stdin: false,
                    })
                }
                "mastra" | "workflow://mastra" => {
                    let args = if passthrough.is_empty()
                        || passthrough
                            .first()
                            .map(|row| row.starts_with("--"))
                            .unwrap_or(false)
                    {
                        let mut args = vec!["register-graph".to_string()];
                        args.extend(passthrough);
                        args
                    } else {
                        passthrough
                    };
                    Some(Route {
                        script_rel: "core://mastra-bridge".to_string(),
                        args,
                        forward_stdin: false,
                    })
                }
                _ => None,
            }
        }
        "parse" => {
            let args = if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                let sub = rest
                    .first()
                    .map(|v| v.trim().to_ascii_lowercase())
                    .unwrap_or_else(|| "status".to_string());
                match sub.as_str() {
                    "doc" => {
                        let mut args = vec!["parse-doc".to_string()];
                        if let Some(path) = rest.get(1) {
                            if !path.starts_with("--") {
                                args.push(format!("--file={}", path.trim()));
                                args.extend(rest.iter().skip(2).cloned());
                            } else {
                                args.extend(rest.iter().skip(1).cloned());
                            }
                        } else {
                            args.extend(rest.iter().skip(1).cloned());
                        }
                        args
                    }
                    "visualize" | "viz" => {
                        let mut args = vec!["visualize".to_string()];
                        if let Some(path) = rest.get(1) {
                            if !path.starts_with("--") {
                                args.push(format!("--from-path={}", path.trim()));
                                args.extend(rest.iter().skip(2).cloned());
                            } else {
                                args.extend(rest.iter().skip(1).cloned());
                            }
                        } else {
                            args.extend(rest.iter().skip(1).cloned());
                        }
                        args
                    }
                    "export" => {
                        let mut args = vec!["export".to_string()];
                        if let Some(path) = rest.get(1) {
                            if !path.starts_with("--") {
                                args.push(format!("--from-path={}", path.trim()));
                                if let Some(out_path) = rest.get(2) {
                                    if !out_path.starts_with("--") {
                                        args.push(format!("--output-path={}", out_path.trim()));
                                        args.extend(rest.iter().skip(3).cloned());
                                    } else {
                                        args.extend(rest.iter().skip(2).cloned());
                                    }
                                } else {
                                    args.extend(rest.iter().skip(2).cloned());
                                }
                            } else {
                                args.extend(rest.iter().skip(1).cloned());
                            }
                        } else {
                            args.extend(rest.iter().skip(1).cloned());
                        }
                        args
                    }
                    _ => rest.to_vec(),
                }
            };
            Some(Route {
                script_rel: "core://parse-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "flow" => {
            let args = if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                let sub = rest
                    .first()
                    .map(|v| v.trim().to_ascii_lowercase())
                    .unwrap_or_else(|| "status".to_string());
                match sub.as_str() {
                    "compile" | "build" => {
                        let mut args = vec!["compile".to_string()];
                        if let Some(path) = rest.get(1) {
                            if !path.starts_with("--") {
                                args.push(format!("--canvas-path={}", path.trim()));
                                args.extend(rest.iter().skip(2).cloned());
                            } else {
                                args.extend(rest.iter().skip(1).cloned());
                            }
                        } else {
                            args.extend(rest.iter().skip(1).cloned());
                        }
                        args
                    }
                    "debug" => {
                        let mut args = vec!["playground".to_string()];
                        if let Some(op) = rest.get(1) {
                            if !op.starts_with("--") {
                                args.push(format!("--op={}", op.trim()));
                                args.extend(rest.iter().skip(2).cloned());
                            } else {
                                args.extend(rest.iter().skip(1).cloned());
                            }
                        } else {
                            args.extend(rest.iter().skip(1).cloned());
                        }
                        args
                    }
                    "run" => {
                        let mut args = vec!["playground".to_string(), "--op=play".to_string()];
                        args.extend(rest.iter().skip(1).cloned());
                        args
                    }
                    "templates" => {
                        let mut args = vec!["template-governance".to_string()];
                        args.extend(rest.iter().skip(1).cloned());
                        args
                    }
                    "install" => {
                        let mut args = vec!["install".to_string()];
                        args.extend(rest.iter().skip(1).cloned());
                        args
                    }
                    "components" => {
                        let mut args = vec!["component-marketplace".to_string()];
                        args.extend(rest.iter().skip(1).cloned());
                        args
                    }
                    _ => rest.to_vec(),
                }
            };
            Some(Route {
                script_rel: "core://flow-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "mcp" => {
            let args = if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                let sub = rest
                    .first()
                    .map(|v| v.trim().to_ascii_lowercase())
                    .unwrap_or_else(|| "status".to_string());
                match sub.as_str() {
                    "expose" => {
                        let mut args = vec!["expose".to_string()];
                        if let Some(agent) = rest.get(1) {
                            if !agent.starts_with("--") {
                                args.push(format!("--agent={}", agent.trim()));
                                args.extend(rest.iter().skip(2).cloned());
                            } else {
                                args.extend(rest.iter().skip(1).cloned());
                            }
                        } else {
                            args.extend(rest.iter().skip(1).cloned());
                        }
                        args
                    }
                    _ => rest.to_vec(),
                }
            };
            Some(Route {
                script_rel: "core://mcp-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "blobs" | "blob" => {
            let args = if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            };
            Some(Route {
                script_rel: "core://binary-blob-runtime".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "directives" => {
            let args = if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            };
            Some(Route {
                script_rel: "core://directive-kernel".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "prime"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("sign"))
                .unwrap_or(false) =>
        {
            let args = std::iter::once("prime-sign".to_string())
                .chain(rest.iter().skip(1).cloned())
                .collect::<Vec<_>>();
            Some(Route {
                script_rel: "core://directive-kernel".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "organism" => {
            let args = if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            };
            Some(Route {
                script_rel: "core://organism-layer".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "rsi" => {
            let args = if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            };
            Some(Route {
                script_rel: "core://rsi-ignition".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "veto" => {
            let mut args = vec![
                "compliance-check".to_string(),
                "--action=veto".to_string(),
                "--allow=0".to_string(),
            ];
            args.extend(rest.iter().cloned());
            Some(Route {
                script_rel: "core://directive-kernel".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "agent"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("run"))
                .unwrap_or(false) =>
        {
            let mut args = vec!["ephemeral-run".to_string()];
            if let Some(goal) = rest.get(1) {
                if !goal.starts_with("--") {
                    args.push(format!("--goal={goal}"));
                }
            }
            args.extend(
                rest.iter()
                    .skip(2)
                    .filter(|v| !v.trim().eq_ignore_ascii_case("--ephemeral"))
                    .cloned(),
            );
            Some(Route {
                script_rel: "core://autonomy-controller".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "agent"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("status"))
                .unwrap_or(false)
                && rest
                    .iter()
                    .any(|v| v.trim().eq_ignore_ascii_case("--trunk")) =>
        {
            let mut args = vec!["trunk-status".to_string()];
            args.extend(
                rest.iter()
                    .skip(1)
                    .filter(|v| !v.trim().eq_ignore_ascii_case("--trunk"))
                    .cloned(),
            );
            Some(Route {
                script_rel: "core://autonomy-controller".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "agent"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("reset"))
                .unwrap_or(false) =>
        {
            let args = std::iter::once("reset-agent".to_string())
                .chain(rest.iter().skip(1).cloned())
                .collect::<Vec<_>>();
            Some(Route {
                script_rel: "core://model-router".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "agent"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("debate"))
                .unwrap_or(false)
                && rest
                    .get(1)
                    .map(|v| v.trim().eq_ignore_ascii_case("bullbear"))
                    .unwrap_or(false) =>
        {
            let mut args = vec!["debate-bullbear".to_string()];
            args.extend(rest.iter().skip(2).cloned());
            Some(Route {
                script_rel: "core://llm-economy-organ".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "economy" => {
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("stake"))
                .unwrap_or(false)
                && rest.iter().any(|v| v.trim().starts_with("--market"))
            {
                let market = rest
                    .iter()
                    .find_map(|v| v.trim().split_once("--market=").map(|(_, m)| m.to_string()))
                    .unwrap_or_else(|| "unknown".to_string());
                return Some(Route {
                    script_rel: "core://network-protocol".to_string(),
                    args: vec![
                        "stake".to_string(),
                        "--action=stake".to_string(),
                        "--agent=economy:operator".to_string(),
                        "--amount=10".to_string(),
                        format!("--reason=market:{market}"),
                    ],
                    forward_stdin: false,
                });
            }
            let args = if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("upgrade"))
                .unwrap_or(false)
                && rest
                    .get(1)
                    .map(|v| v.trim().eq_ignore_ascii_case("trading-hand"))
                    .unwrap_or(false)
            {
                let mut args = vec!["upgrade-trading-hand".to_string()];
                args.extend(rest.iter().skip(2).cloned());
                args
            } else if rest.is_empty() {
                vec!["dashboard".to_string()]
            } else {
                rest.to_vec()
            };
            Some(Route {
                script_rel: "core://llm-economy-organ".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "network" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("ignite"))
                .unwrap_or(false)
                && rest
                    .get(1)
                    .map(|v| v.trim().eq_ignore_ascii_case("bitcoin"))
                    .unwrap_or(false)
            {
                let args = std::iter::once("ignite-bitcoin".to_string())
                    .chain(rest.iter().skip(2).cloned())
                    .collect::<Vec<_>>();
                return Some(Route {
                    script_rel: "core://network-protocol".to_string(),
                    args,
                    forward_stdin: false,
                });
            }
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("join"))
                .unwrap_or(false)
                && rest
                    .get(1)
                    .map(|v| v.trim().eq_ignore_ascii_case("hyperspace"))
                    .unwrap_or(false)
            {
                let args = std::iter::once("join-hyperspace".to_string())
                    .chain(rest.iter().skip(2).cloned())
                    .collect::<Vec<_>>();
                return Some(Route {
                    script_rel: "core://network-protocol".to_string(),
                    args,
                    forward_stdin: false,
                });
            }
            if matches!(
                sub.as_str(),
                "status"
                    | "stake"
                    | "reward"
                    | "slash"
                    | "contribution"
                    | "consensus"
                    | "rsi-boundary"
                    | "governance-vote"
                    | "join-hyperspace"
                    | "merkle-root"
                    | "emission"
                    | "zk-claim"
                    | "oracle-query"
                    | "truth-weight"
                    | "dashboard"
            ) {
                let args = if rest.is_empty() {
                    vec!["status".to_string()]
                } else {
                    rest.to_vec()
                };
                return Some(Route {
                    script_rel: "core://network-protocol".to_string(),
                    args,
                    forward_stdin: false,
                });
            }
            let args = if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("dashboard"))
                .unwrap_or(false)
            {
                let mut args = vec!["status".to_string(), "--dashboard=1".to_string()];
                args.extend(rest.iter().skip(1).cloned());
                args
            } else if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            };
            Some(Route {
                script_rel: "core://p2p-gossip-seed".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "enterprise" => {
            let args = if rest.is_empty() {
                vec!["dashboard".to_string()]
            } else if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("enable"))
                .unwrap_or(false)
                && rest
                    .get(1)
                    .map(|v| v.trim().eq_ignore_ascii_case("bedrock"))
                    .unwrap_or(false)
            {
                std::iter::once("enable-bedrock".to_string())
                    .chain(rest.iter().skip(2).cloned())
                    .collect::<Vec<_>>()
            } else if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("compliance"))
                .unwrap_or(false)
                && rest
                    .get(1)
                    .map(|v| v.trim().eq_ignore_ascii_case("export"))
                    .unwrap_or(false)
            {
                std::iter::once("export-compliance".to_string())
                    .chain(rest.iter().skip(2).cloned())
                    .collect::<Vec<_>>()
            } else if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("identity"))
                .unwrap_or(false)
            {
                std::iter::once("identity-surface".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>()
            } else if rest
                .first()
                .map(|v| {
                    v.trim().eq_ignore_ascii_case("scale")
                        || v.trim().eq_ignore_ascii_case("certify-scale")
                })
                .unwrap_or(false)
            {
                let skip = if rest
                    .first()
                    .map(|v| v.trim().eq_ignore_ascii_case("scale"))
                    .unwrap_or(false)
                {
                    1
                } else {
                    0
                };
                std::iter::once("certify-scale".to_string())
                    .chain(rest.iter().skip(skip).cloned())
                    .collect::<Vec<_>>()
            } else if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("moat"))
                .unwrap_or(false)
            {
                match rest
                    .get(1)
                    .map(|v| v.trim().to_ascii_lowercase())
                    .unwrap_or_else(|| "contrast".to_string())
                    .as_str()
                {
                    "license" => std::iter::once("moat-license".to_string())
                        .chain(rest.iter().skip(2).cloned())
                        .collect::<Vec<_>>(),
                    "launch-sim" | "launch" => std::iter::once("moat-launch-sim".to_string())
                        .chain(rest.iter().skip(2).cloned())
                        .collect::<Vec<_>>(),
                    _ => std::iter::once("moat-contrast".to_string())
                        .chain(rest.iter().skip(2).cloned())
                        .collect::<Vec<_>>(),
                }
            } else if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("genesis"))
                .unwrap_or(false)
            {
                match rest
                    .get(1)
                    .map(|v| v.trim().to_ascii_lowercase())
                    .unwrap_or_else(|| "truth-gate".to_string())
                    .as_str()
                {
                    "truth-gate" | "gate" => std::iter::once("genesis-truth-gate".to_string())
                        .chain(rest.iter().skip(2).cloned())
                        .collect::<Vec<_>>(),
                    "thin-wrapper-audit" | "thin-wrapper" | "audit" => {
                        std::iter::once("genesis-thin-wrapper-audit".to_string())
                            .chain(rest.iter().skip(2).cloned())
                            .collect::<Vec<_>>()
                    }
                    "doc-freeze" | "freeze" => std::iter::once("genesis-doc-freeze".to_string())
                        .chain(rest.iter().skip(2).cloned())
                        .collect::<Vec<_>>(),
                    "bootstrap" => std::iter::once("genesis-bootstrap".to_string())
                        .chain(rest.iter().skip(2).cloned())
                        .collect::<Vec<_>>(),
                    "installer-sim" | "installer" => {
                        std::iter::once("genesis-installer-sim".to_string())
                            .chain(rest.iter().skip(2).cloned())
                            .collect::<Vec<_>>()
                    }
                    _ => std::iter::once("genesis-truth-gate".to_string())
                        .chain(rest.iter().skip(2).cloned())
                        .collect::<Vec<_>>(),
                }
            } else {
                rest.to_vec()
            };
            Some(Route {
                script_rel: "core://enterprise-hardening".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "moat" => {
            let args = match rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "contrast".to_string())
                .as_str()
            {
                "license" => std::iter::once("moat-license".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
                "launch-sim" | "launch" => std::iter::once("moat-launch-sim".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
                "replay" => std::iter::once("replay".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
                "explore" => std::iter::once("explore".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
                "ai" => std::iter::once("ai".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
                "sync" => std::iter::once("sync".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
                "energy-cert" | "energy" => std::iter::once("energy-cert".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
                "migrate" => std::iter::once("migrate-ecosystem".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
                "chaos" => std::iter::once("chaos-run".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
                "assistant" => std::iter::once("assistant-mode".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
                _ => std::iter::once("moat-contrast".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
            };
            Some(Route {
                script_rel: "core://enterprise-hardening".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "replay" => Some(Route {
            script_rel: "core://enterprise-hardening".to_string(),
            args: std::iter::once("replay".to_string())
                .chain(rest.iter().cloned())
                .collect(),
            forward_stdin: false,
        }),
        "explore" => Some(Route {
            script_rel: "core://enterprise-hardening".to_string(),
            args: std::iter::once("explore".to_string())
                .chain(rest.iter().cloned())
                .collect(),
            forward_stdin: false,
        }),
        "ai" => Some(Route {
            script_rel: "core://enterprise-hardening".to_string(),
            args: std::iter::once("ai".to_string())
                .chain(rest.iter().cloned())
                .collect(),
            forward_stdin: false,
        }),
        "chaos" => Some(Route {
            script_rel: "core://enterprise-hardening".to_string(),
            args: if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("isolate"))
                .unwrap_or(false)
            {
                std::iter::once("chaos-run".to_string())
                    .chain(std::iter::once("--suite=isolate".to_string()))
                    .chain(rest.iter().skip(1).cloned())
                    .collect()
            } else {
                std::iter::once("chaos-run".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect()
            },
            forward_stdin: false,
        }),
        "assistant" => Some(Route {
            script_rel: "core://enterprise-hardening".to_string(),
            args: std::iter::once("assistant-mode".to_string())
                .chain(rest.iter().cloned())
                .collect(),
            forward_stdin: false,
        }),
        "genesis" => {
            let args = match rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "truth-gate".to_string())
                .as_str()
            {
                "truth-gate" | "gate" => std::iter::once("genesis-truth-gate".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
                "thin-wrapper-audit" | "thin-wrapper" | "audit" => {
                    std::iter::once("genesis-thin-wrapper-audit".to_string())
                        .chain(rest.iter().skip(1).cloned())
                        .collect::<Vec<_>>()
                }
                "doc-freeze" | "freeze" => std::iter::once("genesis-doc-freeze".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
                "bootstrap" => std::iter::once("genesis-bootstrap".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
                "installer-sim" | "installer" => {
                    std::iter::once("genesis-installer-sim".to_string())
                        .chain(rest.iter().skip(1).cloned())
                        .collect::<Vec<_>>()
                }
                _ => std::iter::once("genesis-truth-gate".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
            };
            Some(Route {
                script_rel: "core://enterprise-hardening".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "seed" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let args = match sub.as_str() {
                "deploy" | "ignite" => {
                    let mut out = vec!["deploy".to_string()];
                    let mut skip = 1usize;
                    if let Some(profile) = rest.get(1).map(|v| v.trim().to_ascii_lowercase()) {
                        if profile == "viral" || profile == "immortal" {
                            out.push(format!("--profile={profile}"));
                            skip = 2;
                        }
                    }
                    out.extend(rest.iter().skip(skip).cloned());
                    out
                }
                "monitor" => {
                    let mut out = vec!["monitor".to_string()];
                    out.extend(rest.iter().skip(1).cloned());
                    out
                }
                "status" | "migrate" | "enforce" | "select" | "archive" | "defend" => {
                    if rest.is_empty() {
                        vec!["status".to_string()]
                    } else {
                        rest.to_vec()
                    }
                }
                _ => {
                    if rest.is_empty() {
                        vec!["status".to_string()]
                    } else {
                        rest.to_vec()
                    }
                }
            };
            Some(Route {
                script_rel: "core://seed-protocol".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "compute"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("share"))
                .unwrap_or(false) =>
        {
            let mut args = vec!["compute-proof".to_string(), "--share=1".to_string()];
            args.extend(rest.iter().skip(1).cloned());
            Some(Route {
                script_rel: "core://p2p-gossip-seed".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "skills"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("enable"))
                .unwrap_or(false) =>
        {
            let mode = rest
                .get(1)
                .cloned()
                .unwrap_or_else(|| "perplexity-mode".to_string());
            let mut args = vec!["skills-enable".to_string(), mode];
            args.extend(rest.iter().skip(2).cloned());
            Some(Route {
                script_rel: "core://assimilation-controller".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "skills"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("dashboard"))
                .unwrap_or(false) =>
        {
            let mut args = vec!["dashboard".to_string()];
            args.extend(rest.iter().skip(1).cloned());
            Some(Route {
                script_rel: "core://skills-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "skills"
            if rest
                .first()
                .map(|v| {
                    let s = v.trim().to_ascii_lowercase();
                    s == "spawn" || s == "spawn-subagents"
                })
                .unwrap_or(false) =>
        {
            let mut args = vec!["skills-spawn-subagents".to_string()];
            args.extend(rest.iter().skip(1).cloned());
            Some(Route {
                script_rel: "core://assimilation-controller".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "skills"
            if rest
                .first()
                .map(|v| {
                    let s = v.trim().to_ascii_lowercase();
                    s == "computer-use" || s == "hands"
                })
                .unwrap_or(false) =>
        {
            let mut args = vec!["skills-computer-use".to_string()];
            args.extend(rest.iter().skip(1).cloned());
            Some(Route {
                script_rel: "core://assimilation-controller".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "skills" => {
            let args = if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            };
            Some(Route {
                script_rel: "core://skills-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "skill" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let mut args = match sub.as_str() {
                "create" => vec!["create".to_string()],
                "list" => vec!["list".to_string()],
                "dashboard" => vec!["dashboard".to_string()],
                "activate" => vec!["activate".to_string()],
                "install" => vec!["install".to_string()],
                "run" => vec!["run".to_string()],
                "share" => vec!["share".to_string()],
                "gallery" => vec!["gallery".to_string()],
                "load" => vec!["load".to_string()],
                "react" | "react-minimal" | "react_minimal" => vec!["react-minimal".to_string()],
                "tot" | "tot-deliberate" | "tot_deliberate" => vec!["tot-deliberate".to_string()],
                "chain" | "chain-validate" | "chain_validate" => vec!["chain-validate".to_string()],
                "status" => vec!["status".to_string()],
                _ => {
                    let mut out = vec![sub.clone()];
                    out.extend(rest.iter().skip(1).cloned());
                    out
                }
            };
            if sub == "create" {
                let mut forwarded_name = false;
                for row in rest.iter().skip(1) {
                    if row.starts_with("--name=") {
                        args.push(row.clone());
                        forwarded_name = true;
                    } else if row.starts_with("--task=") {
                        args.push(row.replacen("--task=", "--name=", 1));
                        forwarded_name = true;
                    } else if row.starts_with("--") {
                        args.push(row.clone());
                    }
                }
                if !forwarded_name {
                    let name = rest
                        .iter()
                        .skip(1)
                        .filter(|row| !row.starts_with("--"))
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(" ");
                    if !name.trim().is_empty() {
                        args.push(format!("--name={name}"));
                    }
                }
            } else if sub == "load" {
                if let Some(skill) = rest
                    .iter()
                    .skip(1)
                    .find(|row| !row.starts_with("--"))
                    .cloned()
                {
                    args.push(format!("--skill={skill}"));
                }
                args.extend(
                    rest.iter()
                        .skip(1)
                        .filter(|row| row.starts_with("--"))
                        .cloned(),
                );
            } else if !rest.is_empty() {
                args.extend(rest.iter().skip(1).cloned());
            }
            Some(Route {
                script_rel: "core://skills-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "binary-vuln" | "binvuln" => {
            let args = if rest.is_empty() {
                vec!["status".to_string()]
            } else {
                rest.to_vec()
            };
            Some(Route {
                script_rel: "core://binary-vuln-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "scan"
            if rest
                .first()
                .map(|v| {
                    let s = v.trim().to_ascii_lowercase();
                    s == "binary" || s == "firmware" || s == "uefi" || s == "ba2"
                })
                .unwrap_or(false) =>
        {
            let mut args = vec!["scan".to_string(), "--dx-source=scan-binary".to_string()];
            if let Some(input) = rest.get(1) {
                if !input.starts_with("--") {
                    args.push(format!("--input={input}"));
                }
            }
            args.extend(
                rest.iter()
                    .skip(2)
                    .filter(|row| row.starts_with("--"))
                    .cloned(),
            );
            Some(Route {
                script_rel: "core://binary-vuln-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "browser" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "session-start".to_string());
            let mut args = match sub.as_str() {
                "start" | "open" | "session-start" => vec!["session-start".to_string()],
                "join" => vec!["session-control".to_string(), "--op=join".to_string()],
                "handoff" => vec!["session-control".to_string(), "--op=handoff".to_string()],
                "leave" => vec!["session-control".to_string(), "--op=leave".to_string()],
                "control" | "session-control" => vec!["session-control".to_string()],
                "automate" => vec!["automate".to_string()],
                "privacy" | "privacy-guard" => vec!["privacy-guard".to_string()],
                "snapshot" => vec!["snapshot".to_string()],
                "screenshot" => vec!["screenshot".to_string()],
                "action-policy" => vec!["action-policy".to_string()],
                "auth-save" => vec!["auth-save".to_string()],
                "auth-login" => vec!["auth-login".to_string()],
                "native" => vec!["native".to_string()],
                "status" => vec!["status".to_string()],
                _ => vec!["session-start".to_string()],
            };
            if !rest.is_empty() {
                args.extend(rest.iter().skip(1).cloned());
            }
            Some(Route {
                script_rel: "core://vbrowser-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "hand" | "hands" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let scheduled_mode = matches!(sub.as_str(), "enable" | "scheduled" | "dashboard")
                && (sub != "enable"
                    || rest
                        .get(1)
                        .map(|v| v.trim().eq_ignore_ascii_case("scheduled"))
                        .unwrap_or(false));
            let mut args = match sub.as_str() {
                "enable"
                    if rest
                        .get(1)
                        .map(|v| v.trim().eq_ignore_ascii_case("scheduled"))
                        .unwrap_or(false) =>
                {
                    vec!["scheduled-hands".to_string(), "--op=enable".to_string()]
                }
                "scheduled" => vec!["scheduled-hands".to_string(), "--op=run".to_string()],
                "dashboard" => vec!["scheduled-hands".to_string(), "--op=dashboard".to_string()],
                "new" => vec!["hand-new".to_string()],
                "schedule" | "cycle" | "run" => vec!["hand-cycle".to_string()],
                "status" => vec!["hand-status".to_string()],
                "memory-page" | "memory" => vec!["hand-memory-page".to_string()],
                "wasm-task" | "wasm" => vec!["hand-wasm-task".to_string()],
                _ => vec!["hand-status".to_string()],
            };
            if !rest.is_empty() {
                let skip = if sub == "enable"
                    && rest
                        .get(1)
                        .map(|v| v.trim().eq_ignore_ascii_case("scheduled"))
                        .unwrap_or(false)
                {
                    2
                } else {
                    1
                };
                args.extend(rest.iter().skip(skip).cloned());
            }
            Some(Route {
                script_rel: if scheduled_mode {
                    "core://assimilation-controller".to_string()
                } else {
                    "core://autonomy-controller".to_string()
                },
                args,
                forward_stdin: false,
            })
        }
        "oracle" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "query".to_string());
            let args = match sub.as_str() {
                "query" => {
                    let provider = rest
                        .iter()
                        .find_map(|v| {
                            v.trim()
                                .split_once("--provider=")
                                .map(|(_, p)| p.to_string())
                        })
                        .or_else(|| {
                            rest.iter()
                                .skip(1)
                                .find(|v| !v.trim().starts_with("--"))
                                .cloned()
                        })
                        .unwrap_or_else(|| "polymarket".to_string());
                    let event = rest
                        .iter()
                        .find_map(|v| v.trim().split_once("--event=").map(|(_, e)| e.to_string()))
                        .or_else(|| {
                            rest.iter()
                                .skip(2)
                                .find(|v| !v.trim().starts_with("--"))
                                .cloned()
                        })
                        .unwrap_or_else(|| "default-event".to_string());
                    vec![
                        "oracle-query".to_string(),
                        format!("--provider={provider}"),
                        format!("--event={event}"),
                    ]
                }
                _ => vec!["oracle-query".to_string()],
            };
            Some(Route {
                script_rel: "core://network-protocol".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "truth"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("weight"))
                .unwrap_or(false) =>
        {
            let mut args = vec!["truth-weight".to_string()];
            args.extend(rest.iter().skip(1).cloned());
            Some(Route {
                script_rel: "core://network-protocol".to_string(),
                args,
                forward_stdin: false,
            })
        }
        _ => protheusctl_plane_shortcuts::resolve_plane_shortcuts(cmd, rest),
    }
}
