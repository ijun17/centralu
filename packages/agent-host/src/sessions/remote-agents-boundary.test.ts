import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionLiveDefaults, type SessionInfo } from '@cc/protocol'
import type { ChildRunResult, LinkedSessions } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SLOW, eventually } from '../../../../tooling/test-timing.js'
import { ChildOwnership } from './child-ownership.js'
import { LinkedReports, type LinkedEvent, type LinkedReportsHost } from './linked-reports.js'
import { RemoteAgents, REMOTE_AGENTS_KEY, type RemoteAgentsHost } from './remote-agents.js'

/**
 * The boundary of a child on a linked machine (#1038 review, RV13): the person may use the same session on that
 * machine, and nothing of a turn that is not the caller's reaches the caller, whatever path asks. One table: every path
 * that hands the caller anything of the child, in every way the person's turn can come about. Each cell checks that
 * nothing of the person's turn (its message, its card, its words, an answer to its card, a report of it) reached the
 * caller, and that the caller's own text did not slip into it.
 *
 * The machine is a stand-in that keeps the child's state, its conversation and its card, relays events in order as a
 * link does, and drops them while its link is down; the hub side is the real `RemoteAgents`, `ChildOwnership` and
 * `LinkedReports` wired as the session manager wires them.
 */

/** What only the person's turn says: none of it may reach the caller */
const PERSON = { message: 'my own thing', question: 'Delete prod?', words: 'PERSON-WORDS, the private answer' }
/** This hub's sender as the machine records it, qualified by its link */
const HUB_FROM = { sessionId: 'm1._hub-orchestrator' }
const CHILD = 'm1.c1'

const caller = { id: 'h1', name: 'Parent', projectId: 'p1', kind: 'worker', tool: 'claude', permissionPreset: 'normal', ...sessionLiveDefaults() } as unknown as SessionInfo

type Msg = { seq: number; role: 'user' | 'assistant'; kind: 'text'; payload: { text: string; from?: unknown } }

/** The child's machine: one session, the person at its keyboard, and the link to the hub */
class Machine {
  reachable = true
  state: 'idle' | 'working' = 'idle'
  turn: 'hub' | 'person' | 'self' | null = null
  question: { requestId: string; questions: unknown[] } | null = null
  readonly transcript: Msg[] = []
  readonly answered: string[] = []
  /** Every instruction the hub's sends put into the session */
  readonly fromHub: string[] = []
  sends = 0
  hold: Promise<void> | null = null
  private seq = 0
  private cards = 0

  constructor(private readonly relay: (e: LinkedEvent) => void) {}

  private out(e: LinkedEvent): void {
    if (this.reachable) this.relay(e)
  }
  private take(text: string, from?: unknown): void {
    const seq = ++this.seq
    this.transcript.push({ seq, role: 'user', kind: 'text', payload: { text, ...(from ? { from } : {}) } })
    this.out({ type: 'user_message', sessionId: CHILD, seq, text, ...(from ? { from } : {}) })
  }
  private begin(who: 'hub' | 'person' | 'self'): void {
    this.state = 'working'
    this.turn = who
    this.out({ type: 'state_change', sessionId: CHILD, state: 'working' })
  }
  private end(words: string): void {
    this.transcript.push({ seq: ++this.seq, role: 'assistant', kind: 'text', payload: { text: words } })
    this.out({ type: 'message_delta', sessionId: CHILD, role: 'assistant', text: words } as LinkedEvent)
    this.question = null
    this.state = 'idle'
    this.turn = null
    this.out({ type: 'turn_complete', sessionId: CHILD })
  }
  /** The person types into the session there: a turn of theirs if none runs, a message into the running one if one does */
  personSays(text = PERSON.message): void {
    this.take(text)
    if (this.state === 'idle') this.begin('person')
  }
  personAsks(): void {
    this.question = { requestId: `r${++this.cards}`, questions: [{ question: PERSON.question, header: 'Delete', multiSelect: false, options: [{ label: 'yes', description: '' }, { label: 'no', description: '' }] }] }
    this.out({ type: 'question_request', sessionId: CHILD, requestId: this.question.requestId, questions: this.question.questions } as LinkedEvent)
  }
  personTurnEnds(): void {
    if (this.turn === 'person') this.end(PERSON.words)
  }
  callerTurnEnds(): void {
    if (this.turn === 'hub') this.end('CALLER-ANSWER')
  }
  /** The child's own background work ended and its tool starts a turn by itself: a task notification, no message of anyone's */
  selfStarts(): void {
    if (this.state === 'idle') this.begin('self')
  }
  selfTurnEnds(): void {
    if (this.turn === 'self') this.end('SELF-ANSWER')
  }
  backgroundWork(live: unknown[]): void {
    this.out({ type: 'background_tasks', sessionId: CHILD, live } as LinkedEvent)
  }

