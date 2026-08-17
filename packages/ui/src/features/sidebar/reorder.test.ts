import { describe, expect, it } from 'vitest'
import { dropsBefore, moveTo } from './reorder.js'

describe('moveTo', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('앞으로 옮긴다', () => {
    expect(moveTo(ids, 'd', 'b', true)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('뒤로 옮긴다', () => {
    expect(moveTo(ids, 'a', 'c', false)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('바로 옆으로 옮기는 것도 어긋나지 않는다', () => {
    expect(moveTo(ids, 'a', 'b', false)).toEqual(['b', 'a', 'c', 'd'])
    expect(moveTo(ids, 'b', 'a', true)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('자기 자신에 떨어뜨리면 아무 일도 없다', () => {
    expect(moveTo(ids, 'b', 'b', true)).toEqual(ids)
  })

  it('모르는 id면 그대로 둔다 — 목록이 그 사이 바뀌었을 수 있다', () => {
    expect(moveTo(ids, 'zz', 'b', true)).toEqual(ids)
    expect(moveTo(ids, 'a', 'zz', true)).toEqual(ids)
  })

  it('원본을 건드리지 않는다', () => {
    const original = [...ids]
    moveTo(ids, 'a', 'c', false)
    expect(ids).toEqual(original)
  })
})

describe('dropsBefore', () => {
  const rect = { top: 100, height: 20 }

  it('위쪽 절반이면 앞', () => {
    expect(dropsBefore(rect, 101)).toBe(true)
    expect(dropsBefore(rect, 109)).toBe(true)
  })

  it('아래쪽 절반이면 뒤', () => {
    expect(dropsBefore(rect, 111)).toBe(false)
    expect(dropsBefore(rect, 119)).toBe(false)
  })

  it('정확히 가운데는 뒤 — 경계가 어느 한쪽에 확정되어 있어야 손이 예측한다', () => {
    expect(dropsBefore(rect, 110)).toBe(false)
  })
})
