import { describe, expect, it } from 'vitest'
import { answerKeeperStop } from './keeper-stop.js'
import { createStopGate } from './stop-gate.js'
import { Drain } from '../drain.js'
import type { HostActivity } from '@cc/protocol'

const quiet: HostActivity = { working: 0, approvals: 0, questions: 0, background: 0, terminals: 0, commandRuns: 0 }

function rig(activity: HostActivity) {
  const drain = new Drain()
  const gate = createStopGate({ drain, activity: () => activity, boundMs: 50 })
  const said: unknown[] = []
  const stops: { forUpdate: boolean }[] = []
  const ask = (m: { ifIdle?: unknown; forUpdate?: unknown }) =>
    answerKeeperStop(m, { gate, stop: (o) => stops.push(o), write: (line) => said.push(JSON.parse(line)) })
  return { drain, said, stops, ask }
}

describe('a headless keeper asking its host to stop (docs/plans/remote-keeper.md §8)', () => {
  it('refuses while a turn runs, says what runs, and stops nothing', () => {
    const r = rig({ ...quiet, working: 1 })
    r.ask({ ifIdle: true })
    expect(r.said).toEqual([{ stopAnswer: { ok: false, busy: { ...quiet, working: 1 }, calls: 0 } }])
    expect(r.stops).toEqual([])
    expect(r.drain.draining).toBe(false)
  })

  it('refuses while a terminal is open, or a call is in flight besides the asking one', async () => {
    const terminal = rig({ ...quiet, terminals: 1 })
    terminal.ask({ ifIdle: true })
    expect(terminal.stops).toEqual([])
    const call = rig(quiet)
    // the asking call plus another one
    const first = call.drain.track('a', () => new Promise(() => {}))
    const second = call.drain.track('b', () => new Promise(() => {}))
    void first
    void second
    call.ask({ ifIdle: true })
    expect(call.said).toEqual([{ stopAnswer: { ok: false, busy: quiet, calls: 1 } }])
    expect(call.stops).toEqual([])
  })

  it('on idle says yes first, refuses every call after its yes, then stops', async () => {
    const r = rig(quiet)
    r.ask({ ifIdle: true })
    expect(r.said).toEqual([{ stopAnswer: { ok: true } }])
    expect(r.stops).toEqual([{ forUpdate: false }])
    // The gate's yes closed the door in the same tick: a call that arrives now is cut as retryable
    expect(r.drain.draining).toBe(true)
    await expect(r.drain.track('sessions.send', async () => 'started')).rejects.toThrow()
  })

  it('without ifIdle stops at once, whatever runs, and carries forUpdate', () => {
    const r = rig({ ...quiet, working: 2 })
    r.ask({ forUpdate: true })
    expect(r.said).toEqual([{ stopAnswer: { ok: true } }])
    expect(r.stops).toEqual([{ forUpdate: true }])
    expect(r.drain.draining).toBe(false)
  })

  it('takes only a boolean true for either flag', () => {
    const r = rig({ ...quiet, working: 1 })
    r.ask({ ifIdle: 'yes', forUpdate: 'yes' })
    expect(r.stops).toEqual([{ forUpdate: false }])
  })
})
