#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
python3 "$ROOT/repair/apply-repair-bundle.py"
python3 "$ROOT/repair/post-apply-test-sync.py"
