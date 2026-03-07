// SPDX-License-Identifier: Apache-2.0
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageRecord {
    pub key: String,
    pub value: String,
    pub version: u64,
    pub updated_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageError {
    InvalidKey,
    NotFound,
    VersionConflict,
}

#[derive(Debug, Default)]
pub struct StorageEngine {
    records: BTreeMap<String, StorageRecord>,
}

impl StorageEngine {
    pub fn get(&self, key: &str) -> Result<StorageRecord, StorageError> {
        self.records.get(key).cloned().ok_or(StorageError::NotFound)
    }

    pub fn put(
        &mut self,
        key: &str,
        value: &str,
        expected_version: Option<u64>,
        now_ms: u64,
    ) -> Result<StorageRecord, StorageError> {
        if !valid_key(key) {
            return Err(StorageError::InvalidKey);
        }

        let previous = self.records.get(key).cloned();
        if let Some(expected) = expected_version {
            let current = previous.as_ref().map(|row| row.version).unwrap_or(0);
            if expected != current {
                return Err(StorageError::VersionConflict);
            }
        }

        let next_version = previous.map(|row| row.version + 1).unwrap_or(1);
        let record = StorageRecord {
            key: key.to_string(),
            value: value.to_string(),
            version: next_version,
            updated_ms: now_ms,
        };
        self.records.insert(key.to_string(), record.clone());
        Ok(record)
    }

    pub fn delete(&mut self, key: &str) -> Result<StorageRecord, StorageError> {
        self.records.remove(key).ok_or(StorageError::NotFound)
    }
}

fn valid_key(key: &str) -> bool {
    if key.trim().is_empty() {
        return false;
    }
    key.chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/'))
}

#[cfg(test)]
mod tests {
    use super::{StorageEngine, StorageError};

    #[test]
    fn put_and_get_are_versioned_and_deterministic() {
        let mut store = StorageEngine::default();
        let first = store
            .put("state/kernel", "{\"ok\":true}", None, 1_762_100_000_000)
            .expect("first put");
        assert_eq!(first.version, 1);

        let second = store
            .put(
                "state/kernel",
                "{\"ok\":false}",
                Some(first.version),
                1_762_100_000_001,
            )
            .expect("second put");
        assert_eq!(second.version, 2);

        let loaded = store.get("state/kernel").expect("get latest");
        assert_eq!(loaded.value, "{\"ok\":false}");
        assert_eq!(loaded.version, 2);
    }

    #[test]
    fn put_rejects_invalid_keys_and_version_conflicts() {
        let mut store = StorageEngine::default();
        assert_eq!(
            store.put("bad key with spaces", "x", None, 1),
            Err(StorageError::InvalidKey)
        );

        let inserted = store.put("state/a", "x", None, 1).expect("insert");
        assert_eq!(
            store.put("state/a", "y", Some(inserted.version + 2), 2),
            Err(StorageError::VersionConflict)
        );
    }

    #[test]
    fn delete_requires_existing_record() {
        let mut store = StorageEngine::default();
        assert_eq!(store.delete("missing"), Err(StorageError::NotFound));
        store
            .put("state/b", "payload", None, 1_762_100_000_010)
            .expect("insert");
        let deleted = store.delete("state/b").expect("delete");
        assert_eq!(deleted.key, "state/b");
        assert_eq!(store.get("state/b"), Err(StorageError::NotFound));
    }
}
