import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTINUE_WORDS, type NormalizedEvent, type SessionInfo, type ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { LIMIT_NOTE, NETWORK_NOTE } from '../adapters/input-receipts.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { tempRoot } from '../temp-dir.test-helpers.js'
import { SessionManager } from './manager.js'
import { Adapter } from './turn-continue.test-helpers.js'
import { MAX_FAILED_PROBES, MAX_TRIES, PROBE_STEPS_MS, RESET_MARGIN_MS, STAGGER_MS, TICK_MS } from './turn-continue.js'

/**
 * A turn the network or a usage limit stopped is continued by the host once the cause clears (#1415, #2238): the stop stays a stop
 * (its interruption says why), the wait is on it (`autoContinue`), and the continue goes in through Centralu's channel.
 */

/** The sentence of #2238's case: the turn's first request found no DNS */
const NO_DNS = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"
const API = 'https://api.example.test'

const dir = tempRoot('auto-continue-')
let store: Store
let events: NormalizedEvent[]
/** Whether the tool's API answers; every probe is counted */
let online: boolean
let probes: number

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  store = new Store()
  events = []
  online = false
  probes = 0
  vi.stubGlobal('fetch', async (url: string) => {
    probes++
    expect(url).toBe(API)
    if (!online) throw new TypeError('fetch failed')
    return new Response(null, { status: 404 })
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function host() {
  const adapter = new Adapter()
  adapter.apiUrl = () => API
  const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, dir)
  const session = (id: string): SessionInfo => mgr.listSessions().find((s) => s.id === id)!
  return { mgr, adapter, session, rpc: createRpcHandler(mgr, adapters) }
}

async function started(a: ReturnType<typeof host>) {
  const p = (await a.rpc('projects.add', { path: dir })) as { id: string }
  const s = (await a.rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: 'claude', permissionPreset: 'normal' })) as { id: string }
  const handle = a.adapter.last
  handle.emit({ type: 'state_change', sessionId: s.id, state: 'working' })
  return { id: s.id, handle }
}

/** A session whose turn the network ended */
async function cutByNetwork(a = host()) {
  const { id, handle } = await started(a)
  handle.emit({ type: 'error', sessionId: id, error: { code: 'internal', message: NO_DNS, retryable: true } })
  return { a, id, handle }
}

const lines = (id: string, label: string) => events.filter((e) => e.type === 'notice' && e.sessionId === id && e.label === label) as Extract<NormalizedEvent, { type: 'notice' }>[]

