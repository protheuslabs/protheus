use super::Route;

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
        "eval" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "benchmark-neuralavb".to_string());
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
                "benchmark" => std::iter::once("benchmark-neuralavb".to_string())
                    .chain(rest.iter().skip(1).cloned())
                    .collect::<Vec<_>>(),
                _ => {
                    if rest.is_empty() {
                        vec!["benchmark-neuralavb".to_string()]
                    } else {
                        rest.to_vec()
                    }
                }
            };
            Some(Route {
                script_rel: "core://ab-lane-eval".to_string(),
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
                script_rel: "core://ab-lane-eval".to_string(),
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
            if matches!(
                sub.as_str(),
                "status"
                    | "stake"
                    | "reward"
                    | "slash"
                    | "merkle-root"
                    | "emission"
                    | "zk-claim"
                    | "dashboard"
            ) {
                let args = if sub == "dashboard" {
                    vec!["status".to_string()]
                } else if rest.is_empty() {
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
                .map(|v| v.trim().eq_ignore_ascii_case("join"))
                .unwrap_or(false)
                && rest
                    .get(1)
                    .map(|v| v.trim().eq_ignore_ascii_case("hyperspace"))
                    .unwrap_or(false)
            {
                let mut args = vec![
                    "discover".to_string(),
                    "--profile=hyperspace".to_string(),
                    "--apply=1".to_string(),
                ];
                args.extend(rest.iter().skip(2).cloned());
                args
            } else if rest
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
            let mut args = vec!["scan".to_string()];
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
        "agency" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let mut args = match sub.as_str() {
                "create" | "create-shadow" => vec!["create-shadow".to_string()],
                "topology" | "division-topology" => vec!["topology".to_string()],
                "orchestrate" => vec!["orchestrate".to_string()],
                "workflow" | "workflow-bind" => vec!["workflow-bind".to_string()],
                "status" => vec!["status".to_string()],
                _ => vec![sub],
            };
            if !rest.is_empty() {
                args.extend(rest.iter().skip(1).cloned());
            }
            Some(Route {
                script_rel: "core://agency-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "team" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "dashboard".to_string());
            let mut args = match sub.as_str() {
                "dashboard" => vec!["dashboard".to_string()],
                "launch" | "launch-role" => vec!["launch-role".to_string()],
                "schedule" => vec!["schedule".to_string()],
                "continuity" => vec!["continuity".to_string()],
                "status" => vec!["status".to_string()],
                _ => vec![sub],
            };
            if !rest.is_empty() {
                args.extend(rest.iter().skip(1).cloned());
            }
            Some(Route {
                script_rel: "core://collab-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "company" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let mut args = match sub.as_str() {
                "orchestrate" | "orchestrate-agency" => vec!["orchestrate-agency".to_string()],
                "budget" | "budget-enforce" => vec!["budget-enforce".to_string()],
                "ticket" => vec!["ticket".to_string()],
                "heartbeat" => vec!["heartbeat".to_string()],
                "status" => vec!["status".to_string()],
                _ => vec![sub],
            };
            if !rest.is_empty() {
                args.extend(rest.iter().skip(1).cloned());
            }
            Some(Route {
                script_rel: "core://company-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "ticket" => {
            let mut args = vec!["ticket".to_string()];
            args.extend(rest.iter().cloned());
            Some(Route {
                script_rel: "core://company-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "heartbeat" => {
            let mut args = vec!["heartbeat".to_string()];
            args.extend(rest.iter().cloned());
            Some(Route {
                script_rel: "core://company-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "substrate" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let enable_biological = sub == "enable"
                && rest
                    .get(1)
                    .map(|v| v.trim().eq_ignore_ascii_case("biological"))
                    .unwrap_or(false);
            let mut args = match sub.as_str() {
                "capture" | "csi-capture" => vec!["csi-capture".to_string()],
                "module" | "csi-module" => vec!["csi-module".to_string()],
                "embedded" | "csi-embedded-profile" => vec!["csi-embedded-profile".to_string()],
                "policy" | "csi-policy" => vec!["csi-policy".to_string()],
                "eye" | "eye-bind" => vec!["eye-bind".to_string()],
                "bio-interface" => vec!["bio-interface".to_string()],
                "bio-feedback" => vec!["bio-feedback".to_string()],
                "bio-adapter-template" => vec!["bio-adapter-template".to_string()],
                "bioethics" | "bioethics-policy" => vec!["bioethics-policy".to_string()],
                "enable" if enable_biological => {
                    vec!["bio-enable".to_string(), "--mode=biological".to_string()]
                }
                "bio-enable" => vec!["bio-enable".to_string()],
                "status" => vec!["status".to_string()],
                _ => vec![sub.clone()],
            };
            if !rest.is_empty() {
                if enable_biological {
                    args.extend(rest.iter().skip(2).cloned());
                } else {
                    args.extend(rest.iter().skip(1).cloned());
                }
            }
            Some(Route {
                script_rel: "core://substrate-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "observability" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let mut args = match sub.as_str() {
                "monitor" => vec!["monitor".to_string()],
                "workflow" => vec!["workflow".to_string()],
                "incident" => vec!["incident".to_string()],
                "selfhost" | "deploy" => vec!["selfhost".to_string(), "--op=deploy".to_string()],
                "status" => vec!["status".to_string()],
                _ => vec![sub],
            };
            if !rest.is_empty() {
                args.extend(rest.iter().skip(1).cloned());
            }
            Some(Route {
                script_rel: "core://observability-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "persist" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let mut args = match sub.as_str() {
                "schedule" => vec!["schedule".to_string()],
                "mobile" | "mobile-cockpit" => vec!["mobile-cockpit".to_string()],
                "continuity" => vec!["continuity".to_string()],
                "connector" => vec!["connector".to_string()],
                "cowork" | "co-work" => vec!["cowork".to_string()],
                "status" => vec!["status".to_string()],
                _ => vec![sub],
            };
            if !rest.is_empty() {
                args.extend(rest.iter().skip(1).cloned());
            }
            Some(Route {
                script_rel: "core://persist-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "connector" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "list".to_string());
            let mut args = vec!["connector".to_string(), format!("--op={sub}")];
            if let Some(provider) = rest.get(1) {
                if !provider.starts_with("--") {
                    args.push(format!(
                        "--provider={}",
                        provider.trim().to_ascii_lowercase()
                    ));
                    args.extend(rest.iter().skip(2).cloned());
                } else {
                    args.extend(rest.iter().skip(1).cloned());
                }
            } else {
                args.extend(rest.iter().skip(1).cloned());
            }
            Some(Route {
                script_rel: "core://persist-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "cowork" | "co-work" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "list".to_string());
            let mut args = vec!["cowork".to_string(), format!("--op={sub}")];
            args.extend(rest.iter().skip(1).cloned());
            Some(Route {
                script_rel: "core://persist-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "app" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let normalized_sub = match sub.as_str() {
                "run" | "status" | "history" | "replay" | "switch-provider" => sub.as_str(),
                _ => "run",
            };
            let app_name = if sub == normalized_sub {
                rest.get(1)
                    .map(|v| v.trim())
                    .filter(|v| !v.is_empty() && !v.starts_with("--"))
                    .unwrap_or("chat-starter")
                    .to_string()
            } else {
                sub.clone()
            };
            let app = app_name.replace('_', "-").to_ascii_lowercase();
            let mut args = vec![normalized_sub.to_string(), format!("--app={}", app.trim())];
            let mut plain = Vec::<String>::new();
            let start_idx = if sub == normalized_sub {
                2usize
            } else {
                1usize
            };
            for token in rest.iter().skip(start_idx) {
                if token.starts_with("--") {
                    args.push(token.clone());
                } else {
                    plain.push(token.clone());
                }
            }
            if !plain.is_empty() {
                let joined = plain.join(" ");
                if app == "code-engineer" {
                    args.push(format!("--prompt={joined}"));
                } else {
                    args.push(format!("--message={joined}"));
                }
            }
            Some(Route {
                script_rel: "core://app-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "chat-starter" | "chat_starter" => {
            let mut args = vec!["run".to_string(), "--app=chat-starter".to_string()];
            if !rest.is_empty() {
                args.extend(rest.iter().cloned());
            }
            Some(Route {
                script_rel: "core://app-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "chat-ui" | "chat_ui" => {
            let mut args = vec!["run".to_string(), "--app=chat-ui".to_string()];
            if !rest.is_empty() {
                args.extend(rest.iter().cloned());
            }
            Some(Route {
                script_rel: "core://app-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "code-engineer" | "code_engineer" => {
            let mut args = vec!["run".to_string(), "--app=code-engineer".to_string()];
            if !rest.is_empty() {
                args.push(format!("--prompt={}", rest.join(" ")));
            }
            Some(Route {
                script_rel: "core://app-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "schedule" => {
            let mut args = vec!["schedule".to_string()];
            args.extend(rest.iter().cloned());
            Some(Route {
                script_rel: "core://persist-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "mobile" => {
            let mut args = vec!["mobile-cockpit".to_string()];
            args.extend(rest.iter().cloned());
            Some(Route {
                script_rel: "core://persist-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "eye" => {
            let sub = rest
                .first()
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            let mut args = match sub.as_str() {
                "enable" => vec!["eye-bind".to_string(), "--op=enable".to_string()],
                "status" => vec!["eye-bind".to_string(), "--op=status".to_string()],
                _ => vec!["eye-bind".to_string(), format!("--op={sub}")],
            };
            if let Some(source) = rest.get(1) {
                if !source.starts_with("--") {
                    args.push(format!("--source={}", source.trim()));
                    args.extend(rest.iter().skip(2).cloned());
                } else {
                    args.extend(rest.iter().skip(1).cloned());
                }
            } else {
                args.push("--source=wifi".to_string());
            }
            Some(Route {
                script_rel: "core://substrate-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "orchestrate"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("agency"))
                .unwrap_or(false) =>
        {
            let mut args = vec!["orchestrate-agency".to_string()];
            if let Some(team) = rest.get(1) {
                if !team.starts_with("--") {
                    args.push(format!("--team={}", team.trim()));
                    args.extend(rest.iter().skip(2).cloned());
                } else {
                    args.extend(rest.iter().skip(1).cloned());
                }
            } else {
                args.extend(rest.iter().skip(1).cloned());
            }
            Some(Route {
                script_rel: "core://company-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "shadow"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("browser"))
                .unwrap_or(false)
                || rest
                    .first()
                    .map(|v| v.trim().eq_ignore_ascii_case("--browser"))
                    .unwrap_or(false) =>
        {
            let mut args = vec![
                "session-start".to_string(),
                "--shadow=default-shadow".to_string(),
            ];
            args.extend(rest.iter().skip(1).cloned());
            Some(Route {
                script_rel: "core://vbrowser-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "shadow"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("delegate"))
                .unwrap_or(false) =>
        {
            let mut args = vec!["delegate".to_string()];
            args.extend(rest.iter().skip(1).cloned());
            Some(Route {
                script_rel: "core://hermes-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "shadow"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("continuity"))
                .unwrap_or(false) =>
        {
            let mut args = vec!["continuity".to_string()];
            args.extend(rest.iter().skip(1).cloned());
            Some(Route {
                script_rel: "core://hermes-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "shadow"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("create"))
                .unwrap_or(false)
                && rest.iter().any(|v| v.trim().starts_with("--template=")) =>
        {
            let mut args = vec!["create-shadow".to_string()];
            args.extend(rest.iter().skip(1).cloned());
            Some(Route {
                script_rel: "core://agency-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "shadow"
            if rest
                .first()
                .map(|v| v.trim().eq_ignore_ascii_case("discover"))
                .unwrap_or(false) =>
        {
            let mut args = vec!["discover".to_string()];
            args.extend(rest.iter().skip(1).cloned());
            Some(Route {
                script_rel: "core://hermes-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "top" | "protheus-top" => {
            let mut args = vec!["cockpit".to_string()];
            args.extend(rest.iter().cloned());
            Some(Route {
                script_rel: "core://hermes-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        "status"
            if rest
                .iter()
                .any(|arg| arg.trim() == "dashboard" || arg.trim() == "--dashboard") =>
        {
            let mut args = vec!["cockpit".to_string()];
            args.extend(
                rest.iter()
                    .filter(|arg| arg.trim() != "dashboard" && arg.trim() != "--dashboard")
                    .cloned(),
            );
            Some(Route {
                script_rel: "core://hermes-plane".to_string(),
                args,
                forward_stdin: false,
            })
        }
        _ => None,
    }
}
