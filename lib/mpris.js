'use strict';

/*
 * MPRIS D-Bus integration (main process).
 *
 * Exposes DeckFlix as org.mpris.MediaPlayer2.deckflix so the GNOME/KDE
 * media controls widgets and laptop media keys can play/pause/seek in
 * the Netflix player. Command flow:
 *
 *   D-Bus (PlayPause/Seek/…) → onCommand() → main.js → IPC 'deckflix-mpris'
 *     → preload forwards as page `deckflix-mpris` event → lib/spatial.js
 *
 * Status flows back: renderer → IPC 'deckflix:status' → main.js calls
 * reportStatus() which emits PropertiesChanged to the bus on relevant
 * diffs (PlaybackStatus / Volume / Metadata).
 *
 * Pure-JS via dbus-next (no native bindings, so it plays nicely with the
 * castlabs Electron build and the flatpak node_modules copy). If no
 * session bus is reachable, setup fails soft: the app runs fine without it.
 */

const dbus = require('dbus-next');
const {
  Interface, ACCESS_READ, ACCESS_READWRITE,
} = dbus.interface;

const BUS_NAME = 'org.mpris.MediaPlayer2.deckflix';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const TIMEOUT_MS = 5000;

const IDLE_STATUS = Object.freeze({
  mode: 'browse', playing: false, volume: null,
  positionUs: 0, durationUs: 0, title: '', url: '',
});

/* ------------------------------------------------------------------ */
/* Interface classes                                                   */
/* ------------------------------------------------------------------ */

class RootInterface extends Interface {
  constructor(handlers, status) {
    super('org.mpris.MediaPlayer2');
    this.handlers = handlers;
    this.status = status;
  }

  Raise() { this.handlers.onRaise(); }
  Quit() { this.handlers.onQuit(); }
}
RootInterface.configureMembers({
  methods: {
    Raise: { inSignature: '', outSignature: '' },
    Quit: { inSignature: '', outSignature: '' },
  },
  properties: {
    CanQuit: { signature: 'b', access: ACCESS_READ },
    CanRaise: { signature: 'b', access: ACCESS_READ },
    HasTrackList: { signature: 'b', access: ACCESS_READ },
    Identity: { signature: 's', access: ACCESS_READ },
    DesktopEntry: { signature: 's', access: ACCESS_READ },
    SupportedUriSchemes: { signature: 'as', access: ACCESS_READ },
    SupportedMimeTypes: { signature: 'as', access: ACCESS_READ },
  },
});

class PlayerInterface extends Interface {
  constructor(handlers, status) {
    super('org.mpris.MediaPlayer2.Player');
    this.handlers = handlers;
    this.status = status;
  }

  /* Methods (command flow). Seek is relative, microseconds. */
  Play() { this.handlers.onCommand('play'); }
  Pause() { this.handlers.onCommand('pause'); }
  PlayPause() { this.handlers.onCommand('playpause'); }
  Stop() { this.handlers.onCommand('stop'); }
  Seek(x) { this.handlers.onCommand('seek', x > 0 ? 10 : -10); }
  SetPosition() {} // absolute positioning isn't mapped; Netflix steps in 10 s
  OpenUri() {} // single-site app: no URI opening

  /* Property getters (status flow). Standard accessors (iface[name]). */
  get PlaybackStatus() {
    return this.status.mode === 'player' && this.status.playing ? 'Playing' : 'Paused';
  }
  get Rate() { return 1.0; }
  get LoopStatus() { return 'None'; }
  get Shuffle() { return false; }
  get Volume() { return this.status.volume == null ? 1.0 : this.status.volume; }
  set Volume(value) {
    if (Number.isFinite(value)) this.handlers.onCommand('volume-absolute', value);
  }
  get Metadata() {
    const lengthUs = Math.round(this.status.durationUs);
    const meta = {
      'mpris:trackid': new (dbus.Variant)('o', '/org/mpris/MediaPlayer2/deckflix'),
      'xesam:url': new (dbus.Variant)('s', this.status.url),
      'xesam:title': new (dbus.Variant)('s', this.status.title),
    };
    if (lengthUs > 0) meta['mpris:length'] = new (dbus.Variant)('x', lengthUs);
    return meta;
  }
  get Position() { return Math.round(this.status.positionUs); }
}

