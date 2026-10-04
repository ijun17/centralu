import { useState } from 'react'
import type { ProjectInfo } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { Modal } from '../../components/Modal.jsx'

/**
 * Deleting a project (a dogfooding request).
 *
 * **There are two irreversible actions here, and they are different in scale.** One is this app's
 * own memory disappearing (sessions, conversations, the search index); the other is a folder on
 * disk disappearing. So this dialog does only the first by default, and the person has to turn the
 * second on by hand — and the moment it is turned on, **the description text turns into a warning.**
 * The sentence changes in the same spot, so there is no need to look elsewhere to see what changed.
 *
 * Why typing the name is required: this dialog must have no path a person can slip through by
 * mistake. A dialog with just one confirm button is something the hand can click through from
 * memory, and once through, there is nothing to undo. While typing the name, the person reads once
 * what they are about to delete — that is the entire point of this device.
 *
 * **Its sessions go to Centralu's trash (#204), not with it** — only Settings deletes a conversation for good, and
 * a project took every one of its conversations at once. Both sentences below say so, and where to find them.
 *
 * The files go **to the trash.** Exactly the app's own file rule (the fs port: "Not a delete — that
 * is the whole decision"). Leaving the OS one path back is better than calling `rm` ourselves and
 * permanently destroying a person's uncommitted work.
 */
export function DeleteProjectDialog({ project, onClose }: { project: ProjectInfo; onClose: () => void }) {
  const deleteProject = useStore((s) => s.deleteProject)
  const [typed, setTyped] = useState('')
  const [withFiles, setWithFiles] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Only whitespace is trimmed off; it must match exactly, including case — a similarly named project may sit right next to it
  const armed = typed.trim() === project.name

  return (
    <Modal onClose={onClose} testId="delete-project-dialog">
      <form
        className="w-[420px] max-w-[calc(92vw/var(--text-zoom))] rounded-lg border border-line bg-surface-side p-4 shadow-(--shadow-modal)"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!armed || busy) return
          setBusy(true)
          setError(null)
          try {
            await deleteProject(project.id, withFiles)
            onClose()
          } catch (err) {
            // A toast disappears after 2.5 seconds and would look like "nothing happened when pressed" — kept inside the dialog instead
            setError((err as Error).message)
            setBusy(false)
          }
        }}
      >
        <h2 className="text-[13px] font-medium text-ink">
          Delete project <span className="text-ink-faint">·</span>{' '}
          <span className="text-ink-muted">{project.name}</span>
        </h2>

        {/*
          The description turns into a warning in the same spot. Showing both sentences together
          would make the person choose which one describes what is actually about to happen, and
          that choosing is not something that should happen here.
        */}
        {/*
          The dangerous state is **red** (a dogfooding request). The color is the danger token,
          which has the diff's delete values (--color-danger) — red already means "this is disappearing" in this app, so
          this extends the existing language rather than inventing a new one. The most painful
          sentence (it reaches even uncommitted work) is the most saturated.
        */}
        {withFiles ? (
          <p
            className="mt-2 rounded border border-danger/40 bg-danger-bg px-2.5 py-2 text-[11px] leading-relaxed text-ink"
            data-testid="delete-project-warning"
          >
            The folder itself goes to the Trash — <span className="readout text-ink-muted">{project.path}</span> and
            everything inside it, <span className="text-danger">including work the agents have not committed</span>.
            Its sessions go to Centralu’s trash; restoring one needs the folder back.
          </p>
        ) : (
          <p className="mt-2 text-[11px] leading-relaxed text-ink-muted" data-testid="delete-project-note">
            The project leaves Centralu with its always-allow rules and usage. Its sessions go to Centralu’s trash —
            Settings → Trash restores them or deletes them for good.{' '}
            <span className="text-ink">The folder on disk is left alone.</span>
          </p>
        )}

        <label
          className={`mt-3 flex cursor-pointer items-start gap-2 text-[11px] ${
            withFiles ? 'text-danger' : 'text-ink-muted hover:text-ink'
          }`}
          data-testid="delete-project-files-toggle"
        >
          {/* The checkbox turns red the moment it is checked — the same palette as the warning, at the same moment */}
          <input
            type="checkbox"
            className={`mt-0.5 ${withFiles ? 'accent-danger' : 'accent-ink-muted'}`}
            checked={withFiles}
            onChange={(e) => setWithFiles(e.target.checked)}
          />
          <span>Move the folder to the Trash too</span>
        </label>

        {/*
          The name field sits **at the very bottom.** The order has to be reading the description
          (or warning) above and then coming down to it, so typing is an answer to what was just
          read.
        */}
        <label className="mt-3 block text-[11px] text-ink-muted" htmlFor="delete-project-name">
          Type <span className="readout text-ink">{project.name}</span> to confirm
        </label>
        <input
          id="delete-project-name"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          data-testid="delete-project-name-input"
          className="mt-1 w-full rounded border border-line bg-surface-floor px-2 py-1.5 font-mono text-[11px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
        />

        {error && (
          <p
            className="mt-3 rounded border border-line bg-surface-raised px-2.5 py-2 text-[11px] leading-relaxed text-ink"
            data-testid="delete-project-error"
          >
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-[12px] text-ink-faint transition-colors hover:text-ink"
          >
            Cancel
          </button>
          {/* The action button is also in the delete palette — the trigger for something irreversible must not be a neutral color */}
          <button
            type="submit"
            disabled={!armed || busy}
            data-testid="delete-project-confirm"
            className="rounded border border-danger/40 bg-danger-bg px-3 py-1 text-[12px] text-danger transition-colors hover:border-danger/70 disabled:opacity-40"
          >
            {busy ? 'Deleting…' : withFiles ? 'Delete and trash folder' : 'Delete'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
