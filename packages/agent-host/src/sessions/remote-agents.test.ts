import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionLiveDefaults, type SessionInfo } from '@cc/protocol'
import type { ChildRunResult, LinkedSessions } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import type { LinkedTasks, TaskStanding } from '../mail/delegation.js'
import { SLOW } from '../../../../tooling/test-timing.js'
import { raceBound } from '../timing.js'
import { AGENT_DEPTH_SETTING, agentDepthKey } from './agent-depth.js'
import { ChildOwnership } from './child-ownership.js'
import { RemoteAgents, REMOTE_AGENTS_KEY, linkedWords, type RemoteAgentsHost } from './remote-agents.js'
import { NO_WORDS } from './ask-project.js'
import { ProjectRegistry, type ProjectRegistryHost } from './project-registry.js'

/**
 * A child on a linked machine as the hub keeps it (#1038), over stand-ins for the link and the mailbox: what a start and a send rest on in the
 * caller, what they give the machine, what a wait reads, the list's state words, and a record an older build kept. Its work goes as mail across
 * the link (#1948 step 6); the real link and the real mail on both hosts are in links/linked-children-mail.test.ts.
 */

const CHILD = 'm1.c1'
const caller = { id: 'h1', name: 'Parent', projectId: 'p1', kind: 'worker', tool: 'claude', permissionPreset: 'normal', ...sessionLiveDefaults() } as unknown as SessionInfo

/** The machine as the hub's reader sees it: one child, its state there and its background work as relayed */
class Machine {
  state = 'idle'
  /** What a start there made, and what was deleted */
  made = 0
  deleted: string[] = []
  interrupted = 0
  cut: { reason: string; at: number } | undefined
  reader(): LinkedSessions {
    return {
      read: async () => ({ ok: true, state: this.state, lines: [] }),
      list: async () => (this.made || this.listed ? [{ sessionId: CHILD, name: 'Child', project: 'app', state: this.state, tool: 'claude', preview: '', machine: 'Box', ...(this.cut ? { interruption: this.cut } : {}) }] : []),
      machineLinked: () => true,
      machineNamed: (n: string) => (n === 'Box' ? { id: 'm1', name: 'Box' } : null),
      lastWords: async () => ({ ok: true as const, text: 'the answer there', length: 0, seq: null }),
      cards: async () => ({ ok: true, cards: [] }),
      createSession: async () => {
        this.made++
        return { ok: true, sessionId: CHILD, name: 'Child' }
      },
      projects: async () => ({ projects: [{ id: 'm1.p', machineId: 'm1', machine: 'Box', name: 'app', path: '/app' }], away: [] }),
      origin: async () => ({ ok: true, origin: 'git@github.com:me/app.git' }),
      interrupt: async () => {
        this.interrupted++
        return { ok: true }
      },
      deleteSession: async (id: string) => {
        this.deleted.push(id)
        return { ok: true }
      },
    } as unknown as LinkedSessions
  }
  /** Listed though no start made it: a child the record names already */
  listed = false
}

