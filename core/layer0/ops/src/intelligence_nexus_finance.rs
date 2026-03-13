use super::*;

fn health_from_runway(runway_days: f64) -> &'static str {
    if runway_days <= 0.5 {
        "critical"
    } else if runway_days <= 2.0 {
        "low"
    } else {
        "healthy"
    }
}

fn render_bar(percent: f64) -> String {
    let clamped = percent.clamp(0.0, 1.0);
    let total = 20usize;
    let fill = ((clamped * total as f64).round() as usize).min(total);
    format!(
        "{}{}",
        "#".repeat(fill),
        "-".repeat(total.saturating_sub(fill))
    )
}

pub(super) fn command_credits_status(root: &Path, parsed: &ParsedArgs) -> i32 {
    let provider = provider_name(parsed.flags.get("provider"));
    let gate_action = format!("credits:status:{provider}");
    if !directive_kernel::action_allowed(root, &gate_action) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_credits_status",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": "directive_gate_denied"
            }),
        );
    }

    let mut ledger = load_ledger(root);
    let key = key_for_provider(parsed, &provider, &ledger);
    let probe = match run_provider_probe(root, parsed, &provider, key.as_deref()) {
        Ok(v) => v,
        Err(err) => {
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "intelligence_nexus_credits_status",
                    "lane": "core/layer0/ops",
                    "provider": provider,
                    "error": clean(err, 220)
                }),
            )
        }
    };

    let credits = probe
        .get("credits_remaining")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .max(0.0);
    let burn_rate = probe
        .get("burn_rate_per_day")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .max(0.0);
    let runway_days = days_left(credits, burn_rate);

    {
        let obj = ledger_obj_mut(&mut ledger);
        map_mut(obj, "credit_balances").insert(provider.clone(), Value::from(credits));
        map_mut(obj, "credit_usage").insert(
            provider.clone(),
            json!({
                "burn_rate_per_day": burn_rate,
                "runway_days": runway_days,
                "source": probe.get("source").cloned().unwrap_or(Value::Null),
                "refreshed_at": now_iso()
            }),
        );
    }
    if let Err(err) = store_ledger(root, &ledger) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_credits_status",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": clean(err, 220)
            }),
        );
    }

    emit(
        root,
        json!({
            "ok": true,
            "type": "intelligence_nexus_credits_status",
            "lane": "core/layer0/ops",
            "provider": provider,
            "credits_remaining": credits,
            "burn_rate_per_day": burn_rate,
            "runway_days_estimate": runway_days,
            "refresh_minutes": parse_f64(parsed.flags.get("refresh-minutes"), 5.0).clamp(1.0, 60.0),
            "probe_source": probe.get("source").cloned().unwrap_or(Value::Null)
        }),
    )
}

