use protheus_ops_core::canyon_plane;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

const ENV_KEY: &str = "PROTHEUS_CANYON_PLANE_STATE_ROOT";

fn temp_root(prefix: &str) -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix(&format!("protheus_{prefix}_"))
        .tempdir()
        .expect("tempdir")
}

fn test_env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().expect("lock")
}

fn latest_path(state_root: &Path) -> PathBuf {
    state_root.join("latest.json")
}

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read json");
    serde_json::from_str::<Value>(&raw).expect("parse json")
}

fn write_text(root: &Path, rel: &str, body: &str) {
    let p = root.join(rel);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).expect("mkdir");
    }
    fs::write(p, body).expect("write");
}

fn install_stub_binary(root: &Path) -> PathBuf {
    let bin = root.join("bin").join("protheus-ops");
    if let Some(parent) = bin.parent() {
        fs::create_dir_all(parent).expect("mkdir bin dir");
    }
    fs::write(&bin, "#!/bin/sh\nexit 0\n").expect("write stub binary");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&bin).expect("stat").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&bin, perms).expect("chmod");
    }
    bin
}

fn install_tool_stubs(root: &Path) -> PathBuf {
    let dir = root.join("toolbin");
    fs::create_dir_all(&dir).expect("mkdir toolbin");
    let cargo = dir.join("cargo");
    fs::write(
        &cargo,
        r#"#!/bin/sh
set -eu
TARGET=""
PROFILE="release-minimal"
BIN="protheusd"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --bin) BIN="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "target/${TARGET}/${PROFILE}"
printf '#!/bin/sh\necho built\n' > "target/${TARGET}/${PROFILE}/${BIN}"
chmod +x "target/${TARGET}/${PROFILE}/${BIN}"
"#,
    )
    .expect("write cargo stub");
    let strip = dir.join("strip");
    fs::write(&strip, "#!/bin/sh\nexit 0\n").expect("write strip stub");
    let prof = dir.join("llvm-profdata");
    fs::write(&prof, "#!/bin/sh\nexit 0\n").expect("write profdata stub");
    let bolt = dir.join("llvm-bolt");
    fs::write(&bolt, "#!/bin/sh\nexit 0\n").expect("write bolt stub");
    #[cfg(unix)]
    for p in [&cargo, &strip, &prof, &bolt] {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(p).expect("stat").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(p, perms).expect("chmod");
    }
    dir
}

fn write_top1_benchmark(
    root: &Path,
    cold_start_ms: u64,
    idle_rss_mb: f64,
    install_size_mb: f64,
    tasks_per_sec: u64,
) {
    write_text(
        root,
        "core/local/state/ops/top1_assurance/benchmark_latest.json",
        &serde_json::json!({
            "metrics": {
                "cold_start_ms": cold_start_ms,
                "idle_rss_mb": idle_rss_mb,
                "install_size_mb": install_size_mb,
                "tasks_per_sec": tasks_per_sec
            }
        })
        .to_string(),
    );
}

fn write_large_binary(root: &Path, rel: &str, size_bytes: usize) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("mkdir binary dir");
    }
    fs::write(path, vec![0u8; size_bytes]).expect("write large binary");
}

fn write_substrate_adapter_graph(root: &Path) {
    write_text(
        root,
        "client/runtime/config/substrate_adapter_graph.json",
        &serde_json::json!({
            "schema_id": "substrate_adapter_graph",
            "schema_version": "1.0",
            "adapters": [
                {"id": "wifi-csi-engine", "feature_gate": "embedded-minimal-core", "feature_sets": ["minimal", "full-substrate"]},
                {"id": "browser-sandbox", "feature_gate": "full-substrate", "feature_sets": ["full-substrate"]},
                {"id": "bio-adapter-template", "feature_gate": "full-substrate", "feature_sets": ["full-substrate"]},
                {"id": "vbrowser", "feature_gate": "full-substrate", "feature_sets": ["full-substrate"]},
                {"id": "binary-vuln", "feature_gate": "full-substrate", "feature_sets": ["full-substrate"]}
            ]
        })
        .to_string(),
    );
}

