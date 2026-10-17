import type { ExternalSessionSummary, HistoryMessage } from '../contract.js'
import { finite, trimmed } from '../../json-value.js'
import { countsAsLine, HISTORY_SESSION, historyEvents, lastLines } from '../history-events.js'
import { cleanTitle, stripInjectedBlocks } from '../history-text.js'
import { normalizeNotification } from './normalize.js'
import { withCodexClient } from './short-lived.js'

/**
 * Reading a previous thread Codex has kept.
 *
 * **Only official app-server RPCs are used** (`thread/list`, `thread/turns/list`, and `thread/read` on a Codex that
 * predates the paginated methods). We do not parse
 * `~/.codex/sessions/**\/rollout-*.jsonl` directly — the rollout format is an internal detail, and
 * chasing it ourselves would mean silently showing a wrong conversation every time codex ships an update.
 *
 * An older codex does not know these methods -> a JSON-RPC "method not found" comes back. That is
 * treated not as an exception but as **a normal outcome of negotiation**, and the reason is passed up.
 */

export const UNSUPPORTED =
  'The installed Codex does not support listing past sessions (update codex)'

/** The response when an older version is called with a method it does not know. The wording differs by version, so this checks broadly */
export function isUnknownMethod(err: unknown): boolean {
  const m = (err as Error | null)?.message ?? ''
  return /-32601|method not found|unknown method|unsupported method|not supported/i.test(m)
}

/** codex uses Unix time in seconds — our own storage unit is ms */
const ms = (sec: unknown): number | undefined => {
  const n = finite(sec)
  return n === undefined ? undefined : Math.round(n * 1000)
}

export async function listCodexThreads(
  cwd: string,
  limit: number,
  command: string,
): Promise<ExternalSessionSummary[]> {
  return withCodexClient({ cwd, command }, async (client) => {
    let res: { data?: unknown }
    try {
      res = await client.request<{ data?: unknown }>('thread/list', {
        cwd,
        limit,
        sortKey: 'updated_at',
        sortDirection: 'desc',
      })
    } catch (err) {
      throw isUnknownMethod(err) ? new Error(UNSUPPORTED) : err
    }
    return threadListToSummaries(res?.data, cwd)
  })
}

export async function readCodexHistory(
  externalId: string,
  cwd: string,
  limit: number,
  command: string,
): Promise<HistoryMessage[]> {
  return withCodexClient({ cwd, command }, (client) => readThreadHistory((method, params) => client.request(method, params), externalId, limit))
}

/** Turns per `thread/turns/list` page. A page is bounded by its turns' size, not by the whole thread's */
export const HISTORY_PAGE_TURNS = 5

/** A thread no message has reached yet has no turns to read (measured wording, codex-cli 0.160.0) */
const NOT_MATERIALIZED = /unavailable before first user message|not materialized yet/i

/**
 * The last `limit` lines of a thread, newest pages first (#342).
 *
 * `thread/read` with `includeTurns` returned the whole history in one response, and Codex 0.160.0 deprecates that for
 * paginated threads: measured on a five-turn scratch thread (gpt-5.6-luna, 2026-10-05), 1,205 KB in one line and a
 * `deprecationNotice` ("Full-history hydration is deprecated for paginated threads; omit `includeTurns`…") that #304
 * put in the conversation. A 775-turn thread was 48.6 MB (manager.ts). `thread/turns/list` pages backwards from the
 * newest turn, so reading stops once `limit` lines are in hand: an import (200 lines) of a long thread reads its tail,
 * not all of it.
 *
 * `itemsView: 'full'`, not `summary`: measured, `summary` gives a turn's user message and final answer but leaves the
 * `contextCompaction` item out (a manual compaction's turn came back empty), and the compaction marker on read-back is
 * #323's. `full` gives the same items `thread/read` did, in the same order, so `turnsToHistory` is unchanged.
 *
 * A Codex without `thread/turns/list` (it answers "method not found", or "not supported" for a thread its store cannot
 * page) is read the old way, `thread/read` with turns: only paginated threads draw the deprecation.
 */
export async function readThreadHistory(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  threadId: string,
  limit: number,
): Promise<HistoryMessage[]> {
  /** Each page's lines, read once (oldest first within the page), newest page first */
  const pages: HistoryMessage[][] = []
  let lines = 0
  let cursor: string | null = null
  try {
    do {
      const page = (await request('thread/turns/list', {
        threadId,
        limit: HISTORY_PAGE_TURNS,
        sortDirection: 'desc',
        itemsView: 'full',
        ...(cursor ? { cursor } : {}),
      })) as { data?: unknown; nextCursor?: unknown } | undefined
      const turns = Array.isArray(page?.data) ? page.data : []
      const pageLines = turnLines([...turns].reverse())
      pages.push(pageLines)
      lines += pageLines.filter(countsAsLine).length
      cursor = typeof page?.nextCursor === 'string' && page.nextCursor && turns.length > 0 ? page.nextCursor : null
    } while (cursor && lines < limit)
  } catch (err) {
    if (NOT_MATERIALIZED.test((err as Error | null)?.message ?? '')) return []
    if (!isUnknownMethod(err)) throw err
    return readWholeThread(request, threadId, limit)
  }
  return lastLines(pages.reverse().flat(), limit)
}

