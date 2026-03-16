use protheus_ops_core::alpha_readiness;
use std::fs;
use std::path::{Path, PathBuf};

fn seed_workspace(root: &Path) {
    let files = [
        ("install.sh", "--pure\n--tiny-max\n--repair\n"),
        (
            "install.ps1",
            "param([switch]$Pure,[switch]$TinyMax,[switch]$Repair)\n",
        ),
        (
            "verify.sh",
            "PROTHEUS_VERIFY_PROOF_TIMEOUT_SEC=${PROTHEUS_VERIFY_PROOF_TIMEOUT_SEC:-420}\n",
        ),
        (
            "README.md",
            "## Alpha Readiness Checklist\ninfring alpha-check\n",
        ),
        (
            "package.json",
            r#"{"bin":{"infring":"a","infringctl":"b","infringd":"c","protheus":"d","protheusctl":"e","protheusd":"f"}}"#,
        ),
        (".github/workflows/release.yml", "name: release\n"),
        (".github/workflows/size-gate.yml", "name: size gate\n"),
        (
            ".github/workflows/protheusd-static-size-gate.yml",
            "name: static size gate\n",
        ),
        ("docs/workspace/templates/assistant/SOUL.md", "seed\n"),
        ("docs/workspace/templates/assistant/USER.md", "seed\n"),
        ("docs/workspace/templates/assistant/HEARTBEAT.md", "seed\n"),
        ("docs/workspace/templates/assistant/IDENTITY.md", "seed\n"),
        ("docs/workspace/templates/assistant/TOOLS.md", "seed\n"),
    ];
    for (rel, contents) in files {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        fs::write(path, contents).expect("write");
    }
}

fn latest_path(root: &Path) -> PathBuf {
    root.join("local/state/ops/alpha_readiness/latest.json")
}

#[test]
fn alpha_readiness_run_persists_latest_snapshot() {
    let temp = tempfile::tempdir().expect("tempdir");
    seed_workspace(temp.path());

    let code = alpha_readiness::run(
        temp.path(),
        &[
            "run".to_string(),
            "--strict=1".to_string(),
            "--run-gates=0".to_string(),
        ],
    );
    assert_eq!(code, 0);
    assert!(latest_path(temp.path()).exists());
}

#[test]
fn alpha_readiness_status_returns_zero_after_run() {
    let temp = tempfile::tempdir().expect("tempdir");
    seed_workspace(temp.path());
    let run_code = alpha_readiness::run(temp.path(), &["run".to_string()]);
    assert_eq!(run_code, 0);
    let status_code = alpha_readiness::run(temp.path(), &["status".to_string()]);
    assert_eq!(status_code, 0);
}
