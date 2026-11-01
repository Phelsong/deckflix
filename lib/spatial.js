'use strict';

/*
 * Full custom spatial navigator over the Netflix web UI.
 *
 * Consumes `deckflix-input` events (see lib/input.js) and owns ALL focus
 * movement: we maintain our own focus target, draw our own focus ring and
 * decide where a directional press goes (sweep-beam nearest-neighbour over
 * the interactive elements visible on screen). Netflix's native keyboard
 * navigation is left untouched for real keyboards.
 *
 * Two modes, driven by the URL path:
 *   browse — /profiles /browse /search /latest … → spatial navigation
 *   player — /watch/<id> → sticks/d-pad still navigate spatially over the
 *            visible player controls; A = play/pause (or click the focused
 *            control), B = back, LB/RB = seek ∓10 s, LT/RT = volume,
 *            Y fullscreen, X guide, B-hold/Start = DeckFlix menu.
 */

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

const SELECTORS = [
  // Priority order only affects pruning inside collectCandidates().
  '[data-profile-guid]',               // profile picker tiles
  '[data-uia="search-icon-button"]',   // search entry point
  '.slider-item',                      // browse row card containers
  'a[href]',
  'button',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="tab"]',
];

const RING_ID = 'deckflix-focus-ring';
const RING_STYLE_ID = 'deckflix-ring-style';
const PAGE_STYLE_ID = 'deckflix-page-style';
/*
 * Page chrome overrides for the TV/desktop app:
 * hidden scrollbars everywhere (pages scroll, but the scrollbar itself is
 * visual noise on a 10-foot UI; movement/scrolling is controller-driven).
 */
const PAGE_CSS = `
  ::-webkit-scrollbar { width: 0; height: 0; display: none; }
  * { scrollbar-width: none; }
`;
const RING_CSS = `
  #${RING_ID} {
    position: fixed;
    left: 0;
    top: 0;
    padding: 6px;
    pointer-events: none;
    z-index: 2147483647;
    border-radius: 12px;
    border: 3px solid rgba(229, 9, 20, 0.95);
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.9), 0 0 14px rgba(229, 9, 20, 0.45);
    transition: transform 110ms ease-out, width 110ms ease-out,
                height 110ms ease-out, opacity 150ms ease-out;
    opacity: 0;
    box-sizing: content-box;
  }
`;

// Candidate pickup extends past the viewport so off-screen cards in an
// overflowing row can be walked into (they scroll into view afterwards).
const CAPTURE_MARGIN_X = 260;
const CAPTURE_MARGIN_Y_FRACTION = 0.4;

const MOVE_SEPARATION_PX = 8;      // minimum progress along the move axis
const OVERLAP_ALIGN_RATIO = 0.25;  // above this lateral overlap, alignment weight drops
const ALIGN_WEIGHT_NEAR = 1.5;     // score weight on lateral offset when aligned
const ALIGN_WEIGHT_FAR = 4.0;      // score weight on lateral offset when misaligned

const ROUTE_POLL_MS = 400;
const FOCUS_RETRY_MS = 300;
const FOCUS_RETRY_COUNT = 10;
const OVERLAY_RECOVERY_DEBOUNCE_MS = 250;
const PLAYER_KEY_VERIFY_MS = 350; // wait for Netflix to react before driving <video> directly
const STATUS_POLL_MS = 2000;      // report playback state to main (MPRIS)

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

let focusedElement = null;
let ringElement = null;
let currentHref = location.href;

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

function inPlayerMode() {
  return location.pathname.startsWith('/watch/');
}

function captureBounds() {
  return {
    left: -CAPTURE_MARGIN_X,
    right: window.innerWidth + CAPTURE_MARGIN_X,
    top: -window.innerHeight * CAPTURE_MARGIN_Y_FRACTION,
    bottom: window.innerHeight + window.innerHeight * CAPTURE_MARGIN_Y_FRACTION,
  };
}

function elementRect(el) {
  return el.getBoundingClientRect();
}

