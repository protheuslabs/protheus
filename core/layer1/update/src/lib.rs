// SPDX-License-Identifier: Apache-2.0
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdatePackage {
    pub version: String,
    pub artifact_sha256: String,
    pub size_bytes: u64,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdatePolicy {
    pub max_size_bytes: u64,
    pub required_capability: String,
    pub allow_prerelease: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateDecision {
    Approved,
    Rejected(String),
}

impl UpdatePolicy {
    pub fn evaluate(&self, package: &UpdatePackage) -> UpdateDecision {
        if package.version.trim().is_empty() {
            return UpdateDecision::Rejected("version_missing".to_string());
        }
        if !self.allow_prerelease && package.version.contains('-') {
            return UpdateDecision::Rejected("prerelease_blocked".to_string());
        }
        if package.size_bytes > self.max_size_bytes {
            return UpdateDecision::Rejected("artifact_size_exceeds_policy".to_string());
        }
        if !valid_sha256(&package.artifact_sha256) {
            return UpdateDecision::Rejected("artifact_sha256_invalid".to_string());
        }
        if !package
            .capabilities
            .iter()
            .any(|cap| cap == &self.required_capability)
        {
            return UpdateDecision::Rejected("missing_required_capability".to_string());
        }
        UpdateDecision::Approved
    }
}

fn valid_sha256(raw: &str) -> bool {
    raw.len() == 64 && raw.chars().all(|ch| ch.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::{UpdateDecision, UpdatePackage, UpdatePolicy};

    fn policy() -> UpdatePolicy {
        UpdatePolicy {
            max_size_bytes: 64 * 1024 * 1024,
            required_capability: "update.apply".to_string(),
            allow_prerelease: false,
        }
    }

    #[test]
    fn update_policy_approves_valid_release_package() {
        let package = UpdatePackage {
            version: "1.2.3".to_string(),
            artifact_sha256:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            size_bytes: 8 * 1024 * 1024,
            capabilities: vec!["update.apply".to_string(), "status.read".to_string()],
        };
        assert_eq!(policy().evaluate(&package), UpdateDecision::Approved);
    }

    #[test]
    fn update_policy_rejects_invalid_hash_or_missing_capability() {
        let invalid_hash = UpdatePackage {
            version: "1.2.3".to_string(),
            artifact_sha256: "xyz".to_string(),
            size_bytes: 8 * 1024 * 1024,
            capabilities: vec!["update.apply".to_string()],
        };
        assert_eq!(
            policy().evaluate(&invalid_hash),
            UpdateDecision::Rejected("artifact_sha256_invalid".to_string())
        );

        let missing_capability = UpdatePackage {
            version: "1.2.3".to_string(),
            artifact_sha256:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            size_bytes: 8 * 1024 * 1024,
            capabilities: vec!["status.read".to_string()],
        };
        assert_eq!(
            policy().evaluate(&missing_capability),
            UpdateDecision::Rejected("missing_required_capability".to_string())
        );
    }

    #[test]
    fn update_policy_rejects_prerelease_when_blocked() {
        let package = UpdatePackage {
            version: "2.0.0-rc1".to_string(),
            artifact_sha256:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            size_bytes: 8 * 1024 * 1024,
            capabilities: vec!["update.apply".to_string()],
        };
        assert_eq!(
            policy().evaluate(&package),
            UpdateDecision::Rejected("prerelease_blocked".to_string())
        );
    }
}
