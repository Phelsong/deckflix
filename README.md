# DeckFlix

A minimal Linux desktop wrapper around **netflix.com** built for handheld or big
screen: This uses the basic Netflix web app with no modifications or added telemetry, with a
**full custom spatial navigator** layered on top so the entire UI can be
driven with a game controller, Steam Deck, or TV remote.

## Tldr

- Uses Electron + Widevine, so content availability is limited to what is allowed thru that pipeline (currently <=1080p SDR)
- Minimal Dependencies and Vanilla JS, you could read all the source code in 10-15min
- Provides intuitive core UI navigation via gamepad/remote
- Default controls don't overlap with Steam/Plasma BigScreen
- Hooks into mpris
- Flatpak


## How it works

Most aftermarket TV remotes enumerate as keyboards, so lib/remote.js maps the
common remote keysym vocabulary onto the same semantic bus the gamepad
uses — gamepad, remote, and MPRIS commands all funnel through one
router.

- The wrapper does **not** reimplement Netflix — every pixel you see is
  the real site. The app only moves focus, clicks things, and (in the
  player) synthesizes keyboard shortcuts.
- **DRM**: the app uses [castlabs Electron for Content
  Security](https://github.com/castlabs/electron-releases) (
  `v44.9.3+wvcus`) for dev. The Widevine CDM self-installs on first launch via
  the `components` API. Flatpak uses the provided Electron package.
- **Focus** is fully app-owned: a fixed-position ring (`.deckflix-focus-ring`)
  follows our spatial engine's target; movement uses a sweep-beam scorer
  (progress along the pressed axis + lateral-alignment penalty).
- **MPRIS**: the app owns `org.mpris.MediaPlayer2.deckflix` on the D-Bus
  session bus. Media keys and the GNOME/KDE media controls widgets can
  play/pause and seek (commands flow into the renderer over IPC), and
  playback status/title/volume flow back out so desktop widgets show the
  real state. Ignored if no session bus is reachable.
- **Feedback HUD** (lib/hud.js): seek/volume/play-pause confirmations
  surface as auto-fading toasts, and activations fire a click-pulse over
  the focused element — feedback a TV viewer can see from the couch.
- **Player**: sticks/d-pad now navigate the visible player controls
  spatially (control bar, skip-intro/credits, next-episode), with the
  focus ring visible — A activates the focused control, or toggles
  play/pause when nothing is focused. The player synthesizes hover so
  Netflix keeps the control bar open while you navigate, independent of
  the Hover Previews setting, and every player input re-synthesizes a
  mouse nudge that resets Netflix's autohide timer; when the bar does
  hide, stale focus on bar controls is dropped so the next press wakes
  the bar and re-takes onto live controls instead of ghost-targeting.
- **DeckFlix menu** (lib/menu.js): hold Back (~0.7 s) or press Start for
  an in-app overlay menu with real buttons — Go to Home, Reload,
  Toggle Window Fullscreen, Control Guide, the Hover Previews setting,
  **Zoom − / 100% / ＋** (50%–200%, persisted, live % readout — the
  value itself is an inert navigable item: you step left/right onto the
  −/+ buttons), **Player Stats** (live playback / resolution /
  color-space readout), and Quit DeckFlix. It navigates with the same
  spatial engine, and while open, pressing B closes it instead of going
  back in history.
- **Hover previews** (setting): leaving a focused card dispatches a real
  mouse-out so Netflix cancels its pending hover-preview pop-up, and
  synthetic hover defaults **off** — walking rows no longer opens the
  preview modal. If you like the previews, flip Hover Previews to On in
  the menu; activation never depends on hover either way.
- **Analog scroll**: the right stick scrolls pages with a quadratic
  velocity ramp (feathered near the deadzone, ~1400 px/s at full
  deflection). Left-stick nav auto-repeat accelerates with deflection
  (130 ms → 65 ms cadence). Scrollbars are hidden page-wide — the
  10-foot UI scrolls, it just doesn't show the scrollbar.
- **Control guide**: gamepad X opens an in-page overlay listing the
  active mapping, labelled for the connected pad family (Xbox /
  PlayStation / generic). While open it swallows input; B/X close it.
- **Player Stats** (lib/stats.js): menu → Player Stats opens a live
  overlay of the media pipeline: playback state, position/duration,
  volume, stream resolution, on-screen display size, color space
  (primaries · transfer · matrix · range), total/dropped frame counts,
  measured **frame rate** (`getVideoPlaybackQuality` deltas at the 1 s
  refresh), UI zoom, Widevine availability, plus a `Bar hider`
  diagnostic row. Refreshes every second; B closes it.
- **Fullscreen-safe overlays** (lib/fullscreen.js): when the player goes
  fullscreen (gamepad Y) it enters the browser's top layer and would
  bury everything outside its subtree — the focus ring, toasts, guide,
  menu and stats are re-parented into the fullscreen element while it
  exists (media elements are skipped — their children render as
  fallback content), and DOM focus is parked inside the top layer so
  keyboard delivery survives the transition.
