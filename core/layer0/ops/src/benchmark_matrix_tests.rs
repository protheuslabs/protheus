use super::*;
use tempfile::tempdir;

#[test]
fn bar_fill_inverts_when_lower_is_better() {
    let width = 20;
    let best = bar_fill(10.0, 10.0, 100.0, width, true);
    let worst = bar_fill(100.0, 10.0, 100.0, width, true);
    assert_eq!(best, width);
    assert_eq!(worst, 1);
}

#[test]
fn bar_fill_prefers_higher_when_higher_is_better() {
    let width = 20;
    let high = bar_fill(16.0, 1.0, 16.0, width, false);
    let low = bar_fill(1.0, 1.0, 16.0, width, false);
    assert_eq!(high, width);
    assert_eq!(low, 1);
}

#[test]
fn merge_projects_replaces_openclaw_entry() {
    let snapshot = json!({
        "projects": {
            "OpenClaw": {"cold_start_ms": 5980.0},
            "OpenFang": {"cold_start_ms": 180.0}
        }
    });
    let mut measured = Map::<String, Value>::new();
    measured.insert("cold_start_ms".to_string(), json!(253.0));
    measured.insert("measured".to_string(), Value::Bool(true));

    let projects = merge_projects(&snapshot, &measured).expect("merge");
    let openclaw = projects
        .get("OpenClaw")
        .and_then(Value::as_object)
        .expect("openclaw object");
    assert_eq!(
        openclaw.get("cold_start_ms").and_then(Value::as_f64),
        Some(253.0)
    );
    assert_eq!(
        openclaw.get("measured").and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn extract_top1_snapshot_metrics_reads_runtime_snapshot_shape() {
    let snapshot = json!({
        "metrics": {
            "cold_start_ms": 74.5,
            "idle_rss_mb": 22.1,
            "install_size_mb": 126.4
        }
    });

    assert_eq!(
        extract_top1_snapshot_metrics(&snapshot),
        Some((74.5, 22.1, 126.4))
    );
}

#[test]
fn runtime_metrics_falls_back_to_top1_snapshot_when_runtime_floor_state_is_missing() {
    let root = tempdir().expect("tempdir");
    let benchmark_snapshot = root.path().join(TOP1_BENCHMARK_SNAPSHOT_REL);
    if let Some(parent) = benchmark_snapshot.parent() {
        fs::create_dir_all(parent).expect("create benchmark dir");
    }
    fs::write(
        &benchmark_snapshot,
        serde_json::to_string_pretty(&json!({
            "metrics": {
                "cold_start_ms": 61.2,
                "idle_rss_mb": 19.8,
                "install_size_mb": 111.4
            }
        }))
        .expect("encode snapshot"),
    )
    .expect("write snapshot");

    let (cold_start_ms, idle_rss_mb, install_size_mb, runtime_json, source_meta) =
        runtime_metrics(root.path(), false).expect("runtime metrics");

    assert_eq!(
        (cold_start_ms, idle_rss_mb, install_size_mb),
        (61.2, 19.8, 111.4)
    );
    assert_eq!(
        source_meta.get("mode").and_then(Value::as_str),
        Some("top1_benchmark_snapshot")
    );
    assert_eq!(
        runtime_json
            .get("metrics")
            .and_then(|v| v.get("cold_start_ms"))
            .and_then(Value::as_f64),
        Some(61.2)
    );
}
