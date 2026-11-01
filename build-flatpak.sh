#!/bin/bash
# DeckFlix flatpak build wrapper.
#
# Usage:
#   ./build-flatpak.sh            # build + install + emit dist bundle
#   ./build-flatpak.sh --run-after  # ... then launch the installed app
#
# Produces:
#   - the installed app (user flatpak install)
#   - dist/com.deckflix.DeckFlix-<version>.flatpak (single-file bundle;
#     installable elsewhere with: flatpak install ./<file>.flatpak —
#     the runtime itself is NOT bundled; targets need the runtime)
#
# Requires: npm install ran in the project root first (prebuilt app),
# flatpak + flatpak-builder, and the org.freedesktop.Sdk + Electron2
# BaseApp 26.08 runtimes (script installs them on first run).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$ROOT/build/flatpak/com.deckflix.DeckFlix.yml"
BUILD_DIR="$ROOT/.flatpak-build/work"   # NEVER build inside build/flatpak (sources!)
STAGE_REPO="$ROOT/.flatpak-build/repo"  # flatpak-builder's staged repo (bundle source)

APP_ID="com.deckflix.DeckFlix"
RUNTIME="org.freedesktop.Sdk//26.08"
BASEAPP="org.electronjs.Electron2.BaseApp//26.08"
BRANCH="${BRANCH:-master}"

cd "$ROOT"

# --- prerequisites ---------------------------------------------------------

if [ ! -f node_modules/.bin/electron ] && [ ! -d node_modules/electron/dist ]; then
  echo "[build-flatpak] node_modules missing: running npm install (Widevine electron)... "
  npm install
fi

command -v flatpak-builder >/dev/null 2>&1 || {
  echo "ERROR: flatpak-builder is not installed."
  exit 1
}

ensure_runtime() {
  if ! flatpak info --user "$1" >/dev/null 2>&1 \
     && ! flatpak info --system "$1" >/dev/null 2>&1; then
    echo "[build-flatpak] installing runtime/baseapp: $1"
    if ! flatpak install --user -y flathub "$1" 2>/dev/null; then
      # user repo without the remote yet: add it, then retry
      flatpak remote-add --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo 2>/dev/null || true
      flatpak install --user -y flathub "$1"
    fi
  fi
}
ensure_runtime "$RUNTIME"
ensure_runtime "$BASEAPP"

# --- build into the staged repo (bundles + installs come from it) ----------

echo "[build-flatpak] building (artifacts in .flatpak-build/ — sources untouched)"
flatpak-builder --user \
  --default-branch="$BRANCH" \
  --force-clean \
  --repo="$STAGE_REPO" \
  "$BUILD_DIR" \
  "$MANIFEST"
echo "[build-flatpak] build staged"

# Install the built app from the staged repo.
flatpak install --user -y --noninteractive --reinstall "$STAGE_REPO" "$APP_ID"
echo "[build-flatpak] installed: $APP_ID"

# --- single-file bundle export ---------------------------------------------

VERSION="$(node -p 'require("./package.json").version' 2>/dev/null || echo unknown)"
OUT_DIR="$ROOT/dist"
OUT_FILE="$OUT_DIR/$APP_ID-$VERSION.flatpak"
mkdir -p "$OUT_DIR"

echo "[build-flatpak] exporting single-file bundle: $OUT_FILE"
flatpak build-bundle "$STAGE_REPO" "$OUT_FILE" "$APP_ID" "$BRANCH"
echo "[build-flatpak] bundle size: $(du -h "$OUT_FILE" | cut -f1)"

if [ "${1:-}" = "--run-after" ]; then
  exec flatpak run "$APP_ID"
else
  echo "run it with:      flatpak run $APP_ID"
  echo "install bundle:   flatpak install $OUT_FILE"
fi