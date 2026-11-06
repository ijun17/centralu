import type { ChatItem } from '../../../store/store.js'
import { formatElapsed } from '../elapsed.js'

/**
 * Folding what the agent did between its words (#2007, owner, 2026-11-06). A conversation shows the agent's answer
 * bubbles and the person's messages; the reasoning rows and tool calls between two of them fold into one line, a run
 * to a line, and open in place when the line is pressed.
 *
 * A run is the rows in a row that may fold. These never fold, and a row of them ends the run, so the rows before and
 * after it fold separately:
 *  - what waits on the person: an approval's row, a question (its card stands after the list), a worktree proposal, an
 *    `ask_project` call until it is answered (its line says whether the session it asked is waiting on the person);
 *  - what happened: every marker (an error line, a usage limit, a stop or restart cut, compaction, handoff, a tool's
 *    notice);
 *  - an app's view shown inline, the tool call that opened it;
 *  - an image the agent shows.
 * The answer's own bubbles and the person's messages are not folded either; they are what the run stands between.
 *
 * The list stays one virtual row per chat row (the indexes the scroller, the banner and a search hit speak in do not
 * move): a folded run's first row draws the line, and the rest of its rows stand at no height (`ChatStream`).
 */

/** One run of foldable rows */
export type Fold = {
  /** The index of its first and of its last row */
  first: number
  last: number
  /** The keys of its rows (`foldKeys`), which is how the run is remembered as open */
  keys: string[]
  /** How many of each it holds, and how many tool calls failed */
  thoughts: number
  tools: number
  failed: number
  /** From when its first row was said to when its last was, in seconds, when both carry a time */
  seconds: number | null
}

/**
 * A row's names for the open state: the host's number when it has one (it survives a re-read), and the render key (a
 * row streaming live has no host number until it is stored, and it must not close the run it is in when it gets one).
 */
export function foldKeys(item: Pick<ChatItem, 'seq' | 'storedSeq'>): string[] {
  return item.storedSeq !== undefined ? [`s${item.storedSeq}`, `r${item.seq}`] : [`r${item.seq}`]
}

/** Whether the row folds into a run; `hasView` says whether a tool call opened an app view in the conversation */
export function foldable(item: ChatItem, hasView: (callId: string) => boolean): boolean {
  if (item.kind === 'reasoning') return true
  if (item.kind !== 'tool') return false
  // A manager's worktree proposal waits on the person to take it (ChatRow `WorktreeProposalRow`)
  if (/propose_worktree_session$/.test(item.tool)) return false
  // An ask_project call says, on its card, that the session it asked waits on the person: it stays until it is answered
  if (/ask_project$/.test(item.tool) && item.result === undefined && item.ok === undefined) return false
  return !(item.callId && hasView(item.callId))
}

/** The runs of a conversation, and for each row the first index of the run it is in, or -1 */
export function foldRuns(chat: readonly ChatItem[], hasView: (callId: string) => boolean): { runs: Fold[]; runOf: Int32Array } {
  const runs: Fold[] = []
  const runOf = new Int32Array(chat.length).fill(-1)
  let open: Fold | null = null
  let from: number | undefined
  let to: number | undefined
  const close = () => {
    if (open && from !== undefined && to !== undefined) open.seconds = Math.max(0, Math.round((to - from) / 1000))
    open = null
    from = to = undefined
  }
  chat.forEach((item, i) => {
    if (!foldable(item, hasView)) return close()
    if (!open) {
      open = { first: i, last: i, keys: [], thoughts: 0, tools: 0, failed: 0, seconds: null }
      runs.push(open)
    }
    open.last = i
    open.keys.push(...foldKeys(item))
    runOf[i] = open.first
    if (item.kind === 'reasoning') open.thoughts++
    else {
      open.tools++
      if (item.kind === 'tool' && item.ok === false) open.failed++
    }
    if (item.at !== undefined) {
      from ??= item.at
      to = item.at
    }
  })
  close()
  return { runs, runOf }
}

