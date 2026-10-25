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

describe('a call that ends with no output passed on', () => {
  it('says the tool passed on none, not that the command printed none (#1562 Mac re-check: 60 KB of output arrived as "")', async () => {
    const { fileURLToPath } = await import('node:url')
    const { loadRecording } = await import('../frames/replay.test-helpers.js')
    const recording = loadRecording(fileURLToPath(new URL('./recordings/cursor-agent-2026.10.22/big-output.jsonl', import.meta.url)))
    const n = new AcpNormalizer('s', 'Cursor')
    const results = recording.frames.flatMap((f) => {
      const msg = f.msg as { method?: string; params?: { update?: SessionUpdate } } | undefined
      return f.dir === 'in' && msg?.method === 'session/update' && msg.params?.update ? n.update(msg.params.update) : []
    })
    const result = results.find((e) => e.type === 'tool_result')
    expect(result).toMatchObject({ type: 'tool_result', ok: true, summary: '(Cursor passed on no output)' })
  })
})
