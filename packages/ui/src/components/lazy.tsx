import { lazy, Suspense, type ComponentType, type ReactNode } from 'react'

/**
 * A component that comes in its own chunk, fetched the first time it renders (#364).
 *
 * The startup bundle was one 1.38 MB chunk with every screen in it, all of it fetched and parsed
 * before the first frame. What only some people open, and never on the first frame (the terminal
 * and its xterm, the run-command window, Settings, the file and diff viewers), loads when it is
 * first shown instead: 0.97 MB before the first frame. Measured, this did not lower the window's
 * memory with nothing open (docs/spikes/2026-10-memory-heavy-store.md §10.4): code that is loaded
 * but never run costs little, so the gain is in what is parsed up front.
 * `tooling/startup-bundle.test.ts` keeps them out of the startup chunks.
 *
 * Nothing is drawn while the chunk arrives (a local file in the app, a few milliseconds), the
 * same as a screen that has not rendered yet. A chunk that fails to load throws into the nearest
 * ErrorBoundary, as a render error would.
 */
export function lazyComponent<P extends object>(
  load: () => Promise<ComponentType<P>>,
  fallback: ReactNode = null,
): ComponentType<P> {
  const Lazy = lazy(async () => ({ default: await load() }))
  return function Loaded(props: P) {
    return (
      <Suspense fallback={fallback}>
        <Lazy {...props} />
      </Suspense>
    )
  }
}
