'use strict';

/*
 * DeckFlix — minimal wrapper around netflix.com for Linux desktop / Steam Deck.
 *
 * The main process owns the window and persistent session only. All
 * navigation and input logic lives in the renderer (preload.js and lib/).
 * The only main-process concern specific to Netflix is Widevine: the
 * castlabs build provides a `components` API that installs the CDM on
 * first launch; we must wait for it before opening a window.
 */

const path = require('path');
const { app, BrowserWindow, session, shell, components, ipcMain } = require('electron');
const { startMPRIS, IDLE_STATUS } = require('./lib/mpris');

const START_URL = 'https://www.netflix.com';
const PARTITION = 'persist:deckflix';

app.setName('DeckFlix');

// Netflix gates on user agent in places. The castlabs UA is
// Chromium-based and accepted; allow an override for troubleshooting.
const USER_AGENT = process.env.DECKFLIX_UA || null;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Latest playback state reported by the renderer (drives MPRIS properties).
let playerStatus = { ...IDLE_STATUS };
// The focused window lives here so MPRIS commands can be forwarded from
// anywhere in this file's lifetime.
let activeWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 960,
    minHeight: 540,
    backgroundColor: '#000000',
    show: false,
    autoHideMenuBar: true,
    title: 'DeckFlix',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: PARTITION, // persistent Netflix login
      // SECURITY: the renderer loads untrusted content (netflix.com). With
      // contextIsolation on, our lib (preload world, isolated) still sees
      // the shared DOM/events/storage it needs, but the page has NO path
      // to Electron or Node APIs (no require, no process, no bridge).
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:false keeps a scoped node prelude for our preload only
      // (require('./lib/*') + ipcRenderer); the page stays unprivileged.
      sandbox: false,
      backgroundThrottling: false, // keep gamepad polling alive when unfocused
      spellcheck: false,
    },
  });

  const ses = win.webContents.session;
  if (USER_AGENT) {
    ses.setUserAgent(USER_AGENT);
  }

// Never spawn child browser windows; anything off netflix.com goes to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(START_URL)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // SECURITY: minimal permission surface — Netflix needs fullscreen,
  // media playback and the Widevine key system; geolocation, camera,
  // microphone, notifications and friends are denied outright.
  const s = win.webContents.session;
  s.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['fullscreen', 'media', 'mediaKeySystem'];
    callback(allowed.includes(permission));
  });

  win.on('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (activeWindow === win) activeWindow = null;
  });
  activeWindow = win;
  watchFullscreenTransitions(win);
  win.loadURL(START_URL);
  return win;
}

/*
 * Renderer → main playback status (see lib/spatial.js collectStatus).
 * Stashes it for MPRIS properties and pushes diffs onto the bus.
 */
let reportMPRISStatus = null;

ipcMain.on('deckflix:status', (_event, status) => {
  if (status && typeof status === 'object') {
    playerStatus = status;
    if (reportMPRISStatus) reportMPRISStatus(status);
  }
});

// Overlay-menu app actions (quit, window fullscreen, zoom).
ipcMain.on('deckflix:app-action', (_event, action, arg) => {
  switch (action) {
    case 'quit':
      app.quit();
      break;
    case 'fullscreen':
      if (activeWindow && !activeWindow.isDestroyed()) {
        activeWindow.setFullScreen(!activeWindow.isFullScreen());
      }
      break;
    case 'zoom':
      applyZoomFactor(Number(arg));
      break;
    default:
      break;
  }
});

/* Zoom lives on the webContents: consistent hit-testing/layout, unlike CSS
 * zoom on the page. The renderer persists the factor and re-applies on boot. */
function applyZoomFactor(factor) {
  if (!activeWindow || activeWindow.isDestroyed()) return;
  if (Number.isFinite(factor) && factor >= 0.5 && factor <= 2) {
    activeWindow.webContents.setZoomFactor(factor);
  }
}

/*
 * Trusted mouse nudge for the player control bar. The renderer sends
 * CSS-viewport coordinates; Chromium's input pipeline wants window DIPs,
 * so scale by the page zoom (Netflix UI zoom from the menu changes it).
 * Implementation + IPC channel live in lib/wake.js.
 */
require('./lib/wake').installPlayerWakeIpc(() => activeWindow);
require('./lib/mediaInfo').installMediaInfoIpc(() => activeWindow);
// Track fullscreen transitions so the wake injector can go dormant while
// the input pipeline is in a fragile state (see lib/wake.js).
function watchFullscreenTransitions(win) {
  win.webContents.on('enter-html-full-screen', () =>
    require('./lib/wake').markFullscreenTransition());
  win.webContents.on('leave-html-full-screen', () =>
    require('./lib/wake').markFullscreenTransition());
}

function initMPRIS() {
  startMPRIS({
    getStatus: () => playerStatus,
    onCommand: (command, arg) => {
      if (activeWindow && !activeWindow.isDestroyed()) {
        activeWindow.webContents.send('deckflix-mpris', { command, arg });
      }
    },
    onRaise: () => {
      if (activeWindow && !activeWindow.isDestroyed()) {
        activeWindow.show();
        activeWindow.focus();
      }
    },
    onQuit: () => app.quit(),
  })
    .then((report) => {
      reportMPRISStatus = report;
      if (report) console.log('[deckflix] mpris available as', 'org.mpris.MediaPlayer2.deckflix');
      reportMPRISStatus?.(playerStatus); // publish initial state
    })
    .catch((err) => {
      console.warn('[deckflix] mpris setup failed (non-fatal):', err?.message || err);
    });
}

app.whenReady().then(async () => {
  if (components) {
    // castlabs ECS: installs/updates the Widevine CDM on first launch.
    await components.whenReady();
    console.log('[deckflix] widevine components ready:', components.status());
  } else {
    console.warn('[deckflix] no components API — running stock Electron, DRM playback will NOT work.');
  }
  createWindow();
  initMPRIS();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());