import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionLiveDefaults, type BackgroundTask, type NormalizedEvent, type SessionInfo } from '@cc/protocol'
import type { RoutedCard, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import type { AgentRunWait } from './app-agents.js'
import { ChildOwnership, pausedReportKey, type Delegation } from './child-ownership.js'
import { DelegationFlow, type DelegationHost } from './delegation-flow.js'

/*
 * The delegation flow over a host it reaches only through `DelegationHost` (#428). The host here is a proxy that fails
 * on any member a test did not give it, so each test also says what of the manager its path reads. The tools' own
 * behaviour is covered over the real manager (ask-project, start-agent, agent-start-requests, handoff-children, ...).
 */

let store: Store
let meta: Map<string, SessionInfo>
let children: ChildOwnership

const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, name: id, kind: 'worker', projectId: 'p1', tool: 'claude', state: 'idle', permissionPreset: 'normal', pendingApproval: null, pendingQuestions: [], ...extra }) as SessionInfo

/** The answers a handoff leaves, private to the flow */
type HandedOver = {
  handedOverAnswer(callerId: string, id: string): { ok: false; error: string } | undefined
  handedOverReply(callerId: string, id: string): { ok: false; error: string }
}
const handed = (flow: DelegationFlow) => flow as unknown as HandedOver

/** A host with only `given`; reading anything else throws, naming it */
function hostWith(given: Partial<DelegationHost>): DelegationHost {
  return new Proxy(given as DelegationHost, {
    get(target, key) {
      if (key in target) return target[key as keyof DelegationHost]
      throw new Error(`the flow read host.${String(key)}, which this test did not give it`)
    },
  })
}

beforeEach(() => {
  store = new Store()
  meta = new Map([['caller', session('caller')], ['heir', session('heir', { name: 'Heir' })], ['child', session('child', { name: 'Child' })]])
  children = new ChildOwnership(store)
})
afterEach(() => store.close())

describe('the gates read before anything is started', () => {
  it('agent_session never acts on its own calling session', async () => {
    const flow = new DelegationFlow(hostWith({}))
    expect(await flow.agentSession('caller', { sessionId: 'caller', action: 'stop' })).toEqual({
      ok: false,
      error: 'agent_session cannot wait on, stop, delete or send to its own calling session.',
    })
  })

  it('a handle that looks like a start request but is not one here says so', async () => {
    const flow = new DelegationFlow(hostWith({ meta, children }))
    const r = await flow.agentSession('caller', { sessionId: 'ag-gone', action: 'status' })
    expect(r).toMatchObject({ ok: false })
    expect(r.ok === false && r.error).toMatch(/^No start_agent request ag-gone of this session is open here/)
  })
})

describe('what a handoff gave away', () => {
  it('the original that stayed hears where the work went, and the heir is not refused', async () => {
    children.recordHandedOver('child', 'caller', 'heir')
    const flow = new DelegationFlow(hostWith({ meta, children }))
    const r = await flow.agentSession('caller', { sessionId: 'child', action: 'status' })
    expect(r).toEqual({
      ok: false,
      error:
        'A handoff gave "Child" [child] to the session that took over from this one, "Heir" [heir]. ' +
        'It answers to that session now: this session no longer follows it, and nothing was stopped.',
    })
    expect(handed(flow).handedOverAnswer('heir', 'child')).toBeUndefined()
  })

  it('a wait the move ended always has an answer, even once the record is gone', () => {
    const flow = new DelegationFlow(hostWith({ meta, children }))
    expect(handed(flow).handedOverReply('caller', 'child')).toEqual({
      ok: false,
      error: '[child] was handed to another session, which follows it now: this session no longer does, and nothing was stopped.',
    })
  })
})

describe('the place a start holds', () => {
  it("a project's running children and its reserved starts count against the ceiling together", () => {
    const flow = new DelegationFlow(hostWith({ meta, children, uiPreferences: () => ({ agentCeiling: 2 }) as never }))
    const ceiling = flow.starts.agentCeilingError.bind(flow.starts)
    const reserve = flow.starts.reservePlace.bind(flow.starts)
    expect(ceiling('caller', 'p1')).toBeNull()
    children.setDelegation('caller>child', { callerId: 'caller', sessionId: 'child', agent: true, settled: false } as unknown as Delegation)
    const place = reserve('caller', 'p1')
    if (!('release' in place)) throw new Error('no place')
    const full =
      '2 agents started by this project\'s sessions are already working, the most at once. Wait for one (agent_session, action "wait") or stop one, then try again.'
    expect(ceiling('caller', 'p1')).toBe(full)
    expect(reserve('caller', 'p1')).toEqual({ error: full })
    place.release()
    place.release()
    expect(ceiling('caller', 'p1')).toBeNull()
  })

  it('releasing a place twice gives back one place, not two', () => {
    const flow = new DelegationFlow(hostWith({ meta, children, uiPreferences: () => ({ agentCeiling: 3 }) as never }))
    const reserve = flow.starts.reservePlace.bind(flow.starts)
    children.setDelegation('caller>child', { callerId: 'caller', sessionId: 'child', agent: true, settled: false } as unknown as Delegation)
    const a = reserve('caller', 'p1')
    expect(reserve('caller', 'p1')).toHaveProperty('release')
    if (!('release' in a)) throw new Error('no place')
    a.release()
    a.release()
    expect(reserve('caller', 'p1')).toHaveProperty('release')
    expect(reserve('caller', 'p1')).toHaveProperty('error')
  })
})

