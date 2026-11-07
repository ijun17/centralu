import { describe, expect, it } from 'vitest'
import { parseProcRows } from '../keeper/children-client.js'
import { endHeld, type HeldIo, type ProcRow, refuseStandby, runningHeld, sessionGroups } from './keeper-held.js'

/**
 * An update from a keeper of beta.48 or older (#1895 step 4, PR 1 review): such a keeper swaps its host to this build
 * under itself even after this build's keeper refused its handoff, and its host's drain hands its children to it. A
 * standby of this build then gives up, and a plain start ends what the keeper holds.
 */

type Row = { id: string; pid: number; kind?: string; exit: unknown }
const child = (id: string, pid: number, exit: unknown = null, kind = 'pipes'): Row => ({ id, pid, kind, exit })

const HOST = 900

/**
 * A keeper of beta.48 or older holding `table`, which records every line sent to its children service, over a process
 * table `procs` where a signal to a group ends its members (`survives` names the pids that ignore TERM)
 */
function holdingKeeper(table: Row[], opts: { onSignal?: (c: Row, sig: string) => void; procs?: ProcRow[]; survives?: number[] } = {}) {
  const sent: Record<string, unknown>[] = []
  const groups: [number, string][] = []
  let procs = [...(opts.procs ?? []), { pid: HOST, pgid: HOST, tty: null }]
  const hit = (pgid: number, sig: string) => {
    procs = procs.filter((p) => p.pgid !== pgid || (sig === 'SIGTERM' && opts.survives?.includes(p.pid)))
    for (const c of table) if (c.pid === pgid && !procs.some((p) => p.pid === c.pid) && c.exit === null) c.exit = { code: null, signal: sig === 'SIGKILL' ? 9 : 15 }
  }
  const io: HeldIo = {
    servesChildren: () => Promise.resolve(true),
    askKeeper: (line) => {
      expect(line).toEqual({ op: 'children' })
      return Promise.resolve({ ok: true, children: table.map((c) => ({ ...c })) })
    },
    askChildren: (lines) => {
      sent.push(...lines)
      for (const l of lines) {
        const c = table.find((t) => t.id === l.id)
        if (l.op !== 'signal' || !c) continue
        opts.onSignal?.(c, String(l.signal))
        if (opts.procs) hit(c.pid, String(l.signal))
      }
      return Promise.resolve(lines.map(() => ({ ok: true })))
    },
    processes: () => procs.map((p) => ({ ...p })),
    signalGroup: (pgid, sig) => {
      groups.push([pgid, sig])
      hit(pgid, sig)
    },
    self: HOST,
  }
  return { io, sent, groups, procs: () => procs }
}

const noWait = { sleep: () => Promise.resolve() }

