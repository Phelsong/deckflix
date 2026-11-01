'use strict';

/*
 * Gamepad/remote → semantic input bus.
 *
 * Polls all connected gamepads on every animation frame using the W3C
 * Standard Gamepad mapping (Xbox controllers, Steam Deck, and most TV
 * remote receivers report this layout) and emits `deckflix-input`
 * CustomEvents on `window`.
 *
 * detail.action ∈ 'nav' | 'activate' | 'back' | 'seek' | 'fullscreen'
 *               | 'volume' | 'scroll' | 'menu' | 'guide'
 * detail.arg    — 'nav': direction string; 'seek': ±10; 'volume': ±1;
 *               'scroll': {x, y} page-space delta in px.
 *
 * Back/select is edge-aware: a tap emits 'back' on release; a hold of
 * BACK_HOLD_MENU_MS emits 'menu' once (DeckFlix overlay menu).
 * LB/RB seek repeats every SEEK_REPEAT_MS while held.
 *
 * Directional input (d-pad + left stick) auto-repeats while held:
 * first repeat after NAV_HOLD_DELAY_MS, then every NAV_REPEAT_MS.
 * Everything else is one-shot per press.
 */

const NAV_HOLD_DELAY_MS = 350;
const NAV_REPEAT_MS = 130;
const NAV_REPEAT_MIN_MS = 65;   // repeat interval when the stick is fully deflected
const STICK_ENGAGE = 0.6;       // magnitude to start treating the stick as a d-pad
const STICK_RELEASE = 0.35;     // magnitude below which a held direction is dropped

const SCROLL_DEADZONE = 0.15;              // right-stick deadzone
const SCROLL_SPEED_PX_PER_SEC = 1400;      // at full deflection (quadratic ramp)
const SCROLL_MAX_FRAME_DT_MS = 100;        // clamp dt spikes (tab switch, etc.)

const BACK_HOLD_MENU_MS = 700; // hold Back to open the DeckFlix menu
const SEEK_REPEAT_MS = 200;    // LB/RB hold: seek repeat cadence

const BUTTON = Object.freeze({
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9,
  D_UP: 12, D_DOWN: 13, D_LEFT: 14, D_RIGHT: 15,
});
// X opens the on-screen control guide; LB/RB drive player volume.
const GUIDE_BUTTON = BUTTON.X;

const DIRECTIONS = Object.freeze(['up', 'down', 'left', 'right']);
const D_PAD_BUTTON = Object.freeze({
  up: BUTTON.D_UP, down: BUTTON.D_DOWN, left: BUTTON.D_LEFT, right: BUTTON.D_RIGHT,
});

const padStates = new Map();

function emit(action, arg) {
  window.dispatchEvent(new CustomEvent('deckflix-input', { detail: { action, arg } }));
}

/*
 * Nav repeat interval scales with stick deflection: a gentle lean still
 * auto-repeats (at NAV_REPEAT_MS), pushing the stick fully over speeds
 * the cadence up toward NAV_REPEAT_MIN_MS. D-pad presses use base rate.
 */
function navRepeatIntervalMs(magnitude) {
  const m = Math.max(0, Math.min(1, magnitude));
  return NAV_REPEAT_MS - (NAV_REPEAT_MS - NAV_REPEAT_MIN_MS) * m;
}

function isPressed(btn) {
  return !!btn && (btn.pressed || btn.value > 0.5);
}

function dominantDirection(x, y) {
  if (Math.abs(x) >= Math.abs(y)) return x > 0 ? 'right' : 'left';
  return y > 0 ? 'down' : 'up';
}

