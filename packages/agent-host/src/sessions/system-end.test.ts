import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYSTEM_END_LEAD_MS, SYSTEM_END_TAIL_MS, type SystemEnd } from '../lifecycle/system-end.js'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { SessionManager } from './manager.js'
import { wakesMessage } from '../mail/rules.js'
import { addressOf, mailReader, wireHostMail } from './host-mail.test-helpers.js'

/*
 * #1397: a shutdown, restart or sign-out ends the agents' processes. Codex's app-servers got the system's termination and exited 0
 * while the host was still up, which was written as `adapter_crashed` and shown as an error. The host now records, as it goes, that
 * it was told the system was ending (lifecycle/system-end.ts); the next start reads that notice and nothing else.
 */

const T0 = 1_800_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN

let w: CrossWorld
const later: SessionManager[] = []

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  w = await crossWorld()
  w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
})
afterEach(async () => {
  vi.useRealTimers()
  for (const mgr of later.splice(0)) await mgr.tenure.disposeAll()
  await w.dispose()
})

const info = (h: SessionManager, id: string) => h.listSessions().find((s) => s.id === id)!
const rowsOf = (id: string) => w.store.messages.loadMessages(id, 20).map((m) => JSON.stringify(m.payload))
const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!
const crash = (id: string) =>
  handleOf(id).event({ type: 'error', sessionId: id, error: { code: 'adapter_crashed', message: 'codex app-server exited (code 0)', retryable: true } })

/** What the host before this one left: a session in a turn, one ended by `adapter_crashed` at `crashedAt` (exit 0, as the issue shows), one at rest */
async function lastHost(crashedAt: number, o: { queued?: boolean } = {}) {
  const mk = () => w.callerSession()
  const inTurn = await mk()
  const crashed = await mk()
  const idle = await mk()
  await w.mgr.inputs.send(inTurn, 'a long job')
  await w.mgr.inputs.send(crashed, 'another job')
  vi.setSystemTime(crashedAt)
  if (o.queued) {
    // As the Claude adapter's close does with a follow-up still queued (`undeliveredError`, adapters/session-kit.ts): the manager closes the crashed handle
    const h = handleOf(crashed)
    const dispose = h.dispose.bind(h)
    h.dispose = async () => {
      h.event({ type: 'error', sessionId: crashed, error: { code: 'internal', message: '1 message was still queued when the session closed', retryable: false } })
      return dispose()
    }
  }
  crash(crashed)
  expect(info(w.mgr, crashed).state).toBe('error')
  return { inTurn, crashed, idle }
}

/** The start after, an hour on: `systemEnd` is what the last host's record said, or `null` when it said nothing of the system */
function nextStart(systemEnd: SystemEnd | null) {
  vi.setSystemTime(T0 + HOUR)
  const mgr = new SessionManager(w.store, w.adapters, () => {}, undefined, undefined, systemEnd ? { systemEnd } : {})
  mgr.prLookup = async () => null
  later.push(mgr)
  return mgr
}