pub(super) fn command_workspace_view(root: &Path) -> i32 {
    let gate_action = "credits:workspace-view";
    if !directive_kernel::action_allowed(root, gate_action) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_workspace_view",
                "lane": "core/layer0/ops",
                "error": "directive_gate_denied",
                "gate_action": gate_action
            }),
        );
    }

    let ledger = load_ledger(root);
    let balances = ledger
        .get("credit_balances")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let usage = ledger
        .get("credit_usage")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let limits = ledger
        .get("spend_limits")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut provider_ids = balances.keys().cloned().collect::<Vec<_>>();
    for key in usage.keys() {
        if !provider_ids.iter().any(|v| v == key) {
            provider_ids.push(key.clone());
        }
    }
    provider_ids.sort();

    let cards = provider_ids
        .iter()
        .map(|provider| {
            let credits_remaining = balances
                .get(provider)
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .max(0.0);
            let burn_rate = usage
                .get(provider)
                .and_then(|v| v.get("burn_rate_per_day"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .max(0.0);
            let runway_days = days_left(credits_remaining, burn_rate);
            let target = limits
                .get(provider)
                .and_then(Value::as_f64)
                .unwrap_or_else(|| credits_remaining.max(100.0))
                .max(1.0);
            let remaining_percent = (credits_remaining / target).clamp(0.0, 1.0);
            let health = health_from_runway(runway_days);
            json!({
                "provider": provider,
                "credits_remaining": credits_remaining,
                "burn_rate_per_day": burn_rate,
                "runway_days_estimate": runway_days,
                "remaining_percent": remaining_percent,
                "remaining_bar": render_bar(remaining_percent),
                "health": health
            })
        })
        .collect::<Vec<_>>();

    let critical_count = cards
        .iter()
        .filter(|row| row.get("health").and_then(Value::as_str) == Some("critical"))
        .count();

    emit(
        root,
        json!({
            "ok": true,
            "type": "intelligence_nexus_workspace_view",
            "lane": "core/layer0/ops",
            "workspace_route": "/workspace/keys",
            "cards": cards,
            "vitals": {
                "credit_health": if critical_count > 0 { "degraded" } else { "healthy" },
                "critical_provider_count": critical_count
            }
        }),
    )
}

fn execute_purchase(
    root: &Path,
    ledger: &mut Value,
    provider: &str,
    amount: f64,
    rail: &str,
    actor: &str,
    reason: &str,
    spend_limit: f64,
    apply: bool,
    allow_unverified_rail: bool,
    payment_proof: &str,
) -> Value {
    let gate_action = format!("credits:buy:{provider}:{rail}");
    let gate_ok = directive_kernel::action_allowed(root, &gate_action);
    let payment_verified = rail == "nexus" || allow_unverified_rail || !payment_proof.is_empty();
    let allowed = gate_ok && amount > 0.0 && amount <= spend_limit && payment_verified;
    let mut network_debit = Value::Null;
    let mut error: Option<String> = None;
    let mut balance_after = 0.0;
    let mut event = Value::Null;

    if allowed && apply {
        if rail == "nexus" {
            match network_protocol::deduct_nexus_balance(
                root,
                actor,
                amount,
                &format!("model_credits:{provider}"),
            ) {
                Ok(v) => network_debit = v,
                Err(err) => {
                    error = Some(clean(err, 220));
                }
            }
        }

        if error.is_none() {
            let obj = ledger_obj_mut(ledger);
            let balances = map_mut(obj, "credit_balances");
            let current = f64_in_map(balances, provider);
            balance_after = current + amount;
            balances.insert(provider.to_string(), Value::from(balance_after));
            map_mut(obj, "spend_limits").insert(provider.to_string(), Value::from(spend_limit));
            event = append_purchase_event(ledger, provider, actor, amount, rail, reason);
        }
    } else {
        let balances = ledger
            .get("credit_balances")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        balance_after = f64_in_map(&balances, provider);
    }

    json!({
        "allowed": allowed && error.is_none(),
        "gate_ok": gate_ok,
        "payment_verified": payment_verified,
        "provider": provider,
        "amount": amount,
        "rail": rail,
        "actor": actor,
        "reason": reason,
        "spend_limit": spend_limit,
        "apply": apply,
        "network_debit": network_debit,
        "balance_after": balance_after,
        "purchase_event": event,
        "error": error
    })
}

pub(super) fn command_buy_credits(root: &Path, parsed: &ParsedArgs) -> i32 {
    let provider = provider_name(parsed.flags.get("provider"));
    let amount = parse_f64(parsed.flags.get("amount"), 100.0).max(0.0);
    let rail = clean(
        parsed
            .flags
            .get("rail")
            .cloned()
            .unwrap_or_else(|| "nexus".to_string()),
        24,
    )
    .to_ascii_lowercase();
    let actor = clean(
        parsed
            .flags
            .get("actor")
            .cloned()
            .unwrap_or_else(|| "organism:global".to_string()),
        120,
    );
    let reason = clean(
        parsed
            .flags
            .get("reason")
            .cloned()
            .unwrap_or_else(|| "manual_top_up".to_string()),
        220,
    );
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let allow_unverified_rail = parse_bool(parsed.flags.get("allow-unverified-rail"), false);
    let payment_proof = clean(
        parsed
            .flags
            .get("payment-proof")
            .cloned()
            .unwrap_or_default(),
        256,
    );

    let mut ledger = load_ledger(root);
    let stored_limit = ledger
        .get("spend_limits")
        .and_then(Value::as_object)
        .and_then(|m| m.get(&provider))
        .and_then(Value::as_f64)
        .unwrap_or(amount);
    let spend_limit = parse_f64(parsed.flags.get("spend-limit"), stored_limit).max(0.0);

    let result = execute_purchase(
        root,
        &mut ledger,
        &provider,
        amount,
        &rail,
        &actor,
        &reason,
        spend_limit,
        apply,
        allow_unverified_rail,
        &payment_proof,
    );

    if let Err(err) = store_ledger(root, &ledger) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_buy_credits",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": clean(err, 220)
            }),
        );
    }

    emit(
        root,
        json!({
            "ok": result.get("allowed").and_then(Value::as_bool).unwrap_or(false),
            "type": "intelligence_nexus_buy_credits",
            "lane": "core/layer0/ops",
            "result": result
        }),
    )
}

