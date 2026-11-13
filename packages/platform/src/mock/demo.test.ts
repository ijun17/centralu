import { describe, expect, it } from 'vitest'
import { MockPlatform } from './index.js'
import { seedDemo } from './demo.js'

describe('the demo scene', () => {
  // "Next waiting" takes the newest wait and breaks a tie by session id, the approval's first: the approval raised before the question lost to it when a tick fell between the two
  it('raises the approval after the question, so the shortcut for the next waiting item lands on the approval', async () => {
    const m = new MockPlatform()
    const raised: string[] = []
    m.emit = ((e: { type: string }) => {
      if (e.type === 'approval_request' || e.type === 'question_request') raised.push(e.type)
    })
    await seedDemo(m)
    expect(raised).toEqual(['question_request', 'approval_request'])
  })
})