  reader(): LinkedSessions {
    const lastOf = (role: Msg['role']) => [...this.transcript].reverse().find((m) => m.role === role)
    return {
      read: async () => (this.reachable ? { ok: true, state: this.state, lines: [] } : { ok: false, error: 'not reachable' }),
      list: async () => [{ sessionId: CHILD, name: 'Child', project: 'app', state: this.state, tool: 'claude', preview: '', machine: 'Box' }],
      machineLinked: () => true,
      machineWaitsForPerson: () => false,
      machineNamed: (n: string) => (n === 'Box' ? { id: 'm1', name: 'Box' } : null),
      describe: () => ({ name: 'Child', project: 'app' }),
      lastWords: async () => (this.reachable ? ({ ok: true as const, text: lastOf('assistant')?.payload.text ?? '', length: 0, seq: null }) : { ok: false as const, error: 'not reachable' }),
      lastUserMessage: async () => {
        if (!this.reachable) return { ok: false, error: 'not reachable' }
        const m = lastOf('user')
        return { ok: true, message: m ? { text: m.payload.text, from: m.payload.from ?? null } : null }
      },
      cards: async () => (this.reachable ? { ok: true, approval: null, questions: this.question ? [this.question] : [] } : { ok: false, error: 'not reachable' }),
      answerQuestion: async (_s: string, requestId: string) => {
        this.answered.push(requestId)
        return { ok: true }
      },
      send: async (_s: string, text: string) => {
        this.sends++
        if (!this.reachable) return { ok: false, error: 'not reachable' }
        if (this.hold) await this.hold
        this.fromHub.push(text)
        this.take(text, HUB_FROM)
        if (this.state === 'idle') this.begin('hub')
        return { ok: true }
      },
      createSession: async () => ({ ok: true, sessionId: CHILD, name: 'Child' }),
      projects: async () => ({ projects: [{ id: 'm1.p', machineId: 'm1', machine: 'Box', name: 'app', path: '/app' }], away: [] }),
      origin: async () => ({ ok: true, origin: 'git@github.com:me/app.git' }),
      interrupt: async () => ({ ok: true }),
      deleteSession: async () => ({ ok: true }),
      backgroundTasks: async () => [],
    } as unknown as LinkedSessions
  }
}

/** The hub: its store, and what the session manager wires around a child on a linked machine */
class Hub {
  children!: ChildOwnership
  reports!: LinkedReports
  agents!: RemoteAgents
  readonly told: string[] = []
  readonly delivered: string[] = []
  readonly results: ChildRunResult[] = []

  constructor(
    readonly store: Store,
    private readonly machine: () => Machine,
  ) {
    this.boot()
  }

  /** A host's start (and so a restart): everything in memory begins again, from the store */
  boot(): void {
    const reader = this.machine().reader()
    this.children = new ChildOwnership(this.store)
    this.reports = new LinkedReports({
      children: this.children,
      linkedReader: reader,
      hasSession: () => true,
      closing: false,
      deliverReport: async (_to: string, sessionId: string, _name: string, _project: string, preview: string, ending: unknown, work: unknown) =>
        void this.delivered.push(JSON.stringify({ sessionId, preview, ending, work })),
      reportGate: (id: string) => this.agents.reportGate(id),
    } as unknown as LinkedReportsHost)
    this.agents = new RemoteAgents({
      children: this.children,
      store: this.store,
      linkedReader: reader,
      meta: new Map([[caller.id, caller]]),
      settleLinkedTurn: (id: string) => this.reports.observe({ type: 'turn_complete', sessionId: id }),
      linkedTasksRunning: (id: string) => this.reports.ownTasksRunning(id),
      tellSession: async (_to: string, text: string) => void this.told.push(text),
      autoBoundaryOpen: () => false,
      emit: () => {},
      uiPreferences: () => ({}),
      askHost: async () => 'allow',
      projectOrigin: async () => 'https://github.com/me/app',
    } as unknown as RemoteAgentsHost, { agentCeilingError: () => null, reservePlace: () => ({ release: () => {} }) })
    this.agents.restore()
  }

