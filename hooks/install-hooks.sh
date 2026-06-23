#!/bin/bash
# Hook'ları .git/hooks/ altına kopyalar ve çalıştırılabilir yapar
HOOK_DIR="$(git rev-parse --show-toplevel)/.git/hooks"
SCRIPT_DIR="$(dirname $0)"
for hook in pre-commit commit-msg pre-push; do
  cp "$SCRIPT_DIR/$hook" "$HOOK_DIR/$hook"
  chmod +x "$HOOK_DIR/$hook"
done
echo "✓ Git hooks kuruldu"
