import { useEffect, useState } from 'react'
import type { ApprovalDetail } from '@cc/protocol'
import { answersInPlace, type SessionSummary } from '@cc/core'
import { useStore } from '../../store/store.js'
import { Kbd, Tooltip } from '../../components/primitives.jsx'
import { detailText } from './ApprovalCard.jsx'

/**
 * An approval answered from a list row (#543, audit items 1 and 2): the waiting list's row and the sidebar's row of a
 * session that waits on an approval. Answering without opening the session is a shortcut past the card, so the row
 * keeps the card's three promises:
 *
 * - **It says what is being approved.** The verb and the command or path stand on the row, cut to its width; the
 *   tooltip is the card's own text, whole (`detailText`, the same function the card draws).
 * - **Only a plain yes or no.** Allow and Deny for a card whose question one line states whole (`answersInPlace`);
 *   any other card, or a question pending beside the approval, shows Open, and the card answers it.
 * - **Never an answer to something else.** The answer is the card's own (`respondApproval`), with the request id this
 *   row was drawn from: the store refuses an id that is no longer pending, and the host one it no longer holds.
 *   And for a moment after the rows change (an approval comes or goes, a session is added or removed) no row
 *   answers, so a row that slid under the pointer, or under the waiting list's cursor, is not answered by a click or
 *   a key meant for the one that was there (`useRowsSettled`).
 */
export function RowApproval({
  sessionId,
  place,
  keys = false,
  settled,
  onOpen,
}: {
  sessionId: string
  /** Where the row stands: names its test ids and its layout */
  place: 'inbox' | 'sidebar'
  /** The waiting list's cursor is on this row: its buttons print y and n, the keys that answer it */
  keys?: boolean
  /** From the list's own `useRowsSettled`, when its keys answer too (the waiting list); otherwise the row asks itself */
  settled?: boolean
  onOpen: () => void
}) {
  const pending = useStore((s) => s.sessions[sessionId]?.pendingApproval ?? null)
  const others = useStore((s) => s.sessions[sessionId]?.pendingQuestions.length ?? 0)
  const name = useStore((s) => s.sessions[sessionId]?.name ?? '')
  const busy = useStore((s) => (pending ? !!s.approvalsInFlight[pending.requestId] : false))
  const respond = useStore((s) => s.respondApproval)
  const settledHere = useRowsSettled()
  const ready = (settled ?? settledHere) && !busy
  if (!pending) return null
  const { verb, line } = rowSummary(pending.detail)
  const inPlace = answersInPlace(pending.detail, others)
  const answer = (decision: 'allow' | 'deny') => void respond(sessionId, pending.requestId, decision)
  const id = (part: string) => `${place}-${part}-${sessionId}`
  const button =
    'flex shrink-0 items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-xs text-ink-muted transition-[color,background-color,opacity] hover:bg-surface-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40'

  /*
   * The waiting list is wide enough for the line and its buttons side by side. The sidebar is not (240 px by default):
   * there the command took what the buttons left, a handful of characters, too few to know what is being allowed. So
   * it has the row's whole width, and the buttons wrap under it.
   */
  return (
    <div
      className={`flex min-w-0 items-center gap-x-1.5 ${place === 'inbox' ? 'pb-2 pl-[30px] pr-3' : 'flex-wrap gap-y-1 pb-1.5 pl-8 pr-3'}`}
      data-testid={id('approval')}
      data-request={pending.requestId}
      data-in-place={inPlace || undefined}
    >
      <Tooltip
        className={place === 'inbox' ? 'min-w-0 flex-1' : 'min-w-0 basis-full'}
        testId={id('approval-tip')}
        content={<span className="block max-h-72 overflow-hidden whitespace-pre-wrap break-words font-mono">{tooltipText(pending.detail)}</span>}
      >
        <span className="flex min-w-0 items-baseline gap-1.5 text-xs" data-testid={id('approval-what')}>
          <span className="signal shrink-0 text-2xs font-medium">{verb}</span>
          <span className="truncate font-mono text-ink">{line}</span>
        </span>
      </Tooltip>
      {inPlace ? (
        <>
          <button
            type="button"
            className={button}
            disabled={!ready}
            onClick={() => answer('allow')}
            aria-label={`Allow ${verb.toLowerCase()} ${line} in ${name}`}
            data-testid={id('approve-allow')}
          >
            {keys && <Kbd live>y</Kbd>}
            Allow
          </button>
          <button
            type="button"
            className={button}
            disabled={!ready}
            onClick={() => answer('deny')}
            aria-label={`Deny ${verb.toLowerCase()} ${line} in ${name}`}
            data-testid={id('approve-deny')}
          >
            {keys && <Kbd live>n</Kbd>}
            Deny
          </button>
        </>
      ) : (
        <button
          type="button"
          className={button}
          onClick={onOpen}
          title="This approval offers more than allow and deny: open the session to answer it on its card"
          aria-label={`Open ${name} to answer its approval`}
          data-testid={id('approve-open')}
        >
          Open
        </button>
      )}
    </div>
  )
}

