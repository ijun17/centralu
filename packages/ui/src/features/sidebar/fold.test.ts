import { describe, expect, it } from 'vitest'
import type { SessionState } from '@cc/protocol'
import { foldSummary } from './fold.js'

const of = (...states: SessionState[]) => states.map((state) => ({ state }))

describe('foldSummary (#205)', () => {
  it('기다리는 세션과 도는 세션을 상태마다 따로 센다 — 합산하지 않는다', () => {
    expect(
      foldSummary(of('working', 'waiting_approval', 'idle', 'waiting_input', 'waiting_approval', 'working', 'working')),
    ).toEqual([
      { state: 'waiting_approval', count: 2 },
      { state: 'waiting_input', count: 1 },
      { state: 'working', count: 3 },
    ])
  })

  it('긴급도 순서다 — 승인, 오류, 응답 대기, 도는 중', () => {
    expect(foldSummary(of('working', 'waiting_input', 'error', 'waiting_approval')).map((x) => x.state)).toEqual([
      'waiting_approval',
      'error',
      'waiting_input',
      'working',
    ])
  })

  it('오류도 센다 — 인박스가 기다리는 세션으로 세는 상태다', () => {
    expect(foldSummary(of('error', 'idle'))).toEqual([{ state: 'error', count: 1 }])
  })

  it('쉬는 중·한도만 있으면 아무것도 말하지 않는다', () => {
    expect(foldSummary(of('idle', 'limited', 'idle'))).toEqual([])
    expect(foldSummary([])).toEqual([])
  })
})
