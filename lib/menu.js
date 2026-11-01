'use strict';

/*
 * DeckFlix overlay menu — the controller-accessible counterpart of the
 * old extension popup.
 *
 * Opens from gamepad Back-hold or Start. All items are real <button>s,
 * so the spatial navigator and occlusion filter manage focus inside it
 * with no special casing; only 'back'/'menu' presses are consumed here
 * (close the menu instead of going back in history). 'menu' is also the
 * Start-button route to Home on console UIs, so going home lives here.
 *
 * Settings persist in localStorage under 'deckflix:settings'.
 */

const MENU_ID = 'deckflix-menu';
const MENU_STYLE_ID = 'deckflix-menu-style';
const SETTINGS_KEY = 'deckflix:settings';

const MENU_CSS = `
  #${MENU_ID} {
    position: fixed;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.72);
    z-index: 2147483646; /* one under the guide overlay so the guide can stack */
  }
  #${MENU_ID}.deckflix-menu-open { display: flex; }
  #${MENU_ID} .deckflix-menu-panel {
    min-width: 380px;
    padding: 30px 38px;
    border-radius: 14px;
    background: rgba(24, 24, 26, 0.97);
    border: 1px solid rgba(255, 255, 255, 0.16);
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.65);
  }
  #${MENU_ID} h2 {
    margin: 0 0 16px;
    color: #fff;
    font: 600 20px/1.3 sans-serif;
    letter-spacing: 0.01em;
  }
  #${MENU_ID} h2 span { color: #e50914; }
  #${MENU_ID} .deckflix-menu-item {
    display: block;
    width: 100%;
    margin: 2px 0;
    padding: 11px 16px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: rgba(255, 255, 255, 0.82);
    font: 500 15px/1.4 sans-serif;
    text-align: left;
    cursor: pointer;
  }
  #${MENU_ID} .deckflix-menu-item:hover { background: rgba(255, 255, 255, 0.08); }
  #${MENU_ID} .deckflix-menu-sep {
    height: 1px;
    margin: 12px 0;
    background: rgba(255, 255, 255, 0.12);
  }
  #${MENU_ID} .deckflix-menu-zoom {
    display: flex;
    align-items: stretch;
    gap: 8px;
    margin: 2px 0;
  }
  #${MENU_ID} .deckflix-menu-zoom .deckflix-menu-item {
    width: 48px;
    min-width: 48px;
    margin: 0;
    padding: 10px 0;
    font-size: 18px;
    text-align: center;
  }
  /* Inert value readout: navigable (role=button → spatial candidate)
     but deliberately not interactive; step left/right for −/+ */
  #${MENU_ID} .deckflix-menu-zoom-label {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.55);
    font: 500 15px/1.4 sans-serif;
    user-select: none;
    cursor: default;
  }
  #${MENU_ID} .deckflix-menu-danger { color: #eb3942; }
  #${MENU_ID} .deckflix-menu-hint {
    margin: 14px 0 0;
    color: rgba(255, 255, 255, 0.45);
    font: 12.5px/1.4 sans-serif;
  }
`;

/* ------------------------------------------------------------------ */
/* Settings (localStorage-backed)                                      */
/* ------------------------------------------------------------------ */

/* Hover previews default OFF: synthetic hover keeps triggering Netflix's
 * auto-preview popup while walking rows, which reads as visual noise on a
 * TV. Mouse-out on focus-leave always fires, so stale previews still get
 * cancelled; turn them back on from the menu if you want them. */
const DEFAULT_SETTINGS = Object.freeze({ showPreviews: false, zoomFactor: 1 });

const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;

function clampZoom(f) {
  // Snap to whole steps to kill float drift, then clamp.
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(f * 10) / 10));
}

function loadSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn('[deckflix] settings save failed:', err);
  }
}

let settings = loadSettings();

function showPreviews() {
  return !!settings.showPreviews;
}

function setShowPreviews(on) {
  settings = { ...settings, showPreviews: !!on };
  saveSettings(settings);
  const label = document.getElementById('deckflix-menu-previews');
  if (label) {
    label.textContent = previewLabel();
  }
  window.dispatchEvent(new CustomEvent('deckflix-feedback', {
    detail: { text: on ? 'Hover previews on' : 'Hover previews off' },
  }));
}

function previewLabel() {
  return `Hover Previews (experimental): ${showPreviews() ? 'On' : 'Off'}`;
}

/* ------------------------------------------------------------------ */
/* Zoom (webContents zoom factor, applied via the IPC bridge)          */
/* ------------------------------------------------------------------ */

function zoomFactor() {
  return clampZoom(Number(settings.zoomFactor) || 1);
}

function setZoomFactor(factor) {
  const next = clampZoom(factor);
  settings = { ...settings, zoomFactor: next };
  saveSettings(settings);
  applyZoom(next);
  window.dispatchEvent(new CustomEvent('deckflix-feedback', {
    detail: { text: `Zoom ${Math.round(next * 100)}%` },
  }));
  updateZoomLabel();
}

function zoomLabel() {
  return `Zoom ${Math.round(zoomFactor() * 100)}%`;
}

function updateZoomLabel() {
  const label = document.getElementById('deckflix-menu-zoom-label');
  if (label) label.textContent = zoomLabel();
}

function applyZoom(factor) {
  window.__deckflixBridge?.appAction?.('zoom', factor);
}

// Restore the saved zoom on boot (bridge exists once preload finishes).
requestAnimationFrame(() => {
  const factor = zoomFactor();
  if (factor !== 1) applyZoom(factor);
});

/* ------------------------------------------------------------------ */
/* Menu actions                                                        */
/* ------------------------------------------------------------------ */

