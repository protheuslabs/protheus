// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer2/ops::spawn_broker (authoritative)
use crate::{deterministic_receipt_hash, now_iso};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
struct PoolPolicy {
    min_cells: i64,
    max_cells: i64,
    reserve_cpu_threads: f64,
    reserve_ram_gb: f64,
    estimated_cpu_threads_per_cell: f64,
    estimated_ram_gb_per_cell: f64,
    max_cells_by_hardware: BTreeMap<String, i64>,
}

#[derive(Debug, Clone)]
struct QuotaPolicy {
    default_max_cells: i64,
    modules: BTreeMap<String, i64>,
}

#[derive(Debug, Clone)]
struct LeasePolicy {
    enabled: bool,
    default_ttl_sec: i64,
    max_ttl_sec: i64,
}

#[derive(Debug, Clone)]
struct SpawnPolicy {
    version: String,
    pool: PoolPolicy,
    quotas: QuotaPolicy,
    leases: LeasePolicy,
}

#[derive(Debug, Clone)]
struct Allocation {
    cells: i64,
    ts: String,
    reason: String,
    lease_expires_at: Option<String>,
}

#[derive(Debug, Clone)]
struct BrokerState {
    version: i64,
    ts: String,
    allocations: BTreeMap<String, Allocation>,
}

#[derive(Debug, Clone)]
struct RouterPlan {
    ok: bool,
    payload: Value,
    error: Option<String>,
    transport: Option<String>,
}

#[derive(Debug, Clone)]
struct HardwareBounds {
    hardware_class: Option<String>,
    cpu_threads: Option<f64>,
    ram_gb: Option<f64>,
    cap_by_class: i64,
    cap_by_cpu: i64,
    cap_by_ram: i64,
    global_max_cells: i64,
}

#[derive(Debug, Clone)]
struct Limits {
    module: String,
    global_max_cells: i64,
    module_quota_max_cells: i64,
    module_current_cells: i64,
    allocated_other_cells: i64,
    allocated_total_cells: i64,
    free_global_cells: i64,
    max_cells: i64,
}

#[derive(Debug, Clone)]
struct AutopauseState {
    active: bool,
    source: Option<String>,
    reason: Option<String>,
    until: Option<String>,
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops spawn-broker status [--module=<name>] [--profile=<id>]");
    println!("  protheus-ops spawn-broker request --module=<name> --requested_cells=<n> [--profile=<id>] [--reason=<text>] [--apply=1|0] [--lease_sec=<n>]");
    println!("  protheus-ops spawn-broker release --module=<name> [--reason=<text>]");
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn receipt_hash(value: &Value) -> String {
    deterministic_receipt_hash(value)
}

fn now_ms() -> i64 {
    let Ok(dur) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return 0;
    };
    i64::try_from(dur.as_millis()).unwrap_or(0)
}

fn clamp_i64(v: i64, lo: i64, hi: i64) -> i64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

fn clamp_f64(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let with_eq = format!("--{key}=");
    let plain = format!("--{key}");
    let mut i = 0usize;
    while i < argv.len() {
        let token = argv[i].trim();
        if let Some(v) = token.strip_prefix(with_eq.as_str()) {
            return Some(v.trim().to_string());
        }
        if token == plain {
            if let Some(next) = argv.get(i + 1) {
                if !next.trim_start().starts_with("--") {
                    return Some(next.trim().to_string());
                }
            }
            return Some("true".to_string());
        }
        i += 1;
    }
    None
}

fn parse_bool(raw: Option<&str>, fallback: bool) -> bool {
    let Some(v) = raw else {
        return fallback;
    };
    match v.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn parse_i64(raw: Option<&str>, fallback: i64) -> i64 {
    raw.and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(fallback)
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent).map_err(|e| format!("mkdir_failed:{}:{e}", parent.display()))
}

fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

