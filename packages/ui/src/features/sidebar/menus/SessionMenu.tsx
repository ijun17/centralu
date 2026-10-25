import type { SessionSummary } from '@cc/core'
import { RowMenu } from './RowMenu.jsx'
import { ActionRow } from './ActionRow.jsx'
import { archiveNeedsAsk } from '../../../store/sessions/lifecycle.js'

/**
 * The action menu on a session row (dogfooding: the hover icons grew to four — pencil, handoff,
 * worktree, delete. The same reason the project row moved from three icons to a menu applies:
 * **names are needed.** There is no way to know what a handoff arrow icon means before pressing it,
 * and two of them are the kind that must not be pressed just to find out.)
 *
 * Delete sits at the very bottom, below a divider — everyday actions and once-in-a-while actions
 * do not belong in the same group.
 */
export function SessionMenu({
  session,
  anchorEl,
  onClose,
  onRename,
  onHandoff,
  onDelete,
}: {
  session: SessionSummary
  anchorEl: HTMLElement | null
  onClose: () => void
  onRename: () => void
  onHandoff: () => void
  onDelete: () => void
}) {
  const pick = (fn: () => void) => () => {
    fn()
    onClose()
  }
  return (
    <RowMenu anchorEl={anchorEl} testId={`session-menu-open-${session.id}`} onClose={onClose}>
      <ActionRow label="Rename" onClick={pick(onRename)} testId={`rename-session-${session.id}`} />
      {/* A worktree session cannot do this yet — the worktree's lifetime is tied to the session */}
      {!session.worktree && (
        <ActionRow
          label="Hand off to a fresh session…"
          onClick={pick(onHandoff)}
          testId={`handoff-session-${session.id}`}
        />
      )}
      <div className="my-1 border-t border-line" />
      <ActionRow
        // The dots mean a question comes first: an idle session is archived at once
        label={archiveNeedsAsk(session) ? 'Archive session…' : 'Archive session'}
        onClick={pick(onDelete)}
        testId={`delete-session-${session.id}`}
        danger
      />
    </RowMenu>
  )
}
