import { useEffect, useState } from 'react'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { isPlainEscape } from '../../app/keys.js'
import { Modal } from '../../components/Modal.jsx'
import { useStore } from '../../store/store.js'

type Preview = { parent: string; path: string | null; error: string | null }

/**
 * Making a new project (#515): an empty folder, named here, on the Desktop of the machine it is for unless another
 * location is given. The machine's own host says where that is and whether the name is free, as the person types, so
 * the folder that will be made stands on the form before anything is made. A folder of that name already there is
 * refused, never reused.
 *
 * `machine` null is this computer. On a linked machine the location is typed in that machine's terms; on this one the
 * folder picker can choose it too.
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
  // Null: the machine's Desktop. A typed location is sent as typed; the host says whether it is a folder
  const [parent, setParent] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    // Asked after a pause in typing: on a linked machine every question crosses the link
    const t = setTimeout(() => {
      platform.projects
        .createPreview(name.trim(), parent?.trim() || undefined, machine)
        .then((p) => live && setPreview(p))
        .catch((e: Error) => live && setPreview({ parent: parent ?? '', path: null, error: e.message }))
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [platform, name, parent, machine])

  const ready = !!name.trim() && !!preview?.path && !busy
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
          await createProject(name.trim(), parent?.trim() || undefined, machine)
          onDone()
        } catch (err) {
          // Kept in the form with what was typed: a toast would vanish and take the reason with it
          setError((err as Error).message)
        } finally {
          setBusy(false)
        }
      }}
      data-testid="create-project-form"
    >
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
        placeholder="my-project"
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
            An empty folder will be made at{' '}
            <span className="readout break-all text-ink-muted" data-testid="create-project-path">
              {preview.path}
            </span>
          </>
        ) : (
          'An empty folder is made there and added as a project. Nothing already there is reused.'
        )}
      </p>
      {(error ?? (name.trim() ? preview?.error : null)) && (
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
          {busy ? 'Creating…' : 'Create project'}
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
