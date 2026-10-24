import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handoffPrompt, sessionLiveDefaults, type NormalizedEvent, type SessionInfo } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import type { AgentRunWait } from './app-agents.js'
import type { HostAskAnswer } from './host-cards.js'
import { HandoffFlow, type HandoffFlowHost } from './handoff-flow.js'

/*
 * The orchestrator's handoff_session on its own (#694): the steps a handoff takes, in order, and what each failure on
 * the way leaves (nothing handed off, and the session free to be handed off again). The tool's behaviour over the real
 * manager (the card, the note file, the children it moves) is in handoff-session.test.ts.
 */

let store: Store
let meta: Map<string, SessionInfo>
let turnObservers: Map<string, Set<AgentRunWait>>
/** Each step the flow took of the manager, in order */
let steps: string[]
let created: Parameters<HandoffFlowHost['createSession']>[0][]
let notices: NormalizedEvent[]
let answer: HostAskAnswer
let auto: boolean
let host: HandoffFlowHost

const target = (extra: Partial<SessionInfo> = {}): SessionInfo => ({
  ...sessionLiveDefaults(),
  id: 't1', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: 'ext-1', name: 'Long run', autoNamed: false, state: 'idle',
  lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: true, model: 'opus', effort: 'high', verbosity: 'low', serviceTier: 'priority',
  permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
  ...extra,
}) as SessionInfo

