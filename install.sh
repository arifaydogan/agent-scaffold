#!/bin/bash
set -e

# Repository URL for remote cloning
REPO_URL="https://github.com/arifaydogan/ai-team-scaffold.git"

# Parse arguments
TARGET_DIR="${1:-}"
PACK_CHOICE="${2:-}"
ADAPTER_CHOICE="${3:-}"
FORCE=false

# Check for --force flag anywhere in args
for arg in "$@"; do
  if [ "$arg" = "--force" ] || [ "$arg" = "-f" ]; then
    FORCE=true
  fi
done

# If arguments are missing, we will run in interactive mode
INTERACTIVE=true
if [ -n "$TARGET_DIR" ] && [ -n "$PACK_CHOICE" ] && [ -n "$ADAPTER_CHOICE" ]; then
  INTERACTIVE=false
fi

echo "============================================="
echo "        AI Team Scaffold Installer           "
echo "============================================="

# Detect source directory
# Check if running from a local cloned repo (contains core/ and packs/)
if [ -d "core" ] && [ -d "packs" ]; then
  SOURCE_DIR="$(pwd)"
  echo "Using local source directory: $SOURCE_DIR"
  TEMP_DIR=""
else
  # Remote execution: Clone repository to temporary directory
  TEMP_DIR=$(mktemp -d /tmp/ai-team-scaffold.XXXXXX)
  echo "Cloning scaffold repository from $REPO_URL to temporary directory..."
  git clone --depth 1 "$REPO_URL" "$TEMP_DIR" > /dev/null 2>&1
  SOURCE_DIR="$TEMP_DIR"
fi

# Cleanup function on exit
cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    echo "Cleaning up temporary directory..."
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

# Prompt for Target Directory if interactive
if [ "$INTERACTIVE" = true ]; then
  read -p "Enter target project directory (default: .): " TARGET_INPUT
  TARGET_DIR="${TARGET_INPUT:-.}"
fi

# Resolve absolute path of target directory
mkdir -p "$TARGET_DIR"
TARGET_DIR=$(cd "$TARGET_DIR" && pwd)
echo "Target Directory: $TARGET_DIR"

# Prompt for Pack choice if interactive
if [ "$INTERACTIVE" = true ]; then
  echo ""
  echo "Select Pack Option:"
  echo "  1) Core (Standard 9 Agents & Rules)"
  echo "  2) Core + PaceBuild (10 Agents, Overrides & Context)"
  while true; do
    read -p "Choice (1-2): " PACK_INPUT
    if [ "$PACK_INPUT" = "1" ] || [ "$PACK_INPUT" = "2" ]; then
      PACK_CHOICE="$PACK_INPUT"
      break
    fi
    echo "Invalid choice. Please select 1 or 2."
  done
fi

# Prompt for Adapter choice if interactive
if [ "$INTERACTIVE" = true ]; then
  echo ""
  echo "Select Target Adapter(s):"
  echo "  1) Antigravity (.agents/ structure)"
  echo "  2) Claude Code (CLAUDE.md & .claude/ structure)"
  echo "  3) GitHub Copilot (.github/copilot-instructions.md)"
  echo "  4) All Adapters"
  while true; do
    read -p "Choice (1-4): " ADAPTER_INPUT
    if [[ "$ADAPTER_INPUT" =~ ^[1-4]$ ]]; then
      ADAPTER_CHOICE="$ADAPTER_INPUT"
      break
    fi
    echo "Invalid choice. Please select 1, 2, 3 or 4."
  done
fi

# Confirm choices
echo ""
echo "Configuration Summary:"
echo "  - Source: $SOURCE_DIR"
echo "  - Target: $TARGET_DIR"
echo "  - Pack:   $( [ "$PACK_CHOICE" = "1" ] && echo "Core Only" || echo "Core + PaceBuild" )"
echo "  - Adapter:$( [ "$ADAPTER_CHOICE" = "1" ] && echo "Antigravity" ; [ "$ADAPTER_CHOICE" = "2" ] && echo "Claude Code" ; [ "$ADAPTER_CHOICE" = "3" ] && echo "Copilot" ; [ "$ADAPTER_CHOICE" = "4" ] && echo "All Adapters" )"
echo ""

# Check for existing files and prompt for confirmation
EXISTING_FILES=()
# We check a few key files/dirs to detect existing installations
if [ "$ADAPTER_CHOICE" = "1" ] || [ "$ADAPTER_CHOICE" = "4" ]; then
  [ -d "$TARGET_DIR/.agents" ] && EXISTING_FILES+=(".agents/")
