import { lazy, Suspense, type ComponentType, type ReactNode } from 'react'

/**
 * A component in its own chunk, fetched the first time it renders (#364). Without this every screen would be in the
 * startup bundle, one 1.38 MB chunk parsed before the first frame; with the terminal, the run-command window, Settings
 * and the viewers split off it is 0.97 MB (`tooling/startup-bundle.test.ts` keeps it so). Idle memory does not drop
 * (docs/spikes/2026-10-memory-heavy-store.md §10.4): the gain is in what is parsed up front.
 *
 * Nothing is drawn while the chunk arrives (a local file, a few milliseconds); a chunk that fails to load throws into
 * the nearest ErrorBoundary.
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
