import { describe, expect, it } from 'vitest'
import { setupOfDetection, type NormalizedEvent } from '@cc/protocol'
import { ToolSignIns } from './tool-sign-ins.js'

const signedOut = (sessionId: string): NormalizedEvent => ({ type: 'error', sessionId, error: { code: 'not_logged_in', message: 'Claude Code is not signed in.', retryable: false } })

function signIns() {
  const told: NormalizedEvent[] = []
  const tools: Record<string, 'claude' | 'antigravity'> = { s1: 'claude', s2: 'claude', a1: 'antigravity' }
  const s = new ToolSignIns((e) => told.push(e), (id) => tools[id], (tool) => tool === 'antigravity')
  return { s, told }
}

describe('a tool a turn found signed out', () => {
  it('is told to the windows once, as signed out, and once more when a detect finds it signed in again', () => {
    const { s, told } = signIns()
    s.observe(signedOut('s1'))
    s.observe(signedOut('s2'))
    expect(told).toEqual([{ type: 'tool_setup', tool: 'claude', setup: setupOfDetection(true, false) }])
    s.detected('claude', setupOfDetection(true, false))
    expect(told).toHaveLength(1)
    s.detected('claude', setupOfDetection(true, true))
    s.detected('claude', setupOfDetection(true, true))
    expect(told.slice(1)).toEqual([{ type: 'tool_setup', tool: 'claude', setup: setupOfDetection(true, true) }])
  })

  it('tells nothing for another error, a detect of a tool never told, or a tool whose own setup tells its windows', () => {
    const { s, told } = signIns()
    s.observe({ type: 'error', sessionId: 's1', error: { code: 'internal', message: 'boom', retryable: true } })
    s.observe(signedOut('a1'))
    s.observe(signedOut('gone'))
    s.detected('claude', setupOfDetection(true, true))
    expect(told).toEqual([])
  })
})
