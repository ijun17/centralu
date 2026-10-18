import { useState } from 'react'
import { useStore, type ChatItem } from '../../../store/store.js'
import { Button } from '../../../components/Button.jsx'

/*
 * The rows and the badge that point at another session or project: a manager's worktree proposal
 * (#69), a call that asked another project to do a task (#371) and the header's mark on the session
 * that was asked.
 */

/**
 * A worktree proposal (#69) — one door, and this is only a finger pointing at it, with one value riding along: the branch name. The project's ⋯
 * menu button lights up, and its New session (the door) brings up a dialog with the worktree toggle already on and
 * the name pre-filled; the sidebar's + it used to name is gone (owner, 2026-10-18: sessions start from the menu). Creating it is, to the very end, the person's own act.
 */
export function WorktreeProposalRow({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const branch = item.title && !/propose_worktree_session$/.test(item.title) ? item.title : null
  return (
    <p className="flex items-baseline gap-2 text-sm text-ink-muted" data-testid="worktree-proposal">
      <span className="shrink-0 text-ink-faint" aria-hidden>
        ↖
      </span>
      <span>
        {branch ? (
          <>
            Branch <span className="font-mono text-ink">{branch}</span> proposed
          </>
        ) : (
          'A worktree session was proposed'
        )}
        {' — '}
        <span className="text-ink">New session</span>
        {" in this project's ⋯ menu opens the prefilled dialog"}
      </span>
    </p>
  )
}

/**
 * ask_project in the caller's conversation (#371 part B) — one line naming the project asked and how it stands,
 * with the way to the session doing the work: that session is an ordinary one in the other project, and the person
 * may want to watch it or step in. The answer the model got stays one click away rather than filling the
 * conversation; the model already says what it made of it.
 *
 * The delegated session is read from the result (`[id]`, which every answer but a refusal carries) and, before the
 * result exists, from the delivered task's conversation provenance (`from`) in that project.
 */
export function AskProjectRow({ item, sessionId }: { item: Extract<ChatItem, { kind: 'tool' }>; sessionId: string }) {
  const [open, setOpen] = useState(false)
  // The adapter puts the project on the title (normalize); with none, the tool name comes through as is
  const projectName = item.title && !/ask_project$/.test(item.title) ? item.title : null
  const fromResult = item.result?.match(/\[([^\]\s]+)\] in /)?.[1] ?? null
  const delegatedId = useStore((s) => {
    if (fromResult && s.sessions[fromResult]) return fromResult
    if (item.result !== undefined && item.ok === false && !fromResult) return null
    const asked = Object.values(s.sessions).filter(
      (x) => (!projectName || (x.projectId && s.projects[x.projectId]?.name === projectName)) &&
        (s.chat[x.id] ?? []).some((row) => row.kind === 'user' && row.from?.sessionId === sessionId && row.text.includes("through Centralu's ask_project")),
    )
    return asked.length === 1 ? asked[0]!.id : null
  })
  const delegated = useStore((s) => (delegatedId ? s.sessions[delegatedId] : undefined))
  const focus = useStore((s) => s.focusSession)
  const running = item.result === undefined
  const stillWorking = !!item.result && / is still working on it in /.test(item.result)
  const status = running
    ? delegated?.state === 'waiting_approval'
      ? 'waiting for approval there'
      : delegated?.state === 'waiting_input'
        ? 'waiting for an answer there'
        : 'working…'
    : stillWorking
      ? 'still working'
      : item.ok === false
        ? 'did not finish'
        : 'answered'
  return (
    <div className="rounded-md border border-line bg-surface-raised" data-testid="ask-project-card">
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-sm">
        <span className="shrink-0 text-ink-faint" aria-hidden>
          ↗
        </span>
        <button
          type="button"
          className="min-w-0 truncate text-left text-ink-muted hover:text-ink"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-testid="ask-project-toggle"
        >
          Asked <span className="text-ink">{projectName ?? 'another project'}</span>
          <span className="text-ink-faint" data-testid="ask-project-status">
            {' · '}
            {status}
          </span>
        </button>
        {delegated && (
          <button
            type="button"
            className="ml-auto shrink-0 text-xs text-ink-faint hover:text-ink"
            onClick={() => focus(delegated.id)}
            data-testid="ask-project-open"
            title={delegated.name}
          >
            Open session →
          </button>
        )}
      </div>
      {open && item.result && (
        <pre
          className="max-h-60 overflow-auto whitespace-pre-wrap break-words border-t border-line px-2.5 py-1.5 font-mono text-xs leading-body text-ink-muted"
          data-testid="ask-project-result"
        >
          {item.result}
        </pre>
      )}
    </div>
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
