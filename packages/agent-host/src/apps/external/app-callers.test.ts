import { describe, expect, it } from 'vitest'
import { AppCalls, type CallsHost } from './app-calls.js'
import type { OpenRun } from './app-entry.js'
import type { AppCaller } from './runtime-types.js'

/** Who has a call open into an app (`AppCalls.agentCallers`): a chain of apps ends at the session or the person that started it */

const calls = () => new AppCalls({} as unknown as CallsHost)
const open = (c: AppCalls, id: string, projectId: string | null, appId: string, caller: AppCaller) =>
  c.openRuns.set(id, { entry: { ref: { projectId, appId } }, caller } as unknown as OpenRun)

describe('who started the calls open into an app', () => {
  it('an app of the user folder and a project’s app of the same id are two apps in the chain', () => {
    const c = calls()
    open(c, 'r1', 'p1', 'notes', { kind: 'session', sessionId: 's1' })
    open(c, 'r2', null, 'notes', { kind: 'app', parentRunId: 'r1' })
    open(c, 'r3', null, 'notes', { kind: 'session', sessionId: 's2' })
    // The user-folder `notes` was called by the project's `notes` (which a session started), and by a session itself
    expect(c.agentCallers({ projectId: null, appId: 'notes' })).toEqual([
      { kind: 'session', sessionId: 's1' },
      { kind: 'session', sessionId: 's2' },
    ])
  })

  it('an app that calls itself back is followed once', () => {
    const c = calls()
    open(c, 'r1', 'p1', 'loop', { kind: 'app', parentRunId: 'r2' })
    open(c, 'r2', 'p1', 'loop', { kind: 'app', parentRunId: 'r1' })
    expect(c.agentCallers({ projectId: 'p1', appId: 'loop' })).toEqual([])
  })
})
