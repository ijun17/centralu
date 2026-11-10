import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { CardRests } from './card-rest.js'

const request: NormalizedEvent = { type: 'approval_request', sessionId: 's', requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/' } }
const resolved: NormalizedEvent = { type: 'approval_resolved', sessionId: 's', requestId: 'r0', decision: 'allow' }

describe('the rest an adapter card closes into (#428, #2158)', () => {
  /*
   * After a swap the next host adopts the process with the session still waiting_approval and no card carried yet, until
   * the tool raises it again. A stray resolve then (a request the old handle released) finds a card standing by the busy
   * rule (`needsAnswer`), so the rest stays owed to that card: dropped, the raised card read as one inside a turn and
   * answering it left the session working with nothing to end it.
   */
  it('a resolve while the state still says a card stands keeps the rest for that card', () => {
    const rests = new CardRests()
    rests.note(request, 's', 'idle')
    expect(rests.restAfter(resolved, { id: 's', state: 'waiting_approval', pendingApproval: null, pendingQuestions: [] })).toBeNull()
    expect(rests.restAfter({ ...resolved, requestId: 'r1' }, { id: 's', state: 'working', pendingApproval: null, pendingQuestions: [] })).toBe('idle')
  })
})