fi
if [ "$ADAPTER_CHOICE" = "2" ] || [ "$ADAPTER_CHOICE" = "4" ]; then
  [ -f "$TARGET_DIR/CLAUDE.md" ] && EXISTING_FILES+=("CLAUDE.md")
  [ -d "$TARGET_DIR/.claude" ] && EXISTING_FILES+=(".claude/")
fi
if [ "$ADAPTER_CHOICE" = "3" ] || [ "$ADAPTER_CHOICE" = "4" ]; then
  [ -f "$TARGET_DIR/.github/copilot-instructions.md" ] && EXISTING_FILES+=(".github/copilot-instructions.md")
fi

if [ ${#EXISTING_FILES[@]} -ne 0 ] && [ "$FORCE" = false ]; then
  echo "WARNING: The following existing folders/files will be overwritten:"
  for f in "${EXISTING_FILES[@]}"; do
    echo "  - $f"
  done
  if [ "$INTERACTIVE" = true ]; then
    read -p "Do you want to proceed and overwrite? (y/N): " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[yY](es)?$ ]]; then
      echo "Installation cancelled."
      exit 0
    fi
  else
    echo "Error: Target files already exist and --force is not specified. Aborting."
    exit 1
  fi
fi

# Helper function to copy rules
copy_rules_antigravity() {
  local src="$1"
  local dest="$2"
  mkdir -p "$dest/rules"
  cp "$src"/core/rules/*.md "$dest/rules/"
  
  if [ "$PACK_CHOICE" = "2" ]; then
    cp "$src"/packs/pacebuild/overrides/rules/demo-reliability-guard.md "$dest/rules/"
    # Context override overrides the generic jira-protocol.md
    cp "$src"/packs/pacebuild/context/jira-protocol.md "$dest/rules/jira-protocol.md"
  fi
}

copy_skills_antigravity() {
  local src="$1"
  local dest="$2"
  mkdir -p "$dest/skills"
  
  # Copy core skills
  for agent_dir in "$src"/core/agents/*; do
    if [ -d "$agent_dir/skills" ]; then
      for skill_dir in "$agent_dir"/skills/*; do
        if [ -d "$skill_dir" ]; then
          local skill_name=$(basename "$skill_dir")
          mkdir -p "$dest/skills/$skill_name"
          cp "$skill_dir"/* "$dest/skills/$skill_name/"
        fi
      done
    fi
  done
  
  # Copy PaceBuild specific skills & overrides
  if [ "$PACK_CHOICE" = "2" ]; then
    # CV Engineer skills
    if [ -d "$src/packs/pacebuild/agents/cv-engineer/skills" ]; then
      for skill_dir in "$src"/packs/pacebuild/agents/cv-engineer/skills/*; do
        if [ -d "$skill_dir" ]; then
          local skill_name=$(basename "$skill_dir")
          mkdir -p "$dest/skills/$skill_name"
          cp "$skill_dir"/* "$dest/skills/$skill_name/"
        fi
      done
    fi
    # Backend engineer timescaledb skill override
    if [ -d "$src/packs/pacebuild/overrides/backend-engineer/skills/fastapi-timescale" ]; then
      mkdir -p "$dest/skills/fastapi-timescale"
      cp -r "$src"/packs/pacebuild/overrides/backend-engineer/skills/fastapi-timescale/* "$dest/skills/fastapi-timescale/"
    fi
  fi
}

copy_agents_antigravity() {
  local src="$1"
  local dest="$2"
  mkdir -p "$dest/agents"
  
  # Copy core agents
  cp -r "$src"/core/agents/* "$dest/agents/"
  cp "$src"/AGENTS.md "$dest/AGENTS.md"
  
  # Copy PaceBuild agents and AGENTS override
  if [ "$PACK_CHOICE" = "2" ]; then
    mkdir -p "$dest/agents/cv-engineer"
    cp -r "$src"/packs/pacebuild/agents/cv-engineer/* "$dest/agents/cv-engineer/"
    cp "$src"/packs/pacebuild/overrides/AGENTS.md "$dest/AGENTS.md"
  fi
}

# ----------------------------------------------------
# 1) Install Antigravity Adapter
# ----------------------------------------------------
if [ "$ADAPTER_CHOICE" = "1" ] || [ "$ADAPTER_CHOICE" = "4" ]; then
  echo "Installing Antigravity Adapter..."
  mkdir -p "$TARGET_DIR/.agents"
  copy_rules_antigravity "$SOURCE_DIR" "$TARGET_DIR/.agents"
  copy_skills_antigravity "$SOURCE_DIR" "$TARGET_DIR/.agents"
  copy_agents_antigravity "$SOURCE_DIR" "$TARGET_DIR/.agents"
  echo "Antigravity Adapter installed successfully."
fi

# ----------------------------------------------------
# 2) Install Claude Code Adapter
# ----------------------------------------------------
if [ "$ADAPTER_CHOICE" = "2" ] || [ "$ADAPTER_CHOICE" = "4" ]; then
  echo "Installing Claude Code Adapter..."
  mkdir -p "$TARGET_DIR/.claude/agents"
  mkdir -p "$TARGET_DIR/.claude/skills"
  
  # Copy agents
  cp -r "$SOURCE_DIR"/core/agents/* "$TARGET_DIR/.claude/agents/"
  
  # Copy core skills
  for agent_dir in "$SOURCE_DIR"/core/agents/*; do
    if [ -d "$agent_dir/skills" ]; then
      for skill_dir in "$agent_dir"/skills/*; do
        if [ -d "$skill_dir" ]; then
          local skill_name=$(basename "$skill_dir")
          mkdir -p "$TARGET_DIR/.claude/skills/$skill_name"
          cp "$skill_dir"/* "$TARGET_DIR/.claude/skills/$skill_name/"
        fi
      done
    fi
  done
  
  if [ "$PACK_CHOICE" = "2" ]; then
    mkdir -p "$TARGET_DIR/.claude/agents/cv-engineer"
    cp -r "$SOURCE_DIR"/packs/pacebuild/agents/cv-engineer/* "$TARGET_DIR/.claude/agents/cv-engineer/"
    
    # CV Engineer skills
    if [ -d "$SOURCE_DIR/packs/pacebuild/agents/cv-engineer/skills" ]; then
      for skill_dir in "$SOURCE_DIR"/packs/pacebuild/agents/cv-engineer/skills/*; do
        if [ -d "$skill_dir" ]; then
          local skill_name=$(basename "$skill_dir")
          mkdir -p "$TARGET_DIR/.claude/skills/$skill_name"
          cp "$skill_dir"/* "$TARGET_DIR/.claude/skills/$skill_name/"
        fi
      done
    fi
    # Backend timescaledb skill override
    if [ -d "$SOURCE_DIR/packs/pacebuild/overrides/backend-engineer/skills/fastapi-timescale" ]; then
      mkdir -p "$TARGET_DIR/.claude/skills/fastapi-timescale"
      cp -r "$SOURCE_DIR"/packs/pacebuild/overrides/backend-engineer/skills/fastapi-timescale/* "$TARGET_DIR/.claude/skills/fastapi-timescale/"
    fi
  fi
  
  # Create CLAUDE.md combined prompt
  echo "# Claude Code System Guidelines" > "$TARGET_DIR/CLAUDE.md"
  echo "" >> "$TARGET_DIR/CLAUDE.md"
  cat "$SOURCE_DIR/core/rules/global.md" >> "$TARGET_DIR/CLAUDE.md"
  echo "" >> "$TARGET_DIR/CLAUDE.md"
  echo "## Git & Branching Policy" >> "$TARGET_DIR/CLAUDE.md"
  cat "$SOURCE_DIR/core/rules/git-workflow.md" >> "$TARGET_DIR/CLAUDE.md"
  
  if [ "$PACK_CHOICE" = "2" ]; then
    echo "" >> "$TARGET_DIR/CLAUDE.md"
    echo "## PaceBuild Reliability Rules" >> "$TARGET_DIR/CLAUDE.md"
    cat "$SOURCE_DIR/packs/pacebuild/overrides/rules/demo-reliability-guard.md" >> "$TARGET_DIR/CLAUDE.md"
    echo "" >> "$TARGET_DIR/CLAUDE.md"
    echo "## Jira Protocol Context" >> "$TARGET_DIR/CLAUDE.md"
    cat "$SOURCE_DIR/packs/pacebuild/context/jira-protocol.md" >> "$TARGET_DIR/CLAUDE.md"
  else
    echo "" >> "$TARGET_DIR/CLAUDE.md"
    echo "## Jira Protocol" >> "$TARGET_DIR/CLAUDE.md"
    cat "$SOURCE_DIR/core/rules/jira-protocol.md" >> "$TARGET_DIR/CLAUDE.md"
  fi
  
  echo "Claude Code Adapter installed successfully."
fi

# ----------------------------------------------------
# 3) Install Copilot Adapter
# ----------------------------------------------------
if [ "$ADAPTER_CHOICE" = "3" ] || [ "$ADAPTER_CHOICE" = "4" ]; then
  echo "Installing GitHub Copilot Adapter..."
  mkdir -p "$TARGET_DIR/.github"
  
  # Generate .github/copilot-instructions.md
  echo "# GitHub Copilot Custom Instructions" > "$TARGET_DIR/.github/copilot-instructions.md"
  echo "" >> "$TARGET_DIR/.github/copilot-instructions.md"
  cat "$SOURCE_DIR/core/rules/global.md" >> "$TARGET_DIR/.github/copilot-instructions.md"
  echo "" >> "$TARGET_DIR/.github/copilot-instructions.md"
  
  if [ "$PACK_CHOICE" = "2" ]; then
    echo "## PaceBuild Reliability Guard" >> "$TARGET_DIR/.github/copilot-instructions.md"
    cat "$SOURCE_DIR/packs/pacebuild/overrides/rules/demo-reliability-guard.md" >> "$TARGET_DIR/.github/copilot-instructions.md"
    echo "" >> "$TARGET_DIR/.github/copilot-instructions.md"
    echo "## PaceBuild Jira Protocol" >> "$TARGET_DIR/.github/copilot-instructions.md"
    cat "$SOURCE_DIR/packs/pacebuild/context/jira-protocol.md" >> "$TARGET_DIR/.github/copilot-instructions.md"
    echo "" >> "$TARGET_DIR/.github/copilot-instructions.md"
    echo "## Agent Routing Matrix (PaceBuild)" >> "$TARGET_DIR/.github/copilot-instructions.md"
    cat "$SOURCE_DIR/packs/pacebuild/overrides/AGENTS.md" >> "$TARGET_DIR/.github/copilot-instructions.md"
  else
    echo "## Git & Jira Guidelines" >> "$TARGET_DIR/.github/copilot-instructions.md"
    cat "$SOURCE_DIR/core/rules/git-workflow.md" >> "$TARGET_DIR/.github/copilot-instructions.md"
    echo "" >> "$TARGET_DIR/.github/copilot-instructions.md"
    cat "$SOURCE_DIR/core/rules/jira-protocol.md" >> "$TARGET_DIR/.github/copilot-instructions.md"
    echo "" >> "$TARGET_DIR/.github/copilot-instructions.md"
    echo "## Agent Routing Matrix" >> "$TARGET_DIR/.github/copilot-instructions.md"
    cat "$SOURCE_DIR/AGENTS.md" >> "$TARGET_DIR/.github/copilot-instructions.md"
  fi
  
  echo "GitHub Copilot Adapter installed successfully."
fi

# ----------------------------------------------------
# Git Hooks Installation (if target is a Git repo)
# ----------------------------------------------------
if [ -d "$TARGET_DIR/.git" ]; then
  INSTALL_HOOKS=false
  if [ "$INTERACTIVE" = true ]; then
    read -p "Git repository detected. Install Git hooks? (Y/n): " HOOK_CONFIRM
    if [[ ! "$HOOK_CONFIRM" =~ ^[nN](o)?$ ]]; then
      INSTALL_HOOKS=true
    fi
  else
    # In unattended mode, always install hooks if .git exists
    INSTALL_HOOKS=true
  fi
  
  if [ "$INSTALL_HOOKS" = true ]; then
    echo "Installing Git hooks..."
    mkdir -p "$TARGET_DIR/.git/hooks"
    cp "$SOURCE_DIR"/hooks/pre-commit "$TARGET_DIR/.git/hooks/pre-commit"
    cp "$SOURCE_DIR"/hooks/commit-msg "$TARGET_DIR/.git/hooks/commit-msg"
    cp "$SOURCE_DIR"/hooks/pre-push "$TARGET_DIR/.git/hooks/pre-push"
    chmod +x "$TARGET_DIR/.git/hooks/pre-commit" "$TARGET_DIR/.git/hooks/commit-msg" "$TARGET_DIR/.git/hooks/pre-push"
    echo "Git hooks installed and made executable."
  fi
fi

echo "============================================="
echo "   Installation Completed Successfully!      "
echo "============================================="
