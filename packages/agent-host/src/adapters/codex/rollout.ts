import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { codexHome } from './home.js'
import { readLines } from '../../transport/json-lines.js'

/**
 * The last compact summary of a dead codex process (#78) — **from the rollout file, with no binary involved**: the
 * first user message in a `compacted` item's replacement_history is the summary text (measured 2026-09-04), and the
 * file is found by **file name** (`rollout-…-<threadId>.jsonl`), so it reads with the API dead or the binary broken.
 * getConversationSummary gives only metadata and needs a live binary; so do the app-server's reads (`thread/read`,
 * `thread/turns/list`, `thread/items/list`), where a compaction is only `{ type: "contextCompaction", id }` (measured
 * 2026-10-03, codex-cli 0.153.4). `Thread.path` (UNSTABLE) gives the same file the name search finds.
 *
 * The rollout format is unofficial, so it is read **only on the disaster path**, never on every compaction (decision
 * for #78). Any failure is null: the record builder then compresses the raw text, and the handoff still proceeds.
 */

/** The minimum length to call something a summary — a fragment a few characters long is not promoted to "summary" */
const MIN_SUMMARY_CHARS = 200

export async function findRolloutPath(
  threadId: string,
  sessionsDir = join(codexHome(), 'sessions'),
): Promise<string | null> {
  try {
    const suffix = `-${threadId}.jsonl`
    const names = await readdir(sessionsDir, { recursive: true })
    // There is exactly one rollout per thread — if there were several (should not happen), take the last by name sort (the most recent timestamp)
    const hits = names.filter((n) => String(n).endsWith(suffix)).sort()
    const hit = hits[hits.length - 1]
    return hit ? join(sessionsDir, String(hit)) : null
  } catch {
    return null
  }
}

/**
 * **A remote compaction keeps its summary encrypted** (measured 2026-10-03, codex-cli 0.153.4,
 * ChatGPT login). Its `message` is empty and replacement_history is the person's own messages,
 * kept as they were, followed by `{ type: "compaction", encrypted_content }`. There is no readable
 * summary, and the first user message is something the person wrote: taking it would head the
 * handoff record with their own words labelled as a summary.
 */
function isEncrypted(payload: unknown): boolean {
  const history = (payload as { replacement_history?: { type?: string }[] }).replacement_history
  return Array.isArray(history) && history.some((item) => item?.type === 'compaction')
}

/** Pulls the summary text out of a single compacted item — if message is empty, uses replacement_history's first user message */
function summaryOf(payload: unknown): string | null {
  const p = payload as {
    message?: unknown
    replacement_history?: { type?: string; role?: string; content?: { type?: string; text?: string }[] }[]
  }
  if (typeof p.message === 'string' && p.message.trim().length >= MIN_SUMMARY_CHARS) return p.message
  for (const item of p.replacement_history ?? []) {
    if (item.type !== 'message' || item.role !== 'user') continue
    const text = (item.content ?? [])
      .filter((c) => c.type === 'input_text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
    // The first user message is the summary (measured). If too short, it is a preserved ordinary message, not a summary
    return text.trim().length >= MIN_SUMMARY_CHARS ? text : null
  }
  return null
}

/**
 * Streams through the rollout sequentially, keeping the **last** compacted item's summary.
 * Since it is a stream, memory use stays at one line's worth even for a 550MB-class file —
 * parsing is done only on lines that contain 'compacted' (most lines pass through with just that
 * one string check).
 */
export async function lastCompactSummary(
  threadId: string,
  sessionsDir?: string,
): Promise<string | null> {
  const path = await findRolloutPath(threadId, sessionsDir)
  if (!path) return null
  try {
    let last: string | null = null
    // Not readline, which also ends a line at a U+2028 inside a JSON string (`readLines`)
    for await (const line of readLines(createReadStream(path))) {
      if (!line.includes('"compacted"')) continue
      try {
        const j = JSON.parse(line) as { type?: string; payload?: unknown }
        if (j.type !== 'compacted') continue
        // An encrypted compaction supersedes any earlier summary — that one no longer covers the conversation up to here
        if (isEncrypted(j.payload)) {
          last = null
          continue
        }
        const s = summaryOf(j.payload)
        if (s) last = s
      } catch {
        // A broken line is skipped — it could be the last line the tool left half-written
      }
    }
    return last
  } catch {
    return null
  }
}
