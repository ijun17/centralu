import { useEffect, useRef, useState } from 'react'
import type { AppErrorBundle } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'
import type { AppBuilder } from './useAppBuilder.js'

/** The number of stderr lines shown — just the tail. The full bundle goes to the builder session */
const TAIL_LINES = 8

/** A bundle's kind → a line for a person to read */
function titleOf(b: AppErrorBundle): string {
  if (b.kind === 'start') return 'The app could not start'
  if (b.kind === 'crash') return 'The app stopped'
  return `${b.tool ?? 'A tool'} failed`
}

/**
 * A way for an error to reach the builder (M4 C-6) — when the app fails to start, dies, or a tool
 * throws, that bundle's tail is shown below the pinned view, and one press of "Send to builder"
 * hands it to the builder session.
 *
 * **Nothing is sent automatically.** This prevents an agent from repeatedly fixing and breaking
 * things without the person knowing (plan C-6). Sending happens only on that one press by the
 * person, and one bundle is only sent once — the host records that it was sent (`sentAt`) and
 * rejects a second attempt. So a reopened view, or a different dialog, also knows it was "sent."
 *
 * What is shown: the most recent bundle. If the app is stopped (crashed, failed), any bundle
 * regardless of when it happened; otherwise, only a tool failure that happened **after this view was
 * opened** — showing last week's failure while the app is running fine is noise, not a warning. Once
 * a person dismisses it (×), that bundle does not come back. When it re-reads: when the host records
 * a new bundle (the list's `lastErrorAt`), and when the app's status changes. The "changed"
 * notification is not used — a read-only tool's failure does not emit that notification.
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
  /** Opens this app's Runs panel — the place to forget a capability the person declined (Permissions → Forget) lives there */
  onShowRuns: () => void
}) {
  const platform = usePlatform()
  const appId = app?.appId
  const projectId = app?.projectId ?? null
  const status = app?.info.status
  // This value in the list changes whenever the host records a new bundle — including a read-only tool's failure (which does not emit "changed")
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
      .errors(appId, projectId)
      .then((r) => alive && setBundle(r.latest))
      // On a failed read, the old value is left in place — the next signal will trigger a re-read
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [platform, appId, projectId, lastErrorAt, status])

  if (!app || !bundle || dismissed === bundle.at) return null
  const stopped = status === 'crashed' || status === 'failed'
  if (!stopped && bundle.at < since.current) return null

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await platform.apps.sendError(app.appId, app.projectId, bundle.at)
      // The fact that it was sent is recorded by the host — re-reading draws it from that answer (sentAt)
      const r = await platform.apps.errors(app.appId, app.projectId)
      setBundle(r.latest)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const tail = bundle.stderr.slice(-TAIL_LINES)

  /*
   * A call blocked because the person declined a capability (M4 D-4) — this is the person's
   * decision, not a bug in the app. Neither a stack trace nor "Send to builder" is offered: sending
   * it would have the builder agent "fix" perfectly fine code. It states what was declined and where
   * to reverse it (that app's Runs panel, Permissions → Forget). A bundle from an older host does not
   * have this field — its absence means an ordinary failure.
   */
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
            {new Date(bundle.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </time>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {here && (
              <button
                type="button"
                className="rounded-md border border-line bg-surface-floor px-2.5 py-0.5 text-xs text-ink transition-colors hover:border-line-strong"
                onClick={onShowRuns}
                data-testid="error-tail-open-runs"
              >
                Open Runs
              </button>
            )}
            <IconButton label="Hide this note" onClick={() => setDismissed(bundle.at)} testId="error-tail-dismiss" align="right">
              <CloseIcon size={12} />
            </IconButton>
          </span>
        </header>
        <p className="mt-1 whitespace-pre-wrap break-words text-ink-muted" data-testid="error-tail-denied">
          {`You did not allow ${denied.name} to ${denied.text}. This is your decision, not a bug in the app. `}
          {here
            ? 'To change it, open Runs, find it under Permissions and choose Forget. Centralu asks again the next time.'
            : `To change it, open ${denied.name}'s Runs, find it under Permissions and choose Forget. Centralu asks again the next time.`}
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
          {new Date(bundle.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
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
            <button
              type="button"
              className="rounded-md border border-line bg-surface-floor px-2.5 py-0.5 text-xs text-ink transition-colors hover:border-line-strong disabled:opacity-40"
              onClick={() => void send()}
              disabled={busy}
              title="Hand this error to the app's builder session, once"
              data-testid="error-tail-send"
            >
              {busy ? 'Sending…' : 'Send to builder'}
            </button>
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
