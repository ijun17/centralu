import type { ExternalSessionSummary, HistoryMessage } from '../contract.js'
import { finite, trimmed } from '../../json-value.js'
import { HISTORY_SESSION, historyEvents } from '../history-events.js'
import { cleanTitle, stripInjectedBlocks } from '../history-text.js'
import { normalizeMessage } from './normalize.js'

/**
 * Reads past sessions Claude Code has kept.
 *
 * **Only the official SDK API is used** (`listSessions` / `getSessionMessages`).
 * `~/.claude/projects/**\/*.jsonl` is never parsed directly — that file format is not a
 * documented contract, so an update to the tool can break it silently, and there would be no
 * way to know the parsing broke. The SDK reads the transcripts its own version wrote, so version
 * compatibility becomes the SDK's problem, not ours.
 *
 * That said, **the SDK itself can be old** (an environment installed with an old lockfile).
 * So this reaches it through a dynamic import plus a function-existence check instead of a
 * named import: if the function is missing, the module load does not blow up — this falls back
 * to "not supported" instead.
 */

export const UNSUPPORTED =
  'The installed Claude Code SDK does not support listing past sessions (update the SDK)'

/** Only the part of the SDK surface we use. A field not listed here is ignored even if present (safe as the SDK grows). */
type SdkSessionInfo = {
  sessionId?: unknown
  summary?: unknown
  customTitle?: unknown
  firstPrompt?: unknown
  lastModified?: unknown
  createdAt?: unknown
  gitBranch?: unknown
}
type SdkSessionMessage = { type?: unknown; message?: unknown }
type SessionApi = {
  listSessions?: (o?: Record<string, unknown>) => Promise<SdkSessionInfo[]>
  getSessionMessages?: (id: string, o?: Record<string, unknown>) => Promise<SdkSessionMessage[]>
  deleteSession?: (id: string, o?: Record<string, unknown>) => Promise<void>
  forkSession?: (id: string, o?: Record<string, unknown>) => Promise<{ sessionId?: unknown }>
}

let cached: SessionApi | null | undefined

async function sessionApi(): Promise<SessionApi | null> {
  if (cached !== undefined) return cached
  try {
    const mod = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as SessionApi
    cached = typeof mod.listSessions === 'function' ? mod : null
  } catch {
    cached = null
  }
  return cached
}

/** Swaps in the SDK surface from a test, to reproduce old-version or unsupported situations. */
export function __setSessionApiForTest(api: SessionApi | null | undefined): void {
  cached = api
}


export async function listClaudeSessions(cwd: string, limit: number): Promise<ExternalSessionSummary[]> {
  const sdk = await sessionApi()
  if (!sdk?.listSessions) throw new Error(UNSUPPORTED)
  /*
   * includeProgrammatic:true — this also includes sessions created through the SDK (i.e., the
   * ones Centralu itself created).
   *
   * We originally filtered with false. The reasoning was "sessions we created are already in the
   * sidebar, so this would be a duplicate" — but **that premise broke once "hidden" came to mean
   * "removed from the list"**: a hidden session is not in the sidebar, and if it also does not
   * show up here, there is no way back for it.
   * (Measured: a session we created returned 0 rows with false, 1 row with true.)
   *
   * The duplicate case is filtered out using the list's `imported` flag instead.
   */
  const rows = await sdk.listSessions({ dir: cwd, limit, includeProgrammatic: true })
  if (!Array.isArray(rows)) return []
  const out: ExternalSessionSummary[] = []
  for (const r of rows) {
    const id = trimmed(r?.sessionId)
    if (!id) continue
    out.push({
      externalId: id,
      // Title candidates can also have harness-injected blocks mixed in (measured) — strip them before picking one.
      title:
        [r.customTitle, r.summary, r.firstPrompt]
          .map((c) => (typeof c === 'string' ? cleanTitle(c) : ''))
          .find((c) => c.length > 0) ?? 'Untitled session',
      updatedAt: finite(r.lastModified) ?? Date.now(),
      createdAt: finite(r.createdAt),
      branch: trimmed(r.gitBranch),
    })
  }
  return out
}

/**
 * The last `last` messages of a conversation as the SDK reads its transcript (`type` and the API `message`), for a
 * process adopted from a previous host to recover what it was told only on that host's stream: the timers it holds
 * (#568, `ClaudeSchedules`). Empty when the SDK cannot read it.
 */
export async function readClaudeTranscriptTail(externalId: string, cwd: string, last: number): Promise<{ type?: unknown; message?: unknown }[]> {
  const sdk = await sessionApi()
  if (!sdk?.getSessionMessages) return []
  const rows = await sdk.getSessionMessages(externalId, { dir: cwd }).catch(() => [])
  return Array.isArray(rows) ? rows.slice(-last) : []
}

