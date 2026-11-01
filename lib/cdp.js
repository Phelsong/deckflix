'use strict';

/*
 * Shared CDP (Chrome DevTools Protocol) session helpers — main process.
 *
 * Several features share ONE debugger attachment per webContents
 * (lib/wake.js injects input, lib/mediaInfo.js reads the Media domain);
 * subscribe(wc, handler) fans protocol messages out to them.
 */

const states = new WeakMap();

function bind(wc, wcDebugger) {
  const dbg = wcDebugger || wc.debugger;
  let state = states.get(wc);
  if (!state) {
    state = { handlers: [], domains: {} };
    states.set(wc, state);
    dbg.on('message', (_event, method, params) => {
      for (const handler of state.handlers) handler(method, params);
    });
    dbg.on('detach', () => {
      // Domains revert to disabled on detach; handlers stay registered and
      // will be reused after the next attach.
      state.domains = {};
    });
  }
  return state;
}

async function ensureAttached(wc) {
  const dbg = wc.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  return bind(wc, dbg);
}

function subscribe(wc, handler) {
  const state = bind(wc);
  state.handlers.push(handler);
}

function send(wc, method, params) {
  return wc.debugger.sendCommand(method, params);
}

async function ensureDomain(wc, domain) {
  const state = await ensureAttached(wc);
  if (state.domains[domain]) return;
  await send(wc, `${domain}.enable`);
  state.domains[domain] = true;
}

module.exports = { ensureAttached, subscribe, ensureDomain, send };