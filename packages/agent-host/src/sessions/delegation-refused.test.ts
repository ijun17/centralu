/**
 * Delegations out of an untrusted project are refused, not held (docs/plans/mailbox.md §7.4, D12): every delegation tool
 * asks the mailbox's `refusesDelegation` before it creates, starts or delivers anything, and a refusal is the tool's
 * answer, word for word, with nothing started. Over the real manager, with a stand-in for the mailbox's decision and
 * for a linked machine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LinkedSessions } from '../adapters/contract.js'
import type { DelegationCall, DelegationTarget } from './delegation-host.js'
import { crossWorld, type CrossHandle, type CrossWorld, sendWork } from './cross-project.test-helpers.js'
import { ASK_THE_PERSON } from './start-agent-terms.js'

const S15 = 'Refused (untrusted_project): your project consumer is not trusted, so work you give outside it (to the target) waits for the person to trust consumer. Nothing was started.'

let w: CrossWorld
/** What the stand-in answers: S15, or null to let the call go */
let refusal: string | null
let asked: { callerId: string; target: DelegationTarget; call: DelegationCall }[]
/** What reached the stand-in machine */
let overLink: string[]

beforeEach(async () => {
  w = await crossWorld()
  refusal = null
  asked = []
  overLink = []
  w.mgr.mail.useMail({
    sessionGone: () => {},
    sessionChanged: () => {},
    refusesDelegation: (callerId, target, call) => {
      asked.push({ callerId, target, call })
      return refusal
    },
  })
})
afterEach(async () => {
  await w.dispose()
})

const handleOf = (id: string): CrossHandle | undefined => w.adapters.get('claude')!.handles.get(id) ?? w.adapters.get('codex')!.handles.get(id)
const sessionCount = () => w.mgr.listSessions().length
const textOf = (r: unknown) => (r as { error?: string }).error ?? (r as { text?: string }).text ?? ''

/** A linked machine "Box" with the project api and the session m1.w1, recording what goes over the link */
function linkMachine(): void {
  const project = { id: 'm1.p-api', name: 'api', path: '/api', defaultTool: null, machine: 'Box', machineId: 'm1', trusted: true }
  w.mgr.useLinkedReader({
    machineOf: (id: string) => (id.startsWith('m1.') ? 'Box' : null),
    machineNamed: (name: string) => (name === 'Box' ? { id: 'm1', name } : null),
    projects: async () => ({ projects: [project], away: [], machines: [{ machine: 'Box', machineId: 'm1' }] }),
    projectSessions: async () => {
      overLink.push('projectSessions')
      return { ok: true as const, sessions: [{ id: 'm1.w1', name: 'Worker', state: 'idle' }] }
    },
    createSession: async () => {
      overLink.push('createSession')
      return { ok: true as const, sessionId: 'm1.new', name: 'New' }
    },
    send: async (sessionId: string, text: string) => {
      overLink.push(`send ${sessionId}: ${text}`)
      return { ok: true as const }
    },
    origin: async () => {
      overLink.push('origin')
      return { ok: false as const, error: 'not asked further here' }
    },
    describe: () => ({ name: 'Worker', project: 'api on Box' }),
    machineLinked: () => true,
    machineWaitsForPerson: () => false,
    backgroundTasks: async () => [],
  } as unknown as LinkedSessions)
}