pub(super) fn command_autobuy(root: &Path, parsed: &ParsedArgs) -> i32 {
    let provider = provider_name(parsed.flags.get("provider"));
    let actor = clean(
        parsed
            .flags
            .get("actor")
            .cloned()
            .unwrap_or_else(|| "organism:global".to_string()),
        120,
    );
    let priority = clean(
        parsed
            .flags
            .get("priority")
            .cloned()
            .unwrap_or_else(|| "normal".to_string()),
        32,
    )
    .to_ascii_lowercase();
    let threshold = parse_f64(parsed.flags.get("threshold"), 100.0).max(0.0);
    let refill = parse_f64(parsed.flags.get("refill"), 250.0).max(0.0);
    let daily_cap = parse_f64(parsed.flags.get("daily-cap"), 500.0).max(0.0);
    let apply = parse_bool(parsed.flags.get("apply"), false);
    let rail = clean(
        parsed
            .flags
            .get("rail")
            .cloned()
            .unwrap_or_else(|| "nexus".to_string()),
        24,
    )
    .to_ascii_lowercase();

    let mut ledger = load_ledger(root);
    let current = parsed
        .flags
        .get("current")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or_else(|| {
            ledger
                .get("credit_balances")
                .and_then(Value::as_object)
                .and_then(|m| m.get(&provider))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        })
        .max(0.0);
    let spent = spent_today(&ledger, &actor, &provider);
    let under_threshold = current <= threshold;
    let within_cap = spent + refill <= daily_cap;
    let priority_allows = priority != "low";
    let decision = if under_threshold && within_cap && priority_allows {
        "buy_now"
    } else {
        "hold"
    };

    let purchase_result = if apply && decision == "buy_now" {
        Some(execute_purchase(
            root,
            &mut ledger,
            &provider,
            refill,
            &rail,
            &actor,
            "autobuy_refill",
            refill,
            true,
            false,
            "",
        ))
    } else {
        None
    };

    {
        let obj = ledger_obj_mut(&mut ledger);
        obj.insert(
            "last_autobuy".to_string(),
            json!({
                "provider": provider,
                "actor": actor,
                "decision": decision,
                "priority": priority,
                "current_credits": current,
                "threshold": threshold,
                "refill_amount": refill,
                "daily_cap": daily_cap,
                "spent_today": spent,
                "apply": apply,
                "ts": now_iso()
            }),
        );
    }

    if let Err(err) = store_ledger(root, &ledger) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_autobuy_evaluate",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": clean(err, 220)
            }),
        );
    }

    emit(
        root,
        json!({
            "ok": true,
            "type": "intelligence_nexus_autobuy_evaluate",
            "lane": "core/layer0/ops",
            "provider": provider,
            "decision": decision,
            "current_credits": current,
            "threshold": threshold,
            "refill_amount": refill,
            "spent_today": spent,
            "daily_cap": daily_cap,
            "priority": priority,
            "purchase_result": purchase_result
        }),
    )
}
