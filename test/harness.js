'use strict';

/*
 * Harness: serves test/ on 127.0.0.1, loads the browse and player pages
 * with the REAL preload stack, drives `deckflix-input` events and asserts
 * spatial-navigation behaviour. Run: node test/harness.js
 *
 * DECKFLIX_TEST=1 detaches the preload from physical devices (gamepad
 * polling, trusted-key remote listener) so background runs aren't
 * polluted by input on the desktop the suite shares.
 */

process.env.DECKFLIX_TEST = '1';

const http = require('http');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { installPlayerWakeIpc } = require('../lib/wake');

const PORT = 18744;
const BASE = `http://127.0.0.1:${PORT}`;

const fs = require('fs');

const server = http.createServer((req, res) => {
  const file = req.url.startsWith('/watch') ? 'watch.html' : 'page.html';
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('nope');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(data);
  });
});

const BROWSE_DRIVER = `
  (async () => {
    console.log('[driver] top reached');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    localStorage.removeItem('deckflix:settings'); // deterministic run-to-run
    const focused = () => window.__deckflix.focused();
    const id = () => (focused() ? focused().id || '>' + focused().tagName : 'none');
    const press = (action, arg) =>
      window.dispatchEvent(new CustomEvent('deckflix-input', { detail: { action, arg } }));
    const center = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const ringOpacity = () => getComputedStyle(document.getElementById('deckflix-focus-ring')).opacity;
    const nav = async (dir, times) => {
      const before = focused() ? id() : 'none';
      const beforeC = focused() ? center(focused()) : null;
      for (let i = 0; i < times; i++) { press('nav', dir); await sleep(70); }
      await sleep(200);
      const after = focused();
      const afterC = after ? center(after) : null;
      let movedCorrectly = null;
      if (!beforeC) movedCorrectly = !!after;
      else if (!afterC) movedCorrectly = false;
      else {
        let primary;
        if (dir === 'left') primary = afterC.x < beforeC.x - 5;
        else if (dir === 'right') primary = afterC.x > beforeC.x + 5;
        else if (dir === 'up') primary = afterC.y < beforeC.y - 5;
        else primary = afterC.y > beforeC.y + 5;
        const lateral =
          (dir === 'left' || dir === 'right') ? Math.abs(afterC.y - beforeC.y) : Math.abs(afterC.x - beforeC.x);
        movedCorrectly = primary && lateral < 420;
      }
      return { before, after: id(), movedCorrectly };
    };

    await sleep(800);
    const log = {};
    log.dpr = window.devicePixelRatio; // ≠ 1 ⇒ Chromium zoom pollution
    log.viewport = window.innerWidth + 'x' + window.innerHeight;
    log.testMode = window.__deckflixOptions?.testMode === true;
    log.initialFocus = id();
    log.scrollbarsHidden = !!document.getElementById('deckflix-page-style') &&
      document.documentElement.offsetWidth === document.documentElement.clientWidth;
    // Wait for the ring's fade-in transition to settle.
    for (let i = 0; i < 20 && ringOpacity() !== '1'; i++) await sleep(100);
    log.ringVisible = ringOpacity();

    log.rightFromFocus = await nav('right', 1);
    log.rightAgain = await nav('right', 1);
    log.downFromRow = await nav('down', 1);
    log.leftInNewRow = await nav('left', 1);
    log.upFromRow = await nav('up', 1);

    // hold: 6 right presses; informational — shows where focus lands after
    // repeatedly walking toward/onto the row end. (The Skip button, fixed
    // at the far right, is a legitimate right-neighbour here.)
    log.stuckToEndThenStop = await nav('right', 6);

    /* -------- modal / popup layer trapping -------- */
    console.log('[driver] section: modal / popup layer trapping');
    document.getElementById('open-modal').click();
    await sleep(120);
    // Focus is currently buried under the backdrop → next press re-takes
    // the top layer instead of moving within the base page.
    press('nav', 'down');
    await sleep(300);
    log.modalFocusAfterBury = id();
    log.ringOnModal = ringOpacity();
    const buriedTop = focused() ? Math.round(focused().getBoundingClientRect().top) : 0;

    press('nav', 'down');
    await sleep(120);
    log.modalNavStaysInModal = id();
    log.modalNavSecondTop = focused() ? Math.round(focused().getBoundingClientRect().top) : 0;
    log.modalNavBuriedTop = buriedTop;

    document.getElementById('m-close').click(); // modal closes (no history)
    await sleep(400); // observer debounce 250ms
    log.backToBaseAfterModalClose = id();

    /* -------- right-stick scroll / HUD / guide overlay -------- */
    console.log('[driver] section: right-stick scroll / HUD / guide overlay');
    const scrollBefore = window.scrollY;
    press('scroll', { x: 0, y: 600 });
    await sleep(150);
    log.scrollMoved = window.scrollY - scrollBefore;

    window.dispatchEvent(new CustomEvent('deckflix-feedback', { detail: { text: 'Test toast' } }));
    await sleep(150);
    const toast = document.getElementById('deckflix-hud-toast');
    log.hudToast = toast ? toast.textContent : 'none';

    press('guide');
    await sleep(150);
    log.guideOpens = window.__deckflix.isGuideOpen();
    // Side-by-side input columns: gamepad + remote cells, one per function.
    log.guideHasSections = ['Browse', 'Watch'].every((m) =>
      document.querySelector('#deckflix-guide table[data-mode="' + m + '"]'));
    log.guideColumnsPaired = (() => {
      const table = document.querySelector('#deckflix-guide table[data-mode="Browse"]');
      if (!table) return false;
      const cells = [...table.querySelectorAll('td')].map((td) => td.textContent);
      return cells.includes('Remote / keyboard') &&
        cells.includes('Enter / Space') && cells.includes('Esc / Backspace');
    })();
    const focusWhileGuideOpen = id();
    press('nav', 'down'); // spatial movement must be suppressed while guide is open
    await sleep(150);
    log.guideBlocksNav = id() === focusWhileGuideOpen;
    press('back'); // guide intercepts: closes, no history.back
    await sleep(150);
    log.guideClosesOnBack = !window.__deckflix.isGuideOpen();
    log.focusSurvivesGuide = id() === focusWhileGuideOpen;

    // Restore scroll so later spatial assertions see the original geometry.
    window.scrollTo(0, scrollBefore);
    await sleep(250);

    /* -------- DeckFlix menu + preview-suppression setting -------- */
    console.log('[driver] section: DeckFlix menu + preview-suppression setting');
    const hrefInMenu = window.location.href;
    const appActions = [];
    const realBridge = window.__deckflixBridge;
    window.__deckflixBridge = { sendStatus: () => {}, appAction: (a, v) => appActions.push([a, v]) };

    press('menu');
    await sleep(250);
    log.menuOpens = window.__deckflix.isMenuOpen();
    log.menuFocusLandsInMenu = id().startsWith('menu-') || /^deckflix-menu-/.test(focused()?.id || '');

    const menuFocus1 = id();
    press('nav', 'down');
    await sleep(150);
    log.menuNavMoves = id() !== menuFocus1 && /^(deckflix-menu-|m-)/.test(focused()?.id || '');

    // Hover-preview setting: off → no synthetic hover, on → hover returns.
    // Vertical moves only: menu items are stacked full-width rows, so
    // left/right has no lateral target inside the panel.
    window.__deckflix.setShowPreviews(false);
    const h0 = +sessionStorage.getItem('df-test:hovers');
    press('nav', 'down');
    await sleep(150);
    log.hoverSuppressedWhenOff = +sessionStorage.getItem('df-test:hovers') === h0 && focused() !== null;
    window.__deckflix.setShowPreviews(true);
    const h1 = +sessionStorage.getItem('df-test:hovers');
    press('nav', 'down');
    await sleep(150);
    log.hoverRestoredWhenOn = +sessionStorage.getItem('df-test:hovers') > h1;

    press('back'); // menu consumed it: closes, no history change
    await sleep(300);
    log.menuBackCloses = !window.__deckflix.isMenuOpen();
    log.menuBackNoHistory = window.location.href === hrefInMenu;

    press('menu'); // reopen for quit + zoom wiring tests
    await sleep(250);
    document.getElementById('deckflix-menu-quit').click();
    await sleep(120);
    log.quitSendsAppAction = appActions.some(([a]) => a === 'quit');
    log.quitClosesMenu = !window.__deckflix.isMenuOpen();

    press('menu'); // zoom stepper: inert value readout, −/+ via left/right
    await sleep(250);
    for (let i = 0; i < 6 && id() !== 'deckflix-menu-zoom-label'; i++) {
      press('nav', 'down');
      await sleep(90);
    }
    log.zoomLabelReached = id() === 'deckflix-menu-zoom-label';

    press('nav', 'left'); // value is inert: step to the − button
    await sleep(120);
    log.zoomMinusReached = id() === 'deckflix-menu-zoom-out';
    press('activate'); // − : 100% → 90%
    await sleep(150);
    log.zoomDownValue = appActions.filter(([a]) => a === 'zoom').at(-1)?.[1];

    press('nav', 'right'); // step back onto the readout
    await sleep(120);
    log.zoomLabelTracks = document.getElementById('deckflix-menu-zoom-label')?.textContent;

    press('nav', 'right');
    await sleep(120);
    log.zoomPlusReached = id() === 'deckflix-menu-zoom-in';
    press('activate'); // ＋ : 90% → 100%
    await sleep(150);
    log.zoomUpValue = appActions.filter(([a]) => a === 'zoom').at(-1)?.[1];

    press('nav', 'left'); // back onto the inert readout
    await sleep(120);
    press('activate'); // inert: no zoom action, focus stays put
    await sleep(150);
    log.zoomLabelInert = id() === 'deckflix-menu-zoom-label' &&
      appActions.filter(([a]) => a === 'zoom').length === 2;

    document.getElementById('deckflix-menu-zoom-reset').click();
    await sleep(150);
    log.zoomResetValue = appActions.filter(([a]) => a === 'zoom').at(-1)?.[1];
    log.zoomLabelAfterReset = document.getElementById('deckflix-menu-zoom-label')?.textContent;
    press('back'); // close the menu before the base-layer activation tests
    await sleep(300);
    window.__deckflixBridge = realBridge;

    /* -------- activation -------- */
    console.log('[driver] section: activation');

    // Step back onto a real card link before testing activation.
    await nav('left', 1);
    log.preActivateFocus = id();

    const hrefBefore = window.location.href;
    press('activate');
    await sleep(200);
    log.activateNavigated = window.location.href !== hrefBefore && !!window.location.hash;
    log.ringAfterActivate = ringOpacity();

    /* -------- TV remote (keyboard) front-end -------- */
    console.log('[driver] section: TV remote (keyboard) front-end');
    // SPA route change after activation resets focus and re-establishes it
    // asynchronously (FOCUS_RETRY cadence) — wait for it to settle first.
    for (let i = 0; i < 40 && !focused(); i++) await sleep(50);
    const remoteKey = window.__deckflix.remoteKey;
    log.remoteIgnoresOtherKeys = remoteKey('KeyZ') === null;
    const remoteFromId = id();
    const remoteTopBefore = focused()?.getBoundingClientRect().top ?? -1;
    remoteKey('ArrowDown'); // remote d-down → spatial move
    await sleep(150);
    const remoteTopAfter = focused()?.getBoundingClientRect().top ?? -1;
    log.remoteArrowValues = { from: remoteFromId, topBefore: remoteTopBefore, topAfter: remoteTopAfter, to: id() };
    log.remoteArrowsNav = id() !== remoteFromId && remoteTopAfter > remoteTopBefore + 5;

    const remoteHrefBefore = window.location.href;
    remoteKey('Enter'); // OK button → activate
    await sleep(200);
    log.remoteEnterActivates = window.location.href !== remoteHrefBefore;

    /* -------- player stats modal -------- */
    console.log('[driver] section: player stats modal');
    press('menu');
    await sleep(250);
    document.getElementById('deckflix-menu-stats').click();
    await sleep(2200); // >= 2 stats refresh ticks so the FPS sampler settles
    log.statsOpens = window.__deckflix.isStatsOpen();
    log.statsTableRowCount = document.querySelectorAll('#deckflix-stats table tr').length;
    log.statsShowsWidevine = document.getElementById('deckflix-stats')?.textContent.includes('Widevine');
    log.statsFrameRateText = (() => {
      for (const row of document.querySelectorAll('#deckflix-stats table tr')) {
        if (row.children[0]?.textContent === 'Frame rate') {
          return row.children[1]?.textContent || '';
        }
      }
      return 'missing';
    })();
    log.statsCodecRows = (() => {
      const want = ['Video', 'Audio'];
      const seen = {};
      for (const row of document.querySelectorAll('#deckflix-stats table tr')) {
        const label = row.children[0]?.textContent;
        if (want.includes(label)) seen[label] = row.children[1]?.textContent;
      }
      return want.map((w) => w + ':' + seen[w]);
    })();
    press('back'); // modal consumes it: closes, no history change
    await sleep(200);
    log.statsClosesOnBack = !window.__deckflix.isStatsOpen();
    return log;
  })()
`;

