import { useMemo } from 'react'
import type { SessionSummary } from '@cc/core'
import { useStore } from '../../store/store.js'
import { useToolMeta } from '../../store/selectors.js'

/**
 * A pinned view's `ui/message` — asks the person which session to send it to (M4 B-4).
 *
 * An in-conversation view's message goes to that conversation; where it is sent is already fixed.
 * A pinned view has no such conversation. Letting the app pick on its own would let the view (the
 * app's own code) put a message into any session without the person knowing. So **nothing is sent
 * before the person chooses.** Canceling has the view receive a decline (so it never believes it
 * was sent).
 *
 * The text about to be sent is shown exactly as it is. The person reading that text and choosing is
 * the entirety of this confirmation. A non-text part (an image, etc.) is not sent, and that fact is
 * stated. The list ranks this app's own project sessions first, then the orchestrator and other
 * projects' sessions. A user-folder app has no project, so the orchestrator comes first (decision 4:
 * a user-folder app belongs to the orchestrator).
 */
export type MessageAskState = { text: string; dropped: number; resolve: (sent: boolean) => void }

export function MessageAsk({
  appTitle,
  projectId,
  ask,
  onAnswer,
}: {
  appTitle: string
  projectId: string | null
  ask: MessageAskState
  onAnswer: (sessionId: string | null) => void
}) {
  const sessions = useStore((s) => s.sessions)
  const projects = useStore((s) => s.projects)
  const targets = useMemo(() => messageTargets(Object.values(sessions), projectId), [sessions, projectId])
  return (
    <div
      className="absolute inset-x-3 bottom-3 z-20 max-h-[70%] overflow-y-auto rounded-lg border border-line bg-surface-side p-3 shadow-(--shadow-popover)"
      role="dialog"
      aria-label={`${appTitle} wants to send a message`}
      data-testid="pinned-message-ask"
    >
      <p className="text-sm text-ink">{appTitle} wants to send this to a session:</p>
      <pre
        className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-floor px-2.5 py-2 font-sans text-sm text-ink-muted"
        data-testid="pinned-message-text"
      >
        {ask.text}
      </pre>
      {ask.dropped > 0 && (
        <p className="mt-1 text-xs text-ink-faint">
          {ask.dropped} non-text part{ask.dropped > 1 ? 's' : ''} will not be sent.
        </p>
      )}
      <p className="mt-3 text-xs text-ink-faint">Send to</p>
      {targets.length === 0 ? (
        <p className="mt-1 text-sm text-ink-muted">There is no session to send it to.</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {targets.map((s) => (
            <li key={s.id}>
              <Target session={s} project={s.projectId ? projects[s.projectId]?.name : undefined} onPick={() => onAnswer(s.id)} />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          className="rounded-md px-2 py-1 text-sm text-ink-faint transition-colors hover:text-ink"
          onClick={() => onAnswer(null)}
          data-testid="pinned-message-cancel"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function Target({ session, project, onPick }: { session: SessionSummary; project: string | undefined; onPick: () => void }) {
  const meta = useToolMeta(session.tool)
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-ink-muted transition-colors hover:bg-surface-hover/40 hover:text-ink"
      onClick={onPick}
      data-testid={`pinned-message-to-${session.id}`}
    >
      <span className="readout flex size-[14px] shrink-0 items-center justify-center rounded-sm border border-line-strong text-2xs text-ink">
        {meta.mark}
      </span>
      <span className="truncate">{session.kind === 'orchestrator' ? 'Orchestrator' : session.name}</span>
      {project && <span className="ml-auto shrink-0 truncate text-2xs text-ink-faint">{project}</span>}
    </button>
  )
}

/** Sessions it can be sent to, nearest first — this app's project, the orchestrator, then the rest */
export function messageTargets(all: SessionSummary[], projectId: string | null): SessionSummary[] {
  const rank = (s: SessionSummary) => {
    if (projectId && s.projectId === projectId) return 0
    if (s.kind === 'orchestrator') return 1
    return 2
  }
  return [...all].sort((a, b) => rank(a) - rank(b))
}

/** Only the text from the parts a view sent — the rest are counted */
export function messageText(content: unknown[]): { text: string; dropped: number } {
  const texts: string[] = []
  let dropped = 0
  for (const c of content) {
    const block = c as { type?: unknown; text?: unknown }
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else dropped++
  }
  return { text: texts.join('\n\n').trim(), dropped }
}
