/**
 * The intro reveal surface — rendered inside the dedicated transparent
 * always-on-top window (`?win=intro`) covering the whole display.
 *
 * v4: the sequence is a product story played on an enlarged, idealized Hermes
 * chat — a request types itself, real tool activity materializes, the reply
 * streams in, the chat joins a constellation of parallel agents, then the
 * badge + wordmark close. No physics, no abstraction: every visible change is
 * a deterministic function of one clock (typing cadence, tool flips, and word
 * streaming are precomputed schedules), and all motion is transform/opacity
 * with one easing family.
 *
 * SAFETY CONTRACT (the screen must ALWAYS come back):
 *   1. Normal path: this window's clock finishes → reports done → main
 *      renderer finishes the store and closes the window.
 *   2. Local skip: Esc/click sends skip IPC AND arms a 1.2s fallback that
 *      closes this window directly if the main renderer doesn't.
 *   3. Local deadman: this window force-closes itself INTRO_DEADMAN_MS after
 *      mount, even if every IPC channel and the main renderer are dead.
 *   4. Main-process watchdog (electron/main.ts) closes it independently.
 */

import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

import { playLatch, playResolve, playSwell, playTick, startPad } from './sound'
import {
  beatsBetween,
  INTRO_BEATS,
  INTRO_DEADMAN_MS,
  INTRO_EXIT_MS,
  INTRO_PROMPT,
  INTRO_REPLY_WORDS,
  INTRO_TOOL_ROWS,
  INTRO_TOTAL_MS,
  sampleCurves,
  streamingSchedule,
  typingSchedule
} from './timeline'

const INTRO_BEAT_INDEX: Record<string, number> = Object.fromEntries(INTRO_BEATS.map((b, i) => [b.id, i]))

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

// The overlay window is gateway-less: no I18nProvider, strings inline (same
// contract as the pet overlay).
const TAGLINE = 'Your agent, everywhere'
const SKIP = 'Skip'
const SURFACES = 'Desktop · Messages · Phone · Anywhere'

// One easing family for the whole piece.
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

// Hermes blue — the app's --theme-primary (#0053fd), lifted for dark ground.
const BLUE = '#4d8dff'
const BLUE_DIM = 'rgba(77, 141, 255, 0.55)'
const BLUE_FAINT = 'rgba(77, 141, 255, 0.4)'

// One shadow for every floating surface — --shadow-nous's recipe (single top
// light, layered contact→ambient, x=0, negative spread pulling each layer
// inward) restated for a dark ground at LOW opacity, so cards sit on the
// frost instead of dragging black halos across it.
const NOUS_SHADOW =
  '0 2px 4px -2px rgba(0,0,0,0.3), 0 8px 12px -6px rgba(0,0,0,0.24), 0 20px 28px -14px rgba(0,0,0,0.2), 0 36px 48px -28px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.05)'

// Scrubber rides the same env flag as the feature: flagged builds ARE the
// iteration builds while this ships dark.
const DEV_SCRUB = import.meta.env?.VITE_INTRO_REVEAL === '1'

// Brand faces, self-hosted from public/intro-fonts (this window only — the
// app itself keeps its system stack).
const FONT_CSS = `
@font-face {
  font-family: 'Sigurd';
  src: url('${assetPath('intro-fonts/Sigurd-Variable.woff2')}') format('woff2');
  font-weight: 100 900;
  font-display: block;
}
@font-face {
  font-family: 'Rules Expanded';
  src: url('${assetPath('intro-fonts/RulesExpanded-Regular.woff2')}') format('woff2');
  font-weight: 400;
  font-display: block;
}
@font-face {
  font-family: 'Rules Expanded';
  src: url('${assetPath('intro-fonts/RulesExpanded-Bold.woff2')}') format('woff2');
  font-weight: 700;
  font-display: block;
}
@font-face {
  font-family: 'Courier Prime';
  src: url('${assetPath('intro-fonts/CourierPrime-Regular.woff2')}') format('woff2');
  font-weight: 400;
  font-display: block;
}
@keyframes intro-caret { 0%, 55% { opacity: 1 } 56%, 100% { opacity: 0 } }
@keyframes intro-dot { 0%, 100% { opacity: 0.35 } 50% { opacity: 1 } }
@keyframes intro-float-a { from { transform: translateY(-5px) } to { transform: translateY(6px) } }
@keyframes intro-float-b { from { transform: translateY(4px) } to { transform: translateY(-7px) } }
@keyframes intro-float-c { from { transform: translateY(-3px) } to { transform: translateY(5px) } }
@keyframes intro-hover-a { from { translate: 0 -4px } to { translate: 0 5px } }
@keyframes intro-hover-b { from { translate: 0 4px } to { translate: 0 -6px } }
`

// Deterministic schedules, computed once from the timeline.
const SEND_T = INTRO_BEATS.find(b => b.id === 'send')!.t
const REPLY_T = INTRO_BEATS.find(b => b.id === 'reply')!.t
const EVERYWHERE_T = INTRO_BEATS.find(b => b.id === 'everywhere')!.t
const BRAND_T = INTRO_BEATS.find(b => b.id === 'brand')!.t
const TYPE_TIMES = typingSchedule(INTRO_PROMPT, 700, SEND_T - 450)
const WORD_TIMES = streamingSchedule(INTRO_REPLY_WORDS.length, REPLY_T + 150, REPLY_T + 2400)

interface Frame {
  beat: number
  replyWords: number
  /** 45ms quantized clock — drives braille spinners + scramble decodes. */
  tick: number
  toolDone: number // bitmask
  toolShown: number // bitmask
  typed: number
}

const INITIAL_FRAME: Frame = { beat: 0, replyWords: 0, tick: 0, toolDone: 0, toolShown: 0, typed: 0 }