fn write_json_atomic(path: &Path, payload: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let tmp = path.with_extension(format!("tmp-{}-{}", std::process::id(), now_ms().max(0)));
    let encoded = serde_json::to_string_pretty(payload).unwrap_or_else(|_| "{}".to_string()) + "\n";
    fs::write(&tmp, encoded).map_err(|e| format!("write_tmp_failed:{}:{e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        format!(
            "rename_tmp_failed:{}=>{}:{e}",
            tmp.display(),
            path.display()
        )
    })
}

fn append_jsonl(path: &Path, payload: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let line = serde_json::to_string(payload).unwrap_or_else(|_| "{}".to_string()) + "\n";
    let mut opts = fs::OpenOptions::new();
    opts.create(true).append(true);
    let mut file = opts
        .open(path)
        .map_err(|e| format!("open_append_failed:{}:{e}", path.display()))?;
    use std::io::Write;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("append_failed:{}:{e}", path.display()))
}

fn root_client_runtime(root: &Path) -> PathBuf {
    root.join("client").join("runtime")
}

fn policy_path(root: &Path) -> PathBuf {
    if let Ok(v) = std::env::var("SPAWN_POLICY_PATH") {
        let s = v.trim();
        if !s.is_empty() {
            let p = PathBuf::from(s);
            if p.is_absolute() {
                return p;
            }
            return root.join(p);
        }
    }
    root_client_runtime(root)
        .join("config")
        .join("spawn_policy.json")
}

fn state_dir(root: &Path) -> PathBuf {
    if let Ok(v) = std::env::var("SPAWN_STATE_DIR") {
        let s = v.trim();
        if !s.is_empty() {
            let p = PathBuf::from(s);
            if p.is_absolute() {
                return p;
            }
            return root.join(p);
        }
    }
    root_client_runtime(root)
        .join("local")
        .join("state")
        .join("spawn")
}

fn state_path(root: &Path) -> PathBuf {
    state_dir(root).join("allocations.json")
}

fn events_path(root: &Path) -> PathBuf {
    state_dir(root).join("events.jsonl")
}

fn router_script_path(root: &Path) -> PathBuf {
    if let Ok(v) = std::env::var("SPAWN_ROUTER_SCRIPT") {
        let s = v.trim();
        if !s.is_empty() {
            let p = PathBuf::from(s);
            if p.is_absolute() {
                return p;
            }
            return root.join(p);
        }
    }
    root_client_runtime(root)
        .join("systems")
        .join("routing")
        .join("model_router.js")
}

fn autopause_path(root: &Path) -> PathBuf {
    if let Ok(v) = std::env::var("SPAWN_TOKEN_BUDGET_AUTOPAUSE_PATH") {
        let s = v.trim();
        if !s.is_empty() {
            let p = PathBuf::from(s);
            if p.is_absolute() {
                return p;
            }
            return root.join(p);
        }
    }
    root_client_runtime(root)
        .join("local")
        .join("state")
        .join("autonomy")
        .join("budget_autopause.json")
}

fn default_policy() -> SpawnPolicy {
    let mut class_caps = BTreeMap::new();
    class_caps.insert("tiny".to_string(), 1);
    class_caps.insert("small".to_string(), 2);
    class_caps.insert("medium".to_string(), 3);
    class_caps.insert("large".to_string(), 4);
    class_caps.insert("xlarge".to_string(), 6);
    SpawnPolicy {
        version: "1.0".to_string(),
        pool: PoolPolicy {
            min_cells: 0,
            max_cells: 6,
            reserve_cpu_threads: 2.0,
            reserve_ram_gb: 4.0,
            estimated_cpu_threads_per_cell: 1.0,
            estimated_ram_gb_per_cell: 1.2,
            max_cells_by_hardware: class_caps,
        },
        quotas: QuotaPolicy {
            default_max_cells: 2,
            modules: BTreeMap::new(),
        },
        leases: LeasePolicy {
            enabled: true,
            default_ttl_sec: 300,
            max_ttl_sec: 3600,
        },
    }
}

