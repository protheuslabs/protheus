// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{directive_kernel, network_protocol, seed_protocol};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_root(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("protheus_v9_seed_{name}_{nonce}"));
    fs::create_dir_all(&root).expect("mkdir");
    root
}

fn core_state_root(root: &Path) -> PathBuf {
    root.join("core").join("local").join("state")
}

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read json");
    serde_json::from_str(&raw).expect("parse json")
}

fn allow(root: &Path, directive: &str) {
    let exit = directive_kernel::run(
        root,
        &[
            "prime-sign".to_string(),
            format!("--directive={directive}"),
            "--signer=integration".to_string(),
        ],
    );
    assert_eq!(exit, 0, "failed to allow directive: {directive}");
}

#[test]
fn seed_protocol_end_to_end_profiles_and_dashboard_state() {
    let root = temp_root("integration");
    std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "v9-seed-integration-key");

    allow(&root, "allow:seed:deploy:viral");
    allow(&root, "allow:seed:migrate:immortal");
    allow(&root, "allow:seed:select:viral");
    allow(&root, "allow:seed:archive:immortal");
    allow(&root, "allow:seed:defend");
    allow(&root, "allow:tokenomics");

    assert_eq!(
        network_protocol::run(
            &root,
            &[
                "reward".to_string(),
                "--action=reward".to_string(),
                "--agent=node-a".to_string(),
                "--amount=100".to_string(),
                "--reason=seed-selection".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        network_protocol::run(
            &root,
            &[
                "reward".to_string(),
                "--action=reward".to_string(),
                "--agent=node-b".to_string(),
                "--amount=5".to_string(),
                "--reason=seed-selection".to_string(),
            ],
        ),
        0
    );

    assert_eq!(
        seed_protocol::run(
            &root,
            &[
                "deploy".to_string(),
                "--profile=viral".to_string(),
                "--targets=node-a,node-b".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        seed_protocol::run(
            &root,
            &[
                "migrate".to_string(),
                "--profile=immortal".to_string(),
                "--node=node-a".to_string(),
                "--energy=0.20".to_string(),
                "--threat=high".to_string(),
                "--hardware=edge".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        seed_protocol::run(
            &root,
            &[
                "enforce".to_string(),
                "--profile=viral".to_string(),
                "--operation=replicate".to_string(),
                "--node=rogue-1".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        2
    );
    assert_eq!(
        seed_protocol::run(
            &root,
            &[
                "select".to_string(),
                "--profile=viral".to_string(),
                "--top=1".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        seed_protocol::run(
            &root,
            &[
                "archive".to_string(),
                "--profile=immortal".to_string(),
                "--lineage-id=lineage-intg".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        seed_protocol::run(
            &root,
            &[
                "defend".to_string(),
                "--profile=immortal".to_string(),
                "--node=rogue-1".to_string(),
                "--signal=tamper".to_string(),
                "--severity=critical".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(seed_protocol::run(&root, &["status".to_string()]), 0);

    let state_path = core_state_root(&root)
        .join("ops")
        .join("seed_protocol")
        .join("seed_state.json");
    assert!(state_path.exists());
    let state = read_json(&state_path);
    assert!(
        state
            .get("packet_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            >= 1
    );
    assert!(
        state
            .get("migration_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            >= 1
    );
    assert!(
        state
            .get("selection_rounds")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            >= 1
    );
    assert!(
        state
            .get("archive_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            >= 1
    );
    assert!(
        state
            .get("defense_event_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            >= 1
    );
    assert!(state
        .get("archive_merkle_root")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false));
    assert!(state
        .get("quarantine")
        .and_then(Value::as_object)
        .map(|q| q.contains_key("rogue-1"))
        .unwrap_or(false));

    let packets_dir = core_state_root(&root)
        .join("ops")
        .join("seed_protocol")
        .join("packets");
    let packet_count = fs::read_dir(&packets_dir)
        .expect("packets dir")
        .flatten()
        .filter(|entry| entry.path().extension().and_then(|v| v.to_str()) == Some("json"))
        .count();
    assert!(packet_count >= 1);

    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    let _ = fs::remove_dir_all(root);
}