function pollPads() {
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const now = performance.now();
  const dtMs = pollPads.lastTime ? Math.min(now - pollPads.lastTime, SCROLL_MAX_FRAME_DT_MS) : 0;
  pollPads.lastTime = now;

  for (const pad of gamepads) {
    if (!pad) continue;

    let state = padStates.get(pad.index);
    if (!state) {
      state = { oneShot: {}, heldDirs: {}, heldSeek: {} };
      padStates.set(pad.index, state);
    }
    const b = pad.buttons;

    // One-shot buttons: fire on the press edge only.
    const edge = (index, handler) => {
      const down = isPressed(b[index]);
      const wasDown = state.oneShot[index];
      state.oneShot[index] = down;
      if (down && !wasDown) handler();
    };
    edge(BUTTON.A, () => emit('activate'));
    edge(BUTTON.B, () => emit('back'));
    edge(BUTTON.Y, () => emit('fullscreen'));
    edge(GUIDE_BUTTON, () => emit('guide'));
    edge(BUTTON.START, () => emit('menu'));
    edge(BUTTON.RT, () => emit('volume', 1));
    edge(BUTTON.LT, () => emit('volume', -1));

    // Seek bumpers: fire on press, then repeat on a short hold debounce
    // (~SEEK_REPEAT_MS) while held — scrubbing feels like Netflix's own UI.
    const seekRepeat = (index, arg) => {
      const down = isPressed(b[index]);
      state.heldSeek = state.heldSeek || {};
      const held = state.heldSeek[index] || (state.heldSeek[index] = { wasDown: false, nextFireAt: 0 });
      if (down && !held.wasDown) {
        held.wasDown = true;
        held.nextFireAt = now + SEEK_REPEAT_MS;
        emit('seek', arg);
      } else if (down && now >= held.nextFireAt) {
        held.nextFireAt = now + SEEK_REPEAT_MS;
        emit('seek', arg);
      } else if (!down && held.wasDown) {
        held.wasDown = false;
      }
    };
    seekRepeat(BUTTON.RB, 10);
    seekRepeat(BUTTON.LB, -10);

    // Back/select: 'back' fires on release (fast taps feel unchanged);
    // holding it ≥ BACK_HOLD_MENU_MS opens the DeckFlix menu instead.
    const backDown = isPressed(b[BUTTON.BACK]);
    if (backDown && !state.backDown) {
      state.backDown = true;
      state.backHeldSince = now;
      state.backFired = false;
    } else if (backDown && !state.backFired && now - state.backHeldSince >= BACK_HOLD_MENU_MS) {
      emit('menu');
      state.backFired = true;
    } else if (!backDown && state.backDown) {
      state.backDown = false;
      if (!state.backFired) emit('back');
    }

    // Directional set for this frame: d-pad first…
    const heldNow = new Set();
    for (const dir of DIRECTIONS) {
      if (isPressed(b[D_PAD_BUTTON[dir]])) heldNow.add(dir);
    }

    // …then the left stick, with hysteresis so it doesn't flicker.
    const axisX = pad.axes[0] || 0;
    const axisY = pad.axes[1] || 0;
    const magnitude = Math.hypot(axisX, axisY);
    if (state.stickDir) {
      const stillEngaged =
        magnitude >= STICK_RELEASE && dominantDirection(axisX, axisY) === state.stickDir;
      if (!stillEngaged) state.stickDir = null;
    } else if (magnitude >= STICK_ENGAGE) {
      state.stickDir = dominantDirection(axisX, axisY);
    }
    if (state.stickDir) {
      state.stickMag = magnitude; // fresh each frame: deflection tunes repeat speed
      heldNow.add(state.stickDir);
    }

    // Emit with auto-repeat, cadence scaled by stick deflection.
    for (const dir of DIRECTIONS) {
      const repeater = state.heldDirs[dir];
      const dirMag = state.stickDir === dir ? state.stickMag : 1;
      if (heldNow.has(dir)) {
        if (!repeater) {
          emit('nav', dir);
          state.heldDirs[dir] = { nextFireAt: now + NAV_HOLD_DELAY_MS };
        } else if (now >= repeater.nextFireAt) {
          emit('nav', dir);
          repeater.nextFireAt = now + navRepeatIntervalMs(dirMag);
        }
      } else if (repeater) {
        delete state.heldDirs[dir];
      }
    }

    // Right stick: smooth omnidirectional page scrolling (per-frame px).
    // Quadratic ramp: full deflection → SCROLL_SPEED_PX_PER_SEC; near the
    // deadzone it feathers in for precise short nudges.
    const scrollX = pad.axes[2] || 0;
    const scrollY = pad.axes[3] || 0;
    if (
      Math.abs(scrollX) > SCROLL_DEADZONE ||
      Math.abs(scrollY) > SCROLL_DEADZONE
    ) {
      const px = (v) =>
        Math.abs(v) > SCROLL_DEADZONE
          ? v * Math.abs(v) * SCROLL_SPEED_PX_PER_SEC * (dtMs / 1000)
          : 0;
      emit('scroll', { x: px(scrollX), y: px(scrollY) });
    }
  }

  requestAnimationFrame(pollPads);
}

// Test mode detaches from physical devices: the harness drives
// deckflix-input directly, so real pads on the desktop must not inject
// edges into background runs.
if (!window.__deckflixOptions?.testMode) {
  pollPads();
}