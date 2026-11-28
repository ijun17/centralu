import type { StoredMessage } from '@cc/protocol/client'
import type { AppState, SubagentSteps } from './state.js'
import { isPendingSend, nextChatKey, type ChatItem } from './transcript.js'

// Which rows of a conversation the screen holds: history pages merged with the screen, the window cut back
// off screen, and launch cards' subagent steps. Pure; the store's history actions call these.

// One row per `seq`, the later (fresher) list winning: a page, a search hit's page and a live row can hold one message.
export function mergeBySeq<T extends { seq: number }>(...lists: readonly (readonly T[])[]): T[] {
  return [...new Map(lists.flat().map((r) => [r.seq, r] as const)).values()].sort((a, b) => a.seq - b.seq)
}

// Messages, not rows (#66): the host's `loadMessages` merges delta chunks into messages before counting.
export const HISTORY_PAGE = 100

/**
 * Rekeys incoming history rows whose key is on screen (#79): a live key (`chatSeq`) can equal a stored number not yet
 * read, and two rows with one key draw on top of each other. Never a screen row: its `scrollAnchor` would lose it.
 * `bumpChatKeysAbove` has already raised `chatSeq`, so the new key matches no stored number.
 */
function rekeyAgainst(incoming: ChatItem[], taken: Set<number>): ChatItem[] {
  return incoming.map((it) => (taken.has(it.seq) ? { ...it, seq: nextChatKey() } : it))
}

/**
 * One row from a history row and the same message on screen (#79): the shape from history, the key and screen-only
 * fields from the screen. A streaming reply whose screen text extends history's stays as on screen: the host writes
 * its body only every few hundred ms.
 */
function settle(live: ChatItem, row: ChatItem): ChatItem {
  if ((live.kind === 'assistant' || live.kind === 'reasoning') && row.kind === live.kind && live.text.startsWith(row.text)) {
    return live
  }
  return {
    ...live,
    ...row,
    seq: live.seq,
    ...(live.kind === 'user' && live.pending ? { pending: false } : {}),
  } as ChatItem
}

/**
 * Whether an unnumbered screen row already drew this history row, by content (#79). Unnumbered rows: a message before
 * confirmation, an image (numbered only after its file is written), and a mock's error (the host's carry one, #161).
 */
function sameLine(live: ChatItem, row: ChatItem): boolean {
  if (live.kind === 'user' && row.kind === 'user') return isPendingSend(live, row.text)
  if (live.kind === 'image' && row.kind === 'image') return !!live.data && live.mime === row.mime && live.data === row.data
  if (live.kind === 'mark' && row.kind === 'mark') return live.text === row.text
  return false
}

/**
 * Merges the newest history page with the screen (#79), matching rows by `storedSeq` only. Within the page's range
 * the page is the truth: a screen row with a page row's number merges into it (`settle`); an older screen row (a stale
 * replay) is dropped for `loadOlder` to bring back, as it cannot connect without a gap or a duplicate; an approval keeps
 * its numbered spot (history never draws one). Screen rows past the range are the tail; unnumbered ones at its head
 * merge with unmatched page rows of the same content (`sameLine`).
 */