fn load_policy(root: &Path) -> SpawnPolicy {
    let mut out = default_policy();
    let path = policy_path(root);
    let Some(raw) = read_json(&path) else {
        return out;
    };

    if let Some(version) = raw.get("version").and_then(Value::as_str) {
        out.version = version.trim().to_string();
    }
    if let Some(pool) = raw.get("pool").and_then(Value::as_object) {
        out.pool.min_cells = clamp_i64(
            pool.get("min_cells")
                .and_then(Value::as_i64)
                .unwrap_or(out.pool.min_cells),
            0,
            4096,
        );
        out.pool.max_cells = clamp_i64(
            pool.get("max_cells")
                .and_then(Value::as_i64)
                .unwrap_or(out.pool.max_cells),
            out.pool.min_cells,
            8192,
        );
        out.pool.reserve_cpu_threads = clamp_f64(
            pool.get("reserve_cpu_threads")
                .and_then(Value::as_f64)
                .unwrap_or(out.pool.reserve_cpu_threads),
            0.0,
            4096.0,
        );
        out.pool.reserve_ram_gb = clamp_f64(
            pool.get("reserve_ram_gb")
                .and_then(Value::as_f64)
                .unwrap_or(out.pool.reserve_ram_gb),
            0.0,
            4096.0,
        );
        out.pool.estimated_cpu_threads_per_cell = clamp_f64(
            pool.get("estimated_cpu_threads_per_cell")
                .and_then(Value::as_f64)
                .unwrap_or(out.pool.estimated_cpu_threads_per_cell),
            0.1,
            512.0,
        );
        out.pool.estimated_ram_gb_per_cell = clamp_f64(
            pool.get("estimated_ram_gb_per_cell")
                .and_then(Value::as_f64)
                .unwrap_or(out.pool.estimated_ram_gb_per_cell),
            0.1,
            512.0,
        );
        if let Some(map) = pool.get("max_cells_by_hardware").and_then(Value::as_object) {
            let mut next = BTreeMap::new();
            for (k, v) in map {
                let n = v.as_i64().unwrap_or(out.pool.max_cells);
                next.insert(
                    k.trim().to_ascii_lowercase(),
                    clamp_i64(n, 0, out.pool.max_cells),
                );
            }
            if !next.is_empty() {
                out.pool.max_cells_by_hardware = next;
            }
        }
    }
    if let Some(quotas) = raw.get("quotas").and_then(Value::as_object) {
        out.quotas.default_max_cells = clamp_i64(
            quotas
                .get("default_max_cells")
                .and_then(Value::as_i64)
                .unwrap_or(out.quotas.default_max_cells),
            0,
            out.pool.max_cells,
        );
        if let Some(modules) = quotas.get("modules").and_then(Value::as_object) {
            let mut next = BTreeMap::new();
            for (name, row) in modules {
                let max_cells = row
                    .as_object()
                    .and_then(|obj| obj.get("max_cells"))
                    .and_then(Value::as_i64)
                    .unwrap_or(out.quotas.default_max_cells);
                next.insert(
                    name.trim().to_ascii_lowercase(),
                    clamp_i64(max_cells, 0, out.pool.max_cells),
                );
            }
            out.quotas.modules = next;
        }
    }
    if let Some(leases) = raw.get("leases").and_then(Value::as_object) {
        out.leases.enabled = leases
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(out.leases.enabled);
        out.leases.default_ttl_sec = clamp_i64(
            leases
                .get("default_ttl_sec")
                .and_then(Value::as_i64)
                .unwrap_or(out.leases.default_ttl_sec),
            5,
            172800,
        );
        out.leases.max_ttl_sec = clamp_i64(
            leases
                .get("max_ttl_sec")
                .and_then(Value::as_i64)
                .unwrap_or(out.leases.max_ttl_sec),
            out.leases.default_ttl_sec,
            172800,
        );
    }
    out
}

fn default_state() -> BrokerState {
    BrokerState {
        version: 1,
        ts: now_iso(),
        allocations: BTreeMap::new(),
    }
}

