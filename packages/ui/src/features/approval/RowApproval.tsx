import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { wireJoin, wireSegments, type ApprovalDetail } from '@cc/protocol/client'
import { answersInPlace, type SessionSummary } from '@cc/core'
import { inFlightKey, useStore } from '../../store/store.js'
import { useSessionFolder } from '../../store/selectors.js'
import { Kbd, Tooltip } from '../../components/primitives.jsx'
import { detailText } from './ApprovalCard.jsx'

/**
 * An approval answered from the waiting list's row (#543, audit items 1 and 2). Answering without opening the session is a shortcut past the card, so the row
 * keeps the card's promises:
 *
 * - **It says what is being approved, and nothing of it is hidden.** The verb and the command or path stand on the
 *   row; the tooltip is the card's own text, whole (`detailText`, the same function the card draws, with what the
 *   request says beyond its line). A path shows its file's name first, then its folder inside the session's own
 *   folder (#683 review: cut at the end, an absolute path lost the name). A command is answered from the row only
 *   when it fits on it whole (measured, `useFitsWhole`): a cut command can hide its dangerous end (`cd ~/x && …`).
 * - **Only a plain yes or no.** Allow and Deny for a card whose question one line states whole (`answersInPlace`,
 *   which also sends empty and flagged requests to the card), for an edit inside the session's folder; anything else
 *   shows Open, and the card answers it.
 * - **Never an answer to something else.** The answer is the card's own (`respondApproval`), with the request id this
 *   row was drawn from: the store refuses an id that is no longer pending, and the host one it no longer holds. And
 *   for a moment after the rows change (an approval comes or goes, a session is added or removed) no row answers, so a
 *   row that slid under the pointer, or under the waiting list's cursor, is not answered by a click or a key meant for
 *   the one that was there (`useRowsSettled`). The waiting list's y and n press these buttons, so a key answers only
 *   what a click could.
 */
