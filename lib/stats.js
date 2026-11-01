'use strict';

/*
 * Player-stats overlay modal (DeckFlix menu → Player Stats).
 *
 * Reports what the video pipeline is actually doing: playback state,
 * position/duration, volume, stream resolution, on-screen display size,
 * color space (primaries / transfer / matrix / range), frame statistics
 * (total + dropped), the applied UI zoom, Widevine availability and the
 * page title. Values refresh every second while open; Refresh/Close are
 * real buttons so spatial navigation manages focus inside the modal.
 * Re-parents into the fullscreen top layer alongside the other overlays.
 */

const STATS_ID = 'deckflix-stats';
const STATS_STYLE_ID = 'deckflix-stats-style';
const REFRESH_MS = 1000;

const STATS_CSS = `
  #${STATS_ID} {
    position: fixed;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.72);
    z-index: 2147483645; /* under the menu so the menu can stack above */
  }
  #${STATS_ID}.deckflix-stats-open { display: flex; }
  #${STATS_ID} .deckflix-stats-panel {
    min-width: 420px;
    padding: 26px 36px;
    border-radius: 14px;
    background: rgba(24, 24, 26, 0.97);
    border: 1px solid rgba(255, 255, 255, 0.16);
    color: #fff;
    font: 14px/1.5 sans-serif;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.65);
  }
  #${STATS_ID} h2 { margin: 0 0 14px; font: 600 20px/1.3 sans-serif; }
  #${STATS_ID} h2 span { color: #e50914; }
  #${STATS_ID} td { padding: 3px 18px 3px 0; vertical-align: baseline; }
  #${STATS_ID} td:first-child {
    color: rgba(255, 255, 255, 0.5);
    white-space: nowrap;
    font-size: 12.5px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  #${STATS_ID} .deckflix-stats-actions { margin-top: 16px; display: flex; gap: 10px; }
  #${STATS_ID} .deckflix-stats-item {
    flex: 0 0 auto;
    padding: 9px 18px;
    border: none;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
    font: 500 14px/1.4 sans-serif;
    cursor: pointer;
  }
  #${STATS_ID} .deckflix-stats-item:hover { background: rgba(255, 255, 255, 0.14); }
`;

let statsElement = null;
let valueCells = new Map(); // row label → value td
let refreshTimer = null;
let isOpen = false;

/* ------------------------------------------------------------------ */
/* Reading the media pipeline                                          */
/* ------------------------------------------------------------------ */

function activeVideo() {
  return document.querySelector('video');
}