  /** A machine's event, as the manager relays it: to the children on linked machines first, then to the linked reports */
  readonly observe = (e: LinkedEvent): void => {
    this.agents.observe(e)
    this.reports.observe(e)
  }

  async act(action: string, more: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ChildRunResult> {
    const r = await this.agents.agentSession('h1', this.agents.of(CHILD)!, { sessionId: CHILD, action, ...more } as never, signal)
    this.results.push(r)
    return r
  }

  async start(): Promise<ChildRunResult> {
    const r = await this.agents.startAgent('h1', { task: 'TASK-TEXT', machine: 'Box', wait: false })
    this.results.push(r)
    return r
  }

  /** What reached the caller since `mark`, all of it */
  since = 0
  seenFrom = { told: 0, delivered: 0, results: 0 }
  mark(): void {
    this.seenFrom = { told: this.told.length, delivered: this.delivered.length, results: this.results.length }
  }
  seen(): { told: string[]; delivered: string[]; results: ChildRunResult[] } {
    return { told: this.told.slice(this.seenFrom.told), delivered: this.delivered.slice(this.seenFrom.delivered), results: this.results.slice(this.seenFrom.results) }
  }
}

const flush = async (rounds = 25) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve))
}

let store: Store
let machine: Machine
let hub: Hub

beforeEach(() => {
  store = new Store()
  store.projects.addProject({ id: 'p1', path: '/p', name: 'p' })
  store.projects.setProjectTrusted('p1', true)
  machine = new Machine((e) => hub.observe(e))
  hub = new Hub(store, () => machine)
})
afterEach(() => store.close())

const linkDown = () => {
  machine.reachable = false
  hub.observe({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'unreachable' } })
}
const linkUp = async () => {
  machine.reachable = true
  hub.observe({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'connected' } })
  hub.observe({ type: 'machine_resync', machineId: 'm1' })
  await flush()
}
const sent = (): string => (JSON.parse(store.settings.appSetting(REMOTE_AGENTS_KEY) ?? '[]') as { sent?: string }[])[0]?.sent ?? ''

/** A start, with its task's turn running there as the caller's */
async function started(): Promise<void> {
  const r = await hub.start()
  if (!r.ok) throw new Error(r.error)
  await flush()
}

/**
 * The ways the person's turn comes about. Each leaves the child in a turn of the person's, which has asked a question
 * there; `hub.mark()` is set before anything of the person's happens, so what reached the caller since is checked
 */