/** The mailbox's work across the link, as `LinkedTasks` gives it: each task sent, and how each stands */
class Tasks {
  readonly sent: { callerId: string; childId: string; text: string; task: unknown }[] = []
  readonly standing = new Map<string, TaskStanding>()
  readonly withdrawn: string[] = []
  readonly gone: string[] = []
  readonly answered: string[] = []
  refusal: string | null = null
  private readonly listeners = new Set<() => void>()
  private n = 0
  /** The report on task `id` comes back */
  report(id: string, s: TaskStanding): void {
    this.standing.set(id, s)
    for (const l of this.listeners) l()
  }
  api(): LinkedTasks {
    return {
      send: async (callerId, childId, text, task) => {
        if (this.refusal) return { ok: false, why: 'older', text: this.refusal }
        const id = `hub.m_${++this.n}`
        this.sent.push({ callerId, childId, text, task })
        this.standing.set(id, { state: 'open' })
        return { ok: true, messageId: id, to: 'Child', address: childId, computer: 'Box' }
      },
      open: () => [...this.standing].reverse().find(([, s]) => s.state === 'open')?.[0],
      standing: (id) => this.standing.get(id) ?? { state: 'open' },
      lastAnswer: () => [...this.standing.values()].reverse().flatMap((s) => (s.state === 'reported' && s.answer ? [s.answer] : []))[0],
      settled: (id, boundMs, { signal, until } = {}) => {
        const reported = new Promise<'settled'>((resolve) => {
          const check = () => (this.standing.get(id) ?? { state: 'open' }).state !== 'open' && resolve('settled')
          this.listeners.add(check)
          check()
        })
        return raceBound(until ? Promise.race([reported, until.then(() => 'settled' as const)]) : reported, boundMs, signal)
      },
      asks: () => [],
      refusal: () => this.refusal,
      keep: () => {},
      holdReports: () => () => {},
      withdrawAsks: () => 0,
      withdraw: (callerId) => {
        let n = 0
        for (const [id, s] of this.standing) {
          if (s.state !== 'open') continue
          this.standing.set(id, { state: 'ended', why: 'withdrawn' })
          n++
        }
        this.withdrawn.push(callerId)
        return n
      },
      gone: (childId) => void this.gone.push(childId),
    }
  }
}

let store: Store
let machine: Machine
let tasks: Tasks
let meta: Map<string, SessionInfo>
let told: string[]
/** What a test puts in place of the manager's members (its cards, its `auto` boundary) */
let more: Record<string, unknown>

function agents(): RemoteAgents {
  const children = new ChildOwnership(store)
  children.onAnswered((callerId, childId) => void tasks.answered.push(`${callerId}>${childId}`))
  const host = {
    children,
    store,
    linkedReader: machine.reader(),
    linkedTasks: tasks.api(),
    meta,
    linkedReports: { tasksOf: () => linkedWork },
    tellSession: async (_to: string, text: string) => void told.push(text),
    autoBoundaryOpen: () => false,
    emit: () => {},
    uiPreferences: () => ({}),
    adapters: new Map(),
    hostCards: { askHost: async () => 'allow' },
    files: { projectOrigin: async () => 'https://github.com/me/app' },
    closing: false,
    ...more,
  } as unknown as RemoteAgentsHost
  // The manager's project-trust gate over this host's store and its `auto` (#2159)
  const registry = new ProjectRegistry(host as unknown as ProjectRegistryHost)
  const ra = new RemoteAgents(Object.assign(host, { trustGate: (...a: Parameters<typeof registry.trustGate>) => registry.trustGate(...a) }), { agentCeilingError: () => null, reservePlace: () => ({ release: () => {} }) })
  ra.machineTasks = () => true
  ra.restore()
  return ra
}
/** The child's background work as its machine last relayed it (`LinkedReports.tasksOf`) */
let linkedWork: { id: string; kind: string; description: string; status: string }[]

beforeEach(() => {
  store = new Store()
  store.projects.addProject({ id: 'p1', path: '/p', name: 'p' })
  store.projects.setProjectTrusted('p1', true)
  machine = new Machine()
  tasks = new Tasks()
  meta = new Map([[caller.id, caller]])
  told = []
  more = {}
  linkedWork = []
})
afterEach(() => store.close())

