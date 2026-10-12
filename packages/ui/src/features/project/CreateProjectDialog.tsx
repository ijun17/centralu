import { useEffect, useState } from 'react'
import { repoNameOf, type GitSource } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { isPlainEscape } from '../../app/keys.js'
import { Modal } from '../../components/Modal.jsx'
import { useStore } from '../../store/store.js'

type Preview = { parent: string; path: string | null; error: string | null }

/**
 * Making a new project (#515): an empty folder, named here, in `~/Centralu` on the machine it is for unless another
 * location is given (made on first use). The machine's own host says where that is and whether the name is free, as the person types, so
 * the folder that will be made stands on the form before anything is made. A folder of that name already there is
 * refused, never reused.
 *
 * `machine` null is this computer. On a linked machine the location is typed in that machine's terms; on this one the
 * folder picker can choose it too.
 *
 * Or a clone of a git repository: the folder is named after it unless a name is given, and that machine's own git
 * clones it with the sign-ins it has saved, never asking for one. While it runs the form says so; a clone that fails
 * leaves nothing behind, and one that outlasts the call joins the sidebar when it lands.
 */
export function CreateProjectForm({
  machine,
  onDone,
  onCancel,
}: {
  machine: string | null
  onDone: () => void
  onCancel: () => void
}) {
  const platform = usePlatform()
  const createProject = useStore((s) => s.createProject)
  const [name, setName] = useState('')
  // Null: the machine's ~/Centralu. A typed location is sent as typed; the host says whether it is a folder
  const [parent, setParent] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clone, setClone] = useState(false)
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('')
  const source: GitSource | undefined = clone && url.trim() ? { git: url.trim(), ...(branch.trim() ? { branch: branch.trim() } : {}) } : undefined
  const sourceKey = source ? `${source.git}\n${source.branch ?? ''}` : ''

  useEffect(() => {
    let live = true
    // Asked after a pause in typing: on a linked machine every question crosses the link
    const t = setTimeout(() => {
      platform.projects
        .createPreview(name.trim(), parent?.trim() || undefined, machine, source)
        .then((p) => live && setPreview(p))
        .catch((e: Error) => live && setPreview({ parent: parent ?? '', path: null, error: e.message }))
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
    // `source` is rebuilt every render; its key is what changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, name, parent, machine, sourceKey])

  const ready = (!!name.trim() || !!source) && !!preview?.path && !busy
  const field =
    'w-full rounded-md border border-line bg-surface-floor px-2 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none'

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        if (!ready) return
        setBusy(true)
        setError(null)
        try {
          await createProject(name.trim(), parent?.trim() || undefined, machine, source)
          onDone()
        } catch (err) {
          // Kept in the form with what was typed: a toast would vanish and take the reason with it
          const message = (err as Error).message
          // The call gave up waiting, not the clone: it goes on, and lands in the sidebar or leaves nothing
          setError(
            source && /timed out|in time/i.test(message)
              ? 'Still cloning — the project joins the sidebar when it is done, and nothing is left if it fails.'
              : message,
          )
        } finally {
          setBusy(false)
        }
      }}
      data-testid="create-project-form"
    >
      <label className="mt-3 flex items-center gap-2 text-xs text-ink-muted">
        <input
          type="checkbox"
          checked={clone}
          onChange={(e) => setClone(e.target.checked)}
          data-testid="create-project-clone"
        />
        Clone a git repository into it
      </label>
      {clone && (
        <div className="mt-2 flex gap-2">
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (isPlainEscape(e.nativeEvent)) onCancel()
            }}
            placeholder="https://github.com/owner/repo.git or git@host:owner/repo.git"
            spellCheck={false}
            autoComplete="off"
            data-testid="create-project-git"
            className={`min-w-0 flex-1 font-mono ${field}`}
          />
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (isPlainEscape(e.nativeEvent)) onCancel()
            }}
            placeholder="branch"
            spellCheck={false}
            autoComplete="off"
            data-testid="create-project-branch"
            className={`w-24 shrink-0 font-mono ${field}`}
          />
        </div>
      )}
      <label className="mt-3 block text-xs text-ink-muted" htmlFor="create-project-name">
        Folder name
      </label>
      <input
        id="create-project-name"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (isPlainEscape(e.nativeEvent)) onCancel()
        }}
        placeholder={(source && repoNameOf(source.git)) || 'my-project'}
        spellCheck={false}
        autoComplete="off"
        data-testid="create-project-name"
        className={`mt-1 ${field}`}
      />
      <div className="mt-2 text-xs leading-body text-ink-muted">
        {parent === null ? (
          <p>
            In <span className="readout break-all text-ink" data-testid="create-project-parent-shown">{preview?.parent ?? '…'}</span>{' '}
            <button
              type="button"
              className="text-ink-faint underline-offset-2 hover:text-ink hover:underline"
              onClick={() => setParent(preview?.parent ?? '')}
              data-testid="create-project-change-parent"
            >
              Change
            </button>
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <input
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (isPlainEscape(e.nativeEvent)) onCancel()
              }}
              placeholder={machine ? 'The full path of a folder there' : 'The full path of a folder'}
              spellCheck={false}
              autoComplete="off"
              data-testid="create-project-parent"
              className={`font-mono ${field}`}
            />
            {machine === null && (
              <button
                type="button"
                className="shrink-0 rounded-md px-2 py-1 text-xs text-ink-faint hover:text-ink"
                onClick={async () => {
                  const picked = await platform.system.pickDirectory()
                  if (picked) setParent(picked)
                }}
                data-testid="create-project-pick-parent"
              >
                Choose…
              </button>
            )}
          </div>
        )}
      </div>
      <p className="mt-2 text-xs leading-body text-ink-faint">
        {preview?.path ? (
          <>
            {source ? 'It will be cloned into' : 'An empty folder will be made at'}{' '}
            <span className="readout break-all text-ink-muted" data-testid="create-project-path">
              {preview.path}
            </span>
          </>
        ) : (
          source
            ? "Cloned with that machine's own git and saved sign-ins, without submodules. Nothing already there is reused."
            : 'An empty folder is made there and added as a project. Nothing already there is reused.'
        )}
      </p>
      {busy && source && (
        <p className="mt-2 text-xs leading-body text-ink-muted" data-testid="create-project-cloning">
          Cloning {source.git}… a large repository can take a few minutes.
        </p>
      )}
      {(error ?? (name.trim() || source ? preview?.error : null)) && (
        <p className="mt-2 text-xs leading-body text-danger" data-testid="create-project-error">
          {error ?? preview?.error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="rounded-md px-2 py-1 text-sm text-ink-faint hover:text-ink" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          disabled={!ready}
          className="rounded-md border border-line bg-surface-raised px-3 py-1 text-sm text-ink transition-colors hover:border-line-strong disabled:opacity-50"
          data-testid="create-project-confirm"
        >
          {busy ? (source ? 'Cloning…' : 'Creating…') : source ? 'Clone project' : 'Create project'}
        </button>
      </div>
    </form>
  )
}

/** The form alone in a dialog — this computer's "New folder" beside Add project (#515) */
export function CreateProjectDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} testId="create-project-dialog">
      <div className="w-[420px] max-w-[calc(92vw/var(--text-zoom))] rounded-lg border border-line bg-surface-side p-4 shadow-(--shadow-modal)">
        <p className="text-md text-ink">Create a project</p>
        <p className="mt-1.5 text-xs leading-body text-ink-muted">A new, empty folder on this computer, added as a project.</p>
        <CreateProjectForm machine={null} onDone={onClose} onCancel={onClose} />
      </div>
    </Modal>
  )
}
