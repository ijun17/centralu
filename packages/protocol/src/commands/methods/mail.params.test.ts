import { describe, expect, it } from 'vitest'
import { mailParams } from './mail.params.js'

describe('mail.resume', () => {
  const resume = mailParams['mail.resume']

  it("takes a thread, and still an older window's session (#2247), which the host answers by resuming nothing", () => {
    expect(resume.safeParse({ threadId: 't1' }).success).toBe(true)
    expect(resume.safeParse({ sessionId: 's1' }).success).toBe(true)
  })

  it('takes exactly one of the two', () => {
    expect(resume.safeParse({}).success).toBe(false)
    expect(resume.safeParse({ sessionId: 's1', threadId: 't1' }).success).toBe(false)
  })
})