- **Player bar vs autohide** (lib/spatial.js, lib/wake.js): every player
  input injects a fake **trusted** mouse move (3-event burst with ±1 px
  jitter around the video's neutral center — real movement deltas for
  movement checks, but the real pointer can never drift onto
  hover-sensitive UI; delivered via Chrome DevTools Protocol
  `Input.dispatchMouseEvent` since `sendInputEvent` mouse moves are a
  silent no-op in the castlabs build), so Netflix's mouse-activity idle
  timer resets and the bar un-hides like it would for a physical mouse.
  The injector goes dormant ~1 s around every fullscreen transition
  (injected events racing those transitions once froze all trusted
  input); during that window — and for timers that ignore injected
  motion — stale focus triggers an inline force-show that pins the bar
  through the focused control's ancestor chain (~4.5 s grace, extended
  while navigating, released when idle).
- **Popup/modality safety**: candidates hidden behind modal backdrops,
  drawers, or hover panels are filtered by centre-point hit-testing
  (`elementsFromPoint` occlusion checks), so pressing a direction inside a
  popup never moves the buried base layer, and the first press when a
  popup opens re-takes focus on the popup itself. A MutationObserver
  recovers focus when the layer under it opens/closes (childList /
  style / class churn, debounced).
- **SPA-aware**: Netflix's route changes are watched and focus is
  re-established near the viewport centre after navigation.

## Run it

```bash
npm install
npm start
```

First launch downloads the Widevine CDM (watch the log for
`widevine components ready`). Log in once — cookies persist in the
`persist:deckflix` session partition.

## Controls (standard gamepad mapping)

| Input                       | Browse                              | Player (while watching)        |
| --------------------------- | ----------------------------------- | ------------------------------ |
| D-pad / left stick          | spatial movement + scroll           | spatial movement over the player controls |
| Right stick                 | smooth omnidirectional scrolling    | —                              |
| A (south / cross)           | activate focused card               | play / pause · activate focused control |
| B (east / circle), select   | back (tap) · DeckFlix menu (hold)   | back (tap) · menu (hold)       |
| X (west / square)           | control guide overlay               | control guide overlay          |
| Y (north / triangle)        | —                                   | toggle fullscreen              |
| LB / RB                     | —                                   | seek back / forward 10 s (repeat ~0.3 s while held) |
| LT / RT                     | —                                   | volume down / up               |
| Start / menu                | DeckFlix menu                       | DeckFlix menu                  |
| Media keys / MPRIS clients  | —                                   | play / pause / stop / seek (±10 s) / volume |

### TV remotes (keyboard front-end)

Remotes that enumerate as keyboards are mapped in `lib/remote.js`; only
*trusted* keys are handled (our synthesized keys can't loop back), and
text fields are never hijacked (typing keeps arrows/Enter/Backspace for
the field; media + volume keys still work):

| Remote key                  | Action                                              |
| --------------------------- | --------------------------------------------------- |
| Arrows                      | d-pad: spatial movement (both modes)                |
| Enter (also Numpad, Space)  | OK — activate                                       |
| Esc / Backspace / BrowserBack | back                                              |
| Home                        | Netflix home (closes overlays)                      |
| Menu key (ContextMenu)      | DeckFlix menu                                       |
| Page Up / Down              | page scroll                                         |
| Media Play/Pause/Stop       | playback (player mode)                              |
| Media FF / RW / Skip / Track | seek ∓10 s (player mode)                            |
| XF86 Volume Up / Down       | volume ∓10% (player mode)                           |

Arrow auto-repeat is throttled to gamepad-like cadence (≥140 ms).
Mapped keys are consumed at the **capture phase** with
`stopImmediatePropagation`, so Netflix's own player shortcuts (arrow
seek, Space play/pause, …) never double-fire — our synthetic keys
(untrusted) still reach Netflix unimpeded.

The **DeckFlix menu** (B-hold or Start) is the controller-only way to go
Home, reload, toggle the window fullscreen, flip Hover Previews, open
the guide — or **quit the app**. `__deckflix` settings persist in
localStorage; any physical keyboard keeps working too (Netflix's native
keyboard navigation is untouched).

## Tests

Synthetic-Netflix harness (no Netflix access needed):

```bash
./node_modules/.bin/electron test/harness.js
```

76 assertions over browse movement, activation, focus ring, right-stick
scrolling, HUD feedback, the guide overlay (gamepad + remote/keyboard
columns side by side), the DeckFlix menu (including
quit wiring, the zoom stepper with its inert live readout, the
hover-preview setting, and the stats modal), player spatial navigation
over controls, bumpers/triggers remapping, volume, playback element
fallback, the player bar autohide lifecycle (opacity + display shapes,
force-show, grace release), fullscreen navigation + trusted-input
survival, and the TV-remote keyboard front-end (arrows, Enter, media
keys) — all passing at time of writing.

