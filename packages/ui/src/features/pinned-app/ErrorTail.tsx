import { useEffect, useRef, useState } from 'react'
import { errorMessage, type AppErrorBundle } from '@cc/protocol/client'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { formatClock } from '../../app/format.js'
import { Button } from '../../components/Button.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import { userAppMachine, type ExternalCatalogApp } from '../../store/app-catalog.js'
import type { AppBuilder } from './useAppBuilder.js'

/** Stderr lines shown; the full bundle goes to the builder */
const TAIL_LINES = 8

/** A bundle's kind → a line for a person to read */
function titleOf(b: AppErrorBundle): string {
  if (b.kind === 'start') return 'The app could not start'
  if (b.kind === 'crash') return 'The app stopped'
  return `${b.tool ?? 'A tool'} failed`
}

/**
 * An error's way to the builder (M4 C-6): a start failure, crash or tool throw shows its tail below the view, with
 * "Send to builder". Never automatic (plan C-6: no unseen fix-and-break loop); a bundle goes once, as the host records
 * `sentAt` and refuses a second. Shown: the latest bundle, but while the app runs only a tool failure after this view
 * opened. Dismissed (×), it stays gone. Re-read on `lastErrorAt` and status changes ("changed" skips read-only tools).
 */
export function ErrorTail({
  app,
  builder,
  onShowBuilder,
  onShowRuns,
}: {
  app: ExternalCatalogApp | undefined
  builder: AppBuilder
  onShowBuilder: () => void
  /** Opens this app's Runs panel, where a declined capability is forgotten (Permissions → Forget) */
  onShowRuns: () => void
}) {
  const platform = usePlatform()
  const appId = app?.appId
  const projectId = app?.projectId ?? null
  // A linked machine's user-folder app (#82): its errors, and where they are sent, are that machine's
  const machine = app ? userAppMachine(app.info) : undefined
  const status = app?.info.status
  // Changes with every new bundle, a read-only tool's failure too (which emits no "changed")
  const lastErrorAt = app?.info.lastErrorAt
  const [bundle, setBundle] = useState<AppErrorBundle | null>(null)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** When this view was mounted — while the app is running, only a failure after this point is shown */
  const since = useRef(Date.now())

  useEffect(() => {
    if (!appId) return
    let alive = true
    platform.apps
      .errors(appId, projectId, machine)
      .then((r) => alive && setBundle(r.latest))
      // A failed read keeps the old value until the next signal
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [platform, appId, projectId, machine, lastErrorAt, status])

  if (!app || !bundle || dismissed === bundle.at) return null
  const stopped = status === 'crashed' || status === 'failed'
  if (!stopped && bundle.at < since.current) return null

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await platform.apps.sendError(app.appId, app.projectId, bundle.at, machine)
      // The host records the send; the re-read shows it (sentAt)
      const r = await platform.apps.errors(app.appId, app.projectId, machine)
      setBundle(r.latest)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const tail = bundle.stderr.slice(-TAIL_LINES)

  // Declined by the person (M4 D-4): a decision, not a bug, so no stack or "Send to builder" (the builder would "fix"
  // fine code); it says what and where to undo it (Runs, Permissions → Forget). Without the field (older host): an ordinary failure.
  const denied = bundle.denied ?? null
  if (denied) {
    const here = denied.appId === app.appId && (denied.projectId ?? null) === (app.projectId ?? null)
    return (
      <section
        className="mt-2 shrink-0 rounded-md border border-line bg-surface-raised px-3 py-2 text-sm"
        role="status"
        data-testid="error-tail"
        data-kind={bundle.kind}
        data-denied="true"
      >
        <header className="flex items-center gap-2">
          <span className="min-w-0 truncate text-ink" data-testid="error-tail-title">
            {`${bundle.tool ?? 'A tool'} stopped: you did not allow it`}
          </span>
          <time className="readout shrink-0 text-2xs text-ink-faint" dateTime={new Date(bundle.at).toISOString()}>
            {formatClock(bundle.at, { seconds: true })}
          </time>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {here && (
              <Button variant="primary" onRaised size="sm" onClick={onShowRuns} data-testid="error-tail-open-runs">
                Open Runs
              </Button>
            )}
            <IconButton label="Hide this note" onClick={() => setDismissed(bundle.at)} testId="error-tail-dismiss" align="right">
              <CloseIcon size={12} />
            </IconButton>
          </span>
        </header>
        <p className="mt-1 whitespace-pre-wrap break-words text-ink-muted" data-testid="error-tail-denied">
          {`You did not allow ${denied.name} to ${denied.text}. This is your decision, not a bug in the app. `}
          {`To change it, open ${here ? 'Runs' : `${denied.name}'s Runs`}, find it under Permissions and choose Forget. The app can then do it without asking, unless a session set to Safe calls it.`}
        </p>
      </section>
    )
  }

  return (
    <section className="mt-2 shrink-0 rounded-md border border-line bg-surface-raised px-3 py-2 text-sm" role="alert" data-testid="error-tail" data-kind={bundle.kind}>
      <header className="flex items-center gap-2">
        <span className="min-w-0 truncate text-ink" data-testid="error-tail-title">
          {titleOf(bundle)}
        </span>
        <time className="readout shrink-0 text-2xs text-ink-faint" dateTime={new Date(bundle.at).toISOString()}>
          {formatClock(bundle.at, { seconds: true })}
        </time>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {bundle.sentAt !== null ? (
            <span className="flex items-center gap-2 text-xs text-ink-faint" data-testid="error-tail-sent">
              Sent to the builder.
              {/* No builder any more (its session was deleted): nothing to show, and the no-builder bar below offers to start one */}
              {builder.id && (
                <button
                  type="button"
                  className="text-ink-muted underline-offset-2 hover:text-ink hover:underline"
                  onClick={onShowBuilder}
                  data-testid="error-tail-show-builder"
                >
                  Show
                </button>
              )}
            </span>
          ) : builder.id ? (
            <Button
              variant="primary"
              onRaised
              size="sm"
              onClick={() => void send()}
              busy={busy}
              busyText="Sending…"
              title="Hand this error to the app's builder session, once"
              data-testid="error-tail-send"
            >
              Send to builder
            </Button>
          ) : (
            <span className="text-xs text-ink-faint">Start a builder to send it.</span>
          )}
          <IconButton label="Hide this error" onClick={() => setDismissed(bundle.at)} testId="error-tail-dismiss" align="right">
            <CloseIcon size={12} />
          </IconButton>
        </span>
      </header>
      <p className="mt-1 whitespace-pre-wrap break-words text-ink-muted" data-testid="error-tail-message">
        {bundle.message}
      </p>
      {tail.length > 0 && (
        <pre
          className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-floor px-2 py-1 font-mono text-xs leading-body text-ink-muted"
          data-testid="error-tail-stderr"
        >
          {tail.join('\n')}
        </pre>
      )}
      {error && (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-ink-muted" data-testid="error-tail-error">
          {error}
        </p>
      )}
    </section>
  )
}
