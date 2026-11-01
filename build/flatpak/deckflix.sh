#!/bin/bash
# DeckFlix launcher (inside the flatpak).
set -e

ELECTRON=/app/deckflix/node_modules/electron/dist/electron
APP=/app/deckflix

if [ -x /app/bin/zypak-wrapper.sh ]; then
  exec /app/bin/zypak-wrapper.sh "$ELECTRON" --ozone-platform-hint=auto "$APP" "$@"
else
  # BaseApp without zypak: electron's own zygote can't run in the sandbox.
  exec "$ELECTRON" --no-sandbox --ozone-platform-hint=auto "$APP" "$@"
fi
