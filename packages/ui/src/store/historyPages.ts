import type { StoredMessage } from '@cc/protocol/client'
import type { AppState, SubagentSteps } from './state.js'
import { nextChatKey, type ChatItem } from './transcript.js'

/**
 * Which rows of a conversation the screen holds: a page read from history merged with the rows
 * already on screen (`mergePage`, `prependPage`, `readBack`), and a conversation cut back to its
 * window when nobody is looking at it (`trimWindow`), with the subagent steps a launch card has read
 * (`putSubagentSteps`, `withoutClosedSteps`). Pure; the store's history actions call these.
 */

/**
 * Rows from several reads of one conversation as one list: one row per `seq` (the later list wins, since it is the
 * fresher read), in order. A page, the page around a search hit and a live row can all hold the same message.
 */
export function mergeBySeq<T extends { seq: number }>(...lists: readonly (readonly T[])[]): T[] {
  return [...new Map(lists.flat().map((r) => [r.seq, r] as const)).values()].sort((a, b) => a.seq - b.seq)
}

/**
 * How much history is read back at a time — **a count of messages, not rows** (#66).
 * The host's `loadMessages` merges delta chunks into messages before counting them, so what arrives
 * is 100 real messages, not the "200 rows = 200 tokens = a couple of sentences" that 200 meant in
 * the days before that merge.
 */
export const HISTORY_PAGE = 100

/**
 * Gives a row read from history a new key if it collides with a key already on screen (#79).
 *
 * History's key is the stored number, and a live item's key comes from `chatSeq`. In a session
 * where events arrived before history, a live key (say, 31) can coincide with a stored number
 * (row 31) not yet read. Two rows sharing one key makes the virtual scroll draw them on top of each
 * other in the same spot (see the `chatSeq` comment in transcript.ts). The side that gets rekeyed is always the
 * incoming history row — changing the key of a row already on screen would re-render it and make the
 * read position (`scrollAnchor`) lose track of that key. Because `chatSeq` was already raised by
 * `bumpChatKeysAbove` before this is called, the new key never collides with any stored number.
 */
function rekeyAgainst(incoming: ChatItem[], taken: Set<number>): ChatItem[] {
  return incoming.map((it) => (taken.has(it.seq) ? { ...it, seq: nextChatKey() } : it))
}

/**
 * Merges a history row and a screen row into one when they are the same message (#79). The shape
 * comes from history; the key and anything screen-only (a tool's live output, a confirmation mark)
 * come from the screen.
 *
 * A message still streaming is the exception: the host writes down its body every few hundred ms, so
 * if the screen's text continues history's text, the screen side is longer — in that case the screen
 * version is kept. If it does not continue (the initial connection only replayed the tail of the
 * message), history's version is the complete one.
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
 * Whether an unnumbered row on screen is what already drew this history row first — matched by
 * content (#79).
 *
 * There are three kinds of unnumbered row: a message before confirmation (a mock never sends the
 * confirmation), an image (the host assigns the number only **after** writing the file, so the event
 * carries none), and an error (a mock never records the error, so it carries no number — the host's
 * own errors have carried a number since #161). All three exist in the host's store.
 */
function sameLine(live: ChatItem, row: ChatItem): boolean {
  if (live.kind === 'user' && row.kind === 'user') return !!live.pending && !row.from && !row.fromApp && !row.fromScript && live.text === row.text
  if (live.kind === 'image' && row.kind === 'image') return !!live.data && live.mime === row.mime && live.data === row.data
  if (live.kind === 'mark' && row.kind === 'mark') return live.text === row.text
  return false
}

/**
 * Merges the newest history page with the conversation on screen (#79) — rows are matched only by
 * stored number (`storedSeq`).
 *
 * This used to discard the page and set the cursor from the page alone whenever the screen already
 * had rows. That left a gap between the discarded page and the screen (`loadOlder` only reads above
 * the cursor), and setting the cursor from the render key at the top of the screen appended the same
 * conversation a second time.
 *
 * The page is the last N rows as of the moment the host read them, and within that range (first row
 * through last row) **the page is the source of truth.**
 *  - A screen row with the same number as a page row is merged into one (`settle`) — it does not
 *    appear twice, and the screen's key is kept.
 *  - A screen row older than the page (a stale chunk replayed by the initial connection) is
 *    discarded. Keeping it would leave a row that does not connect to the top of the page, and no
 *    matter where the cursor is set, the middle would either have a gap or duplicate content. A
 *    discarded row is brought back into place by `loadOlder`.
 *  - Approval rows are never drawn from history (`messagesToChat`) — they are kept in their numbered
 *    spot even when inside the range.
 *  - An unnumbered row inside the range is already held by the page (the three kinds covered by
 *    `sameLine`).
 * Screen rows after the range are simply appended as the tail — this is where a streaming message
 * and one just sent live. An unnumbered row at the head of the tail is treated as the same row as an
 * unmatched row at the end of the page if their content matches: it merely lacks a number, but it is
 * already recorded in the store.
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

/**
 * Prepends an older page (#79). A row whose number is already on screen is not appended again, and
 * a row that collides with a key on screen gets a new key (`rekeyAgainst`).
 */