fn parse_allocation(raw: &Value) -> Option<Allocation> {
    let obj = raw.as_object()?;
    Some(Allocation {
        cells: clamp_i64(
            obj.get("cells").and_then(Value::as_i64).unwrap_or(0),
            0,
            4096,
        ),
        ts: obj
            .get("ts")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        reason: obj
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        lease_expires_at: obj
            .get("lease_expires_at")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    })
}

fn load_state(root: &Path) -> BrokerState {
    let path = state_path(root);
    let Some(raw) = read_json(&path) else {
        return default_state();
    };
    let Some(obj) = raw.as_object() else {
        return default_state();
    };
    let mut state = default_state();
    state.version = obj.get("version").and_then(Value::as_i64).unwrap_or(1);
    state.ts = obj
        .get("ts")
        .and_then(Value::as_str)
        .unwrap_or(&state.ts)
        .trim()
        .to_string();
    if let Some(allocs) = obj.get("allocations").and_then(Value::as_object) {
        let mut out = BTreeMap::new();
        for (name, row) in allocs {
            if let Some(parsed) = parse_allocation(row) {
                out.insert(name.trim().to_ascii_lowercase(), parsed);
            }
        }
        state.allocations = out;
    }
    state
}

fn state_to_value(state: &BrokerState) -> Value {
    let mut allocs = serde_json::Map::new();
    for (name, row) in &state.allocations {
        allocs.insert(
            name.clone(),
            json!({
                "module": name,
                "cells": row.cells,
                "ts": row.ts,
                "reason": row.reason,
                "lease_expires_at": row.lease_expires_at
            }),
        );
    }
    json!({
        "version": state.version,
        "ts": state.ts,
        "allocations": Value::Object(allocs)
    })
}

fn save_state(root: &Path, state: &BrokerState) -> Result<(), String> {
    write_json_atomic(&state_path(root), &state_to_value(state))
}

fn parse_iso_ms(raw: &str) -> Option<i64> {
    let dt = DateTime::parse_from_rfc3339(raw).ok()?;
    Some(dt.timestamp_millis())
}

fn is_expired(iso: &Option<String>) -> bool {
    let Some(v) = iso else {
        return false;
    };
    let Some(ms) = parse_iso_ms(v.as_str()) else {
        return false;
    };
    ms <= now_ms()
}

fn prune_expired(mut state: BrokerState) -> (BrokerState, bool) {
    let before = state.allocations.len();
    state
        .allocations
        .retain(|_, row| !is_expired(&row.lease_expires_at));
    let changed = state.allocations.len() != before;
    if changed {
        state.ts = now_iso();
    }
    (state, changed)
}