/** The answer the waiting list's y or n gives the row under its cursor, or null when that row cannot be answered in place */
export function rowAnswerFor(
  s: Pick<SessionSummary, 'state' | 'pendingApproval' | 'pendingQuestions'> | undefined,
): { requestId: string } | null {
  if (!s || s.state !== 'waiting_approval' || !s.pendingApproval) return null
  return answersInPlace(s.pendingApproval.detail, s.pendingQuestions.length) ? { requestId: s.pendingApproval.requestId } : null
}

/**
 * What a row says about an approval: a verb, and one line of what it acts on. The line is the card's text (the
 * command, the path, the question), up to its first line break; the tooltip carries the rest.
 */
export function rowSummary(d: ApprovalDetail): { verb: string; line: string } {
  const first = (t: string) => {
    const lines = t.split('\n')
    return lines.length > 1 ? `${lines[0]} …` : t
  }
  if (d.kind === 'command') return { verb: 'Run', line: first(d.command) }
  if (d.kind === 'file_edit') return { verb: 'Edit', line: d.path }
  if (d.kind === 'agent_start') return { verb: 'Start agent', line: first(detailText(d)) }
  if (d.kind === 'project_access') return { verb: 'Reach project', line: first(detailText(d)) }
  if (d.kind === 'capability') return { verb: 'App permission', line: first(detailText(d)) }
  if (d.kind === 'project_create') return { verb: 'New project', line: first(detailText(d)) }
  if (d.kind === 'centralu_update') return { verb: 'Update', line: first(detailText(d)) }
  return { verb: 'Approve', line: first(detailText(d)) }
}

/** The card's text, cut after this many lines: an edit's diff can be thousands, and its card is one click away */
const TOOLTIP_LINES = 24

export function tooltipText(d: ApprovalDetail): string {
  const lines = detailText(d).split('\n')
  if (lines.length <= TOOLTIP_LINES) return lines.join('\n')
  return `${lines.slice(0, TOOLTIP_LINES).join('\n')}\n… ${lines.length - TOOLTIP_LINES} more lines on the card`
}

/**
 * How long the rows stay unanswerable after they change. Long enough for a hand already moving to land on the row that
 * slid in and stop; short against the mental step (about 1.35 s) a person takes before an answer they mean.
 */
export const ROW_SETTLE_MS = 500

/**
 * The rows as they stand, for `useRowsSettled`: every session in order, and the approval each one waits on. An
 * approval that comes or goes adds or removes a row's line in the sidebar and a row in the waiting list; a session
 * added or removed moves the rows below it. A state change that moves nothing (working, idle) is not in it.
 */
export function rowsKey(sessions: Record<string, Pick<SessionSummary, 'id' | 'pendingApproval'>>): string {
  return Object.values(sessions)
    .map((s) => `${s.id}:${s.pendingApproval?.requestId ?? ''}`)
    .join('|')
}

/**
 * False until the rows have stood still for `ROW_SETTLE_MS`, including right after the list appears. `extra` is
 * whatever else moves the list's rows (the waiting list's order).
 */
export function useRowsSettled(extra = ''): boolean {
  const key = useStore((s) => rowsKey(s.sessions)) + '#' + extra
  const [settledFor, setSettledFor] = useState<string | null>(null)
  useEffect(() => {
    const t = setTimeout(() => setSettledFor(key), ROW_SETTLE_MS)
    return () => clearTimeout(t)
  }, [key])
  return settledFor === key
}