fn write_release_security_workflow(root: &Path) {
    write_text(
        root,
        ".github/workflows/release-security-artifacts.yml",
        "name: Release Security Artifacts\njobs:\n  release:\n    steps:\n      - uses: actions/attest-build-provenance@v2\n      - run: supply-chain-provenance-v2 run --strict=1\n      - run: echo reproducible_build_equivalence.json\n",
    );
}

fn write_size_trust_workflows(root: &Path) {
    write_text(
        root,
        ".github/workflows/size-gate.yml",
        "name: Size Gate\njobs:\n  gate:\n    steps:\n      - run: echo Build static protheusd\n      - run: echo Enforce full install size gate\n      - run: echo Enforce throughput gate\n",
    );
    write_text(
        root,
        ".github/workflows/protheusd-static-size-gate.yml",
        "name: Static Size Gate\njobs:\n  gate:\n    steps:\n      - run: echo Build static protheusd\n      - run: echo Enforce static size gate\n      - run: echo Verify reproducible static rebuild\n",
    );
    write_text(
        root,
        ".github/workflows/nightly-size-trust-center.yml",
        "name: Nightly Size Trust Center\non:\n  schedule:\n    - cron: \"17 7 * * *\"\njobs:\n  publish:\n    steps:\n      - run: echo upload-pages-artifact\n      - run: echo deploy-pages\n",
    );
}

fn assert_claim(payload: &Value, id: &str) {
    let claims = payload
        .get("claim_evidence")
        .and_then(Value::as_array)
        .expect("claim evidence array");
    assert!(
        claims
            .iter()
            .any(|row| row.get("id").and_then(Value::as_str) == Some(id)),
        "missing claim evidence {id}: {payload}"
    );
}

#[test]
fn v7_canyon_batch2_contracts_are_behavior_proven() {
    let _guard = test_env_lock();
    let tmp = temp_root("canyon_batch2");
    let root = tmp.path();
    let canyon_state = root.join("local").join("state").join("canyon");
    std::env::set_var(ENV_KEY, &canyon_state);

    write_text(
        root,
        "core/layer0/kernel_layers/Cargo.toml",
        "[package]\nname='kernel_layers'\n[features]\ndefault = []\nno_std_probe = []\n",
    );
    write_text(root, "core/layer0/kernel_layers/src/lib.rs", "#![no_std]\n");
    write_text(
        root,
        "core/layer2/conduit/Cargo.toml",
        "[package]\nname='conduit'\n[features]\ndefault = []\nno_std_probe = []\n",
    );
    write_text(root, "core/layer2/conduit/src/lib.rs", "#![no_std]\n");
    write_text(
        root,
        "core/layer0/memory/Cargo.toml",
        "[package]\nname='memory'\n[features]\ndefault = []\nno_std_probe = []\n",
    );
    write_text(root, "core/layer0/memory/src/lib.rs", "pub fn x() {}\n");
    write_text(
        root,
        "core/layer1/security/Cargo.toml",
        "[package]\nname='security'\n[features]\ndefault = []\nno_std_probe = []\n",
    );
    write_text(root, "core/layer1/security/src/lib.rs", "pub fn y() {}\n");
    write_text(
        root,
        "core/layer0/ops/Cargo.toml",
        "[package]\nname='protheus-ops-core'\n[features]\nminimal = []\n",
    );
    write_text(
        root,
        "core/layer0/alloc.rs",
        "pub struct Layer0CountingAllocator;\n",
    );
    write_substrate_adapter_graph(root);
    write_release_security_workflow(root);
    write_size_trust_workflows(root);

    let stub_bin = install_stub_binary(root);
    let toolbin = install_tool_stubs(root);
    std::env::set_var("PROTHEUS_CARGO_BIN", toolbin.join("cargo"));
    std::env::set_var("PROTHEUS_STRIP_BIN", toolbin.join("strip"));
    std::env::set_var("PROTHEUS_LLVM_PROFDATA_BIN", toolbin.join("llvm-profdata"));
    std::env::set_var("PROTHEUS_LLVM_BOLT_BIN", toolbin.join("llvm-bolt"));

    assert_eq!(
        canyon_plane::run(root, &["footprint".to_string(), "--strict=1".to_string()]),
        0
    );
    let mut latest = read_json(&latest_path(&canyon_state));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("canyon_plane_footprint")
    );
    assert_claim(&latest, "V7-CANYON-002.1");

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "lazy-substrate".to_string(),
                "--op=enable".to_string(),
                "--feature-set=minimal".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "lazy-substrate".to_string(),
                "--op=load".to_string(),
                "--adapter=wifi-csi-engine".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_claim(&latest, "V7-CANYON-002.2");

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "release-pipeline".to_string(),
                "--op=run".to_string(),
                "--binary=protheusd".to_string(),
                "--target=x86_64-unknown-linux-musl".to_string(),
                "--profile=release-minimal".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_claim(&latest, "V7-CANYON-002.3");

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "efficiency".to_string(),
                "--strict=1".to_string(),
                format!("--binary-path={}", stub_bin.display()),
                "--idle-memory-mb=10".to_string(),
                "--concurrent-agents=50".to_string(),
            ],
        ),
        0
    );
    write_text(root, "workspace/README.md", "# workspace\n");
    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "workflow".to_string(),
                "--op=run".to_string(),
                "--goal=ship_end_to_end".to_string(),
                format!("--workspace={}", root.join("workspace").display()),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "scheduler".to_string(),
                "--op=simulate".to_string(),
                "--agents=10000".to_string(),
                "--nodes=4".to_string(),
                "--modes=kubernetes,edge,distributed".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "control-plane".to_string(),
                "--op=snapshot".to_string(),
                "--rbac=1".to_string(),
                "--sso=1".to_string(),
                "--hitl=1".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "adoption".to_string(),
                "--op=run-demo".to_string(),
                "--tutorial=quickstart".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "benchmark-gate".to_string(),
                "--op=run".to_string(),
                "--milestone=day90".to_string(),
                "--strict=0".to_string(),
            ],
        ),
        0
    );

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "receipt-batching".to_string(),
                "--op=flush".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_claim(&latest, "V7-CANYON-002.4");

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "package-release".to_string(),
                "--op=build".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_claim(&latest, "V7-CANYON-002.5");

    assert_eq!(
        canyon_plane::run(root, &["size-trust".to_string(), "--strict=1".to_string()]),
        0
    );
    latest = read_json(&latest_path(&canyon_state));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("canyon_plane_size_trust_center")
    );
    assert_claim(&latest, "V7-CANYON-002.6");
}