const PLAYER_DRIVER = `
  (async () => {
    console.log('[driver] top reached');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    localStorage.removeItem('deckflix:settings'); // deterministic run-to-run
    const press = (action, arg) =>
      window.dispatchEvent(new CustomEvent('deckflix-input', { detail: { action, arg } }));
    // Fixtures live in the page world; their sessionStorage mirrors are
    // shared across worlds so the isolated driver can read them.
    const store = (k) => JSON.parse(sessionStorage.getItem('df-test:' + k) || '[]');
    const keys = () => store('keys');
    const clicks = () => store('clicks');
    const feedback = () => store('feedback');
    const pulses = () => store('pulses');
    const replica = () => JSON.parse(sessionStorage.getItem('df-test:replica') || '{}');
    const replicaMoves = () => replica().movementLog || [];
    const testOp = (op, extra = {}) => window.dispatchEvent(new CustomEvent('deckflix-test', { detail: Object.assign({ op }, extra) }));
    const focused = () => window.__deckflix.focused();
    const log = {};
    await sleep(500);

    press('nav', 'right');      // sticks/d-pad = spatial over player controls
    await sleep(150);
    log.playerNavInControls = (focused()?.id || '').startsWith('pc-');
    const startX = focused()?.getBoundingClientRect().left ?? -1;
    press('nav', 'right');
    await sleep(150);
    log.playerNavMovesForward = (focused()?.getBoundingClientRect().left ?? -1) > startX + 5;
    log.playerNavEndId = focused()?.id || 'none';

    press('seek', 10);          // bumpers → arrow-key seek (10 s)
    await sleep(100);
    log.seekRightKeys = keys().join(',');

    press('nav', 'up');         // spatial up to the skip-intro button
    await sleep(150);
    log.focusAfterUp = focused()?.id || 'none';

    press('activate');          // clicks the focused control (skip)
    await sleep(100);
    log.clicks = clicks().join(',');
    log.pulseCount = pulses().length;

    press('activate');          // focus cleared → play/pause
    await sleep(100);
    log.keysAfterToggle = keys().join(',');

    press('fullscreen');
    await sleep(100);
    log.keysAfterFullscreen = keys().join(',');

    press('volume', 1);         // triggers: ±10% on the <video>
    press('seek', -10);         // bumpers: back 10 s
    await sleep(120);
    log.videoVolume = document.getElementById('player-video')?.volume ?? null;
    log.feedbackSeen = feedback().join('|');

    await sleep(700); // playback fallback verification window (350 ms) elapses
    log.playbackFallbackFeedback = feedback().includes('▶ Play');

    /* remote media keys ride the shared MPRIS command path */
    const remoteKey = window.__deckflix.remoteKey;
    remoteKey('MediaPlayPause');
    await sleep(600);
    log.remotePlayFeedback = feedback().includes('▶ Play');
    remoteKey('XF86AudioRaiseVolume');
    await sleep(150);
    log.remoteVolume = document.getElementById('player-video')?.volume;

    /* -------- player activate SELECTS the focused control -------- */
    console.log('[driver] section: player activate SELECTS the focused control');
    press('nav', 'down');       // ensure focus sits on a live bar control
    await sleep(200);
    const controlFocusedOn = focused()?.id || 'none';
    press('activate');          // A on a focused control must click IT,
    await sleep(150);           // not fall through to play/pause
    log.controlFocusedOn = controlFocusedOn;
    log.playerActivateSelects = controlFocusedOn !== 'none' &&
      clicks().includes(controlFocusedOn);

    /* ---- player bar auto-hide lifecycle: display-hide shape ---- */
    console.log('[driver] section: player bar auto-hide lifecycle: display-hide');
    const controlsEl = document.querySelector('.controls');
    press('nav', 'left');       // fresh focus parks on a live bar control
    await sleep(150);
    log.parkedFocus = focused()?.id || 'none';
    log.parkedOnControl = (focused()?.id || '').startsWith('pc-');
    controlsEl.style.display = 'none'; // Netflix-style autohide under the focus
    press('nav', 'down'); // any input: stale focus dropped, re-take onto live
    await sleep(200);
    log.focusAfterBarHides = focused()?.id || 'none'; // expect skip (only live control)
    controlsEl.style.display = ''; // bar returns (idle timer refreshed)
    press('nav', 'down');       // navigation resumes over live controls
    await sleep(200);
    log.focusAfterBarReturns = focused()?.id || 'none';

    /* ---- player bar auto-hide lifecycle: opacity-hide shape (Netflix) ---- */
    console.log('[driver] section: player bar auto-hide lifecycle: opacity-hide');
    // Arm the replica's idle timer, let it hide the bar UNDER the parked
    // focus, then press: stale focus must force-show the pinned bar.
    testOp('show-controls');
    testOp('reset-replica');
    testOp('arm-idle', { ms: 1000 });
    await sleep(1700); // idle window elapses -> replica hides
    log.replicaHidIdle = replica().shown === false &&
      getComputedStyle(controlsEl).opacity === '0';
    log.replicaProbePre = {
      focused: focused()?.id || 'none',
      controlsOpacity: getComputedStyle(controlsEl).opacity,
      trail: window.__deckflix.barTrailDebug(),
    };
    press('nav', 'down'); // stale drop + inline force-show + re-take
    await sleep(300);
    const replicaState = () => ({
      shown: replica().shown,
      away: controlsEl.classList.contains('controls-away'),
      moves: replicaMoves().length,
    });
    log.replicaState1 = replicaState(); // right after the first press
    await sleep(700); // first CDP attach + burst may lag
    log.replicaState2 = replicaState(); // settle point
    log.barForceShown = getComputedStyle(controlsEl).opacity === '1';
    log.focusAfterIdleWake = focused()?.id || 'none';
    log.replicaMovementLog = replicaMoves().join('|');

    /* ---- grace release: overrides release after idle, Netflix autohide resumes ---- */
    await sleep(4800); // PLAYER_BAR_GRACE_MS elapsed without player input
    log.barReleasedAfterGrace = !controlsEl.classList.contains('controls-away') ||
      getComputedStyle(controlsEl).opacity === '0';
    testOp('show-controls'); // bar shown (idle NOT re-armed) for fullscreen block

    /* -------- fullscreen navigation stress (Netflix's container shape) ---- */
    console.log('[driver] section: fullscreen navigation stress (Netflixs cont');
    // Fullscreen the player container exactly like Netflix does: video +
    // controls + skip all live INSIDE the top-layer subtree.
    const fsAttempt = await Promise.race([
      document.getElementById('player-shell').requestFullscreen()
        .then(() => 'ok').catch((e) => 'rejected: ' + e.message),
      sleep(2000).then(() => 'timeout'),
    ]);
    log.fullscreenAttempt = fsAttempt;
    for (let i = 0; i < 20 && !document.fullscreenElement; i++) await sleep(50);
    log.fullscreenElementInFs = document.fullscreenElement
      ? (document.fullscreenElement.id || document.fullscreenElement.tagName) : 'none';
    await sleep(250); // let the ring re-parent, wake, etc.
    press('nav', 'left'); // wake + (possibly stale) nav inside fullscreen
    await sleep(250);
    log.navInFullscreen = (focused()?.id || '').startsWith('pc-') || focused()?.id === 'skip';
    log.ringParentInFullscreen = document.getElementById('deckflix-focus-ring')
      ?.parentElement?.id || 'body';
    log.ringVisibleInFullscreen = getComputedStyle(document.getElementById('deckflix-focus-ring')).opacity;
    press('nav', 'right'); // navigation still moves within the top layer
    await sleep(250);
    log.navMovesInFullscreen = focused()?.id !== 'none';
    const exitReq = await Promise.race([
      document.exitFullscreen().then(() => 'ok').catch((e) => 'rejected: ' + e.message),
      sleep(2000).then(() => 'timeout'),
    ]);
    log.fullscreenExit = exitReq;
    for (let i = 0; i < 20 && document.fullscreenElement; i++) await sleep(50);
    await sleep(250);
    log.ringParentAfterExit = document.getElementById('deckflix-focus-ring')
      ?.parentElement?.id || 'body';
    return log;
  })()
`;