describe('a session the system ended under the host (#1397)', () => {
  it('is stopped with the shutdown as its reason and a line to continue from, not an error', async () => {
    const { inTurn, crashed } = await lastHost(T0 + 5_000)

    const b = nextStart({ at: T0 })
    for (const id of [crashed, inTurn]) {
      expect(info(b, id)).toMatchObject({ state: 'idle', interruption: { reason: 'shutdown' } })
      expect(w.store.sessions.listSessions().find((s) => s.id === id)).toMatchObject({ state: 'idle', interruption: { reason: 'shutdown' } })
      expect(rowsOf(id).at(-1)).toContain('This turn stopped before it finished: the computer shut down, restarted or signed out while it was running')
    }
  })

  it('counts an agent that exited a little before the host was told: the system ended every process at once', async () => {
    const { crashed } = await lastHost(T0 - SYSTEM_END_LEAD_MS + 1_000)
    expect(info(nextStart({ at: T0 }), crashed)).toMatchObject({ state: 'idle', interruption: { reason: 'shutdown' } })
  })

  it('looks past the error closing the handle writes for follow-ups still queued (review finding 4)', async () => {
    const { crashed } = await lastHost(T0 + 5_000, { queued: true })
    expect(rowsOf(crashed).at(-1)).toContain('"code":"internal"')
    expect(info(nextStart({ at: T0 }), crashed)).toMatchObject({ state: 'idle', interruption: { reason: 'shutdown' } })
  })

  it('leaves a session that was at rest without a mark: it is asleep', async () => {
    const { idle } = await lastHost(T0 + 5_000)
    const before = rowsOf(idle)
    const b = nextStart({ at: T0 })
    expect(info(b, idle)).toMatchObject({ state: 'idle', interruption: null })
    expect(rowsOf(idle)).toEqual(before)
  })

  it('is a crash when the agent exited well before the system ended', async () => {
    const { crashed, inTurn } = await lastHost(T0 - HOUR / 2)
    const b = nextStart({ at: T0 })
    expect(info(b, crashed)).toMatchObject({ state: 'error', interruption: null })
    expect(rowsOf(crashed).at(-1)).toContain('adapter_crashed')
    // However long before its turn began, a turn still running when the system ended is the system's
    expect(info(b, inTurn).interruption).toMatchObject({ reason: 'shutdown' })
  })

  it('is a quit and a crash, as before, when the last host recorded nothing of the system: no guess from the clock (review findings 1-3, 6)', async () => {
    const { inTurn, crashed } = await lastHost(T0 + 5_000)
    const b = nextStart(null)
    expect(info(b, inTurn).interruption).toMatchObject({ reason: 'quit' })
    expect(info(b, crashed)).toMatchObject({ state: 'error', interruption: null })
  })

  it('is a quit for a turn with rows from after that end: a later host, of a build that reads no record, ran it', async () => {
    const { inTurn } = await lastHost(T0 + 5_000)
    // The record's end is two hours before the turn's rows
    expect(info(nextStart({ at: T0 - 2 * HOUR }), inTurn).interruption).toMatchObject({ reason: 'quit' })
    expect(info(nextStart({ at: T0 - SYSTEM_END_TAIL_MS }), inTurn).interruption).toMatchObject({ reason: 'quit' })
  })

  it('tells the session that gave the task, by the stop notice at the next start, as it is for a quit', async () => {
    // The mail wired as main.ts wires it: start_agent's task is a row the stop releases (mailbox.md §10.6.1)
    wireHostMail(w.mgr, w.store)
    const parent = await w.callerSession()
    const started = await w.mgr.startAgent(parent, { task: 'fix the sidebar indent', wait: false })
    if (!started.ok) throw new Error(started.error)
    const [task] = mailReader(w.store).tasks(addressOf(parent), started.sessionId)

    const b = nextStart({ at: T0 })
    expect(info(b, started.sessionId).interruption).toMatchObject({ reason: 'shutdown' })
    const m = wireHostMail(b, w.store)
    m.afterReady()
    m.delivery.stop()
    const notices = mailReader(w.store).between('centralu', addressOf(parent), 'notice')
    // Owed a reply (its task) and at rest: told at once and woken, in the shutdown's words, not a quit's
    expect(notices.map((n) => n.facts)).toEqual([{ unanswered: [{ id: task!.id, recipient: addressOf(started.sessionId), why: 'shutdown' }] }])
    expect(wakesMessage(notices[0]!)).toBe(true)
    expect(notices[0]!.body).toContain('the computer shut down, restarted or signed out while it worked')
    expect(notices[0]!.body).not.toContain('Centralu quit')
    // No report of the older path besides (#1948 step 1: `quitNotices` is gone), and the task stays open for the reply: the start's adoption does
    // not settle a released task as reported
    expect(mailReader(w.store).reportsOn(task!.id)).toEqual([])
    expect(mailReader(w.store).row(task!.id, addressOf(started.sessionId))).toMatchObject({ releasedWhy: 'shutdown', settled: null })
  })
})
