#!/usr/bin/env bash
# Browser automation wrapper for playwright-cli.
# Automatically uses persistent profile at ~/.octopal/browser-profile.
#
# Usage:
#   scripts/browser.sh open https://example.com
#   scripts/browser.sh snapshot
#   scripts/browser.sh click e15
#   scripts/browser.sh screenshot
#   scripts/browser.sh close
#
# To use incognito mode (no persistent state):
#   scripts/browser.sh --incognito open https://example.com
#
# To use headed mode (visible browser window):
#   scripts/browser.sh --headed open https://example.com

set -euo pipefail

PROFILE_DIR="${OCTOPAL_BROWSER_PROFILE:-$HOME/.octopal/browser-profile}"
PLAYWRIGHT_CLI="$(dirname "$0")/../../../node_modules/.bin/playwright-cli"

# Fall back to PATH if not found relative to skill
if [ ! -x "$PLAYWRIGHT_CLI" ]; then
  PLAYWRIGHT_CLI="$(command -v playwright-cli 2>/dev/null || true)"
fi

if [ -z "$PLAYWRIGHT_CLI" ]; then
  echo "Error: playwright-cli not found. Run: npm install @playwright/cli" >&2
  exit 1
fi

# Parse wrapper flags
INCOGNITO=false
HEADED=false
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --incognito)
      INCOGNITO=true
      shift
      ;;
    --headed)
      HEADED=true
      shift
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

if [ ${#EXTRA_ARGS[@]} -eq 0 ]; then
  echo "Usage: browser.sh [--incognito] [--headed] <command> [args...]"
  echo ""
  echo "Commands: open, goto, snapshot, click, fill, type, press, screenshot, pdf, close, etc."
  echo "Run 'playwright-cli --help' for full command list."
  exit 1
fi

COMMAND="${EXTRA_ARGS[0]}"
CMD_ARGS=("${EXTRA_ARGS[@]:1}")

# Add persistent profile flags for 'open' command
SESSION_NAME="octopal"
if [ "$COMMAND" = "open" ] && [ "$INCOGNITO" = "false" ]; then
  mkdir -p "$PROFILE_DIR"
  # Clean up stale session state that blocks profile reuse
  "$PLAYWRIGHT_CLI" -s="$SESSION_NAME" close 2>/dev/null || true
  CMD_ARGS+=("--persistent" "--profile=$PROFILE_DIR" "-s=$SESSION_NAME")
fi

# Use the fixed session name for non-open commands
if [ "$COMMAND" != "open" ]; then
  CMD_ARGS=("-s=$SESSION_NAME" "${CMD_ARGS[@]}")
fi

# Add headed flag if requested or if DISPLAY is available (e.g. Xvfb/VNC)
if [ "$COMMAND" = "open" ]; then
  if [ "$HEADED" = "true" ] || [ -n "${DISPLAY:-}" ]; then
    CMD_ARGS+=("--headed")
  fi
fi

# Use chromium browser — prefer Playwright's bundled Chromium over system installs
if [ "$COMMAND" = "open" ]; then
  CMD_ARGS+=("--browser=chromium")
  # Only use system Chromium if explicitly set via env var
  # (Playwright's own Chromium avoids conflicts with system snap/apt Chromium)
  # Required for running Chromium as root in containers
  if [ "$(id -u)" = "0" ] && [ -z "${PLAYWRIGHT_MCP_NO_SANDBOX:-}" ]; then
    export PLAYWRIGHT_MCP_NO_SANDBOX=true
  fi
fi

# Debug output so hangs are diagnosable
echo "[browser] exec: $PLAYWRIGHT_CLI $COMMAND ${CMD_ARGS[*]}" >&2

# Check executable-path exists if specified
if [ -n "${PLAYWRIGHT_MCP_EXECUTABLE_PATH:-}" ] && [ ! -x "$PLAYWRIGHT_MCP_EXECUTABLE_PATH" ]; then
  echo "[browser] WARNING: $PLAYWRIGHT_MCP_EXECUTABLE_PATH not found or not executable" >&2
fi

exec "$PLAYWRIGHT_CLI" "$COMMAND" "${CMD_ARGS[@]}"