/** The path for a Codex that predates `thread/turns/list`: the whole thread in one response */
async function readWholeThread(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  threadId: string,
  limit: number,
): Promise<HistoryMessage[]> {
  let res: { thread?: unknown } | undefined
  try {
    res = (await request('thread/read', { threadId, includeTurns: true })) as { thread?: unknown } | undefined
  } catch (err) {
    if (NOT_MATERIALIZED.test((err as Error | null)?.message ?? '')) return []
    throw isUnknownMethod(err) ? new Error(UNSUPPORTED) : err
  }
  const thread = (res?.thread ?? {}) as Record<string, unknown>
  return turnsToHistory(thread.turns, limit)
}

/**
 * A thread/list response into a summary list.
 * Response parsing is split out as a pure function — being able to verify it without starting
 * codex means a test is what tells us first when the format changes.
 */
export function threadListToSummaries(data: unknown, cwd: string): ExternalSessionSummary[] {
  const rows = Array.isArray(data) ? data : []
  const out: ExternalSessionSummary[] = []
  for (const r of rows) {
    const row = (r ?? {}) as Record<string, unknown>
    const id = trimmed(row.id)
    if (!id) continue
    // The server filters by cwd, but an older version might ignore it, so this filters once more
    if (trimmed(row.cwd) && trimmed(row.cwd) !== cwd) continue
    out.push({
      externalId: id,
      /*
       * codex's preview is, as a rule, "**usually the first** user message." That means even a
       * conversation spanning several days shows up under its very first topic — unlike Claude,
       * which gives a summary. Fetching the last message while building the list would require a
       * thread/read per thread, which is too slow to use for a snappy response. So the title is
       * left as-is, and the UI states "last active N hours ago" alongside it so recency is still
       * visible. (There are cases where instructions injected by the harness get mixed in, and
       * only those are stripped out.)
       */
      title: cleanTitle(trimmed(row.preview) ?? '') || 'Untitled session',
      updatedAt: ms(row.updatedAt) ?? ms(row.recencyAt) ?? Date.now(),
      createdAt: ms(row.createdAt),
    })
  }
  return out
}

/**
 * Turns, oldest first, into a list of conversation lines. Trims from the older side when the lines that count exceed
 * the limit (`lastLines`: the words and compactions; a turn's tool rows ride along)
 */
export function turnsToHistory(turns: unknown, limit: number): HistoryMessage[] {
  return lastLines(turnLines(turns), limit)
}

/** Turns, oldest first, into every line they leave */
function turnLines(turns: unknown): HistoryMessage[] {
  const list = Array.isArray(turns) ? turns : []
  const out: HistoryMessage[] = []
  for (const t of list) {
    const turn = (t ?? {}) as Record<string, unknown>
    const at = ms(turn.startedAt)
    const items = Array.isArray(turn.items) ? turn.items : []
    for (const i of items) out.push(...itemToMessages(i, at))
  }
  return out
}

/**
 * A ThreadItem into the lines of conversation it leaves.
 *
 * The person's and the model's words are read here: a `userMessage` with injected blocks stripped, an `agentMessage`
 * whole (live, its text arrives as deltas). Every other item is read by the live normalizer, as if it had started and
 * completed while the app watched (#843), so it leaves what it would have left live: a tool card (a command, a file
 * change, an MCP call, a search, an agent launch, a kind Codex adds later) with its input and result, and a compaction
 * marker for a `contextCompaction` (#303). Reasoning and the review and image-view items leave nothing that is kept
 * (`historyEvents`). Before #843 only the words and compactions came back, so an imported thread showed none of its
 * tool calls where a watched one did.
 *
 * A compaction's place is right: measured (codex-cli 0.147.0, 0.153.4 and 0.160.0, 2026-10-04), `thread/read` returns
 * it as `{ type: 'contextCompaction', id }` in the turn where it ran — a turn of its own for a manual compaction, and
 * ahead of the userMessage for an automatic one.
 */
function itemToMessages(item: unknown, ts?: number): HistoryMessage[] {
  const it = (item ?? {}) as Record<string, unknown>
  if (it.type === 'agentMessage') {
    const text = trimmed(it.text)
    return text ? [{ role: 'assistant', text, ts }] : []
  }
  if (it.type === 'userMessage') {
    const text = stripInjectedBlocks(userInputText(it.content))
    return text ? [{ role: 'user', text, ts }] : []
  }
  const live = (method: string) => normalizeNotification(HISTORY_SESSION, { method, params: { item: it } })
  return historyEvents([...live('item/started'), ...live('item/completed')], ts)
}

/** Only the text the person typed, out of UserInput[]. Image and file attachments are excluded from display */
function userInputText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const c of content) {
    const block = (c ?? {}) as Record<string, unknown>
    const text = trimmed(block.text)
    if (text && (block.type === 'text' || block.type === 'input_text' || block.type === undefined)) {
      parts.push(text)
    }
  }
  return parts.join('\n\n').trim()
}
