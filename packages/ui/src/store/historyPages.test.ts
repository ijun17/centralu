import { describe, expect, it } from 'vitest'
import { mergeBySeq } from './historyPages.js'

describe('mergeBySeq', () => {
  it('puts the rows of several reads in order', () => {
    expect(mergeBySeq([{ seq: 3 }, { seq: 1 }], [{ seq: 2 }]).map((r) => r.seq)).toEqual([1, 2, 3])
  })

  it('keeps one row per seq, the later list winning', () => {
    const before = [{ seq: 1, text: 'old' }, { seq: 2, text: 'old' }]
    const after = [{ seq: 2, text: 'new' }, { seq: 3, text: 'new' }]
    expect(mergeBySeq(before, after)).toEqual([
      { seq: 1, text: 'old' },
      { seq: 2, text: 'new' },
      { seq: 3, text: 'new' },
    ])
  })

  it('is empty for nothing', () => {
    expect(mergeBySeq()).toEqual([])
    expect(mergeBySeq([], [])).toEqual([])
  })
})
