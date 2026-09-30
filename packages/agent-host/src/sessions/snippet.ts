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
