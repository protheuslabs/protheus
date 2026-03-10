// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer1/memory_runtime (authoritative)

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LensMapAnnotation {
    pub tags: Vec<String>,
    pub nodes: Vec<String>,
    pub jots: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LensMapAnnotationValidation {
    pub ok: bool,
    pub errors: Vec<String>,
    pub annotation: Option<LensMapAnnotation>,
}

const FIELD_MAX_COUNT: usize = 32;
const TOKEN_MAX_LEN: usize = 64;

fn normalize_token(raw: &str) -> String {
    raw.trim().to_ascii_lowercase()
}

fn token_is_valid(raw: &str) -> bool {
    let token = normalize_token(raw);
    !token.is_empty()
        && token.len() <= TOKEN_MAX_LEN
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/'))
}

fn parse_field(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(normalize_token)
        .filter(|token| !token.is_empty())
        .collect()
}

fn dedupe_ordered(items: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for item in items {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

fn parse_pair(raw: &str) -> Option<(&str, &str)> {
    let (key, value) = raw.split_once('=')?;
    let k = key.trim();
    let v = value.trim();
    if k.is_empty() || v.is_empty() {
        return None;
    }
    Some((k, v))
}

pub fn parse_lensmap_annotation(raw: &str) -> LensMapAnnotationValidation {
    let mut errors = Vec::new();
    let line = raw.trim();
    if line.is_empty() {
        return LensMapAnnotationValidation {
            ok: false,
            errors: vec!["annotation_empty".to_string()],
            annotation: None,
        };
    }

    // Accepted surface: "@lensmap tags=a,b nodes=n1 jot=j1,j2"
    let body = if let Some(rest) = line.strip_prefix("@lensmap") {
        rest.trim()
    } else {
        line
    };
    if body.is_empty() {
        return LensMapAnnotationValidation {
            ok: false,
            errors: vec!["annotation_fields_missing".to_string()],
            annotation: None,
        };
    }

    let mut tags: Vec<String> = Vec::new();
    let mut nodes: Vec<String> = Vec::new();
    let mut jots: Vec<String> = Vec::new();

    for segment in body.split_whitespace() {
        let Some((key, value)) = parse_pair(segment) else {
            errors.push(format!("invalid_segment:{segment}"));
            continue;
        };

        let parsed = parse_field(value);
        if parsed.is_empty() {
            errors.push(format!("empty_field:{key}"));
            continue;
        }

        match key.to_ascii_lowercase().as_str() {
            "tag" | "tags" => tags.extend(parsed),
            "node" | "nodes" => nodes.extend(parsed),
            "jot" | "jots" => jots.extend(parsed),
            other => errors.push(format!("unknown_field:{other}")),
        }
    }

    tags = dedupe_ordered(tags);
    nodes = dedupe_ordered(nodes);
    jots = dedupe_ordered(jots);

    if tags.len() > FIELD_MAX_COUNT {
        errors.push("tags_overflow".to_string());
    }
    if nodes.len() > FIELD_MAX_COUNT {
        errors.push("nodes_overflow".to_string());
    }
    if jots.len() > FIELD_MAX_COUNT {
        errors.push("jots_overflow".to_string());
    }

    for token in tags.iter().chain(nodes.iter()).chain(jots.iter()) {
        if !token_is_valid(token) {
            errors.push(format!("invalid_token:{token}"));
        }
    }

    if tags.is_empty() && nodes.is_empty() && jots.is_empty() {
        errors.push("empty_annotation".to_string());
    }

    if errors.is_empty() {
        LensMapAnnotationValidation {
            ok: true,
            errors,
            annotation: Some(LensMapAnnotation { tags, nodes, jots }),
        }
    } else {
        LensMapAnnotationValidation {
            ok: false,
            errors,
            annotation: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_lensmap_annotation() {
        let out = parse_lensmap_annotation(
            "@lensmap tags=memory,low-burn nodes=recall/v1,hydration jot=token_cap",
        );
        assert!(out.ok);
        let ann = out.annotation.expect("annotation");
        assert_eq!(ann.tags, vec!["memory", "low-burn"]);
        assert_eq!(ann.nodes, vec!["recall/v1", "hydration"]);
        assert_eq!(ann.jots, vec!["token_cap"]);
    }

    #[test]
    fn rejects_unknown_fields_and_bad_tokens() {
        let out = parse_lensmap_annotation("@lensmap labels=a tags=ok??");
        assert!(!out.ok);
        assert!(out
            .errors
            .iter()
            .any(|e| e.starts_with("unknown_field:labels")));
        assert!(out
            .errors
            .iter()
            .any(|e| e.starts_with("invalid_token:ok??")));
    }

    #[test]
    fn dedupes_tokens_in_order() {
        let out = parse_lensmap_annotation("@lensmap tags=a,a,b nodes=n1,n1 jot=j,j");
        assert!(out.ok);
        let ann = out.annotation.expect("annotation");
        assert_eq!(ann.tags, vec!["a", "b"]);
        assert_eq!(ann.nodes, vec!["n1"]);
        assert_eq!(ann.jots, vec!["j"]);
    }

    #[test]
    fn fails_when_annotation_is_empty() {
        let out = parse_lensmap_annotation("   ");
        assert!(!out.ok);
        assert_eq!(out.errors, vec!["annotation_empty".to_string()]);
    }
}