describe('a keeper that still holds children (beta.48 or older)', () => {
  it('a keeper with no children service is not asked anything: a standby stands by and a start ends nothing', async () => {
    const asked = () => Promise.reject(new Error('asked'))
    const io: HeldIo = {
      servesChildren: () => Promise.resolve(false),
      askKeeper: asked,
      askChildren: asked,
      processes: () => [],
      signalGroup: () => {
        throw new Error('signalled')
      },
      self: HOST,
    }
    expect(await runningHeld(io)).toEqual({ running: [] })
    expect(await refuseStandby(io)).toBeNull()
    expect(await endHeld(io, () => {}, noWait)).toEqual({ ended: 0, left: 0, strays: 0 })
  })

  it('a standby gives up while the keeper holds a running child of the running host, and sends its service nothing', async () => {
    const k = holdingKeeper([child('c1', 101), child('c2', 102, { code: 0, signal: null })])
    const why = await refuseStandby(k.io)
    expect(why).toMatch(/still holds 1 agent, terminal or command process/)
    expect(why).toMatch(/Quit Centralu completely and open it again/)
    expect(k.sent).toEqual([])
  })

  it('a standby stands by when the keeper says everything it holds has exited', async () => {
    expect(await refuseStandby(holdingKeeper([child('c1', 101, { code: 1, signal: null })]).io)).toBeNull()
    expect(await refuseStandby(holdingKeeper([]).io)).toBeNull()
  })

  it('a standby gives up when a keeper with a children service cannot say: it answers ok:false, not at all, or a list it cannot be read from', async () => {
    const base = holdingKeeper([]).io
    const cases: [string, HeldIo['askKeeper'], RegExp][] = [
      ['ok:false', () => Promise.resolve({ ok: false, error: 'the keeper has no child service' }), /answered "the keeper has no child service"/],
      ['no answer', () => Promise.reject(new Error('no answer on keeper.sock')), /did not answer: no answer on keeper\.sock/],
      ['refused', () => Promise.reject(new Error('ECONNREFUSED')), /did not answer: ECONNREFUSED/],
      ['no list', () => Promise.resolve({ ok: true }), /without a list/],
      ['a child without a pid', () => Promise.resolve({ ok: true, children: [{ id: 'c1', exit: null }] }), /cannot be read/],
    ]
    for (const [name, askKeeper, said] of cases) {
      const why = await refuseStandby({ ...base, askKeeper })
      expect(why, name).toMatch(/cannot say whether any still runs/)
      expect(why, name).toMatch(said)
      expect(why, name).toMatch(/Quit Centralu completely and open it again/)
    }
  })

  it('a plain start that cannot read what the keeper holds sends nothing, and says so', async () => {
    const k = holdingKeeper([child('c1', 101)])
    const lines: string[] = []
    const io = { ...k.io, askKeeper: () => Promise.resolve({ ok: false, error: 'busy' }) }
    expect(await endHeld(io, (l) => lines.push(l), noWait)).toEqual({ ended: 0, left: 0, strays: 0 })
    expect(k.sent).toEqual([])
    expect(lines).toEqual([expect.stringMatching(/could not end what the keeper holds.*"busy"/)])
  })

  it('a plain start ends each running child by its process group: TERM, then KILL to what is left after the grace', async () => {
    const table = [child('c1', 101), child('c2', 102), child('c3', 103, { code: 0, signal: null })]
    // c1 ends on TERM; c2 only on KILL
    const k = holdingKeeper(table, {
      onSignal: (c, sig) => {
        if (c.id === 'c1' || sig === 'SIGKILL') c.exit = { code: null, signal: sig === 'SIGKILL' ? 9 : 15 }
      },
    })
    const lines: string[] = []
    expect(await endHeld(k.io, (l) => lines.push(l), { ...noWait, graceMs: 500 })).toEqual({ ended: 2, left: 0, strays: 0 })
    expect(k.sent).toEqual([
      { op: 'hello', protocol: 1 },
      { rid: 1, op: 'signal', id: 'c1', signal: 'SIGTERM', group: true },
      { rid: 2, op: 'signal', id: 'c2', signal: 'SIGTERM', group: true },
      { op: 'hello', protocol: 1 },
      { rid: 1, op: 'signal', id: 'c2', signal: 'SIGKILL', group: true },
    ])
    expect(k.groups).toEqual([])
    expect(lines[0]).toMatch(/still holds 2 process\(es\).*c1 pid 101, c2 pid 102/)
  })

  it('says what did not end', async () => {
    const lines: string[] = []
    expect(await endHeld(holdingKeeper([child('c1', 101)]).io, (l) => lines.push(l), { ...noWait, graceMs: 250 })).toEqual({ ended: 0, left: 1, strays: 0 })
    expect(lines.at(-1)).toMatch(/1 process\(es\) the keeper holds did not end: c1 pid 101/)
  })
})

