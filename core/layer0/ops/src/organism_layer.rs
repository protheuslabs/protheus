// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use crate::directive_kernel;
use crate::rsi_ignition;
use crate::v8_kernel::{
    append_jsonl, keyed_digest_hex, parse_bool, parse_f64, print_json, read_json,
    scoped_state_root, sha256_hex_str, write_json, write_receipt,
};
use crate::{clean, now_iso, parse_args};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "ORGANISM_LAYER_STATE_ROOT";
const STATE_SCOPE: &str = "organism_layer";
const CRYSTAL_SIGNING_ENV: &str = "ORGANISM_CRYSTAL_SIGNING_KEY";
#[path = "organism_layer_phase1.rs"]
mod organism_layer_phase1;
#[path = "organism_layer_phase2.rs"]
mod organism_layer_phase2;

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn organism_state_path(root: &Path) -> PathBuf {
    state_root(root).join("organism_state.json")
}

fn dream_log_path(root: &Path) -> PathBuf {
    state_root(root).join("dream_log.jsonl")
}

fn narrative_log_path(root: &Path) -> PathBuf {
    state_root(root).join("narrative_log.jsonl")
}

fn personality_history_path(root: &Path) -> PathBuf {
    state_root(root).join("personality_history.jsonl")
}

fn default_state() -> Value {
    json!({
        "version": "1.0",
        "active": false,
        "dream_count": 0,
        "narrative_count": 0,
        "vitals": {
            "coherence": 0.75,
            "metabolism": 0.50,
            "heartbeat": 75
        },
        "personality": {
            "version": 0,
            "persona": "default",
            "delta": "",
            "signature": "unsigned",
            "updated_at": now_iso()
        },
        "symbiosis": {
            "nodes": 0,
            "memory_share_rate": 0.0,
            "coherence_score": 0.0
        },
        "sensory": {
            "pain": 0.0,
            "pleasure": 0.0,
            "adjustment": "maintain"
        },
        "created_at": now_iso()
    })
}

fn load_state(root: &Path) -> Value {
    read_json(&organism_state_path(root)).unwrap_or_else(default_state)
}

fn store_state(root: &Path, state: &Value) -> Result<(), String> {
    write_json(&organism_state_path(root), state)
}

fn state_obj_mut(state: &mut Value) -> &mut Map<String, Value> {
    if !state.is_object() {
        *state = default_state();
    }
    state.as_object_mut().expect("state_object")
}

fn emit(root: &Path, payload: Value) -> i32 {
    match write_receipt(root, STATE_ENV, STATE_SCOPE, payload) {
        Ok(out) => {
            print_json(&out);
            if out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                0
            } else {
                2
            }
        }
        Err(err) => {
            let mut out = json!({
                "ok": false,
                "type": "organism_layer_error",
                "lane": "core/layer0/ops",
                "error": clean(err, 220),
                "exit_code": 2
            });
            out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
            print_json(&out);
            2
        }
    }
}

fn gate(root: &Path, action: &str) -> bool {
    directive_kernel::action_allowed(root, action)
}

fn rsi_state_path(root: &Path) -> PathBuf {
    crate::core_state_root(root)
        .join("ops")
        .join("rsi_ignition")
        .join("loop_state.json")
}

fn network_ledger_path(root: &Path) -> PathBuf {
    crate::core_state_root(root)
        .join("ops")
        .join("network_protocol")
        .join("ledger.json")
}