## Scripts

```bash
npm install   # castlabs electron + deps (once)
npm start     # run the app
npm test      # full harness: 78 assertions over browse/player/fullscreen
npm run check # syntax-check every JS file
```

## Security posture

- **Page isolation** (`contextIsolation: true`): the renderer loads
  untrusted netflix.com content; the app's lib runs in the isolated
  preload world and talks to the page only through the shared DOM, DOM
  events and origin storage — the page has no path to Electron/Node
  APIs (no `require`, no `process`, no bridge reachability).
- **Minimal permissions**: `setPermissionRequestHandler` denies
  geolocation/camera/mic/notifications; only `fullscreen`, `media`,
  `mediaKeySystem` are granted.
- **Local-only**: cookies live in the `persist:deckflix` partition;
  nothing ships off-device; no telemetry. Off-domain links open in the
  system browser.
- **CDP debugger** (`lib/wake.js`, `lib/mediaInfo.js`) attaches only to
  our own windows locally — no remote debugging port is ever opened.
- The test-mode eval runner exists **only** when `DECKFLIX_TEST=1`
  (never in packaged runs).

## Flatpak

Build with the wrapper script at the repo root (it checks prerequisites,
builds into `.flatpak-build/` — never inside the sources dir — installs
to the user repo, and exports a single-file bundle):

```bash
./build-flatpak.sh              # build + install + dist bundle
./build-flatpak.sh --run-after  # ... then launch the app
flatpak run com.deckflix.DeckFlix
```

Artifacts land in `.flatpak-build/`; the bundle is written to
`dist/com.deckflix.DeckFlix-<version>.flatpak` (~92 MB — install it on
other 26.08-runtime machines with
`flatpak install com.deckflix.DeckFlix-<version>.flatpak`). The sources
in `build/flatpak/` survive every build.

Gamepad devices require the `--device=input` finish arg (already in the
manifest) plus **`--filesystem=/run/udev:ro`** — Chromium enumerates
gamepads through udev, and without a read-only udev view `getGamepads()`
stays empty inside any flatpak (same fix Heroic/Edge/GFN-flatpaks use).
The udev database is read-only, so **plug the pad in before launching**:
hotplug events don't reach the sandbox. If a pad stops being recognized,
open **menu → Player Stats** — the `Gamepads` row shows what Chromium
actually sees. The Widevine CDM self-installs inside the sandbox on first
launch (persisted under `~/.var/app/com.deckflix.DeckFlix`). The
manifest `--own-name=`s `org.mpris.MediaPlayer2.deckflix` so media keys
and desktop media controls work inside the sandbox.

## Options & gotchas

- `DECKFLIX_UA` env var overrides the user agent if Netflix ever shows a
  "browser not supported" gate. The castlabs UA normally passes.
- **Search / profile renaming** need a physical keyboard — the gamepad
  activation focuses the field for you.
- **Player volume** walks Netflix's EME `<video>` element directly and
  shows the resulting level; if the site ever re-normalizes it, use the
  on-screen volume slider instead. Play/pause and seek go through
  synthetic keys first, with direct `<video>` element control as a
  verified fallback (the HUD confirms which state actually took).
- Linux Widevine is L3 only (no hardware-licensed path): expect ~720p
  max. That's a Netflix/Google platform limit, not an app bug.
- The castlabs CDM updates itself in the background on subsequent
  launches.
- You are still bound to the Netflix Terms of Service; DeckFlix only
  automates focus within the official web UI.

## Layout

```
main.js                 Electron main process (+ MPRIS wiring, menu actions)
preload.js              renderer bootstrap + main↔page IPC bridge
lib/input.js            gamepad → semantic input bus (scroll, repeats,
                        back-hold → menu)
lib/remote.js           TV-remote keyboard → semantic input bus
lib/spatial.js          spatial navigator + focus ring + player controls
                        nav + MPRIS command handling + status collection
lib/hud.js              action toasts + click-pulse feedback
lib/guide.js            on-screen control guide overlay (X button)
lib/menu.js             DeckFlix overlay menu + settings (previews, zoom)
lib/stats.js            player stats overlay modal (menu → Player Stats)
lib/fullscreen.js       top-layer overlay host (fullscreen-safe overlays)
lib/wake.js             main-process trusted input wake (player autohide)
lib/mpris.js            main-process org.mpris.MediaPlayer2 D-Bus service
test/page.html          synthetic Netflix-like browse DOM
test/watch.html         synthetic player page (controls bar + skip button)
test/harness.js         end-to-end assertion harness
build/flatpak/          flatpak manifest, launcher, desktop file, metainfo
assets/                 icons (SVG source + PNG rasterizations)
```