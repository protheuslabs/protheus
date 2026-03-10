// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer1/memory_runtime (authoritative)

use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RetrievalMode {
    IndexOnly,
    NodeRead,
    FullFile,
}

impl RetrievalMode {
    pub fn as_str(self) -> &'static str {
        match self {
            RetrievalMode::IndexOnly => "index-only",
            RetrievalMode::NodeRead => "node-read",
            RetrievalMode::FullFile => "full-file",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenTelemetryEvent {
    pub startup_tokens: u32,
    pub hydration_tokens: u32,
    pub retrieval_tokens: u32,
    pub response_tokens: u32,
    pub mode: RetrievalMode,
}

impl TokenTelemetryEvent {
    pub fn total_tokens(&self) -> u32 {
        self.startup_tokens
            .saturating_add(self.hydration_tokens)
            .saturating_add(self.retrieval_tokens)
            .saturating_add(self.response_tokens)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenTelemetrySummary {
    pub event_count: u32,
    pub total_tokens: u32,
    pub by_mode: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BurnSloDecision {
    pub ok: bool,
    pub total_tokens: u32,
    pub threshold_tokens: u32,
    pub reason: &'static str,
}

pub fn summarize(events: &[TokenTelemetryEvent]) -> TokenTelemetrySummary {
    let mut by_mode = BTreeMap::new();
    let mut total_tokens = 0u32;
    for event in events {
        total_tokens = total_tokens.saturating_add(event.total_tokens());
        let key = event.mode.as_str().to_string();
        let entry = by_mode.entry(key).or_insert(0u32);
        *entry = entry.saturating_add(event.total_tokens());
    }
    TokenTelemetrySummary {
        event_count: events.len() as u32,
        total_tokens,
        by_mode,
    }
}

pub fn evaluate_burn_slo(event: &TokenTelemetryEvent, threshold_tokens: u32) -> BurnSloDecision {
    let total = event.total_tokens();
    if total <= threshold_tokens {
        BurnSloDecision {
            ok: true,
            total_tokens: total,
            threshold_tokens,
            reason: "within_budget",
        }
    } else {
        BurnSloDecision {
            ok: false,
            total_tokens: total,
            threshold_tokens,
            reason: "burn_threshold_exceeded",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(mode: RetrievalMode, startup: u32, hydration: u32, retrieval: u32, response: u32) -> TokenTelemetryEvent {
        TokenTelemetryEvent {
            startup_tokens: startup,
            hydration_tokens: hydration,
            retrieval_tokens: retrieval,
            response_tokens: response,
            mode,
        }
    }

    #[test]
    fn computes_total_tokens() {
        let event = sample(RetrievalMode::NodeRead, 12, 18, 42, 55);
        assert_eq!(event.total_tokens(), 127);
    }

    #[test]
    fn summarizes_by_mode() {
        let events = vec![
            sample(RetrievalMode::IndexOnly, 10, 10, 20, 30), // 70
            sample(RetrievalMode::IndexOnly, 5, 5, 5, 5),     // 20
            sample(RetrievalMode::NodeRead, 8, 8, 16, 16),    // 48
        ];
        let out = summarize(&events);
        assert_eq!(out.event_count, 3);
        assert_eq!(out.total_tokens, 138);
        assert_eq!(out.by_mode.get("index-only"), Some(&90));
        assert_eq!(out.by_mode.get("node-read"), Some(&48));
        assert_eq!(out.by_mode.get("full-file"), None);
    }

    #[test]
    fn burn_slo_passes_under_threshold() {
        let event = sample(RetrievalMode::NodeRead, 10, 20, 30, 40); // 100
        let decision = evaluate_burn_slo(&event, 120);
        assert!(decision.ok);
        assert_eq!(decision.reason, "within_budget");
    }

    #[test]
    fn burn_slo_fails_when_threshold_exceeded() {
        let event = sample(RetrievalMode::FullFile, 40, 40, 80, 60); // 220
        let decision = evaluate_burn_slo(&event, 200);
        assert!(!decision.ok);
        assert_eq!(decision.reason, "burn_threshold_exceeded");
        assert_eq!(decision.total_tokens, 220);
    }
}
