'use strict';

/*
 * Media pipeline introspection (main process).
 *
 * Uses the CDP Media domain (what chrome://media-internals shows) to
 * surface per-player pipeline properties — video/audio codec and decoder
 * names, DRM streams included (the pipeline is still visible). The
 * Player Stats modal reads the digest over IPC.
 *
 * Protocol: Media.enable once per debugger session; Media
 * .playerPropertiesChanged events are folded into a cache keyed by
 * playerId; the digest picks the most recently updated player and
 * extracts codec/decoder names by key pattern.
 */

const { ipcMain } = require('electron');
const cdp = require('./cdp');

const watchers = new WeakMap(); // wc -> subscriber installed
const caches = new WeakMap();   // wc -> { [playerId]: { map, updatedAt } }

function watch(wc) {
  if (watchers.get(wc)) return;
  watchers.set(wc, true);
  caches.set(wc, {});
  cdp.subscribe(wc, (method, params) => {
    if (method !== 'Media.playerPropertiesChanged') return;
    const map = {};
    for (const prop of params?.properties || []) {
      map[prop.name] = String(prop.value);
    }
    const cache = caches.get(wc) || {};
    cache[params.playerId] = { map, updatedAt: Date.now() };
    caches.set(wc, cache);
  });
}

// Digest: newest player's properties, codec/decoder fields by pattern.
function digest(cache) {
  let bestMap = null;
  let bestAt = -1;
  for (const entry of Object.values(cache || {})) {
    if (entry.updatedAt > bestAt) {
      bestMap = entry.map;
      bestAt = entry.updatedAt;
    }
  }
  const out = {
    videoCodec: null,
    videoDecoder: null,
    audioCodec: null,
    audioDecoder: null,
  };
  if (!bestMap) return out;
  for (const [key, value] of Object.entries(bestMap)) {
    const k = key.toLowerCase();
    if (out.videoCodec == null && k.includes('video') && k.includes('codec')) {
      out.videoCodec = value;
    } else if (out.videoDecoder == null && k.includes('video') && k.includes('decoder')) {
      out.videoDecoder = value;
    } else if (out.audioCodec == null && k.includes('audio') && k.includes('codec')) {
      out.audioCodec = value;
    } else if (out.audioDecoder == null && k.includes('audio') && k.includes('decoder')) {
      out.audioDecoder = value;
    }
  }
  return out;
}

/**
 * Response handler for the renderer's deckflix:media-info invoke: makes
 * sure the Media domain is enabled for the focused window and returns
 * the cached digest (may be empty until pipeline events arrive).
 */
async function mediaInfoFor(getWindow) {
  const win = getWindow();
  if (!win || win.isDestroyed()) return {};
  try {
    const wc = win.webContents;
    watch(wc);
    await cdp.ensureDomain(wc, 'Media');
    return digest(caches.get(wc));
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}

function installMediaInfoIpc(getWindow) {
  ipcMain.handle('deckflix:media-info', () => mediaInfoFor(getWindow));
}

module.exports = { installMediaInfoIpc };