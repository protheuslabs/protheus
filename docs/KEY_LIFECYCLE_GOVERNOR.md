# Key Lifecycle Governor

`systems/security/key_lifecycle_governor.ts` provides governed key lifecycle ceremonies with crypto-agility checks.

## Supported ceremonies

- `issue`
- `rotate`
- `revoke`
- `recover`
- `drill`
- `verify`

## Governance features

- Key-class/algorithm allowlists
- Hardware-backed requirements per key class
- Recovery drill freshness enforcement
- Crypto-agility migration track verification (`config/crypto_agility_contract.json`)
- Immutable lifecycle receipts

## Commands

```bash
node systems/security/key_lifecycle_governor.js issue --key-id=signing_root --class=signing --hardware-backed=1
node systems/security/key_lifecycle_governor.js rotate --key-id=signing_root --algorithm=pq-dilithium3 --hardware-backed=1
node systems/security/key_lifecycle_governor.js drill --key-id=signing_root
node systems/security/key_lifecycle_governor.js verify --strict=1
node systems/security/key_lifecycle_governor.js status
```
