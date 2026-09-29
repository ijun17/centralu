import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The last compact summary of a dead codex process (#78) — **from the rollout file, with no
 * binary involved**.
 *
 * A summary cannot be requested from an agent whose service has stopped, but codex's compact
 * summary survives as plain text in the rollout file (measured 2026-09-04: the first user message
 * in a `compacted` item's replacement_history is the summary text itself). Since it is a local
 * file, this still reads even if the API is dead, or even if the codex binary itself is broken —
 * the file's location is also found by **file name** (`rollout-…-<threadId>.jsonl`), since the
 * getConversationSummary RPC, despite its name, only gives metadata and also requires a live binary.
 *
 * The rollout format is unofficial. So this dependency is used **only on the disaster path** — it
 * is not promoted to an always-on path that runs on every compaction (decision for #78). Any
 * failure lies down as null: without a summary, the record builder just falls back to compressing
 * the raw text, and the handoff still proceeds.
 */

/** The minimum length to call something a summary — a fragment a few characters long is not promoted to "summary" */
const MIN_SUMMARY_CHARS = 200

export async function findRolloutPath(
  threadId: string,
  sessionsDir = join(homedir(), '.codex', 'sessions'),
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
    const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.includes('"compacted"')) continue
      try {
        const j = JSON.parse(line) as { type?: string; payload?: unknown }
        if (j.type !== 'compacted') continue
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
