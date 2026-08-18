/**
 * The intro reveal conductor — mounted in the MAIN renderer while the sequence
 * plays. The overlay window owns the clock and the visuals (its rAF keeps
 * running; the main window's is throttled while fully occluded, so no frame
 * clock can live here). This component:
 *   - native path: renders nothing; finishes the store when the overlay
 *     reports done/skip (wired in the store's bridge listeners) with a
 *     wall-clock timeout as belt-and-braces
 *   - fallback path (web/tests, no bridge): renders the surface inline and
 *     finishes the store on a plain timeout
 */

import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import {
  $introReveal,
  finishIntroReveal,
  leaveIntroReveal
} from '@/store/intro-reveal'

import { IntroRevealSurface } from './intro-reveal-surface'
import { INTRO_DEADMAN_MS, INTRO_EXIT_MS, INTRO_TOTAL_MS } from './timeline'

function hasNativeSurface(): boolean {
  return typeof window !== 'undefined' && Boolean(window.hermesDesktop?.introReveal)
}

export function IntroRevealOverlay() {
  const state = useStore($introReveal)

  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  // Wall-clock completion. Native path: the overlay window reports done via
  // the skip channel before this fires (making this a no-op backstop —
  // setTimeout still fires under background throttling, just late). Fallback
  // path: this IS the clock. Reduced motion: short hold.
  useEffect(() => {
    if ($introReveal.get().phase !== 'playing') {
      return undefined
    }

    const total = reduceMotion ? 2200 : hasNativeSurface() ? INTRO_DEADMAN_MS : INTRO_TOTAL_MS

    const id = window.setTimeout(() => {
      if ($introReveal.get().phase === 'playing') {
        leaveIntroReveal()
        window.setTimeout(() => finishIntroReveal(), INTRO_EXIT_MS)
      }
    }, total)

    return () => window.clearTimeout(id)
     
  }, [reduceMotion])

  // Esc skips from the main window too (the overlay window handles its own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && $introReveal.get().phase === 'playing') {
        leaveIntroReveal()
        window.setTimeout(() => finishIntroReveal(), INTRO_EXIT_MS)
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (state.phase === 'hidden') {
    return null
  }

  // Native path: the dedicated window renders everything; nothing in-app.
  if (hasNativeSurface()) {
    return null
  }

  // Fallback (web/tests): render the surface inline over the app.
  return (
    <div className="fixed inset-0 z-(--z-intro-reveal)">
      <IntroRevealSurface beatOverride={undefined} leavingOverride={state.phase === 'leaving'} />
    </div>
  )
}
