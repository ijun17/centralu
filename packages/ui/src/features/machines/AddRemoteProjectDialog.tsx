import { useState } from 'react'
import { useStore } from '../../store/store.js'
import { useMachineName } from '../../store/selectors.js'
import { Modal } from '../../components/Modal.jsx'
import { Button } from '../../components/Button.jsx'
import { TextField } from '../../components/TextField.jsx'
import { isPlainEscape } from '../../app/keys.js'

/**
 * Adds a folder on a linked machine as a project (#82). The folder picker is this computer's, and cannot see another
 * machine's disk, so the path is typed, in that machine's own terms (`/home/me/app`, `C:\Users\me\app`, or a path
 * inside the WSL distro). The machine's host checks it exists and answers with the project, named as the hub names it.
 *
 * It only adds a folder that is there (owner, 2026-10-21): the "Create a new folder" tab went with the sidebar's
 * "New folder as a project", so a project comes to be in two ways everywhere, an existing folder or a new app. Drawn as
 * the other dialogs are (header, body, footer; `TextField`, `Button`), docs/design-system.md §11.
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
        className="flex w-[440px] max-w-[calc(92vw/var(--text-zoom))] flex-col overflow-hidden rounded-lg border border-line bg-surface-side shadow-(--shadow-modal)"
        onKeyDown={(e) => {
          // Not the Esc that cancels a composition in the path field (#181)
          if (isPlainEscape(e.nativeEvent)) onClose()
        }}
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
