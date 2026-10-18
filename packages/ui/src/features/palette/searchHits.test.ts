import { describe, expect, it } from 'vitest'
import { enterMayOpen, hitsAnswer, NO_HITS } from './searchHits.js'

describe('the palette\'s search hits and the query they answer (#1143 U15)', () => {
  it('answer the query once they were asked for it, ignoring the spaces around it', () => {
    expect(hitsAnswer({ query: 'fo', list: [] }, ' fo ')).toBe(true)
  })

  it('do not answer a query typed after them', () => {
    expect(hitsAnswer({ query: 'fo', list: [] }, 'foz')).toBe(false)
  })

  it('do not answer anything before a first search', () => {
    expect(hitsAnswer(NO_HITS, 'fo')).toBe(false)
  })

  it('keep Enter off a message hit from an earlier query', () => {
    expect(enterMayOpen({ kind: 'message' }, false)).toBe(false)
    expect(enterMayOpen({ kind: 'message' }, true)).toBe(true)
  })

  it('leave Enter on every other row alone, whatever the hits say', () => {
    for (const kind of ['session', 'project', 'app', 'action']) expect(enterMayOpen({ kind }, false)).toBe(true)
  })
})
