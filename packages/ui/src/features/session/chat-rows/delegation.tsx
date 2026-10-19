import { useStore, type ChatItem } from '../../../store/store.js'
import { Button } from '../../../components/Button.jsx'
import { BranchIcon } from '../../../components/icons.jsx'

/*
 * The row and the badge that point at another session or project: a manager's worktree proposal (#69) and the
 * header's mark on the session another project asked (#371). The call that asked is a Centralu call's card
 * (`CentraluCall.tsx`), as every other call to Centralu's tools is.
 */

/**
 * A worktree proposal (#69) — one door, and this is only a finger pointing at it, with one value riding along: the branch name. The project's ⋯
 * menu button lights up, and its New session (the door) brings up a dialog with the worktree toggle already on and
 * the name pre-filled; the sidebar's + it used to name is gone (owner, 2026-10-18: sessions start from the menu). Creating it is, to the very end, the person's own act.
 */
export function WorktreeProposalRow({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const branch = item.title && !/propose_worktree_session$/.test(item.title) ? item.title : null
  return (
    <p className="flex items-start gap-2 text-sm text-ink-muted" data-testid="worktree-proposal">
      {/*
        The branch mark the changes panel names a branch by, in place of a font arrow (design-system.md §5), centred on
        the first line of a sentence that may wrap
      */}
      <span className="flex h-[1lh] shrink-0 items-center text-ink-faint" aria-hidden>
        <BranchIcon />
      </span>
      <span>
        {branch ? (
          <>
            Branch <span className="font-mono text-ink">{branch}</span> proposed.
          </>
        ) : (
          'A worktree session was proposed.'
        )}{' '}
        <span className="text-ink">New session</span>
        {" in this project's ⋯ menu opens the prefilled dialog."}
      </span>
    </p>
  )
}

/**
 * The header's mark on a session another project asked for (#371 part B): who asked, and the way back. The caller
 * may since have been deleted; the mark then says so rather than disappearing, since the session still did that
 * project's work.
 */
export function AskedByBadge({ callerId, projectId }: { callerId: string; projectId: string | null }) {
  const caller = useStore((s) => s.sessions[callerId])
  const projectName = useStore((s) => (caller?.projectId ? s.projects[caller.projectId]?.name : undefined))
  const focus = useStore((s) => s.focusSession)
  if (!caller) {
    return (
      <span className="shrink-0 text-2xs text-ink-faint" data-testid="asked-by-badge">
        Asked by a session no longer here
      </span>
    )
  }
  // A session of the same project started this one with start_agent (#561): the session, not the project, is named
  if (caller.projectId && caller.projectId === projectId) {
    return (
      <Button
        variant="quiet"
        size="xs"
        className="min-w-0 shrink truncate"
        onClick={() => focus(callerId)}
        data-testid="asked-by-badge"
        title={`Go back to ${caller.name}`}
      >
        ↩ Started by {caller.name}
      </Button>
    )
  }
  return (
    <Button
      variant="quiet"
      size="xs"
      className="min-w-0 shrink truncate"
      onClick={() => focus(callerId)}
      data-testid="asked-by-badge"
      title={`Go back to ${caller.name}`}
    >
      ↩ Asked by {projectName ?? caller.name}
    </Button>
  )
}