const SCENARIOS: Record<string, () => Promise<void>> = {
  "the person's turn while the child is idle": async () => {
    await started()
    machine.callerTurnEnds()
    await flush()
    hub.mark()
    machine.personSays()
    machine.personAsks()
  },
  "the person's turn while the caller's report waits on its background work": async () => {
    await started()
    machine.backgroundWork([{ id: 't1', description: 'build', status: 'running' }])
    machine.callerTurnEnds()
    await flush()
    hub.mark()
    machine.personSays()
    machine.personAsks()
  },
  "the person's turn while the link is down": async () => {
    await started()
    hub.mark()
    linkDown()
    machine.personSays()
    machine.personAsks()
  },
  "the person's turn while the link was down, seen when it is back": async () => {
    await started()
    hub.mark()
    linkDown()
    machine.personSays()
    machine.personAsks()
    await linkUp()
  },
  "the person's turn while the hub restarted": async () => {
    await started()
    hub.mark()
    linkDown()
    hub.boot()
    machine.personSays()
    machine.personAsks()
    await linkUp()
  },
  "the person typing the caller's own words": async () => {
    await started()
    machine.callerTurnEnds()
    await flush()
    hub.mark()
    machine.personSays(sent())
    machine.personAsks()
  },
  "the caller's send landing in a turn the person had just begun": async () => {
    await started()
    machine.callerTurnEnds()
    await flush()
    hub.mark()
    let release!: () => void
    machine.hold = new Promise((resolve) => (release = resolve))
    const sending = hub.act('send', { text: 'more work' })
    await eventually(() => machine.sends === 2)
    machine.personSays()
    machine.hold = null
    release()
    await sending
    machine.personAsks()
  },
  "a start racing the person's first message": async () => {
    hub.mark()
    let release!: () => void
    machine.hold = new Promise((resolve) => (release = resolve))
    const starting = hub.start()
    await eventually(() => machine.sends === 1)
    machine.personSays()
    machine.hold = null
    release()
    await starting
    machine.personAsks()
  },
}

/** Every path that hands the caller anything of the child, run while the person's turn is there */
const ENTRIES: Record<string, () => Promise<void>> = {
  'status, in a turn': async () => {
    await hub.act('status')
  },
  'status, at rest': async () => {
    machine.personTurnEnds()
    await flush()
    await hub.act('status')
  },
  'wait, as it opens': async () => {
    const waiting = hub.act('wait')
    await flush()
    machine.personTurnEnds()
    await waiting
  },
  'wait, on a card': async () => {
    const waiting = hub.act('wait')
    await flush()
    machine.personAsks()
    await flush()
    machine.personTurnEnds()
    await waiting
  },
  'wait, at the turn\'s end': async () => {
    const waiting = hub.act('wait')
    await flush()
    machine.personTurnEnds()
    await waiting
  },
  'wait, cut short': async () => {
    const ctl = new AbortController()
    const waiting = hub.act('wait', {}, ctl.signal)
    await flush()
    ctl.abort()
    await waiting
  },
  answer: async () => {
    await hub.act('answer', { text: 'yes' })
    await hub.act('answer', { card: 'r1.anything', text: 'yes' })
  },
  'send, into the turn': async () => {
    await hub.act('send', { text: 'a note' })
  },
  'send, at rest': async () => {
    machine.personTurnEnds()
    await flush()
    await hub.act('send', { text: 'new work' })
  },
  'start, its answer': async () => {
    // The start's own answer is among what reached the caller (the racing scenario starts after the mark)
  },
  'the linked report, its text and preview': async () => {
    machine.personTurnEnds()
    await flush()
  },
  'the notice of a turn that ended unwatched': async () => {
    machine.personTurnEnds()
    if (!machine.reachable) await linkUp()
    await flush()
  },
}

describe("nothing of the person's turn on the child's machine reaches the caller (#1038 review, RV13)", () => {
  const cells = Object.keys(SCENARIOS).flatMap((scenario) => Object.keys(ENTRIES).map((entry) => [scenario, entry] as const))

  it('covers every path in every way the person can take the session', () => {
    expect(cells).toHaveLength(Object.keys(SCENARIOS).length * Object.keys(ENTRIES).length)
  })

  it.each(cells)('%s: %s', async (scenario, entry) => {
    await SCENARIOS[scenario]!()
    await flush()
    const hubSends = machine.fromHub.length
    await ENTRIES[entry]!()
    // Whatever was left: the person's turn ends, and a link that was down comes back
    machine.personTurnEnds()
    if (!machine.reachable) await linkUp()
    await flush()
    const seen = hub.seen()
    const all = JSON.stringify(seen)
    expect(all).not.toContain(PERSON.question)
    expect(all).not.toContain(PERSON.words)
    expect(all).not.toContain(PERSON.message)
    // No card of it was answered, and no report of it went
    expect(machine.answered).toEqual([])
    expect(seen.delivered).toEqual([])
    // Nothing is owed of a turn that is not the caller's (a send after the person's turn ended starts the caller's own)
    if (machine.turn !== 'hub') expect(hub.children.linkedReports.has(CHILD)).toBe(false)
    // The caller's text went into the person's turn only where the scenario races it in, never by a path asked here
    if (entry !== 'send, at rest') expect(machine.fromHub.length).toBe(hubSends)
  })
})

