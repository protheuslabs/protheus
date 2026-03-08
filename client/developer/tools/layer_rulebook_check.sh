#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
node client/developer/tools/layer_rulebook_check.js
