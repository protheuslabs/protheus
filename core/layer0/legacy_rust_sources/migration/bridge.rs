use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedTarget {
    pub input: String,
    pub slug: Option<String>,
    pub remote_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SurfaceTransfer {
    pub id: String,
    pub source: String,
    pub target: String,
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationCheckpoint {
    pub migration_id: String,
    pub source_workspace: String,
    pub target_workspace: String,
    pub remote_before: Option<String>,
    pub remote_after: Option<String>,
    pub touched_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedReceipt {
    pub migration_id: String,
    pub event_type: String,
    pub key_id: String,
    pub signature: String,
}

fn sanitize(s: &str) -> String {
    s.trim().replace('\n', " ").replace('\r', " ")
}

pub fn normalize_repo_target(raw: &str) -> NormalizedTarget {
    let input = sanitize(raw);
    let cleaned = input.trim_end_matches(".git");

    let slug = if let Some(idx) = cleaned.find("github.com/") {
        let tail = &cleaned[idx + "github.com/".len()..];
        let parts: Vec<&str> = tail.split('/').collect();
        if parts.len() >= 2 {
            Some(format!("{}/{}", parts[0], parts[1]))
        } else {
            None
        }
    } else if cleaned.starts_with("git@") && cleaned.contains(':') {
        let tail = cleaned.split(':').nth(1).unwrap_or_default();
        if tail.split('/').count() == 2 {
            Some(tail.to_string())
        } else {
            None
        }
    } else if cleaned.split('/').count() == 2 && !cleaned.contains("://") {
        Some(cleaned.to_string())
    } else {
        None
    };

    let remote_url = match &slug {
        Some(value) => format!("https://github.com/{}.git", value),
        None => input.clone(),
    };

    NormalizedTarget {
        input,
        slug,
        remote_url,
    }
}

pub fn workspace_name_from_target(raw: &str) -> String {
    let normalized = normalize_repo_target(raw);
    if let Some(slug) = normalized.slug {
        let mut parts = slug.split('/');
        let _org = parts.next();
        if let Some(repo) = parts.next() {
            let candidate = repo.trim_end_matches(".git").trim();
            if !candidate.is_empty() {
                return candidate.to_string();
            }
        }
    }

    let fallback = normalized
        .remote_url
        .split('/')
        .last()
        .unwrap_or("protheus-workspace")
        .trim_end_matches(".git")
        .trim();
    if fallback.is_empty() {
        "protheus-workspace".to_string()
    } else {
        fallback.to_string()
    }
}

pub fn sign_receipt(migration_id: &str, event_type: &str, key_material: &str) -> SignedReceipt {
    let key = if key_material.trim().is_empty() {
        "migration_dev_key"
    } else {
        key_material.trim()
    };
    let key_id = short_hash(&format!("key:{}", key), 12);
    let signature = short_hash(
        &format!(
            "migration_id={}|event_type={}|key={} ",
            sanitize(migration_id),
            sanitize(event_type),
            key
        ),
        48,
    );

    SignedReceipt {
        migration_id: sanitize(migration_id),
        event_type: sanitize(event_type),
        key_id,
        signature,
    }
}

pub fn short_hash(value: &str, width: usize) -> String {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    let raw = format!("{:016x}", hasher.finish());
    if width == 0 {
        return raw;
    }
    let repeat = (width / raw.len()) + 1;
    raw.repeat(repeat).chars().take(width).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_slug_to_https_remote() {
        let n = normalize_repo_target("protheus-labs/core");
        assert_eq!(n.slug, Some("protheus-labs/core".to_string()));
        assert_eq!(n.remote_url, "https://github.com/protheus-labs/core.git");
    }

    #[test]
    fn infers_workspace_name() {
        assert_eq!(workspace_name_from_target("acme/runtime"), "runtime");
        assert_eq!(workspace_name_from_target("https://github.com/acme/runtime.git"), "runtime");
    }

    #[test]
    fn generates_stable_signature() {
        let a = sign_receipt("migr_1", "run", "abc");
        let b = sign_receipt("migr_1", "run", "abc");
        assert_eq!(a.signature, b.signature);
        assert_eq!(a.key_id, b.key_id);
    }
}