/** A run that is shown open: pressed open, or holding the row a search found (so the hit is on the page) */
export function foldIsOpen(fold: Fold, opened: Record<string, true> | undefined, hit: number | null): boolean {
  if (hit !== null && hit >= fold.first && hit <= fold.last) return true
  return !!opened && fold.keys.some((k) => opened[k])
}

/**
 * What a live run is doing now, for its line (so a folded run still visibly moves): its last row, a tool call by its
 * words (a Centralu call by its own label) and "Thinking" for a thought.
 */
export function liveStep(chat: readonly ChatItem[], fold: Fold): string | null {
  const last = chat[fold.last]
  if (last?.kind === 'tool') return toolStep(last)
  return last ? 'Thinking' : null
}

/**
 * The run the turn is in, if the turn is live: the last run, when only decided approvals stand after it (the tool the
 * approval let through is still running, its row before the approval's).
 */
export function liveRun(chat: readonly ChatItem[], runs: readonly Fold[], working: boolean): Fold | null {
  const run = runs.at(-1)
  if (!working || !run) return null
  for (let i = run.last + 1; i < chat.length; i++) if (chat[i]?.kind !== 'approval') return null
  return run
}

function toolStep(item: Extract<ChatItem, { kind: 'tool' }>): string {
  const name = item.centralu?.label ?? item.tool
  // One line: a command that runs over several is cut at its first, and the line's own width cuts the rest
  const title = item.title.split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
  const more = item.title.trim().includes('\n') ? ' …' : ''
  return !title || title === item.tool ? name : `${name}: ${title}${more}`
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The words of a run's line: what it holds, and how long it took when that is worth saying */
export function foldSummary(fold: Fold): string {
  const parts: string[] = []
  if (fold.thoughts > 0) parts.push(plural(fold.thoughts, 'thought', 'thoughts'))
  if (fold.tools > 0) parts.push(plural(fold.tools, 'tool', 'tools'))
  if (fold.seconds !== null && fold.seconds >= 5) parts.push(formatElapsed(fold.seconds))
  return parts.join(' · ')
}

/**
 * A day divider that stands on a row a fold hides is not lost with it. A run that changes the day inside it leaves the
 * rows after it in the new day, so the divider goes to the first row after the run (when that row has none of its own,
 * which then says its own day); a run that ends the conversation has its line carry it.
 */
export function dayBreaksOnPage(breaks: Map<number, string>, runs: readonly Fold[], chatLength: number, isOpen: (fold: Fold) => boolean): Map<number, string> {
  const out = new Map(breaks)
  for (const fold of runs) {
    if (isOpen(fold)) continue
    let inside: string | undefined
    for (let i = fold.first + 1; i <= fold.last; i++) {
      const label = breaks.get(i)
      if (label === undefined) continue
      out.delete(i)
      inside = label
    }
    if (inside === undefined) continue
    const after = fold.last + 1
    if (after < chatLength && !out.has(after)) out.set(after, inside)
    else if (after >= chatLength && !out.has(fold.first)) out.set(fold.first, inside)
  }
  return out
}

/**
 * How many drawn rows lie between a row and the range the list draws (0 inside it). The rows a closed run hides stand
 * at no height, so they are not distance: an app view held beside a closed run would otherwise be told it left the
 * screen a fold line's height after it did. Counting stops once it passes the limit.
 */
export function rowsBeyond(range: { startIndex: number; endIndex: number }, index: number, hidden: ArrayLike<number>, limit = 1_000): number {
  let drawn = 0
  if (index < range.startIndex) for (let i = index; i < range.startIndex && drawn <= limit; i++) drawn += hidden[i] ? 0 : 1
  else for (let i = index; i > range.endIndex && drawn <= limit; i--) drawn += hidden[i] ? 0 : 1
  return drawn
}
