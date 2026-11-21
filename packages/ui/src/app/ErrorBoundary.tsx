import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '../components/Button.jsx'
import { useCopied } from './useCopied.js'
import { APP_VERSION } from '@cc/protocol/client'
import type { Platform } from '@cc/platform/ports'

/** The host cuts each field too; this keeps a long stack from making it refuse the whole report */
const REPORT_FIELD_MAX = 20_000
const cut = (s: string) => s.slice(0, REPORT_FIELD_MAX)

/** To the host's log, which outlives a reload. Never throws: that would be a second crash on the crashed screen */
export function reportCrash(platform: Platform | null | undefined, thrown: unknown, componentStack: string | null | undefined): void {
  try {
    const error = thrown instanceof Error ? thrown : null
    void platform?.diagnostics
      .reportCrash({
        message: cut(error ? error.message : String(thrown)),
        stack: cut(error?.stack ?? ''),
        componentStack: cut(componentStack ?? ''),
        version: APP_VERSION,
      })
      .catch(() => {})
  } catch {
    // A platform without the call, or a port that throws at once: the console line is all there is
  }
}

/**
 * Shows what crashed, where, and Reload instead of the blank page React leaves. No automatic recovery: a render that
 * crashes again would only flicker. A class because hooks have no componentDidCatch.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; platform: Platform }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[centralu] render crashed', error, info.componentStack)
    reportCrash(this.props.platform, error, info.componentStack)
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
          <CopyDetails text={`${error.message}
${error.stack ?? ''}`} />
        </div>
      </div>
    )
  }
}

function CopyDetails({ text }: { text: string }) {
  const { copied, copy } = useCopied()
  return (
    <Button variant="quiet" size="md" data-testid="app-crashed-copy" onClick={() => copy(text)}>
      {copied ? 'Copied' : 'Copy details'}
    </Button>
  )
}
