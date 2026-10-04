import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppReview } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { Modal } from '../../components/Modal.jsx'
import { useStore } from '../../store/store.js'
import { AppReviewDetails } from './AppReviewDetails.jsx'

const inputClass =
  'w-full rounded-md border border-line bg-surface-floor px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none'

/**
 * Import an app (M4 E-3) — from a folder, a .zip, or an https link to a .zip, into the user
 * folder. A deep link (E-4) opens this same dialog.
 *
 * Two steps. Choosing a **source** and clicking Review moves it into a staging area where the
 * host examines it (it has not been brought in yet); the **confirm** step shows what it runs,
 * what it will use, what secrets it wants, and its files, before it is brought in. An imported
 * app arrives turned off ("Import"). "Import and enable" brings it in and turns it on in the same
 * step — it sends the host exactly the key to the window the person just looked at (what the
 * person saw is what gets turned on).
 *
 * A window opened by a link only pre-fills the source — **nothing is read or downloaded before
 * Review is clicked.** The person clicked the link, but somebody else made it — this machine
 * sending a request to somebody else's address still has to wait for the person to choose to do
 * so.
 */
export function ImportAppDialog() {
  const request = useStore((s) => s.importDialog)
  if (!request) return null
  // A new request (a different link) stands up a fresh window — so a half-reviewed confirmation is never mixed with a different source's
  return <ImportDialogBody key={request.at} source={request.source} fromLink={request.fromLink} />
}

function ImportDialogBody({ source: initial, fromLink }: { source: string; fromLink: boolean }) {
  const platform = usePlatform()
  const close = useStore((s) => s.closeImport)
  const openApp = useStore((s) => s.openApp)
  const setToast = useStore((s) => s.setToast)
  const refresh = useStore((s) => s.refreshExternalApps)
  const [source, setSource] = useState(initial)
  const [staged, setStaged] = useState<{ token: string; review: AppReview } | null>(null)
  const [busy, setBusy] = useState<null | 'reading' | 'importing'>(null)
  const [error, setError] = useState<string | null>(null)
  // When the window closes (cancel, esc, clicking outside), the staging area is cleaned up — nothing that was never imported is left behind on the host
  const pending = useRef<string | null>(null)
  useEffect(() => () => void (pending.current && platform.apps.importCancel(pending.current).catch(() => {})), [platform])

  const review = async () => {
    if (!source.trim() || busy) return
    setBusy('reading')
    setError(null)
    try {
      const got = await platform.apps.importPrepare(source.trim())
      pending.current = got.token
      setStaged(got)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const commit = async (enable: boolean) => {
    if (!staged || busy) return
    setBusy('importing')
    setError(null)
    try {
      const app = await platform.apps.importCommit(staged.token, { enable, reviewKey: staged.review.reviewKey })
      pending.current = null
      void refresh()
      close()
      setToast(enable ? `Imported and enabled ${app.name ?? app.appId}` : `Imported ${app.name ?? app.appId}. It stays off until you enable it`)
      // Goes to the imported app — if it was enabled, the app itself; if not, the pre-enable confirmation stands
      openApp(app.projectId, app.appId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const back = useCallback(() => {
    if (pending.current) void platform.apps.importCancel(pending.current).catch(() => {})
    pending.current = null
    setStaged(null)
    setError(null)
  }, [platform])

  const pick = async (kind: 'folder' | 'zip') => {
    const picked = kind === 'folder' ? await platform.system.pickDirectory() : await platform.system.pickFile({ title: 'Choose an app .zip', extensions: ['zip'] })
    if (picked) setSource(picked)
  }

  const https = /^https:/i.test(source.trim())
  return (
    <Modal onClose={close} testId="import-app-dialog" align="top">
      <div className="flex max-h-[calc(80vh/var(--text-zoom))] w-[520px] max-w-[calc(92vw/var(--text-zoom))] flex-col overflow-hidden rounded-lg border border-line bg-surface-side shadow-(--shadow-modal)">
        <header className="shrink-0 border-b border-line px-4 py-2.5">
          <h2 className="text-md font-medium text-ink">
            Import an app <span className="text-ink-faint">·</span> <span className="text-ink-muted">Your apps</span>
          </h2>
          <p className="mt-1 text-xs leading-body text-ink-faint">
            It arrives turned off. You see what it runs before you turn it on.
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {!staged ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault()
                void review()
              }}
            >
              {fromLink && (
                <p className="rounded-md border border-line bg-surface-raised px-2.5 py-2 text-xs leading-body text-ink-muted" data-testid="import-from-link">
                  A link asked Centralu to import this app. Nothing is read or downloaded until you choose Review.
                </p>
              )}
              <label className="block">
                <span className="mb-1 block text-2xs text-ink-muted">Folder, .zip file, or https link to a .zip</span>
                <input
                  autoFocus
                  type="text"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="/Users/you/Downloads/notes.zip"
                  spellCheck={false}
                  className={inputClass}
                  data-testid="import-source"
                />
              </label>
              <div className="flex gap-2">
                <button type="button" className="rounded-md px-2 py-0.5 text-xs text-ink-faint transition-colors hover:text-ink" onClick={() => void pick('folder')} data-testid="import-pick-folder">
                  Choose folder…
                </button>
                <button type="button" className="rounded-md px-2 py-0.5 text-xs text-ink-faint transition-colors hover:text-ink" onClick={() => void pick('zip')} data-testid="import-pick-zip">
                  Choose .zip…
                </button>
              </div>
            </form>
          ) : (
            <AppReviewDetails review={staged.review} />
          )}
          {error && (
            <p className="mt-3 whitespace-pre-wrap break-words rounded-md border border-line bg-surface-raised px-2.5 py-2 text-xs leading-body text-ink" role="alert" data-testid="import-error">
              {error}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2.5">
          {staged ? (
            <>
              <button type="button" className="mr-auto rounded-md px-2 py-1 text-sm text-ink-faint transition-colors hover:text-ink" onClick={back} disabled={!!busy}>
                Back
              </button>
              <button type="button" className="rounded-md px-2 py-1 text-sm text-ink-faint transition-colors hover:text-ink" onClick={close} data-testid="import-cancel">
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md border border-line px-3 py-1 text-sm text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
                onClick={() => void commit(false)}
                disabled={!!busy}
                data-testid="import-commit"
              >
                Import
              </button>
              <button
                type="button"
                className="rounded-md border border-line bg-surface-raised px-3 py-1 text-sm text-ink transition-colors hover:border-line-strong disabled:opacity-40"
                onClick={() => void commit(true)}
                disabled={!!busy}
                data-testid="import-enable"
              >
                {busy === 'importing' ? 'Importing…' : 'Import and enable'}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="rounded-md px-2 py-1 text-sm text-ink-faint transition-colors hover:text-ink" onClick={close} data-testid="import-cancel">
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md border border-line bg-surface-raised px-3 py-1 text-sm text-ink transition-colors hover:border-line-strong disabled:opacity-40"
                onClick={() => void review()}
                disabled={!source.trim() || !!busy}
                data-testid="import-review"
              >
                {busy === 'reading' ? (https ? 'Downloading…' : 'Reading…') : 'Review'}
              </button>
            </>
          )}
        </footer>
      </div>
    </Modal>
  )
}
