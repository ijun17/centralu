import { describe, expect, it } from 'vitest'
import { setupOfDetection, type NormalizedEvent } from '@cc/protocol'
import { ToolSignIns } from './tool-sign-ins.js'

const signedOut = (sessionId: string): NormalizedEvent => ({ type: 'error', sessionId, error: { code: 'not_logged_in', message: 'Claude Code is not signed in.', retryable: false } })

/** Claude signs in from a terminal and Antigravity through Centralu, as their detects said; Codex was never detected */
function signIns() {
  const told: NormalizedEvent[] = []
  const tools: Record<string, 'claude' | 'antigravity' | 'codex'> = { s1: 'claude', s2: 'claude', a1: 'antigravity', c1: 'codex' }
  const s = new ToolSignIns((e) => told.push(e), (id) => tools[id])
  s.detected('claude', setupOfDetection(true, true))
  s.detected('antigravity', { state: 'ready', install: 'centralu', signIn: 'centralu' })
  return { s, told }
}

describe('a tool a turn found signed out', () => {
  it('is told to the windows once, as signed out, and from then on every detect that finds it in another state is told', () => {
    const { s, told } = signIns()
    const out = { type: 'tool_setup', tool: 'claude', setup: setupOfDetection(true, false) }
    const ready = { type: 'tool_setup', tool: 'claude', setup: setupOfDetection(true, true) }
    s.observe(signedOut('s1'))
    s.observe(signedOut('s2'))
    s.detected('claude', setupOfDetection(true, false))
    expect(told).toEqual([out])
    s.detected('claude', setupOfDetection(true, true))
    s.detected('claude', setupOfDetection(true, true))
    expect(told).toEqual([out, ready])
    // The windows keep the ready they were told over their own detects: a sign-out a detect finds is told as well
    s.detected('claude', setupOfDetection(true, false))
    expect(told).toEqual([out, ready, out])
    s.observe(signedOut('s1'))
    expect(told).toHaveLength(3)
  })

  it('tells nothing for another error, a detect of a tool never told, or a tool its detect did not find signed in from a terminal', () => {
    const { s, told } = signIns()
    s.observe({ type: 'error', sessionId: 's1', error: { code: 'internal', message: 'boom', retryable: true } })
    s.observe(signedOut('a1'))
    s.observe(signedOut('c1'))
    s.observe(signedOut('gone'))
    s.detected('claude', setupOfDetection(true, true))
    s.detected('claude', { state: 'ready', install: 'terminal', signIn: 'none' })
    s.observe(signedOut('s1'))
    expect(told).toEqual([])
  })
})
