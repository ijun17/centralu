import { describe, expect, it } from 'vitest'
import { dedupeNearbyHits, windowAround } from './snippet.js'

/**
 * Tests, as-is, the two reasons dogfooding made recall unusable: a fragment was too short to
 * judge, and the same phrase appeared multiple times, making the limit meaningless.
 */
describe('cutting out the area around a found spot', () => {
  const body = `${'앞'.repeat(400)}은하수 그라데이션${'뒤'.repeat(400)}`

  it('gives context around the word — a 15-character fragment gives no way to tell what it is', () => {
    const s = windowAround(body, '은하수', 160)
    expect(s).toContain('은하수 그라데이션')
    // Context actually comes along on both sides
    expect(s.length).toBeGreaterThan(300)
    expect(s).toMatch(/^…앞/)
    expect(s).toMatch(/뒤…$/)
  })

  it('gives a short body whole (nothing is cut if there is nothing to cut)', () => {
    expect(windowAround('짧은 말', '짧은', 160)).toBe('짧은 말')
  })

  it('does not return empty-handed even when the word cannot be found', () => {
    // The case where FTS matched a different form of the word (e.g. one with a particle attached)
    const s = windowAround(body, '없는낱말', 50)
    expect(s.length).toBeGreaterThan(0)
  })

  it('collapses a newline to a single space — a multi-line result would break a one-line-per-entry list', () => {
    expect(windowAround('가\n\n나   다', '가', 100)).toBe('가 나 다')
  })
})

describe('sweeping out nearby hits', () => {
  /*
   * A single row in the store is one streaming delta, so one response spans hundreds of rows.
   * That means a word appearing multiple times within one response gets caught as multiple hits
   * for the same story (dogfooding: with limit 8, the same one appeared 5 times, so only 3 were
   * actually distinct).
   */
  it('treats hits in the same session as one when their seq are close together', () => {
    const hits = [
      { sessionId: 'a', seq: 100 },
      { sessionId: 'a', seq: 103 },
      { sessionId: 'a', seq: 118 },
      { sessionId: 'a', seq: 400 },
    ]
    expect(dedupeNearbyHits(hits)).toEqual([
      { sessionId: 'a', seq: 100 },
      { sessionId: 'a', seq: 400 },
    ])
  })

  it('keeps both if the sessions differ, even with the same seq — they are different stories', () => {
    const hits = [
      { sessionId: 'a', seq: 100 },
      { sessionId: 'b', seq: 100 },
    ]
    expect(dedupeNearbyHits(hits)).toHaveLength(2)
  })

  it('keeps the earliest one (the one that ranks higher in search)', () => {
    const hits = [
      { sessionId: 'a', seq: 200 },
      { sessionId: 'a', seq: 201 },
    ]
    expect(dedupeNearbyHits(hits)[0]!.seq).toBe(200)
  })
})