function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function colorSpace(v) {
  if (!v) return '—';
  const cs = v.colorSpace; // VideoColorSpace (Chromium)
  if (!cs) return 'unavailable';
  const parts = [
    cs.primaries,
    cs.transfer,
    cs.matrix,
    cs.fullRange === true ? 'full-range' : cs.fullRange === false ? 'limited' : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'unavailable';
}

function frameStats(v) {
  const q = v && typeof v.getVideoPlaybackQuality === 'function' && v.getVideoPlaybackQuality();
  return q
    ? `${q.totalVideoFrames} total · ${q.droppedVideoFrames} dropped`
    : '—';
}

// FPS from sampled playback-quality counters (delta over the refresh
// interval). Reset per video element; 'measuring…' on the first tick.
let frameSample = null;

function frameRateRow(v) {
  const q = v && typeof v.getVideoPlaybackQuality === 'function' && v.getVideoPlaybackQuality();
  if (!q) return 'unavailable';
  const now = performance.now();
  if (!frameSample || frameSample.video !== v) {
    frameSample = { total: q.totalVideoFrames, dropped: q.droppedVideoFrames, at: now, video: v };
    return 'measuring…';
  }
  const dt = (now - frameSample.at) / 1000;
  const fps = dt > 0 ? (q.totalVideoFrames - frameSample.total) / dt : 0;
  const dropsPerSec = dt > 0 ? (q.droppedVideoFrames - frameSample.dropped) / dt : 0;
  frameSample = { total: q.totalVideoFrames, dropped: q.droppedVideoFrames, at: now, video: v };
  return `${fps.toFixed(1)} fps · ${dropsPerSec.toFixed(1)} drops/s${v.paused ? ' (paused)' : ''}`;
}

function widevineLabel() {
  const flag = window.__deckflixWidevine; // set by preload diagnostics
  return flag === true ? 'available' : flag === false ? 'NOT available' : 'unknown';
}

// Media pipeline digest from the main process (CDP Media domain); may be
// empty until pipeline events arrive.
let lastMediaInfo = null;
let mediaInfoInFlight = false;

function refreshMediaInfo() {
  const bridge = window.__deckflixBridge;
  if (mediaInfoInFlight || typeof bridge?.mediaInfo !== 'function') return;
  mediaInfoInFlight = true;
  bridge.mediaInfo()
    .then((info) => {
      lastMediaInfo = info || {};
      update();
    })
    .catch(() => {})
    .finally(() => {
      mediaInfoInFlight = false;
    });
}

function codecLabel(codec, decoder) {
  if (!codec && !decoder) return '—';
  return [codec, decoder].filter(Boolean).join(' · ');
}

function rows() {
  const v = activeVideo();
  const playing = v && !v.paused;
  const zoom = (window.__deckflix && window.__deckflix.zoomFactor ? window.__deckflix.zoomFactor() : 1);
  return [
    ['Playback',
      (window.__deckflix && window.__deckflix.playerStatus ? window.__deckflix.playerStatus() : {}).mode === 'player'
        ? (playing ? 'Playing · DRM stream' : 'Paused')
        : 'Browse (no playback)'],
    ['Position', `${fmtTime(v && v.currentTime)} / ${fmtTime(v && v.duration)}`],
    ['Volume', v ? `${Math.round(v.volume * 100)}%` : '—'],
    ['Resolution', v ? `${v.videoWidth} × ${v.videoHeight}` : '—'],
    ['Display size', v ? `${Math.round(v.clientWidth)} × ${Math.round(v.clientHeight)}` : '—'],
    ['Color space', colorSpace(v)],
    ['Frames', frameStats(v)],
    ['Frame rate', frameRateRow(v)],
    ['UI zoom', `${Math.round(zoom * 100)}%`],
    ['Widevine', widevineLabel()],
    ['Fullscreen', fullscreenLabel()],
    ['Bar hider', typeof (window.__deckflix && window.__deckflix.barTrailDebug) === 'function'
      ? window.__deckflix.barTrailDebug() : 'unknown'],
    ['Gamepads', gamepadsLabel()],
    ['Video', codecLabel(lastMediaInfo?.videoCodec, lastMediaInfo?.videoDecoder)],
    ['Audio', codecLabel(lastMediaInfo?.audioCodec, lastMediaInfo?.audioDecoder)],
    ['Page', document.title || '—'],
  ];
}

// Gamepad visibility readout — inside a flatpak without /run/udev these
// stay invisible until a button press exposes them.
function gamepadsLabel() {
  const pads = (navigator.getGamepads ? navigator.getGamepads() : [])
    .filter(Boolean);
  if (!pads.length) return 'none';
  return pads.map((p) => p.id.split(/\s+\(/)[0]).slice(0, 3).join(' + ');
}

// Shape of the active fullscreen (element tag) — diagnostics for
// top-layer navigation issues.
function fullscreenLabel() {
  const fs = document.fullscreenElement;
  if (!fs) return 'no';
  return `${fs.tagName.toLowerCase()}${fs.id ? '#' + fs.id : ''}`;
}

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

function ensureStyles() {
  if (!document.getElementById(STATS_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STATS_STYLE_ID;
    style.textContent = STATS_CSS;
    document.head.appendChild(style);
  }
}

function buildPanel() {
  const panel = document.createElement('div');
  panel.className = 'deckflix-stats-panel';
  panel.innerHTML = `
    <h2>Deck<span>Flix</span> Player Stats</h2>
    <table data-mode="Stats"></table>
    <div class="deckflix-stats-actions">
      <button class="deckflix-stats-item" id="deckflix-stats-refresh">Refresh</button>
      <button class="deckflix-stats-item" id="deckflix-stats-close">Close</button>
    </div>
  `;
  const table = panel.querySelector('table');
  valueCells = new Map();
  for (const [label] of rows()) {
    const row = table.insertRow(-1);
    row.insertCell(-1).textContent = label;
    valueCells.set(label, row.insertCell(-1));
  }
  panel.querySelector('#deckflix-stats-refresh')
    .addEventListener('click', () => update());
  panel.querySelector('#deckflix-stats-close')
    .addEventListener('click', () => closeStats());
  return panel;
}

function update() {
  for (const [label, value] of rows()) {
    const cell = valueCells.get(label);
    if (cell) cell.textContent = value;
  }
}

function openStats() {
  ensureStyles();
  frameSample = null; // fresh FPS measurement per open
  if (!statsElement || !statsElement.isConnected) {
    statsElement = document.createElement('div');
    statsElement.id = STATS_ID;
    statsElement.appendChild(buildPanel());
    document.body.appendChild(statsElement);
  }
  window.__deckflix?.trackTopLayer?.(statsElement); // fullscreen-safe
  window.__deckflix?.attachTopLayer?.(statsElement);
  update();
  statsElement.classList.add('deckflix-stats-open');
  isOpen = true;
  refreshMediaInfo();
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      refreshMediaInfo();
      update();
    }, REFRESH_MS);
  }
  window.__deckflix?.retakeFocus?.(); // spatial focus onto Refresh/Close
}

function closeStats() {
  if (statsElement) statsElement.classList.remove('deckflix-stats-open');
  isOpen = false;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function toggleStats() {
  if (isOpen) closeStats();
  else openStats();
}

function isStatsOpen() {
  return isOpen;
}

/*
 * Overlay consumer contract: 'stats' toggles; while open, B / stats /
 * Home close it (menu-on-top still allowed via 'menu' pass-through).
 */
function consumeInput(action) {
  if (isOpen) {
    if (action === 'back' || action === 'stats' || action === 'home') {
      closeStats();
      return true;
    }
    return false;
  }
  if (action === 'stats') {
    openStats();
    return true;
  }
  return false;
}

window.__deckflix = Object.assign({}, window.__deckflix, {
  isStatsOpen,
  inputConsumers: [
    ...((window.__deckflix && window.__deckflix.inputConsumers) || []),
    consumeInput,
  ],
});