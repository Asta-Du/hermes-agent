import { createRoot } from 'react-dom/client'

import { ErrorBoundary } from '@/components/error-boundary'

import { IntroRevealSurface } from './intro-reveal-surface'

/**
 * Boot the intro-reveal window. Loaded by the same bundle as the main app via
 * `?win=intro`, so it shares CSS while mounting only the reveal surface — no
 * app shell, no gateway, no I18n (strings are inline, like the pet overlay).
 *
 * The index.html boot script paints an opaque themed background for normal
 * windows; this window must be see-through so the sequence plays over the
 * user's real desktop. Force every host layer transparent.
 */
export function mountIntroReveal(): void {
  const style = document.createElement('style')

  style.textContent = 'html,body,#root{background:transparent !important;}'
  document.head.appendChild(style)

  document.title = 'Hermes'

  const root = document.getElementById('root')

  if (!root) {
    return
  }

  createRoot(root).render(
    // NO StrictMode: dev double-mount would start two rAF clocks + two sound
    // pads (visible as a glitchy double-render until one wins). The surface
    // is self-clocked and disposable; strict double-invoke buys nothing here.
    <ErrorBoundary label="intro-reveal">
      <IntroRevealSurface />
    </ErrorBoundary>
  )
}
