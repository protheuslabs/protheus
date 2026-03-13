// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::metakernel;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;
use walkdir::WalkDir;

fn workspace_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .ancestors()
        .nth(3)
        .expect("workspace ancestor")
        .to_path_buf()
}

fn copy_tree(src: &Path, dst: &Path) {
    for entry in WalkDir::new(src).into_iter().filter_map(Result::ok) {
        let rel = entry.path().strip_prefix(src).expect("strip prefix");
        let out = dst.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&out).expect("mkdir");
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).expect("mkdir parent");
        }
        fs::copy(entry.path(), &out).expect("copy file");
    }
}

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("mkdir");
    }
    let mut body = serde_json::to_string_pretty(value).expect("encode");
    body.push('\n');
    fs::write(path, body).expect("write");
}

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read");
    serde_json::from_str(&raw).expect("parse")
}

fn latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("metakernel")
        .join("latest.json")
}

fn stage_metakernel_fixture_root() -> TempDir {
    let workspace = workspace_root();
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();

    copy_tree(
        &workspace.join("planes").join("contracts"),
        &root.join("planes").join("contracts"),
    );
    copy_tree(
        &workspace.join("client").join("runtime").join("config"),
        &root.join("client").join("runtime").join("config"),
    );
    let tla_src = workspace
        .join("planes")
        .join("spec")
        .join("tla")
        .join("three_plane_boundary.tla");
    let tla_dst = root
        .join("planes")
        .join("spec")
        .join("tla")
        .join("three_plane_boundary.tla");
    if let Some(parent) = tla_dst.parent() {
        fs::create_dir_all(parent).expect("mkdir tla");
    }
    fs::copy(tla_src, tla_dst).expect("copy tla");

    tmp
}

