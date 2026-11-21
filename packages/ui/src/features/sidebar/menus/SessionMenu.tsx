import type { SessionSummary } from '@cc/core'
import { RowMenu } from './RowMenu.jsx'
import { ActionRow } from './ActionRow.jsx'

/** The action menu on a session row: labeled, with Delete below a divider, for the project menu's reasons */
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
        // The dots mean a question comes first: the confirm dialog, for every session (#1589)
        label="Archive session…"
        onClick={pick(onDelete)}
        testId={`delete-session-${session.id}`}
        danger
      />
    </RowMenu>
  )
}
