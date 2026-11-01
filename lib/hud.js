'use strict';

/*
 * On-screen feedback HUD.
 *
 * Listens for two page-level events and renders TV-appropriate feedback:
 *   deckflix-feedback  detail.text   → bottom-centre toast (seek, volume,
 *                                      play/pause confirmation)
 *   deckflix-pulse     detail.rect   → ripple over the clicked element so
 *                                      gamepad activation reads visually
 *
 * Pure DOM/CSS, no focus interaction, safe on every page including the
 * player. Auto-fades; never takes focus or intercepts input.
 */

const TOAST_ID = 'deckflix-hud-toast';
const HUD_STYLE_ID = 'deckflix-hud-style';
const TOAST_VISIBLE_MS = 1600;

const HUD_CSS = `
  #${TOAST_ID} {
    position: fixed;
    left: 50%;
    bottom: 36px;
    transform: translateX(-50%) translateY(10px);
    padding: 10px 22px;
    border-radius: 24px;
    background: rgba(20, 20, 20, 0.88);
    border: 1px solid rgba(255, 255, 255, 0.18);
    color: #fff;
    font: 500 15px/1.4 sans-serif;
    letter-spacing: 0.02em;
    pointer-events: none;
    z-index: 2147483647;
    opacity: 0;
    transition: opacity 140ms ease-out, transform 140ms ease-out;
  }
  #${TOAST_ID}.deckflix-hud-visible {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
  .deckflix-pulse {
    position: fixed;
    border-radius: 12px;
    border: 2px solid rgba(255, 255, 255, 0.85);
    box-shadow: 0 0 18px rgba(229, 9, 20, 0.7);
    box-sizing: border-box;
    pointer-events: none;
    z-index: 2147483647;
    animation: deckflixPulse 360ms ease-out forwards;
  }
  @keyframes deckflixPulse {
    0%   { opacity: 0.9; transform: scale(0.72); }
    100% { opacity: 0;   transform: scale(1.35); }
  }
`;

let toastTimer = null;

function ensureHudStyles() {
  if (!document.getElementById(HUD_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = HUD_STYLE_ID;
    style.textContent = HUD_CSS;
    document.head.appendChild(style);
  }
}

function showToast(text) {
  ensureHudStyles();
  let toast = document.getElementById(TOAST_ID);
  if (!toast || !toast.isConnected) {
    toast = document.createElement('div');
    toast.id = TOAST_ID;
    window.__deckflix?.trackTopLayer?.(toast); // fullscreen-safe
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add('deckflix-hud-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('deckflix-hud-visible');
  }, TOAST_VISIBLE_MS);
}

function showPulse(rect) {
  ensureHudStyles();
  const el = document.createElement('div');
  el.className = 'deckflix-pulse';
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.top}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  window.__deckflix?.attachTopLayer?.(el); // fullscreen-safe
  el.addEventListener('animationend', () => el.remove());
  setTimeout(() => el.remove(), 600); // safety if animation events are missed
}

window.addEventListener('deckflix-feedback', (event) => {
  try {
    const text = event.detail && event.detail.text;
    if (text) showToast(String(text));
  } catch (err) {
    console.warn('[deckflix] hud feedback error:', err);
  }
});

window.addEventListener('deckflix-pulse', (event) => {
  try {
    const rect = event.detail && event.detail.rect;
    if (rect) showPulse(rect);
  } catch (err) {
    console.warn('[deckflix] hud pulse error:', err);
  }
});