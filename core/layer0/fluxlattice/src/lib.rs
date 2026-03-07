// SPDX-License-Identifier: Apache-2.0
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub struct FluxState {
    pub id: String,
    pub settled: bool,
    pub morphology: String,
    pub metadata: BTreeMap<String, String>,
}

impl FluxState {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            settled: false,
            morphology: "coalesced".to_string(),
            metadata: BTreeMap::new(),
        }
    }
}

pub fn init_state(id: &str) -> FluxState {
    let mut state = FluxState::new(id);
    state
        .metadata
        .insert("phase".to_string(), "initialized".to_string());
    state
}

pub fn settle(mut state: FluxState, target: &str) -> FluxState {
    state.settled = true;
    state
        .metadata
        .insert("target".to_string(), target.to_string());
    state
        .metadata
        .insert("phase".to_string(), "settled".to_string());
    state
}

pub fn morph(mut state: FluxState, morphology: &str) -> FluxState {
    state.morphology = morphology.to_string();
    state
        .metadata
        .insert("phase".to_string(), "morphed".to_string());
    state
}

pub fn status_map(state: &FluxState) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    map.insert("id".to_string(), state.id.clone());
    map.insert("settled".to_string(), state.settled.to_string());
    map.insert("morphology".to_string(), state.morphology.clone());
    for (k, v) in state.metadata.iter() {
        map.insert(format!("meta_{}", k), v.clone());
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_settle_morph_roundtrip() {
        let state = init_state("test");
        let state = settle(state, "binary");
        let state = morph(state, "dynamic");
        let status = status_map(&state);
        assert_eq!(status.get("settled").unwrap(), "true");
        assert_eq!(status.get("morphology").unwrap(), "dynamic");
    }
}