export function RowApproval({
  sessionId,
  keys = false,
  settled,
  onOpen,
}: {
  sessionId: string
  /** The waiting list's cursor is on this row: its buttons print y and n, the keys that answer it */
  keys?: boolean
  /** From the list's own `useRowsSettled`, when its keys answer too (the waiting list); otherwise the row asks itself */
  settled?: boolean
  onOpen: () => void
}) {
  const pending = useStore((s) => s.sessions[sessionId]?.pendingApproval ?? null)
  const others = useStore((s) => s.sessions[sessionId]?.pendingQuestions.length ?? 0)
  const name = useStore((s) => s.sessions[sessionId]?.name ?? '')
  // The folder the session works in: its worktree, or its project's
  const root = useSessionFolder(sessionId)
  const busy = useStore((s) =>
    pending ? !!s.approvalsInFlight[inFlightKey(sessionId, pending.requestId)] : false,
  )
  const respond = useStore((s) => s.respondApproval)
  const settledHere = useRowsSettled()
  const view = pending ? rowView(pending.detail, root, others) : null
  const [fitRef, fits] = useFitsWhole(
    view ? `${pending!.requestId}|${view.verb}|${view.line}|${view.dir ?? ''}` : '',
  )
  if (!pending || !view) return null
  // Allow and Deny while the line is not yet measured stay disabled, as before the rows settle
  const answerable = view.inPlace && fits !== false
  const ready = (settled ?? settledHere) && !busy && fits === true
  const answer = (decision: 'allow' | 'deny') => void respond(sessionId, pending.requestId, decision)
  const id = (part: string) => `inbox-${part}-${sessionId}`
  const why = !view.inPlace
    ? view.openWhy
    : 'The line is longer than the row: open the session to read it whole on its card'
  const button =
    'flex shrink-0 items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-muted transition-[color,background-color,opacity] hover:bg-surface-hover hover:text-ink disabled:pointer-events-none disabled:opacity-50'

  /*
   * The line and its buttons stand side by side; their slot has one width whether it holds Allow and Deny or Open, so
   * the line's room, and so whether it fits, does not change with the answer.
   */
  return (
    <div
      className="flex min-w-0 items-center gap-x-1.5 pb-2 pl-[30px] pr-3"
      data-testid={id('approval')}
      data-request={pending.requestId}
      data-in-place={answerable || undefined}
    >
      <Tooltip
        className="min-w-0 flex-1"
        testId={id('approval-tip')}
        content={
          <span className="block max-h-72 overflow-hidden whitespace-pre-wrap break-words font-mono">
            {tooltipText(pending.detail)}
          </span>
        }
      >
        {view.dir === undefined ? (
          <span className="flex min-w-0 items-baseline gap-1.5 text-xs" data-testid={id('approval-what')}>
            <span className="signal shrink-0 text-2xs font-medium">{view.verb}</span>
            <span ref={view.inPlace ? fitRef : undefined} className="truncate font-mono text-ink">
              {view.line}
            </span>
          </span>
        ) : (
          // An edit: the file's name never shrinks, its folder gives way first; the whole must show the name
          <span
            ref={view.inPlace ? fitRef : undefined}
            className="flex min-w-0 items-baseline gap-1.5 overflow-hidden text-xs"
            data-testid={id('approval-what')}
          >
            <span className="signal shrink-0 text-2xs font-medium">{view.verb}</span>
            <span className="shrink-0 font-mono text-ink" data-testid={id('approval-file')}>
              {view.line}
            </span>
            {view.dir && <span className="min-w-0 truncate font-mono text-ink-faint">{view.dir}</span>}
          </span>
        )}
      </Tooltip>
      <span
        className="flex w-[8.5rem] shrink-0 items-center justify-end gap-1.5"
      >
        {answerable ? (
          <>
            <button
              type="button"
              className={button}
              disabled={!ready}
              onClick={() => answer('allow')}
              aria-label={`Allow ${view.verb.toLowerCase()} ${view.line} in ${name}`}
              data-testid={id('approve-allow')}
              data-row-answer="allow"
              data-session={sessionId}
            >
              {keys && <Kbd live>y</Kbd>}
              Allow
            </button>
            <button
              type="button"
              className={button}
              disabled={!ready}
              onClick={() => answer('deny')}
              aria-label={`Deny ${view.verb.toLowerCase()} ${view.line} in ${name}`}
              data-testid={id('approve-deny')}
              data-row-answer="deny"
              data-session={sessionId}
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
            title={why}
            aria-label={`Open ${name} to answer its approval`}
            data-testid={id('approve-open')}
          >
            Open
          </button>
        )}
      </span>
    </div>
  )
}

/**
 * Whether an element shows its whole content, measured after layout and again when it is resized (the window's width
 * changes): null until measured, and when there is nothing to measure. `key` names what it shows.
 */
