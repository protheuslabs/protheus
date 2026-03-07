// SPDX-License-Identifier: Apache-2.0
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CrdtCell {
    pub value: String,
    pub clock: u64,
    pub node: String,
}

pub type CrdtMap = BTreeMap<String, CrdtCell>;

pub fn merge(left: &CrdtMap, right: &CrdtMap) -> CrdtMap {
    let mut out = left.clone();
    for (key, incoming) in right {
        match out.get(key) {
            None => {
                out.insert(key.clone(), incoming.clone());
            }
            Some(existing) => {
                let take_incoming = incoming.clock > existing.clock
                    || (incoming.clock == existing.clock && incoming.node > existing.node);
                if take_incoming {
                    out.insert(key.clone(), incoming.clone());
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_prefers_higher_clock() {
        let mut a = CrdtMap::new();
        a.insert(
            "topic".into(),
            CrdtCell {
                value: "alpha".into(),
                clock: 1,
                node: "n1".into(),
            },
        );
        let mut b = CrdtMap::new();
        b.insert(
            "topic".into(),
            CrdtCell {
                value: "beta".into(),
                clock: 2,
                node: "n2".into(),
            },
        );
        let merged = merge(&a, &b);
        assert_eq!(merged.get("topic").map(|v| v.value.as_str()), Some("beta"));
    }
}