function isCandidateVisible(rect) {
  const bounds = captureBounds();
  return (
    rect.width >= 12 &&
    rect.height >= 12 &&
    rect.right > bounds.left &&
    rect.left < bounds.right &&
    rect.bottom > bounds.top &&
    rect.top < bounds.bottom
  );
}

/*
 * Occlusion: if something unrelated (a modal backdrop, a drawer, an
 * expanded hover panel) sits above the element's centre point, the
 * element is invisible to the user and is removed from the candidate
 * pool. This is what keeps navigation from getting trapped in, or
 * clicking through, the layer underneath a popup: candidates above the
 * backdrop survive this test, everything below it doesn't.
 */
function isOccluded(el, rect) {
  if (rect.width <= 0 || rect.height <= 0) return true;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const stack = document.elementsFromPoint(cx, cy);
  if (stack.length === 0) {
    // Off-viewport or unrendered: not *covered* by anything. Reachable by
    // our capture margins (walk-to-it-and-scroll), e.g. zoomed layouts.
    return false;
  }
  for (const node of stack) {
    if (node.id === RING_ID) continue; // our own ring never occludes
    if (node.contains(el)) return false; // reached el's subtree from the top
    if (el.contains(node)) return false; // (defensive) same subtree
    return true; // unrelated element stacked above
  }
  return false;
}

/*
 * Collect focusable candidates in document order. Elements that merely
 * contain a real interactive element are pruned (e.g. `.slider-item`
 * wrappers holding their inner `<a>`), so focus lands on things that
 * actually activate. Natively-interactive tags (a/button/roles, profile
 * tiles) are never pruned in favour of their children.
 * Geometry visibility is cheap and checked by the caller.
 */