/*
 * #1161 review: the start called `reader.agentInstructions`, which a reader from before it (this file's stand-in, a
 * build that predates #1161) does not have, and every start here failed with "is not a function". A reader without the
 * new calls, or whose call fails or never answers, starts and deletes as it did before.
 */
describe('a reader from before #1161, or one whose new calls fail', () => {
  /** The stand-in reader with `more` on top, wired in as a host's start would */
  const withReader = (more: Partial<LinkedSessions>, listed?: string) => {
    const plain = Machine.prototype.reader.bind(machine)
    machine.reader = () => {
      const r = plain()
      const projects = listed === undefined ? r.projects : async () => ({ projects: [{ id: 'm1.p', machineId: 'm1', machine: 'Box', name: 'app', path: '/app', defaultTool: null, agentInstructions: listed }], away: [] })
      return { ...r, projects, ...more } as LinkedSessions
    }
    hub.boot()
  }

  it('starts the child with what the machine listed when the reader has no agentInstructions, and with none when it listed none', async () => {
    withReader({}, 'LISTED-TEXT')
    expect(await hub.start()).toMatchObject({ ok: true })
    expect(machine.fromHub[0]).toContain('TASK-TEXT')
    expect(machine.fromHub[0]).toContain('LISTED-TEXT')
    // The stand-in as it is lists no instructions, as a machine that predates them
    await hub.act('delete')
    withReader({})
    expect(await hub.start()).toMatchObject({ ok: true })
    expect(machine.fromHub[1]).toContain('TASK-TEXT')
    expect(machine.fromHub[1]).not.toContain('standing instructions')
  })

  it('starts the child with what the machine listed when the read throws', async () => {
    withReader({ agentInstructions: async () => { throw new Error('the link broke') } }, 'LISTED-TEXT')
    expect(await hub.start()).toMatchObject({ ok: true })
    expect(machine.fromHub[0]).toContain('LISTED-TEXT')
  })

  it('starts the child with what the machine listed when the read never answers', async () => {
    withReader({ agentInstructions: () => new Promise(() => {}) }, 'LISTED-TEXT')
    expect(await hub.start()).toMatchObject({ ok: true })
    expect(machine.fromHub[0]).toContain('LISTED-TEXT')
  }, 20_000 * SLOW)

  it('deletes a worktree child as before when the reader has no deleteAgentChild, and answers when the call throws', async () => {
    const start = () => hub.agents.startAgent('h1', { task: 'TASK-TEXT', machine: 'Box', branch: 'feat-x', wait: false })
    expect(await start()).toMatchObject({ ok: true })
    expect(await hub.act('delete')).toMatchObject({ ok: true, state: 'deleted', notice: expect.stringContaining('its worktree there, on feat-x, stays') })
    withReader({ deleteAgentChild: async () => { throw new Error('the link broke') } })
    expect(await start()).toMatchObject({ ok: true })
    expect(await hub.act('delete')).toMatchObject({ ok: false, error: expect.stringContaining('the link broke') })
  })
})

/*
 * #1576: the turn the child's own tool starts when its background work ends (a task notification, no message of
 * anyone's) continues the work the caller gave it, and its end is reported to the caller (the paused report). A note
 * into it is the caller's to add, as into the turn the caller gave; only a turn a person's message (or another session)
 * started there is not.
 */