fn parse_json_line_fallback(stdout: &str) -> Value {
    if let Ok(v) = serde_json::from_str::<Value>(stdout.trim()) {
        return v;
    }
    for line in stdout.lines().rev() {
        let s = line.trim();
        if !s.starts_with('{') {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(s) {
            return v;
        }
    }
    Value::Null
}

fn router_hardware_plan(root: &Path) -> RouterPlan {
    let script = router_script_path(root);
    let cwd = root_client_runtime(root);
    let node_bin = std::env::var("PROTHEUS_NODE_BINARY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "node".to_string());
    let run = Command::new(node_bin)
        .arg(script.to_string_lossy().to_string())
        .arg("hardware-plan")
        .current_dir(cwd)
        .output();
    let Ok(out) = run else {
        return RouterPlan {
            ok: false,
            payload: Value::Null,
            error: Some("spawn_router_exec_failed".to_string()),
            transport: Some("spawn_sync".to_string()),
        };
    };
    let status = out.status.code().unwrap_or(1);
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if status != 0 {
        return RouterPlan {
            ok: false,
            payload: Value::Null,
            error: Some(format!("hardware_plan_failed:{}", stderr.trim())),
            transport: Some("spawn_sync".to_string()),
        };
    }
    let payload = parse_json_line_fallback(&stdout);
    RouterPlan {
        ok: true,
        payload,
        error: None,
        transport: Some("spawn_sync".to_string()),
    }
}

fn hardware_bounds(policy: &SpawnPolicy, payload: &Value) -> HardwareBounds {
    let profile = payload.get("profile").and_then(Value::as_object);
    let hw_class = profile
        .and_then(|p| p.get("hardware_class"))
        .and_then(Value::as_str)
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());
    let cpu_threads = profile
        .and_then(|p| p.get("cpu_threads"))
        .and_then(Value::as_f64);
    let ram_gb = profile
        .and_then(|p| p.get("ram_gb"))
        .and_then(Value::as_f64);

    let class_cap = hw_class
        .as_ref()
        .and_then(|c| policy.pool.max_cells_by_hardware.get(c))
        .copied()
        .unwrap_or(policy.pool.max_cells);

    let cap_by_cpu = if let Some(cpu) = cpu_threads {
        let free = (cpu - policy.pool.reserve_cpu_threads).max(0.0);
        ((free / policy.pool.estimated_cpu_threads_per_cell).floor() as i64).max(0)
    } else {
        policy.pool.max_cells
    };
    let cap_by_ram = if let Some(ram) = ram_gb {
        let free = (ram - policy.pool.reserve_ram_gb).max(0.0);
        ((free / policy.pool.estimated_ram_gb_per_cell).floor() as i64).max(0)
    } else {
        policy.pool.max_cells
    };

    let global_max = std::cmp::max(
        policy.pool.min_cells,
        std::cmp::min(
            policy.pool.max_cells,
            std::cmp::min(class_cap, std::cmp::min(cap_by_cpu, cap_by_ram)),
        ),
    );

    HardwareBounds {
        hardware_class: hw_class,
        cpu_threads,
        ram_gb,
        cap_by_class: class_cap,
        cap_by_cpu,
        cap_by_ram,
        global_max_cells: global_max,
    }
}

fn normalize_module_name(raw: Option<String>) -> String {
    let out = raw.unwrap_or_else(|| "reflex".to_string());
    let n = out.trim().to_ascii_lowercase();
    if n.is_empty() {
        "reflex".to_string()
    } else {
        n
    }
}

fn module_quota_max(policy: &SpawnPolicy, module: &str, global_max: i64) -> i64 {
    let raw = policy
        .quotas
        .modules
        .get(module)
        .copied()
        .unwrap_or(policy.quotas.default_max_cells);
    clamp_i64(raw, 0, global_max)
}

fn cells_for(state: &BrokerState, module: &str) -> i64 {
    state
        .allocations
        .get(module)
        .map(|r| r.cells)
        .unwrap_or(0)
        .max(0)
}

fn sum_allocations(state: &BrokerState, skip_module: &str) -> i64 {
    state
        .allocations
        .iter()
        .filter(|(name, _)| name.as_str() != skip_module)
        .map(|(_, row)| row.cells.max(0))
        .sum::<i64>()
}

fn compute_limits(
    policy: &SpawnPolicy,
    state: &BrokerState,
    module: &str,
    bounds: &HardwareBounds,
) -> Limits {
    let global_max = bounds.global_max_cells.max(0);
    let current = cells_for(state, module);
    let allocated_other = sum_allocations(state, module);
    let allocated_total = allocated_other + current;
    let free_with_current = (global_max - allocated_other).max(0);
    let free_global = (global_max - allocated_total).max(0);
    let module_quota = module_quota_max(policy, module, global_max);
    let max_cells = std::cmp::max(0, std::cmp::min(module_quota, free_with_current));
    Limits {
        module: module.to_string(),
        global_max_cells: global_max,
        module_quota_max_cells: module_quota,
        module_current_cells: current,
        allocated_other_cells: allocated_other,
        allocated_total_cells: allocated_total,
        free_global_cells: free_global,
        max_cells,
    }
}

fn summarize_allocations(state: &BrokerState) -> Value {
    let mut map = serde_json::Map::new();
    for (name, row) in &state.allocations {
        map.insert(
            name.clone(),
            json!({
                "cells": row.cells.max(0),
                "ts": row.ts,
                "reason": row.reason,
                "lease_expires_at": row.lease_expires_at
            }),
        );
    }
    Value::Object(map)
}

fn resolve_profile(argv: &[String]) -> String {
    let raw = parse_flag(argv, "profile")
        .or_else(|| parse_flag(argv, "spawn_profile"))
        .unwrap_or_else(|| "standard".to_string());
    let mut out = String::with_capacity(raw.len());
    let mut prev_us = false;
    for ch in raw.trim().to_ascii_lowercase().chars() {
        let keep = ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '/' | '-');
        if keep {
            out.push(ch);
            prev_us = false;
        } else if !prev_us {
            out.push('_');
            prev_us = true;
        }
    }
    let cleaned = out.trim_matches('_').to_string();
    if cleaned.is_empty() {
        "standard".to_string()
    } else {
        cleaned
    }
}