#[test]
fn v7_canyon_release_pipeline_allows_missing_optional_llvm_tools_when_not_strict_and_size_trust_uses_top1_fallback(
) {
    let _guard = test_env_lock();
    let tmp = temp_root("canyon_batch2_optional_tools");
    let root = tmp.path();
    let canyon_state = root.join("local").join("state").join("canyon");
    std::env::set_var(ENV_KEY, &canyon_state);

    write_text(
        root,
        "core/layer0/ops/Cargo.toml",
        "[package]\nname='protheus-ops-core'\n[features]\nminimal = []\n",
    );
    write_release_security_workflow(root);
    write_size_trust_workflows(root);
    let toolbin = install_tool_stubs(root);
    std::env::set_var("PROTHEUS_CARGO_BIN", toolbin.join("cargo"));
    std::env::set_var("PROTHEUS_STRIP_BIN", toolbin.join("strip"));
    std::env::set_var(
        "PROTHEUS_LLVM_PROFDATA_BIN",
        root.join("missing").join("llvm-profdata"),
    );
    std::env::set_var(
        "PROTHEUS_LLVM_BOLT_BIN",
        root.join("missing").join("llvm-bolt"),
    );

    write_top1_benchmark(root, 28, 9.5, 2.7, 18_500);

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "release-pipeline".to_string(),
                "--op=run".to_string(),
                "--binary=protheusd".to_string(),
                "--target=x86_64-unknown-linux-musl".to_string(),
                "--profile=release-minimal".to_string(),
                "--strict=0".to_string(),
            ],
        ),
        0
    );
    let latest = read_json(&latest_path(&canyon_state));
    assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(true));
    assert!(latest
        .get("optimization")
        .and_then(|v| v.get("missing_optional_tools"))
        .and_then(Value::as_array)
        .map(|rows| rows.iter().any(|row| row.as_str() == Some("llvm-profdata")))
        .unwrap_or(false));

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "package-release".to_string(),
                "--op=build".to_string(),
                "--strict=0".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        canyon_plane::run(root, &["size-trust".to_string(), "--strict=0".to_string()]),
        0
    );
    let latest = read_json(&latest_path(&canyon_state));
    assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        latest
            .get("metrics")
            .and_then(|v| v.get("cold_start_ms"))
            .and_then(Value::as_u64),
        Some(28)
    );
    assert_eq!(
        latest
            .get("metrics")
            .and_then(|v| v.get("idle_rss_mb"))
            .and_then(Value::as_f64),
        Some(9.5)
    );
}

