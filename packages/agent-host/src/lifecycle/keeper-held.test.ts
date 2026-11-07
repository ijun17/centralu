import { describe, expect, it } from 'vitest'
import { endHeld, type HeldIo, refuseStandby, runningHeld } from './keeper-held.js'

/**
 * An update from a keeper of beta.48 or older (#1895 step 4, PR 1 review): such a keeper swaps its host to this build
 * under itself even after this build's keeper refused its handoff, and its host's drain hands its children to it. A
 * standby of this build then gives up, and a plain start ends what the keeper holds.
 */

type Row = { id: string; pid: number; exit: unknown }
const child = (id: string, pid: number, exit: unknown = null): Row => ({ id, pid, exit })

/** A keeper of beta.48 or older holding `table`, which records every line sent to its children service */
function holdingKeeper(table: Row[], onSignal: (c: Row, sig: string) => void = () => {}) {
  const sent: Record<string, unknown>[] = []
  const io: HeldIo = {
    servesChildren: () => true,
    askKeeper: (line) => {
      expect(line).toEqual({ op: 'children' })
      return Promise.resolve({ ok: true, children: table.map((c) => ({ ...c })) })
    },
    askChildren: (lines) => {
      sent.push(...lines)
      for (const l of lines) {
        const c = table.find((t) => t.id === l.id)
        if (l.op === 'signal' && c) onSignal(c, String(l.signal))
      }
      return Promise.resolve(lines.map(() => ({ ok: true })))
    },
  }
  return { io, sent }
}

const noWait = { sleep: () => Promise.resolve() }

describe('a keeper that still holds children (beta.48 or older)', () => {
  it('a keeper with no children service is not asked anything: a standby stands by and a start ends nothing', async () => {
    const asked = () => Promise.reject(new Error('asked'))
    const io: HeldIo = { servesChildren: () => false, askKeeper: asked, askChildren: asked }
    expect(await runningHeld(io)).toEqual([])
    expect(await refuseStandby(io)).toBeNull()
    expect(await endHeld(io, () => {}, noWait)).toEqual({ ended: 0, left: 0 })
  })

  it('a standby gives up while the keeper holds a running child of the running host, and sends its service nothing', async () => {
    const k = holdingKeeper([child('c1', 101), child('c2', 102, { code: 0, signal: null })])
    const why = await refuseStandby(k.io)
    expect(why).toMatch(/still holds 1 agent, terminal or command process/)
    expect(why).toMatch(/Quit Centralu completely and open it again/)
    expect(k.sent).toEqual([])
  })

  it('a standby stands by when everything the keeper holds has exited, or when the keeper cannot say', async () => {
    expect(await refuseStandby(holdingKeeper([child('c1', 101, { code: 1, signal: null })]).io)).toBeNull()
    const base = holdingKeeper([]).io
    expect(await refuseStandby({ ...base, askKeeper: () => Promise.resolve({ ok: false, error: 'the keeper has no child service' }) })).toBeNull()
    expect(await refuseStandby({ ...base, askKeeper: () => Promise.reject(new Error('ECONNREFUSED')) })).toBeNull()
  })

  it('a plain start ends each running child by its process group: TERM, then KILL to what is left after the grace', async () => {
    const table = [child('c1', 101), child('c2', 102), child('c3', 103, { code: 0, signal: null })]
    // c1 ends on TERM; c2 only on KILL
    const k = holdingKeeper(table, (c, sig) => {
      if (c.id === 'c1' || sig === 'SIGKILL') c.exit = { code: null, signal: sig === 'SIGKILL' ? 9 : 15 }
    })
    const lines: string[] = []
    expect(await endHeld(k.io, (l) => lines.push(l), { ...noWait, graceMs: 500 })).toEqual({ ended: 2, left: 0 })
    expect(k.sent).toEqual([
      { op: 'hello', protocol: 1 },
      { rid: 1, op: 'signal', id: 'c1', signal: 'SIGTERM', group: true },
      { rid: 2, op: 'signal', id: 'c2', signal: 'SIGTERM', group: true },
      { op: 'hello', protocol: 1 },
      { rid: 1, op: 'signal', id: 'c2', signal: 'SIGKILL', group: true },
    ])
    expect(lines[0]).toMatch(/still holds 2 process\(es\).*c1 pid 101, c2 pid 102/)
  })

  it('says what did not end', async () => {
    const lines: string[] = []
    expect(await endHeld(holdingKeeper([child('c1', 101)]).io, (l) => lines.push(l), { ...noWait, graceMs: 250 })).toEqual({ ended: 0, left: 1 })
    expect(lines.at(-1)).toMatch(/1 process\(es\) the keeper holds did not end: c1 pid 101/)
  })
})
