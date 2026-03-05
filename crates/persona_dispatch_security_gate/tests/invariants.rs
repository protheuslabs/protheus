use persona_dispatch_security_gate::evaluate_persona_dispatch_gate;

#[test]
fn blocked_dispatch_path_fails_closed() {
    let decision = evaluate_persona_dispatch_gate(
        "systems/ops/protheus_control_plane.js",
        Some("guardian"),
        &["guardian", "operator"],
        &["systems/ops/protheus_control_plane.js"],
        false,
        false,
    );

    assert!(!decision.ok);
    assert_eq!(decision.code, "blocked_dispatch_path");
}

#[test]
fn invalid_requested_lens_uses_valid_fallback() {
    let decision = evaluate_persona_dispatch_gate(
        "systems/ops/protheus_control_plane.js",
        Some("nonexistent"),
        &["guardian", "operator"],
        &[],
        false,
        false,
    );

    assert!(decision.ok);
    assert_eq!(decision.selected_lens.as_deref(), Some("guardian"));
    assert!(decision.envelope.fallback_used);
}

#[test]
fn deterministic_error_envelope_is_stable() {
    let first = evaluate_persona_dispatch_gate(
        "systems/ops/protheus_control_plane.js",
        Some("guardian"),
        &["guardian"],
        &["systems/ops/protheus_control_plane.js"],
        false,
        false,
    );
    let second = evaluate_persona_dispatch_gate(
        "systems/ops/protheus_control_plane.js",
        Some("guardian"),
        &["guardian"],
        &["systems/ops/protheus_control_plane.js"],
        false,
        false,
    );

    assert!(!first.ok);
    assert_eq!(first.envelope, second.envelope);
    assert_eq!(
        first.envelope.deterministic_key,
        second.envelope.deterministic_key
    );
}