const start = (ra: RemoteAgents, o: Record<string, unknown> = {}) => ra.startAgent('h1', { task: 'TASK-TEXT', machine: 'Box', wait: false, ...o })
const act = (ra: RemoteAgents, action: string, o: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ChildRunResult> =>
  ra.agentSession('h1', ra.of(CHILD)!, { sessionId: CHILD, action, ...o } as never, signal)
const send = (ra: RemoteAgents, text: string) => ra.send('h1', ra.of(CHILD)!, text)

describe('the work a start and a send give a child on a linked machine (#1948 step 6)', () => {
  it("gives the start's task, framed, as a task across the link from the caller", async () => {
    const ra = agents()
    expect(await start(ra)).toMatchObject({ ok: true, state: 'working', reported: true, sessionId: CHILD })
    expect(tasks.sent).toEqual([{ callerId: 'h1', childId: CHILD, text: expect.stringContaining('TASK-TEXT'), task: { origin: 'start_agent' } }])
    expect(tasks.sent[0]!.text).toContain('gives you this task through Centralu\'s start_agent')
  })

  it('gives more work as a task of agent_session, busy there or not: the machine holds it', async () => {
    const ra = agents()
    await start(ra)
    machine.state = 'working'
    expect(await send(ra, 'and this')).toMatchObject({ ok: true, state: 'working', reported: true })
    expect(tasks.sent.at(-1)).toEqual({ callerId: 'h1', childId: CHILD, text: 'and this', task: { origin: 'agent_session' } })
  })

  it("says the machine's refusal of a send in its words", async () => {
    const ra = agents()
    await start(ra)
    tasks.refusal = 'Box runs an older Centralu, which takes no work from this computer. Update Centralu on Box.'
    expect(await send(ra, 'and this')).toEqual({ ok: false, error: 'Could not send to "Child" on Box: Box runs an older Centralu, which takes no work from this computer. Update Centralu on Box.' })
  })

  it("says that this computer's mail is not running, not that the machine is older, when there is no mail to carry the work", async () => {
    const ra = agents()
    await start(ra)
    more = { linkedTasks: null }
    const without = agents()
    expect(await start(without)).toEqual({ ok: false, error: 'Nothing was made on Box: this computer gives work to another machine only by mail, and its mail is not running.' })
    expect(await send(without, 'and this')).toEqual({ ok: false, error: 'Could not send to "Child" on Box: this computer gives work to another machine only by mail, and its mail is not running.' })
  })

  it('refuses a start on a machine that takes no tasks before its card, and makes nothing there', async () => {
    const askHost = vi.fn(async () => 'allow')
    more = { hostCards: { askHost } }
    const ra = agents()
    ra.machineTasks = () => false
    expect(await start(ra)).toEqual({ ok: false, error: 'Box runs an older Centralu, which takes no work from this computer. Update Centralu on Box, or start the session here.' })
    expect(askHost).not.toHaveBeenCalled()
    expect(machine.made).toBe(0)
  })

  it('keeps the child it made and says so when the machine did not take its task', async () => {
    const ra = agents()
    tasks.refusal = 'the link dropped'
    expect(await start(ra)).toEqual({ ok: false, error: `The session "Child" [${CHILD}] was made on Box but did not take the task: the link dropped. Send it again by mail, or delete it with agent_session.` })
    expect(ra.of(CHILD)).toBeTruthy()
  })

  it('a difficulty with no model set for the tool says so, naming the machine as what picks the model (#2350)', async () => {
    const r = await start(agents(), { difficulty: 'heavy' })
    expect(r).toMatchObject({ ok: true, notice: expect.stringMatching(/no heavy model is set for \S+; it runs on the model Box picks for it/) })
  })

  it("stops the child there and withdraws the caller's open tasks to it", async () => {
    const ra = agents()
    await start(ra)
    expect(await act(ra, 'stop')).toMatchObject({ ok: true, state: 'stopped' })
    expect(machine.interrupted).toBe(1)
    expect(tasks.withdrawn).toEqual(['h1'])
    expect([...tasks.standing.values()]).toEqual([{ state: 'ended', why: 'withdrawn' }])
  })
})

describe('a call that waits on a child on a linked machine reads the report on its task (#1948 step 6)', () => {
  it("answers with the child's words once the report comes back, and marks the reports read for the caller", async () => {
    const ra = agents()
    await start(ra)
    const waiting = act(ra, 'wait')
    tasks.report('hub.m_1', { state: 'reported', outcome: 'finished', answer: 'the answer…', owner: 'session:hub/h1' })
    expect(await waiting).toMatchObject({ ok: true, state: 'done', answer: 'the answer there', notice: expect.stringContaining('works on Box') })
    expect(tasks.answered).toEqual([`h1>${CHILD}`])
  })

  it('answers a failed turn with its kind, and a task that ended with no report as that', async () => {
    const ra = agents()
    await start(ra)
    let waiting = act(ra, 'wait')
    tasks.report('hub.m_1', { state: 'reported', outcome: 'failed', error: 'network', owner: 'session:hub/h1' })
    expect(await waiting).toEqual({ ok: false, error: `"Child" [${CHILD}] on Box did not finish: network. Tell the person, or give it a clearer task.` })
    await send(ra, 'again')
    waiting = act(ra, 'wait')
    tasks.report('hub.m_2', { state: 'ended', why: 'gone' })
    expect(await waiting).toEqual({ ok: false, error: `"Child" [${CHILD}] on Box did not finish: its task there ended with no report (gone).` })
  })

  it('says a paused turn leaves its final report to come as mail', async () => {
    const ra = agents()
    await start(ra)
    const waiting = act(ra, 'wait')
    tasks.report('hub.m_1', { state: 'reported', outcome: 'paused', owner: 'session:hub/h1' })
    expect(await waiting).toMatchObject({ ok: true, state: 'done', notice: expect.stringContaining('a final report follows when that work ends') })
  })

  it('ends at once when the child is deleted there, and when the call is cancelled', async () => {
    const ra = agents()
    await start(ra)
    const waiting = act(ra, 'wait')
    ra.observe({ type: 'session_deleted', sessionId: CHILD })
    expect(await waiting).toEqual({ ok: false, error: `"Child" [${CHILD}] was deleted on Box before it finished.` })
    expect(ra.of(CHILD)).toBeUndefined()
    const other = agents()
    await start(other)
    const ctl = new AbortController()
    const cancelled = act(other, 'wait', {}, ctl.signal)
    ctl.abort()
    expect(await cancelled).toEqual({ ok: false, error: 'The call was cancelled; "Child" was left running on Box.' })
  })

  it("reads a child with no open task of the caller's by its state word, and at rest by the answer its last report kept, nothing of another's turn", async () => {
    machine.listed = true
    store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify([{ sessionId: CHILD, callerId: 'h1', machineId: 'm1', machine: 'Box', name: 'Child', tool: 'claude', project: 'app', startedAt: 1 }]))
    const fresh = agents()
    machine.state = 'working'
    expect(await act(fresh, 'status')).toMatchObject({ ok: true, state: 'working', reported: false })
    machine.state = 'idle'
    expect(await act(fresh, 'wait')).toMatchObject({ ok: true, state: 'at_rest', answer: '(no report on a task you gave it has come back)' })
  })
})