#[test]
fn v7_canyon_release_pipeline_strict_fails_when_optional_llvm_tools_are_missing() {
    let _guard = test_env_lock();
    let tmp = temp_root("canyon_batch2_missing_llvm_strict");
    let root = tmp.path();
    let canyon_state = root.join("local").join("state").join("canyon");
    std::env::set_var(ENV_KEY, &canyon_state);

    write_text(
        root,
        "core/layer0/ops/Cargo.toml",
        "[package]\nname='protheus-ops-core'\n[features]\nminimal = []\n",
    );
    let toolbin = install_tool_stubs(root);
    std::env::set_var("PROTHEUS_CARGO_BIN", toolbin.join("cargo"));
    std::env::set_var("PROTHEUS_STRIP_BIN", toolbin.join("strip"));
    std::env::set_var(
        "PROTHEUS_LLVM_PROFDATA_BIN",
        root.join("missing").join("llvm-profdata"),
    );
    std::env::set_var(
        "PROTHEUS_LLVM_BOLT_BIN",
        root.join("missing").join("llvm-bolt"),
    );

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "release-pipeline".to_string(),
                "--op=run".to_string(),
                "--binary=protheusd".to_string(),
                "--target=x86_64-unknown-linux-musl".to_string(),
                "--profile=release-minimal".to_string(),
                "--strict=1".to_string(),
            ],
        ),
        1
    );
    let latest = read_json(&latest_path(&canyon_state));
    let errors = latest
        .get("errors")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert!(errors
        .iter()
        .any(|row| row.as_str() == Some("tool_missing:llvm-profdata")));
    if !cfg!(target_os = "macos") {
        assert!(errors
            .iter()
            .any(|row| row.as_str() == Some("tool_missing:llvm-bolt")));
    }
}

#[test]
fn v7_canyon_release_pipeline_reuses_real_release_artifact_when_minimal_profile_missing_non_strict()
{
    let _guard = test_env_lock();
    let tmp = temp_root("canyon_batch2_release_fallback");
    let root = tmp.path();
    let canyon_state = root.join("local").join("state").join("canyon");
    std::env::set_var(ENV_KEY, &canyon_state);

    write_text(
        root,
        "core/layer0/ops/Cargo.toml",
        "[package]\nname='protheus-ops-core'\n[features]\nminimal = []\n",
    );
    write_release_security_workflow(root);
    let toolbin = install_tool_stubs(root);
    std::env::set_var("PROTHEUS_CARGO_BIN", toolbin.join("cargo"));
    std::env::set_var("PROTHEUS_STRIP_BIN", toolbin.join("strip"));
    std::env::remove_var("PROTHEUS_LLVM_PROFDATA_BIN");
    std::env::remove_var("PROTHEUS_LLVM_BOLT_BIN");

    write_large_binary(
        root,
        "target/x86_64-unknown-linux-musl/release/protheusd",
        1_200_000,
    );

    assert_eq!(
        canyon_plane::run(
            root,
            &[
                "release-pipeline".to_string(),
                "--op=run".to_string(),
                "--binary=protheusd".to_string(),
                "--target=x86_64-unknown-linux-musl".to_string(),
                "--profile=release-minimal".to_string(),
                "--strict=0".to_string(),
            ],
        ),
        0
    );

    let latest = read_json(&latest_path(&canyon_state));
    assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        latest.get("artifact_source").and_then(Value::as_str),
        Some(
            root.join("target/x86_64-unknown-linux-musl/release/protheusd")
                .to_string_lossy()
                .as_ref()
        )
    );
    assert_eq!(
        latest.get("final_size_bytes").and_then(Value::as_u64),
        Some(1_200_000)
    );
}
