import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@cc/core'
import { messageTargets, messageText } from './MessageAsk.jsx'

/**
 * 고정 화면의 `ui/message` (M4 B-4) — 무엇을 보내고, 누구를 먼저 보이나.
 */

const s = (id: string, projectId: string | null, kind: SessionSummary['kind'] = 'worker') => ({ id, projectId, kind }) as SessionSummary

describe('보낼 곳', () => {
  it('이 앱의 프로젝트 세션이 먼저, 그다음 오케스트레이터, 그다음 다른 프로젝트 — 같은 무리 안의 순서는 그대로', () => {
    const all = [s('other-1', 'p2'), s('orc', null, 'orchestrator'), s('mine-1', 'p1'), s('other-2', 'p2'), s('mine-2', 'p1')]
    expect(messageTargets(all, 'p1').map((x) => x.id)).toEqual(['mine-1', 'mine-2', 'orc', 'other-1', 'other-2'])
  })

  it('사용자 폴더 앱(프로젝트 없음)은 오케스트레이터가 먼저다', () => {
    const all = [s('a', 'p1'), s('orc', null, 'orchestrator'), s('b', 'p2')]
    expect(messageTargets(all, null).map((x) => x.id)).toEqual(['orc', 'a', 'b'])
  })
})

describe('보낼 글', () => {
  it('글 조각만 모으고, 나머지는 센다 — 글이 없으면 빈 글이다(묻지 않고 거절할 것)', () => {
    expect(messageText([{ type: 'text', text: 'first' }, { type: 'image', data: 'x' }, { type: 'text', text: 'second' }])).toEqual({
      text: 'first\n\nsecond',
      dropped: 1,
    })
    expect(messageText([{ type: 'image', data: 'x' }])).toEqual({ text: '', dropped: 1 })
    expect(messageText([{ type: 'text', text: '   ' }])).toEqual({ text: '', dropped: 0 })
  })
})
