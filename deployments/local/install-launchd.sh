#!/usr/bin/env bash
# Installs (or removes) the OPENTRADIE API LaunchAgent for the current user.
#   install-launchd.sh install     build must already exist (pnpm build)
#   install-launchd.sh uninstall
# Authored without a launchd test run in CI; verify on the target Mac (see README.md here).
set -euo pipefail

LABEL="ai.opentradie.api"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/opentradie"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    [ -f "$REPO/.env" ] || { echo "Missing $REPO/.env (run: pnpm setup:dev)" >&2; exit 1; }
    [ -f "$REPO/dist/api/server.js" ] || { echo "Missing build output (run: pnpm build)" >&2; exit 1; }
    NODE_BIN="$(command -v node)" || { echo "node not found on PATH" >&2; exit 1; }
    mkdir -p "$LOGDIR" "$(dirname "$TARGET")"
    sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__REPO__|$REPO|g" -e "s|__LOGDIR__|$LOGDIR|g" \
      "$REPO/deployments/local/$LABEL.plist.template" > "$TARGET"
    plutil -lint "$TARGET"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$TARGET"
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "Installed $LABEL. Logs: $LOGDIR. Check: curl -fsS http://127.0.0.1:3000/health"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$TARGET"
    echo "Removed $LABEL."
    ;;
  *)
    echo "usage: $0 install|uninstall" >&2
    exit 2
    ;;
esac
