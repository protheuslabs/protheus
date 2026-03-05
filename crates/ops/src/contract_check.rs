use crate::legacy_bridge::{resolve_script_path, run_legacy_script_compat};
use std::path::Path;

const LEGACY_SCRIPT_ENV: &str = "PROTHEUS_CONTRACT_CHECK_LEGACY_SCRIPT";
const LEGACY_SCRIPT_DEFAULT: &str = "systems/spine/contract_check_legacy.js";

pub fn run(root: &Path, args: &[String]) -> i32 {
    let script = resolve_script_path(root, LEGACY_SCRIPT_ENV, LEGACY_SCRIPT_DEFAULT);
    run_legacy_script_compat(root, "contract_check", &script, args, false)
}

fn compact_json_spacing(token: &str) -> String {
    let mut out = String::with_capacity(token.len());
    let mut chars = token.chars().peekable();
    while let Some(ch) = chars.next() {
        out.push(ch);
        if ch == ':' && out.ends_with("\":") {
            while let Some(next) = chars.peek() {
                if next.is_whitespace() {
                    chars.next();
                } else {
                    break;
                }
            }
        }
    }
    out
}

pub fn missing_tokens(text: &str, tokens: &[String]) -> Vec<String> {
    let mut missing = Vec::new();
    for token in tokens {
        if text.contains(token) {
            continue;
        }
        let compact_json_token = compact_json_spacing(token);
        if compact_json_token != *token && text.contains(&compact_json_token) {
            continue;
        }
        missing.push(token.clone());
    }
    missing
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_json_spacing_only_compacts_key_colon_whitespace() {
        let token = r#""schema":   {"id": "x"} value:  keep"#;
        let compacted = compact_json_spacing(token);
        assert_eq!(compacted, r#""schema":{"id":"x"} value:  keep"#);
    }

    #[test]
    fn missing_tokens_accepts_compact_json_variant() {
        let text = r#"{"schema":{"id":"x"}}"#;
        let tokens = vec!["\"schema\": {".to_string()];
        let missing = missing_tokens(text, &tokens);
        assert!(missing.is_empty());
    }

    #[test]
    fn missing_tokens_reports_absent_tokens() {
        let text = "usage run --help";
        let tokens = vec!["status".to_string(), "run".to_string()];
        let missing = missing_tokens(text, &tokens);
        assert_eq!(missing, vec!["status".to_string()]);
    }

    #[test]
    fn missing_tokens_preserves_missing_order() {
        let text = "run --help";
        let tokens = vec![
            "status".to_string(),
            "run".to_string(),
            "contract".to_string(),
        ];
        let missing = missing_tokens(text, &tokens);
        assert_eq!(missing, vec!["status".to_string(), "contract".to_string()]);
    }

    #[test]
    fn missing_tokens_does_not_loosen_non_json_colon_spacing() {
        let text = "value: keep";
        let tokens = vec!["value:  keep".to_string()];
        let missing = missing_tokens(text, &tokens);
        assert_eq!(missing, vec!["value:  keep".to_string()]);
    }

    #[test]
    fn missing_tokens_accepts_multiple_compacted_json_tokens() {
        let text = r#"{"schema":{"id":"x","checks":[1,2]}}"#;
        let tokens = vec![
            "\"schema\": {".to_string(),
            "\"id\":   \"x\"".to_string(),
            "\"checks\":   [1,2]".to_string(),
        ];
        let missing = missing_tokens(text, &tokens);
        assert!(missing.is_empty());
    }

    #[test]
    fn compact_json_spacing_removes_all_whitespace_after_json_key_colon() {
        let token = "\"schema\":\n\t  {\"id\":\n \"x\"}";
        let compacted = compact_json_spacing(token);
        assert_eq!(compacted, "\"schema\":{\"id\":\"x\"}");
    }

    #[test]
    fn missing_tokens_treats_empty_token_as_present_like_str_contains() {
        let text = "anything";
        let tokens = vec!["".to_string(), "absent".to_string()];
        let missing = missing_tokens(text, &tokens);
        assert_eq!(missing, vec!["absent".to_string()]);
    }

    #[test]
    fn compact_json_spacing_leaves_non_json_colon_patterns_untouched() {
        let token = "url:http://example.com key: value";
        let compacted = compact_json_spacing(token);
        assert_eq!(compacted, token);
    }

    #[test]
    fn missing_tokens_preserves_duplicate_missing_entries() {
        let text = "run";
        let tokens = vec![
            "missing".to_string(),
            "run".to_string(),
            "missing".to_string(),
        ];
        let missing = missing_tokens(text, &tokens);
        assert_eq!(missing, vec!["missing".to_string(), "missing".to_string()]);
    }
}