function frameAt(t: number, beat: number): Frame {
  let typed = 0

  while (typed < TYPE_TIMES.length && TYPE_TIMES[typed] <= t) {
    typed += 1
  }

  let replyWords = 0

  while (replyWords < WORD_TIMES.length && WORD_TIMES[replyWords] <= t) {
    replyWords += 1
  }

  let toolShown = 0
  let toolDone = 0

  for (let i = 0; i < INTRO_TOOL_ROWS.length; i += 1) {
    if (t >= INTRO_TOOL_ROWS[i].at) {
      toolShown |= 1 << i
    }

    if (t >= INTRO_TOOL_ROWS[i].doneAt) {
      toolDone |= 1 << i
    }
  }

  return { beat, replyWords, tick: Math.floor(t / 45), toolDone, toolShown, typed }
}

// ── Hacker-terminal text machinery (DecodeText's mechanics, deterministic:
//    LCG on (position, tick) instead of Math.random so every run is
//    frame-identical). ─────────────────────────────────────────────────────

const SCRAMBLE_CHARS = '/\\|-_=+<>~:*'
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const scrambleGlyph = (i: number, tick: number) => {
  const n = (i * 2654435761 + tick * 40503) >>> 0

  return SCRAMBLE_CHARS[n % SCRAMBLE_CHARS.length]
}

/** Text decoding left→right over `spanMs` since `bornAt`: unresolved tail
 *  churns scramble glyphs each tick, spaces never scramble (word shape holds). */
function decoded(text: string, bornAt: number, tick: number, spanMs = 520): string {
  const age = tick * 45 - bornAt
  const resolved = Math.max(0, Math.min(text.length, Math.ceil((age / spanMs) * text.length)))

  return Array.from(text, (ch, i) => (ch === ' ' || i < resolved ? ch : scrambleGlyph(i, tick))).join('')
}

// ── The viewport: a software-rendered cube cycling shading modes, as if a
//    Blender viewport were live in the chat. Pure canvas 2D, deterministic
//    from the sequence clock (rotation and material mode are f(t)). ────────

const VIEWPORT_MODES = ['standard', 'metal', 'glass', 'wireframe'] as const
const MODE_SPAN_MS = 2100

const viewportMode = (t: number) => Math.floor(t / MODE_SPAN_MS) % VIEWPORT_MODES.length

interface Quad {
  z: number
  pts: [number, number][]
  shade: number
}

/** Subdivided cube quads, rotated + projected. Always a true cube — the
 *  subdivision exists so per-face shading has facets to work with. */
function cubeQuads(t: number, w: number, h: number): Quad[] {
  const N = 4
  const rx = t * 0.00042
  const ry = t * 0.00071
  const cx = Math.cos(rx)
  const sx = Math.sin(rx)
  const cy = Math.cos(ry)
  const sy = Math.sin(ry)
  // Roomy: the cube never grazes the viewport frame.
  const scale = Math.min(w, h) * 0.24
  const quads: Quad[] = []

  const vert = (u: number, v: number, face: number): [number, number, number] => {
    const a = -1 + (2 * u) / N
    const b = -1 + (2 * v) / N

    const p: [number, number, number] =
      face === 0 ? [a, b, 1] : face === 1 ? [a, b, -1] : face === 2 ? [1, a, b] : face === 3 ? [-1, a, b] : face === 4 ? [a, 1, b] : [a, -1, b]

    // rotate Y then X
    const x1 = p[0] * cy + p[2] * sy
    const z1 = -p[0] * sy + p[2] * cy
    const y2 = p[1] * cx - z1 * sx
    const z2 = p[1] * sx + z1 * cx

    return [x1, y2, z2]
  }

  for (let face = 0; face < 6; face += 1) {
    for (let u = 0; u < N; u += 1) {
      for (let v = 0; v < N; v += 1) {
        const c: [number, number, number][] = [vert(u, v, face), vert(u + 1, v, face), vert(u + 1, v + 1, face), vert(u, v + 1, face)]
        const z = (c[0][2] + c[1][2] + c[2][2] + c[3][2]) / 4
        // Face normal via cross product → simple headlamp lambert.
        const ux = c[1][0] - c[0][0]
        const uy = c[1][1] - c[0][1]
        const uz = c[1][2] - c[0][2]
        const vx = c[3][0] - c[0][0]
        const vy = c[3][1] - c[0][1]
        const vz = c[3][2] - c[0][2]
        const nx = uy * vz - uz * vy
        const ny = uz * vx - ux * vz
        const nz = ux * vy - uy * vx
        const nl = Math.hypot(nx, ny, nz) || 1
        const shade = Math.abs(nz / nl)

        quads.push({
          z,
          shade,
          pts: c.map(([x, y, zz]) => {
            const persp = 3.6 / (3.6 - zz * 0.9)

            return [w / 2 + x * scale * persp, h / 2 + y * scale * persp] as [number, number]
          })
        })
      }
    }
  }

  return quads.sort((a, b) => a.z - b.z)
}

