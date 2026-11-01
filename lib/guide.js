'use strict';

/*
 * In-page control guide overlay (gamepad X button toggles it).
 *
 * A closed overlay listing the gamepad/remote mapping, styled to match
 * the Netflix dark UI. Controller-type detection labels the face
 * buttons the way the connected pad does (Xbox A/B/X/Y vs PlayStation
 * ✕/○/□/△). While open, it swallows 'guide' and 'back' presses; spatial
 * navigation pauses via the window.__deckflix.isGuideOpen() guard.
 */

const GUIDE_ID = 'deckflix-guide';
const GUIDE_STYLE_ID = 'deckflix-guide-style';

const GUIDE_CSS = `
  #${GUIDE_ID} {
    position: fixed;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.78);
    z-index: 2147483647;
  }
  #${GUIDE_ID}.deckflix-guide-open { display: flex; }
  #${GUIDE_ID} .deckflix-guide-panel {
    background: rgba(24, 24, 26, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 16px;
    padding: 22px 36px;
    max-width: 760px;
    max-height: 80vh;
    overflow-y: auto;
    color: #fff;
    font: 14px/1.5 sans-serif;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.6);
  }
  #${GUIDE_ID} h2 {
    margin: 0 0 2px;
    font-size: 22px;
    letter-spacing: 0.01em;
  }
  #${GUIDE_ID} h2 span { color: #e50914; }
  #${GUIDE_ID} .deckflix-guide-sub {
    color: rgba(255, 255, 255, 0.55);
    margin: 0 0 10px;
    font-size: 12.5px;
  }
  #${GUIDE_ID} h3 {
    margin: 10px 0 4px;
    font-size: 18px;
    font-weight: 700;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: #e50914;
  }
  #${GUIDE_ID} table { width: 100%; border-collapse: collapse; }
  #${GUIDE_ID} .deckflix-guide-colhdr td {
    padding: 1px 14px 4px 0;
    font-size: 16.5px;
    font-weight: 700;
    color: rgba(255, 255, 255, 0.42);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  #${GUIDE_ID} .deckflix-guide-colhdr td:nth-child(2) { color: rgba(57, 142, 254, 0.85); }
  #${GUIDE_ID} .deckflix-guide-colhdr td:first-child { color: #ff5a62; }
  #${GUIDE_ID} td { padding: 3px 14px 3px 0; vertical-align: baseline; }
  #${GUIDE_ID} td:first-child {
    white-space: nowrap;
    color: #ff5a62;
    font-weight: 600;
  }
  #${GUIDE_ID} td:nth-child(2) { white-space: nowrap; color: #398EFE; }
  #${GUIDE_ID} td:last-child { color: rgba(255, 255, 255, 0.55); }
`;

/* Face-button glyphs per detected controller family. */
const CONTROLLER_LABELS = {
  playstation: Object.freeze({ A: '✕', B: '○', X: '□', Y: '△' }),
  xbox: Object.freeze({ A: 'A', B: 'B', X: 'X', Y: 'Y' }),
  generic: Object.freeze({ A: 'Ⓐ', B: 'Ⓑ', X: 'Ⓧ', Y: 'Ⓨ' }),
};

function detectControllerFamily() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const pad of pads) {
    if (!pad || !pad.id) continue;
    const id = pad.id.toLowerCase();
    if (/playstation|dualshock|dualsense|054c|054[a-z]*c|wireless controller/.test(id)) {
      return 'playstation';
    }
    if (/xbox|xinput|045e|x360/.test(id)) return 'xbox';
  }
  return 'generic';
}

/*
 * Sections of paired rows, rendered gamepad-first with the TV-remote /
 * keyboard equivalent beside it so both input paths read side-by-side
 * (the guide adapts its labels to the detected controller family).
 * Remote notes: 'Menu key' = ContextMenu keysym.
 */
