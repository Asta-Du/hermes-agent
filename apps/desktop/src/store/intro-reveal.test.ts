import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $introReveal,
  finishIntroReveal,
  hasSeenIntroReveal,
  leaveIntroReveal,
  replayIntroReveal,
  resetIntroRevealForTests,
  setIntroRevealBeat,
  shouldPlayFirstRunIntro,
  startIntroReveal
} from './intro-reveal'

const SEEN_KEY = 'hermes-intro-reveal-seen-v1'

describe('intro-reveal store', () => {
  beforeEach(() => {
    // The whole feature is gated on this build flag; the store reads it at
    // call time exactly so tests can flip it on.
    vi.stubEnv('VITE_INTRO_REVEAL', '1')
    window.localStorage.clear()
    resetIntroRevealForTests()
  })

  it('starts hidden', () => {
    expect($introReveal.get().phase).toBe('hidden')
  })

  it('plays on first run only when unconfigured, unskipped, and unseen', () => {
    expect(shouldPlayFirstRunIntro(false, false)).toBe(true)
    expect(shouldPlayFirstRunIntro(true, false)).toBe(false)
    expect(shouldPlayFirstRunIntro(null, false)).toBe(false)
    expect(shouldPlayFirstRunIntro(false, true)).toBe(false)
  })

  it('does not replay first run once seen', () => {
    window.localStorage.setItem(SEEN_KEY, '1')
    expect(shouldPlayFirstRunIntro(false, false)).toBe(false)
  })

  it('records seen on finish', () => {
    expect(hasSeenIntroReveal()).toBe(false)
    startIntroReveal(false)
    leaveIntroReveal()
    finishIntroReveal()
    expect(hasSeenIntroReveal()).toBe(true)
    expect($introReveal.get().phase).toBe('hidden')
  })

  it('walks playing → leaving → hidden', () => {
    startIntroReveal(false)
    expect($introReveal.get().phase).toBe('playing')
    leaveIntroReveal()
    expect($introReveal.get().phase).toBe('leaving')
    finishIntroReveal()
    expect($introReveal.get().phase).toBe('hidden')
  })

  it('leave is a no-op unless playing', () => {
    leaveIntroReveal()
    expect($introReveal.get().phase).toBe('hidden')
  })

  it('replay marks the state as replay', () => {
    replayIntroReveal()
    expect($introReveal.get().replay).toBe(true)
    expect($introReveal.get().phase).toBe('playing')
  })

  it('beat advances only while visible and dedupes repeats', () => {
    setIntroRevealBeat(3)
    expect($introReveal.get().beat).toBe(0)

    startIntroReveal(false)
    setIntroRevealBeat(3)
    expect($introReveal.get().beat).toBe(3)
    setIntroRevealBeat(3)
    expect($introReveal.get().beat).toBe(3)
  })
})