describe('a turn the child starts by itself after a paused report (#1576)', () => {
  const build = { id: 't1', description: 'build', status: 'running' }
  const done = { ...build, status: 'completed' }
  const note = { text: 'the owner decided: use staging', ifBusy: 'note' }

  /** The caller's task, whose turn ends while the child's background work runs: the caller is told it is paused */
  async function paused(): Promise<void> {
    await started()
    machine.backgroundWork([build])
    machine.callerTurnEnds()
    await flush()
    expect(hub.children.linkedReports.get(CHILD)?.paused).toBeTruthy()
  }
  /** The work ends and the tool starts the turn that carries on */
  async function followUp(): Promise<void> {
    machine.backgroundWork([])
    machine.selfStarts()
    await flush()
  }
  const notes = () => machine.fromHub.filter((t) => t.includes('use staging'))

  it('takes a note into it, and its end is still reported once', async () => {
    await paused()
    await followUp()
    expect(await hub.act('send', note)).toMatchObject({ ok: true, state: 'working' })
    expect(notes()).toHaveLength(1)
    expect(hub.children.linkedReports.get(CHILD)?.orchestratorId).toBe('h1')
    expect(await hub.act('status')).toMatchObject({ ok: true, state: 'working' })
    // The pause notice went at the first turn's end; this turn's end is the final report, once
    expect(hub.delivered).toHaveLength(1)
    machine.selfTurnEnds()
    await flush()
    expect(hub.delivered).toHaveLength(2)
    expect(hub.children.linkedReports.has(CHILD)).toBe(false)
  })

  it('answers wait with the end of the turn as for the turn the caller gave', async () => {
    await paused()
    await followUp()
    const waiting = hub.act('wait')
    await flush()
    machine.selfTurnEnds()
    expect(await waiting).toMatchObject({ ok: true, state: 'done', answer: expect.stringContaining('SELF-ANSWER') })
  })

  it('refuses once the person types into it there, and names the person', async () => {
    await paused()
    await followUp()
    machine.personSays()
    await flush()
    const r = await hub.act('send', note)
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('the person may be using it there') })
    expect(notes()).toHaveLength(0)
    expect(hub.children.linkedReports.has(CHILD)).toBe(false)
  })

  it('refuses a turn the person started at rest after the pause, even when their words match nothing of the work', async () => {
    await paused()
    machine.backgroundWork([])
    machine.personSays()
    await flush()
    expect(await hub.act('send', note)).toMatchObject({ ok: false, error: expect.stringContaining('the person may be using it there') })
    expect(notes()).toHaveLength(0)
  })

  it('does not blame the person when another session owes the report: it names that', async () => {
    await paused()
    hub.children.setLinkedReport(CHILD, { orchestratorId: 'h2', busy: false, paused: [build] as never })
    await followUp()
    const r = await hub.act('send', note)
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('another session') })
    expect(JSON.stringify(r)).not.toContain('the person may be using it')
    expect(notes()).toHaveLength(0)
  })

  it('takes a note after a hub swap between the pause and the turn', async () => {
    await paused()
    hub.boot()
    await followUp()
    expect(await hub.act('send', note)).toMatchObject({ ok: true })
    expect(notes()).toHaveLength(1)
  })

  it('refuses, without blaming the person, a turn the swapped hub did not see begin', async () => {
    await paused()
    machine.backgroundWork([])
    machine.selfStarts()
    hub.boot()
    await flush()
    const r = await hub.act('send', note)
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('started by itself') })
    expect(JSON.stringify(r)).not.toContain('the person may be using it')
    expect(notes()).toHaveLength(0)
  })

  it('pauses again when the turn ends with new work running: a note goes in, and a later send is new work', async () => {
    await paused()
    await followUp()
    machine.backgroundWork([{ ...build, id: 't2' }])
    expect(await hub.act('send', note)).toMatchObject({ ok: true })
    machine.selfTurnEnds()
    await flush()
    expect(hub.children.linkedReports.get(CHILD)?.paused).toBeTruthy()
    expect(hub.delivered).toHaveLength(1)
    // At rest now: a send is new work, not a note
    expect(await hub.act('send', { text: 'more' })).toMatchObject({ ok: true })
    expect(machine.turn).toBe('hub')
  })

  it('keeps the old refusal on a machine that lists no background work (it never pauses), naming no person', async () => {
    await started()
    machine.callerTurnEnds()
    await flush()
    // Nothing paused, nothing owed: a turn the child starts by itself is not the caller's work
    machine.selfStarts()
    await flush()
    const r = await hub.act('send', note)
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('try again once it is at rest') })
    expect(notes()).toHaveLength(0)
    void done
  })
})
