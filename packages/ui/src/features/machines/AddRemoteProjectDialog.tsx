import { errorMessage } from '@cc/protocol/client'
import { useState } from 'react'
import { useStore } from '../../store/store.js'
import { useMachineName } from '../../store/selectors.js'
import { Modal } from '../../components/Modal.jsx'
import { Button } from '../../components/Button.jsx'
import { TextField } from '../../components/TextField.jsx'

/**
 * Adds an existing folder on a linked machine as a project (#82). The picker cannot see that machine's disk, so the path
 * is typed in its terms (`/home/me/app`, `C:\Users\me\app`, a WSL path); its host checks it. No "Create a new folder":
 * everywhere a project is an existing folder or a new app.
 */
export function AddRemoteProjectDialog({ machine, onClose }: { machine: string; onClose: () => void }) {
  const name = useMachineName(machine)
  const addProject = useStore((s) => s.addProject)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Modal onClose={onClose} testId="add-remote-project-dialog">
      <form
        className="flex w-[440px] max-w-[calc(92vw/var(--text-zoom))] flex-col overflow-hidden rounded-lg border border-line bg-surface-side shadow-(--shadow-modal)"
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
            setError(errorMessage(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        <header className="shrink-0 border-b border-line px-4 py-2.5">
          <h2 className="text-md font-medium text-ink">
            Add a project <span className="text-ink-faint">·</span> <span className="text-ink-muted">{name}</span>
          </h2>
          <p className="mt-1 text-xs leading-body text-ink-faint">
            A folder on {name}. Its agents, files and terminals run there.
          </p>
        </header>

        <div className="space-y-3 px-4 py-3">
          <TextField
            label="Folder"
            hint={`its path on ${name}, as that machine writes it`}
            autoFocus
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/home/me/project"
            spellCheck={false}
            autoComplete="off"
            font="mono"
            data-testid="add-remote-project-path"
          />
          {error && (
            <p
              className="whitespace-pre-wrap break-words rounded-md border border-line bg-surface-raised px-2.5 py-2 text-xs leading-body text-ink"
              role="alert"
              data-testid="add-remote-project-error"
            >
              {error}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2.5">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!path.trim()}
            busy={busy}
            busyText="Adding…"
            data-testid="add-remote-project-confirm"
          >
            Add project
          </Button>
        </footer>
      </form>
    </Modal>
  )
}