function useFitsWhole(key: string): [(el: HTMLElement | null) => void, boolean | null] {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [fits, setFits] = useState<boolean | null>(null)
  const ref = useRef(setEl).current
  useLayoutEffect(() => {
    if (!el) {
      setFits(null)
      return
    }
    const check = () => setFits(el.scrollWidth <= el.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el, key])
  return [ref, fits]
}

export type RowView = {
  verb: string
  /** The command or the question; for an edit, the file's name */
  line: string
  /** For an edit, the folder the file is in (inside the session's folder, or the whole folder outside it); '' at its root */
  dir?: string
  /** Allow and Deny may stand on the row, if the line fits */
  inPlace: boolean
  /** Why the row shows Open instead */
  openWhy: string
}

/**
 * What a row says about an approval: a verb, and one line of what it acts on, and whether it may be answered there.
 * The line is the card's text (the command, the question), up to its first line break; the tooltip carries the rest.
 */
export function rowView(d: ApprovalDetail, root: string | null, otherPending = 0): RowView {
  const first = (t: string) => {
    const lines = t.split('\n')
    return lines.length > 1 ? `${lines[0]} …` : t
  }
  const policy = answersInPlace(d, otherPending)
  const more =
    otherPending > 0
      ? 'Something else is pending in this session too: open it to answer both'
      : 'This approval offers more than allow and deny, or says more than one line can: open the session to answer it on its card'
  if (d.kind === 'command') {
    const line =
      d.command.trim() === ''
        ? d.network
          ? `network access to ${d.network.host}`
          : '(no command)'
        : first(d.command)
    return { verb: d.stdin ? 'Type' : 'Run', line, inPlace: policy, openWhy: more }
  }
  if (d.kind === 'file_edit' && !d.multi) {
    const p = pathParts(d.path, root)
    const inside = p.inside
    return {
      verb:
        d.change === 'add'
          ? 'Create'
          : d.change === 'delete'
            ? 'Delete'
            : d.change === 'move'
              ? 'Move'
              : 'Edit',
      line: p.name,
      dir: p.dir,
      inPlace: policy && inside,
      openWhy:
        policy && !inside
          ? "The file is outside this session's folder: open the session to read the whole path on its card"
          : more,
    }
  }
  const verb =
    d.kind === 'file_edit'
      ? 'Edit files'
      : d.kind === 'agent_start'
        ? 'Start agent'
        : d.kind === 'project_access'
          ? 'Reach project'
          : d.kind === 'capability'
            ? 'App permission'
            : d.kind === 'project_create'
              ? 'New project'
              : d.kind === 'project_add'
                ? 'Add project'
              : d.kind === 'centralu_update'
                ? 'Update'
                : 'Approve'
  return { verb, line: first(d.kind === 'file_edit' ? d.path : detailText(d)), inPlace: false, openWhy: more }
}

/**
 * A path as a row shows it (#683 review): the file's name first, then its folder relative to the session's folder.
 * Both are normalized first, segment by segment (`.`, `..`, repeated separators, either slash, a Windows drive), and
 * compared whole segments at a time: `/proj/src/../../../../etc/zshrc` is `/etc/zshrc`, outside `/proj`, and a
 * prefix of the text alone (`/proj-2` against `/proj`) is not inside. A path outside that folder, one that climbs out
 * of it, or one with no folder to compare against keeps its whole (normalized) folder, and is not `inside`.
 */
export function pathParts(path: string, root: string | null): { name: string; dir: string; inside: boolean } {
  const p = normalizePath(path)
  let rel: string[] = p.segs
  let inside = false
  if (p.prefix === '') {
    // Relative: inside unless it climbs above where it starts
    inside = !p.escapes
  } else {
    const r = root === null ? null : normalizePath(root)
    // Drive letters and Windows paths compare without case
    const fold = (x: string) => (/^[a-z]:\/$/i.test(p.prefix) ? x.toLowerCase() : x)
    if (
      r &&
      r.prefix !== '' &&
      fold(r.prefix) === fold(p.prefix) &&
      p.segs.length > r.segs.length &&
      r.segs.every((seg, i) => fold(seg) === fold(p.segs[i]!))
    ) {
      rel = p.segs.slice(r.segs.length)
      inside = true
    }
  }
  const name = rel[rel.length - 1] ?? ''
  const folder = wireJoin(...rel.slice(0, -1))
  // Inside: relative to the session's folder. Otherwise the whole normalized folder, so the real target shows
  const lead = inside ? '' : p.prefix
  return { name, dir: folder ? `${lead}${folder}/` : lead, inside }
}

/**
 * A path as a prefix (`/`, `C:/`, or `''` for a relative one) and its segments, with `.` and empty segments dropped
 * and each `..` taking the segment before it. A `..` with nothing before it stays in a relative path (`escapes`); at
 * an absolute root it goes nowhere, as the OS reads it.
 */
function normalizePath(path: string): { prefix: string; segs: string[]; escapes: boolean } {
  const p = path.replace(/\\/g, '/')
  const drive = /^([a-z]:)(\/|$)/i.exec(p)
  const prefix = drive ? `${drive[1]}/` : p.startsWith('/') ? '/' : ''
  const segs: string[] = []
  let escapes = false
  for (const seg of wireSegments(p.slice(drive ? drive[1]!.length : 0))) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (segs.length > 0 && segs[segs.length - 1] !== '..') segs.pop()
      else if (prefix === '') {
        segs.push('..')
        escapes = true
      }
      continue
    }
    segs.push(seg)
  }
  return { prefix, segs, escapes }
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
 * approval that comes or goes adds or removes a row in the waiting list; a session
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