function menuAction(action) {
  const go = (fn) => {
    closeMenu(); // SPA navigations happen under the menu; close first
    fn();
  };
  switch (action) {
    case 'home':
      go(() => location.assign('/'));
      break;
    case 'reload':
      go(() => location.reload());
      break;
    case 'fullscreen':
      window.__deckflixBridge?.appAction?.('fullscreen');
      go(() => {}); // close so the change is visible
      break;
    case 'guide':
      go(() => window.dispatchEvent(new CustomEvent('deckflix-input', {
        detail: { action: 'guide', arg: null },
      })));
      break;
    case 'previews':
      setShowPreviews(!showPreviews()); // stays open so the label is visible
      break;
    case 'zoom-in':
      setZoomFactor(zoomFactor() + ZOOM_STEP); // stays open to see the toast
      break;
    case 'zoom-out':
      setZoomFactor(zoomFactor() - ZOOM_STEP);
      break;
    case 'zoom-reset':
      setZoomFactor(1);
      break;
    case 'stats':
      go(() => window.dispatchEvent(new CustomEvent('deckflix-input', {
        detail: { action: 'stats', arg: null },
      })));
      break;
    case 'quit':
      window.__deckflixBridge?.appAction?.('quit');
      closeMenu();
      break;
    case 'close':
      closeMenu();
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

let menuElement = null;
let isOpen = false;

function ensureStyles() {
  if (!document.getElementById(MENU_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = MENU_STYLE_ID;
    style.textContent = MENU_CSS;
    document.head.appendChild(style);
  }
}

function buildMenu() {
  const panel = document.createElement('div');
  panel.className = 'deckflix-menu-panel';
  panel.innerHTML = `
    <h2>Deck<span>Flix</span> Menu</h2>
    <button class="deckflix-menu-item" id="deckflix-menu-home">Go to Home</button>
    <button class="deckflix-menu-item" id="deckflix-menu-reload">Reload Netflix</button>
    <button class="deckflix-menu-item" id="deckflix-menu-fullscreen">Toggle Window Fullscreen</button>
    <button class="deckflix-menu-item" id="deckflix-menu-guide">Control Guide</button>
    <button class="deckflix-menu-item" id="deckflix-menu-previews">${previewLabel()}</button>
    <div class="deckflix-menu-zoom">
      <button class="deckflix-menu-item" id="deckflix-menu-zoom-out" aria-label="Zoom out">−</button>
      <span class="deckflix-menu-zoom-label" id="deckflix-menu-zoom-label" role="button">${zoomLabel()}</span>
      <button class="deckflix-menu-item" id="deckflix-menu-zoom-in" aria-label="Zoom in">+</button>
    </div>
    <button class="deckflix-menu-item" id="deckflix-menu-zoom-reset">Reset Zoom (100%)</button>
    <button class="deckflix-menu-item" id="deckflix-menu-stats">Player Stats</button>
    <button class="deckflix-menu-item" id="deckflix-menu-close">Close</button>
    <div class="deckflix-menu-sep"></div>
    <button class="deckflix-menu-item deckflix-menu-danger" id="deckflix-menu-quit">Quit DeckFlix</button>
    <p class="deckflix-menu-hint">B — close · B (hold) or Start — open this menu</p>
  `;
  for (const el of panel.querySelectorAll('.deckflix-menu-item')) {
    el.addEventListener('click', () => menuAction(el.dataset.menuAction));
    el.dataset.menuAction = el.id.replace('deckflix-menu-', '');
  }
  // The zoom readout is inert for zoom control: activation is a hint only.
  panel.querySelector('.deckflix-menu-zoom-label')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('deckflix-feedback', {
      detail: { text: 'Use − / + to change zoom' },
    }));
  });
  return panel;
}

function openMenu() {
  ensureStyles();
  if (!menuElement || !menuElement.isConnected) {
    menuElement = document.createElement('div');
    menuElement.id = MENU_ID;
    menuElement.appendChild(buildMenu());
    document.body.appendChild(menuElement);
  }
  document.getElementById('deckflix-menu-previews').textContent = previewLabel();
  updateZoomLabel(); // keep the readout in sync with the tracked factor
  window.__deckflix?.trackTopLayer?.(menuElement); // fullscreen-safe
  window.__deckflix?.attachTopLayer?.(menuElement);
  menuElement.classList.add('deckflix-menu-open');
  isOpen = true;
  // Take focus into the menu right away instead of waiting for the next
  // directional press to notice the buried focus.
  window.__deckflix?.retakeFocus?.();
}

function closeMenu() {
  if (menuElement) menuElement.classList.remove('deckflix-menu-open');
  isOpen = false;
}

function toggleMenu() {
  if (isOpen) closeMenu();
  else openMenu();
}

function isMenuOpen() {
  return isOpen;
}

/*
 * Consumer contract with lib/spatial.js: return true when this action was
 * handled and must not be routed to the page. While open, 'back'/'menu'
 * close the menu; all other input flows to spatial navigation (which
 * moves focus among the menu's real buttons).
 */
function consumeInput(action) {
  if (isOpen) {
    if (action === 'back' || action === 'menu' || action === 'home') {
      closeMenu();
      return true;
    }
    return false;
  }
  if (action === 'menu') {
    openMenu();
    return true;
  }
  return false;
}

// Escape also closes (physical keyboard convenience).
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isOpen) closeMenu();
});

// Register into the shared feature registry.
window.__deckflix = Object.assign({}, window.__deckflix, {
  isMenuOpen,
  showPreviews,
  setShowPreviews,
  zoomFactor, // stats modal reads the applied UI zoom through the registry
  inputConsumers: [
    ...((window.__deckflix && window.__deckflix.inputConsumers) || []),
    consumeInput,
  ],
});