export function prependPage(have: ChatItem[], older: ChatItem[]): ChatItem[] {
  const held = new Set(have.flatMap((it) => (it.storedSeq === undefined ? [] : [it.storedSeq])))
  const fresh = older.filter((it) => it.storedSeq === undefined || !held.has(it.storedSeq))
  return [...rekeyAgainst(fresh, new Set(have.map((it) => it.seq))), ...have]
}

/**
 * The rows above a re-read page that the person had already read back to (#79), or none.
 *
 * A re-read (`history_synced` when a resumed session catches up, a resync after a reconnect) merges
 * the newest page with the screen, and `mergePage` drops every screen row older than the page. For
 * a stale fragment replayed on first contact that is right, but it also dropped the pages the person
 * had just read back through with "earlier messages": the conversation snapped back to its last page
 * in the middle of reading, and the cursor with it. These rows are kept when they still connect to
 * the page, which is when the screen holds a stored row inside the page's range: everything from the
 * cursor up to that row was read as whole pages. When the screen ends before the page starts, a gap
 * of unknown size lies between them, and the rows go as before.
 */
export function readBack(have: ChatItem[], held: AppState['history'][string] | undefined, rows: StoredMessage[]): ChatItem[] {
  const first = rows[0]?.seq
  if (!held || first === undefined || held.oldestSeq >= first) return []
  if (!have.some((it) => it.storedSeq !== undefined && it.storedSeq >= first)) return []
  return have.filter((it) => it.storedSeq !== undefined && it.storedSeq >= held.oldestSeq && it.storedSeq < first)
}

/** How many recent messages a non-focused session keeps — reopening it loads more from the store */
const WINDOW_SIZE = 50

/**
 * Cuts a conversation down to its last `WINDOW_SIZE` rows, or returns null when there is nothing to cut.
 *
 * **Shrinking the window moves the cursor along with it** (dogfooding, 2026-09-09: "older
 * conversation does not load above").
 *
 * This used to trim only `chat`. That left the top of the screen at the freshly trimmed spot
 * while the cursor (`oldestSeq`) stayed at its old value, so "load earlier conversation"
 * prepended **a range that does not connect to the screen** — the trimmed-away gap was never
 * seen again. The trim point is now the new cursor.
 *
 * The cursor is the top row's **stored number** (#79). Back when the render key was used, if
 * the top of the 50 kept rows was a live row, the cursor received a number shared across every
 * session. The window never starts at an unnumbered row (an image, a message before
 * confirmation) — it has no number to set, and that row lives in the store anyway, so
 * `loadOlder` brings it back. If there is no numbered row at all, nothing is trimmed: trimming
 * with no cursor would leave no way back into the trimmed gap.
 */
export function trimWindow(items: ChatItem[]): { items: ChatItem[]; oldestSeq: number } | null {
  if (items.length <= WINDOW_SIZE) return null
  let top = items.length - WINDOW_SIZE
  while (top < items.length && items[top]!.storedSeq === undefined) top++
  const oldestSeq = items[top]?.storedSeq
  return oldestSeq === undefined ? null : { items: items.slice(top), oldestSeq }
}

/**
 * How long an off-screen conversation may grow before it is cut back to the window.
 *
 * Losing focus is not the only way a conversation grows out of sight: a worker the orchestrator
 * started, a session an app asked for, a grid panel that is not the focused one — none of them is
 * ever focused and then left, so the trim in `focusSession` never reached them, and every event
 * (screenshots included, base64 and all) stayed in memory for the life of the window. Twice the
 * window leaves slack, so the cut happens once per window's worth of rows rather than on every event.
 */
export const OFFSCREEN_TRIM_AT = WINDOW_SIZE * 2

/**
 * A session's launch cards without the steps of the closed ones (#392), for when its conversation is cut back to the
 * window. A closed card kept every step it had read, and a live session kept appending to it, for the life of the
 * window. Opening it again reads them from the store, as the first opening did. An open card keeps its steps: it is
 * still showing them, or will be when the person comes back.
 */
export function withoutClosedSteps(all: AppState['subagentSteps'], sessionId: string): AppState['subagentSteps'] {
  const mine = all[sessionId]
  if (!mine || Object.values(mine).every((c) => c.open)) return all
  const kept: Record<string, SubagentSteps> = {}
  for (const [callId, c] of Object.entries(mine)) if (c.open) kept[callId] = c
  return { ...all, [sessionId]: kept }
}

/** A launch card's steps before the first read (#222) */
export const SUBAGENT_STEPS_UNREAD: SubagentSteps = { open: false, rows: [], more: false, loading: false, error: null }

export function putSubagentSteps(
  all: AppState['subagentSteps'],
  sessionId: string,
  callId: string,
  next: SubagentSteps,
): Pick<AppState, 'subagentSteps'> {
  return { subagentSteps: { ...all, [sessionId]: { ...all[sessionId], [callId]: next } } }
}
