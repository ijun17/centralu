import { useState } from 'react'
import type { ToolName } from '@cc/protocol'
import { usePlatform } from '../../../app/PlatformProvider.jsx'
import { useToolMeta } from '../../../store/selectors.js'
import { Modal } from '../../../components/Modal.jsx'
import { Button } from '../../../components/Button.jsx'
import { formatChangedCount } from '../../../app/format.js'
import { useLoad } from '../../../app/useLoad.js'
import { archiveAsksOf } from '../../../store/sessions/lifecycle.js'

/**
 * Delete confirmation.
 *
 * **States plainly what is deleted and what stays behind.**
 * Writing only "this cannot be undone" would not be true — the underlying tool (Claude, Codex)
 * still keeps the conversation, and it can be recovered through '+ → previous conversation.'
 * Making it sound scarier than it is leaves the person unable to clean up, and rows just pile up.
 */

export function ConfirmDelete({
  sessionId,
  name,
  tool,
  onConfirm,
  onCancel,
}: {
  sessionId: string
  name: string
  tool: ToolName
  onConfirm: (deleteWorktree: boolean, deleteExternal: boolean) => void
  onCancel: () => void
}) {
  const platform = usePlatform()
  const toolLabel = useToolMeta(tool).label
  /*
   * Since #204 the session goes to the session archive, and both choices below are about what goes with it **when it is deleted
   * for good** from Settings → Archive. The dialog says so in its first lines: a session that leaves the sidebar with
   * no word about where it went and how it comes back is the retired hide-a-session feature (FR-20).
   *
   * Whether to also delete the original on the tool's side too (dogfooding: "really delete it").
   * **Defaults to deleting it** — it used to default to keeping it, but a person pressing delete
   * actually means to clean up, so a half-delete that "deleted it, but the file is still there"
   * turned out to be the wrong feel (a second dogfooding finding). Turning it off swaps the notice
   * in the same spot to "it stays on the tool's side" (the same grammar as project deletion: the
   * two sentences are never shown together for the person to pick between).
   */
  const [deleteExternal, setDeleteExternal] = useState(true)

  /*
   * Whether this is a worktree session, and whether it has uncommitted changes, is **asked the
   * moment the dialog opens.** The session list only holds the path, not whether it is dirty —
   * that is a fact only the filesystem can answer.
   */
  // Unknown until the host answers, and when it cannot: the dialog then says nothing about a worktree
  const wt = useLoad(() => platform.agents.worktreeStatus(sessionId), [platform, sessionId]).data ?? null
  const [deleteWorktree, setDeleteWorktree] = useState(false)
  // What the host said the archive would lose and Undo does not bring back (#1512): the reason this asks at all, when it is one
  const [losses] = useState(() => archiveAsksOf(sessionId))
  return (
    <Modal onClose={onCancel} testId="confirm-delete">
      <div className="w-[380px] max-w-[calc(90vw/var(--text-zoom))] rounded-lg border border-line bg-surface-side p-4 shadow-(--shadow-modal)">
        <p className="text-md text-ink">Archive this session?</p>
        <p className="mt-1.5 truncate text-sm text-ink-muted">{name}</p>
        {losses.length > 0 && (
          <div className="mt-2 rounded-md border border-danger/40 bg-danger-bg px-2 py-1.5 text-xs leading-body text-ink" data-testid="delete-losses">
            <p>Archiving it drops these, and Undo does not bring them back:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {losses.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-2 text-xs leading-body text-ink-faint" data-testid="delete-trash-note">
          Chat history and attachments stay in Centralu’s session archive, out of the sidebar, search and the agents’ reach.{' '}
          <span className="text-ink">Settings → Archive</span> reads it, restores it, or deletes it for good.
        </p>
        {deleteExternal ? (
          <p
            className="mt-1 rounded-md border border-danger/40 bg-danger-bg px-2 py-1.5 text-xs leading-body text-ink"
            data-testid="delete-external-warning"
          >
            When it is deleted for good,{' '}
            <span className="text-danger">the conversation file in {toolLabel} is deleted too</span> — there will be
            nothing left to pull back.
          </p>
        ) : (
          <p className="mt-1 text-xs leading-body text-ink-muted" data-testid="delete-notice">
            The conversation stays in {toolLabel} — you can pull it back from{' '}
            <span className="text-ink">+ → Past conversations</span>.
          </p>
        )}
        <label
          className={`mt-2 flex cursor-pointer items-start gap-2 text-xs ${
            deleteExternal ? 'text-danger' : 'text-ink-muted hover:text-ink'
          }`}
          data-testid="delete-external-toggle"
        >
          <input
            type="checkbox"
            className={`mt-0.5 ${deleteExternal ? 'accent-danger' : 'accent-ink-muted'}`}
            checked={deleteExternal}
            onChange={(e) => setDeleteExternal(e.target.checked)}
          />
          <span>Delete the {toolLabel} conversation file too, when deleted for good</span>
        </label>

        {/*
          A worktree's **lifetime differs from the session's.** Hours of an agent's work can be
          sitting there, so it defaults to being kept. Deleting it requires the person to turn it
          on by hand — and to read first what would be lost.
        */}
        {wt && (
          <div className="mt-3 rounded-md border border-line bg-surface-raised p-2.5" data-testid="delete-worktree">
            <p className="text-xs text-ink-muted">
              This session ran in a worktree — <span className="font-mono text-ink">{wt.branch}</span>
            </p>
            <p className="mt-1 text-xs text-ink-faint">It stays where it is while the session is in the session archive.</p>
            {wt.dirty && (
              <p className="mt-1 text-xs text-ink" data-testid="worktree-dirty">
                {wt.unknown
                  ? // git did not answer: not known to be clean is not clean (#850 review)
                    'Its changes could not be counted. Uncommitted work in it would be lost once it is deleted.'
                  : `${formatChangedCount(wt.changedFiles, wt.more)} uncommitted ${wt.changedFiles === 1 && !wt.more ? 'change' : 'changes'} would be lost once it is deleted.`}
              </p>
            )}
            <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-xs text-ink-muted hover:text-ink">
              <input
                type="checkbox"
                className="mt-0.5 accent-ink-muted"
                checked={deleteWorktree}
                onChange={(e) => setDeleteWorktree(e.target.checked)}
                data-testid="delete-worktree-toggle"
              />
              <span>
                Delete the worktree too, when deleted for good
                <span className="mt-0.5 block text-2xs break-all text-ink-faint">{wt.path}</span>
              </span>
            </label>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded-md px-2 py-1 text-sm text-ink-faint hover:text-ink" onClick={onCancel}>
            Cancel
          </button>
          <Button variant="primary" onClick={() => onConfirm(deleteWorktree, deleteExternal)} data-testid="confirm-delete-yes">
            Archive
          </Button>
        </div>
      </div>
    </Modal>
  )
}
