import { CLIENT_INFO } from '@cc/protocol'
import type { ExternalSessionSummary, HistoryMessage } from '../contract.js'
import { cleanTitle, stripInjectedBlocks } from '../history-text.js'
import { CodexClient } from './client.js'

/**
 * Reading a previous thread Codex has kept.
 *
 * **Only official app-server RPCs are used** (`thread/list`, `thread/read`). We do not parse
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

/**
 * A short-lived client for listing lookups. Kept separate from the session process — piling
 * lookup traffic onto a thread that is mid-conversation would slow that thread down, and if
 * something fails, there would be no telling which side died.
 */
async function withClient<T>(cwd: string, command: string, fn: (c: CodexClient) => Promise<T>): Promise<T> {
  const client = new CodexClient(
    { onNotification: () => {}, onServerRequest: (r) => client.respond(r.id, {}), onExit: () => {} },
    { cwd, command },
  )
  try {
    await client.request('initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: null,
    })
    client.notify('initialized')
    return await fn(client)
  } finally {
    await client.dispose().catch(() => {})
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
/** codex uses Unix time in seconds — our own storage unit is ms */
const ms = (sec: unknown): number | undefined => {
  const n = num(sec)
  return n === undefined ? undefined : Math.round(n * 1000)
}

export async function listCodexThreads(
  cwd: string,
  limit: number,
  command: string,
): Promise<ExternalSessionSummary[]> {
  return withClient(cwd, command, async (client) => {
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
  return withClient(cwd, command, async (client) => {
    let res: { thread?: unknown }
    try {
      res = await client.request<{ thread?: unknown }>('thread/read', {
        threadId: externalId,
        includeTurns: true,
      })
    } catch (err) {
      throw isUnknownMethod(err) ? new Error(UNSUPPORTED) : err
    }
    const thread = (res?.thread ?? {}) as Record<string, unknown>
    return turnsToHistory(thread.turns, limit)
  })
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
    const id = str(row.id)
    if (!id) continue
    // The server filters by cwd, but an older version might ignore it, so this filters once more
    if (str(row.cwd) && str(row.cwd) !== cwd) continue
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
      title: cleanTitle(str(row.preview) ?? '') || 'Untitled session',
      updatedAt: ms(row.updatedAt) ?? ms(row.recencyAt) ?? Date.now(),
      createdAt: ms(row.createdAt),
    })
  }
  return out
}

/** thread/read's turns into a list of conversation lines. Trims from the older side when it exceeds the limit */
export function turnsToHistory(turns: unknown, limit: number): HistoryMessage[] {
  const list = Array.isArray(turns) ? turns : []
  const out: HistoryMessage[] = []
  for (const t of list) {
    const turn = (t ?? {}) as Record<string, unknown>
    const at = ms(turn.startedAt)
    const items = Array.isArray(turn.items) ? turn.items : []
    for (const i of items) {
      const msg = itemToMessage(i, at)
      if (msg) out.push(msg)
    }
  }
  return out.length > limit ? out.slice(out.length - limit) : out
}

/**
 * A ThreadItem into one line of conversation.
 *
 * Only picks up the two kinds we know about (userMessage, agentMessage). Everything else
 * (reasoning, commandExecution, fileChange, ...) is **passed over as unknown** — even if codex
 * adds a new item kind, this does not break, it just does not show up.
 */
function itemToMessage(item: unknown, ts?: number): HistoryMessage | null {
  const it = (item ?? {}) as Record<string, unknown>
  if (it.type === 'agentMessage') {
    const text = str(it.text)
    return text ? { role: 'assistant', text, ts } : null
  }
  if (it.type === 'userMessage') {
    const text = stripInjectedBlocks(userInputText(it.content))
    return text ? { role: 'user', text, ts } : null
  }
  return null
}

/** Only the text the person typed, out of UserInput[]. Image and file attachments are excluded from display */
function userInputText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const c of content) {
    const block = (c ?? {}) as Record<string, unknown>
    const text = str(block.text)
    if (text && (block.type === 'text' || block.type === 'input_text' || block.type === undefined)) {
      parts.push(text)
    }
  }
  return parts.join('\n\n').trim()
}