describe('a turn the network stopped (#2238)', () => {
  it('waits while the API does not answer, and is continued with Centralu’s note once it does', async () => {
    const { a, id, handle } = await cutByNetwork()
    expect(a.session(id).state).toBe('error')
    expect(a.session(id).interruption).toMatchObject({ reason: 'network', autoContinue: { tries: 0 } })
    expect(a.session(id).interruption?.autoContinue?.at).toBeUndefined()
    // Down: probed at the steps, nothing sent
    await vi.advanceTimersByTimeAsync(PROBE_STEPS_MS[0] + PROBE_STEPS_MS[1] + TICK_MS)
    expect(probes).toBe(2)
    expect(handle.sent).toEqual([])
    online = true
    await vi.advanceTimersByTimeAsync(PROBE_STEPS_MS[2] + TICK_MS)
    expect(handle.sent).toEqual([NETWORK_NOTE])
    // Not the person's message: the conversation says Centralu continued it, and the turn runs
    expect(lines(id, 'continue').at(-1)?.text).toBe('The network is back, so Centralu continued this turn.')
    expect(a.session(id).state).toBe('working')
    expect(a.session(id).interruption ?? null).toBeNull()
  })

  it('goes on at once after the computer slept: a tick that came late probes now', async () => {
    const { a, id, handle } = await cutByNetwork()
    online = true
    // The clock jumps an hour between two ticks, as it does across a sleep, before the first probe step is due
    vi.setSystemTime(Date.now() + 60 * 60_000)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(handle.sent).toEqual([NETWORK_NOTE])
    expect(a.session(id).state).toBe('working')
  })

  it('a finished turn of another session of the tool says the API answers: the wait ends without a probe', async () => {
    const a = host()
    const { id, handle } = await cutByNetwork(a)
    const other = await started(a)
    other.handle.emit({ type: 'turn_complete', sessionId: other.id })
    expect(probes).toBe(0)
    expect(handle.sent).toEqual([NETWORK_NOTE])
    expect(a.session(id).state).toBe('working')
  })

  it(`is left for the person after ${MAX_TRIES.network} continues that the network ended again, each try waiting longer than the one before`, async () => {
    const { a, id, handle } = await cutByNetwork()
    // The probe answers, but the turn fails again (#1415 review: a gateway that answers HEAD and drops the API's requests spent the tries in 75 s)
    online = true
    for (let i = 1; i <= MAX_TRIES.network; i++) {
      const step = PROBE_STEPS_MS[Math.min(i - 1, PROBE_STEPS_MS.length - 1)] ?? PROBE_STEPS_MS[0]
      await vi.advanceTimersByTimeAsync(step - TICK_MS)
      expect(handle.sent).toHaveLength(i - 1)
      await vi.advanceTimersByTimeAsync(2 * TICK_MS)
      expect(handle.sent).toHaveLength(i)
      handle.emit({ type: 'error', sessionId: id, error: { code: 'internal', message: NO_DNS, retryable: true } })
    }
    expect(a.session(id).interruption).toMatchObject({ reason: 'network' })
    expect(a.session(id).interruption?.autoContinue).toBeUndefined()
    expect(lines(id, 'continue').at(-1)?.text).toMatch(/continued this turn 5 times and the network failed again/)
    await vi.advanceTimersByTimeAsync(PROBE_STEPS_MS[4] * 2)
    expect(handle.sent).toHaveLength(MAX_TRIES.network)
  })

  it(`a probe that never answers leaves the stop for the person after ${MAX_FAILED_PROBES} tries, saying so`, async () => {
    const { a, id, handle } = await cutByNetwork()
    const last = PROBE_STEPS_MS[4]
    await vi.advanceTimersByTimeAsync(PROBE_STEPS_MS.reduce((x, y) => x + y, 0) + (MAX_FAILED_PROBES - PROBE_STEPS_MS.length) * last - last)
    expect(a.session(id).interruption?.autoContinue).toBeDefined()
    await vi.advanceTimersByTimeAsync(last + TICK_MS)
    expect(probes).toBe(MAX_FAILED_PROBES)
    expect(a.session(id).interruption?.autoContinue).toBeUndefined()
    expect(lines(id, 'continue').at(-1)?.text).toBe("Centralu could not reach this tool's API for hours, so it does not continue this turn by itself. Send a message to go on.")
    online = true
    await vi.advanceTimersByTimeAsync(10 * last)
    expect(handle.sent).toEqual([])
  })

  it('a finished turn starts the count over', async () => {
    const { a, id, handle } = await cutByNetwork()
    online = true
    await vi.advanceTimersByTimeAsync(PROBE_STEPS_MS[0] + TICK_MS)
    handle.emit({ type: 'error', sessionId: id, error: { code: 'internal', message: NO_DNS, retryable: true } })
    expect(a.session(id).interruption?.autoContinue?.tries).toBe(1)
    // The second try waits the next step
    await vi.advanceTimersByTimeAsync(PROBE_STEPS_MS[1] + TICK_MS)
    expect(handle.sent).toHaveLength(2)
    handle.emit({ type: 'turn_complete', sessionId: id })
    handle.emit({ type: 'state_change', sessionId: id, state: 'working' })
    handle.emit({ type: 'error', sessionId: id, error: { code: 'internal', message: NO_DNS, retryable: true } })
    expect(a.session(id).interruption?.autoContinue?.tries).toBe(0)
  })

  it.each([
    ['Don’t continue', async (a: ReturnType<typeof host>, id: string) => expect(await a.rpc('sessions.stopContinue', { sessionId: id })).toEqual({ ok: true, stopped: true })],
    ['a message of the person’s, which carries the work on', async (a: ReturnType<typeof host>, id: string) => void (await a.mgr.inputs.send(id, 'go on'))],
    ['a Stop', async (a: ReturnType<typeof host>, id: string) => void (await a.rpc('agents.interrupt', { sessionId: id }))],
    ['the session going to the trash', async (a: ReturnType<typeof host>, id: string) => void (await a.rpc('agents.deleteSession', { sessionId: id }))],
  ])('is cancelled by %s: nothing of Centralu’s is sent', async (_, act) => {
    const { a, id } = await cutByNetwork()
    const handle = a.adapter.last
    await act(a, id)
    online = true
    await vi.advanceTimersByTimeAsync(PROBE_STEPS_MS[4] * 2)
    expect(handle.sent.filter((t) => t === NETWORK_NOTE)).toEqual([])
    const s = a.mgr.listSessions().find((x) => x.id === id)
    expect(s?.interruption?.autoContinue).toBeUndefined()
  })

  it('is not armed with the setting off, and the stop keeps its Continue', async () => {
    const a = host()
    a.mgr.prefs.setUiPreferences({ continueOnNetwork: false })
    const { id, handle } = await cutByNetwork(a)
    expect(a.session(id).interruption).toEqual({ reason: 'network', at: expect.any(Number), detail: NO_DNS })
    online = true
    await vi.advanceTimersByTimeAsync(PROBE_STEPS_MS[4] * 2)
    expect(handle.sent).toEqual([])
  })

  it('outlives the host: the next host on the same store takes the stored wait up again', async () => {
    const { a, id } = await cutByNetwork()
    await a.mgr.tenure.disposeAll()
    const b = host()
    expect(b.session(id).interruption?.autoContinue).toEqual({ tries: 0 })
    online = true
    await vi.advanceTimersByTimeAsync(PROBE_STEPS_MS[0] + TICK_MS + STAGGER_MS)
    // The session had no process: the note woke it, as an update's continue does
    expect(b.adapter.created).toHaveLength(1)
    expect(b.adapter.last.sent).toEqual([NETWORK_NOTE])
  })
})

