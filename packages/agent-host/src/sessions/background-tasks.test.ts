import { describe, expect, it } from 'vitest'
import type { BackgroundTask, NormalizedEvent } from '@cc/protocol'
import type { AgentAdapter, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'
import { hostBusy } from '../idle.js'

/**
 * The manager keeps each session's background work (#290): the live set the adapter reports, the ended tasks it
 * keeps listed, the stop and clear requests, and the idle check #297 builds on.
 */

type Fake = SessionHandle & { emit: EventSink; stopped: string[] }

function fakeAdapter(handles: Fake[], opts: { reports?: boolean; stoppable?: boolean } = {}): AgentAdapter {
  return {
    tool: 'claude',
    descriptor: { name: 'claude', label: 'Claude Code', mark: 'C', install: 'npm i -g x', login: 'x login' },
    capabilities: {
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false,
      backgroundTasks: opts.reports ?? true,
    },
    detect: async () => ({ tool: 'claude', installed: true, loggedIn: true, detail: 'fake' }),
    createSession: async (o, emit): Promise<SessionHandle> => {
      const h: Fake = {
        sessionId: o.sessionId,
        externalId: `ext-${o.sessionId}`,
        emit,
        stopped: [],
        send: () => {},
        respondApproval: () => true,
        interrupt: () => {},
        dispose: async () => {},
        ...(opts.stoppable === false ? {} : { stopBackgroundTask: async (id: string) => void h.stopped.push(id) }),
      }
      handles.push(h)
      return h
    },
  }
}

const agent = (id: string, extra: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id, kind: 'agent', description: `task ${id}`, parentCallId: `toolu_${id}`, stopsWithTurn: true, stoppable: true, status: 'running', ...extra,
})

async function setup(opts: { reports?: boolean; stoppable?: boolean } = {}) {
  const handles: Fake[] = []
  const events: NormalizedEvent[] = []
  const mgr = new SessionManager(new Store(), new Map([['claude', fakeAdapter(handles, opts)]]), (e) => events.push(e))
  const project = await mgr.addProject(process.cwd())
  const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
  const info = () => mgr.listSessions().find((s) => s.id === session.id)!
  const tasks = (live: BackgroundTask[], ended?: BackgroundTask[], h = handles.at(-1)!) =>
    h.emit({ type: 'background_tasks', sessionId: session.id, live, ...(ended ? { ended } : {}) })
  return { mgr, session, handles, events, info, tasks }
}

describe('a session\'s background tasks in the manager (#290)', () => {
  it('keeps the live set the adapter reports, replaced each time, and the ended tasks with their status', async () => {
    const { info, tasks } = await setup()
    tasks([agent('a'), agent('b')])
    expect(info().backgroundTasks.map((t) => [t.id, t.status])).toEqual([['a', 'running'], ['b', 'running']])
    tasks([agent('b')], [agent('a', { status: 'stopped' })])
    expect(info().backgroundTasks.map((t) => [t.id, t.status])).toEqual([['b', 'running'], ['a', 'stopped']])
  })

  it('passes the event on, so the screen and a reconnect read the same list', async () => {
    const { events, tasks, session } = await setup()
    tasks([agent('a')])
    expect(events.filter((e) => e.type === 'background_tasks').at(-1)).toMatchObject({ sessionId: session.id, live: [{ id: 'a' }] })
  })

  it('stops a task through the adapter only when it is listed as running and stoppable', async () => {
    const { mgr, session, handles, tasks } = await setup()
    tasks([agent('a'), agent('w', { stoppable: false })], [agent('x', { status: 'completed' })])
    await mgr.stopBackgroundTask(session.id, 'a')
    expect(handles[0]!.stopped).toEqual(['a'])
    await expect(mgr.stopBackgroundTask(session.id, 'x')).rejects.toThrow(/no longer running/)
    await expect(mgr.stopBackgroundTask(session.id, 'gone')).rejects.toThrow(/no longer running/)
    await expect(mgr.stopBackgroundTask(session.id, 'w')).rejects.toThrow(/cannot be stopped/)
    expect(handles[0]!.stopped).toEqual(['a'])
  })

  it('an adapter that cannot stop a task alone is refused rather than asked', async () => {
    const { mgr, session, tasks } = await setup({ stoppable: false })
    tasks([agent('a')])
    await expect(mgr.stopBackgroundTask(session.id, 'a')).rejects.toThrow(/cannot be stopped/)
  })

  it('clearing takes the ended tasks off the list and keeps the running ones, and tells the screen', async () => {
    const { mgr, session, events, info, tasks } = await setup()
    tasks([agent('a')], [agent('x', { status: 'failed' })])
    mgr.clearBackgroundTasks(session.id)
    expect(info().backgroundTasks.map((t) => t.id)).toEqual(['a'])
    expect(events.at(-1)).toMatchObject({ type: 'background_tasks', live: [{ id: 'a' }], clearEnded: true })
  })

  it('a set-aside process\'s endings are kept, but its empty set does not wipe the new process\'s tasks', async () => {
    const { mgr, session, handles, info, tasks } = await setup()
    tasks([agent('a')])
    const old = handles[0]!
    await mgr.restartSession(session.id)
    expect(handles).toHaveLength(2)
    tasks([agent('n')], undefined, handles[1])
    // The old process says, late, that its task went with it
    tasks([], [agent('a', { status: 'stopped' })], old)
    expect(info().backgroundTasks.map((t) => [t.id, t.status])).toEqual([['n', 'running'], ['a', 'stopped']])
    // And with nothing ended, a stale set is dropped entirely
    tasks([], undefined, old)
    expect(info().backgroundTasks.map((t) => t.id)).toEqual(['n', 'a'])
  })
})