describe('a child on a linked machine, as agent_session list shows it (#1038 review)', () => {
  beforeEach(() => {
    machine.listed = true
    store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify([{ sessionId: CHILD, callerId: 'h1', machineId: 'm1', machine: 'Box', name: 'Child', tool: 'claude', project: 'app', startedAt: 1 }]))
  })

  it("lists the child's state as its machine reports it", async () => {
    const ra = agents()
    machine.state = 'working'
    expect(await ra.rows('h1')).toEqual([expect.objectContaining({ sessionId: CHILD, state: 'working', machine: 'Box' })])
    machine.state = 'waiting_approval'
    expect(await ra.rows('h1')).toEqual([expect.objectContaining({ state: 'waiting' })])
    machine.state = 'idle'
    expect(await ra.rows('h1')).toEqual([expect.objectContaining({ state: 'finished' })])
  })

  // #2146: its turn ended there while its own background work runs, as its machine relays that work
  it('lists the child as paused while its machine lists its own background work running after its turn', async () => {
    const ra = agents()
    machine.state = 'waiting_input'
    linkedWork = [{ id: 'a1', kind: 'agent', description: 'review', status: 'running' }]
    expect(await ra.rows('h1')).toEqual([expect.objectContaining({ state: 'paused' })])
    linkedWork = [{ id: 'a1', kind: 'agent', description: 'review', status: 'completed' }]
    expect(await ra.rows('h1')).toEqual([expect.objectContaining({ state: 'finished' })])
  })

  it('lists the child as stopped, never paused, when its turn there was cut short with its work still running (#2146 review)', async () => {
    const ra = agents()
    linkedWork = [{ id: 'a1', kind: 'agent', description: 'review', status: 'running' }]
    machine.cut = { reason: 'interrupted', at: 5 }
    expect(await ra.rows('h1')).toEqual([expect.objectContaining({ state: 'stopped' })])
  })
})

