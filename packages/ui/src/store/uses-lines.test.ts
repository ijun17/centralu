import { describe, expect, it } from 'vitest'
import { usesLines } from './uses-lines'

describe('what an app declares, in plain words', () => {
  it('says an app that observes its project sees the state of its sessions and not their conversations', () => {
    expect(usesLines({ sessions: ['observe'] })).toEqual(['Sessions of its project: see their state, such as working, finished or waiting for you (not their conversations)'])
  })

  it('shows a session capability a newer host adds as it is, beside the one it knows', () => {
    const lines = usesLines({ sessions: ['observe', 'message'] })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/\(not their conversations\); message$/)
  })
})
