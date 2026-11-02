import { describe, expect, it } from 'vitest'
import { EDGE_FADE_PX, edgeFadeLevels } from './useEdgeFade.js'

const at = (scrollTop: number) => edgeFadeLevels({ scrollTop, scrollHeight: 2000, clientHeight: 500 })

describe('edgeFadeLevels (#1706)', () => {
  it('has no fade where nothing is cut: not at the very top, not at the very end', () => {
    expect(at(0)).toEqual({ top: 0, bottom: 1 })
    expect(at(1500)).toEqual({ top: 1, bottom: 0 })
    // A position that rounds to either end is that end
    expect(at(0.6).top).toBe(0)
    expect(at(1499.4).bottom).toBe(0)
  })
  it('is full once a fade height of content lies beyond the edge, and ramps in between', () => {
    expect(at(750)).toEqual({ top: 1, bottom: 1 })
    expect(at(1 + EDGE_FADE_PX / 2).top).toBe(0.5)
    expect(at(1500 - 1 - EDGE_FADE_PX / 2).bottom).toBe(0.5)
  })
  it('has none at either edge when everything fits', () => {
    expect(edgeFadeLevels({ scrollTop: 0, scrollHeight: 400, clientHeight: 500 })).toEqual({ top: 0, bottom: 0 })
  })
})
