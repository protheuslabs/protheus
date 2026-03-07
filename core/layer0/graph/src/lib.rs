// SPDX-License-Identifier: Apache-2.0
mod blob;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

pub use blob::{
    decode_manifest, fold_blob, generate_manifest, load_embedded_graph_policy, GraphRuntimePolicy,
    GRAPH_POLICY_BLOB_ID,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphNode {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub condition: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphWorkflow {
    pub workflow_id: String,
    #[serde(default)]
    pub nodes: Vec<GraphNode>,
    #[serde(default)]
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphReceipt {
    pub workflow_id: String,
    pub ordered_nodes: Vec<String>,
    pub step_count: usize,
    pub cyclic: bool,
    pub policy_id: String,
    pub digest: String,
    pub warnings: Vec<String>,
}

fn normalize_id(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        "unnamed_node".to_string()
    } else {
        trimmed.to_string()
    }
}

fn topo_order(nodes: &[GraphNode], edges: &[GraphEdge]) -> (Vec<String>, bool) {
    let mut incoming: BTreeMap<String, usize> = BTreeMap::new();
    let mut outgoing: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for node in nodes {
        let id = normalize_id(&node.id);
        incoming.entry(id.clone()).or_insert(0);
        outgoing.entry(id).or_default();
    }

    for edge in edges {
        let from = normalize_id(&edge.from);
        let to = normalize_id(&edge.to);
        if !incoming.contains_key(&from) || !incoming.contains_key(&to) {
            continue;
        }
        outgoing.entry(from).or_default().push(to.clone());
        *incoming.entry(to).or_insert(0) += 1;
    }

    let mut ready = incoming
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(id, _)| id.to_string())
        .collect::<Vec<_>>();
    ready.sort();

    let mut queue = VecDeque::from(ready);
    let mut ordered = Vec::<String>::new();

    while let Some(node) = queue.pop_front() {
        ordered.push(node.clone());
        let mut targets = outgoing.get(&node).cloned().unwrap_or_default();
        targets.sort();
        for to in targets {
            if let Some(entry) = incoming.get_mut(&to) {
                if *entry > 0 {
                    *entry -= 1;
                    if *entry == 0 {
                        queue.push_back(to);
                    }
                }
            }
        }
    }

    let cyclic = ordered.len() != nodes.len();
    if cyclic {
        let ordered_set = ordered.iter().cloned().collect::<BTreeSet<_>>();
        let mut remaining = nodes
            .iter()
            .map(|n| normalize_id(&n.id))
            .filter(|id| !ordered_set.contains(id))
            .collect::<Vec<_>>();
        remaining.sort();
        ordered.extend(remaining);
    }

    (ordered, cyclic)
}

fn digest_receipt(
    workflow_id: &str,
    ordered: &[String],
    cyclic: bool,
    warnings: &[String],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(workflow_id.as_bytes());
    for (idx, node) in ordered.iter().enumerate() {
        hasher.update(format!("{}:{}|", idx, node).as_bytes());
    }
    hasher.update(cyclic.to_string().as_bytes());
    for warning in warnings {
        hasher.update(warning.as_bytes());
    }
    hex::encode(hasher.finalize())
}

pub fn run_workflow(yaml: &str) -> Result<GraphReceipt, String> {
    let policy = load_embedded_graph_policy().map_err(|e| e.to_string())?;
    let workflow: GraphWorkflow =
        serde_yaml::from_str(yaml).map_err(|e| format!("workflow_parse_failed:{e}"))?;

    let mut warnings = Vec::<String>::new();
    if workflow.nodes.len() > policy.max_nodes {
        warnings.push("node_count_above_policy_cap".to_string());
    }
    if workflow.edges.len() > policy.max_edges {
        warnings.push("edge_count_above_policy_cap".to_string());
    }

    let (ordered_nodes, cyclic) = topo_order(&workflow.nodes, &workflow.edges);
    if cyclic && !policy.allow_cycles {
        warnings.push("cycle_detected_under_non_cycle_policy".to_string());
    }

    let digest = digest_receipt(&workflow.workflow_id, &ordered_nodes, cyclic, &warnings);

    Ok(GraphReceipt {
        workflow_id: workflow.workflow_id,
        step_count: ordered_nodes.len(),
        ordered_nodes,
        cyclic,
        policy_id: policy.policy_id,
        digest,
        warnings,
    })
}

pub fn run_workflow_json(yaml: &str) -> Result<String, String> {
    let receipt = run_workflow(yaml)?;
    serde_json::to_string(&receipt).map_err(|e| format!("receipt_encode_failed:{e}"))
}

pub fn viz_dot(yaml: &str) -> Result<String, String> {
    let workflow: GraphWorkflow =
        serde_yaml::from_str(yaml).map_err(|e| format!("workflow_parse_failed:{e}"))?;
    let mut lines = Vec::<String>::new();
    lines.push(format!(
        "digraph {} {{",
        normalize_id(&workflow.workflow_id)
    ));
    let mut seen = BTreeSet::<String>::new();
    for node in &workflow.nodes {
        let id = normalize_id(&node.id);
        if seen.insert(id.clone()) {
            lines.push(format!("  \"{}\" [label=\"{}:{}\"];", id, id, node.kind));
        }
    }
    for edge in &workflow.edges {
        let from = normalize_id(&edge.from);
        let to = normalize_id(&edge.to);
        lines.push(format!("  \"{}\" -> \"{}\";", from, to));
    }
    lines.push("}".to_string());
    Ok(lines.join("\n"))
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn graph_run_workflow_wasm(yaml: &str) -> String {
    match run_workflow_json(yaml) {
        Ok(v) => v,
        Err(err) => serde_json::json!({ "ok": false, "error": err }).to_string(),
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn graph_viz_wasm(yaml: &str) -> String {
    match viz_dot(yaml) {
        Ok(v) => v,
        Err(err) => serde_json::json!({ "ok": false, "error": err }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workflow_yaml() -> String {
        serde_json::json!({
            "workflow_id": "graph_demo",
            "nodes": [
                {"id": "collect", "kind": "task"},
                {"id": "score", "kind": "task"},
                {"id": "ship", "kind": "task"}
            ],
            "edges": [
                {"from": "collect", "to": "score"},
                {"from": "score", "to": "ship"}
            ]
        })
        .to_string()
    }

    #[test]
    fn workflow_orders_nodes() {
        let receipt = run_workflow(&workflow_yaml()).expect("run");
        assert_eq!(receipt.ordered_nodes, vec!["collect", "score", "ship"]);
        assert!(!receipt.cyclic);
    }

    #[test]
    fn viz_contains_edges() {
        let dot = viz_dot(&workflow_yaml()).expect("dot");
        assert!(dot.contains("collect"));
        assert!(dot.contains("score"));
    }
}