let failures = 0;

function expect(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
function expectTruthy(name, got) {
  const ok = !!got;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${JSON.stringify(got)}`);
}

// Test mode: relay renderer console to main stdout (driver checkpoints).
function relayRendererConsole(win, name) {
  win.webContents.on('console-message', (e) => {
    const text = e.message || e.text || '';
    if (text.startsWith('[driver]')) {
      console.log(`[harness:${name}]`, text);
    }
  });
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  return win;
}

// Element fullscreen (the player-driver stress test) needs a mapped view:
// on hidden windows the fullscreen request can hang.
async function createPlayerWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: true, // briefly visible during runs
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  return win;
}

// Trusted-input probe with retries: races vs page-readiness are noise;
// PERSISTENT non-delivery (the fullscreen-transitions bug) still fails.
async function sendTrustedKeyProbe(win, key) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const keys = await win.webContents
      .executeJavaScript("sessionStorage.getItem('df-test:trusted')", true);
    if (keys.includes(key)) return keys;
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
    await new Promise((r) => setTimeout(r, 250));
  }
  return await win.webContents
    .executeJavaScript("sessionStorage.getItem('df-test:trusted')", true);
}

// Driver runner: executes the driver INSIDE the preload world (the world
// our lib lives in under contextIsolation), collecting the result over IPC.
let driverCallId = 0;
const driverResults = new Map();

ipcMain.on('deckflix-test:result', (_event, callId, json) => {
  console.log('[harness] driver result received', callId);
  driverResults.set(callId, json);
});

async function runDriver(win, code) {
  const callId = String(++driverCallId);
  driverResults.delete(callId);
  console.log('[harness] runDriver sending', callId, 'to', win.webContents.getTitle());
  win.webContents.send('deckflix-test:eval', callId, code);
  const deadline = Date.now() + 240000;
  let json = null;
  while (!json && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    json = driverResults.get(callId);
  }
  if (!json) throw new Error('driver timeout');
  driverResults.delete(callId);
  return JSON.parse(json);
}

// Chromium remembers per-origin zoom across sessions in the default
// partition — neutralize it (debug scripts / stale runs pollute it) so
// every run is measured at exactly 100%.
function resetZoom(win) {
  win.webContents.setZoomLevel(0);
}

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log('[harness] server on', BASE);

  /* ---------------- browse page ---------------- */
  console.log('[driver] section: browse page');
  const browse = await createWindow();
  resetZoom(browse);
  await browse.loadURL(BASE + '/');
  resetZoom(browse);
  browse.webContents.on('preload-error', (e, p, err) => console.log('[harness] PRELOAD-ERR browse:', (err?.message || "").slice(0, 90)));
  ipcMain.on('deckflix:status', (e, s) => console.log('[harness] status mode=' + s.mode + ' testMode=' + s.testMode));
  relayRendererConsole(browse, 'browse');
  const ping = await runDriver(browse, "(async () => 'registry:' + (window.__deckflix ? 'ok' : 'NO'))();");
  console.log('[harness] driver ping →', ping);
  const blog = await runDriver(browse, BROWSE_DRIVER);
  console.log('[harness] browse:', JSON.stringify(blog, null, 2));

  expectTruthy('browse: initial focus found', blog.initialFocus && blog.initialFocus !== 'none');
  expectTruthy('browse: scrollbars hidden (page chrome)', blog.scrollbarsHidden);
  expect('browse: ring visible', blog.ringVisible, '1');
  expectTruthy('browse: first right moves forward', blog.rightFromFocus.movedCorrectly);
  expectTruthy('browse: second right moves forward', blog.rightAgain.movedCorrectly);
  expectTruthy('browse: down reaches lower row', blog.downFromRow.movedCorrectly);
  expectTruthy('browse: left moves back', blog.leftInNewRow.movedCorrectly);
  expectTruthy('browse: up moves back', blog.upFromRow.movedCorrectly);
  console.log(`INFO  browse: 6x right from last checked position → ${blog.stuckToEndThenStop.before} → ${blog.stuckToEndThenStop.after}`);
  expectTruthy('browse: modal re-takes trapped focus', ['m-a', 'm-b', 'm-c', 'm-close'].includes(blog.modalFocusAfterBury));
  expectTruthy('browse: modal nav stays inside the modal and moves down',
    ['m-a', 'm-b', 'm-c', 'm-close'].includes(blog.modalNavStaysInModal) &&
    blog.modalNavSecondTop > blog.modalNavBuriedTop);
  expectTruthy('browse: modal-close returns to base layer', !['none', 'm-a', 'm-b', 'm-c', 'm-close'].includes(blog.backToBaseAfterModalClose));
  expectTruthy('browse: stepped back onto a card link', !['none', 'skip', ''].includes(blog.preActivateFocus));
  expectTruthy('browse: activation follows link', blog.activateNavigated);
  expectTruthy('browse: remote ignores unmapped keys', blog.remoteIgnoresOtherKeys);
  expectTruthy('browse: remote arrows navigate spatially', blog.remoteArrowsNav);
  expectTruthy('browse: remote Enter activates', blog.remoteEnterActivates);
  expectTruthy('browse: test mode detaches physical input', blog.testMode);
  expect('browse: viewport at 100% zoom', blog.dpr, 1);
  expectTruthy('browse: stats modal opens from menu', blog.statsOpens);
  expectTruthy('browse: stats modal reports media pipeline rows', blog.statsTableRowCount >= 9);
  expectTruthy('browse: stats modal includes Widevine state', blog.statsShowsWidevine);
  expectTruthy('browse: stats modal reports a frame rate row',
    /^(\d+\.\d+ fps|measuring|—)/.test(blog.statsFrameRateText || ''));
  expectTruthy('browse: stats modal has codec rows (Video/Audio)',
    blog.statsCodecRows?.length === 2 &&
    blog.statsCodecRows.every((entry) => /^Video:|^Audio:/.test(entry)));
  expectTruthy('browse: stats modal closes on back', blog.statsClosesOnBack);
  expectTruthy('browse: scroll action moves the page', blog.scrollMoved > 300);
  expect('browse: HUD toast renders text', blog.hudToast, 'Test toast');
  expectTruthy('browse: guide overlay opens on X', blog.guideOpens);
  expectTruthy('browse: guide lists Browse + Watch sections', blog.guideHasSections);
  expectTruthy('browse: guide pairs gamepad and remote columns', blog.guideColumnsPaired);
  expectTruthy('browse: guide suppresses spatial nav', blog.guideBlocksNav);
  expectTruthy('browse: guide closes on back instead of history.back', blog.guideClosesOnBack);
  expectTruthy('browse: focus survives guide open/close', blog.focusSurvivesGuide);
  expectTruthy('browse: menu opens from menu action', blog.menuOpens);
  expectTruthy('browse: focus lands in the menu panel', blog.menuFocusLandsInMenu);
  expectTruthy('browse: menu items are spatially navigable', blog.menuNavMoves);
  expectTruthy('browse: previews off suppresses synthetic hover', blog.hoverSuppressedWhenOff);
  expectTruthy('browse: previews on restores synthetic hover', blog.hoverRestoredWhenOn);
  expectTruthy('browse: back closes menu without history change', blog.menuBackCloses && blog.menuBackNoHistory);
  expectTruthy('browse: quit sends app action and closes menu',
    blog.quitSendsAppAction && blog.quitClosesMenu);
  expectTruthy('browse: zoom readout reachable by nav', blog.zoomLabelReached);
  expectTruthy('browse: left steps from readout to − button', blog.zoomMinusReached);
  expectTruthy('browse: − buttons zoom down one step', Math.abs(blog.zoomDownValue - 0.9) < 1e-9);
  expect('browse: readout tracks current zoom', blog.zoomLabelTracks, 'Zoom 90%');
  expectTruthy('browse: right steps from readout to + button', blog.zoomPlusReached);
  expectTruthy('browse: + buttons zoom back up', Math.abs(blog.zoomUpValue - 1) < 1e-9);
  expectTruthy('browse: readout activation is inert', blog.zoomLabelInert);
  expectTruthy('browse: zoom reset returns to 100%', Math.abs(blog.zoomResetValue - 1) < 1e-9);
  expect('browse: readout after reset', blog.zoomLabelAfterReset, 'Zoom 100%');
  await browse.close();

  /* ---------------- player page ---------------- */
  console.log('[driver] section: player page');
  const player = await createPlayerWindow();
  await player.loadURL(BASE + '/watch/123');
  resetZoom(player);
  relayRendererConsole(player, 'player');
  // Trusted-input probe (real input pipeline): baseline before anything.
  player.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'm' });
  player.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'm' });
  const trustedBeforeFs = await sendTrustedKeyProbe(player, 'm');
  // Exercise the trusted-wake IPC path against the real window objects:
  // wrong-API crashes here would previously only surface in the real app.
  let wakeWindow = player;
  installPlayerWakeIpc(() => wakeWindow);
  player.webContents.on('enter-html-full-screen', () =>
    require('../lib/wake').markFullscreenTransition());
  player.webContents.on('leave-html-full-screen', () =>
    require('../lib/wake').markFullscreenTransition());
  await player.loadURL(BASE + '/watch/123');
  resetZoom(player);
  relayRendererConsole(player, 'player');
  const plog = await runDriver(player, PLAYER_DRIVER);
  // Trusted-input probe AFTER the fullscreen cycle: injected events racing
  // fullscreen transitions once froze ALL trusted input at page level.
  const trustedAfterFs = await sendTrustedKeyProbe(player, 'm');
  console.log('[harness] player:', JSON.stringify(plog, null, 2));

  expectTruthy('player: sticks navigate player controls spatially', plog.playerNavInControls);
  expectTruthy('player: nav moves forward through controls',
    plog.playerNavMovesForward &&
    (plog.playerNavEndId.startsWith('pc-') || plog.playerNavEndId === 'skip'));
  expect('player: bumper seek+ synthesizes ArrowRight', plog.seekRightKeys, 'ArrowRight');
  expect('player: nav up reaches the skip-intro button', plog.focusAfterUp, 'skip');
  expectTruthy('player: focus was parked on a bar control first', plog.parkedOnControl);
  expect('player: hidden bar drops stale focus and re-takes live controls', plog.focusAfterBarHides, 'skip');
  expectTruthy('player: control bar returning resumes spatial nav',
    (plog.focusAfterBarReturns || '').startsWith('pc-'));
  // The player window is visible during runs: physical mouse activity on
  // the desktop can keep the replica alive (or add trusted noise). The
  // force-show probes only hold when the replica actually hid.
  const replicaNoise = (plog.replicaMovementLog || '').includes('T:');
  expectTruthy('player: replica probe unpolluted or hid as expected',
    replicaNoise || plog.replicaHidIdle === true);
  expectTruthy('player: opacity-hidden bar force-shows on player input',
    replicaNoise || plog.barForceShown === true);
  expectTruthy('player: pinned bar releases after grace',
    replicaNoise || plog.barReleasedAfterGrace === true);
  expectTruthy('player: idle wake re-takes a live control', plog.focusAfterIdleWake !== 'none');
  expectTruthy('player: injected wake resets the movement-required idle timer',
    plog.replicaState1?.shown === true || plog.replicaState2?.shown === true);
  expectTruthy('player: container fullscreen activates', plog.fullscreenAttempt === 'ok');
  expectTruthy('player: fullscreen subtree is the player shell',
    plog.fullscreenElementInFs === 'player-shell');
  expectTruthy('player: nav works inside fullscreen', plog.navInFullscreen);
  expectTruthy('player: ring re-parents into the fullscreen element',
    plog.ringParentInFullscreen === 'player-shell' && plog.ringVisibleInFullscreen === '1');
  expectTruthy('player: nav keeps moving inside fullscreen', plog.navMovesInFullscreen);
  expectTruthy('player: fullscreen exits cleanly', plog.fullscreenExit === 'ok');
  expectTruthy('player: ring returns to body after fullscreen exit',
    plog.ringParentAfterExit === 'body');
  expectTruthy('player: trusted keys delivered before fullscreen', trustedBeforeFs.includes('m'));
  expectTruthy('player: trusted keys delivered after fullscreen cycle', trustedAfterFs.includes('m'));
  expect('player: activate clicks the focused control (skip)', plog.clicks, 'skip');
  expectTruthy('player: activation pulse fired', plog.pulseCount >= 1);
  expect('player: activate then toggles playback (Space)', plog.keysAfterToggle, 'ArrowRight, ');
  expect('player: fullscreen toggles with f', plog.keysAfterFullscreen, 'ArrowRight, ,f');
  expectTruthy('player: triggers move the video element volume', Math.abs((plog.videoVolume ?? 0) - 0.6) < 1e-9);
  expectTruthy('player: seek + volume feedback toasts shown',
    plog.feedbackSeen.includes('⏪ 10 s') && plog.feedbackSeen.includes('Volume 60%'));
  expectTruthy('player: playback falls back to the video element', plog.playbackFallbackFeedback);
  expectTruthy('player: remote media key toggles playback', plog.remotePlayFeedback);
  expectTruthy('player: remote volume key steps the video element',
    Math.abs((plog.remoteVolume ?? 0) - 0.7) < 1e-9);
  await player.close();

  server.close();
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
  app.exit(failures === 0 ? 0 : 1);
});