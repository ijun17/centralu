import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '../components/Button.jsx'
import { useStore } from '../store/store.js'

/**
 * Leaves a sentence instead of a blank page when the screen crashes (dogfooding, 2026-09-07:
 * "it said there was an error and then went blank").
 *
 * When React has nowhere to catch an exception thrown during render, it unmounts the whole tree —
 * the screen goes blank white. In that state there is nothing the person can tell: not what
 * crashed, not whether there is a way back. This app is a window that stays open all day, so that
 * blank screen reads directly as "the app is dead".
 *
 * So this catches it and says exactly three things: what crashed (the message), where (the first
 * lines of the stack), and the way out (reload). It does not recover automatically — if the same
 * render crashes again, all that is left is a flicker, and what went wrong never becomes visible.
 *
 * The one reason this is a class component: hooks have no equivalent of this spot
 * (componentDidCatch).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Also logs to the console — during development this is what catches the eye first
    console.error('[centralu] render crashed', error, info.componentStack)
    /*
     * And to the host's log, where it outlives a reload (the console does not). Nothing waits for it and nothing can
     * come back from it: a crash report that itself throws would be a second crash on the screen that just crashed.
     */
    try {
      void useStore
        .getState()
        .platform?.diagnostics.reportCrash({ message: error.message, stack: error.stack ?? '', componentStack: info.componentStack ?? '' })
        .catch(() => {})
    } catch {
      // No platform yet, or a port without the call: the console line above is all there is
    }
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    const detail = [error.message, error.stack?.split('\n').slice(1, 4).join('\n')].filter(Boolean).join('\n')
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-floor p-8 text-ink">
        <p className="text-md" data-testid="app-crashed">
          Something in this screen crashed.
        </p>
        <p className="max-w-lg text-center text-sm leading-body text-ink-muted">
          Your sessions are not affected — they run in the agent host, not in this window. Reloading
          rebuilds the screen from the host.
        </p>
        <pre className="readout max-h-40 max-w-lg overflow-auto rounded-md border border-line bg-surface-raised p-3 text-2xs leading-body text-ink-faint">
          {detail}
        </pre>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="md" data-testid="app-crashed-reload" onClick={() => location.reload()}>
            Reload
          </Button>
          <Button
            variant="quiet"
            size="md"
            data-testid="app-crashed-copy"
            onClick={() => void navigator.clipboard?.writeText(`${error.message}\n${error.stack ?? ''}`)}
          >
            Copy details
          </Button>
        </div>
      </div>
    )
  }
}
