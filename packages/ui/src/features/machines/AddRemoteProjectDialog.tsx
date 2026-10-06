import { useState } from 'react'
import { useStore } from '../../store/store.js'
import { useMachineName } from '../../store/selectors.js'
import { Modal } from '../../components/Modal.jsx'

/**
 * Adds a folder on a linked machine as a project (#82). The folder picker is this computer's, and cannot see another
 * machine's disk, so the path is typed, in that machine's own terms (`/home/me/app`, `C:\Users\me\app`, or a path
 * inside the WSL distro). The machine's host checks it exists and answers with the project, named as the hub names it.
 */
export function AddRemoteProjectDialog({ machine, onClose }: { machine: string; onClose: () => void }) {
  const name = useMachineName(machine) ?? machine
  const addProject = useStore((s) => s.addProject)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Modal onClose={onClose} testId="add-remote-project-dialog">
      <form
        className="w-[420px] max-w-[calc(92vw/var(--text-zoom))] rounded-lg border border-line bg-surface-side p-4 shadow-(--shadow-modal)"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!path.trim()) return
          setBusy(true)
          setError(null)
          try {
            await addProject(path.trim(), machine)
            onClose()
          } catch (err) {
            // Kept in the dialog, with the typed path: a toast would vanish and take the reason with it
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <p className="text-md text-ink">Add a project on {name}</p>
        <p className="mt-1.5 text-xs leading-body text-ink-muted">
          The folder&apos;s path on {name}, as that machine writes it. Its agents, files and terminals run there.
        </p>
        <input
          autoFocus
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') onClose()
          }}
          placeholder="/home/me/project"
          spellCheck={false}
          autoComplete="off"
          data-testid="add-remote-project-path"
          className="mt-3 w-full rounded-md border border-line bg-surface-floor px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
        />
        {error && (
          <p className="mt-2 text-xs leading-body text-danger" data-testid="add-remote-project-error">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-md px-2 py-1 text-sm text-ink-faint hover:text-ink" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !path.trim()}
            className="rounded-md border border-line bg-surface-raised px-3 py-1 text-sm text-ink transition-colors hover:border-line-strong disabled:opacity-50"
            data-testid="add-remote-project-confirm"
          >
            {busy ? 'Adding…' : 'Add project'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
