'use strict';

/*
 * Top-layer-aware overlay host.
 *
 * When the Netflix player goes fullscreen (gamepad Y) the player element
 * enters the browser's TOP LAYER and everything outside its subtree —
 * our focus ring, toasts, guide, menu, stats — is painted underneath and
 * disappears. The fix is to re-parent overlay roots into the fullscreen
 * element for as long as it exists and back into <body> on exit.
 *
 *   attachTopLayer(el)  — place el in the top layer (or body) now
 *   trackTopLayer(el)   — + keep el placed across fullscreen changes
 *
 * Both are tolerant of missing registry (loaded before spatial boots).
 */

const tracked = new Set();
let fsWasFocused = false;

function layerHost() {
  const fs = document.fullscreenElement;
  if (!fs) return document.body;
  // Media elements don't render appended children (they're fallback
  // content, invisible in hit-test and paint); avoid parking overlays
  // inside one. Netflix fullscreens a container div, which is safe.
  if (/^(video|audio)$/i.test(fs.tagName)) return document.body;
  return fs;
}

function attachTopLayer(el) {
  const host = layerHost();
  if (el.parentElement !== host) host.appendChild(el);
}

function trackTopLayer(el) {
  tracked.add(el);
  attachTopLayer(el);
}

document.addEventListener('fullscreenchange', () => {
  for (const el of tracked) {
    if (el.isConnected) attachTopLayer(el);
  }
  const fs = document.fullscreenElement;
  if (fs) {
    // Chromium constrains keyboard delivery to the top layer: keep DOM
    // focus inside it, or unmapped keys can stop reaching the page.
    if (!fs.contains(document.activeElement)) {
      fs.setAttribute('tabindex', '-1');
      fs.focus({ preventScroll: true });
    }
  } else if (fsWasFocused) {
    // Leaving fullscreen: release the focus we parked on the container.
    document.activeElement?.blur?.();
  }
  fsWasFocused = !!fs;
});

window.__deckflix = Object.assign({}, window.__deckflix, {
  attachTopLayer,
  trackTopLayer,
});