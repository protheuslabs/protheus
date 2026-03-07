// SPDX-License-Identifier: Apache-2.0
use conduit::{
    run_stdio_once, validate_conduit_contract_budget, ConduitPolicy, ConduitSecurityContext,
    KernelLaneCommandHandler, RegistryPolicyGate,
};
use std::env;
use std::io::{self, BufReader};

fn main() {
    if let Err(err) = run() {
        eprintln!("conduit_daemon_error:{err}");
        std::process::exit(1);
    }
}

fn run() -> io::Result<()> {
    let policy = load_policy()?;
    validate_conduit_contract_budget(policy.bridge_message_budget_max)
        .map_err(|reason| io::Error::new(io::ErrorKind::InvalidData, reason))?;
    let signing_key_id =
        env::var("CONDUIT_SIGNING_KEY_ID").unwrap_or_else(|_| "conduit-msg-k1".to_string());
    let signing_secret = env::var("CONDUIT_SIGNING_SECRET")
        .unwrap_or_else(|_| "conduit-dev-signing-secret".to_string());
    let token_key_id =
        env::var("CONDUIT_TOKEN_KEY_ID").unwrap_or_else(|_| "conduit-token-k1".to_string());
    let token_secret =
        env::var("CONDUIT_TOKEN_SECRET").unwrap_or_else(|_| "conduit-dev-token-secret".to_string());

    let gate = RegistryPolicyGate::new(policy.clone());
    let mut security = ConduitSecurityContext::from_policy(
        &policy,
        signing_key_id,
        signing_secret,
        token_key_id,
        token_secret,
    );
    let mut handler = KernelLaneCommandHandler;

    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = io::stdout();
    let mut writer = stdout.lock();

    while run_stdio_once(&mut reader, &mut writer, &gate, &mut security, &mut handler)? {}
    Ok(())
}

fn load_policy() -> io::Result<ConduitPolicy> {
    if let Ok(path) = env::var("CONDUIT_POLICY_PATH") {
        ConduitPolicy::from_path(path)
    } else {
        Ok(ConduitPolicy::default())
    }
}