export function mergePage(have: ChatItem[], page: ChatItem[], rows: StoredMessage[]): ChatItem[] {
  if (rows.length === 0) return have
  const first = rows[0]!.seq
  const last = rows[rows.length - 1]!.seq
  const at = new Map<number, number>()
  page.forEach((p, i) => {
    if (p.storedSeq !== undefined) at.set(p.storedSeq, i)
  })
  const out = [...page]
  /** Page slots that have taken in a screen row and inherited its key */
  const adopted = new Set<number>()
  const approvals: ChatItem[] = []

  let cut = -1
  have.forEach((it, i) => {
    if (it.storedSeq !== undefined && it.storedSeq <= last) cut = i
  })
  for (const it of have.slice(0, cut + 1)) {
    const n = it.storedSeq
    if (n === undefined || n < first) continue
    const i = at.get(n)
    if (i !== undefined) {
      if (!adopted.has(i)) out[i] = settle(it, page[i]!)
      adopted.add(i)
    } else if (it.kind === 'approval') approvals.push(it)
  }

  const tail: ChatItem[] = []
  let from = adopted.size ? Math.max(...adopted) + 1 : 0
  let head = true
  for (const it of have.slice(cut + 1)) {
    if (it.storedSeq !== undefined) head = false
    if (head) {
      let i = from
      while (i < page.length && (adopted.has(i) || !sameLine(it, page[i]!))) i++
      if (i < page.length) {
        out[i] = settle(it, page[i]!)
        adopted.add(i)
        from = i + 1
        continue
      }
    }
    tail.push(it)
  }

  // Only newly incoming history rows get rekeyed (rekeyAgainst) — a row that came from the screen keeps its key
  const screen = new Set([...[...adopted].map((i) => out[i]!.seq), ...approvals.map((a) => a.seq), ...tail.map((t) => t.seq)])
  out.forEach((it, i) => {
    if (!adopted.has(i)) out[i] = rekeyAgainst([it], screen)[0]!
  })

  const body: ChatItem[] = []
  for (const it of out) {
    while (approvals.length && it.storedSeq !== undefined && approvals[0]!.storedSeq! < it.storedSeq) body.push(approvals.shift()!)
    body.push(it)
  }
  return [...body, ...approvals, ...tail]
}

export function prependPage(have: ChatItem[], older: ChatItem[]): ChatItem[] {
  const held = new Set(have.flatMap((it) => (it.storedSeq === undefined ? [] : [it.storedSeq])))
  const fresh = older.filter((it) => it.storedSeq === undefined || !held.has(it.storedSeq))
  return [...rekeyAgainst(fresh, new Set(have.map((it) => it.seq))), ...have]
}

/**
 * The rows above a re-read page (`history_synced`, a reconnect's resync) that the person read back to (#79), which
 * `mergePage` would drop, snapping the conversation to its last page mid-read. Kept only while they connect: the
 * screen holds a stored row inside the page's range. Otherwise a gap of unknown size lies between.
 */
export function readBack(have: ChatItem[], held: AppState['history'][string] | undefined, rows: StoredMessage[]): ChatItem[] {
  const first = rows[0]?.seq
  if (!held || first === undefined || held.oldestSeq >= first) return []
  if (!have.some((it) => it.storedSeq !== undefined && it.storedSeq >= first)) return []
  return have.filter((it) => it.storedSeq !== undefined && it.storedSeq >= held.oldestSeq && it.storedSeq < first)
}

// docs/state-management.md §4
const WINDOW_SIZE = 50

/**
 * Cuts a conversation to its last `WINDOW_SIZE` rows, or null. The cursor moves to the new top's stored number (#79;
 * render keys are shared across sessions), or `loadOlder` would prepend a range that does not connect. The top skips
 * unnumbered rows, and with no numbered row nothing is cut: there would be no way back into the gap.
 */
export function trimWindow(items: ChatItem[]): { items: ChatItem[]; oldestSeq: number } | null {
  if (items.length <= WINDOW_SIZE) return null
  let top = items.length - WINDOW_SIZE
  while (top < items.length && items[top]!.storedSeq === undefined) top++
  const oldestSeq = items[top]?.storedSeq
  return oldestSeq === undefined ? null : { items: items.slice(top), oldestSeq }
}

// docs/state-management.md §4 (a session never focused grows out of sight); twice, so it cuts once per window of rows.
export const OFFSCREEN_TRIM_AT = WINDOW_SIZE * 2

// docs/state-management.md §4: a closed launch card's steps go with the cut; an open card keeps them.
export function withoutClosedSteps(all: AppState['subagentSteps'], sessionId: string): AppState['subagentSteps'] {
  const mine = all[sessionId]
  if (!mine || Object.values(mine).every((c) => c.open)) return all
  const kept: Record<string, SubagentSteps> = {}
  for (const [callId, c] of Object.entries(mine)) if (c.open) kept[callId] = c
  return { ...all, [sessionId]: kept }
}

export const SUBAGENT_STEPS_UNREAD: SubagentSteps = { open: false, rows: [], more: false, loading: false, error: null }

export function putSubagentSteps(
  all: AppState['subagentSteps'],
  sessionId: string,
  callId: string,
  next: SubagentSteps,
): Pick<AppState, 'subagentSteps'> {
  return { subagentSteps: { ...all, [sessionId]: { ...all[sessionId], [callId]: next } } }
}
