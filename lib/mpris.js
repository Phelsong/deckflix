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
 * Pure-JS via dbus-native (no native bindings, so it plays nicely with the
 * castlabs Electron build and the flatpak node_modules copy). If no
 * session bus is reachable, setup fails soft: the app runs fine without it.
 */

const dbus = require('dbus-native');
const { Variant, defineInterface } = dbus;

const BUS_NAME = 'org.mpris.MediaPlayer2.deckflix';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const TIMEOUT_MS = 5000;
const TRACK_ID = '/org/mpris/MediaPlayer2/deckflix';

const IDLE_STATUS = Object.freeze({
  mode: 'browse', playing: false, volume: null,
  positionUs: 0, durationUs: 0, title: '', url: '',
});

/* ------------------------------------------------------------------ */
/* Interface definitions                                               */
/* ------------------------------------------------------------------ */

/**
 * Build both MPRIS interfaces against a `status` holder that reportStatus()
 * keeps current. Property accessors pull from it, so D-Bus reads always see
 * the latest reported state without re-exporting anything.
 */
function buildInterfaces(handlers, status) {
  const root = defineInterface({
    name: 'org.mpris.MediaPlayer2',
    methods: {
      Raise: { in: {}, out: {}, handler: () => handlers.onRaise() },
      Quit: { in: {}, out: {}, handler: () => handlers.onQuit() },
    },
    properties: {
      CanQuit: { type: 'b', access: 'read', value: true },
      CanRaise: { type: 'b', access: 'read', value: true },
      HasTrackList: { type: 'b', access: 'read', value: false },
      Identity: { type: 's', access: 'read', value: 'Netflix (DeckFlix)' },
      DesktopEntry: { type: 's', access: 'read', value: 'com.deckflix.DeckFlix' },
      SupportedUriSchemes: { type: 'as', access: 'read', value: ['http', 'https'] },
      SupportedMimeTypes: { type: 'as', access: 'read', value: ['audio/mpegurl'] },
    },
  });

  const player = defineInterface({
    name: PLAYER_IFACE,
    methods: {
      /* Command flow. Seek is relative, microseconds. */
      Play: { in: {}, out: {}, handler: () => handlers.onCommand('play') },
      Pause: { in: {}, out: {}, handler: () => handlers.onCommand('pause') },
      PlayPause: { in: {}, out: {}, handler: () => handlers.onCommand('playpause') },
      Stop: { in: {}, out: {}, handler: () => handlers.onCommand('stop') },
      Seek: {
        in: { step: 'x' },
        out: {},
        handler: ({ step }) => handlers.onCommand('seek', step > 0 ? 10 : -10),
      },
      /* Absolute positioning isn't mapped; Netflix steps in 10 s via Seek. */
      SetPosition: { in: { trackId: 'o', positionUs: 'x' }, out: {}, handler: () => {} },
      /* Single-site app: no URI opening. */
      OpenUri: { in: { uri: 's' }, out: {}, handler: () => {} },
    },
    properties: {
      PlaybackStatus: {
        type: 's',
        access: 'read',
        get: () => status.mode === 'player' && status.playing ? 'Playing' : 'Paused',
      },
      Rate: { type: 'd', access: 'read', value: 1.0 },
      LoopStatus: { type: 's', access: 'read', value: 'None' },
      Shuffle: { type: 'b', access: 'read', value: false },
      Volume: {
        type: 'd',
        access: 'readwrite',
        get: () => status.volume == null ? 1.0 : status.volume,
        set: (value) => {
          if (Number.isFinite(value)) handlers.onCommand('volume-absolute', value);
        },
      },
      Metadata: {
        type: 'a{sv}',
        access: 'read',
        get: () => {
          const lengthUs = Math.round(status.durationUs);
          const meta = {
            'mpris:trackid': new Variant('o', TRACK_ID),
            'xesam:url': new Variant('s', status.url),
            'xesam:title': new Variant('s', status.title),
          };
          if (lengthUs > 0) meta['mpris:length'] = new Variant('x', lengthUs);
          return meta;
        },
      },
      Position: { type: 'x', access: 'read', get: () => Math.round(status.positionUs) },
      CanControl: { type: 'b', access: 'read', value: true },
      CanPlay: { type: 'b', access: 'read', value: true },
      CanPause: { type: 'b', access: 'read', value: true },
      CanSeek: { type: 'b', access: 'read', value: true },
      CanGoNext: { type: 'b', access: 'read', value: false },
      CanGoPrevious: { type: 'b', access: 'read', value: false },
    },
  });

  return { root, player };
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
  // Properties pull from the latest reported status via this holder.
  const status = { ...IDLE_STATUS };
  let bus = null;
  // Client-visible values broadcast last, so reportStatus() can diff.
  let lastEmitted = { PlaybackStatus: 'Paused', Volume: 1.0, title: '', durationUs: 0 };

  try {
    bus = dbus.sessionBus();
    // Media controls are optional: a dying bus must never crash the app.
    bus.connection.on('error', (err) => {
      console.warn('[deckflix] MPRIS bus error:', err.message || err);
    });

    const { root, player } = buildInterfaces(handlers, status);
    bus.exportInterface(root.impl, OBJECT_PATH, root.descriptor);
    bus.exportInterface(player.impl, OBJECT_PATH, player.descriptor);

    // Resolves to daemon reply code: 1 primary owner, 2 queued, 3 taken, 4 ours.
    const result = await Promise.race([
      bus.requestName(BUS_NAME, 0),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('bus name request timeout')), TIMEOUT_MS)),
    ]);
    if (result !== 1) {
      console.warn('[deckflix] MPRIS bus name not acquired (code %d);', result,
        'another player may already own it — continuing anyway');
    }
  } catch (err) {
    console.warn('[deckflix] MPRIS unavailable (continuing without media controls):',
      err.message || err);
    return null;
  }

  // Broadcast only when a client-visible property actually changed; skip
  // high-frequency fields (Position) — clients read it on demand.
  return function reportStatus(next) {
    const meta = () => ({
      'mpris:trackid': new Variant('o', TRACK_ID),
      'xesam:url': new Variant('s', status.url),
      'xesam:title': new Variant('s', status.title),
      ...(Math.round(status.durationUs) > 0 && {
        'mpris:length': new Variant('x', Math.round(status.durationUs)),
      }),
    });
    const playback = () =>
      status.mode === 'player' && status.playing ? 'Playing' : 'Paused';
    const volume = () => status.volume == null ? 1.0 : status.volume;

    Object.assign(status, next);

    const changed = {};
    if (lastEmitted.PlaybackStatus !== playback()) changed.PlaybackStatus = playback();
    if (lastEmitted.Volume !== volume()) changed.Volume = volume();
    if (lastEmitted.title !== next.title || lastEmitted.durationUs !== next.durationUs) {
      changed.Metadata = meta();
    }
    if (Object.keys(changed).length === 0) return;

    lastEmitted = {
      PlaybackStatus: changed.PlaybackStatus ?? lastEmitted.PlaybackStatus,
      Volume: changed.Volume ?? lastEmitted.Volume,
      title: next.title,
      durationUs: next.durationUs,
    };
    try {
      bus.emitPropertiesChanged(OBJECT_PATH, PLAYER_IFACE, changed);
    } catch (err) {
      console.warn('[deckflix] MPRIS PropertiesChanged error:', err.message || err);
    }
  };
}

module.exports = { startMPRIS, IDLE_STATUS };