/*
 * A build before #1948 step 6 kept what it owed the caller of the child's turn in the record (`owed`), with its own reading of whose each turn
 * there was. That report path is gone: the caller is told once where the child stands, and the old fields go
 */
describe('a record an older build kept', () => {
  const legacy = { sessionId: CHILD, callerId: 'h1', machineId: 'm1', machine: 'Box', name: 'Child', tool: 'claude', project: 'app', startedAt: 1 }

  it('tells the caller of a child it owed a report once, and drops the old fields', () => {
    store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify([{ ...legacy, owed: {}, whose: 'caller', sent: 'TASK', turn: 't1', given: [3], queued: [{ id: 'q', text: 'x' }] }]))
    agents()
    expect(told).toEqual([
      `[Centralu] Centralu was updated while "Child" on Box was working on a task from this session, so its report will not arrive. read_session(sessionId="${CHILD}") shows where it stands.\n` +
        '[Centralu] Centralu was updated while a message from this session waited for "Child" on Box to be free. It was not sent; send again what still matters.',
    ])
    expect(JSON.parse(store.settings.appSetting(REMOTE_AGENTS_KEY)!)).toEqual([legacy])
    agents()
    expect(told).toHaveLength(1)
  })

  it('tells a caller of two such children once, in one notice', () => {
    store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify([{ ...legacy, owed: {} }, { ...legacy, sessionId: 'm1.c2', name: 'Other', owed: {} }]))
    agents()
    expect(told).toEqual([
      `[Centralu] Centralu was updated while "Child" on Box was working on a task from this session, so its report will not arrive. read_session(sessionId="${CHILD}") shows where it stands.\n` +
        '[Centralu] Centralu was updated while "Other" on Box was working on a task from this session, so its report will not arrive. read_session(sessionId="m1.c2") shows where it stands.',
    ])
  })

  it('tells the caller of messages it held for a busy child, owed nothing else, that they were not sent', () => {
    store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify([{ ...legacy, queued: [{ id: 'q1', text: 'x' }, { id: 'q2', text: 'y' }] }]))
    agents()
    expect(told).toEqual(['[Centralu] Centralu was updated while 2 messages from this session waited for "Child" on Box to be free. They were not sent; send again what still matters.'])
    expect(JSON.parse(store.settings.appSetting(REMOTE_AGENTS_KEY)!)).toEqual([legacy])
  })

  it('tells nobody of one it owed nothing, nor a caller that is gone, and drops the old fields all the same', () => {
    store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify([{ ...legacy, whose: 'other' }, { ...legacy, sessionId: 'm1.c2', callerId: 'gone', owed: {} }]))
    agents()
    expect(told).toEqual([])
    expect(JSON.parse(store.settings.appSetting(REMOTE_AGENTS_KEY)!)).toEqual([legacy, { ...legacy, sessionId: 'm1.c2', callerId: 'gone' }])
  })
})

/*
 * #1161: a reader from before `agentInstructions` and `deleteAgentChild` (a build that predates them, a stand-in), or one whose new calls fail or
 * never answer, starts and deletes as it did before
 */
