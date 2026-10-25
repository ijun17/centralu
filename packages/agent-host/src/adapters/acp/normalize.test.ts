import { describe, expect, it } from 'vitest'
import { AcpNormalizer } from './normalize.js'
import type { SessionUpdate } from './wire.js'

const frame = (u: Record<string, unknown>) => u as unknown as SessionUpdate

describe('a call’s result', () => {
  it('reads the exit code the call reported before its end, though its last update carries none (#1562 review)', () => {
    const n = new AcpNormalizer('s')
    n.update(frame({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 'Run', kind: 'execute', status: 'pending', rawInput: { command: 'false' } }))
    n.update(frame({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'in_progress', rawOutput: { exitCode: 1, stdout: '', stderr: 'no' } }))
    const end = n.update(frame({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed' }))
    expect(end).toEqual([expect.objectContaining({ type: 'tool_result', callId: 'c', ok: false })])
  })
})