/*
 * The waits on a delegation's turn, and agent_session's send and stop, over the real ownership: what a regression there
 * loses is the child's answer or its report, or it leaves a wait, a turn link or a delegation behind that misroutes the
 * next one. The child's turn is driven as the manager drives it, through the wait in `agentRuns`.
 */
describe("a child's turn and the call waiting on it", () => {
  let handingOver = false
  let running: BackgroundTask[] = []
  let cards: RoutedCard[] = []
  let raiseCard: () => void = () => {}
  let interrupted: string[] = []
  let reported: { sessionId: string; type: string }[] = []
  let agentRuns: Map<string, AgentRunWait>
  let readGrants: Map<string, Set<string>>
  let root: string

  beforeEach(() => {
    handingOver = false
    running = []
    cards = []
    interrupted = []
    reported = []
    agentRuns = new Map()
    readGrants = new Map()
    root = tempRoot('cc-delegation-')
    store.projects.addProject({ id: 'p1', path: root, name: 'P1', trusted: true })
    meta.set('child', session('child', { name: 'Child', askedBy: 'caller' }))
    // The child's row, which its conversation is stored under
    store.upsertSession({
      ...sessionLiveDefaults(),
      id: 'child', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: 'Child', autoNamed: false, state: 'idle',
      lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null,
      permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
    } as SessionInfo)
  })
  afterEach(() => removeTree(root))

  /** The manager's part these paths read, and `extra` on top; anything else throws, naming it */
  function flowWith(extra: Partial<DelegationHost> = {}): DelegationFlow {
    const given: Partial<DelegationHost> = {
      meta,
      children,
      store,
      agentRuns,
      readGrants,
      handles: new Map([['child', { interrupt: () => void interrupted.push('child') } as unknown as SessionHandle]]),
      get handingOver() {
        return handingOver
      },
      autoBoundaryOpen: () => false,
      routedCards: () => cards,
      untilCard: () => ({ asked: new Promise<'asked'>((resolve) => (raiseCard = () => resolve('asked'))), done: () => {} }),
      ownTasksRunning: () => running,
      pauseReport: (id, tasks) => children.pauseReport(id, tasks),
      reportBackIfAwaited: async (sessionId, ending) => void reported.push({ sessionId, type: ending.type }),
    }
    Object.defineProperties(given, Object.getOwnPropertyDescriptors(extra))
    return new DelegationFlow(hostWith(given))
  }
  const target = () => ({ id: 'p1', name: 'P1', path: root })
  const event = (e: Record<string, unknown>) => agentRuns.get('child')!.onEvent({ sessionId: 'child', ...e } as NormalizedEvent)
  /** The child's turn writes its answer and ends */
  const finishes = (text: string) => {
    store.appendMessages([{ sessionId: 'child', seq: 1, role: 'assistant', kind: 'text', payload: { text }, ts: 1 }])
    event({ type: 'turn_complete' })
  }
  /** What an outcome's handlers start runs on resolved promises only */
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

  it('a child that finished before the call waits is read once: its answer, the paths it names, and no report owed', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.ts'), 'export {}\n')
    const inside = join(root, 'src', 'a.ts')
    const away = join(tmpdir(), 'cc-delegation-nowhere.ts')
    const flow = flowWith()
    const d = flow.startDelegation('caller>child', 'caller', 'child', target(), true)
    expect(children.turnOwners.get('child')?.callerId).toBe('caller')
    // Armed as a call past its bound arms it: the call that reads the answer takes it, so it does not arrive twice
    children.markReport('child', 'caller')
    finishes(`Done. See ${inside} and ${away}.`)
    const r = await flow.awaitAgent('caller>child', d)
    expect(r).toMatchObject({ ok: true, state: 'done', sessionId: 'child', answer: expect.stringContaining('Done.'), readable: [inside], outside: [away], cleanUp: true })
    expect(readGrants.get('caller')).toEqual(new Set([inside]))
    await flush()
    expect(store.listReportMarks()).toEqual([])
    expect(children.delegations.size).toBe(0)
    expect(children.turnOwners.has('child')).toBe(false)
    expect(agentRuns.size).toBe(0)
    // A child's turn that completed was reported as it ended, by the manager: not again from here
    expect(reported).toEqual([])
  })

  it('a turn that fails mid-way answers that it did not finish, and its failure goes to whoever is owed the report', async () => {
    const flow = flowWith()
    const d = flow.startDelegation('caller>child', 'caller', 'child', target(), true)
    const waiting = flow.awaitAgent('caller>child', d)
    event({ type: 'message_delta' })
    event({ type: 'error', error: { code: 'internal', message: 'the CLI crashed', retryable: false } })
    expect(await waiting).toEqual({
      ok: false,
      error: '"Child" [child] did not finish: the agent\'s turn failed: the CLI crashed. Tell the person, or give it a clearer task.',
    })
    await flush()
    expect(reported).toEqual([{ sessionId: 'child', type: 'error' }])
    expect(children.delegations.size).toBe(0)
    expect(children.turnOwners.has('child')).toBe(false)
  })

  it('a cancelled call stops the turn it gave and lets the delegation go', async () => {
    const flow = flowWith()
    const d = flow.startDelegation('caller>child', 'caller', 'child', target(), true)
    const call = new AbortController()
    const waiting = flow.awaitAgent('caller>child', d, call.signal)
    call.abort()
    expect(await waiting).toEqual({ ok: false, error: 'The call was cancelled, so "Child" was stopped.' })
    expect(interrupted).toEqual(['child'])
    expect(d.settled).toBe(true)
    expect(d.waiters).toBe(0)
    expect(children.delegations.size).toBe(0)
  })

  it('a cancelled call on a turn it only joined leaves that turn running, and never owned it', async () => {
    const flow = flowWith()
    const d = flow.startDelegation('caller>child', 'caller', 'child', target(), false, true)
    expect(children.turnOwners.has('child')).toBe(false)
    const call = new AbortController()
    const waiting = flow.awaitTurn('caller>child', d, { signal: call.signal, stopWhy: 'the call was cancelled' })
    call.abort()
    expect(await waiting).toEqual({ kind: 'cancelled' })
    expect(interrupted).toEqual([])
    expect(d.settled).toBe(false)
    // The turn it joined still ends for whoever else reads it
    finishes("the person's turn ends")
    expect(await d.outcome).toEqual({ ok: true, answer: "the person's turn ends" })
  })

  it('past the bound the call answers "working", and the report it promises is stored', async () => {
    const flow = flowWith()
    const d = flow.startDelegation('caller>child', 'caller', 'child', target(), true)
    expect(await flow.awaitAgent('caller>child', d, undefined, false, 1)).toMatchObject({ ok: true, state: 'working', reported: true })
    expect(store.listReportMarks()).toEqual([{ sessionId: 'child', callerSessionId: 'caller' }])
    expect(children.delegations.get('caller>child')).toBe(d)
  })

  it('a card raised during the wait answers "asking", with the report armed for the turn going on without the call', async () => {
    const flow = flowWith()
    const d = flow.startDelegation('caller>child', 'caller', 'child', target(), true)
    const waiting = flow.awaitAgent('caller>child', d)
    const card = { card: 'c-1', requestId: 'r-1', kind: 'approval', detail: { kind: 'command', command: 'rm -rf build' }, answerable: true } as unknown as RoutedCard
    cards = [card]
    raiseCard()
    expect(await waiting).toMatchObject({ ok: true, state: 'asking', sessionId: 'child', cards: [card] })
    expect(store.listReportMarks()).toEqual([{ sessionId: 'child', callerSessionId: 'caller' }])
    expect(d.settled).toBe(false)
  })

  it('a handoff during the wait ends it with where the work went, and the heir reads the answer and frees the turn (#693)', async () => {
    const flow = flowWith()
    const d = flow.startDelegation('caller>child', 'caller', 'child', target(), true)
    const original = flow.awaitAgent('caller>child', d)
    children.moveOwner('caller', 'heir', { sessions: ['child'], armReports: [], starts: [], queued: false }, () => {})
    expect(await original).toEqual({
      ok: false,
      error:
        'A handoff gave "Child" [child] to the session that took over from this one, "Heir" [heir]. ' +
        'It answers to that session now: this session no longer follows it, and nothing was stopped.',
    })
    const moved = children.delegations.get('heir>child')
    expect(moved).toBe(d)
    const heir = flow.awaitAgent('heir>child', moved!)
    finishes('all done')
    expect(await heir).toMatchObject({ ok: true, state: 'done', answer: 'all done' })
    await flush()
    // Released by the owner it has when it ends, not the one that gave it
    expect(children.turnOwners.has('child')).toBe(false)
    expect(children.delegations.size).toBe(0)
  })

  it("a turn that ends with the child's own work still running holds the report for that work's end (#721)", async () => {
    const flow = flowWith()
    const d = flow.startDelegation('caller>child', 'caller', 'child', target(), true)
    const waiting = flow.awaitAgent('caller>child', d)
    running = [{ id: 'bg-verify', kind: 'shell', description: 'pnpm verify', status: 'running' }]
    finishes('verify is running in the background')
    const r = await waiting
    expect(r).toMatchObject({ ok: true, state: 'done', answer: 'verify is running in the background', notice: expect.stringContaining('pnpm verify') })
    // No clean-up line: the work is not over
    expect(r).not.toHaveProperty('cleanUp')
    expect(store.listReportMarks()).toEqual([{ sessionId: 'child', callerSessionId: 'caller' }])
    expect(JSON.parse(store.appSetting(pausedReportKey('child'))!)).toEqual([{ id: 'bg-verify', description: 'pnpm verify' }])
  })

  it("new work from the same caller ends its pause; another caller's pause stands", () => {
    const flow = flowWith()
    children.markReport('child', 'caller')
    children.pauseReport('child', [{ id: 'bg-verify', description: 'pnpm verify' }])
    flow.startDelegation('caller>child', 'caller', 'child', target(), true)
    expect(children.pausedReports.has('child')).toBe(false)
    expect(store.listReportMarks()).toEqual([])

    meta.set('other', session('other', { name: 'Other', askedBy: 'someone' }))
    children.markReport('other', 'someone')
    children.pauseReport('other', [{ id: 'bg-dev', description: 'dev server' }])
    flow.startDelegation('caller>other', 'caller', 'other', target(), true)
    expect(children.pausedReports.get('other')).toEqual([{ id: 'bg-dev', description: 'dev server' }])
    expect(children.awaitingReport.get('other')).toBe('someone')
  })

  it("a host handing over keeps the turn's link for the next host; one that is not lets it go", async () => {
    const flow = flowWith()
    meta.set('kept', session('kept', { askedBy: 'caller' }))
    const leaving = flow.startDelegation('caller>kept', 'caller', 'kept', target(), false)
    handingOver = true
    leaving.wait.fail(new Error('the host is handing over'))
    await leaving.outcome
    await flush()
    expect(children.turnOwners.get('kept')?.callerId).toBe('caller')

    handingOver = false
    const ended = flow.startDelegation('caller>child', 'caller', 'child', target(), false)
    ended.wait.fail(new Error('stopped'))
    await ended.outcome
    await flush()
    expect(children.turnOwners.has('child')).toBe(false)
  })

  it('a send that fails leaves no wait, turn or delegation behind, and fails a wait that joined it (#839)', async () => {
    let joined: AgentRunWait | undefined
    const flow = flowWith({
      busyForCaller: () => false,
      uiPreferences: () => ({}) as never,
      deliver: async () => {
        // A wait of the caller's joins the new turn while the child wakes
        joined = agentRuns.get('child')
        throw new Error('the CLI is gone')
      },
    })
    expect(await flow.agentSession('caller', { sessionId: 'child', action: 'send', text: 'and the tests' })).toEqual({ ok: false, error: 'Could not send it: the CLI is gone' })
    expect(joined?.finished).toBe(true)
    expect(agentRuns.size).toBe(0)
    expect(children.delegations.size).toBe(0)
    expect(children.turnOwners.has('child')).toBe(false)
  })

  it('stop on the turn it gave interrupts it, takes the report down and lets the delegation go', async () => {
    const flow = flowWith()
    flow.startDelegation('caller>child', 'caller', 'child', target(), true)
    children.markReport('child', 'caller')
    expect(await flow.agentSession('caller', { sessionId: 'child', action: 'stop' })).toEqual({ ok: true, state: 'stopped', sessionId: 'child', sessionName: 'Child', tool: 'claude' })
    expect(interrupted).toEqual(['child'])
    expect(store.listReportMarks()).toEqual([])
    expect(children.delegations.size).toBe(0)
  })

  it('stop with nothing of the caller running says so and stops nothing', async () => {
    const flow = flowWith()
    expect(await flow.agentSession('caller', { sessionId: 'child', action: 'stop' })).toEqual({ ok: false, error: 'Nothing you gave "Child" is running.' })
    expect(interrupted).toEqual([])
  })

  it("a session another session started, or another project's, is not the caller's to work with", async () => {
    const flow = flowWith()
    meta.set('theirs', session('theirs', { askedBy: 'someone' }))
    meta.set('far', session('far', { askedBy: 'caller', projectId: 'p2' }))
    for (const id of ['theirs', 'far']) {
      expect(await flow.agentSession('caller', { sessionId: id, action: 'stop' })).toEqual({
        ok: false,
        error: `${id} is not a session this session started. agent_session works only on sessions start_agent started here.`,
      })
    }
  })
})
