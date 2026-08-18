/**
 * Gate that decides when the intro reveal mounts.
 *
 * Two entry paths:
 * - First run: onboarding reports an unconfigured runtime that the user hasn't
 *   skipped. The reveal plays once, ahead of the picker, then hands off.
 * - Replay: Settings → About sets `requested` on the store directly.
 *
 * Kept separate from the overlay so the overlay itself has a single prop-less
 * contract (`$introReveal.phase !== 'hidden'`) and the onboarding-aware logic
 * stays testable without rendering GL.
 */

import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import {
  $introReveal,
  installIntroRevealBridgeListeners,
  shouldPlayFirstRunIntro,
  startIntroReveal
} from '@/store/intro-reveal'
import { $desktopOnboarding } from '@/store/onboarding'

import { IntroRevealOverlay } from './intro-reveal-overlay'

export function IntroRevealGate({ enabled }: { enabled: boolean }) {
  const onboarding = useStore($desktopOnboarding)
  const intro = useStore($introReveal)

  useEffect(() => {
    installIntroRevealBridgeListeners()
  }, [])

  useEffect(() => {
    if (!enabled || intro.phase !== 'hidden') {
      return
    }

    if (shouldPlayFirstRunIntro(onboarding.configured, onboarding.firstRunSkipped)) {
      startIntroReveal(false)
    }
  }, [enabled, intro.phase, onboarding.configured, onboarding.firstRunSkipped])

  if (intro.phase === 'hidden') {
    return null
  }

  return <IntroRevealOverlay />
}
