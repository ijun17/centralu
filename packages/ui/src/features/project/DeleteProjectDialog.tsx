import { useEffect, useState } from 'react'
import { errorMessage, type ProjectInfo } from '@cc/protocol/client'
import { isAway } from '@cc/core'
import { useStore } from '../../store/store.js'
import { useMachineName } from '../../store/selectors.js'
import { Modal } from '../../components/Modal.jsx'
import { Button } from '../../components/Button.jsx'
import { TextInput } from '../../components/TextField.jsx'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { awayNote, folderNote, type DeleteOutlook } from './deleteNote.js'

/** How long the dialog waits for the host's answer about the folder before it goes by the list's mark */
const OUTLOOK_WAIT_MS = 3000

/**
 * Deleting a project: two irreversible actions of different scale. The app's memory goes by default, the folder only
 * when ticked, and then the note turns into a warning in the same spot. Typing the name makes the person read what
 * goes; a lone confirm button gets clicked from memory. Sessions go to Centralu's trash (#204): only Settings deletes
 * a conversation for good. The folder goes to the OS trash, never `rm` (the fs port's rule).
 */
export function DeleteProjectDialog({ project, onClose }: { project: ProjectInfo; onClose: () => void }) {
  const deleteProject = useStore((s) => s.deleteProject)
  const [typed, setTyped] = useState('')
  const [withFiles, setWithFiles] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // What deleting may do to the folder, asked once on open (#1301): the host checks real paths, the list's mark only spelling
  const platform = usePlatform()
  const [outlook, setOutlook] = useState<DeleteOutlook | 'pending' | null>('pending')
  useEffect(() => {
    let current = true
    // The sentence and Delete wait: a guess shown for a moment could be read and confirmed. A host that does not answer
    // in time, or lacks the call, leaves the list's mark deciding
    const gaveUp = setTimeout(() => current && setOutlook(null), OUTLOOK_WAIT_MS)
    platform.projects.deleteOutlook(project.id).then(
      (r) => current && setOutlook(r.folder),
      () => current && setOutlook(null),
    )
    return () => {
      current = false
      clearTimeout(gaveUp)
    }
  }, [platform, project.id])
  // A linked machine that is not connected (#2330): the hub keeps the delete until it reconnects, and the dialog says so.
  // The outlook call is refused at once there, so the list's mark decides the folder's sentence.
  const away = useStore((s) => isAway(project, s.machines))
  const machineName = useMachineName(project.machine)
  // Exact, case included, only whitespace trimmed: a similarly named project may sit right next to it
  const armed = typed.trim() === project.name

  return (
    <Modal onClose={onClose} testId="delete-project-dialog">
      <form
        className="w-[420px] max-w-[calc(92vw/var(--text-zoom))] rounded-lg border border-line bg-surface-side p-4 shadow-(--shadow-modal)"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!armed || busy || outlook === 'pending') return
          setBusy(true)
          setError(null)
          try {
            await deleteProject(project.id, withFiles)
            onClose()
          } catch (err) {
            // Kept in the dialog: a toast vanishes after 2.5 s and reads as "nothing happened"
            setError(errorMessage(err))
            setBusy(false)
          }
        }}
      >
        <h2 className="text-md font-medium text-ink">
          Delete project <span className="text-ink-faint">·</span>{' '}
          <span className="text-ink-muted">{project.name}</span>
        </h2>

        {/* The note becomes the warning in place;
            both at once would make the person pick which is true */}
        {/* Red is the danger token (the diff's delete color): "this disappears".
            The most saturated for the part that reaches uncommitted work */}
        {withFiles ? (
          <p
            className="mt-2 rounded-md border border-danger bg-danger-bg px-2.5 py-2 text-xs leading-body text-ink"
            data-testid="delete-project-warning"
          >
            The folder itself goes to the Trash —{' '}
            <span className="readout text-ink-muted">{project.path}</span> and everything inside it,{' '}
            <span className="text-danger">including work the agents have not committed</span>. Its sessions go
            to Centralu’s session archive; restoring one needs the folder back.
          </p>
        ) : (
          <p className="mt-2 text-xs leading-body text-ink-muted" data-testid="delete-project-note">
            The project leaves Centralu with its always-allow rules and usage. Its sessions go to Centralu’s
            session archive — Settings → Archive restores them or deletes them for good.{' '}
            <span className="text-ink" data-testid="delete-project-folder-note">
              {folderNote(project, outlook)}
            </span>
            {away && machineName && (
              <span className="text-ink" data-testid="delete-project-away-note">
                {' '}
                {awayNote(machineName)}
              </span>
            )}
          </p>
        )}

        {/* No box for a linked machine (#82): the trash is this computer's,
            through the desktop shell, and the folder stays on the other machine */}
        {!project.machine && (
          <label
            className={`mt-3 flex cursor-pointer items-start gap-2 text-xs ${
              withFiles ? 'text-danger' : 'text-ink-muted hover:text-ink'
            }`}
            data-testid="delete-project-files-toggle"
          >
            {/* Red once checked, with the warning */}
            <input
              type="checkbox"
              className={`mt-0.5 ${withFiles ? 'accent-danger' : 'accent-ink-muted'}`}
              checked={withFiles}
              onChange={(e) => setWithFiles(e.target.checked)}
            />
            <span>Move the folder to the Trash too</span>
          </label>
        )}

        {/* The name field comes last:
            typing answers what was just read */}
        <label className="mt-3 block text-xs text-ink-muted" htmlFor="delete-project-name">
          Type <span className="readout text-ink">{project.name}</span> to confirm
        </label>
        <TextInput
          id="delete-project-name"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          data-testid="delete-project-name-input"
          font="mono"
          className="mt-1 w-full"
        />

        {error && (
          <p
            className="mt-3 rounded-md border border-line bg-surface-raised px-2.5 py-2 text-xs leading-body text-ink"
            data-testid="delete-project-error"
          >
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-ink-faint transition-colors hover:text-ink"
          >
            Cancel
          </button>
          {/* Danger too: an irreversible trigger is never neutral */}
          <Button type="submit" variant="danger" disabled={!armed || busy || outlook === 'pending'} data-testid="delete-project-confirm">
            {busy ? 'Deleting…' : withFiles ? 'Delete and trash folder' : 'Delete'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
