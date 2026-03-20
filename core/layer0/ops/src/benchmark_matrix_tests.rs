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
fn extract_runtime_metrics_prefers_p50_when_available() {
    let runtime = json!({
        "metrics": {
            "cold_start_p50_ms": 12.3,
            "cold_start_p95_ms": 55.0,
            "idle_rss_p50_mb": 4.2,
            "idle_rss_p95_mb": 8.9,
            "full_install_total_mb": 33.1
        }
    });

    assert_eq!(extract_runtime_metrics(&runtime), Some((12.3, 4.2, 33.1)));
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

#[test]
fn stabilized_tasks_per_sec_discards_warmup_outliers() {
    let mut samples = vec![2400.0, 2600.0, 7750.0, 7800.0, 7700.0, 7850.0, 7725.0].into_iter();
    let median = stabilized_tasks_per_sec_with(5, 2, || samples.next().expect("sample"));
    assert_eq!(median, 7750.0);
}

#[test]
fn attach_shared_throughput_marks_shared_baseline_source() {
    let mut measured = Map::<String, Value>::new();
    attach_shared_throughput(&mut measured, 7777.0);
    assert_eq!(
        measured.get("tasks_per_sec").and_then(Value::as_f64),
        Some(7777.0)
    );
    assert_eq!(
        measured.get("throughput_source").and_then(Value::as_str),
        Some(SHARED_THROUGHPUT_SOURCE)
    );
}

#[test]
fn benchmark_preflight_report_blocks_high_load() {
    let config = BenchmarkPreflightConfig {
        enabled: true,
        max_load_per_core: 0.9,
        max_noise_cv_pct: 12.5,
        noise_sample_ms: 250,
        noise_rounds: 3,
    };
    let report = benchmark_preflight_report(
        config,
        true,
        8,
        12.0,
        10.0,
        8.0,
        &[100_000.0, 101_000.0, 99_000.0],
    );
    assert_eq!(report.get("ok").and_then(Value::as_bool), Some(false));
    let blockers = report
        .get("blockers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert!(
        blockers.iter().any(|value| {
            value
                .as_str()
                .map(|text| text.starts_with("host_load_per_core_exceeded:"))
                .unwrap_or(false)
        }),
        "expected host load blocker, got: {blockers:?}"
    );
}

#[test]
fn benchmark_preflight_report_blocks_high_noise_cv() {
    let config = BenchmarkPreflightConfig {
        enabled: true,
        max_load_per_core: 0.9,
        max_noise_cv_pct: 5.0,
        noise_sample_ms: 250,
        noise_rounds: 3,
    };
    let report = benchmark_preflight_report(
        config,
        false,
        8,
        1.0,
        1.0,
        1.0,
        &[40_000.0, 10_000.0, 40_000.0],
    );
    assert_eq!(report.get("ok").and_then(Value::as_bool), Some(false));
    let blockers = report
        .get("blockers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert!(
        blockers.iter().any(|value| {
            value
                .as_str()
                .map(|text| text.starts_with("throughput_noise_cv_exceeded:"))
                .unwrap_or(false)
        }),
        "expected noise cv blocker, got: {blockers:?}"
    );
}

#[test]
fn benchmark_preflight_report_passes_within_thresholds() {
    let config = BenchmarkPreflightConfig {
        enabled: true,
        max_load_per_core: 0.9,
        max_noise_cv_pct: 12.5,
        noise_sample_ms: 250,
        noise_rounds: 3,
    };
    let report = benchmark_preflight_report(
        config,
        true,
        8,
        3.2,
        3.6,
        3.0,
        &[100_000.0, 104_000.0, 102_000.0],
    );
    assert_eq!(report.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        report
            .get("blockers")
            .and_then(Value::as_array)
            .map(|rows| rows.len()),
        Some(0)
    );
}
