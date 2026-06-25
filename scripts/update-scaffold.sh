#!/bin/bash
set -euo pipefail

TARGET_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
PROFILE_PATH="$TARGET_DIR/.agent-scaffold/profile.env"

if [ ! -f "$PROFILE_PATH" ]; then
  echo "Missing scaffold profile: $PROFILE_PATH" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$PROFILE_PATH"

if [ -z "${SOURCE_REPO:-}" ] || [ -z "${SOURCE_REF:-}" ] || \
   [ -z "${PACK_CHOICE:-}" ] || [ -z "${ADAPTER_CHOICES:-}" ]; then
  echo "Invalid scaffold profile: $PROFILE_PATH" >&2
  exit 1
fi

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-scaffold-update.XXXXXX")
cleanup() {
  case "$TEMP_DIR" in
    "${TMPDIR:-/tmp}"/agent-scaffold-update.*) rm -rf "$TEMP_DIR" ;;
    *) echo "Unsafe temporary cleanup target: $TEMP_DIR" >&2 ;;
  esac
}
trap cleanup EXIT

echo "Fetching agent-scaffold $SOURCE_REF..."
git clone --depth 1 --branch "$SOURCE_REF" "$SOURCE_REPO" "$TEMP_DIR"

IFS=',' read -r -a ADAPTERS <<< "$ADAPTER_CHOICES"
for adapter in "${ADAPTERS[@]}"; do
  bash "$TEMP_DIR/install.sh" "$TARGET_DIR" "$PACK_CHOICE" "$adapter" \
    --force --skip-hooks
done

commit=$(git -C "$TEMP_DIR" rev-parse HEAD)
updated_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat > "$TARGET_DIR/.agent-scaffold/last-update.env" <<EOF
SOURCE_COMMIT=$commit
UPDATED_AT=$updated_at
EOF

echo "Scaffold updated successfully."
echo "Commit: $commit"
