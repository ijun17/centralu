import type { Interruption, SessionState } from '@cc/protocol/client'
import { isListedWaiting, isUnread, listedState, needsAnswer, type ReadTracked } from '@cc/core'

/**
 * What a folded project's name line says in place of the sessions it hides (#205).
 *
 * The sidebar is the place to see "who is waiting for me" at a glance (FR-1). If folding hides the
 * session rows and also hides that signal along with them, folding stops being a tidying feature and
 * becomes a feature that hides signal instead. So the folded row keeps the state of the hidden rows
 * **as counts**.
 *
 * There are four states counted, in the same order of urgency as the inbox (approval → error →
 * waiting for input, then working). Error was not part of the original request, but it cannot be
 * dropped: it is a state that the inbox and ⌘⇧A count as a waiting session (core `isWaiting`), and if a
 * session stalled inside a folded project disappears with no indication at all, folding has just done
 * exactly that. Idle and rate-limited are not counted — they are rows that neither call the person nor
 * move.
 *
 * The counts are never summed (the same rule as the dashboard in FR-12): seeing only "3" does not say
 * whether it is three approvals or three working sessions.
 */
export const FOLD_SUMMARY_STATES = ['waiting_approval', 'error', 'waiting_input', 'working'] as const

export type FoldSummaryState = (typeof FOLD_SUMMARY_STATES)[number]

export function foldSummary(
  sessions: readonly ({ state: SessionState; pendingQuestions: readonly unknown[]; interruption?: Interruption | null } & ReadTracked)[],
): { state: FoldSummaryState; count: number }[] {
  const counts = new Map<SessionState, number>()
  for (const raw of sessions) {
    // An open question is an approval here as it is in the inbox (`listedState`): the line cannot call it working or nothing
    const s = { ...raw, state: listedState(raw) }
    /*
     * An idle session is not counted at all, read or unread (owner, 2026-10-20): the chips speak only of what runs and
     * what needs the person (an approval, a question, an error). An unread answer looked as urgent as an approval, and
     * whether an idle session counted depended on having opened it, which the line could not show. The inbox lists the
     * unread ones.
     */
    if (s.state === 'waiting_input' && !(s.interruption && isListedWaiting(s))) continue
    // A stopped turn the inbox lists counts with the errors, as the inbox's counters count it (#698)
    const counted = s.interruption && isListedWaiting(s) ? 'error' : s.state
    counts.set(counted, (counts.get(counted) ?? 0) + 1)
  }
  return FOLD_SUMMARY_STATES.flatMap((state) => {
    const count = counts.get(state) ?? 0
    return count > 0 ? [{ state, count }] : []
  })
}

/**
 * What a folded group (the children of a session, the sessions of an app) says about the rows it hides (#666).
 *
 * A fold must not hide the one thing the sidebar is for, "who is waiting for me" (FR-1), so a group that hides such a
 * row keeps a sign. Two strengths, the same ladder as a row: `alert` is a hidden row that needs an answer (an
 * approval, a question, an error) and is spoken in the signal ink; `unread` is a hidden row with something new to read
 * and is spoken one step quieter. Working, idle and asleep rows say nothing, as in a project's `foldSummary`.
 */
export type GroupAttention = 'alert' | 'unread'

export function groupAttention(
  sessions: readonly { state: SessionState; pendingQuestions: readonly unknown[]; lastSeq: number; lastReadSeq: number; interruption?: Interruption | null }[],
): GroupAttention | null {
  let found: GroupAttention | null = null
  for (const s of sessions) {
    if (needsAnswer(s) || s.state === 'error') return 'alert'
    // A stopped turn still listed in the inbox needs the person as an error does (#698)
    if (s.interruption && isListedWaiting(s)) return 'alert'
    if (isUnread(s)) found = 'unread'
  }
  return found
}

/** How long the pointer rests on a folded project's name row before it expands (owner, 2026-10-26: 200 ms in #1578, 100 ms in #1605). The orchestrator's button shares it (#1591) */
export const HOVER_EXPAND_MS = 100

/**
 * The transient expansion of a folded project under the pointer (#1578). It lives on top of the saved fold and never
 * writes to it: the block reads `saved fold && !open`. One timer per project: it starts when the pointer enters the name
 * row (all of it, the empty space beside the name included, #1605) and is cleared when it leaves, so a pass shorter than
 * `HOVER_EXPAND_MS` does nothing. Only a mouse pointer counts; keyboard focus and touch never call `enterRow`.
 *
 * `leaveBlock` folds again, unless something holds the project as it is (an open menu, a drag): `hold(true)` defers the
 * fold, and `hold(false)` settles it by asking `pointerInside` where the pointer is now.
 */
export class HoverExpander {
  private cancel: (() => void) | null = null
  private open = false
  private held = false
  constructor(
    private readonly env: {
      onChange: (open: boolean) => void
      pointerInside: () => boolean
      /** Starts a timer and returns what cancels it (tests pass a fake) */
      startTimer?: (fn: () => void, ms: number) => () => void
    },
  ) {}

  /** The pointer came onto a folded project's name row (or the orchestrator's button) */
  enterRow(folded: boolean): void {
    this.clearTimer()
    if (!folded || this.open) return
    const start =
      this.env.startTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        return () => clearTimeout(t)
      })
    this.cancel = start(() => {
      this.cancel = null
      this.set(true)
    }, HOVER_EXPAND_MS)
  }

  /** The pointer left the row or pressed on it (still inside the block): a rest that has not finished is cancelled; an expansion stays */
  leaveRow(): void {
    this.clearTimer()
  }

  /** The pointer left the project's whole block */
  leaveBlock(): void {
    this.clearTimer()
    if (!this.held) this.set(false)
  }

  /** A menu is open or a drag is under way (`true`), or it ended (`false`) */
  hold(held: boolean): void {
    if (this.held === held) return
    this.held = held
    if (!held && this.open && !this.env.pointerInside()) this.set(false)
  }

  /** A click made it stay (the saved fold takes over), or the project was unmounted */
  reset(): void {
    this.clearTimer()
    this.set(false)
  }

  private set(open: boolean): void {
    if (this.open === open) return
    this.open = open
    this.env.onChange(open)
  }

  private clearTimer(): void {
    this.cancel?.()
    this.cancel = null
  }
}
