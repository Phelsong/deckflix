'use strict';

/*
 * Trusted player-bar wake (main process).
 *
 * The renderer asks for a fake mouse move on every player input (see
 * lib/spatial.js wakePlayerControls). The nudge is injected as a TRUSTED
 * event so Netflix's mouse-activity idle timer resets and a hidden
 * control bar un-hides exactly like it would for a physical mouse.
 *
 * Delivery channel: Chrome DevTools Protocol Input.dispatchMouseEvent via
 * webContents.debugger. sendInputEvent({type:'mouseMove'}) turned out to
 * be a silent no-op in the castlabs build (keyboard injections work,
 * mouse moves are dropped), and CDP is the same mechanism automation
 * tools use for realistic input. Coordinates are PAGE CSS pixels — no
 * zoom scaling needed (CDP uses the page viewport).
 *
 * SAFETY GATE: injected/foreign input racing fullscreen transitions was
 * observed freezing the page's trusted input pipeline. The injector goes
 * dormant for a moment around every enter/leave-html-full-screen; the
 * renderer's inline force-show (lib/spatial.js) keeps the bar reachable
 * meanwhile. Failures are logged, never thrown.
 */

const { ipcMain } = require('electron');
const cdp = require('./cdp');

const TRANSITION_QUIET_MS = 1000;
const BURST_GAP_MS = 60;         // spaced so events aren't coalesced
const BURST = Object.freeze([0, 3, 6]); // traveling deltas

let lastTransitionAt = 0;

function markFullscreenTransition() {
  lastTransitionAt = Date.now();
}

/**
 * @param {() => Electron.BrowserWindow | null} getWindow
 */
function installPlayerWakeIpc(getWindow) {
  ipcMain.on('deckflix:player-wake', (_event, x, y) => {
    try {
      if (Date.now() - lastTransitionAt < TRANSITION_QUIET_MS) return; // gate
      const win = getWindow();
      if (!win || win.isDestroyed()) return;
      const wc = win.webContents;
      const px = Math.max(0, Math.round(Number(x) || 0));
      const py = Math.max(0, Math.round(Number(y) || 0));
      (async () => {
        await cdp.ensureAttached(wc);
        // Traveling burst: consecutive positions carry motion deltas.
        for (let i = 0; i < BURST.length; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, BURST_GAP_MS));
          if (Date.now() - lastTransitionAt < TRANSITION_QUIET_MS) return; // re-check
          await cdp.send(wc, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: px + BURST[i],
            y: py,
            button: 'none',
            pointerType: 'mouse',
          });
        }
      })().catch((err) => {
        console.warn('[deckflix] player wake (cdp) failed:', err?.message || err);
      });
    } catch (err) {
      console.warn('[deckflix] player wake failed:', err?.message || err);
    }
  });
}

module.exports = { installPlayerWakeIpc, markFullscreenTransition };