/**
 * The opening of the summary a compaction leaves as a user turn (#843). The transcript marks that row
 * `isCompactSummary` and writes a `compact_boundary` system row before it, but the SDK's `getSessionMessages` keeps
 * neither (SDK 0.3.263: a row is cut to `type`, `uuid`, `message`; a system row has no `message`, so even
 * `includeSystemMessages` cannot tell a compaction from any other). So an imported conversation showed the whole
 * summary as if the person had typed it, and no marker, where a Codex import has one (#303). The CLI's own words are
 * the one sign left (measured in transcripts of CLI 2.1.228 to 2.1.289).
 */
const COMPACT_SUMMARY = /^This session is being continued from a previous conversation that ran out of context\./

export async function readClaudeHistory(
  externalId: string,
  cwd: string,
  limit: number,
): Promise<HistoryMessage[]> {
  const sdk = await sessionApi()
  if (!sdk?.getSessionMessages) throw new Error(UNSUPPORTED)
  const rows = await sdk.getSessionMessages(externalId, { dir: cwd, limit })
  if (!Array.isArray(rows)) return []
  const out: HistoryMessage[] = []
  for (const r of rows) {
    if (r?.type === 'assistant') out.push(...assistantLines(r.message))
    else if (r?.type === 'user') out.push(...userLines(r.message))
  }
  return out
}

/**
 * A model message read back: its words, then its tool calls, as the live normalizer reads the same message when it
 * arrives whole (#843). Tool calls used to be dropped, leaving only the tool's name as a line of the model's words, so
 * an imported conversation showed `Bash` where a watched one showed the command and its output. Its thinking, usage
 * and plan are not part of a conversation read back (`historyEvents`).
 */
function assistantLines(message: unknown): HistoryMessage[] {
  const out: HistoryMessage[] = []
  const events = normalizeMessage({ type: 'assistant', message }, HISTORY_SESSION)
  for (const e of events) {
    // A tag inside the model's own words is something the model actually wrote, so nothing is stripped here
    if (e.type === 'message_delta' && e.text.trim()) out.push({ role: 'assistant', text: e.text.trim() })
    else out.push(...historyEvents([e]))
  }
  return out
}

/**
 * A user message read back: the person's words with the blocks the harness injected stripped, or the compaction a
 * summary row marks, then the results of the tool calls it carries, as the live normalizer reads them (#843).
 */
function userLines(message: unknown): HistoryMessage[] {
  const raw = userText(message)
  if (COMPACT_SUMMARY.test(raw)) return [{ role: 'system', event: { type: 'compaction', sessionId: HISTORY_SESSION, failed: false } }]
  const text = stripInjectedBlocks(raw)
  const out: HistoryMessage[] = text ? [{ role: 'user', text }] : []
  const content = (message as { content?: unknown } | null)?.content
  if (Array.isArray(content)) out.push(...historyEvents(normalizeMessage({ type: 'user', message }, HISTORY_SESSION)))
  return out
}

/** The text blocks of a user message: what the person typed, before injected blocks are stripped */
function userText(message: unknown): string {
  if (typeof message === 'string') return message.trim()
  const content = (message as { content?: unknown } | null)?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    const block = b as { type?: unknown; text?: unknown }
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n\n').trim()
}

/**
 * Deletes the original conversation on the tool's side (the "actually delete" case surfaced by
 * dogfooding).
 *
 * The reason we do not `rm` the files (`~/.claude/projects/**`) ourselves is the same as for
 * reading — where the transcript lives, and with which attachments (subagent folders, etc.), is
 * the SDK's own business, and the SDK's `deleteSession` knows its own layout. If it is missing
 * (an old version), this throws UNSUPPORTED — the manager tells the person, with the reason.
 */
export async function deleteClaudeSession(externalId: string, cwd: string): Promise<void> {
  const sdk = await sessionApi()
  if (!sdk?.deleteSession) throw new Error(UNSUPPORTED)
  await sdk.deleteSession(externalId, { dir: cwd })
}

/**
 * A copy of a conversation under a new id (#677: a fork of a busy session), through the SDK's own `forkSession` (SDK
 * 0.3.263), which knows its file layout: the copy is a full transcript the CLI resumes like any other. The original is
 * left as it is, and a copy taken mid-turn holds what the transcript has so far. `dir` is the folder the original ran
 * in, the one its transcript is kept under.
 */
export async function forkClaudeSession(externalId: string, cwd: string): Promise<string> {
  const sdk = await sessionApi()
  if (!sdk?.forkSession) throw new Error('The installed Claude Code SDK cannot fork a conversation (update the SDK)')
  const r = await sdk.forkSession(externalId, { dir: cwd })
  if (typeof r?.sessionId !== 'string' || !r.sessionId) throw new Error('Claude Code forked the conversation but returned no session id')
  return r.sessionId
}
