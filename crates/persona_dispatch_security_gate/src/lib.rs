pub const CHECK_ID: &str = "persona_dispatch_security_gate";
pub const RECEIPT_SCHEMA_ID: &str = "persona_dispatch_security_gate_receipt";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonaDispatchEnvelope {
    pub schema_id: &'static str,
    pub check_id: &'static str,
    pub ok: bool,
    pub code: &'static str,
    pub script_rel: String,
    pub requested_lens: Option<String>,
    pub selected_lens: Option<String>,
    pub fallback_used: bool,
    pub deterministic_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonaDispatchGateDecision {
    pub ok: bool,
    pub code: &'static str,
    pub selected_lens: Option<String>,
    pub envelope: PersonaDispatchEnvelope,
}

fn normalize_token(raw: &str, max_len: usize) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_underscore = false;
    for ch in raw.trim().chars() {
        let lc = ch.to_ascii_lowercase();
        let mapped = if lc.is_ascii_alphanumeric() || matches!(lc, '_' | '.' | ':' | '/' | '-') {
            lc
        } else {
            '_'
        };
        if mapped == '_' {
            if prev_underscore {
                continue;
            }
            prev_underscore = true;
        } else {
            prev_underscore = false;
        }
        out.push(mapped);
        if out.len() >= max_len {
            break;
        }
    }
    out.trim_matches('_').to_string()
}

fn normalize_lens(raw: Option<&str>) -> Option<String> {
    raw.map(|v| normalize_token(v, 64))
        .filter(|v| !v.is_empty())
}

fn normalize_lens_list(valid_lenses: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for raw in valid_lenses {
        let norm = normalize_token(raw, 64);
        if norm.is_empty() || out.contains(&norm) {
            continue;
        }
        out.push(norm);
    }
    out
}

fn blocked_path(script_rel: &str, blocked_paths: &[&str]) -> Option<String> {
    let normalized_script = normalize_token(script_rel, 300);
    for blocked in blocked_paths {
        let blocked_norm = normalize_token(blocked, 300);
        if blocked_norm.is_empty() {
            continue;
        }
        let blocked_prefix = format!("{blocked_norm}/");
        if normalized_script == blocked_norm || normalized_script.starts_with(&blocked_prefix) {
            return Some(blocked_norm);
        }
    }
    None
}

fn make_decision(
    ok: bool,
    code: &'static str,
    script_rel: &str,
    requested_lens: Option<String>,
    selected_lens: Option<String>,
    fallback_used: bool,
) -> PersonaDispatchGateDecision {
    let normalized_script = normalize_token(script_rel, 300);
    let requested_lens_token = requested_lens.clone().unwrap_or_else(|| "none".to_string());
    let selected_lens_token = selected_lens.clone().unwrap_or_else(|| "none".to_string());
    let deterministic_key = format!(
        "{CHECK_ID}|{}|{code}|{normalized_script}|{requested_lens_token}|{selected_lens_token}|{}",
        if ok { 1 } else { 0 },
        if fallback_used { 1 } else { 0 }
    );

    PersonaDispatchGateDecision {
        ok,
        code,
        selected_lens: selected_lens.clone(),
        envelope: PersonaDispatchEnvelope {
            schema_id: RECEIPT_SCHEMA_ID,
            check_id: CHECK_ID,
            ok,
            code,
            script_rel: normalized_script,
            requested_lens,
            selected_lens,
            fallback_used,
            deterministic_key,
        },
    }
}

pub fn evaluate_persona_dispatch_gate(
    script_rel: &str,
    requested_lens: Option<&str>,
    valid_lenses: &[&str],
    blocked_paths: &[&str],
    covenant_violation: bool,
    tamper_signal: bool,
) -> PersonaDispatchGateDecision {
    let normalized_requested = normalize_lens(requested_lens);
    if covenant_violation {
        return make_decision(
            false,
            "covenant_violation_fail_closed",
            script_rel,
            normalized_requested,
            None,
            false,
        );
    }
    if tamper_signal {
        return make_decision(
            false,
            "tamper_signal_fail_closed",
            script_rel,
            normalized_requested,
            None,
            false,
        );
    }

    if blocked_path(script_rel, blocked_paths).is_some() {
        return make_decision(
            false,
            "blocked_dispatch_path",
            script_rel,
            normalized_requested,
            None,
            false,
        );
    }

    let normalized_lenses = normalize_lens_list(valid_lenses);
    let selected_lens = normalized_requested
        .as_ref()
        .and_then(|lens| {
            normalized_lenses
                .iter()
                .find(|candidate| *candidate == lens)
        })
        .cloned()
        .or_else(|| normalized_lenses.first().cloned());

    let fallback_used = match (&normalized_requested, &selected_lens) {
        (Some(requested), Some(selected)) => requested != selected,
        _ => false,
    };

    if selected_lens.is_none() {
        return make_decision(
            false,
            "no_valid_lens_fail_closed",
            script_rel,
            normalized_requested,
            None,
            false,
        );
    }

    make_decision(
        true,
        "ok",
        script_rel,
        normalized_requested,
        selected_lens,
        fallback_used,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_requested_lens_when_present() {
        let decision = evaluate_persona_dispatch_gate(
            "systems/ops/protheus_control_plane.js",
            Some("guardian"),
            &["operator", "guardian"],
            &[],
            false,
            false,
        );
        assert!(decision.ok);
        assert_eq!(decision.selected_lens.as_deref(), Some("guardian"));
    }
}