describe("a held terminal's session", () => {
  // The shell 201 leads its session on pts/4; `sleep &` (205) and a dev server (207, with a child 208) are jobs in
  // groups of their own. Another terminal's shell (301) and a process with no terminal (401) are not the terminal's.
  const procs: ProcRow[] = [
    { pid: 201, pgid: 201, tty: 'pts/4' },
    { pid: 205, pgid: 205, tty: 'pts/4' },
    { pid: 207, pgid: 207, tty: 'pts/4' },
    { pid: 208, pgid: 207, tty: 'pts/4' },
    { pid: 301, pgid: 301, tty: 'pts/9' },
    { pid: 401, pgid: 401, tty: null },
  ]

  it('is every process whose controlling terminal is the shell’s, and nothing else', () => {
    expect(sessionGroups(procs, 201, HOST).map((r) => r.pid)).toEqual([201, 205, 207, 208])
    expect(sessionGroups(procs, 999, HOST)).toEqual([])
    expect(sessionGroups([...procs, { pid: 501, pgid: 501, tty: null }], 501, HOST)).toEqual([])
  })

  it('never takes in the host, its group, or a terminal the host shares', () => {
    const rows = [...procs, { pid: HOST, pgid: 207, tty: null }]
    expect(sessionGroups(rows, 201, HOST).map((r) => r.pid)).toEqual([201, 205])
    expect(sessionGroups([...procs, { pid: HOST, pgid: HOST, tty: 'pts/4' }], 201, HOST)).toEqual([])
  })

  it('a plain start ends the jobs of a held terminal with its shell, and nothing outside it', async () => {
    const k = holdingKeeper([child('c1', 201, null, 'pty')], { procs })
    expect(await endHeld(k.io, () => {}, { ...noWait, graceMs: 500 })).toEqual({ ended: 1, left: 0, strays: 0 })
    expect(k.groups).toEqual([
      [201, 'SIGTERM'],
      [205, 'SIGTERM'],
      [207, 'SIGTERM'],
    ])
    expect(k.procs().map((p) => p.pid)).toEqual([301, 401, HOST])
  })

  it('a job that ignores TERM gets KILL after the grace, even once its shell is gone and it keeps no terminal', async () => {
    const k = holdingKeeper([child('c1', 201, null, 'pty')], { procs, survives: [205] })
    // once the shell has gone, the kernel takes the terminal from what is left of its session
    const io: HeldIo = {
      ...k.io,
      processes: () => {
        const rows = k.io.processes()
        return rows.some((p) => p.pid === 201) ? rows : rows.map((p) => (p.pid === 205 ? { ...p, tty: null } : p))
      },
    }
    expect(await endHeld(io, () => {}, { ...noWait, graceMs: 500 })).toEqual({ ended: 1, left: 0, strays: 0 })
    expect(k.groups).toContainEqual([205, 'SIGKILL'])
    expect(k.groups.filter(([, s]) => s === 'SIGKILL')).toEqual([[205, 'SIGKILL']])
    expect(k.procs().map((p) => p.pid)).toEqual([301, 401, HOST])
  })

  it('a pid that has gone and come back in another group is not shot again', async () => {
    const k = holdingKeeper([child('c1', 201, null, 'pty')], { procs, survives: [205] })
    let calls = 0
    // after the first shot, 205 is a process of someone else's, in a group of its own
    const io: HeldIo = {
      ...k.io,
      processes: () => (calls++ === 0 ? k.io.processes() : k.io.processes().map((p) => (p.pid === 205 ? { pid: 205, pgid: 600, tty: null } : p))),
    }
    expect(await endHeld(io, () => {}, { ...noWait, graceMs: 500 })).toEqual({ ended: 1, left: 0, strays: 0 })
    expect(k.groups.filter(([, s]) => s === 'SIGKILL')).toEqual([])
  })
})

describe('the process table', () => {
  it('reads ps rows of Linux and macOS, a missing terminal as none', () => {
    expect(parseProcRows('  1     1 ?\n 201   201 pts/4\n 205 205 ttys003\n 7 7 ??\n 8 8 -\nnoise\n')).toEqual([
      { pid: 1, pgid: 1, tty: null },
      { pid: 201, pgid: 201, tty: 'pts/4' },
      { pid: 205, pgid: 205, tty: 'ttys003' },
      { pid: 7, pgid: 7, tty: null },
      { pid: 8, pgid: 8, tty: null },
    ])
  })
})