function drawViewport(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  const mode = viewportMode(t)
  // Materials CROSSFADE at mode boundaries — the first 30% of each span
  // paints the outgoing material under the incoming one, like a shader
  // recompile settling. Never a hard swap. The geometry is ALWAYS a cube.
  const prevMode = (mode + VIEWPORT_MODES.length - 1) % VIEWPORT_MODES.length
  const phase = (t % MODE_SPAN_MS) / MODE_SPAN_MS
  const blendF = Math.min(1, phase / 0.3)
  const blend = blendF * blendF * (3 - 2 * blendF)

  ctx.clearRect(0, 0, w, h)

  const quads = cubeQuads(t, w, h)

  // ── Viewport furniture (drawn under the mesh) ─────────────────────────
  ctx.save()
  ctx.font = "8px 'Courier Prime', monospace"

  // Axis gizmo, bottom-left: x/y/z stubs following the cube's rotation.
  const rx = t * 0.00042
  const ry = t * 0.00071
  const gx = 24
  const gy = h - 22

  const axes: [string, number, number, number, string][] = [
    ['x', 1, 0, 0, 'rgba(248, 113, 113, 0.8)'],
    ['y', 0, -1, 0, 'rgba(74, 222, 128, 0.8)'],
    ['z', 0, 0, 1, 'rgba(96, 165, 250, 0.8)']
  ]

  for (const [label, ax, ay, az, color] of axes) {
    const x1 = ax * Math.cos(ry) + az * Math.sin(ry)
    const z1 = -ax * Math.sin(ry) + az * Math.cos(ry)
    const y2 = ay * Math.cos(rx) - z1 * Math.sin(rx)
    const px = gx + x1 * 13
    const py = gy + y2 * 13

    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(gx, gy)
    ctx.lineTo(px, py)
    ctx.stroke()
    ctx.fillStyle = color
    ctx.fillText(label, px + 2, py + 3)
  }

  // Rotation readout, top-left; verts, bottom-right. N=4 → 6·(N+1)² shared
  // grid verts per face is the honest-ish count for the subdivided cube.
  const deg = (r: number) => (((r * 180) / Math.PI) % 360 | 0).toString().padStart(3, ' ')

  ctx.fillStyle = 'rgba(255,255,255,0.22)'
  ctx.fillText(`rx ${deg(rx)}\u00b0  ry ${deg(ry)}\u00b0`, 12, 14)
  const verts = `${6 * 5 * 5} verts \u00b7 ${quads.length} faces`

  ctx.fillText(verts, w - ctx.measureText(verts).width - 12, h - 10)
  ctx.restore()

  // One painter per material. `standard` is the resting state: the plain
  // white default cube under ambient light — lambert with a lifted floor so
  // no face ever goes black.
  const paint = (m: number, q: Quad, alpha: number) => {
    if (alpha <= 0.01) {
      return
    }

    ctx.globalAlpha = alpha

    if (m === 0) {
      // standard: white, ambient-lit.
      const l = 152 + q.shade * 88

      ctx.fillStyle = `rgb(${l}, ${l}, ${l + 2})`
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.16)'
      ctx.lineWidth = 0.5
      ctx.stroke()
    } else if (m === 1) {
      // metal: dark base, tight specular ramp, cool cast.
      const s = Math.pow(q.shade, 2.6)
      const v = 26 + s * 205

      ctx.fillStyle = `rgb(${v * 0.92}, ${v * 0.97}, ${Math.min(255, v * 1.06 + 6)})`
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.07)'
      ctx.lineWidth = 0.5
      ctx.stroke()
    } else if (m === 2) {
      // glass: translucent facets, fresnel rim (grazing faces glow).
      const rim = 1 - q.shade

      ctx.fillStyle = `rgba(140, 180, 255, ${0.05 + rim * 0.17})`
      ctx.fill()
      ctx.strokeStyle = `rgba(170, 200, 255, ${0.1 + rim * 0.38})`
      ctx.lineWidth = 0.7
      ctx.stroke()
    } else {
      // wireframe: the naked mesh, before the loop returns to standard.
      ctx.strokeStyle = `rgba(255,255,255,${0.14 + q.shade * 0.2})`
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }

  for (const q of quads) {
    ctx.beginPath()
    ctx.moveTo(q.pts[0][0], q.pts[0][1])

    for (let i = 1; i < 4; i += 1) {
      ctx.lineTo(q.pts[i][0], q.pts[i][1])
    }

    ctx.closePath()

    if (blend < 1) {
      paint(prevMode, q, 1 - blend)
    }

    paint(mode, q, blend)
  }

  ctx.globalAlpha = 1
}


