// SPDX-License-Identifier: Apache-2.0
#![cfg(kani)]

use crate::{run_workflow_definition, WorkflowDefinition, WorkflowStep};
use std::collections::BTreeMap;

#[kani::proof]
fn prove_normalize_step_id_fills_empty_id() {
    let step = WorkflowStep {
        id: "".to_string(),
        kind: "task".to_string(),
        action: "noop".to_string(),
        command: "".to_string(),
        pause_after: false,
        params: BTreeMap::new(),
    };
    let normalized = crate::normalize_step_id(&step, 0);
    assert_eq!(normalized, "step_001");
}

#[kani::proof]
fn prove_step_fingerprint_is_deterministic_for_same_input() {
    let mut params = BTreeMap::new();
    params.insert("goal".to_string(), "ship".to_string());
    let step = WorkflowStep {
        id: "s1".to_string(),
        kind: "task".to_string(),
        action: "execute".to_string(),
        command: "run".to_string(),
        pause_after: false,
        params,
    };
    let left = crate::step_fingerprint("wf", "seed", 0, "s1", &step);
    let right = crate::step_fingerprint("wf", "seed", 0, "s1", &step);
    assert_eq!(left, right);
}

#[kani::proof]
fn prove_scheduler_receipt_is_deterministic_for_same_workflow() {
    let step = WorkflowStep {
        id: "step_a".to_string(),
        kind: "task".to_string(),
        action: "run".to_string(),
        command: "echo".to_string(),
        pause_after: false,
        params: BTreeMap::new(),
    };
    let workflow = WorkflowDefinition {
        workflow_id: "wf_scheduler".to_string(),
        deterministic_seed: "seed".to_string(),
        pause_after_step: None,
        resume: None,
        steps: vec![step],
        metadata: BTreeMap::new(),
    };
    let left = run_workflow_definition(workflow.clone());
    let right = run_workflow_definition(workflow);
    assert_eq!(left.event_digest, right.event_digest);
    assert_eq!(left.status, right.status);
}
