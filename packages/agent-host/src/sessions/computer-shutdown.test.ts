import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootTimeOf, computerShutdownWindow, SHUTDOWN_GRACE_MS } from '../lifecycle/computer-shutdown.js'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { SessionManager } from './manager.js'

/*
 * #1397: a computer's shutdown ends the agents' processes. Codex's app-servers got the system's termination and exited 0 while the host
 * was still up, which was written as `adapter_crashed` and shown as an error. The next start tells it from a crash by the host's last sign
 * of life (the mail heartbeat) against the boot time: a boot after it, with no quit of the person's, means the computer went down under it.
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
  for (const mgr of later.splice(0)) await mgr.disposeAll()
  await w.dispose()
})

const info = (h: SessionManager, id: string) => h.listSessions().find((s) => s.id === id)!
const rowsOf = (id: string) => w.store.messages.loadMessages(id, 20).map((m) => JSON.stringify(m.payload))
const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!

/** What the host before this one left: a session in a turn, one ended by `adapter_crashed` (exit 0, as the issue shows), one at rest */
async function lastHost(crashedAt: number) {
  const mk = () => w.callerSession()
  const inTurn = await mk()
  const crashed = await mk()
  const idle = await mk()
  await w.mgr.send(inTurn, 'a long job')
  await w.mgr.send(crashed, 'another job')
  vi.setSystemTime(crashedAt)
  handleOf(crashed).event({ type: 'error', sessionId: crashed, error: { code: 'adapter_crashed', message: 'codex app-server exited (code 0)', retryable: true } })
  expect(info(w.mgr, crashed).state).toBe('error')
  return { inTurn, crashed, idle }
}

/** The start after, at `T0 + 3 h`: `lastAliveAt` is the host's last heartbeat, `bootedAt` when the computer booted (read back from the uptime, as the host reads it) */
function nextStart(o: { lastAliveAt: number | null; bootedAt: number; stoppedOnPurpose?: boolean }) {
  const now = T0 + 3 * HOUR
  vi.setSystemTime(now)
  const bootAt = bootTimeOf(now, (now - o.bootedAt) / 1000)
  const mgr = new SessionManager(w.store, w.adapters, () => {}, undefined, undefined, {
    computerShutdown: computerShutdownWindow({ lastAliveAt: o.lastAliveAt, bootAt, stoppedOnPurpose: o.stoppedOnPurpose ?? false }),
  })
  mgr.prLookup = async () => null
  later.push(mgr)
  return mgr
}
const BOOTED_AFTER = T0 + 3 * HOUR - 30_000

describe('which span a shutdown covers', () => {
  it('runs from a little before the host was last alive to the boot', () => {
    expect(computerShutdownWindow({ lastAliveAt: T0, bootAt: T0 + HOUR, stoppedOnPurpose: false })).toEqual({ from: T0 - SHUTDOWN_GRACE_MS, to: T0 + HOUR })
  })
  it.each([
    ['the host ran through the boot', { lastAliveAt: T0, bootAt: T0 - HOUR, stoppedOnPurpose: false }],
    ['the host was last alive at the boot', { lastAliveAt: T0, bootAt: T0, stoppedOnPurpose: false }],
    ['there is no sign of life on record', { lastAliveAt: null, bootAt: T0 + HOUR, stoppedOnPurpose: false }],
    ['the person quit Centralu', { lastAliveAt: T0, bootAt: T0 + HOUR, stoppedOnPurpose: true }],
  ])('is none when %s', (_, o) => {
    expect(computerShutdownWindow(o)).toBeNull()
  })
  it('reads the boot from the clock less the uptime', () => {
    expect(bootTimeOf(T0, 90)).toBe(T0 - 90_000)
  })
})

describe('a session the computer shut down under (#1397)', () => {
  it('is stopped with the shutdown as its reason and a line to continue from, not an error', async () => {
    const { inTurn, crashed } = await lastHost(T0 + MIN)

    const b = nextStart({ lastAliveAt: T0, bootedAt: BOOTED_AFTER })
    for (const id of [crashed, inTurn]) {
      expect(info(b, id)).toMatchObject({ state: 'idle', interruption: { reason: 'shutdown' } })
      expect(w.store.sessions.listSessions().find((s) => s.id === id)).toMatchObject({ state: 'idle', interruption: { reason: 'shutdown' } })
      expect(rowsOf(id).at(-1)).toContain('The computer shut down or restarted while this turn was running')
    }
  })

  it('leaves a session that was at rest without a mark: it is asleep', async () => {
    const { idle } = await lastHost(T0 + MIN)
    const before = rowsOf(idle)
    const b = nextStart({ lastAliveAt: T0, bootedAt: BOOTED_AFTER })
    expect(info(b, idle)).toMatchObject({ state: 'idle', interruption: null })
    expect(rowsOf(idle)).toEqual(before)
  })

  it('is a crash when the session ended long before the host was last alive: the computer going down later changes nothing', async () => {
    const { crashed, inTurn } = await lastHost(T0 - HOUR)
    const b = nextStart({ lastAliveAt: T0, bootedAt: BOOTED_AFTER })
    expect(info(b, crashed)).toMatchObject({ state: 'error', interruption: null })
    expect(rowsOf(crashed).at(-1)).toContain('adapter_crashed')
    // A turn the host lost is one the shutdown ended whenever the host was last alive; only its crash is dated
    expect(info(b, inTurn).interruption).toMatchObject({ reason: 'shutdown' })
  })

  it('stays an error when the computer did not go down: the boot is before the host was last alive', async () => {
    const { crashed } = await lastHost(T0 + MIN)
    const b = nextStart({ lastAliveAt: T0, bootedAt: T0 - 2 * HOUR })
    expect(info(b, crashed)).toMatchObject({ state: 'error', interruption: null })
  })

  it('is a quit when the person stopped Centralu before the computer went down', async () => {
    const { inTurn, crashed } = await lastHost(T0 + MIN)
    const b = nextStart({ lastAliveAt: T0, bootedAt: BOOTED_AFTER, stoppedOnPurpose: true })
    expect(info(b, inTurn).interruption).toMatchObject({ reason: 'quit' })
    expect(info(b, crashed)).toMatchObject({ state: 'error', interruption: null })
  })

  it('tells the session that gave the turn, as it is for a quit', async () => {
    const parent = await w.callerSession()
    const started = await w.mgr.startAgent(parent, { task: 'fix the sidebar indent', wait: false })
    if (!started.ok) throw new Error(started.error)

    const b = nextStart({ lastAliveAt: T0, bootedAt: BOOTED_AFTER })
    const told = () => w.store.messages.loadMessages(parent, 50).map((m) => JSON.stringify(m.payload)).filter((x) => x.includes('[Centralu] The assigned work') && x.includes(started.sessionId))
    await w.until(() => told().length === 1)
    expect(told()[0]).toContain('stopped before finishing: the computer shut down or restarted during its turn')
    expect(told()[0]).not.toContain('Centralu quit')
    expect(info(b, started.sessionId).interruption).toMatchObject({ reason: 'shutdown' })
  })
})
