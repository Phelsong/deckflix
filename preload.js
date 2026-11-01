'use strict';

/*
 * DeckFlix renderer bootstrap.
 *
 * Runs in the page world (contextIsolation:false) so that lib/input
 * can poll the Gamepad API and lib/spatial can walk the Netflix DOM.
 * lib/ is layered:
 *   lib/input.js   — gamepad hardware → semantic `deckflix-input` events
 *   lib/spatial.js — semantic events → focus movement / clicks / hotkeys
 * plus presentation and integration pieces:
 *   lib/hud.js     — action toasts + click-pulse feedback (deckflix-feedback)
 *   lib/guide.js   — on-screen control guide (gamepad X toggles)
 *   lib/menu.js    — DeckFlix overlay menu (Back-hold / Start; quit, zoom)
 *   lib/stats.js   — player stats overlay modal (menu → Player Stats)
 *   lib/remote.js  — TV-remote keyboard front-end (arrows/Enter/media keys)
 *
 * Harness mode (DECKFLIX_TEST=1) detaches tests from physical devices:
 * gamepad polling and the trusted-key remote listener are disabled so
 * background runs can't be polluted by input on the real desktop.
 */

window.__deckflixOptions = Object.freeze({
  testMode: process.env.DECKFLIX_TEST === '1',
});

require('./lib/fullscreen'); // top-layer overlay host (must load before consumers)
require('./lib/input');
require('./lib/spatial');
require('./lib/hud');
require('./lib/guide');
require('./lib/menu');
require('./lib/stats');
require('./lib/remote');

/* ------------------------------------------------------------------ */
/* MPRIS bridge (main process ↔ page-world)                            */
/* ------------------------------------------------------------------ */

/*
 * lib/mpris.js owns the D-Bus side (media keys, desktop media controls).
 * Commands main→renderer arrive as `deckflix-mpris` events; the renderer
 * reports playback state back via deckflix:status (see lib/spatial.js).
 * This is the only place that touches ipcRenderer.
 */
const { ipcRenderer } = require('electron');

ipcRenderer.on('deckflix-mpris', (_event, msg) => {
  window.dispatchEvent(new CustomEvent('deckflix-mpris', { detail: msg || {} }));
});

window.__deckflixBridge = Object.freeze({
  sendStatus: (status) => ipcRenderer.send('deckflix:status', status),
  // App-level actions from the DeckFlix menu (quit, fullscreen, zoom).
  appAction: (action, arg) => ipcRenderer.send('deckflix:app-action', action, arg),
  // Trusted mouse nudge for Netflix's real-mouse player autohide timer.
  wakePlayer: (x, y) => ipcRenderer.send('deckflix:player-wake', x, y),
  // Media pipeline digest for the stats modal (CDP Media domain).
  mediaInfo: () => ipcRenderer.invoke('deckflix:media-info'),
});

/* Test-mode driver runner: main executes test drivers INSIDE this (the
 * preload) world, where the feature registry and the bridge live. Only
 * exists when DECKFLIX_TEST=1 — the production renderer has no eval path. */
if (window.__deckflixOptions.testMode) {
  ipcRenderer.on('deckflix-test:eval', async (_event, callId, code) => {
    try {
      const result = await eval(code);
      ipcRenderer.send('deckflix-test:result', callId, JSON.stringify(result));
    } catch (err) {
      ipcRenderer.send('deckflix-test:result', callId,
        JSON.stringify({ driverError: String((err && err.stack) || err) }));
    }
  });
}

// Diagnostics: confirm Widevine is reachable in this session. The result
// lands on window.__deckflixWidevine for the stats modal to report.
if (navigator.requestMediaKeySystemAccess) {
  window.__deckflixWidevine = undefined;
  navigator
    .requestMediaKeySystemAccess('com.widevine.alpha', [
      {
        initDataTypes: ['cenc'],
        videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.64001f"' }],
      },
    ])
    .then(() => {
      window.__deckflixWidevine = true;
      console.log('[deckflix] widevine available');
    })
    .catch((err) => {
      window.__deckflixWidevine = false;
      console.warn('[deckflix] widevine NOT available:', err?.message || err);
    });
}