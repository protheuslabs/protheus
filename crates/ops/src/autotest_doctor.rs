use crate::legacy_bridge::run_legacy_script_rel;
use std::path::Path;

const LEGACY_SCRIPT_REL: &str = "systems/ops/autotest_doctor_legacy.js";

pub fn run(root: &Path, argv: &[String]) -> i32 {
    run_legacy_script_rel(root, LEGACY_SCRIPT_REL, argv, "autotest_doctor")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_legacy_script_returns_error() {
        let dir = tempdir().expect("tempdir");
        let exit = run(dir.path(), &["status".to_string()]);
        assert_eq!(exit, 1);
    }
}