describe('start_agent', () => {
  beforeEach(() => w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents'))

  it('refused: no child is made, and the answer is the refusal', async () => {
    const s = await w.callerSession()
    const before = sessionCount()
    refusal = S15
    expect(await w.mgr.startAgent(s, { task: 'Write the export', wait: false })).toEqual({ ok: false, error: S15 })
    expect(sessionCount()).toBe(before)
    expect(asked).toEqual([{ callerId: s, target: { projectId: w.caller.id }, call: { tool: 'start_agent', target: w.caller.name, text: 'Write the export' } }])
  })

  it('let go: the child starts as before', async () => {
    const s = await w.callerSession()
    const started = await w.mgr.startAgent(s, { task: 'Write the export', wait: false })
    expect(started).toMatchObject({ ok: true, state: 'working' })
    expect(handleOf(started.ok ? started.sessionId : '')!.sent[0]).toContain('Write the export')
    expect(asked).toHaveLength(1)
  })

  it('on a linked machine: refused before the machine is asked anything', async () => {
    linkMachine()
    const s = await w.callerSession()
    refusal = S15
    expect(await w.mgr.startAgent(s, { task: 'build it there', machine: 'Box', wait: false })).toEqual({ ok: false, error: S15 })
    expect(overLink).toEqual([])
    expect(asked[0]).toEqual({ callerId: s, target: { linked: true }, call: { tool: 'start_agent', target: 'a session on Box', text: 'build it there' } })
  })
})

describe('agent_session send', () => {
  beforeEach(() => w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents'))

  async function restingChild(): Promise<{ s: string; child: string }> {
    const s = await w.callerSession()
    const started = await w.mgr.startAgent(s, { task: 'first job', wait: false })
    const child = started.ok ? started.sessionId : ''
    handleOf(child)!.answer('done')
    await w.until(() => w.mgr.sessionInfo(child)?.state !== 'working')
    await w.mgr.agentSession(s, { sessionId: child, action: 'wait' })
    asked = []
    return { s, child }
  }

  it('refused: nothing reaches the child, and the answer is the refusal; status is no delegation and is not asked', async () => {
    const { s, child } = await restingChild()
    const sent = handleOf(child)!.sent.length
    refusal = S15
    expect(await w.mgr.agentSession(s, { sessionId: child, action: 'status' })).toMatchObject({ ok: true })
    expect(await sendWork(w.mgr, s, child, 'and the linter')).toEqual({ ok: false, error: S15 })
    expect(handleOf(child)!.sent).toHaveLength(sent)
    const name = w.mgr.sessionInfo(child)!.name
    expect(asked).toEqual([{ callerId: s, target: { sessionId: child, projectId: w.caller.id }, call: { tool: 'mail', target: name, text: 'and the linter' } }])
  })

  it('let go: the words reach the child as before', async () => {
    const { s, child } = await restingChild()
    const sending = sendWork(w.mgr, s, child, 'and the linter')
    await w.until(() => handleOf(child)!.sent.some((t) => t.includes('and the linter')))
    handleOf(child)!.answer('linted')
    expect(await sending).toMatchObject({ ok: true })
    expect(asked).toHaveLength(1)
  })

})

describe('ask_project', () => {
  /** A session in the target project; with `consent`, the person allowed the caller's project to give it work */
  async function targetSession(consent = true): Promise<string> {
    const target = await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })
    if (consent) w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    return target.id
  }

  it('refused: nothing is delivered, no card is raised, and the answer is the refusal; a wait with no task is not asked', async () => {
    const caller = await w.callerSession()
    // No consent: a call past the mailbox would raise the card
    const target = await targetSession(false)
    refusal = S15
    await w.mgr.askProject(caller, { project: w.target.id })
    expect(await w.mgr.askProject(caller, { project: w.target.id, session: target, task: 'export the sprites' })).toEqual({ ok: false, error: S15 })
    expect(handleOf(target)?.sent ?? []).toEqual([])
    expect(w.card(caller)).toBeUndefined()
    expect(asked).toEqual([{ callerId: caller, target: { projectId: w.target.id }, call: { tool: 'ask_project', target: w.target.name, text: 'export the sprites' } }])
  })

  it('let go: the task is delivered as before', async () => {
    const caller = await w.callerSession()
    const target = await targetSession()
    const call = w.mgr.askProject(caller, { project: w.target.id, session: target, task: 'export the sprites' })
    await w.until(() => (handleOf(target)?.sent.length ?? 0) === 1)
    handleOf(target)!.answer('exported')
    expect(await call).toMatchObject({ ok: true })
    expect(asked).toHaveLength(1)
  })

  it('from an untrusted project: the refusal, else the trust sentence as before, which names no other project', async () => {
    await w.mgr.setProjectTrusted(w.caller.id, false)
    const caller = await w.callerSession()
    const target = await targetSession()
    refusal = S15
    expect(await w.mgr.askProject(caller, { project: w.target.id, session: target, task: 'export the sprites' })).toEqual({ ok: false, error: S15 })
    refusal = null
    const trust = `Project "${w.caller.name}" is not trusted, so asking another project is refused — the person can trust it from the project menu. ${ASK_THE_PERSON}`
    expect(await w.mgr.askProject(caller, { project: w.target.id, session: target, task: 'export the sprites' })).toEqual({ ok: false, error: trust })
    expect(await w.mgr.askProject(caller, { project: 'nowhere', task: 'x' })).toEqual({ ok: false, error: trust })
    expect(handleOf(target)?.sent ?? []).toEqual([])
  })

  it('on a linked machine: refused before the machine is asked anything', async () => {
    linkMachine()
    const caller = await w.callerSession()
    refusal = S15
    expect(await w.mgr.askProject(caller, { project: 'm1/api', task: 'export there' })).toEqual({ ok: false, error: S15 })
    expect(overLink).toEqual([])
    expect(asked[0]).toEqual({ callerId: caller, target: { projectId: 'm1.p-api', linked: true }, call: { tool: 'ask_project', target: 'api on Box', text: 'export there' } })
  })
})

