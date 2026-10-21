import type { StoredMessage } from '@cc/protocol'
import { describe, expect, it } from 'vitest'
import { sessionLines } from './session-lines.js'

const row = (seq: number, payload: Record<string, unknown>): StoredMessage => ({ sessionId: 's1', seq, role: 'user', kind: 'text', payload, ts: Date.UTC(2026, 9, 21, 9, 30) })

describe('a user line in read_session says who wrote it', () => {
  it('a script’s first message carries the script’s label, and is not the person’s (§8.1)', () => {
    const lines = sessionLines([row(1, { text: 'Triage the build', fromScript: { credential: 'ci runner' } }), row(2, { text: 'my own words' })])
    expect(lines[0]!.fields).toMatchObject({ role: 'user', fromScript: 'ci runner', text: 'Triage the build' })
    expect(lines[1]!.fields).not.toHaveProperty('fromScript')
    expect(lines[1]!.fields).not.toHaveProperty('from')
    // The marks of an app's and a session's message are as they were
    const others = sessionLines([row(3, { text: 'a', fromApp: { appId: 'x', projectId: null, name: 'Slider' } }), row(4, { text: 'b', from: { sessionId: 'w', name: 'Worker' } })])
    expect(others[0]!.fields).toMatchObject({ fromApp: 'Slider' })
    expect(others[1]!.fields).toMatchObject({ from: 'Worker' })
  })
})
