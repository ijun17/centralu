import { useState } from 'react'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { Badge } from '../../components/Badge.jsx'
import { Button } from '../../components/Button.jsx'
import { TextInput } from '../../components/TextField.jsx'
import { useStore } from '../../store/store.js'
import { userAppMachine, type ExternalCatalogApp } from '../../store/app-catalog.js'

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
  const trouble = app.info.secretsUnreadable
  if (slots.length === 0) return null
  // Still in place and unreadable: nothing can be saved over it, and the Save button says why instead of failing
  const stuck =
    trouble?.movedTo === null ? `The saved secrets file cannot be read${trouble.reason ? ` (${trouble.reason})` : ''}, so nothing is saved until it is fixed or removed` : null
  return (
    <div data-testid="app-secrets">
      {trouble && <SecretsUnreadable movedTo={trouble.movedTo} reason={trouble.reason} />}
      <ul className="space-y-2">
        {slots.map((s) => (
          <SecretRow key={s.name} app={app} name={s.name} set={s.set} stuck={stuck} />
        ))}
      </ul>
      <p className="mt-2 text-xs leading-body text-ink-faint">
        Values stay on this machine and are never shown again. The app gets a new value the next time it starts.
      </p>
    </div>
  )
}

/**
 * The saved secrets could not be read (#944): said once above the fields. On screen nothing said it before, and a
 * section showing every value missing read as values never entered. Moved aside, the values are in that copy; the line
 * goes once a value is saved again. Still in place, the file has to be fixed or removed first. Why, when the host knows
 * (`reason`, words that never quote the file)
 */
function SecretsUnreadable({ movedTo, reason }: { movedTo: string | null; reason?: string }) {
  return (
    <p className="mb-2 rounded-md border border-danger/40 bg-danger-bg px-2 py-1.5 text-xs leading-body text-ink" role="alert" data-testid="secrets-unreadable">
      {movedTo ? (
        <>
          The saved secrets could not be read{reason ? ` (${reason})` : ''} and were moved to <span className="font-mono">{movedTo}</span> in
          Centralu’s data folder. Enter them again, or restore the file.
        </>
      ) : (
        <>
          The saved secrets file (<span className="font-mono">app-secrets.json</span> in Centralu’s data folder) cannot
          be read{reason ? `: ${reason}` : ''}. Nothing can be saved until it is fixed or removed.
        </>
      )}
    </p>
  )
}

function SecretRow({ app, name, set, stuck }: { app: ExternalCatalogApp; name: string; set: boolean; stuck: string | null }) {
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
      await platform.apps.setSecret(app.appId, app.projectId, name, value, userAppMachine(app.info))
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
    <li className="rounded-md border border-line bg-surface-floor px-2.5 py-2" data-testid={`secret-${name}`} data-set={set || undefined}>
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 truncate font-mono text-ink">{name}</span>
        <span className={`readout ml-auto shrink-0 ${set ? 'text-ink-faint' : 'text-ink'}`} data-testid="secret-state">
          {set ? 'Set' : 'Missing'}
        </span>
        {set && !editing && (
          <>
            <button
              type="button"
              className="shrink-0 rounded-md px-1.5 py-0.5 text-ink-faint transition-colors hover:text-ink"
              onClick={() => setEditing(true)}
              disabled={busy}
              data-testid="secret-replace"
            >
              Replace
            </button>
            <button
              type="button"
              className="shrink-0 rounded-md px-1.5 py-0.5 text-ink-faint transition-colors hover:text-ink-signal"
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
            if (draft && !busy && stuck === null) void write(draft)
          }}
        >
          <TextInput
            size="sm"
            surface="side"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={set ? 'New value' : 'Value'}
            aria-label={`Value for ${name}`}
            className="min-w-0 flex-1"
            data-testid="secret-input"
          />
          {editing && (
            <button
              type="button"
              className="shrink-0 rounded-md px-1.5 py-1 text-xs text-ink-faint transition-colors hover:text-ink"
              onClick={() => {
                setDraft('')
                setEditing(false)
                setError(null)
              }}
            >
              Cancel
            </button>
          )}
          <Button
            type="submit"
            variant="primary"
            size="sm"
            className="shrink-0"
            disabled={!draft || busy || stuck !== null}
            title={stuck ?? undefined}
            data-testid="secret-save"
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </form>
      )}
      {error && (
        <p className="mt-1 break-words text-xs text-ink-muted" role="alert" data-testid="secret-error">
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
        <Badge readout>Secrets</Badge>
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
