import { describe, expect, it } from 'vitest'
import { MockPlatform } from './index.js'
import { seedDemo } from './demo.js'

describe('the demo scene', () => {
  // "Next waiting" takes the newest wait (ties by session id): an approval raised first loses if a tick falls between
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