fn resolve_lease_expiry(policy: &LeasePolicy, argv: &[String]) -> Option<String> {
    if !policy.enabled {
        return None;
    }
    let ttl = parse_i64(
        parse_flag(argv, "lease_sec")
            .or_else(|| parse_flag(argv, "lease"))
            .as_deref(),
        policy.default_ttl_sec,
    );
    let ttl = clamp_i64(ttl, 5, policy.max_ttl_sec);
    let ms = now_ms().saturating_add(ttl.saturating_mul(1000));
    DateTime::<Utc>::from_timestamp_millis(ms).map(|dt| dt.to_rfc3339())
}

fn load_autopause(root: &Path) -> AutopauseState {
    let path = autopause_path(root);
    let raw = read_json(&path);
    let mut active = false;
    let mut source = None;
    let mut reason = None;
    let mut until = None;
    if let Some(obj) = raw.and_then(|v| v.as_object().cloned()) {
        source = obj
            .get("source")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        reason = obj
            .get("reason")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        until = obj
            .get("until")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let until_ms = obj.get("until_ms").and_then(Value::as_i64).unwrap_or(0);
        active = obj.get("active").and_then(Value::as_bool).unwrap_or(false) && until_ms > now_ms();
    }
    AutopauseState {
        active,
        source,
        reason,
        until,
    }
}

fn limits_to_value(limits: &Limits) -> Value {
    json!({
        "module": limits.module,
        "global_max_cells": limits.global_max_cells,
        "module_quota_max_cells": limits.module_quota_max_cells,
        "module_current_cells": limits.module_current_cells,
        "allocated_other_cells": limits.allocated_other_cells,
        "allocated_total_cells": limits.allocated_total_cells,
        "free_global_cells": limits.free_global_cells,
        "max_cells": limits.max_cells
    })
}

fn bounds_to_value(bounds: &HardwareBounds) -> Value {
    json!({
        "hardware_class": bounds.hardware_class,
        "cpu_threads": bounds.cpu_threads,
        "ram_gb": bounds.ram_gb,
        "cap_by_class": bounds.cap_by_class,
        "cap_by_cpu": bounds.cap_by_cpu,
        "cap_by_ram": bounds.cap_by_ram,
        "global_max_cells": bounds.global_max_cells
    })
}

fn policy_to_value(policy: &SpawnPolicy) -> Value {
    let mut modules = serde_json::Map::new();
    for (name, max_cells) in &policy.quotas.modules {
        modules.insert(name.clone(), json!({ "max_cells": max_cells }));
    }
    let mut by_hw = serde_json::Map::new();
    for (name, cap) in &policy.pool.max_cells_by_hardware {
        by_hw.insert(name.clone(), json!(cap));
    }
    json!({
        "version": policy.version,
        "pool": {
            "min_cells": policy.pool.min_cells,
            "max_cells": policy.pool.max_cells,
            "reserve_cpu_threads": policy.pool.reserve_cpu_threads,
            "reserve_ram_gb": policy.pool.reserve_ram_gb,
            "estimated_cpu_threads_per_cell": policy.pool.estimated_cpu_threads_per_cell,
            "estimated_ram_gb_per_cell": policy.pool.estimated_ram_gb_per_cell,
            "max_cells_by_hardware": by_hw
        },
        "quotas": {
            "default_max_cells": policy.quotas.default_max_cells,
            "modules": modules
        },
        "leases": {
            "enabled": policy.leases.enabled,
            "default_ttl_sec": policy.leases.default_ttl_sec,
            "max_ttl_sec": policy.leases.max_ttl_sec
        }
    })
}