describe('a turn a usage limit stopped (#1415)', () => {
  /** Claude's order: the rejected `rate_limit_event`, then the result's error at rest */
  async function limited(resetInMs: number | null, extra: Partial<Extract<NormalizedEvent, { type: 'limit_reached' }>> = {}) {
    const a = host()
    const { id, handle } = await started(a)
    const resumeAt = resetInMs === null ? undefined : new Date(Date.now() + resetInMs).toISOString()
    handle.emit({ type: 'limit_reached', sessionId: id, resumeAt, windowMins: 300, ...extra })
    handle.emit({ type: 'error', sessionId: id, error: { code: 'internal', message: "You've hit your session limit · resets 1:20am", retryable: true } })
    return { a, id, handle }
  }

  it('is continued at the reset and its margin, not before', async () => {
    const hour = 60 * 60_000
    const { a, id, handle } = await limited(hour)
    const wait = a.session(id).interruption
    expect(wait).toMatchObject({ reason: 'limit', autoContinue: { tries: 0 } })
    expect(wait!.autoContinue!.at).toBe(Date.now() + hour + RESET_MARGIN_MS)
    await vi.advanceTimersByTimeAsync(hour + RESET_MARGIN_MS - TICK_MS)
    expect(handle.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(handle.sent).toEqual([LIMIT_NOTE])
    expect(lines(id, 'continue').at(-1)?.text).toBe('The usage limit reset, so Centralu continued this turn.')
    // A limit never touches the network: nothing was probed
    expect(probes).toBe(0)
  })

  it("a Codex 429 with no reset in its data continues at the time its words say, not 30 minutes on", async () => {
    vi.setSystemTime(new Date(2026, 10, 13, 17, 30))
    const a = host()
    const { id } = await started(a)
    // Codex 0.160.0's words, with no `account/rateLimits/updated` before them (measured on a live run)
    a.adapter.last.emit({ type: 'error', sessionId: id, error: { code: 'internal', message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at 6:17 PM.", retryable: false } })
    expect(a.session(id).interruption?.autoContinue?.at).toBe(new Date(2026, 10, 13, 18, 17).getTime() + RESET_MARGIN_MS)
  })

  it('a Codex credits limit does not reset with time and waits for the person', async () => {
    const { a, id, handle } = await limited(60_000, { credits: true })
    expect(a.session(id).interruption).toMatchObject({ reason: 'limit' })
    expect(a.session(id).interruption?.autoContinue).toBeUndefined()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(handle.sent).toEqual([])
  })

  it("a Codex credits limit said after the turn's error takes the wait away again", async () => {
    const a = host()
    const { id, handle } = await started(a)
    // Codex's failed turn first, its rate-limit notice after, at rest
    handle.emit({ type: 'error', sessionId: id, error: { code: 'internal', message: "You've hit your usage limit. Upgrade to Pro or try again later.", retryable: false } })
    expect(a.session(id).interruption).toMatchObject({ reason: 'limit', autoContinue: { tries: 0 } })
    handle.emit({ type: 'limit_reached', sessionId: id, credits: true })
    expect(a.session(id).interruption).toMatchObject({ reason: 'limit' })
    expect(a.session(id).interruption?.autoContinue).toBeUndefined()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(handle.sent).toEqual([])
  })

  it("a 429 or a quota that is not the account's own limit is no limit stop, and waits for nothing", async () => {
    const a = host()
    const { id } = await started(a)
    a.adapter.last.emit({ type: 'error', sessionId: id, error: { code: 'internal', message: '429 rate_limit_error: too many requests', retryable: true } })
    expect(a.session(id).interruption ?? null).toBeNull()
  })

  it('sessions of one tool that clear together go a few seconds apart', async () => {
    const a = host()
    const at = new Date(Date.now() + 60_000).toISOString()
    const first = await started(a)
    const second = await started(a)
    for (const s of [first, second]) s.handle.emit({ type: 'limit_reached', sessionId: s.id, resumeAt: at })
    await vi.advanceTimersByTimeAsync(60_000 + RESET_MARGIN_MS)
    expect([first.handle.sent, second.handle.sent]).toEqual([[LIMIT_NOTE], []])
    await vi.advanceTimersByTimeAsync(STAGGER_MS)
    expect(second.handle.sent).toEqual([LIMIT_NOTE])
  })

  it('with the setting off it is not armed', async () => {
    const a = host()
    a.mgr.prefs.setUiPreferences({ continueAfterLimit: false })
    const { id, handle } = await started(a)
    handle.emit({ type: 'limit_reached', sessionId: id, resumeAt: new Date(Date.now() + 1000).toISOString() })
    expect(a.session(id).interruption).toMatchObject({ reason: 'limit' })
    expect(a.session(id).interruption?.autoContinue).toBeUndefined()
  })
})

describe("who the stop's notice was held from hears it once, however the wait ends (#2239 re-check)", () => {
  /** What the host tells the stop notice path when a wait ends (`MailSessionsView.mailWaitEnded`) */
  const told = (a: ReturnType<typeof host>) => {
    const view = (a.mgr as unknown as { mail: { mailWaitEnded: (...x: unknown[]) => void } }).mail
    return vi.spyOn(view, 'mailWaitEnded')
  }

  it('a turn the mailbox starts during the wait ends it, told as the work going on; nothing is probed after, and no "could not reach" comes mid-work', async () => {
    const a = host()
    const ended = told(a)
    const { id, handle } = await cutByNetwork(a)
    // As delivered mail does: the tool takes an input outside this engine, and its turn starts
    handle.emit({ type: 'state_change', sessionId: id, state: 'working' })
    expect(ended).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledWith(id, 'network', null, { continued: 'other', first: true })
    await vi.advanceTimersByTimeAsync(PROBE_STEPS_MS[4] * MAX_FAILED_PROBES)
    expect(probes).toBe(0)
    expect(handle.sent).toEqual([])
    expect(lines(id, 'continue')).toEqual([])
    expect(ended).toHaveBeenCalledTimes(1)
  })

  it('a continue the tool refuses after it was handed is said in the conversation and told once, as the stop', async () => {
    const a = host()
    const ended = told(a)
    const { id, handle } = await cutByNetwork(a)
    handle.refuseSend = true
    online = true
    await vi.advanceTimersByTimeAsync(PROBE_STEPS_MS[0] + TICK_MS)
    expect(handle.sent).toEqual([])
    expect(lines(id, 'continue').at(-1)?.text).toMatch(/^Centralu could not continue this turn: /)
    expect(ended).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledWith(id, 'network', null, { continued: false, first: false })
    expect(a.session(id).interruption?.autoContinue).toBeUndefined()
  })

  it("the person's Continue now is told as the work going on once it went in; another message of theirs as the stop", async () => {
    const a = host()
    const ended = told(a)
    const first = await cutByNetwork(a)
    await a.rpc('agents.send', { sessionId: first.id, text: CONTINUE_WORDS })
    expect(ended).toHaveBeenCalledWith(first.id, 'network', null, { continued: 'other', first: true })
    const second = await cutByNetwork(a)
    await a.rpc('agents.send', { sessionId: second.id, text: 'use the other branch' })
    expect(ended).toHaveBeenCalledWith(second.id, 'network', null, { continued: false, first: false })
    expect(ended).toHaveBeenCalledTimes(2)
  })

  it('turning the setting off ends its waits at once, told once, and leaves the other cause waiting', async () => {
    const a = host()
    const ended = told(a)
    const { id } = await cutByNetwork(a)
    const limited = await started(a)
    limited.handle.emit({ type: 'limit_reached', sessionId: limited.id, resumeAt: new Date(Date.now() + 60 * 60_000).toISOString() })
    a.mgr.prefs.setUiPreferences({ continueOnNetwork: false })
    expect(a.session(id).interruption).toMatchObject({ reason: 'network' })
    expect(a.session(id).interruption?.autoContinue).toBeUndefined()
    expect(events.filter((e) => e.type === 'interruption' && e.sessionId === id).at(-1)).toMatchObject({ interruption: { reason: 'network' } })
    expect(ended).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledWith(id, 'network', null, { continued: false, first: false })
    expect(a.session(limited.id).interruption?.autoContinue).toBeDefined()
  })

  it("a Continue now that does not go in is told as the stop, never as the work going on", async () => {
    const a = host()
    const ended = told(a)
    const { id, handle } = await cutByNetwork(a)
    handle.refuseSend = true
    await expect(a.rpc('agents.send', { sessionId: id, text: CONTINUE_WORDS })).rejects.toThrow()
    expect(ended).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledWith(id, 'network', null, { continued: false, first: false })
  })

  it('the setting turned off while the continue is on its way (a restart or a wake waited out) sends nothing, told once as the stop', async () => {
    const a = host()
    const ended = told(a)
    const { id, handle } = await cutByNetwork(a)
    // Every input waits for a restart under way: the continue is being sent, not yet handed to the tool
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    ;(a.mgr as unknown as { restartPolicy: { deferredRestarts: Map<string, Promise<void>> } }).restartPolicy.deferredRestarts.set(id, gate)
    online = true
    await vi.advanceTimersByTimeAsync(PROBE_STEPS_MS[0] + TICK_MS)
    a.mgr.prefs.setUiPreferences({ continueOnNetwork: false })
    release()
    await vi.advanceTimersByTimeAsync(1)
    expect(handle.sent).toEqual([])
    expect(a.session(id).interruption?.autoContinue).toBeUndefined()
    expect(ended).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledWith(id, 'network', null, { continued: false, first: false })
  })
})