describe("the Assistant's send_to_session and create_session", () => {
  async function setup(): Promise<{ worker: string; assistant: string }> {
    const worker = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal' })).id
    return { worker, assistant: (await w.mgr.assistant()).id }
  }

  it('send_to_session with reportBack, refused: nothing reaches the session, and the answer carries the refusal', async () => {
    const { worker, assistant } = await setup()
    refusal = S15
    const r = await w.mgr.runCentraluTool(assistant, 'send_to_session', { sessionId: worker, text: 'fix the test', reportBack: true })
    expect(textOf(r)).toContain(S15)
    expect(handleOf(worker)?.sent ?? []).toEqual([])
    const name = w.mgr.sessionInfo(worker)!.name
    expect(asked).toEqual([{ callerId: assistant, target: { sessionId: worker, projectId: w.caller.id }, call: { tool: 'send_to_session', target: name, text: 'fix the test' } }])
  })

  it('send_to_session let go, or without reportBack (not a delegation, never asked): delivered as before', async () => {
    const { worker, assistant } = await setup()
    await w.mgr.runCentraluTool(assistant, 'send_to_session', { sessionId: worker, text: 'fix the test', reportBack: true })
    expect(handleOf(worker)!.sent).toHaveLength(1)
    expect(asked).toHaveLength(1)
    handleOf(worker)!.answer('fixed')
    await w.until(() => w.mgr.sessionInfo(worker)?.state !== 'working')
    refusal = S15
    await w.mgr.runCentraluTool(assistant, 'send_to_session', { sessionId: worker, text: 'just a note' })
    expect(handleOf(worker)!.sent).toHaveLength(2)
    expect(asked).toHaveLength(1)
  })

  it('create_session with a first message, refused: no session is made, and the answer carries the refusal', async () => {
    const { assistant } = await setup()
    const before = sessionCount()
    refusal = S15
    const r = await w.mgr.runCentraluTool(assistant, 'create_session', { project: w.target.id, firstMessage: 'start on the docs' })
    expect(textOf(r)).toContain(S15)
    expect(sessionCount()).toBe(before)
    expect(asked).toEqual([{ callerId: assistant, target: { projectId: w.target.id }, call: { tool: 'create_session', target: w.target.name, text: 'start on the docs' } }])
  })

  it('create_session let go, or with no first message (never asked): made as before', async () => {
    const { assistant } = await setup()
    const before = sessionCount()
    await w.mgr.runCentraluTool(assistant, 'create_session', { project: w.target.id, firstMessage: 'start on the docs' })
    expect(sessionCount()).toBe(before + 1)
    refusal = S15
    await w.mgr.runCentraluTool(assistant, 'create_session', { project: w.target.id })
    expect(sessionCount()).toBe(before + 2)
    expect(asked).toHaveLength(1)
  })

  it('on a linked machine (sendLinked): refused before anything goes over the link; let go, it goes', async () => {
    linkMachine()
    const { assistant } = await setup()
    refusal = S15
    expect(textOf(await w.mgr.runCentraluTool(assistant, 'send_to_session', { sessionId: 'm1.w1', text: 'build it' }))).toContain(S15)
    expect(textOf(await w.mgr.runCentraluTool(assistant, 'create_session', { project: 'm1/api', firstMessage: 'start there' }))).toContain(S15)
    expect(overLink).toEqual([])
    expect(asked.map((a) => [a.target, a.call])).toEqual([
      [{ sessionId: 'm1.w1', linked: true }, { tool: 'send_to_session', target: 'a session on Box', text: 'build it' }],
      [{ linked: true }, { tool: 'create_session', target: 'a session on Box', text: 'start there' }],
    ])
    refusal = null
    await w.mgr.runCentraluTool(assistant, 'send_to_session', { sessionId: 'm1.w1', text: 'build it' })
    expect(overLink).toEqual(['send m1.w1: build it'])
  })
})