function guideSections(family) {
  const face = CONTROLLER_LABELS[family] || CONTROLLER_LABELS.generic;
  const f = (name) => String(face[name] || name);
  return [
    {
      title: 'Browse',
      rows: [
        [f('A'), 'Enter / Space', 'activate the focused card / element'],
        [f('B'), 'Esc / Backspace', 'back'],
        ['D-pad / left stick', 'Arrow keys', 'move focus'],
        [f('B') + ' (hold) / Start', 'Menu key', 'open the DeckFlix menu'],
        ['Right stick', 'Page Up / Down', 'page scrolling'],
        [f('X'), '—', 'open / close this guide'],
      ],
    },
    {
      title: 'Watch',
      rows: [
        [f('A'), 'Space / Enter', 'play–pause · activate the focused control'],
        [f('B'), 'Esc / Backspace', 'back to browse'],
        ['D-pad / left stick', 'Arrow keys', 'move through player controls'],
        [f('Y'), '—', 'toggle fullscreen'],
        [f('LB') + ' / ' + f('RB'), 'Media FF / RW', 'seek ∓10 s (hold: repeats)'],
        [f('LT') + ' / ' + f('RT'), 'XF86 Vol − / +', 'volume down / up'],
        ['—', 'Media ▶ ⏸ ⏹', 'play / pause / stop'],
        ['Home', 'Home', 'Netflix home (browse)'],
      ],
    },
  ];
}

let guideElement = null;
let isOpen = false;

function ensureStyles() {
  if (!document.getElementById(GUIDE_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = GUIDE_STYLE_ID;
    style.textContent = GUIDE_CSS;
    document.head.appendChild(style);
  }
}

function buildPanel(root, family) {
  const panel = document.createElement('div');
  panel.className = 'deckflix-guide-panel';

  const heading = document.createElement('h2');
  heading.innerHTML = 'Deck<span>Flix</span> Controls';
  panel.appendChild(heading);

  const sub = document.createElement('p');
  sub.className = 'deckflix-guide-sub';
  sub.textContent =
    family === 'playstation' ? 'PlayStation controller detected · press □ to close, ○ for back'
    : family === 'xbox' ? 'Xbox controller detected · press X to close, B for back'
    : 'press X to close, B for back';
  panel.appendChild(sub);

  for (const { title, rows } of guideSections(family)) {
    const h3 = document.createElement('h3');
    h3.textContent = title;
    panel.appendChild(h3);

    const table = document.createElement('table');
    table.dataset.mode = title;

    const header = table.insertRow(-1);
    header.className = 'deckflix-guide-colhdr';
    const padHead = header.insertCell(-1);
    padHead.textContent =
      family === 'playstation' ? 'PlayStation' : family === 'xbox' ? 'Gamepad' : 'Gamepad';
    header.insertCell(-1).textContent = 'Remote / keyboard';
    header.insertCell(-1).textContent = '';

    for (const [padInput, remoteInput, description] of rows) {
      const row = table.insertRow(-1);
      row.insertCell(-1).textContent = padInput;
      row.insertCell(-1).textContent = remoteInput;
      row.insertCell(-1).textContent = description;
    }
    panel.appendChild(table);
  }
  return panel;
}

function openGuide() {
  ensureStyles();
  if (!guideElement || !guideElement.isConnected) {
    guideElement = document.createElement('div');
    guideElement.id = GUIDE_ID;
    guideElement.appendChild(buildPanel(guideElement, detectControllerFamily()));
    document.body.appendChild(guideElement);
  }
  window.__deckflix?.trackTopLayer?.(guideElement); // fullscreen-safe
  window.__deckflix?.attachTopLayer?.(guideElement);
  guideElement.classList.add('deckflix-guide-open');
  isOpen = true;
  window.__deckflix?.retakeFocus?.();
}

function closeGuide() {
  if (guideElement) guideElement.classList.remove('deckflix-guide-open');
  isOpen = false;
}

function toggleGuide() {
  if (isOpen) closeGuide();
  else openGuide();
}

function isGuideOpen() {
  return isOpen;
}

function consumeInput(action) {
  if (isOpen) {
    if (action === 'guide' || action === 'back' || action === 'home') {
      closeGuide();
      return true;
    }
    return false;
  }
  if (action === 'guide') {
    openGuide();
    return true;
  }
  return false;
}

// Register into the shared feature registry (extended, not replaced).
window.__deckflix = Object.assign({}, window.__deckflix, {
  isGuideOpen,
  inputConsumers: [
    ...((window.__deckflix && window.__deckflix.inputConsumers) || []),
    consumeInput,
  ],
});