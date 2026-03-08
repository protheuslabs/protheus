use protheus_swarm_router::{
    apply_rollback, apply_upgrade, auto_id, build_metrics, build_receipt, plan_scaling,
    recovery_decision, status_payload, InFlightTracker, QueueArtifact, RecoveryPolicy, ScalingPolicy,
    SwarmEnvelope, UpgradePolicy,
};
use serde_json::{json, Value};
use std::env;
use std::path::PathBuf;

fn parse_flag(args: &[String], name: &str, default: Option<&str>) -> String {
    let prefix = format!("--{}=", name);
    args.iter()
        .find_map(|arg| arg.strip_prefix(&prefix).map(|v| v.to_string()))
        .or_else(|| default.map(|v| v.to_string()))
        .unwrap_or_default()
}

fn parse_u8(args: &[String], name: &str, default: u8) -> u8 {
    parse_flag(args, name, Some(&default.to_string()))
        .parse::<u8>()
        .unwrap_or(default)
}

fn parse_u32(args: &[String], name: &str, default: u32) -> u32 {
    parse_flag(args, name, Some(&default.to_string()))
        .parse::<u32>()
        .unwrap_or(default)
}

fn parse_usize(args: &[String], name: &str, default: usize) -> usize {
    parse_flag(args, name, Some(&default.to_string()))
        .parse::<usize>()
        .unwrap_or(default)
}

fn parse_bool(args: &[String], name: &str, default: bool) -> bool {
    parse_flag(args, name, Some(if default { "1" } else { "0" })) == "1"
}

fn queue_path(args: &[String]) -> PathBuf {
    let raw = parse_flag(args, "queue", Some("client/local/state/swarm/queue.json"));
    PathBuf::from(raw)
}

fn emit(payload: Value, ok: bool) {
    println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string()));
    if !ok {
        std::process::exit(1);
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("status");

    match cmd {
        "status" => {
            let queue = QueueArtifact::load(queue_path(&args)).unwrap_or_default();
            let tracker = InFlightTracker::default();
            let metrics = build_metrics(0, 0, 0, 0, queue.items.len());
            emit(status_payload(&queue, &tracker, Some(metrics)), true);
        }
        "enqueue" => {
            let mut queue = QueueArtifact::load(queue_path(&args)).unwrap_or_default();
            let route = parse_flag(&args, "route", Some("swarm/default"));
            let role = parse_flag(&args, "role", Some("coordinator"));
            let priority = parse_u8(&args, "priority", 5);
            let payload_raw = parse_flag(&args, "payload-json", Some("{}"));
            let payload: Value = serde_json::from_str(&payload_raw).unwrap_or_else(|_| json!({ "raw": payload_raw }));
            let env = SwarmEnvelope::new_auto(&role, &route, payload, priority);
            match queue.push(env.clone()) {
                Ok(()) => {
                    let _ = queue.save(queue_path(&args));
                    let receipt = build_receipt(
                        "enqueue",
                        Some(&env),
                        json!({"queue_depth": queue.items.len()}),
                        Some(build_metrics(
                            queue.items.len() as u64,
                            0,
                            0,
                            0,
                            queue.items.len(),
                        )),
                    );
                    emit(json!({"ok": true, "type": "swarm_router_enqueue", "receipt": receipt}), true);
                }
                Err(err) => emit(json!({"ok": false, "error": err}), false),
            }
        }
        "recover" => {
            let route = parse_flag(&args, "route", Some("swarm/default"));
            let attempts = parse_u32(&args, "attempts", 0);
            let env = SwarmEnvelope::new_auto("worker", &route, json!({}), 5);
            let policy = RecoveryPolicy {
                max_retries: parse_u32(&args, "max-retries", 2),
                fixer_route: parse_flag(&args, "fixer-route", Some("swarm/fixer")),
            };
            let decision = recovery_decision(&env, attempts, &policy);
            emit(json!({"ok": true, "type": "swarm_router_recover", "decision": decision}), true);
        }
        "scale" => {
            let policy = ScalingPolicy {
                min_workers: parse_usize(&args, "min-workers", 1),
                max_workers: parse_usize(&args, "max-workers", 32),
                target_queue_per_worker: parse_usize(&args, "target-queue-per-worker", 4),
                scale_step: parse_usize(&args, "scale-step", 1),
            };
            let decision = plan_scaling(
                parse_usize(&args, "queue-depth", 0),
                parse_usize(&args, "workers", 1),
                &policy,
            );
            emit(json!({"ok": true, "type": "swarm_router_scale", "decision": decision}), true);
        }
        "upgrade" => {
            let policy = UpgradePolicy {
                allow_upgrade: parse_bool(&args, "allow-upgrade", true),
                allow_rollback: parse_bool(&args, "allow-rollback", true),
            };
            let receipt = apply_upgrade(
                &parse_flag(&args, "from", Some("1.0.0")),
                &parse_flag(&args, "to", Some("1.1.0")),
                &policy,
            );
            emit(json!({"ok": receipt.ok, "type": "swarm_router_upgrade", "receipt": receipt}), receipt.ok);
        }
        "rollback" => {
            let policy = UpgradePolicy {
                allow_upgrade: parse_bool(&args, "allow-upgrade", true),
                allow_rollback: parse_bool(&args, "allow-rollback", true),
            };
            let receipt = apply_rollback(
                &parse_flag(&args, "from", Some("1.1.0")),
                &parse_flag(&args, "to", Some("1.0.0")),
                &policy,
            );
            emit(json!({"ok": receipt.ok, "type": "swarm_router_rollback", "receipt": receipt}), receipt.ok);
        }
        "id" => {
            let prefix = parse_flag(&args, "role", Some("swarm"));
            emit(json!({"ok": true, "id": auto_id(&prefix)}), true);
        }
        _ => emit(
            json!({
                "ok": false,
                "error": "unknown_command",
                "supported": ["status", "enqueue", "recover", "scale", "upgrade", "rollback", "id"]
            }),
            false,
        ),
    }
}
