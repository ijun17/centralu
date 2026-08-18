import { describe, expect, it } from 'vitest'
import { dropEdge, dropSide } from './drop.js'

describe('놓일 자리 표시', () => {
  it('앞에 놓이면 왼쪽 선', () => {
    expect(dropEdge({ id: 'a', before: true }, 'a')).toContain('inset_3px_0')
  })

  it('뒤에 놓이면 오른쪽 선', () => {
    expect(dropEdge({ id: 'a', before: false }, 'a')).toContain('inset_-3px_0')
  })

  it('다른 칸에는 아무 표시도 없다', () => {
    expect(dropEdge({ id: 'a', before: true }, 'b')).toBe('')
    expect(dropEdge(null, 'a')).toBe('')
  })

  it('선은 박스 크기를 건드리지 않는다 — border면 격자가 밀린다', () => {
    for (const before of [true, false]) {
      const cls = dropEdge({ id: 'a', before }, 'a')
      expect(cls).toContain('shadow-[inset')
      expect(cls).not.toContain('border')
    }
  })

  it('표시값은 선과 같은 곳을 가리킨다', () => {
    expect(dropSide({ id: 'a', before: true }, 'a')).toBe('before')
    expect(dropSide({ id: 'a', before: false }, 'a')).toBe('after')
    expect(dropSide({ id: 'a', before: true }, 'b')).toBeUndefined()
  })
})
