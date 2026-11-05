import type { ChatItem } from '../../../store/store.js'
import { formatElapsed } from '../elapsed.js'

/**
 * Folding what the agent did between its words (#2007, owner, 2026-11-06). A conversation shows the agent's answer
 * bubbles and the person's messages; the reasoning rows and tool calls between two of them fold into one line, a run
 * to a line, and open in place when the line is pressed.
 *
 * A run is the rows in a row that may fold. These never fold, and a row of them ends the run, so the rows before and
 * after it fold separately:
 *  - what waits on the person: an approval's row, a question (its card stands after the list), a worktree proposal;
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
  /** The key of each row (`foldKey`), which is how the run is remembered as open */
  keys: string[]
  /** How many of each it holds, and how many tool calls failed */
  thoughts: number
  tools: number
  failed: number
  /** From when its first row was said to when its last was, in seconds, when both carry a time */
  seconds: number | null
}

/** A row's name for the open state: the host's number when it has one (it survives a re-read), else the render key */
export function foldKey(item: Pick<ChatItem, 'seq' | 'storedSeq'>): string {
  return item.storedSeq !== undefined ? `s${item.storedSeq}` : `r${item.seq}`
}

/** Whether the row folds into a run; `hasView` says whether a tool call opened an app view in the conversation */
export function foldable(item: ChatItem, hasView: (callId: string) => boolean): boolean {
  if (item.kind === 'reasoning') return true
  if (item.kind !== 'tool') return false
  // A manager's worktree proposal waits on the person to take it (ChatRow `WorktreeProposalRow`)
  if (/propose_worktree_session$/.test(item.tool)) return false
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
    open.keys.push(foldKey(item))
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
 * What a live run is doing now, for its line (so a folded run still visibly moves): the tool call still without an
 * answer, else the last tool call, and "Thinking" when it ended on a thought. Null for a run that is not the last.
 */
export function liveStep(chat: readonly ChatItem[], fold: Fold): string | null {
  let last: ChatItem | undefined
  for (let i = fold.last; i >= fold.first; i--) {
    const item = chat[i]
    if (item?.kind === 'tool' && item.result === undefined && item.ok === undefined) return toolStep(item)
    last ??= item
  }
  if (last?.kind === 'tool') return toolStep(last)
  return last ? 'Thinking' : null
}

function toolStep(item: Extract<ChatItem, { kind: 'tool' }>): string {
  // One line: a command that runs over several is cut at its first, and the line's own width cuts the rest
  const title = item.title.split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
  const more = item.title.trim().includes('\n') ? ' …' : ''
  return !title || title === item.tool ? item.tool : `${item.tool}: ${title}${more}`
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
 * A day divider that stands on a row a fold hides moves to the run's line, or the day would vanish with the row. A run
 * that holds a second day's break keeps only its first: the rest are on the page once it is open.
 */
export function dayBreaksOnPage(breaks: Map<number, string>, runs: readonly Fold[], runOf: Int32Array, isOpen: (fold: Fold) => boolean): Map<number, string> {
  const hidden = runs.filter((f) => !isOpen(f))
  if (hidden.length === 0) return breaks
  const first = new Map(hidden.map((f) => [f.first, f]))
  const out = new Map<number, string>()
  for (const [i, label] of breaks) {
    const head = runOf[i] ?? -1
    if (head < 0 || !first.has(head) || i === head) {
      out.set(i, label)
    } else if (!out.has(head) && !breaks.has(head)) out.set(head, label)
  }
  return out
}
