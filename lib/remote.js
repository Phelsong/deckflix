'use strict';

/*
 * TV-remote front-end: keyboard keys → `deckflix-input` semantics.
 *
 * Linux TV remotes (Android TV boxes, media-center receivers, most
 * "air mouse" remotes) enumerate as keyboard devices: arrows act as the
 * d-pad, Enter is OK, Escape/Backspace is Back, and dedicated media keys
 * arrive as `Media*` / `XF86Audio*` keysyms. Mapped onto the same
 * semantic bus the gamepad feeds, so all existing modes keep working:
 *   browse → spatial nav, activate, back, page scroll, menu, home
 *   player → media keys drive play/pause/seek/volume (shared with MPRIS)
 *
 * Only REAL input is handled (isTrusted): the synthetic keys we dispatch
 * ourselves (lib/spatial.js sendKey) must not feed back into this mapper.
 * Typing is never hijacked: while a text field holds focus, text-ish keys
 * are ignored and only media/volume keys pass through.
 */

const KEY_REPEAT_MIN_MS = 140; // throttle OS key auto-repeat to nav cadence

const NAV_SEMANTICS = Object.freeze({
  ArrowUp: { action: 'nav', arg: 'up' },
  ArrowDown: { action: 'nav', arg: 'down' },
  ArrowLeft: { action: 'nav', arg: 'left' },
  ArrowRight: { action: 'nav', arg: 'right' },
});

// One-shot mappings (ignores keyboard auto-repeat).
const KEY_SEMANTICS = Object.freeze({
  Enter: { action: 'activate' },
  NumpadEnter: { action: 'activate' },
  Escape: { action: 'back' },
  BrowserBack: { action: 'back' },
  Backspace: { action: 'back' },
  ContextMenu: { action: 'menu' },
  Home: { action: 'home' },
  PageUp: { action: 'page', arg: -1 },
  PageDown: { action: 'page', arg: 1 },
  XF86AudioRaiseVolume: { action: 'volume', arg: 1 },
  XF86AudioLowerVolume: { action: 'volume', arg: -1 },
});

// Media-family keysyms route through the MPRIS command path so remote
// and desktop clients share one playback-control implementation.
const MEDIA_SEMANTICS = Object.freeze({
  MediaPlayPause: { mpris: 'playpause' },
  MediaPlay: { mpris: 'play' },
  MediaPause: { mpris: 'pause' },
  MediaStop: { mpris: 'stop' },
  MediaFastForward: { mpris: 'seek', arg: 10 },
  MediaRewind: { mpris: 'seek', arg: -10 },
  MediaSkipForward: { mpris: 'seek', arg: 10 },
  MediaSkipBackward: { mpris: 'seek', arg: -10 },
  MediaTrackNext: { mpris: 'seek', arg: 10 },
  MediaTrackPrevious: { mpris: 'seek', arg: -10 },
});

const lastFireAt = new Map(); // per-key repeat throttle

function isTyping() {
  const ask = window.__deckflix && window.__deckflix.isTypingTarget;
  return ask ? !!ask() : false;
}

function emit(action, arg) {
  window.dispatchEvent(new CustomEvent('deckflix-input', { detail: { action, arg } }));
}

function emitMpris(command, arg) {
  window.dispatchEvent(new CustomEvent('deckflix-mpris', { detail: { command, arg } }));
}

/*
 * Handle one remote key. Returns the mapping object when the key was
 * consumed (the caller should preventDefault), null when it wasn't ours.
 */
function handleRemoteKey(key, repeat) {
  const map = NAV_SEMANTICS[key] || MEDIA_SEMANTICS[key] || KEY_SEMANTICS[key];
  if (!map) return null;

  // Nav keys honor keyboard auto-repeat (throttled); one-shots ignore it.
  if (NAV_SEMANTICS[key]) {
    const now = performance.now();
    if (repeat && now - (lastFireAt.get(key) || 0) < KEY_REPEAT_MIN_MS) return null;
    lastFireAt.set(key, now);
  } else if (repeat) {
    return null;
  }

  // Text safety: while typing, arrows/Enter/Backspace/PageUp belong to the
  // field; media + volume keys don't disturb text and still pass through.
  if (isTyping() && !map.mpris && map.action !== 'volume') return null;

  if (map.mpris) {
    emitMpris(map.mpris, map.arg);
  } else if (map.action === 'page') {
    // Channel-style page hop (remote PageUp/Down).
    emit('scroll', {
      x: 0,
      y: (map.arg > 0 ? 1 : -1) * window.innerHeight * 0.75,
    });
  } else {
    emit(map.action, map.arg);
  }
  return map;
}

/*
 * Mapped keys are consumed at the CAPTURE phase with
 * stopImmediatePropagation: Netflix attaches its own key listeners
 * (player seek/play-pause, browse focus) that run regardless of
 * preventDefault, so mapped keys must never reach them. Our preload
 * registers before any page script, so we are first in the capture
 * chain. Unmapped keys and everything untrusted (our own synthesized
 * keys, which Netflix DOES need to receive) pass straight through.
 */
// Test mode: no trusted-key listener (physical remotes/keyboards are
// excluded from harness runs); remoteKey stays exposed for the driver.
if (!window.__deckflixOptions?.testMode) {
  window.addEventListener('keydown', (event) => {
    if (event.isTrusted !== true) return; // never re-handle our own synthetic keys
    try {
      if (handleRemoteKey(event.key, event.repeat)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    } catch (err) {
      console.warn('[deckflix] remote key error:', err);
    }
  }, true);

  window.addEventListener('keyup', (event) => {
    if (event.isTrusted) lastFireAt.delete(event.key);
  });
}

// Register into the shared feature registry; remoteKey lets tests and
// integrations drive the mapping without fabricating trusted events.
window.__deckflix = Object.assign({}, window.__deckflix, {
  remoteKey: handleRemoteKey,
});