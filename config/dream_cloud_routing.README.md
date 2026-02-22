# Dream Cloud Routing Config

This configuration routes all dream cycles (idle + REM) through kimi-k2.5:cloud instead of local models.

## Usage

To enable cloud routing for the current session:
```bash
source config/dream_cloud_routing.env
```

Or add to your shell profile:
```bash
echo 'source ~/.openclaw/workspace/config/dream_cloud_routing.env' >> ~/.zshrc
```

## What Changes

| Env Var | Old (Local) | New (Cloud) |
|---------|-------------|-------------|
| IDLE_DREAM_MODEL_ORDER | smallthinker,qwen3:1.7b,... | kimi-k2.5:cloud |
| IDLE_DREAM_REM_MODEL_ORDER | qwen3:4b,gemma3:4b,... | kimi-k2.5:cloud |
| IDLE_DREAM_REM_STRATEGY | deterministic | local |
| IDLE_DREAM_TIMEOUT_MS | 25000 | 45000 |
| IDLE_DREAM_REM_TIMEOUT_MS | 30000 | 60000 |

## Effects

✅ No more local model timeouts
✅ Creative synthesis returns (no more degraded fallback)
✅ Better link quality
✅ Cloud costs apply ($0.001-0.003 per dream)
✅ 45-60s response times vs 25s

## Reverting

To go back to local models:
```bash
export IDLE_DREAM_MODEL_ORDER="smallthinker,qwen3:1.7b,qwen3:4b,gemma3:4b"
export IDLE_DREAM_REM_MODEL_ORDER="qwen3:4b,gemma3:4b,qwen3:1.7b,smallthinker"
export IDLE_DREAM_REM_STRATEGY="deterministic"
```
