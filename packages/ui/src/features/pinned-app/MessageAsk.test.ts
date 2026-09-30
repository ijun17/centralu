import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@cc/core'
import { messageTargets, messageText } from './MessageAsk.jsx'

/**
 * A pinned view's `ui/message` (M4 B-4) — what gets sent, and who is shown first.
 */

const s = (id: string, projectId: string | null, kind: SessionSummary['kind'] = 'worker') => ({ id, projectId, kind }) as SessionSummary

describe('the send targets', () => {
  it("ranks this app's own project sessions first, then the orchestrator, then other projects — order within each group is unchanged", () => {
    const all = [s('other-1', 'p2'), s('orc', null, 'orchestrator'), s('mine-1', 'p1'), s('other-2', 'p2'), s('mine-2', 'p1')]
    expect(messageTargets(all, 'p1').map((x) => x.id)).toEqual(['mine-1', 'mine-2', 'orc', 'other-1', 'other-2'])
  })

  it('ranks the orchestrator first for a user-folder app (no project)', () => {
    const all = [s('a', 'p1'), s('orc', null, 'orchestrator'), s('b', 'p2')]
    expect(messageTargets(all, null).map((x) => x.id)).toEqual(['orc', 'a', 'b'])
  })
})

describe('the text to send', () => {
  it('collects only the text parts and counts the rest — an empty text with no text at all (to be declined without asking)', () => {
    expect(messageText([{ type: 'text', text: 'first' }, { type: 'image', data: 'x' }, { type: 'text', text: 'second' }])).toEqual({
      text: 'first\n\nsecond',
      dropped: 1,
    })
    expect(messageText([{ type: 'image', data: 'x' }])).toEqual({ text: '', dropped: 1 })
    expect(messageText([{ type: 'text', text: '   ' }])).toEqual({ text: '', dropped: 0 })
  })
})