PlayerInterface.configureMembers({
  methods: {
    Play: { inSignature: '', outSignature: '' },
    Pause: { inSignature: '', outSignature: '' },
    PlayPause: { inSignature: '', outSignature: '' },
    Stop: { inSignature: '', outSignature: '' },
    Seek: { inSignature: 'x', outSignature: '' },
    SetPosition: { inSignature: 'ox', outSignature: '' },
    OpenUri: { inSignature: 's', outSignature: '' },
  },
  properties: {
    PlaybackStatus: { signature: 's', access: ACCESS_READ },
    Rate: { signature: 'd', access: ACCESS_READ },
    LoopStatus: { signature: 's', access: ACCESS_READ },
    Shuffle: { signature: 'b', access: ACCESS_READ },
    Volume: { signature: 'd', access: ACCESS_READWRITE },
    Metadata: { signature: 'a{sv}', access: ACCESS_READ },
    Position: { signature: 'x', access: ACCESS_READ },
    CanControl: { signature: 'b', access: ACCESS_READ },
    CanPlay: { signature: 'b', access: ACCESS_READ },
    CanPause: { signature: 'b', access: ACCESS_READ },
    CanSeek: { signature: 'b', access: ACCESS_READ },
    CanGoNext: { signature: 'b', access: ACCESS_READ },
    CanGoPrevious: { signature: 'b', access: ACCESS_READ },
  },
});

/* Simple boolean/constant property getters (same value every poll). */
const ROOT_CONSTANTS = {
  CanQuit: true, CanRaise: true, HasTrackList: false,
  Identity: 'Netflix (DeckFlix)', DesktopEntry: 'com.deckflix.DeckFlix',
  SupportedUriSchemes: ['http', 'https'],
  SupportedMimeTypes: ['audio/mpegurl'],
};
const PLAYER_CONSTANTS = {
  CanControl: true, CanPlay: true, CanPause: true, CanSeek: true,
  CanGoNext: false, CanGoPrevious: false,
};
for (const [klass, props] of [[RootInterface, ROOT_CONSTANTS], [PlayerInterface, PLAYER_CONSTANTS]]) {
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(klass.prototype, k, { get: () => v });
  }
}

/* ------------------------------------------------------------------ */
/* Startup + status reporting                                          */
/* ------------------------------------------------------------------ */

/**
 * Bring up MPRIS. Resolves to a report function or null when the session
 * bus is unavailable; never throws (soft-fail by design).
 *
 * @param {object} handlers { onCommand(command, arg), onRaise(), onQuit() }
 * @returns {Promise<((status: object) => void) | null>}
 */
async function startMPRIS(handlers) {
  // Properties pull from the latest reported status via these holders.
  const status = { ...IDLE_STATUS };
  let rootIface = null;
  let playerIface = null;
  let lastEmitted = {}; // keys whose changes we re-broadcast

  try {
    const bus = dbus.sessionBus();
    rootIface = new RootInterface(handlers, status);
    playerIface = new PlayerInterface(handlers, status);
    bus.export(OBJECT_PATH, rootIface);
    bus.export(OBJECT_PATH, playerIface);
    await Promise.race([
      bus.requestName(BUS_NAME),
      new Promise((_, reject) => setTimeout(() => reject(new Error('bus name request timeout')), TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.warn('[deckflix] MPRIS unavailable (continuing without media controls):', err.message || err);
    return null;
  }

  const playerPropsChanged = () => Interface.emitPropertiesChanged(playerIface, {
    PlaybackStatus: playerIface.PlaybackStatus,
  });

  return function reportStatus(next) {
    Object.assign(status, next);
    // Broadcast only when a client-visible property actually changed; skip
    // high-frequency fields (Position) — clients read it on demand.
    const relevant = {
      PlaybackStatus: playerIface.PlaybackStatus,
      Volume: playerIface.Volume,
      title: next.title,
    };
    if (
      lastEmitted.PlaybackStatus !== relevant.PlaybackStatus ||
      lastEmitted.Volume !== relevant.Volume ||
      lastEmitted.title !== relevant.title
    ) {
      lastEmitted = relevant;
      try {
        playerPropsChanged();
      } catch (err) {
        console.warn('[deckflix] MPRIS PropertiesChanged error:', err.message || err);
      }
    }
  };
}

module.exports = { startMPRIS, IDLE_STATUS };