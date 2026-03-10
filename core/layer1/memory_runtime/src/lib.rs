// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer1/memory_runtime (authoritative)

pub const CHECK_ID: &str = "layer1_memory_runtime_contract";
pub mod lensmap_annotations;
pub mod token_telemetry;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecallCommand {
    QueryIndex,
    GetNode,
    BuildIndex,
    VerifyEnvelope,
    Probe,
}

pub fn map_memory_recall_command(cmd: &str) -> RecallCommand {
    match cmd.trim().to_ascii_lowercase().as_str() {
        "get" | "get-node" => RecallCommand::GetNode,
        "build-index" => RecallCommand::BuildIndex,
        "verify-envelope" => RecallCommand::VerifyEnvelope,
        "probe" => RecallCommand::Probe,
        _ => RecallCommand::QueryIndex,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lensmap_annotations::parse_lensmap_annotation;
    use crate::token_telemetry::{evaluate_burn_slo, RetrievalMode, TokenTelemetryEvent};

    #[test]
    fn default_maps_to_query_index() {
        assert_eq!(map_memory_recall_command("query"), RecallCommand::QueryIndex);
        assert_eq!(map_memory_recall_command("status"), RecallCommand::QueryIndex);
    }

    #[test]
    fn explicit_get_maps_correctly() {
        assert_eq!(map_memory_recall_command("get"), RecallCommand::GetNode);
        assert_eq!(map_memory_recall_command("get-node"), RecallCommand::GetNode);
    }

    #[test]
    fn lensmap_annotation_parser_available() {
        let out = parse_lensmap_annotation("@lensmap tags=memory nodes=recall jot=budget");
        assert!(out.ok);
    }

    #[test]
    fn token_telemetry_slo_available() {
        let event = TokenTelemetryEvent {
            startup_tokens: 20,
            hydration_tokens: 20,
            retrieval_tokens: 40,
            response_tokens: 40,
            mode: RetrievalMode::NodeRead,
        };
        assert!(evaluate_burn_slo(&event, 200).ok);
    }
}