describe('a reader from before #1161, or one whose new calls fail', () => {
  const withReader = (extra: Partial<LinkedSessions>, listed?: string) => {
    const plain = Machine.prototype.reader.bind(machine)
    machine.reader = () => {
      const r = plain()
      const projects = listed === undefined ? r.projects : async () => ({ projects: [{ id: 'm1.p', machineId: 'm1', machine: 'Box', name: 'app', path: '/app', defaultTool: null, agentInstructions: listed }], away: [] })
      return { ...r, projects, ...extra } as LinkedSessions
    }
    return agents()
  }

  it('starts the child with what the machine listed when the reader has no agentInstructions, and with none when it listed none', async () => {
    expect(await start(withReader({}, 'LISTED-TEXT'))).toMatchObject({ ok: true })
    expect(tasks.sent[0]!.text).toContain('LISTED-TEXT')
    expect(await start(withReader({}))).toMatchObject({ ok: true })
    expect(tasks.sent[1]!.text).toContain('TASK-TEXT')
    expect(tasks.sent[1]!.text).not.toContain('standing instructions')
  })

  it('starts the child with what the machine listed when the read throws', async () => {
    expect(await start(withReader({ agentInstructions: async () => { throw new Error('the link broke') } }, 'LISTED-TEXT'))).toMatchObject({ ok: true })
    expect(tasks.sent[0]!.text).toContain('LISTED-TEXT')
  })

  it('starts the child with what the machine listed when the read never answers', async () => {
    expect(await start(withReader({ agentInstructions: () => new Promise(() => {}) }, 'LISTED-TEXT'))).toMatchObject({ ok: true })
    expect(tasks.sent[0]!.text).toContain('LISTED-TEXT')
  }, 20_000 * SLOW)

  it('deletes a worktree child as before when the reader has no deleteAgentChild, and answers when the call throws', async () => {
    let ra = withReader({})
    expect(await start(ra, { branch: 'feat-x' })).toMatchObject({ ok: true })
    expect(await act(ra, 'delete')).toMatchObject({ ok: true, state: 'deleted', notice: expect.stringContaining('its worktree there, on feat-x, stays') })
    ra = withReader({ deleteAgentChild: async () => { throw new Error('the link broke') } })
    expect(await start(ra, { branch: 'feat-x' })).toMatchObject({ ok: true })
    expect(await act(ra, 'delete')).toMatchObject({ ok: false, error: expect.stringContaining('the link broke') })
  })
})

/*
 * What a start and a send on a linked machine rest on in the caller (#1038 review, #2159): the checks of a local start, read again after the card
 * and before each send. An `auto` caller crossing out of an untrusted project is logged once, at the start, as a local start logs it
 */
