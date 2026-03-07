// SPDX-License-Identifier: Apache-2.0
use protheus_ops_core::model_router::{
    infer_capability, infer_role, infer_tier, normalize_capability_key, task_type_key_from_route,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct GoldenCase {
    intent: String,
    task: String,
    risk: String,
    complexity: String,
    expected_role: String,
    expected_capability: String,
    expected_tier: u8,
}

#[test]
fn model_router_matches_golden_cases() {
    let cases: Vec<GoldenCase> = serde_json::from_str(include_str!("golden/model_router_cases.json"))
        .expect("valid golden dataset");
    assert!(!cases.is_empty(), "golden dataset must not be empty");
    for case in cases {
        let role = infer_role(&case.intent, &case.task);
        let capability = infer_capability(&case.intent, &case.task, &role);
        let tier = infer_tier(&case.risk, &case.complexity);
        assert_eq!(role, case.expected_role, "role mismatch for {:?}", case.intent);
        assert_eq!(
            capability, case.expected_capability,
            "capability mismatch for {:?}",
            case.intent
        );
        assert_eq!(tier, case.expected_tier, "tier mismatch for {:?}", case.intent);
    }
}

#[test]
fn model_router_property_style_invariants_hold_for_generated_inputs() {
    let risks = ["low", "medium", "high", "LOW", "unknown"];
    let complexities = ["low", "medium", "high", "HIGH", "custom"];
    let intents = [
        "patch rust code",
        "plan strategy",
        "run cli tool",
        "chat reply",
        "parallel agent sync",
        "unknown workload",
    ];
    let tasks = [
        "edit file",
        "roadmap ROI",
        "curl API",
        "respond comment",
        "delegate swarm",
        "misc",
    ];

    for risk in risks {
        for complexity in complexities {
            let tier = infer_tier(risk, complexity);
            assert!(
                (1..=3).contains(&tier),
                "tier must stay in [1,3], got {tier} for risk={risk} complexity={complexity}"
            );
        }
    }

    for intent in intents {
        for task in tasks {
            let role = infer_role(intent, task);
            let capability = infer_capability(intent, task, &role);
            let normalized = normalize_capability_key(&capability);
            assert!(
                !normalized.contains(' '),
                "normalized capability should never contain spaces: {normalized}"
            );
            let key = task_type_key_from_route("default", &capability, &role);
            assert!(!key.trim().is_empty(), "task type key should never be empty");
        }
    }
}
