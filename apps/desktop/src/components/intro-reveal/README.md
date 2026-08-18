# Intro reveal

The first-run (and replayable) onboarding sequence for Hermes Desktop — a
full-screen product story in dark mode: an idealized chat demos a real request
(typed prompt → a detached Blender-style viewport node wires in, a cube cycling
materials → tool activity with scramble-decode statuses → streaming reply),
widens into a constellation of parallel agents, and closes on the brand under
an Apple-style spotlight, all over a frosted takeover of the user's desktop.

Ship-gated: the whole feature (autoplay, About replay row, overlay) exists only
in builds baked with `VITE_INTRO_REVEAL=1`. Flagged builds also get the dev
scrubber (bottom timeline: beat ticks, click/drag to seek, space to pause).

## Where things live

| Piece | Path |
| --- | --- |
| Timeline (beats, curves, schedules — retime everything here) | `timeline.ts` |
| Full-screen surface (the whole visual) | `intro-reveal-surface.tsx` |
| Overlay-window boot (`?win=intro`) | `intro-root.tsx` |
| Main-window conductor + inline fallback | `intro-reveal-overlay.tsx` |
| First-run/replay gate | `index.tsx` |
| Synth sound bed (no audio assets) | `sound.ts` |
| Store (state machine, seen-key, IPC bridge) | `../../store/intro-reveal.ts` |
| Native window + frost + watchdog | `../../../electron/main.ts` ("Intro reveal" section) |
| Preload bridge | `../../../electron/preload.ts` (`introReveal`) |

## Architecture

The sequence plays in a dedicated transparent, always-on-top BrowserWindow
covering the primary display (`?win=intro`), so it composites over the real
desktop. Native NSVisualEffectView vibrancy (`hud` material — dark, matching
the sequence) provides the frosted glass — CSS backdrop-filter cannot reach
behind a transparent window. On close the window parks on `about:blank`
instead of being destroyed, so replays start warm.

The overlay window owns the clock (one rAF loop): the main window's rAF is
throttled while fully occluded, so no timing can live there. Typing cadence,
tool-row flips, and reply streaming are precomputed deterministic schedules —
every run is identical, and all motion is transform/opacity on smoothstep
curves (no physics, no linear ramps).

## Safety contract

The screen must ALWAYS come back. Four independent layers:

1. Normal completion: the overlay clock finishes → main renderer closes it.
2. Esc/click: local close with a 1.2s fallback that bypasses the main renderer.
3. Local deadman: the overlay force-closes itself `INTRO_DEADMAN_MS` after
   mount, even with all IPC dead.
4. Main-process watchdog (30s) destroys the window unconditionally.

All four were verified live over CDP (normal ~19s, Esc 1.0s).

## Run it

```bash
npm install                      # repo root
cd apps/desktop
npx vite --host 127.0.0.1 --port 5175 &          # renderer
npx tsc --build tsconfig.electron.json && node scripts/bundle-electron-main.mjs --dev
HERMES_DESKTOP_USER_DATA_DIR=/tmp/hermes-intro-dev \
HERMES_DESKTOP_DEV_SERVER=http://127.0.0.1:5175 \
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
```

Then Settings → About → "Replay intro", or from the renderer console:

```js
const m = await import('/src/store/intro-reveal.ts'); m.replayIntroReveal()
```

Tests: `TMPDIR=/tmp npx vitest run src/components/intro-reveal src/store/intro-reveal.test.ts`