describe('what a start and a send on a linked machine rest on in the caller', () => {
  /** The session manager's `auto` boundary as it is: open for an `auto` caller, logged when it names what it opens */
  const autoBoundaryOpen = (id: string, boundary?: string) => {
    if (meta.get(id)?.permissionPreset !== 'auto') return false
    if (boundary) console.error(`[permissions] auto session ${id}: ${boundary} allowed`)
    return true
  }
  const asAuto = () => meta.set(caller.id, { ...caller, permissionPreset: 'auto' })
  let log: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    log = vi.spyOn(console, 'error').mockImplementation(() => {})
    more = { autoBoundaryOpen }
  })
  afterEach(() => log.mockRestore())

  it('refuses a start whose project the person stopped trusting while its card stood, in the words of a local start', async () => {
    more = { autoBoundaryOpen, hostCards: { askHost: async () => (store.projects.setProjectTrusted('p1', false), 'allow') } }
    expect(await start(agents())).toMatchObject({ ok: false, error: expect.stringContaining('is not trusted, so starting agents is refused') })
    expect(tasks.sent).toEqual([])
  })

  it('logs an auto caller in an untrusted project once, at the start, not after its card or at each send', async () => {
    store.projects.setProjectTrusted('p1', false)
    asAuto()
    const ra = agents()
    expect(await start(ra)).toMatchObject({ ok: true })
    expect(await send(ra, 'more work')).toMatchObject({ ok: true, state: 'working' })
    expect(tasks.sent).toHaveLength(2)
    const crossed = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('starting agents'))
    expect(crossed).toEqual(['[permissions] auto session h1: starting agents (untrusted project "p") allowed'])
  })

  // Who may start, and send, in which project (RV13): each condition, on each path that reads it, refused or let through
  const CONDITIONS: Record<string, { set: () => void; refused: string | null }> = {
    'a trusted project, normal': { set: () => {}, refused: null },
    'an untrusted project, normal': { set: () => store.projects.setProjectTrusted('p1', false), refused: 'is not trusted, so starting agents is refused' },
    'an untrusted project, auto': { set: () => (store.projects.setProjectTrusted('p1', false), asAuto()), refused: null },
    'its project no longer registered': { set: () => meta.set(caller.id, { ...caller, projectId: 'p-gone' }), refused: 'no longer registered' },
    'at the agent depth': { set: () => store.settings.setAppSetting(agentDepthKey(caller.id), '9'), refused: AGENT_DEPTH_SETTING },
  }
  const PATHS: Record<string, (set: () => void) => Promise<ChildRunResult>> = {
    'a start, before its card': async (set) => (set(), start(agents())),
    'a start, while its card stands': async (set) => {
      more = { autoBoundaryOpen, hostCards: { askHost: async () => (set(), 'allow') } }
      return start(agents())
    },
    'more work': async (set) => {
      const ra = agents()
      await start(ra)
      set()
      return send(ra, 'more work')
    },
  }
  describe.each(Object.keys(PATHS))('%s', (path) => {
    it.each(Object.keys(CONDITIONS))('%s', async (name) => {
      const { set, refused } = CONDITIONS[name]!
      const r = await PATHS[path]!(set)
      if (refused) expect(r).toMatchObject({ ok: false, error: expect.stringContaining(refused) })
      else expect(r).toMatchObject({ ok: true })
    })
  })

  // The Assistant's place is no project (`''`), and a caller of a linked machine's agent is a project's session: one that reads as the Assistant by
  // the time its card is answered, or when it sends, has no project registered, not the Assistant's place to start from (`|| null`, not `?? null`)
  const turnsAssistant = () => meta.set(caller.id, { ...caller, kind: 'orchestrator', projectId: '' } as unknown as SessionInfo)

  it('does not read a caller that became the Assistant while its card stood as the Assistant starting an agent', async () => {
    more = { autoBoundaryOpen, hostCards: { askHost: async () => (turnsAssistant(), 'allow') } }
    expect(await start(agents())).toMatchObject({ ok: false, error: expect.stringContaining('no longer registered') })
    expect(tasks.sent).toEqual([])
  })

  it('does not send a caller that became the Assistant to its child as the Assistant', async () => {
    const ra = agents()
    await start(ra)
    turnsAssistant()
    expect(await send(ra, 'a note')).toMatchObject({ ok: false, error: expect.stringContaining('no longer registered') })
  })

  it('refuses a start whose caller is gone once its card is answered', async () => {
    more = { autoBoundaryOpen, hostCards: { askHost: async () => (meta.delete(caller.id), 'allow') } }
    expect(await start(agents())).toMatchObject({ ok: false, error: 'The session that asked is no longer here.' })
    expect(tasks.sent).toEqual([])
  })
})

describe("the answer of a task on a linked machine (`linkedWords`, #1812)", () => {
  const reading = (text: string | Error): Pick<LinkedSessions, 'lastWords'> => ({
    lastWords: async () => (text instanceof Error ? { ok: false as const, error: text.message } : { ok: true as const, text, length: text.length, seq: 9 }),
  })
  const words = (reader: Pick<LinkedSessions, 'lastWords'> | null, kept: string | undefined) => linkedWords(reader as LinkedSessions | null, CHILD, 'c1', kept)

  it("is the report's words; the session's last words there only when they are its, which give it whole", async () => {
    expect(await words(reading('a later turn: the person asked something else'), 'the branch builds')).toBe('the branch builds')
    expect(await words(reading('the branch builds, and every test passes'), 'the branch builds…')).toBe('the branch builds, and every test passes')
  })

  it('says a turn that kept no words said nothing, whatever the session said later', async () => {
    expect(await words(reading('a later turn'), undefined)).toBe(NO_WORDS)
    expect(await words(null, '')).toBe(NO_WORDS)
  })

  it('names the read that shows the rest of a cut answer it cannot read there', async () => {
    expect(await words(reading(new Error('Box is not reachable right now')), 'the branch builds…')).toBe(`the branch builds…[the rest is cut here; read_session(sessionId="${CHILD}") reads it whole]`)
    expect(await words(null, 'the branch builds')).toBe('the branch builds')
  })
})
