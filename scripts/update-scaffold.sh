#!/bin/bash
set -euo pipefail

TARGET_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PULL_IF_CHANGED=0
CHECK_ONLY=0
WATCH=0
INTERVAL_SECONDS=300

while [ "$#" -gt 0 ]; do
  case "$1" in
    --pull-if-changed)
      PULL_IF_CHANGED=1
      shift
      ;;
    --check-only)
      CHECK_ONLY=1
      shift
      ;;
    --watch)
      WATCH=1
      shift
      ;;
    --interval)
      INTERVAL_SECONDS="${2:?missing value for --interval}"
      shift 2
      ;;
    --help|-h)
      cat <<'EOF'
Usage: update-scaffold.sh [TARGET_DIR] [--pull-if-changed] [--check-only] [--watch] [--interval SECONDS]
EOF
      exit 0
      ;;
    *)
      if [[ "$1" == --* ]]; then
        echo "Unknown option: $1" >&2
        exit 1
      fi
      TARGET_DIR="$1"
      shift
      ;;
  esac
done

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

get_last_installed_commit() {
  local last_update_path="$TARGET_DIR/.agent-scaffold/last-update.env"
  if [ ! -f "$last_update_path" ]; then
    return 0
  fi

  sed -n 's/^SOURCE_COMMIT=//p' "$last_update_path" | head -n 1
}

get_remote_commit() {
  local remote_line
  remote_line="$(git ls-remote "$SOURCE_REPO" "$SOURCE_REF" | head -n 1)"
  if [ -z "$remote_line" ]; then
    echo "Remote ref not found: $SOURCE_REF" >&2
    exit 1
  fi

  printf '%s\n' "${remote_line%%[[:space:]]*}"
}

write_update_status() {
  local installed_commit remote_commit needs_update
  installed_commit="$(get_last_installed_commit)"
  remote_commit="$(get_remote_commit)"
  needs_update=0
  if [ "$installed_commit" != "$remote_commit" ]; then
    needs_update=1
  fi

  cat <<EOF
{"targetDir":"$TARGET_DIR","sourceRef":"$SOURCE_REF","installedCommit":"$installed_commit","remoteCommit":"$remote_commit","needsUpdate":$needs_update}
EOF

  return "$needs_update"
}

invoke_scaffold_update() {
  local temp_dir commit updated_at
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/agent-scaffold-update.XXXXXX")"

  cleanup() {
    case "$temp_dir" in
      "${TMPDIR:-/tmp}"/agent-scaffold-update.*) rm -rf "$temp_dir" ;;
      *) echo "Unsafe temporary cleanup target: $temp_dir" >&2 ;;
    esac
  }
  trap cleanup RETURN

  echo "Fetching agent-scaffold $SOURCE_REF..."
  git clone --depth 1 --branch "$SOURCE_REF" "$SOURCE_REPO" "$temp_dir"

  IFS=',' read -r -a ADAPTERS <<< "$ADAPTER_CHOICES"
  for adapter in "${ADAPTERS[@]}"; do
    bash "$temp_dir/install.sh" "$TARGET_DIR" "$PACK_CHOICE" "$adapter" \
      --force --skip-hooks
  done

  commit="$(git -C "$temp_dir" rev-parse HEAD)"
  updated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  cat > "$TARGET_DIR/.agent-scaffold/last-update.env" <<EOF
SOURCE_COMMIT=$commit
UPDATED_AT=$updated_at
EOF

  echo "Scaffold updated successfully."
  echo "Commit: $commit"
}

if [ "$CHECK_ONLY" -eq 1 ]; then
  if write_update_status; then
    exit 0
  fi
  exit 10
fi

if [ "$WATCH" -eq 1 ]; then
  echo "Watching $SOURCE_REPO ($SOURCE_REF) every $INTERVAL_SECONDS seconds..."
  while true; do
    if write_update_status; then
      echo "No scaffold changes detected."
    else
      invoke_scaffold_update
    fi
    sleep "$INTERVAL_SECONDS"
  done
fi

if [ "$PULL_IF_CHANGED" -eq 1 ]; then
  if write_update_status; then
    echo "Scaffold is already up to date."
    exit 0
  fi
  invoke_scaffold_update
  exit 0
fi

invoke_scaffold_update