function collectCandidates() {
  const seen = new Set();
  const ordered = [];
  for (const selector of SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      if (!seen.has(el)) {
        seen.add(el);
        ordered.push(el);
      }
    }
  }
  const isNativelyInteractive = (el) =>
    el.matches('a, button, [role="button"], [role="menuitem"], [role="tab"], [data-profile-guid]');

  return ordered.filter((el, index) => {
    if (isNativelyInteractive(el)) return true;
    // Document order: any descendant candidate comes after `index`.
    for (let j = index + 1; j < ordered.length; j++) {
      if (el.contains(ordered[j])) return false;
    }
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Focus ring                                                          */
/* ------------------------------------------------------------------ */

function ensurePageChrome() {
  if (!document.getElementById(PAGE_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = PAGE_STYLE_ID;
    style.textContent = PAGE_CSS;
    document.head.appendChild(style);
  }
}

function ensureRing() {
  if (!document.getElementById(RING_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = RING_STYLE_ID;
    style.textContent = RING_CSS;
    document.head.appendChild(style);
  }
  if (!ringElement || !ringElement.isConnected) {
    ringElement = document.createElement('div');
    ringElement.id = RING_ID;
    document.body.appendChild(ringElement);
  }
  // Fullscreen-safe: the top layer covers everything outside its subtree.
  window.__deckflix?.trackTopLayer?.(ringElement);
  window.__deckflix?.attachTopLayer?.(ringElement);
}

function setFocused(el) {
  const previous = focusedElement;
  focusedElement = el;
  // Leaving an element cancels Netflix's pending hover-preview timer so
  // the preview modal doesn't keep opening for the card we just left.
  if (previous && previous !== el && previous.isConnected) {
    previous.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  }
  if (el) {
    ensureRing();
    if (inPlayerMode()) rememberPlayerControl(el); // trail for bar force-show
    // Hover drives Netflix's own preview/title UIs (browse) and keeps the
    // player control bar visible (player). Optional off-switch (menu
    // setting) applies to browse only; activation never depends on hover.
    if (shouldShowPreviews() || inPlayerMode()) {
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    }
  }
}

function shouldShowPreviews() {
  const ask = window.__deckflix && window.__deckflix.showPreviews;
  return ask ? !!ask() : true;
}

/* ------------------------------------------------------------------ */
/* Movement                                                            */
/* ------------------------------------------------------------------ */

const DIRECTION_SIGN = Object.freeze({
  up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
});

function scoreMove(focusRect, candRect, direction) {
  const [sx, sy] = DIRECTION_SIGN[direction];
  const focusCx = focusRect.left + focusRect.width / 2;
  const focusCy = focusRect.top + focusRect.height / 2;
  const candCx = candRect.left + candRect.width / 2;
  const candCy = candRect.top + candRect.height / 2;

  const primary = sx !== 0 ? (candCx - focusCx) * sx : (candCy - focusCy) * sy;
  if (primary < MOVE_SEPARATION_PX) return Infinity;

  const lateral = sx !== 0 ? Math.abs(candCy - focusCy) : Math.abs(candCx - focusCx);
  let overlapRatio;
  if (sx !== 0) {
    const overlap = Math.min(focusRect.bottom, candRect.bottom) - Math.max(focusRect.top, candRect.top);
    overlapRatio = overlap / Math.min(focusRect.height, candRect.height);
  } else {
    const overlap = Math.min(focusRect.right, candRect.right) - Math.max(focusRect.left, candRect.left);
    overlapRatio = overlap / Math.min(focusRect.width, candRect.width);
  }
  const weight = overlapRatio >= OVERLAP_ALIGN_RATIO ? ALIGN_WEIGHT_NEAR : ALIGN_WEIGHT_FAR;
  return primary + weight * lateral - 0.25 * overlapRatio; // nudge toward aligned targets
}

function moveFocus(direction) {
  if (
    !focusedElement ||
    !focusedElement.isConnected ||
    isOccluded(focusedElement, elementRect(focusedElement))
  ) {
    // Stale or covered (e.g. a popup just opened): restart on the top layer.
    initialFocus();
    return;
  }
  const focusRect = elementRect(focusedElement);
  let best = null;
  let bestScore = Infinity;
  for (const candidate of collectCandidates()) {
    if (candidate === focusedElement) continue;
    const rect = elementRect(candidate);
    if (!isCandidateVisible(rect) || isOccluded(candidate, rect)) continue;
    const score = scoreMove(focusRect, rect, direction);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (best) {
    setFocused(best);
    best.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  } else if (direction === 'up' || direction === 'down') {
    // Nothing above/below in the candidate set: page-level scroll.
    window.scrollBy({
      top: (direction === 'down' ? 1 : -1) * window.innerHeight * 0.75,
      behavior: 'smooth',
    });
  }
}

function focusNearestTo(x, y) {
  let best = null;
  let bestScore = Infinity;
  for (const candidate of collectCandidates()) {
    const rect = elementRect(candidate);
    if (!isCandidateVisible(rect) || isOccluded(candidate, rect)) continue;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const score = Math.hypot(cx - x, cy - y);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best) setFocused(best);
  return best;
}

function initialFocus() {
  return focusNearestTo(window.innerWidth / 2, window.innerHeight * 0.45);
}

// Re-take focus on the visible layer right now (overlay modules call this
// when they open, so the menu/guide owns focus immediately).
function retakeFocus() {
  initialFocus();
}

/* ------------------------------------------------------------------ */
/* Activation / back                                                   */
/* ------------------------------------------------------------------ */

// Click the element (or its interactive wrapper) and pulse: shared by
// browse and player activation.
function activateElement(el) {
  // Resolve the real click target: prefer the element itself or its closest
  // interactive ancestor, otherwise the interactive element inside the card
  // wrapper (e.g. profile tiles and container divs holding an `<a>`).
  const target =
    el.closest('a, button, [role="button"]') ||
    el.querySelector('a[href], button, [role="button"]') ||
    el;

  target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  target.click();
  pulseAt(target.getBoundingClientRect());
}

function activate() {
  if (!focusedElement || !focusedElement.isConnected) return;

  if (isOccluded(focusedElement, elementRect(focusedElement))) {
    initialFocus(); // a popup opened over the focused card: take the popup first
    return;
  }

  if (/^(input|textarea|select)$/i.test(focusedElement.tagName)) {
    focusedElement.focus(); // defer to the physical keyboard for typing
    return;
  }

  activateElement(focusedElement);
}

function goBack() {
  if (history.length > 1) {
    history.back(); // real SPA history (browse ↔ detail ↔ player)
  } else {
    location.assign('/');
  }
}

/* ------------------------------------------------------------------ */
/* Player-mode key synthesis                                           */
/* ------------------------------------------------------------------ */

const SYNTHETIC_KEY_CODES = Object.freeze({
  ' ': 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  f: 70, Escape: 27,
});

function sendKey(key) {
  const keyCode = SYNTHETIC_KEY_CODES[key] ?? 0;
  const target = document.activeElement || document.body;
  const init = {
    key,
    code: key === ' ' ? 'Space' : key,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true,
  };
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
}

/* ------------------------------------------------------------------ */
/* Player media helpers                                                */
/* ------------------------------------------------------------------ */

/*
 * Netflix drives its EME-protected <video> through its own player;
 * synthetic keys are the first choice. If nothing reacts (odd focus,
 * overlay state), fall back to driving the element directly.
 */
function playerVideo() {
  return document.querySelector('video');
}

function dispatchFeedback(text) {
  window.dispatchEvent(new CustomEvent('deckflix-feedback', { detail: { text } }));
}

function pulseAt(rect) {
  window.dispatchEvent(new CustomEvent('deckflix-pulse', { detail: { rect } }));
}

function seekFeedback(seconds) {
  dispatchFeedback(seconds > 0 ? '⏩ 10 s' : '⏪ 10 s');
}

/*
 * Toggle/direct playback state. `desired` is 'toggle' | 'play' | 'pause'.
 * Sends the play/pause key Netflix listens for, verifies against the
 * <video> element, and falls back to element control when it didn't move.
 */
function applyPlayback(desired) {
  const v = playerVideo();
  if (!v) {
    if (desired !== 'pause') sendKey(' ');
    return;
  }
  const targetPaused =
    desired === 'play' ? false : desired === 'pause' ? true : !v.paused;
  sendKey(' '); // play/pause
  setTimeout(() => {
    if (!v.isConnected) return;
    if (v.paused !== targetPaused) {
      // Netflix didn't bring the element to the target state: drive it directly.
      const result = targetPaused ? v.pause() : v.play();
      Promise.resolve(result).catch(() => {});
    }
    dispatchFeedback(targetPaused ? '⏸ Pause' : '▶ Play');
  }, PLAYER_KEY_VERIFY_MS);
}

function changeVolume(delta) {
  const v = playerVideo();
  if (!v || !Number.isFinite(v.volume)) {
    dispatchFeedback('Volume unavailable');
    return;
  }
  // Round to steps of 0.1 and clamp; report the value the element took.
  const next = Math.min(1, Math.max(0, Math.round((v.volume + delta * 0.1) * 10) / 10));
  v.volume = next;
  const pct = Math.round(v.volume * 100);
  dispatchFeedback(
    pct === 0 ? 'Volume 0% (muted)' : `Volume ${pct}%${pct === 100 ? ' (max)' : ''}`,
  );
}

function setVolumeAbsolute(volume) {
  const v = playerVideo();
  const clamped = Math.min(1, Math.max(0, Number(volume)));
  if (!v || !Number.isFinite(clamped)) return;
  v.volume = clamped;
  dispatchFeedback(`Volume ${Math.round(clamped * 100)}%`);
}

/*
 * Playback state for the main process / MPRIS bridge. Microseconds per
 * the MPRIS spec; absent media reports zero-length "browse" status.
 */
function collectStatus() {
  const player = inPlayerMode();
  const v = playerVideo();
  const secToUs = (s) =>
    player && v && Number.isFinite(s) ? Math.round(s * 1e6) : 0;
  return {
    mode: player ? 'player' : 'browse',
    playing: player && v ? !v.paused : false,
    volume: v ? v.volume : null,
    positionUs: secToUs(v && v.currentTime),
    durationUs: secToUs(v && v.duration),
    title: document.title,
    url: location.href,
    testMode: !!(window.__deckflixOptions && window.__deckflixOptions.testMode),
  };
}

/* MPRIS commands arriving from the main process (media keys, desktop widgets). */
window.addEventListener('deckflix-mpris', (event) => {
  try {
    if (!inPlayerMode()) return; // media keys are playback-only controls
    const { command, arg } = event.detail;
    switch (command) {
      case 'playpause':
        applyPlayback('toggle');
        break;
      case 'play':
        applyPlayback('play');
        break;
      case 'pause':
        applyPlayback('pause');
        break;
      case 'stop':
        goBack();
        break;
      case 'seek': // relative µs → our fixed 10 s steps
        sendKey(arg > 0 ? 'ArrowRight' : 'ArrowLeft');
        seekFeedback(arg > 0 ? 10 : -10);
        break;
      case 'volume':
        changeVolume(arg);
        break;
      case 'volume-absolute':
        setVolumeAbsolute(arg);
        break;
      default:
        break;
    }
  } catch (err) {
    console.warn('[deckflix] mpris command error:', err);
  }
});

const SKIP_BUTTON_SELECTOR =
  '.watch-video--skip-content-button, [data-uia="skip-intro"], [data-uia="skip-credits"], .skip-credits button';

/* ------------------------------------------------------------------ */
/* Input routing                                                       */
/* ------------------------------------------------------------------ */

function isTypingTarget() {
  const el = document.activeElement;
  return !!el && (/^(input|textarea|select)$/i.test(el.tagName) || el.isContentEditable);
}

function handleBrowseInput(event) {
  if (isTypingTarget()) return;

  switch (event.detail.action) {
    case 'nav':
      moveFocus(event.detail.arg);
      break;
    case 'activate':
      activate();
      break;
    case 'back':
      goBack();
      break;
    case 'home': // remote Home button: straight to Netflix home
      location.assign('/');
      break;
    case 'scroll': // right-stick omni scroll (px per frame from input.js)
      window.scrollBy({ left: event.detail.arg.x, top: event.detail.arg.y });
      break;
    default:
      break; // seek / fullscreen / volume / menu are browse no-ops here
  }
}

function handlePlayerInput(event) {
  switch (event.detail.action) {
    case 'nav':
      // Spatial navigation over the visible player controls (skip
      // intro/credits, play/pause, next-episode, …). Netflix shows its
      // control bar on mouse activity and setFocused keeps hover alive
      // in the player even when browse hover-previews are off.
      moveFocus(event.detail.arg);
      break;
    case 'activate': {
      // Mirror browse: with live focus, SELECT the focused player control
      // (skip-intro/credits, next episode, pause button, …); only activate
      // play/pause when nothing is focused (the empty-video default).
      const skip = focusedElement && focusedElement.isConnected &&
        focusedElement.matches(SKIP_BUTTON_SELECTOR) ? focusedElement : null;
      if (skip) {
        pulseAt(elementRect(skip));
        skip.click();
        setFocused(null); // skip is transient: give the focus back up
        break;
      }
      const live = focusedElement && focusedElement.isConnected &&
        !isOccluded(focusedElement, elementRect(focusedElement));
      if (live) {
        activateElement(focusedElement);
      } else {
        applyPlayback('toggle'); // play/pause with direct-element fallback
      }
      break;
    }
    case 'back':
      goBack();
      break;
    case 'home': // remote Home from the player: back to browse
      goBack();
      break;
    case 'fullscreen':
      sendKey('f');
      break;
    case 'seek': // bumpers: ±10 s via Netflix's arrow-key shortcuts
      sendKey(event.detail.arg > 0 ? 'ArrowRight' : 'ArrowLeft');
      seekFeedback(event.detail.arg);
      break;
    case 'volume': // triggers: ±10% on the EME video element
      changeVolume(event.detail.arg);
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Player control-bar lifecycle                                        */
/* ------------------------------------------------------------------ */

/*
 * Netflix auto-hides the player control bar after ~3 s without mouse
 * activity. Two consequences for spatial navigation:
 *   1. focus that pointed at bar controls must be dropped when the bar
 *      hides, or the ring floats over nothing and the next press has
 *      no visible target;
 *   2. that hide must UNDO itself when the user starts steering, or
 *      navigation dies with the bar. We don't rely on injecting trusted
 *      input for this (see note in wakePlayerControls): instead we inline-
 *      override the hiding styles (opacity/visibility) on the focused
 *      control's ancestors — no site class names involved — pinning the
 *      bar visible for a grace window that extends while navigating and
 *      releases a few seconds after the last input (their autohide
 *      resumes).
 * Hidden here means effectively invisible: display:none, visibility,
 * opacity 0 anywhere up the ancestor chain (bounded walk).
 */
let lastWakePoint = null;
let wakeJitter = 0;
const playerBarOverrides = []; // { el, opacity, visibility } to restore
let playerBarReleaseTimer = null;
let playerLastControl = null;  // anchor for re-entry after focus loss
let playerAncestorTrail = [];  // ancestor chain of the last live control
const PLAYER_BAR_GRACE_MS = 4500;
const PLAYER_TRAIL_DEPTH = 24;

function rememberPlayerControl(el) {
  if (!el || el.nodeType !== 1) return;
  playerLastControl = el;
  // Persist the ancestor chain: on real sites the hide can sit deep in
  // the tree (or the control itself can be re-rendered away), so the
  // trail — not the element — is what survives until the next input.
  const trail = [];
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && depth < PLAYER_TRAIL_DEPTH; depth++, node = node.parentElement) {
    trail.push(node);
  }
  playerAncestorTrail = trail;
}

function effectivelyHidden(el) {
  const style = getComputedStyle(el);
  return (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0'
  );
}

function playerFocusStale() {
  if (!focusedElement || !focusedElement.isConnected) return false;
  if (effectivelyHidden(focusedElement)) return true;
  // Bars hidden by sliding them away leave zero-size rects behind.
  const r = focusedElement.getBoundingClientRect();
  return r.width <= 0 || r.height <= 0;
}

function playerBarTrailDebug() {
  if (!playerAncestorTrail.length) return 'no anchor';
  const hiding = playerAncestorTrail.filter(
    (el) => el.isConnected &&
      (getComputedStyle(el).opacity === '0' || getComputedStyle(el).visibility === 'hidden'),
  );
  if (!hiding.length) return 'visible';
  const el = hiding[0];
  const cls = String(el.className || '').split(' ')[0];
  return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
}

function releasePlayerBar() {
  clearTimeout(playerBarReleaseTimer);
  playerBarReleaseTimer = null;
  while (playerBarOverrides.length) {
    const rec = playerBarOverrides.pop();
    try {
      rec.el.style.opacity = rec.opacity;
      rec.el.style.visibility = rec.visibility;
    } catch { /* element gone */ }
  }
}

/*
 * Un-hide the player bar through the persisted ancestor trail: inline-
 * override every hiding ancestor (no site class names involved). Works
 * even after the focused control itself was re-rendered away. Returns
 * true when something was overridden.
 */
function forceBarVisible() {
  const scan = [];
  let forced = false;
  for (const el of playerAncestorTrail) {
    if (!el.isConnected) continue;
    const cs = getComputedStyle(el);
    scan.push(`${el.tagName.toLowerCase()}:${cs.opacity}/${cs.visibility}${el.style.opacity ? ' (inline:' + el.style.opacity + ')' : ''}`);
    if (cs.opacity === '0' || cs.visibility === 'hidden') {
      playerBarOverrides.push({
        el,
        opacity: el.style.opacity,
        visibility: el.style.visibility,
      });
      el.style.opacity = '1';
      el.style.visibility = 'visible';
      forced = true;
    }
  }
  if (typeof window !== 'undefined' && window.__deckflixDispatch) {
    window.__deckflixDispatch.lastForceScan = `count=${playerAncestorTrail.length} | ${scan.join(' | ')}`;
  }
  if (forced) schedulePlayerBarRelease();
  return forced;
}

function schedulePlayerBarRelease() {
  clearTimeout(playerBarReleaseTimer);
  if (!playerBarOverrides.length) return;
  playerBarReleaseTimer = setTimeout(releasePlayerBar, PLAYER_BAR_GRACE_MS);
}

function wakePlayerControls() {
  if (!inPlayerMode()) return;
  let rect = elementRect(playerVideo() || document.body);
  if (rect.width <= 0 || rect.height <= 0) rect = elementRect(document.body);
  if (rect.width <= 0 || rect.height <= 0) return;
  // Fixed neutral anchor at the video's center with ±1 px alternating
  // jitter: movement checks (movementX/Y) still see real deltas, but the
  // real pointer can NEVER drift onto hover-sensitive UI (scrubber
  // tooltips, hover panels) and starve the candidate pool like the old
  // traveling wake did.
  if (!lastWakePoint || !Number.isFinite(lastWakePoint.x)) {
    lastWakePoint = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    wakeJitter = 0;
  }
  wakeJitter = 1 - wakeJitter;
  const x = lastWakePoint.x + wakeJitter;
  const { y } = lastWakePoint;
  // Two-layer wake:
  //   1. trusted mouse nudge via the main process (sendInputEvent) — this
  //      is what Netflix's real-mouse idle timer respects; main gates
  //      injection around fullscreen transitions (see lib/wake.js), which
  //      is where injected events were seen to freeze trusted input;
  //   2. DOM-synthetic fallback for harness / no-bridge contexts.
  window.__deckflixBridge?.wakePlayer?.(x, y);
  (playerVideo() || document.body).dispatchEvent(new MouseEvent('mousemove', {
    clientX: x, clientY: y, bubbles: true,
  }));
}

/* Overlay input contract: lib/guide.js and lib/menu.js register consumer
 * functions on the shared registry; the first one that returns true has
 * handled the action and the page never sees it. The menu hosts real
 * buttons, so while it is open everything else routes exactly like the
 * browse page (spatial focus among menu items) — including in player.
 */
function playerInputSuppressed() {
  return !!(window.__deckflix && window.__deckflix.isMenuOpen && window.__deckflix.isMenuOpen());
}

window.addEventListener('deckflix-input', (event) => {
  try {
    const consumers = (window.__deckflix && window.__deckflix.inputConsumers) || [];
    for (const consume of consumers) {
      if (consume(event.detail.action)) return;
    }
    if (inPlayerMode() && !playerInputSuppressed()) {
      window.__deckflixDispatch.playerBranch++;
      // Build/refresh the trail when focus is live. When focus was lost to
      // a BAR hide (its control is still there but hidden), re-anchor onto
      // it so the force-show + navigation have a target; all other null
      // cases (e.g. skip activation) re-take via moveFocus → initialFocus.
      if (focusedElement && focusedElement.isConnected) {
        rememberPlayerControl(focusedElement);
      } else if (playerLastControl?.isConnected && effectivelyHidden(playerLastControl)) {
        setFocused(playerLastControl);
        rememberPlayerControl(playerLastControl);
      }
      forceBarVisible();
      wakePlayerControls();
      schedulePlayerBarRelease(); // grace extends with every input
      handlePlayerInput(event);
    } else {
      handleBrowseInput(event);
    }
  } catch (err) {
    console.warn('[deckflix] input handler error:', err);
  }
});

/* ------------------------------------------------------------------ */
/* Ring rendering loop + route watching                                */
/* ------------------------------------------------------------------ */

function renderRing() {
  if (ringElement) {
    const el = focusedElement;
    if (el && el.isConnected) {
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      if (visible) {
        ringElement.style.opacity = '1';
        ringElement.style.transform =
          `translate3d(${rect.left - 6}px, ${rect.top - 6}px, 0)`;
        ringElement.style.width = `${rect.width}px`;
        ringElement.style.height = `${rect.height}px`;
      } else {
        ringElement.style.opacity = '0';
      }
    } else {
      ringElement.style.opacity = '0';
    }
  }
  requestAnimationFrame(renderRing);
}

function onRouteChange() {
  releasePlayerBar(); // never carry bar overrides across routes
  playerAncestorTrail = [];
  setFocused(null);
  lastWakePoint = null; // wake coordinates are per-player-screen
  if (inPlayerMode()) return; // player manages everything visually itself

  // SPA content paints over several frames; retry until candidates exist.
  let attempt = 0;
  const tryFocus = () => {
    if (focusedElement && focusedElement.isConnected) return;
    if (initialFocus() || ++attempt >= FOCUS_RETRY_COUNT) return;
    setTimeout(tryFocus, FOCUS_RETRY_MS);
  };
  setTimeout(tryFocus, FOCUS_RETRY_MS);
}

/*
 * Popup open/close recovery: modals and menus without route changes
 * leave our focus in the buried layer. Whenever DOM churn happens and
 * the current focus turns out to be covered (modal opened) or gone
 * (modal closed), re-take focus on the now-visible layer.
 */
let recoveryTimer = null;
function scheduleFocusRecovery() {
  if (recoveryTimer) return;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    if (inPlayerMode()) return;
    if (
      focusedElement &&
      focusedElement.isConnected &&
      !isOccluded(focusedElement, elementRect(focusedElement))
    ) {
      return;
    }
    initialFocus();
  }, OVERLAY_RECOVERY_DEBOUNCE_MS);
}

setInterval(() => {
  if (location.href !== currentHref) {
    currentHref = location.href;
    onRouteChange();
  }
}, ROUTE_POLL_MS);

// Playback-status reporting for the MPRIS bridge (preload forwards to main).
setInterval(() => {
  // If the player bar hid itself while a bar control still held focus,
  // drop it — but not while our force-show pin is active (that means the
  // user is mid-grace and the bar is intentionally visible).
  if (playerFocusStale() && !playerBarOverrides.length) setFocused(null);
  const bridge = window.__deckflixBridge;
  if (bridge && typeof bridge.sendStatus === 'function') {
    try {
      bridge.sendStatus(collectStatus());
    } catch (err) {
      console.warn('[deckflix] status send error:', err);
    }
  }
}, STATUS_POLL_MS);

function boot() {
  ensurePageChrome();
  ensureRing();
  renderRing();
  onRouteChange();
  new MutationObserver(scheduleFocusRecovery).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'], // display:none close
  });
}

if (document.body) {
  boot();
} else {
  document.addEventListener('DOMContentLoaded', () => boot(), { once: true });
}

// Debug hook for tests / console spelunking; shared feature registry that
// other lib modules extend with their own facilities.
window.__deckflix = Object.assign({}, window.__deckflix, {
  focused: () => focusedElement,
  sendFeedback: dispatchFeedback,
  playerStatus: collectStatus,
  applyPlayback,
  changeVolume,
  retakeFocus,
  isTypingTarget, // overlays and the remote front-end share the typing guard
  barTrailDebug: playerBarTrailDebug, // stats-modal diagnostics for the bar hider
  wakeAnchor: () => lastWakePoint, // diagnostic: injected-pointer position
});

// Dispatch counters for live debugging (read from the harness/console).
window.__deckflixDispatch = {
  playerBranch: 0,
  staleHits: 0,
  forcedHits: 0,
  dropHits: 0,
  lastError: null,
};