export function IntroRevealSurface({
  beatOverride,
  leavingOverride
}: {
  /** Test-only forcing. The surface is self-clocked. */
  beatOverride?: number
  leavingOverride?: boolean
} = {}) {
  const glowRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const brandRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLCanvasElement>(null)
  const [frame, setFrame] = useState<Frame>(INITIAL_FRAME)
  const [clockLeaving, setClockLeaving] = useState(false)
  const [ipcLeaving, setIpcLeaving] = useState(false)
  const [faded, setFaded] = useState(false)
  // Dev scrubber: pause + seek the sequence clock.
  const [pausedUI, setPausedUI] = useState(false)
  const [scrubT, setScrubT] = useState(0)
  const controlRef = useRef<{ seek: (ms: number) => void; toggle: () => void } | null>(null)

  const beat = beatOverride ?? frame.beat
  const leaving = leavingOverride ?? (clockLeaving || ipcLeaving)

  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  const skip = () => {
    window.hermesDesktop?.introReveal?.skip?.()
    window.setTimeout(() => {
      void window.hermesDesktop?.introReveal?.close?.().catch(() => undefined)
    }, 1200)
  }

  // ── Deadman: this window removes itself no matter what. ─────────────────
  useEffect(() => {
    const id = window.setTimeout(() => {
      void window.hermesDesktop?.introReveal?.close?.().catch(() => undefined)
    }, INTRO_DEADMAN_MS)

    return () => window.clearTimeout(id)
  }, [])

  // ── Main-renderer pushes drive a skip-initiated dissolve. ───────────────
  useEffect(() => {
    const off = window.hermesDesktop?.introReveal?.onBeat?.(payload => {
      setIpcLeaving(payload.leaving)
    })

    return () => off?.()
  }, [])

  // ── The clock: one rAF loop → frame snapshots + sound + glow. ───────────
  // eslint-disable-next-line no-restricted-syntax -- controlRef is not an atom mirror: it exposes the clock's imperative seek/pause (closure state) to the dev scrubber; the closure is the only source of truth.
  useEffect(() => {
    if (reduceMotion) {
      // Reduced motion: static brand card, short hold, out.
      setFrame({ ...INITIAL_FRAME, beat: INTRO_BEAT_INDEX.brand })
      playLatch()

      const id = window.setTimeout(() => {
        setClockLeaving(true)
        window.hermesDesktop?.introReveal?.skip?.()
        window.setTimeout(() => {
          void window.hermesDesktop?.introReveal?.close?.().catch(() => undefined)
        }, INTRO_EXIT_MS + 300)
      }, 2600)

      return () => window.clearTimeout(id)
    }

    const pad = startPad()
    let start = performance.now()
    let prevT = -1
    let raf = 0
    let currentBeat = 0
    let reportedDone = false
    let lastFrameKey = ''
    let paused = false
    let pausedAt = 0
    let lastScrub = -1

    // Not an atom mirror — this hands the clock's imperative controls
    // (closure state: start/paused) to the scrubber UI. There is no reactive
    // source to read instead; the closure IS the source of truth.
    controlRef.current = {
      seek: ms => {
        const clamped = Math.max(0, Math.min(INTRO_TOTAL_MS + INTRO_EXIT_MS - 1, ms))

        start = performance.now() - clamped
        pausedAt = clamped
        // No cue replay on a jump: beats re-derive silently from the target.
        prevT = clamped
        currentBeat = 0

        for (const b of INTRO_BEATS) {
          if (b.t <= clamped) {
            currentBeat = INTRO_BEAT_INDEX[b.id]
          }
        }

        if (clamped < INTRO_TOTAL_MS) {
          reportedDone = false
          setClockLeaving(false)
        }

        lastFrameKey = ''
      },
      toggle: () => {
        if (paused) {
          start = performance.now() - pausedAt
        } else {
          pausedAt = performance.now() - start
        }

        paused = !paused
        setPausedUI(paused)
      }
    }

    const tick = () => {
      const t = paused ? pausedAt : performance.now() - start

      for (const b of beatsBetween(prevT, t)) {
        currentBeat = INTRO_BEAT_INDEX[b.id] ?? currentBeat

        if (b.cue === 'tick') {
          playTick(b.id === 'send' ? 1.35 : 1)
        } else if (b.cue === 'swell') {
          playSwell()
        } else if (b.cue === 'latch') {
          playLatch()
        } else if (b.cue === 'resolve') {
          playResolve()
        }
      }

      prevT = t

      // The Blender-viewport cube: drawn imperatively every frame while
      // visible (until the reply lands — it collapses on send).
      const canvas = viewportRef.current

      if (canvas && t < EVERYWHERE_T + 700) {
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        const cw = canvas.clientWidth
        const ch = canvas.clientHeight

        if (cw > 0 && ch > 0) {
          if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
            canvas.width = cw * dpr
            canvas.height = ch * dpr
          }

          const ctx2d = canvas.getContext('2d')

          if (ctx2d) {
            ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
            drawViewport(ctx2d, cw, ch, t)
          }
        }
      }

      const next = frameAt(t, currentBeat)
      const key = `${next.beat}:${next.typed}:${next.replyWords}:${next.toolShown}:${next.toolDone}`

      if (key !== lastFrameKey) {
        lastFrameKey = key
        setFrame(next)
      }

      const coarse = Math.floor(t / 80) * 80

      if (coarse !== lastScrub) {
        lastScrub = coarse
        setScrubT(coarse)
      }

      const curves = sampleCurves(t)

      pad.setLevel(Math.max(curves.glow, next.beat >= INTRO_BEAT_INDEX.working ? 0.45 : 0.2))

      // ── Continuous cinematography, all eased (smoothstep everywhere). ──
      const ss = (from: number, to: number) => {
        const f = Math.min(1, Math.max(0, (t - from) / (to - from)))

        return f * f * (3 - 2 * f)
      }

      // The stage never sits still: a slow drift-up across the whole piece,
      // a gentle scale breath, and a lateral ease as the constellation opens
      // (hero sits slightly left once the side agents arrive — asymmetric,
      // not centered). All one transform, compositor-only.
      if (stageRef.current) {
        const rise = -10 - ss(0, INTRO_TOTAL_MS) * 26
        const breathe = 1 + Math.sin(t / 2600) * 0.004
        const openScale = 1 - ss(EVERYWHERE_T - 600, EVERYWHERE_T + 1200) * 0.06
        const lateral = ss(EVERYWHERE_T - 600, EVERYWHERE_T + 1400) * -18
        const brandPush = ss(BRAND_T - 300, BRAND_T + 1200)

        stageRef.current.style.transform = `translate(${lateral}px, ${rise + brandPush * -14}px) scale(${breathe * openScale * (1 - brandPush * 0.05)})`
        stageRef.current.style.opacity = String(1 - brandPush)
      }

      // The ENTIRE brand close (glow + badge + wordmark + tagline) rides ONE
      // alpha so nothing is ever readable against a half-faded bloom. It
      // rises in with the glow and the whole group breathes out together
      // through the exit window.
      const brandIn = ss(BRAND_T - 200, BRAND_T + 1300)
      const brandOut = 1 - ss(INTRO_TOTAL_MS - 500, INTRO_TOTAL_MS + INTRO_EXIT_MS - 100)
      const brandAlpha = brandIn * brandOut

      if (glowRef.current) {
        glowRef.current.style.opacity = String(brandAlpha)
        glowRef.current.style.transform = `translate(-50%, -30%) scale(${0.9 + brandIn * 0.14})`
      }

      if (brandRef.current) {
        brandRef.current.style.opacity = String(brandAlpha)
        brandRef.current.style.transform = `translateY(${(1 - brandIn) * 26 - brandIn * 6}px) scale(${0.94 + brandIn * 0.06})`
      }

      if (t >= INTRO_TOTAL_MS && !reportedDone && !paused) {
        reportedDone = true
        setClockLeaving(true)
        window.hermesDesktop?.introReveal?.skip?.()
        window.setTimeout(() => {
          void window.hermesDesktop?.introReveal?.close?.().catch(() => undefined)
        }, INTRO_EXIT_MS + 300)
      }

      if (DEV_SCRUB || t < INTRO_TOTAL_MS + INTRO_EXIT_MS) {
        raf = requestAnimationFrame(tick)
      }
    }

    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      pad.stop()
    }
  }, [reduceMotion])

  // ── Esc to skip (local — never depends on the main renderer). ───────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        skip()
      }

      // Space = pause/play in dev builds (buttons handle their own space).
      if (e.key === ' ' && DEV_SCRUB && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault()
        controlRef.current?.toggle()
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
     
  }, [])

  useEffect(() => {
    const id = requestAnimationFrame(() => setFaded(true))

    return () => cancelAnimationFrame(id)
  }, [])

  const sent = beat >= INTRO_BEAT_INDEX.send
  const replying = beat >= INTRO_BEAT_INDEX.reply
  const everywhere = beat >= INTRO_BEAT_INDEX.everywhere
  const brand = beat >= INTRO_BEAT_INDEX.brand
  const typedText = INTRO_PROMPT.slice(0, frame.typed)
  const replyText = INTRO_REPLY_WORDS.slice(0, frame.replyWords).join(' ')

  const sideCard = (title: string, line1: string, line2: string, offset: string, delayMs = 0, tilt = 0) => (
    <div
      className="w-full rounded-xl p-5"
      style={{
        background: 'rgba(12, 13, 16, 0.82)',
        border: '1px solid rgba(255,255,255,0.09)',
        boxShadow: NOUS_SHADOW,
        opacity: everywhere && !brand ? 1 : 0,
        transform:
          everywhere && !brand
            ? `translateZ(-90px) rotateY(${tilt}deg) translateY(0) scale(1)`
            : `translateZ(-90px) rotateY(${tilt}deg) translateY(${offset}) scale(0.94)`,
        transition: `opacity 760ms ${EASE} ${delayMs}ms, transform 760ms ${EASE} ${delayMs}ms`,
        willChange: 'transform, opacity'
      }}
    >
      <div
        className="mb-3 flex items-center gap-2 text-[0.72rem] uppercase tracking-[0.18em] text-white/50"
        style={{ fontFamily: "'Rules Expanded', sans-serif" }}
      >
        <span className="inline-block size-1.5 rounded-full" style={{ animation: 'intro-dot 1.6s ease-in-out infinite', background: BLUE }} />
        {title}
      </div>
      <div className="text-[0.95rem] leading-6 text-white/85">{line1}</div>
      <div className="mt-1 text-[0.85rem] leading-6" style={{ color: BLUE_FAINT, fontFamily: "'Courier Prime', monospace" }}>
        {everywhere && !brand ? decoded(line2, EVERYWHERE_T + delayMs + 500, frame.tick, 700) : line2}
      </div>
    </div>
  )

  return (
    <div
      aria-label={SKIP}
      aria-modal="true"
      className={cn(
        'fixed inset-0 flex items-center justify-center overflow-hidden',
        'transition-opacity ease-out',
        leaving ? 'pointer-events-none opacity-0 duration-[900ms]' : faded ? 'opacity-100 duration-700' : 'opacity-0'
      )}
      onClick={skip}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          skip()
        }
      }}
      role="dialog"
      tabIndex={-1}
    >
      <style>{FONT_CSS}</style>

      {/* Dark wash over the native frost — the whole piece plays in dark
          mode regardless of the desktop under it. */}
      <div
        className="absolute inset-0 bg-black/82"
        style={{ opacity: faded && !leaving ? 1 : 0, transition: `opacity 900ms ${EASE}` }}
      />

      {/* Brand spotlight — an Apple-keynote cone from above, not a bloom:
          soft white falling from the top edge, gentle falloff, barely-there.
          Opacity/scale driven per-frame alongside the brand group. */}
      <div
        className="pointer-events-none absolute left-1/2 top-0 h-[130vmin] w-[150vmin] opacity-0"
        ref={glowRef}
        style={{
          background:
            'radial-gradient(ellipse 46% 44% at 50% 22%, rgba(255,255,255,0.16), rgba(255,255,255,0.045) 48%, transparent 72%)',
          transform: 'translate(-50%, -30%) scale(0.9)'
        }}
      />

      {/* ── The demo constellation ─────────────────────────────────────────
          Wrapped in the stage: one per-frame transform gives the whole scene
          slow continuous drift + breath, and eases it left as the agents
          arrive so the finished composition sits intentionally off-center. */}
      <div
        className="relative flex items-center justify-center gap-[2vw]"
        ref={stageRef}
        style={{ perspective: '1400px', transformStyle: 'preserve-3d', willChange: 'transform, opacity' }}
      >
        {/* Left column: two agents, staggered entrances, gentle float. */}
        <div className="flex w-[19vw] min-w-[240px] flex-col gap-4 self-start pt-[6vh]">
          <div style={{ animation: 'intro-float-a 5.2s ease-in-out infinite alternate' }}>
            {sideCard('research agent', 'Apartment hunt: 3 new listings shortlisted', '↳ compiling tour schedule…', '26px', 0, 7)}
          </div>
          <div style={{ animation: 'intro-float-b 6.1s ease-in-out infinite alternate' }}>
            {sideCard('groceries', 'Weekly order built from your list', '↳ delivery booked for Sunday', '38px', 220, 7)}
          </div>
        </div>

        {/* The hero chat. Dark terminal glass — fixed layout, no reflow:
            bubbles and rows fade/translate into RESERVED space. */}
        <div
          className="relative w-[46vw] min-w-[560px] max-w-[900px] rounded-xl p-7"
          style={{
            background: 'rgba(10, 11, 14, 0.88)',
            border: '1px solid rgba(255,255,255,0.09)',
            boxShadow: NOUS_SHADOW,
            animation: 'intro-hover-a 8.4s ease-in-out infinite alternate',
            transform: everywhere ? 'rotateX(4deg) translateZ(-60px) scale(0.86)' : 'rotateX(1.6deg) scale(1)',
            transition: `transform 1100ms ${EASE}`,
            transformOrigin: 'center 60%',
            willChange: 'transform'
          }}
        >
          {/* ── Detached viewport node — hermes-workflow-demo style: a small
              glass node floating top-left of the chat, wired into it, the
              cube autorotating through materials inside. It stays through
              the reply and slides down/fades only on the scene change to
              the constellation. */}
          <div
            className="absolute -left-64 -top-20 w-52 rounded-xl"
            style={{
              background: 'rgba(10, 11, 14, 0.88)',
              border: '1px solid rgba(255,255,255,0.09)',
              boxShadow: NOUS_SHADOW,
              animation: 'intro-hover-b 6.8s ease-in-out infinite alternate',
              opacity: sent && !everywhere ? 1 : 0,
              transform:
                sent && !everywhere
                  ? 'translateZ(70px) rotateX(-2deg) rotateY(2.5deg) translateY(0) scale(1)'
                  : everywhere
                    ? 'translateZ(70px) rotateX(-2deg) rotateY(2.5deg) translateY(26px) scale(0.97)'
                    : 'translateZ(70px) rotateX(-2deg) rotateY(2.5deg) translateY(12px) scale(0.95)',
              transition: `opacity 480ms ${EASE}, transform 560ms ${EASE}`,
              willChange: 'transform, opacity'
            }}
          >
            <div
              className="flex items-center justify-between px-3 pt-2.5 text-[0.5rem] uppercase tracking-[0.2em] text-white/30"
              style={{ fontFamily: "'Rules Expanded', sans-serif" }}
            >
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-1 rounded-full" style={{ animation: 'intro-dot 1.6s ease-in-out infinite', background: BLUE }} />
                viewport
              </span>
              <span className="text-[0.6rem] normal-case tracking-normal" style={{ color: BLUE_DIM, fontFamily: "'Courier Prime', monospace" }}>
                {decoded(
                  VIEWPORT_MODES[viewportMode(frame.tick * 45)],
                  Math.floor((frame.tick * 45) / MODE_SPAN_MS) * MODE_SPAN_MS,
                  frame.tick,
                  300
                )}
              </span>
            </div>
            <canvas className="block h-40 w-full" ref={viewportRef} />
            {/* Output port on the node's right edge — where the wire leaves. */}
            <span className="absolute -right-[5px] top-1/2 size-2.5 -translate-y-1/2 rounded-full border border-black/55 bg-[#0a0b0e]" />
          </div>

          {/* The wire: node output port → chat input port. hermes-workflow-
              demo grammar — one SOLID hairline bezier (no dashes), stroked
              with a gradient between the two ends' states. It draws on at
              send (the agent plugs into Blender), carries a droplet while the
              tools run, and settles to the quiet done-green once they finish.
              Wires appear when a connection EXISTS, not before. */}
          <svg
            aria-hidden
            className="pointer-events-none absolute -left-12 top-0 h-16 w-12 overflow-visible"
            style={{ opacity: everywhere ? 0 : sent ? 1 : 0, transition: `opacity 300ms ${EASE}` }}
            viewBox="0 0 48 64"
          >
            <path
              d="M 0 15 C 21 15, 27 44, 48 44"
              fill="none"
              pathLength={1}
              stroke="rgba(0,0,0,0.55)"
              strokeDasharray="1"
              strokeDashoffset={sent ? 0 : 1}
              strokeWidth="1.5"
              style={{ transition: `stroke-dashoffset 440ms ${EASE}` }}
            />
          </svg>

          {/* The chat's input port — the wire lands on a real socket. */}
          <span
            className="absolute -left-[5px] top-[40px] size-2.5 rounded-full border bg-[#0a0b0e]"
            style={{
              borderColor: 'rgba(0,0,0,0.55)',
              opacity: everywhere ? 0 : sent ? 1 : 0,
              transition: `opacity 380ms ${EASE}, border-color 380ms ${EASE}`
            }}
          />

          {/* User bubble (reserved slot; appears on send) — bare text, no
              chrome: the words are the bubble. */}
          <div className="flex min-h-[3.9rem] justify-end">
            <div
              className="max-w-[80%] px-1 py-3.5 text-right text-[1.02rem] leading-7 text-white/92"
              style={{
                opacity: sent ? 1 : 0,
                transform: sent ? 'translateY(0) scale(1)' : 'translateY(10px) scale(0.97)',
                transition: `opacity 480ms ${EASE}, transform 480ms ${EASE}`,
                willChange: 'transform, opacity'
              }}
            >
              {INTRO_PROMPT}
            </div>
          </div>

          {/* Tool activity rows — the hackery heart: mono, braille spinners,
              statuses scramble-decode in, results decode on completion.
              (Reserved block so nothing reflows.) */}
          <div className="mt-5 grid min-h-[10.5rem] content-start gap-2.5">
            {INTRO_TOOL_ROWS.map((row, i) => {
              const shown = Boolean(frame.toolShown & (1 << i)) && sent
              const done = Boolean(frame.toolDone & (1 << i))

              return (
                <div
                  className="flex items-center gap-3 rounded-lg px-4 py-3"
                  key={row.label}
                  style={{
                    background: 'rgba(255,255,255,0.045)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    opacity: shown ? 1 : 0,
                    transform: shown ? 'translateY(0)' : 'translateY(6px)',
                    transition: `opacity 520ms ${EASE}, transform 520ms ${EASE}`,
                    willChange: 'transform, opacity'
                  }}
                >
                  <span
                    className={cn('w-4 text-center font-mono text-[0.95rem]', !done && 'text-white/55')}
                    style={{ color: done ? BLUE : undefined, fontFamily: "'Courier Prime', monospace" }}
                  >
                    {done ? '✓' : SPINNER[frame.tick % SPINNER.length]}
                  </span>
                  <span
                    className="text-[0.66rem] font-bold uppercase tracking-[0.18em] text-white/55"
                    style={{ fontFamily: "'Rules Expanded', sans-serif" }}
                  >
                    {row.label}
                  </span>
                  <span
                    className="ml-auto grid text-[0.8rem] text-white/50"
                    style={{ fontFamily: "'Courier Prime', monospace" }}
                  >
                    {/* Stacked in one grid cell so running/done crossfade in place. */}
                    <span
                      className="col-start-1 row-start-1 text-right"
                      style={{ opacity: done ? 0 : 1, transition: `opacity 400ms ${EASE}` }}
                    >
                      {shown && !done ? decoded(row.runningText, row.at, frame.tick) : row.runningText}
                    </span>
                    <span
                      className="col-start-1 row-start-1 text-right"
                      style={{ color: BLUE_DIM, opacity: done ? 1 : 0, transition: `opacity 400ms ${EASE}` }}
                    >
                      {done ? decoded(row.doneText, row.doneAt, frame.tick, 380) : row.doneText}
                    </span>
                  </span>
                </div>
              )
            })}
          </div>

          {/* Streaming reply bubble (reserved slot). */}
          <div className="mt-5 min-h-[6.5rem]">
            <div
              className="max-w-[88%] rounded-xl rounded-bl-md px-5 py-3.5 text-[1.02rem] leading-7 text-white/88"
              style={{
                background: 'rgba(255,255,255,0.055)',
                border: '1px solid rgba(255,255,255,0.07)',
                opacity: replying ? 1 : 0,
                transform: replying ? 'translateY(0)' : 'translateY(6px)',
                transition: `opacity 500ms ${EASE}, transform 500ms ${EASE}`,
                willChange: 'transform, opacity'
              }}
            >
              {replyText || '\u00a0'}
              {replying && frame.replyWords < INTRO_REPLY_WORDS.length ? (
                <span className="dither ml-1 inline-block h-[1.05em] w-[0.5em] translate-y-[3px]" style={{ animation: 'intro-caret 0.9s step-end infinite', color: BLUE }} />
              ) : null}
            </div>
          </div>

          {/* Composer — the REAL app composer's anatomy, faked: glass fill +
              hairline ring (dt-composer-ring recipe), rounded-2xl dock shape,
              ghost "+" left, mic + solid foreground-circle send right
              (PRIMARY_ICON_BTN: white circle, dark glyph in dark mode). */}
          <div className="mt-5">
            <div
              className="rounded-2xl px-3 py-2.5"
              style={{
                background: 'color-mix(in srgb, #16171b 78%, transparent)',
                backdropFilter: 'blur(12px) saturate(1.12)',
                border: '1px solid rgba(255,255,255,0.12)'
              }}
            >
              <div
                className="min-h-[2rem] px-1.5 pt-0.5 text-[1.02rem] leading-7 text-white/90"
              >
                {sent || typedText.length === 0 ? <span className="text-white/28">Ask anything. Build anything.</span> : typedText}
                {!sent ? (
                  <span
                    className="dither ml-0.5 inline-block h-[1.1em] w-[0.52em] translate-y-[3px]"
                    style={{ animation: 'intro-caret 1.05s step-end infinite', color: BLUE }}
                  />
                ) : null}
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <span className="grid size-6 place-items-center rounded-full text-white/45">
                  <svg fill="none" height="13" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" viewBox="0 0 16 16" width="13">
                    <path d="M8 3.5v9M3.5 8h9" />
                  </svg>
                </span>
                <span
                  className="rounded-md px-1.5 py-0.5 text-[0.62rem] text-white/40"
                  style={{ border: '1px solid rgba(255,255,255,0.1)', fontFamily: "'Courier Prime', monospace" }}
                >
                  hermes-guest
                </span>
                <span className="ml-auto grid size-6 place-items-center rounded-full text-white/45">
                  <svg fill="none" height="13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="13">
                    <rect height="12" rx="3" width="6" x="9" y="3" />
                    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                  </svg>
                </span>
                <span
                  className="grid size-[1.65rem] shrink-0 place-items-center rounded-full"
                  style={{
                    background: sent ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.92)',
                    color: '#0a0b0e',
                    transform: !sent && frame.typed >= INTRO_PROMPT.length ? 'scale(1.08)' : 'scale(1)',
                    transition: `transform 300ms ${EASE}, background 400ms ${EASE}`
                  }}
                >
                  <svg fill="none" height="13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" viewBox="0 0 24 24" width="13">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Right column: two agents, offset downward against the left. */}
        <div className="flex w-[19vw] min-w-[240px] flex-col gap-4 self-end pb-[5vh]">
          <div style={{ animation: 'intro-float-c 5.7s ease-in-out infinite alternate' }}>
            {sideCard('inbox agent', '2 replies drafted, waiting for your ok', '↳ calendar updated for Friday', '34px', 120, -7)}
          </div>
          <div style={{ animation: 'intro-float-a 6.6s ease-in-out infinite alternate' }}>
            {sideCard('morning brief', 'Tomorrow: 3 meetings, rain at 8', '↳ ready before you wake', '30px', 340, -7)}
          </div>
        </div>
      </div>

      {/* Surfaces caption (everywhere scene). */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-[13vh] text-center text-[1.02rem] tracking-[0.34em] text-white/60 uppercase"
        style={{
          fontFamily: "'Rules Expanded', sans-serif",
          opacity: everywhere && !brand ? 1 : 0,
          transform: everywhere && !brand ? 'translateY(0)' : 'translateY(12px)',
          transition: `opacity 620ms ${EASE} 180ms, transform 620ms ${EASE} 180ms`
        }}
      >
        {SURFACES}
      </div>

      {/* ── Brand close ──────────────────────────────────────────────────
          Opacity + transform are driven per-frame by the clock (brandRef)
          with the SAME alpha as the glow behind it, so badge, wordmark,
          tagline, and bloom rise and dissolve as one object — text is never
          stranded on a half-faded backdrop. */}
      <div
        className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-[3.2vmin] opacity-0"
        ref={brandRef}
        style={{ willChange: 'transform, opacity' }}
      >
        <img alt="" className="h-[32vmin] w-auto object-contain" src={assetPath('nous-badge.png')} />
        <div className="flex flex-col items-center gap-[1.6vmin]">
          {/* Light under the spotlight — the cone above lifts it off the dark. */}
          <h1
            className="text-[6.8vmin] leading-none uppercase text-white/95"
            style={{ fontFamily: "'Sigurd', serif", fontWeight: 580, letterSpacing: '0.06em', textShadow: '0 2px 24px rgba(0,0,0,0.45)' }}
          >
            Hermes Agent
          </h1>
          <p
            className="text-[1.35vmin] uppercase tracking-[0.42em] text-white/50"
            style={{ fontFamily: "'Rules Expanded', sans-serif" }}
          >
            {TAGLINE}
          </p>
        </div>
      </div>

      {/* ── Dev scrubber: timeline with beat ticks, click/drag to seek,
          space or button to pause. Flag-gated with the feature itself. */}
      {DEV_SCRUB ? (
        <div
          className="absolute inset-x-0 bottom-0 flex items-center gap-3 px-6 pb-4 pt-6"
          onClick={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
          role="presentation"
        >
          <button
            className="grid size-7 shrink-0 place-items-center rounded border border-white/15 bg-black/60 text-white/80"
            onClick={() => controlRef.current?.toggle()}
            type="button"
          >
            {pausedUI ? (
              <svg fill="currentColor" height="10" viewBox="0 0 10 10" width="10"><path d="M2 1l7 4-7 4z" /></svg>
            ) : (
              <svg fill="currentColor" height="10" viewBox="0 0 10 10" width="10"><path d="M2 1h2.4v8H2zM5.6 1H8v8H5.6z" /></svg>
            )}
          </button>
          <div
            className="relative h-7 flex-1 cursor-pointer"
            onPointerDown={e => {
              const el = e.currentTarget

              el.setPointerCapture(e.pointerId)

              const seekTo = (clientX: number) => {
                const r = el.getBoundingClientRect()

                controlRef.current?.seek(((clientX - r.left) / r.width) * INTRO_TOTAL_MS)
              }

              seekTo(e.clientX)

              const move = (ev: PointerEvent) => seekTo(ev.clientX)

              const up = () => {
                el.removeEventListener('pointermove', move)
                el.removeEventListener('pointerup', up)
              }

              el.addEventListener('pointermove', move)
              el.addEventListener('pointerup', up)
            }}
          >
            <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/15" />
            <div
              className="absolute left-0 top-1/2 h-px -translate-y-1/2 bg-[#4d8dff]/70"
              style={{ width: `${Math.min(100, (scrubT / INTRO_TOTAL_MS) * 100)}%` }}
            />
            {INTRO_BEATS.map(b => (
              <div className="group absolute top-0 h-full" key={b.id} style={{ left: `${(b.t / INTRO_TOTAL_MS) * 100}%` }}>
                <div className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-white/40" />
                <span
                  className="absolute bottom-full left-1/2 -translate-x-1/2 whitespace-nowrap pb-0.5 text-[0.55rem] uppercase tracking-[0.14em] text-white/45"
                  style={{ fontFamily: "'Courier Prime', monospace" }}
                >
                  {b.id}
                </span>
              </div>
            ))}
            <div
              className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#4d8dff]"
              style={{ left: `${Math.min(100, (scrubT / INTRO_TOTAL_MS) * 100)}%` }}
            />
          </div>
          <span className="w-14 text-right font-mono text-[0.62rem] tabular-nums text-white/50">
            {(scrubT / 1000).toFixed(1)}s
          </span>
        </div>
      ) : null}

      {/* Skip affordance — quiet, bottom-right. */}
      <button
        className={cn(
          "absolute right-7 text-[0.72rem] uppercase tracking-[0.24em] text-white/40 transition-colors hover:text-white/80",
          DEV_SCRUB ? "bottom-16" : "bottom-6"
        )}
        onClick={skip}
        style={{ fontFamily: "'Rules Expanded', sans-serif" }}
        type="button"
      >
        {SKIP}
      </button>
    </div>
  )
}
