import { pausedOnBackground, type BackgroundTask, type Interruption, type SessionState } from '@cc/protocol/client'
import { isListedWaiting, isUnread, listedState, needsAnswer, type ReadTracked } from '@cc/core'

/**
 * The counts a project's name line shows of its sessions (#205), so a fold never hides "who is waiting for me" (FR-1).
 * Read in counter order: approval, error (the inbox counts it as waiting, core `isWaiting`), input, working, then
 * `background` (a turn ended while its background work runs, #2146). Idle and rate-limited neither call nor move, so
 * are not counted. Never summed (FR-12): "3" alone does not say three of what.
 */
export const FOLD_SUMMARY_STATES = ['waiting_approval', 'error', 'waiting_input', 'working', 'background'] as const

export type FoldSummaryState = (typeof FOLD_SUMMARY_STATES)[number]

export function foldSummary(
  sessions: readonly ({ state: SessionState; pendingQuestions: readonly unknown[]; interruption?: Interruption | null; backgroundTasks?: readonly BackgroundTask[] } & ReadTracked)[],
): { state: FoldSummaryState; count: number }[] {
  const counts = new Map<SessionState | 'background', number>()
  for (const raw of sessions) {
    // An open question is an approval here as it is in the inbox (`listedState`): the line cannot call it working or nothing
    const s = { ...raw, state: listedState(raw) }
    // An idle session is not counted, read or unread: an unread answer would look as urgent as an approval. The inbox lists those
    const stopped = !!s.interruption && isListedWaiting(s)
    // A turn paused on its own background work is not "working" (#2146) but its own quieter chip. Subagents count once
    const paused = !stopped && pausedOnBackground(s)
    if (s.state === 'waiting_input' && !stopped && !paused) continue
    // A stopped turn the inbox lists counts with the errors, as the inbox's counters count it (#698)
    const counted = stopped ? 'error' : paused ? 'background' : s.state
    counts.set(counted, (counts.get(counted) ?? 0) + 1)
  }
  return FOLD_SUMMARY_STATES.flatMap((state) => {
    const count = counts.get(state) ?? 0
    return count > 0 ? [{ state, count }] : []
  })
}

/**
 * The sign a folded group (a session's children, an app's sessions) keeps of the rows it hides (#666, FR-1): `alert`
 * (an approval, a question, an error; signal ink) or `unread` (one step quieter). Working, idle and asleep say nothing.
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

/** How long the pointer rests on a folded project's name row before it expands (#1605); the Assistant's too (#1591) */
export const HOVER_EXPAND_MS = 100

/**
 * The transient expansion of a folded project under the pointer (#1578), over the saved fold and never written to it
 * (`saved fold && !open`). Only a mouse pointer counts; keyboard focus and touch never call `enterRow`. A menu or drag
 * `hold`s the project open; releasing it folds only if `pointerInside` says the pointer left.
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

  /** The pointer came onto a folded project's name row (or the Assistant's button) */
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

  /** The pointer left the row or pressed on it, still inside the block: an expansion stays */
  leaveRow(): void {
    this.clearTimer()
  }

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