beforeEach(() => {
  store = new Store()
  store.projects.addProject({ id: 'p1', path: '/work/p1', name: 'P1' })
  const t = target()
  store.sessions.upsertSession(t)
  meta = new Map([['t1', t], ['orch', target({ id: 'orch', name: 'Orchestrator', kind: 'orchestrator', projectId: null, permissionPreset: 'safe' })]])
  turnObservers = new Map()
  steps = []
  created = []
  notices = []
  answer = 'allow'
  auto = false
  host = {
    meta,
    store,
    turnObservers,
    toolProblem: async (tool) => {
      steps.push(`toolProblem ${tool}`)
      return tool === 'nope' ? 'no tool is called "nope"' : null
    },
    autoBoundaryOpen: (_id, boundary) => {
      if (boundary) steps.push(`auto ${boundary}`)
      return auto
    },
    askHost: async (_id, detail) => {
      steps.push(`card ${detail.kind}`)
      return answer
    },
    cwdFor: (m) => `/work/${m.projectId}`,
    exportHandoffRecord: async (id, tool) => {
      steps.push(`record ${id} ${tool}`)
      return { text: 'the record', path: '/data/handoff/p1/t1.md' }
    },
    exportHandoffNote: async (id, after) => {
      steps.push(`note ${id} after ${after}`)
      return { text: 'the note it wrote', path: '/data/handoff/p1/t1.md' }
    },
    send: async (id, text, _a, from) => {
      steps.push(`send ${id} from ${from.name}${text === handoffPrompt() ? ' (the handoff prompt)' : ''}`)
    },
    createSession: async (params) => {
      steps.push('create')
      created.push(params)
      return target({ id: 'heir', name: 'New session', tool: params.tool })
    },
    rename: (id, name) => void steps.push(`rename ${id} ${name}`),
    onEvent: (e) => {
      steps.push(`notice ${e.sessionId}`)
      notices.push(e)
    },
  }
})
afterEach(() => {
  store.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** The flow over `host`, with the waits short enough for a test where one is the point */
const flowOf = (timings = { callMs: 60_000, noteMs: 60_000 }) => new HandoffFlow(host, timings)
/** The target's turn, as the manager hands its events to the waits that read it */
const turnEvent = (e: Record<string, unknown>) => {
  for (const w of turnObservers.get('t1') ?? []) w.onEvent({ sessionId: 't1', ...e } as NormalizedEvent)
}
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {})

describe('from the record', () => {
  it('asks the person, builds the note, starts the successor with the original\'s settings, and tells the original', async () => {
    quiet()
    const r = await flowOf().handoff('orch', meta.get('t1')!, { instructions: '  keep the tests green  ' })
    expect(r).toEqual({ ok: true, state: 'done', sessionId: 'heir', sessionName: 'Long run', tool: 'claude', mode: 'record', from: 't1', path: '/data/handoff/p1/t1.md' })
    expect(steps).toEqual(['toolProblem claude', 'card other', 'record t1 claude', 'create', 'rename heir Long run', 'notice t1'])
    expect(created[0]).toMatchObject({
      projectId: 'p1', cwd: '/work/p1', tool: 'claude', model: 'opus', effort: 'high', verbosity: 'low', serviceTier: 'priority', permissionPreset: 'normal',
      initialFrom: { sessionId: 'orch', name: 'Orchestrator' },
      handoff: { from: 'Long run', note: 'the record', fromSessionId: 't1' },
    })
    expect(created[0]!.initialPrompt).toContain('keep the tests green')
    expect(notices[0]).toMatchObject({ type: 'notice', sessionId: 't1', label: 'handoff', text: expect.stringContaining('This session stays') })
  })

  it('to another tool, carries none of the tool-specific settings', async () => {
    quiet()
    await flowOf().handoff('orch', meta.get('t1')!, { tool: 'codex' })
    expect(steps).toContain('record t1 codex')
    expect(created[0]).toMatchObject({ tool: 'codex', permissionPreset: 'normal' })
    for (const k of ['model', 'effort', 'verbosity', 'serviceTier']) expect(created[0]).not.toHaveProperty(k)
  })

  it('a record that cannot be read hands nothing off, and leaves the session free to try again', async () => {
    quiet()
    const flow = flowOf()
    host.exportHandoffRecord = async () => {
      throw new Error('the transcript is unreadable')
    }
    expect(await flow.handoff('orch', meta.get('t1')!, {})).toEqual({ ok: false, error: 'Nothing was handed off: the transcript is unreadable' })
    expect(created).toEqual([])
    host.exportHandoffRecord = async () => ({ text: 'the record', path: '/p' })
    expect(await flow.handoff('orch', meta.get('t1')!, {})).toMatchObject({ ok: true, state: 'done' })
  })

  it('a successor that cannot be created is a failure, with no rename and no notice, and the session freed', async () => {
    quiet()
    const flow = flowOf()
    host.createSession = async () => {
      steps.push('create')
      throw new Error('the project folder is gone')
    }
    expect(await flow.handoff('orch', meta.get('t1')!, {})).toEqual({ ok: false, error: 'Nothing was handed off: the project folder is gone' })
    expect(steps.slice(-1)).toEqual(['create'])
    expect(notices).toEqual([])
    // Asked again, it fails the same way, not as a handoff still under way
    expect(await flow.handoff('orch', meta.get('t1')!, {})).toEqual({ ok: false, error: 'Nothing was handed off: the project folder is gone' })
  })
})

// #1509 (owner, 2026-10-24): the card guards nothing for a session at rest whose preset the orchestrator has itself
describe('no card when the handoff guards nothing', () => {
  const callerWith = (permissionPreset: SessionInfo['permissionPreset']) =>
    meta.set('orch', target({ id: 'orch', name: 'Orchestrator', kind: 'orchestrator', projectId: null, permissionPreset }))

  it('hands off without a card when the successor\'s preset (the original\'s) is within the orchestrator\'s', async () => {
    quiet()
    callerWith('normal')
    expect(await flowOf().handoff('orch', meta.get('t1')!, {})).toMatchObject({ ok: true, state: 'done' })
    expect(steps).toEqual(['toolProblem claude', 'record t1 claude', 'create', 'rename heir Long run', 'notice t1'])
    callerWith('auto')
    steps = []
    expect(await flowOf().handoff('orch', meta.get('t1')!, {})).toMatchObject({ ok: true })
    expect(steps).not.toContain('card other')
  })

  it('asks when the original\'s preset is above the orchestrator\'s, or the orchestrator cannot be read', async () => {
    quiet()
    callerWith('safe')
    await flowOf().handoff('orch', meta.get('t1')!, {})
    expect(steps).toContain('card other')
    callerWith('normal')
    meta.set('t1', target({ permissionPreset: 'auto' }))
    steps = []
    await flowOf().handoff('orch', meta.get('t1')!, {})
    expect(steps).toContain('card other')
    meta.delete('orch')
    steps = []
    await flowOf().handoff('orch', meta.get('t1')!, {})
    expect(steps).toContain('card other')
  })

  it('agent mode reads the presets again where the successor starts: one raised while it wrote its note is not handed off unasked', async () => {
    quiet()
    callerWith('normal')
    const flow = flowOf()
    const call = flow.handoff('orch', meta.get('t1')!, { mode: 'agent' })
    await vi.waitFor(() => expect(steps).toContain('send t1 from Orchestrator (the handoff prompt)'))
    meta.set('t1', target({ permissionPreset: 'auto' }))
    turnEvent({ type: 'turn_complete' })
    expect(await call).toMatchObject({ ok: false, error: expect.stringContaining('changed before the successor started') })
    expect(created).toEqual([])
  })

  it('refuses a session mid-turn with no card all the same', async () => {
    quiet()
    callerWith('normal')
    meta.set('t1', target({ state: 'working' }))
    expect(await flowOf().handoff('orch', meta.get('t1')!, {})).toMatchObject({ ok: false, error: expect.stringContaining('is mid-turn') })
    expect(steps).toEqual([])
  })

  it('reads the preset after the tool check: one raised while the tool was checked asks', async () => {
    quiet()
    callerWith('normal')
    host.toolProblem = async () => {
      meta.set('t1', target({ permissionPreset: 'auto' }))
      return null
    }
    answer = 'deny'
    expect(await flowOf().handoff('orch', meta.get('t1')!, {})).toMatchObject({ ok: false, error: expect.stringContaining('did not allow') })
    expect(steps).toContain('card other')
    expect(created).toEqual([])
  })

  it('a card-free call grants no "always": a session above the orchestrator asks next', async () => {
    quiet()
    callerWith('normal')
    const flow = flowOf()
    await flow.handoff('orch', meta.get('t1')!, {})
    // A session above the orchestrator asks: nothing carried over from the card-free call
    meta.set('t1', target({ permissionPreset: 'auto' }))
    steps = []
    await flow.handoff('orch', meta.get('t1')!, {})
    expect(steps).toContain('card other')
  })
})

describe('the checks and the card', () => {
  it('a tool that cannot start a session is refused before any card', async () => {
    quiet()
    expect(await flowOf().handoff('orch', meta.get('t1')!, { tool: 'nope' as never })).toEqual({ ok: false, error: 'Nothing was handed off: no tool is called "nope"' })
    expect(steps).toEqual(['toolProblem nope'])
  })

  it('a refusal or a withdrawn card hands nothing off, and grants no "always"', async () => {
    quiet()
    const flow = flowOf()
    answer = 'deny'
    expect(await flow.handoff('orch', meta.get('t1')!, {})).toMatchObject({ ok: false, error: expect.stringContaining('The person did not allow handing off "Long run"') })
    answer = null
    expect(await flow.handoff('orch', meta.get('t1')!, {})).toMatchObject({ ok: false, error: expect.stringContaining('The card was withdrawn') })
    expect(steps.filter((s) => s.startsWith('record') || s === 'create')).toEqual([])
    // Neither answer counts for the next call: it is asked again
    answer = 'allow'
    steps = []
    await flow.handoff('orch', meta.get('t1')!, {})
    expect(steps).toContain('card other')
  })

  it('"always" lasts for that orchestrator only, once a call passed every check', async () => {
    quiet()
    const flow = flowOf()
    answer = 'always'
    await flow.handoff('orch', meta.get('t1')!, {})
    steps = []
    await flow.handoff('orch', meta.get('t1')!, {})
    expect(steps).not.toContain('card other')
    meta.set('orch2', target({ id: 'orch2', name: 'Other orchestrator', kind: 'orchestrator', projectId: null, permissionPreset: 'safe' }))
    answer = 'allow'
    await flow.handoff('orch2', meta.get('t1')!, {})
    expect(steps).toContain('card other')
  })

  it('reads the target again after the card: one gone or started on a turn meanwhile is not handed off', async () => {
    quiet()
    const flow = flowOf()
    host.askHost = async () => {
      meta.delete('t1')
      return 'allow'
    }
    const t = target()
    expect(await flow.handoff('orch', t, {})).toEqual({ ok: false, error: '"Long run" is gone.' })
    host.askHost = async () => {
      meta.set('t1', target({ state: 'working' }))
      return 'allow'
    }
    expect(await flow.handoff('orch', t, {})).toMatchObject({ ok: false, error: expect.stringContaining('"Long run" is mid-turn (working), so nothing was handed off.') })
    expect(created).toEqual([])
  })

  it('an orchestrator moved off auto while the call was checked gets nothing, and the session is free again', async () => {
    quiet()
    const flow = flowOf()
    let reads = 0
    host.autoBoundaryOpen = () => ++reads === 1
    expect(await flow.handoff('orch', meta.get('t1')!, {})).toEqual({
      ok: false,
      error: 'This session left the auto preset while the handoff was being checked; call again to be asked.',
    })
    expect(created).toEqual([])
    expect(await flow.handoff('orch', meta.get('t1')!, {})).toMatchObject({ ok: true, state: 'done' })
  })
})

describe('from a note the session writes', () => {
  beforeEach(() => {
    auto = true
    store.messages.appendMessages([{ sessionId: 't1', seq: 7, role: 'assistant', kind: 'text', payload: { text: 'earlier work' }, ts: 7 }])
  })

  it("asks the session as the orchestrator, reads the note written after the ask, and stops reading the session's turn", async () => {
    quiet()
    host.send = async (id, text, _a, from) => {
      steps.push(`send ${id} from ${from.name}${text === handoffPrompt() ? ' (the handoff prompt)' : ''}`)
      turnEvent({ type: 'message_delta' })
      turnEvent({ type: 'turn_complete' })
    }
    const r = await flowOf().handoff('orch', meta.get('t1')!, { mode: 'agent' })
    expect(r).toMatchObject({ ok: true, state: 'done', sessionId: 'heir', mode: 'agent' })
    expect(steps.filter((s) => !s.startsWith('auto') && !s.startsWith('toolProblem'))).toEqual([
      'send t1 from Orchestrator (the handoff prompt)', 'note t1 after 7', 'create', 'rename heir Long run', 'notice t1',
    ])
    expect(created[0]!.handoff.note).toBe('the note it wrote')
    expect(turnObservers.size).toBe(0)
  })

  it('an ask that does not go in hands nothing off', async () => {
    quiet()
    host.send = async () => {
      throw new Error('the session is asleep and would not wake')
    }
    expect(await flowOf().handoff('orch', meta.get('t1')!, { mode: 'agent' })).toEqual({
      ok: false,
      error: 'Could not ask "Long run" for its note: the session is asleep and would not wake',
    })
    expect(turnObservers.size).toBe(0)
    expect(created).toEqual([])
  })

  it('a turn that fails, or ends without a note, says which and points at the record', async () => {
    quiet()
    const flow = flowOf()
    host.send = async () => turnEvent({ type: 'error', error: { code: 'internal', message: 'the CLI crashed', retryable: false } })
    expect(await flow.handoff('orch', meta.get('t1')!, { mode: 'agent' })).toEqual({
      ok: false,
      error: '"Long run" did not write its note: the agent\'s turn failed: the CLI crashed; nothing was handed off. Hand it off from the record (mode "record").',
    })
    host.send = async () => turnEvent({ type: 'turn_complete' })
    host.exportHandoffNote = async () => null
    expect(await flow.handoff('orch', meta.get('t1')!, { mode: 'agent' })).toEqual({
      ok: false,
      error: '"Long run" ended its turn without a note; nothing was handed off. Hand it off from the record (mode "record").',
    })
    expect(created).toEqual([])
    expect(turnObservers.size).toBe(0)
  })

  it('a session deleted while it wrote its note hands nothing off', async () => {
    quiet()
    host.send = async () => {
      meta.delete('t1')
      turnEvent({ type: 'turn_complete' })
    }
    expect(await flowOf().handoff('orch', target(), { mode: 'agent' })).toEqual({
      ok: false,
      error: '"Long run" disappeared while writing its note; nothing was handed off.',
    })
    expect(steps.some((s) => s.startsWith('note'))).toBe(false)
  })

  it('a note not written within its bound hands nothing off', async () => {
    quiet()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const running = flowOf({ callMs: 60 * 60_000, noteMs: 10 * 60_000 }).handoff('orch', meta.get('t1')!, { mode: 'agent' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(await running).toEqual({ ok: false, error: '"Long run" wrote no note in 10 minutes; nothing was handed off.' })
    expect(turnObservers.size).toBe(0)
  })

  it('past the call bound the handle is the caller\'s alone, read once, and the session stays claimed until the run ends', async () => {
    quiet()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const flow = flowOf({ callMs: 1_000, noteMs: 10 * 60_000 })
    const first = flow.handoff('orch', meta.get('t1')!, { mode: 'agent' })
    await vi.advanceTimersByTimeAsync(1_000)
    const writing = await first
    expect(writing).toMatchObject({ ok: true, state: 'writing', sessionId: 't1', sessionName: 'Long run' })
    const handle = (writing as { handle: string }).handle
    expect(await flow.handoff('orch', meta.get('t1')!, { mode: 'agent' })).toMatchObject({ ok: false, error: '"Long run" is already being handed off.' })
    expect(await flow.wait('orch2', handle)).toMatchObject({ ok: false, error: expect.stringContaining('No handoff of yours has the handle') })
    turnEvent({ type: 'turn_complete' })
    expect(await flow.wait('orch', handle)).toMatchObject({ ok: true, state: 'done', sessionId: 'heir' })
    expect(await flow.wait('orch', handle)).toMatchObject({ ok: false, error: expect.stringContaining('No handoff of yours has the handle') })
    expect(created).toHaveLength(1)
  })

  it('a result nobody comes back for expires with the note\'s bound', async () => {
    quiet()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const flow = flowOf({ callMs: 1_000, noteMs: 10 * 60_000 })
    const first = flow.handoff('orch', meta.get('t1')!, { mode: 'agent' })
    await vi.advanceTimersByTimeAsync(1_000)
    const { handle } = (await first) as { handle: string }
    turnEvent({ type: 'turn_complete' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(await flow.wait('orch', handle)).toMatchObject({ ok: false, error: expect.stringContaining('it finished and its result was read, or it expired') })
    expect(created).toHaveLength(1)
  })
})