fn count_jsonl_rows(path: &Path) -> usize {
    fs::read_to_string(path)
        .ok()
        .map(|raw| raw.lines().filter(|line| !line.trim().is_empty()).count())
        .unwrap_or(0)
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let command = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        println!("Usage:");
        println!("  protheus-ops organism-layer status");
        println!("  protheus-ops organism-layer ignite [--apply=1|0]");
        println!("  protheus-ops organism-layer dream [--idle-hours=<n>] [--experiments=<n>] [--apply=1|0]");
        println!("  protheus-ops organism-layer homeostasis [--coherence=<0..1>] [--metabolism=<0..1>] [--apply=1|0]");
        println!("  protheus-ops organism-layer crystallize [--persona=<id>] [--delta=<text>] [--apply=1|0]");
        println!("  protheus-ops organism-layer symbiosis [--nodes=<n>] [--memory-share=<0..1>] [--apply=1|0]");
        println!("  protheus-ops organism-layer mutate [--proposal=<text>] [--module=<id>] [--apply=1|0]");
        println!("  protheus-ops organism-layer sensory [--pain=<0..1>] [--pleasure=<0..1>] [--apply=1|0]");
        println!("  protheus-ops organism-layer narrative [--summary=<text>] [--coherence=<0..1>] [--apply=1|0]");
        return 0;
    }

    match command.as_str() {
        "status" => organism_layer_phase1::command_status(root),
        "ignite" => organism_layer_phase1::command_ignite(root, &parsed),
        "dream" => organism_layer_phase1::command_dream(root, &parsed),
        "homeostasis" => organism_layer_phase1::command_homeostasis(root, &parsed),
        "crystallize" => organism_layer_phase2::command_crystallize(root, &parsed),
        "symbiosis" => organism_layer_phase2::command_symbiosis(root, &parsed),
        "mutate" => organism_layer_phase2::command_mutate(root, &parsed),
        "sensory" => organism_layer_phase2::command_sensory(root, &parsed),
        "narrative" => organism_layer_phase2::command_narrative(root, &parsed),
        _ => emit(
            root,
            json!({
                "ok": false,
                "type": "organism_layer_error",
                "lane": "core/layer0/ops",
                "error": "unknown_command",
                "command": command,
                "exit_code": 2
            }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("protheus_organism_layer_{name}_{nonce}"));
        fs::create_dir_all(&root).expect("mkdir");
        root
    }

    fn allow(root: &Path, directive: &str) {
        std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "test-sign-key");
        assert_eq!(
            crate::directive_kernel::run(
                root,
                &[
                    "prime-sign".to_string(),
                    format!("--directive={directive}"),
                    "--signer=tester".to_string(),
                ]
            ),
            0
        );
    }

    #[test]
    fn dream_writes_log_when_allowed() {
        let root = temp_root("dream");
        allow(&root, "allow:organism:dream");
        let exit = run(
            &root,
            &[
                "dream".to_string(),
                "--idle-hours=7".to_string(),
                "--experiments=4".to_string(),
                "--apply=1".to_string(),
            ],
        );
        assert_eq!(exit, 0);
        assert!(dream_log_path(&root).exists());
        std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ignite_materializes_full_view_when_allowed() {
        let root = temp_root("ignite_full");
        allow(&root, "allow:organism:ignite");
        let exit = run(
            &root,
            &[
                "ignite".to_string(),
                "--apply=1".to_string(),
                "--idle-hours=7".to_string(),
                "--experiments=4".to_string(),
                "--persona=operator".to_string(),
            ],
        );
        assert_eq!(exit, 0);
        let latest = read_json(&latest_path(&root)).expect("latest");
        assert_eq!(
            latest
                .get("activated_components")
                .and_then(|v| v.get("dream"))
                .and_then(Value::as_bool),
            Some(true)
        );
        assert!(dream_log_path(&root).exists());
        assert!(narrative_log_path(&root).exists());
        assert!(personality_history_path(&root).exists());
        std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn mutate_routes_into_rsi_pipeline_when_allowed() {
        let root = temp_root("mutate");
        allow(&root, "allow:organism:mutate");
        allow(&root, "allow:rsi:ignite");
        allow(&root, "allow:blob:mutate");
        allow(&root, "allow:blob_mutate");
        let exit = run(
            &root,
            &[
                "mutate".to_string(),
                "--proposal=safer plan".to_string(),
                "--module=conduit".to_string(),
                "--apply=1".to_string(),
            ],
        );
        assert_eq!(exit, 0);
        let latest = read_json(&latest_path(&root)).expect("latest");
        assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(true));
        std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn narrative_fails_closed_without_gate() {
        let root = temp_root("narrative_gate");
        let exit = run(
            &root,
            &[
                "narrative".to_string(),
                "--summary=test".to_string(),
                "--apply=1".to_string(),
            ],
        );
        assert_eq!(exit, 2);
        let _ = fs::remove_dir_all(root);
    }
}
