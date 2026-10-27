import { describe, expect, it } from 'vitest'
import { contextShare, nextContext } from './session-state.js'
import type { NormalizedEvent } from './events.js'

/**
 * The context share is used / the model's full window, for every tool (#1553). The host says which window that is in the reading
 * (`context_update.window`); this is the one place a screen or a text turns the reading into a share.
 */
const update = (over: Partial<Extract<NormalizedEvent, { type: 'context_update' }>>): NormalizedEvent => ({
  type: 'context_update',
  sessionId: 's1',
  used: 304_000,
  window: 1_000_000,
  exactness: 'exact',
  ...over,
})

describe('contextShare', () => {
  it("is used / the model's window: 304k of a 1M model is 30%, with the compaction point as a mark at 60%", () => {
    const share = contextShare({ used: 304_000, window: 1_000_000, exactness: 'exact', compactAt: 600_000 })
    expect(share?.fraction).toBeCloseTo(0.304)
    expect(share?.window).toBe(1_000_000)
    expect(share?.capped).toBe(false)
    expect(share?.compactAt).toEqual({ tokens: 600_000, fraction: 0.6 })
  })

  it('has no compaction mark when the tool was not started by Centralu’s control', () => {
    expect(contextShare({ used: 100_000, window: 200_000, exactness: 'exact' })?.compactAt).toBeNull()
  })

  it('says when the window is only a floor under the model’s: the figure is an upper bound and its mark has no place on it', () => {
    const share = contextShare({
      used: 100_000,
      window: 153_000,
      exactness: 'exact',
      capped: true,
      compactAt: 120_000,
    })
    expect(share?.capped).toBe(true)
    expect(share?.compactAt).toEqual({ tokens: 120_000, fraction: null })
  })

  it('is nothing with no reading, or with a window the host could not size', () => {
    expect(contextShare(null)).toBeNull()
    expect(contextShare({ used: 5_000, window: 0, exactness: 'exact' })).toBeNull()
  })
})

describe('the reading a context_update leaves (nextContext)', () => {
  it('carries the host’s window, its capped mark and the compaction point', () => {
    expect(nextContext(null, update({ compactAt: 600_000 }))).toEqual({
      used: 304_000,
      window: 1_000_000,
      exactness: 'exact',
      compactAt: 600_000,
    })
    expect(nextContext(null, update({ capped: true }))).toEqual({
      used: 304_000,
      window: 1_000_000,
      exactness: 'exact',
      capped: true,
    })
    // An older host says neither
    expect(nextContext(null, update({}))).toEqual({ used: 304_000, window: 1_000_000, exactness: 'exact' })
  })

  it('keeps them through a compaction that reports its size', () => {
    const read = nextContext(null, update({ compactAt: 600_000 }))
    const after = nextContext(read, {
      type: 'compaction',
      sessionId: 's1',
      failed: false,
      before: 304_000,
      after: 8_800,
    })
    expect(after).toEqual({ used: 8_800, window: 1_000_000, exactness: 'estimate', compactAt: 600_000 })
  })
})
