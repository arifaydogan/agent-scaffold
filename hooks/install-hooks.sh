#!/bin/bash

set -euo pipefail

HOOK_DIR="$(git rev-parse --show-toplevel)/.git/hooks"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

for hook in pre-commit commit-msg pre-push; do
  cp "$SCRIPT_DIR/$hook" "$HOOK_DIR/$hook"
  chmod +x "$HOOK_DIR/$hook"
done

echo "Git hooks installed"