describe('whether a session is idle (#290, for #297)', () => {
  it('idle with no turn, nothing waiting on the person and no background task running', async () => {
    const { mgr, session } = await setup()
    expect(mgr.sessionIdle(session.id)).toEqual({ idle: true })
  })

  it('not idle while a background task runs, but ambient and ended ones do not count', async () => {
    const { mgr, session, tasks } = await setup()
    tasks([agent('a')])
    expect(mgr.sessionIdle(session.id)).toEqual({ idle: false, reason: 'background' })
    tasks([agent('w', { ambient: true })], [agent('a', { status: 'completed' })])
    expect(mgr.sessionIdle(session.id)).toEqual({ idle: true })
  })

  it('not idle during a turn, or while an approval or a question waits', async () => {
    const { mgr, session, handles } = await setup()
    const h = handles[0]!
    h.emit({ type: 'message_delta', sessionId: session.id, role: 'assistant', text: 'working' })
    expect(mgr.sessionIdle(session.id)).toEqual({ idle: false, reason: 'turn' })
    h.emit({ type: 'approval_request', sessionId: session.id, requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/' } })
    expect(mgr.sessionIdle(session.id)).toEqual({ idle: false, reason: 'approval' })
    h.emit({ type: 'approval_resolved', sessionId: session.id, requestId: 'r1', decision: 'allow' })
    h.emit({ type: 'question_request', sessionId: session.id, requestId: 'q1', questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] })
    expect(mgr.sessionIdle(session.id)).toEqual({ idle: false, reason: 'question' })
    h.emit({ type: 'question_resolved', sessionId: session.id, requestId: 'q1' })
    h.emit({ type: 'turn_complete', sessionId: session.id })
    expect(mgr.sessionIdle(session.id)).toEqual({ idle: true })
  })

  /*
   * The host-wide rule the keeper's idle exit and #352's automatic apply read, fed the manager's own list as main.ts
   * feeds it: a finished turn is not busy, a waiting question or a running background task is.
   */
  it('the host idle rule over the manager’s list: a finished turn is idle, a waiting question or background work is not', async () => {
    const { mgr, session, handles, tasks } = await setup()
    const h = handles[0]!
    const busy = () => hostBusy({ sessions: mgr.listSessions(), terminals: 0, commandRuns: 0 })
    h.emit({ type: 'message_delta', sessionId: session.id, role: 'assistant', text: 'working' })
    expect(busy()).toBe(true)
    h.emit({ type: 'turn_complete', sessionId: session.id })
    expect(mgr.listSessions()[0]!.state).toBe('waiting_input')
    expect(busy()).toBe(false)
    h.emit({ type: 'question_request', sessionId: session.id, requestId: 'q2', questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }] }] })
    expect(busy()).toBe(true)
    h.emit({ type: 'question_resolved', sessionId: session.id, requestId: 'q2' })
    expect(busy()).toBe(false)
    tasks([agent('a')])
    expect(busy()).toBe(true)
  })

  it('a tool that cannot report its background work is never called idle while its process lives', async () => {
    const { mgr, session } = await setup({ reports: false })
    expect(mgr.sessionIdle(session.id)).toEqual({ idle: false, reason: 'background_unknown' })
  })
})
