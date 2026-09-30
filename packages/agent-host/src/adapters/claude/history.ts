import type { ExternalSessionSummary, HistoryMessage } from '../contract.js'
import { cleanTitle, stripInjectedBlocks } from '../history-text.js'

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

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

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
    const id = str(r?.sessionId)
    if (!id) continue
    out.push({
      externalId: id,
      // Title candidates can also have harness-injected blocks mixed in (measured) — strip them before picking one.
      title:
        [r.customTitle, r.summary, r.firstPrompt]
          .map((c) => (typeof c === 'string' ? cleanTitle(c) : ''))
          .find((c) => c.length > 0) ?? 'Untitled session',
      updatedAt: num(r.lastModified) ?? Date.now(),
      createdAt: num(r.createdAt),
      branch: str(r.gitBranch),
    })
  }
  return out
}

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
    const role = r?.type === 'user' ? 'user' : r?.type === 'assistant' ? 'assistant' : null
    if (!role) continue
    // Only stripped from user turns — a tag inside the model's own words is something the model actually wrote.
    const raw = textOf(r.message)
    const text = role === 'user' ? stripInjectedBlocks(raw) : raw
    if (!text) continue
    out.push({ role, text })
  }
  return out
}

/**
 * Anthropic message to the text shown in the UI.
 *
 * Tool calls and results are dropped on purpose. The point of loading history is **to bring
 * back the conversation**, not to replay the execution log — pulling the log in as well just
 * lengthens the scroll and buries what was actually said. (Only the tool name is kept, as a
 * single line.)
 */
function textOf(message: unknown): string {
  if (typeof message === 'string') return message.trim()
  const content = (message as { content?: unknown } | null)?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    const block = b as { type?: unknown; text?: unknown; name?: unknown }
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'tool_use' && typeof block.name === 'string') parts.push(`\`${block.name}\``)
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
