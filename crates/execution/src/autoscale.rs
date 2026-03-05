// Kept rust50 (HEAD) side exactly; conflict block removed.
// File: /Users/jay/.openclaw/workspace/crates/execution/src/autoscale.rs
// lines: 27546
// sha256: 40890a2c5f1678b3a845b17713127a529180c4d41294a9554c54a235facea762
        let out = run_autoscale_json(&payload).expect("autoscale inversion_maturity_score");
        assert!(out.contains("\"mode\":\"inversion_maturity_score\""));
    }
}
