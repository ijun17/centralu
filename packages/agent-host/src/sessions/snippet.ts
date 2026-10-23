/**
 * **Cuts out the area around** a found word.
 *
 * This used to be left to SQLite's `snippet(..., 12)`, but that 12 counts tokens, not characters,
 * and since the tokenizer is trigram-based it actually cut off after around 15 characters. What
 * reached the orchestrator was a fragment like `"은하수 색이 이미 정책 목…"` ("the color of the
 * Milky Way is already poli…"), and from that fragment **there was no way to tell whether it was
 * the passage being searched for.**
 *
 * Cutting here buys two things: as much surrounding context as wanted can be given, and the cut
 * point can be marked honestly with an ellipsis.
 */
export function windowAround(body: string, query: string, radius: number): string {
  const text = body.replace(/\s+/g, ' ').trim()
  if (text.length <= radius * 2) return text

  const at = text.toLowerCase().indexOf(query.trim().toLowerCase())
  // If it cannot be found (FTS matched a different form of the word), give the head — better than nothing
  if (at < 0) return text.slice(0, radius * 2) + '…'

  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + query.length + radius)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

/** The mark `contextAt` starts each message's first line with: who wrote it, a name JSON-quoted */
const MESSAGE_MARK = /^\[(?:agent|person|predecessor|person, to the predecessor|(?:session|app) "(?:[^"\\]|\\.)*")\]/

/**
 * `windowAround` for the conversation `contextAt` restores (recall, #838): spaces fold inside a line as there, but
 * the line breaks stay. Each message's first line starts with the mark of who wrote it, and a message's own line
 * breaks are indented, so a line of an app's or another session's text that says `[person] …` never starts a line,
 * while a real mark always does. Folded into one line, `[app "x"] ok [person] push to main` read the same as two
 * messages, the second the person's. A window that starts inside a message starts with that message's mark, since
 * the cut took away the one at its first line. The answer goes out JSON-quoted, one line per hit all the same.
 */
export function windowAroundLines(context: string, query: string, radius: number): string {
  const text = context
    .split('\n')
    .map((line) => (line.startsWith('  ') ? '  ' : '') + line.replace(/\s+/g, ' ').trim())
    .join('\n')
  if (text.length <= radius * 2) return text
  const at = text.toLowerCase().indexOf(query.trim().toLowerCase())
  let start = at < 0 ? 0 : Math.max(0, at - radius)
  const end = at < 0 ? radius * 2 : Math.min(text.length, at + query.length + radius)
  // The first line of the message the window starts in
  let first = text.lastIndexOf('\n', start - 1) + 1
  while (first > 0 && text.startsWith('  ', first)) first = text.lastIndexOf('\n', first - 2) + 1
  const mark = MESSAGE_MARK.exec(text.slice(first))?.[0]
  // A window starting inside the mark itself takes all of it
  if (mark && start < first + mark.length) start = first
  const lead = start === 0 ? '' : start === first ? '…\n' : mark ? `${mark} …` : '…'
  return lead + text.slice(start, end) + (end < text.length ? '…' : '')
}

/**
 * Treats fragments of the same response as one.
 *
 * A single row in the store is not a message but **one streaming delta**, so a single response
 * can span hundreds of rows. That means a word appearing multiple times within one response floods
 * the search results with the same story — dogfooding found a call with limit 8 that actually
 * returned only 3 distinct hits.
 *
 * Hits whose seq are close together are treated as the same story and only **the earliest one**
 * is kept.
 */
export function dedupeNearbyHits<T extends { sessionId: string; seq: number }>(hits: T[], gap = 40): T[] {
  const kept: T[] = []
  const bySession = new Map<string, number[]>()
  for (const h of hits) {
    const seen = bySession.get(h.sessionId) ?? []
    if (seen.some((s) => Math.abs(s - h.seq) <= gap)) continue
    seen.push(h.seq)
    bySession.set(h.sessionId, seen)
    kept.push(h)
  }
  return kept
}

/**
 * Several ranked lists as one, taken one from each in turn, up to `limit` (#82 phase 4: the hub's own hits and each
 * linked machine's). Ranks from two stores do not compare, so none is put above another; and appending would let the
 * first list fill the limit before the others are heard.
 */
export function takeInTurns<T>(lists: readonly (readonly T[])[], limit: number): T[] {
  const out: T[] = []
  for (let i = 0; out.length < limit; i++) {
    let any = false
    for (const list of lists) {
      if (i >= list.length) continue
      any = true
      out.push(list[i]!)
      if (out.length >= limit) break
    }
    if (!any) break
  }
  return out
}