fn cmd_status(root: &Path, argv: &[String]) -> i32 {
    let module = normalize_module_name(parse_flag(argv, "module"));
    let profile = resolve_profile(argv);
    let policy = load_policy(root);
    let (mut state, changed) = prune_expired(load_state(root));
    if changed {
        let _ = save_state(root, &state);
    }
    if state.ts.is_empty() {
        state.ts = now_iso();
    }

    let plan = router_hardware_plan(root);
    let bounds = hardware_bounds(&policy, &plan.payload);
    let limits = compute_limits(&policy, &state, &module, &bounds);
    let autopause = load_autopause(root);

    let mut out = json!({
        "ok": true,
        "ts": now_iso(),
        "module": module,
        "profile": profile,
        "policy": policy_to_value(&policy),
        "state": {
            "version": state.version,
            "ts": state.ts,
            "allocations": summarize_allocations(&state)
        },
        "limits": limits_to_value(&limits),
        "token_budget": {
            "enabled": false,
            "allow": true,
            "action": "allow",
            "reason": null
        },
        "budget_autopause": {
            "active": autopause.active,
            "source": autopause.source,
            "reason": autopause.reason,
            "until": autopause.until
        },
        "budget_guard": {
            "hard_stop": false,
            "hard_stop_reasons": [],
            "soft_pressure": false
        },
        "hardware_plan_ok": plan.ok,
        "hardware_plan_error": plan.error,
        "hardware_plan_transport": plan.transport,
        "hardware_bounds": bounds_to_value(&bounds)
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    print_json_line(&out);
    0
}

fn cmd_request(root: &Path, argv: &[String]) -> i32 {
    let module = normalize_module_name(parse_flag(argv, "module"));
    let profile = resolve_profile(argv);
    let requested_cells = clamp_i64(
        parse_i64(
            parse_flag(argv, "requested_cells")
                .or_else(|| parse_flag(argv, "requested"))
                .as_deref(),
            0,
        ),
        0,
        4096,
    );
    let reason = parse_flag(argv, "reason")
        .unwrap_or_default()
        .trim()
        .chars()
        .take(160)
        .collect::<String>();
    let apply = parse_bool(parse_flag(argv, "apply").as_deref(), true);
    let policy = load_policy(root);
    let (mut state, changed) = prune_expired(load_state(root));
    if changed {
        let _ = save_state(root, &state);
    }

    let plan = router_hardware_plan(root);
    let bounds = hardware_bounds(&policy, &plan.payload);
    let limits = compute_limits(&policy, &state, &module, &bounds);
    let autopause = load_autopause(root);
    if autopause.active {
        let mut blocked = json!({
            "ok": true,
            "ts": now_iso(),
            "module": module,
            "profile": profile,
            "apply": apply,
            "requested_cells": requested_cells,
            "granted_cells": 0,
            "requested_tokens_est": 0,
            "reason": "budget_autopause_active",
            "blocked_by_budget": true,
            "lineage_contract": null,
            "lineage_error": null,
            "lease_expires_at": null,
            "limits": limits_to_value(&limits),
            "token_budget": {
              "enabled": true,
              "allow": false,
              "action": "escalate",
              "reason": "budget_autopause_active"
            },
            "budget_autopause": {
                "active": true,
                "source": autopause.source,
                "reason": autopause.reason,
                "until": autopause.until
            },
            "budget_guard": {
              "hard_stop": true,
              "hard_stop_reasons": ["budget_autopause_active"],
              "soft_pressure": false
            },
            "hardware_plan_ok": plan.ok,
            "hardware_plan_error": plan.error,
            "hardware_plan_transport": plan.transport,
            "hardware_bounds": bounds_to_value(&bounds)
        });
        blocked["receipt_hash"] = Value::String(receipt_hash(&blocked));
        let _ = append_jsonl(
            &events_path(root),
            &json!({
                "ts": now_iso(),
                "type": "spawn_request_blocked_budget",
                "module": module,
                "profile": profile,
                "requested_cells": requested_cells,
                "reason": "budget_autopause_active"
            }),
        );
        print_json_line(&blocked);
        return 0;
    }

    let granted_cells = std::cmp::max(0, std::cmp::min(requested_cells, limits.max_cells));
    let lease_expires_at = resolve_lease_expiry(&policy.leases, argv);

    if apply {
        if granted_cells <= 0 {
            state.allocations.remove(&module);
        } else {
            state.allocations.insert(
                module.clone(),
                Allocation {
                    cells: granted_cells,
                    ts: now_iso(),
                    reason: reason.clone(),
                    lease_expires_at: lease_expires_at.clone(),
                },
            );
        }
        state.version = 1;
        state.ts = now_iso();
        let _ = save_state(root, &state);
        let _ = append_jsonl(
            &events_path(root),
            &json!({
                "ts": now_iso(),
                "type": "spawn_request",
                "module": module,
                "profile": profile,
                "requested_cells": requested_cells,
                "granted_cells": granted_cells,
                "reason": if reason.is_empty() { Value::Null } else { Value::String(reason.clone()) },
                "lease_expires_at": lease_expires_at
            }),
        );
    }

    let mut out = json!({
        "ok": true,
        "ts": now_iso(),
        "module": module,
        "profile": profile,
        "apply": apply,
        "requested_cells": requested_cells,
        "granted_cells": granted_cells,
        "requested_tokens_est": 0,
        "reason": if reason.is_empty() { Value::Null } else { Value::String(reason.clone()) },
        "lineage_contract": null,
        "lineage_error": null,
        "lease_expires_at": lease_expires_at,
        "limits": limits_to_value(&limits),
        "token_budget": {
          "enabled": false,
          "allow": true,
          "action": "allow",
          "reason": null
        },
        "hardware_plan_ok": plan.ok,
        "hardware_plan_error": plan.error,
        "hardware_plan_transport": plan.transport,
        "hardware_bounds": bounds_to_value(&bounds)
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    print_json_line(&out);
    0
}

fn cmd_release(root: &Path, argv: &[String]) -> i32 {
    let module = normalize_module_name(parse_flag(argv, "module"));
    let reason = parse_flag(argv, "reason")
        .unwrap_or_else(|| "release".to_string())
        .trim()
        .chars()
        .take(160)
        .collect::<String>();

    let mut state = load_state(root);
    let prev = state.allocations.get(&module).map(|r| r.cells).unwrap_or(0);
    state.allocations.remove(&module);
    state.version = 1;
    state.ts = now_iso();
    let _ = save_state(root, &state);
    let _ = append_jsonl(
        &events_path(root),
        &json!({
            "ts": now_iso(),
            "type": "spawn_release",
            "module": module,
            "previous_cells": prev,
            "reason": reason
        }),
    );

    let mut out = json!({
        "ok": true,
        "ts": now_iso(),
        "module": module,
        "released_cells": prev,
        "reason": reason
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    print_json_line(&out);
    0
}

fn cli_error(argv: &[String], err: &str, exit_code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "spawn_broker_cli_error",
        "ts": now_iso(),
        "argv": argv,
        "error": err,
        "exit_code": exit_code
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let cmd = argv
        .iter()
        .find(|arg| !arg.trim().starts_with("--"))
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if cmd.is_empty() || matches!(cmd.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }
    match cmd.as_str() {
        "status" => cmd_status(root, argv),
        "request" => cmd_request(root, argv),
        "release" => cmd_release(root, argv),
        _ => {
            usage();
            print_json_line(&cli_error(argv, "unknown_command", 2));
            2
        }
    }
}