#[test]
fn v7_meta_001_to_010_strict_lanes_execute_with_receipts() {
    let fixture = stage_metakernel_fixture_root();
    let root = fixture.path();

    let lanes: Vec<(&str, Vec<String>)> = vec![
        (
            "registry",
            vec!["registry".to_string(), "--strict=1".to_string()],
        ),
        (
            "invariants",
            vec!["invariants".to_string(), "--strict=1".to_string()],
        ),
        (
            "manifest",
            vec![
                "manifest".to_string(),
                "--manifest=planes/contracts/examples/cellbundle.minimal.json".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        (
            "worlds",
            vec![
                "worlds".to_string(),
                "--manifest=planes/contracts/examples/cellbundle.minimal.json".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        (
            "capability-taxonomy",
            vec![
                "capability-taxonomy".to_string(),
                "--manifest=planes/contracts/examples/cellbundle.minimal.json".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        (
            "budget-admission",
            vec![
                "budget-admission".to_string(),
                "--manifest=planes/contracts/examples/cellbundle.minimal.json".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        (
            "epistemic-object",
            vec![
                "epistemic-object".to_string(),
                "--manifest=planes/contracts/examples/epistemic_object.minimal.json".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        (
            "effect-journal",
            vec![
                "effect-journal".to_string(),
                "--manifest=planes/contracts/examples/effect_journal.minimal.json".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        (
            "substrate-registry",
            vec!["substrate-registry".to_string(), "--strict=1".to_string()],
        ),
        (
            "radix-guard",
            vec!["radix-guard".to_string(), "--strict=1".to_string()],
        ),
    ];

    for (lane, argv) in lanes {
        let exit = metakernel::run(root, &argv);
        assert_eq!(exit, 0, "lane should pass in strict mode: {lane}");
        let latest = read_json(&latest_path(root));
        assert_eq!(
            latest.get("command").and_then(Value::as_str),
            Some(lane),
            "latest receipt command should match lane {lane}"
        );
        assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(true));
        assert!(
            latest
                .get("receipt_hash")
                .and_then(Value::as_str)
                .map(|v| v.len() > 12)
                .unwrap_or(false),
            "lane {lane} must emit deterministic receipt hash"
        );
    }
}

#[test]
fn v7_meta_registry_fails_closed_when_unknown_primitive_is_used() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();

    write_json(
        &root
            .join("planes")
            .join("contracts")
            .join("metakernel_primitives_v1.json"),
        &json!({
            "version": "v1",
            "kind": "metakernel_primitives_registry",
            "primitives": [
                {"id":"node","description":"node primitive"},
                {"id":"cell","description":"cell primitive"},
                {"id":"task","description":"task primitive"},
                {"id":"capability","description":"capability primitive"},
                {"id":"object","description":"object primitive"},
                {"id":"stream","description":"stream primitive"},
                {"id":"journal","description":"journal primitive"},
                {"id":"budget","description":"budget primitive"},
                {"id":"policy","description":"policy primitive"},
                {"id":"model","description":"model primitive"},
                {"id":"supervisor","description":"supervisor primitive"},
                {"id":"attestation","description":"attestation primitive"}
            ]
        }),
    );
    write_json(
        &root
            .join("client")
            .join("runtime")
            .join("config")
            .join("unknown_usage.json"),
        &json!({
            "policy": {
                "primitive": "alien_primitive"
            }
        }),
    );

    let exit = metakernel::run(root, &["registry".to_string(), "--strict=1".to_string()]);
    assert_eq!(exit, 1);

    let latest = read_json(&latest_path(root));
    assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(false));
    assert_eq!(
        latest.get("command").and_then(Value::as_str),
        Some("registry")
    );
    let payload = latest.get("payload").cloned().unwrap_or(Value::Null);
    assert_eq!(
        payload
            .get("unknown_primitive_usage_count")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        1
    );
}

#[test]
fn v7_meta_011_to_015_strict_lanes_execute_with_receipts() {
    let fixture = stage_metakernel_fixture_root();
    let root = fixture.path();

    let lanes: Vec<(&str, Vec<String>)> = vec![
        (
            "quantum-broker",
            vec!["quantum-broker".to_string(), "--strict=1".to_string()],
        ),
        (
            "neural-consent",
            vec!["neural-consent".to_string(), "--strict=1".to_string()],
        ),
        (
            "attestation-graph",
            vec!["attestation-graph".to_string(), "--strict=1".to_string()],
        ),
        (
            "degradation-contracts",
            vec![
                "degradation-contracts".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        (
            "execution-profiles",
            vec!["execution-profiles".to_string(), "--strict=1".to_string()],
        ),
    ];

    for (lane, argv) in lanes {
        let exit = metakernel::run(root, &argv);
        assert_eq!(exit, 0, "lane should pass in strict mode: {lane}");
        let latest = read_json(&latest_path(root));
        assert_eq!(
            latest.get("command").and_then(Value::as_str),
            Some(lane),
            "latest receipt command should match lane {lane}"
        );
        assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(true));
        assert!(
            latest
                .get("receipt_hash")
                .and_then(Value::as_str)
                .map(|v| v.len() > 12)
                .unwrap_or(false),
            "lane {lane} must emit deterministic receipt hash"
        );
    }
}

#[test]
fn v7_meta_011_to_015_fail_closed_on_contract_breaks() {
    let cases: Vec<(&str, &str, Value)> = vec![
        (
            "quantum-broker",
            "planes/contracts/quantum_broker_domain_v1.json",
            json!({
                "version": "v1",
                "kind": "quantum_broker_domain",
                "operations": ["compile", "estimate", "submit", "session", "batch", "teleport"],
                "classical_fallback": { "enabled": true, "receipt_required": true }
            }),
        ),
        (
            "neural-consent",
            "planes/contracts/neural_consent_kernel_v1.json",
            json!({
                "version": "v1",
                "kind": "neural_consent_kernel",
                "authorities": ["observe", "infer", "feedback", "stimulate"],
                "stimulate_policy": {
                    "consent_token_required": true,
                    "dual_control_required": false,
                    "immutable_audit": true,
                    "rate_limit_per_minute": 5
                }
            }),
        ),
        (
            "attestation-graph",
            "planes/contracts/attestation_graph_v1.json",
            json!({
                "version": "v1",
                "kind": "attestation_graph",
                "edges": [
                    { "from": "code:core/layer0/ops", "to": "policy:manifest" },
                    { "from": "policy:manifest", "to": "effect:dispatch" }
                ]
            }),
        ),
        (
            "degradation-contracts",
            "planes/contracts/degradation_contracts_v1.json",
            json!({
                "version": "v1",
                "kind": "degradation_contracts",
                "critical_lanes": [
                    { "id": "conduit_dispatch", "fallback": "local_receipt_queue", "fallback_widens_privilege": false },
                    { "id": "model_router", "fallback": "safe_local_model", "fallback_widens_privilege": false }
                ],
                "scenarios": {
                    "no-network": ["conduit_dispatch", "model_router"],
                    "no-ternary": [],
                    "no-qpu": ["model_router"],
                    "neural-link-loss": ["conduit_dispatch"]
                }
            }),
        ),
        (
            "execution-profiles",
            "planes/contracts/execution_profile_matrix_v1.json",
            json!({
                "version": "v1",
                "kind": "execution_profile_matrix",
                "profiles": [
                    { "id": "mcu", "harness": "harness/mcu_conformance", "determinism": "high" },
                    { "id": "edge", "harness": "harness/edge_conformance", "determinism": "high" },
                    { "id": "cloud", "harness": "bad", "determinism": "medium" }
                ]
            }),
        ),
    ];

    for (lane, contract_rel, mutated_contract) in cases {
        let fixture = stage_metakernel_fixture_root();
        let root = fixture.path();
        write_json(&root.join(contract_rel), &mutated_contract);

        let exit = metakernel::run(root, &[lane.to_string(), "--strict=1".to_string()]);
        assert_eq!(exit, 1, "lane should fail-closed in strict mode: {lane}");

        let latest = read_json(&latest_path(root));
        assert_eq!(latest.get("command").and_then(Value::as_str), Some(lane));
        assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(false));
        let errors = latest
            .get("payload")
            .and_then(|p| p.get("errors"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(
            !errors.is_empty(),
            "lane {lane} must report explicit errors when strict lane fails"
        );
    }
}

#[test]
fn v7_meta_016_to_018_external_packets_declare_required_hman_ids() {
    let workspace = workspace_root();
    let expected: Vec<(&str, Vec<&str>)> = vec![
        ("V7-META-016", vec!["HMAN-084"]),
        ("V7-META-017", vec!["HMAN-081"]),
        ("V7-META-018", vec!["HMAN-082", "HMAN-083"]),
    ];

    for (id, approvals) in expected {
        let manifest_path = workspace
            .join("evidence")
            .join("external")
            .join(id)
            .join("packet_manifest.json");
        let manifest = read_json(&manifest_path);
        assert_eq!(
            manifest
                .get("external_dependency")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            true,
            "external packets must stay marked as external dependencies: {id}"
        );
        let actual = manifest
            .get("required_hman_approvals")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect::<Vec<_>>();
        for approval in approvals {
            assert!(
                actual.iter().any(|v| v == approval),
                "packet manifest must include required approval {approval} for {id}"
            );
        }
    }
}

#[test]
fn v7_asm_001_to_002_strict_lanes_execute_with_receipts() {
    let fixture = stage_metakernel_fixture_root();
    let root = fixture.path();

    let lanes: Vec<(&str, Vec<String>)> = vec![
        (
            "variant-profiles",
            vec!["variant-profiles".to_string(), "--strict=1".to_string()],
        ),
        (
            "mpu-compartments",
            vec!["mpu-compartments".to_string(), "--strict=1".to_string()],
        ),
    ];

    for (lane, argv) in lanes {
        let exit = metakernel::run(root, &argv);
        assert_eq!(exit, 0, "lane should pass in strict mode: {lane}");
        let latest = read_json(&latest_path(root));
        assert_eq!(
            latest.get("command").and_then(Value::as_str),
            Some(lane),
            "latest receipt command should match lane {lane}"
        );
        assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(true));
    }
}

#[test]
fn v7_asm_001_to_002_fail_closed_on_contract_breaks() {
    let cases: Vec<(&str, &str, Value)> = vec![
        (
            "variant-profiles",
            "planes/contracts/variant_profiles/medical.json",
            json!({
                "version": "v1",
                "kind": "layer_minus_one_variant_profile",
                "profile_id": "medical",
                "baseline_policy_ref": "client/runtime/config/security_policy.json",
                "capability_delta": {"grant": ["observe"], "revoke": ["observe"]},
                "budget_delta": {"cpu_ms": 100},
                "no_privilege_widening": false
            }),
        ),
        (
            "mpu-compartments",
            "planes/contracts/mpu_compartment_profile_v1.json",
            json!({
                "version": "v1",
                "kind": "mpu_compartment_profile",
                "compartments": [
                    {
                        "id": "rtos_kernel",
                        "region_start": 4096,
                        "region_size": 8192,
                        "access": {"read": true, "write": true, "execute": true},
                        "unprivileged": true
                    }
                ],
                "targets": [{"id": "mcu", "compartments": ["rtos_kernel"]}]
            }),
        ),
    ];

    for (lane, contract_rel, mutated_contract) in cases {
        let fixture = stage_metakernel_fixture_root();
        let root = fixture.path();
        write_json(&root.join(contract_rel), &mutated_contract);

        let exit = metakernel::run(root, &[lane.to_string(), "--strict=1".to_string()]);
        assert_eq!(exit, 1, "lane should fail-closed in strict mode: {lane}");

        let latest = read_json(&latest_path(root));
        assert_eq!(latest.get("command").and_then(Value::as_str), Some(lane));
        assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(false));
        let errors = latest
            .get("payload")
            .and_then(|p| p.get("errors"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(
            !errors.is_empty(),
            "lane {lane} must report explicit errors when strict lane fails"
        );
    }
}
