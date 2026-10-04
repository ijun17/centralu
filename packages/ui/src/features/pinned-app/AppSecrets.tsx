import { useState } from 'react'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'

/**
 * An app's secrets (M4 E) — for each name the manifest declares, whether it has a value, and a field
 * to set, replace or clear it.
 *
 * **The value never comes back.** The host's list only carries set or not set (so the value never
 * rides a broadcast), and this field forgets the value it sent right away. That is why "Replace" is
 * not a field that shows the old value for editing, it is an empty field for entering a new one. It
 * is a password field, so the characters stay hidden even while sharing the screen during a call. A
 * value that was set reaches the app **the next time it starts** (a running app is brought down by
 * the host once its current call finishes) — that fact is stated in one line.
 *
 * The pinned view's panel and the settings screen's app row share this one component.
 */
export function AppSecrets({ app }: { app: ExternalCatalogApp }) {
  const slots = app.info.secrets ?? []
  if (slots.length === 0) return null
  return (
    <div data-testid="app-secrets">
      <ul className="space-y-2">
        {slots.map((s) => (
          <SecretRow key={s.name} app={app} name={s.name} set={s.set} />
        ))}
      </ul>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
        Values stay on this machine and are never shown again. The app gets a new value the next time it starts.
      </p>
    </div>
  )
}

function SecretRow({ app, name, set }: { app: ExternalCatalogApp; name: string; set: boolean }) {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  const refresh = useStore((s) => s.refreshExternalApps)
  // The field only opens when empty or when "Replace" is pressed — a field that would hide a value already set is not kept standing all the time
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = !set || editing

  const write = async (value: string | null) => {
    setBusy(true)
    setError(null)
    try {
      await platform.apps.setSecret(app.appId, app.projectId, name, value)
      // Once sent, it is forgotten — this field has no more reason to hold the value
      setDraft('')
      setEditing(false)
      setToast(value === null ? `Cleared ${name}` : `Saved ${name}. ${app.title} gets it the next time it starts`)
      void refresh()
    } catch (e) {
      // Exactly the host's own wording — that wording never contains the value (the host never carries it)
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="rounded border border-line bg-surface-floor px-2.5 py-2" data-testid={`secret-${name}`} data-set={set || undefined}>
      <div className="flex items-center gap-2 text-[11px]">
        <span className="min-w-0 truncate font-mono text-ink">{name}</span>
        <span className={`readout ml-auto shrink-0 ${set ? 'text-ink-faint' : 'text-ink'}`} data-testid="secret-state">
          {set ? 'Set' : 'Missing'}
        </span>
        {set && !editing && (
          <>
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 text-ink-faint transition-colors hover:text-ink"
              onClick={() => setEditing(true)}
              disabled={busy}
              data-testid="secret-replace"
            >
              Replace
            </button>
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 text-ink-faint transition-colors hover:text-ink-signal"
              onClick={() => void write(null)}
              disabled={busy}
              data-testid="secret-clear"
            >
              Clear
            </button>
          </>
        )}
      </div>
      {open && (
        <form
          className="mt-1.5 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (draft && !busy) void write(draft)
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={set ? 'New value' : 'Value'}
            aria-label={`Value for ${name}`}
            className="min-w-0 flex-1 rounded border border-line bg-surface-side px-2 py-1 text-[11px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            data-testid="secret-input"
          />
          {editing && (
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-1 text-[11px] text-ink-faint transition-colors hover:text-ink"
              onClick={() => {
                setDraft('')
                setEditing(false)
                setError(null)
              }}
            >
              Cancel
            </button>
          )}
          <button
            className="shrink-0 rounded border border-line bg-surface-raised px-2 py-1 text-[11px] text-ink transition-colors hover:border-line-strong disabled:opacity-40"
            disabled={!draft || busy}
            data-testid="secret-save"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}
      {error && (
        <p className="mt-1 break-words text-[11px] text-ink-muted" role="alert" data-testid="secret-error">
          {error}
        </p>
      )}
    </li>
  )
}

/** A panel that opens and closes beside the pinned view (same spot and shape as the Runs panel) — where a missing key is discovered while using the app */
export function SecretsPanel({ app }: { app: ExternalCatalogApp }) {
  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-surface-side" data-testid="secrets-panel" aria-label="Secrets">
      <header className="flex h-8 shrink-0 items-center border-b border-line px-3">
        <span className="readout text-[10px] uppercase text-ink-faint">Secrets</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <AppSecrets app={app} />
      </div>
    </aside>
  )
}

/** The count of unset secrets — the pinned view's header and the settings row state "what is missing" in one word */
export function missingSecrets(app: ExternalCatalogApp | undefined): number {
  return app?.info.secrets?.filter((s) => !s.set).length ?? 0
}
