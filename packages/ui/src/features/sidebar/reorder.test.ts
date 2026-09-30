import { describe, expect, it } from 'vitest'
import { dropsBefore, moveTo } from './reorder.js'

describe('moveTo', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('moves it forward', () => {
    expect(moveTo(ids, 'd', 'b', true)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('moves it backward', () => {
    expect(moveTo(ids, 'a', 'c', false)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('does not go wrong when moving it right next door either', () => {
    expect(moveTo(ids, 'a', 'b', false)).toEqual(['b', 'a', 'c', 'd'])
    expect(moveTo(ids, 'b', 'a', true)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('does nothing when dropped on itself', () => {
    expect(moveTo(ids, 'b', 'b', true)).toEqual(ids)
  })

  it('leaves it unchanged for an unknown id — the list may have changed in the meantime', () => {
    expect(moveTo(ids, 'zz', 'b', true)).toEqual(ids)
    expect(moveTo(ids, 'a', 'zz', true)).toEqual(ids)
  })

  it('does not mutate the original', () => {
    const original = [...ids]
    moveTo(ids, 'a', 'c', false)
    expect(ids).toEqual(original)
  })
})

describe('dropsBefore', () => {
  const rect = { top: 100, height: 20 }

  it('is before when in the top half', () => {
    expect(dropsBefore(rect, 101)).toBe(true)
    expect(dropsBefore(rect, 109)).toBe(true)
  })

  it('is after when in the bottom half', () => {
    expect(dropsBefore(rect, 111)).toBe(false)
    expect(dropsBefore(rect, 119)).toBe(false)
  })

  it('is after exactly in the middle — the boundary has to fall on one fixed side so the hand can predict it', () => {
    expect(dropsBefore(rect, 110)).toBe(false)
  })
})
