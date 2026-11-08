/**
 * The host's shutdown as data (docs/runtime-lessons.md HO8, HO15, #396): the order its steps run
 * in, that every one runs, and that leaving happens once.
 */
import { describe, expect, it } from 'vitest'
import { both, runSteps, type Step } from './steps.js'
import { Shutdown, stopPlan, type HostParts } from './shutdown.js'

function steps(log: string[], spec: [string, 'ok' | 'throw' | 'reject' | 'async'][]): Step[] {
  return spec.map(([name, how]) => ({
    name,
    run: () => {
      log.push(name)
      if (how === 'throw') throw new Error(`${name} failed`)
      if (how === 'reject') return Promise.reject(new Error(`${name} failed`))
      if (how === 'async') return Promise.resolve()
      return undefined
    },
  }))
}

describe('running the steps of a shutdown (#396)', () => {
  it('a close that throws does not skip the next one', async () => {
    const ran: string[] = []
    const run = runSteps(steps(ran, [['store', 'throw'], ['children', 'ok']]), () => {})
    await expect(run).rejects.toThrow('store failed')
    expect(ran).toEqual(['store', 'children'])
  })

  it("run when a step threw, and the step's error is the one that comes out", async () => {
    const ran: string[] = []
    const logged: string[] = []
    const run = runSteps(steps(ran, [['views', 'reject'], ['server', 'async'], ['store', 'throw'], ['children', 'ok']]), (l) => void logged.push(l))
    await expect(run).rejects.toThrow('views failed')
    expect(ran).toEqual(['views', 'server', 'store', 'children'])
    expect(logged.join('\n')).toContain('store failed')
  })

  it('the synchronous steps at the head of the list have all run before the call returns', () => {
    const ran: string[] = []
    void runSteps(steps(ran, [['a', 'ok'], ['b', 'throw'], ['c', 'ok'], ['d', 'async'], ['e', 'ok']]), () => {}).catch(() => {})
    expect(ran).toEqual(['a', 'b', 'c', 'd'])
  })

  it('both halves of a parallel step run to their end, and the first one’s error is the step’s', async () => {
    const order: string[] = []
    let release!: () => void
    const slow = () => new Promise<void>((r) => (release = r)).then(() => void order.push('slow done'))
    const run = both(() => Promise.reject(new Error('apps')), () => {
      order.push('slow started')
      return slow()
    })
    release()
    await expect(run).rejects.toThrow('apps')
    expect(order).toEqual(['slow started', 'slow done'])
  })
})

/** Fake services that record what was done to them, with sessions whose cleanup the test releases */
function parts() {
  const did: string[] = []
  let releaseSessions!: () => void
  const sessionsDone = new Promise<void>((r) => (releaseSessions = r))
  const never = new Promise<void>(() => {})
  const rec = (what: string) => () => void did.push(what)
  const p: HostParts = {
    handOverViews: rec('hand over views'),
    recordEnded: rec('record ended'),
    terminals: { disposeAll: rec('terminals end') },
    commands: { disposeAll: rec('commands end') },
    updates: { stop: rec('updates') },
    agentVersions: { stop: rec('agent versions') },
    sleeper: { stop: rec('sleeper') },
    compaction: { stop: rec('compaction') },
    mailDelivery: { stop: rec('mail delivery') },
    stopActivity: rec('activity'),
    git: { stopAll: async () => void did.push('git') },
    links: { stop: async () => void did.push('links') },
    apps: { dispose: async () => void did.push('apps') },
    sessions: {
      disposeAll: () => (did.push('sessions end'), sessionsDone),
    },
    appChanges: { dispose: rec('app changes') },
    themes: { close: rec('themes') },
    inlineViews: { dispose: rec('inline views') },
    views: { dispose: async () => void did.push('views') },
    server: { close: async () => void did.push('server') },
    store: { close: rec('store') },
  }
  return { did, p, releaseSessions, never }
}

describe('the stop plan (HO8)', () => {
  it('terminals and commands end before anything is awaited, even when the links never stop', () => {
    const f = parts()
    f.p.links = { stop: () => (f.did.push('links'), f.never) }
    void runSteps(stopPlan(f.p), () => {})
    expect(f.did.slice(0, 4)).toEqual(['hand over views', 'record ended', 'terminals end', 'commands end'])
  })

  it('an update lists the terminals and commands before the shells go (#1902)', async () => {
    const stop = parts()
    stop.releaseSessions()
    await runSteps(stopPlan(stop.p), () => {})
    expect(stop.did).toContain('record ended')
    expect(stop.did.indexOf('record ended')).toBeLessThan(stop.did.indexOf('terminals end'))
  })

  it('app processes stop while the sessions are still cleaning up, not after', async () => {
    const f = parts()
    const run = runSteps(stopPlan(f.p), () => {})
    await new Promise((r) => setTimeout(r, 0))
    expect(f.did).toContain('sessions end')
    expect(f.did).toContain('apps')
    expect(f.did).not.toContain('server')
    f.releaseSessions()
    await run
  })

  it('the server closes after every service, then the store', async () => {
    const f = parts()
    f.releaseSessions()
    await runSteps(stopPlan(f.p), () => {})
    expect(f.did.slice(-2)).toEqual(['server', 'store'])
    expect(f.did.indexOf('views')).toBeLessThan(f.did.indexOf('server'))
    expect(f.did.indexOf('sessions end')).toBeLessThan(f.did.indexOf('server'))
  })

  it('a service that fails to stop does not keep the server or the store open', async () => {
    const f = parts()
    f.releaseSessions()
    f.p.views = { dispose: () => Promise.reject(new Error('a view would not close')) }
    await expect(runSteps(stopPlan(f.p), () => {})).rejects.toThrow('a view would not close')
    expect(f.did.slice(-2)).toEqual(['server', 'store'])
  })

  it('compacting idle sessions stops before the sessions are let go of too, so a sweep cannot send a compact to a process that is being stopped (#1451)', async () => {
    const f = parts()
    f.releaseSessions()
    await runSteps(stopPlan(f.p), () => {})
    expect(f.did).toContain('compaction')
    expect(f.did.indexOf('compaction')).toBeLessThan(f.did.indexOf('sessions end'))
  })

  it('putting idle sessions to sleep stops before the sessions are let go of, so a sweep cannot race the sessions’ own stop (#568)', async () => {
    const f = parts()
    f.releaseSessions()
    await runSteps(stopPlan(f.p), () => {})
    expect(f.did).toContain('sleeper')
    expect(f.did.indexOf('sleeper')).toBeLessThan(f.did.indexOf('sessions end'))
  })

  it('the mailbox’s delivery stops before the sessions are let go of, so a host that is leaving wakes no session that is being stopped (#1347)', async () => {
    const f = parts()
    f.releaseSessions()
    await runSteps(stopPlan(f.p), () => {})
    expect(f.did).toContain('mail delivery')
    expect(f.did.indexOf('mail delivery')).toBeLessThan(f.did.indexOf('sessions end'))
  })

  it('the open views are handed over first, before anything closes them (the host writes them only on a stop for an update)', async () => {
    const f = parts()
    f.releaseSessions()
    await runSteps(stopPlan(f.p), () => {})
    expect(f.did[0]).toBe('hand over views')
  })
})

describe('the git calls still running (#982)', () => {
  // Git runs in a group of its own, out of reach of a Ctrl+C; nothing else ends it
  it('ends them before the sessions are let go of', async () => {
    const f = parts()
    f.releaseSessions()
    await runSteps(stopPlan(f.p), () => {})
    expect(f.did).toContain('git')
    expect(f.did.indexOf('git')).toBeLessThan(f.did.indexOf('sessions end'))
  })
})

describe('leaving, once (HO8)', () => {
  function shutdown(plan: () => Step[], beforeLeave?: () => Promise<void> | undefined) {
    const logged: string[] = []
    const exits: number[] = []
    let logStopped = 0
    const timers: (() => void)[] = []
    const s = new Shutdown({
      plan,
      log: (l) => void logged.push(l),
      stopLog: () => void logStopped++,
      exit: (code) => void exits.push(code),
      pid: 42,
      setTimer: (f) => void timers.push(f),
      ...(beforeLeave ? { beforeLeave } : {}),
    })
    return { s, logged, exits, logStopped: () => logStopped, fireBound: () => timers.forEach((f) => f()) }
  }

  // #1397: the host asks the system whether it is ending before its agents go, whichever way the leave began
  it('waits for what comes before a leave, once, and stops nothing until it is done; with nothing to wait for it begins at once', async () => {
    let answer: () => void = () => {}
    let asked = 0
    const ran: string[] = []
    const t = shutdown(
      () => [{ name: 'terminals', run: () => void ran.push('terminals') }],
      () => (asked++, new Promise<void>((r) => (answer = r))),
    )
    const first = t.s.leave()
    void t.s.leave()
    await Promise.resolve()
    expect({ asked, ran, leaving: t.s.leaving }).toEqual({ asked: 1, ran: [], leaving: true })
    answer()
    await first
    expect(ran).toEqual(['terminals'])
    expect(t.exits).toEqual([0])

    // With nothing to wait for (no question where the system cannot be asked), the leave begins in the call, as before (HO8)
    const sync: string[] = []
    const u = shutdown(() => [{ name: 'terminals', run: () => void sync.push('terminals') }], () => undefined)
    void u.s.leave()
    expect(sync).toEqual(['terminals'])
  })

  it('a step before the leave that throws does not keep the leave from beginning (#1970)', async () => {
    const ran: string[] = []
    const t = shutdown(
      () => [{ name: 'terminals', run: () => void ran.push('terminals') }],
      () => {
        throw new Error('no notice')
      },
    )
    await t.s.leave()
    expect({ ran, leaving: t.s.leaving, exits: t.exits }).toEqual({ ran: ['terminals'], leaving: true, exits: [0] })
  })

  it('a second ending changes nothing: the services stop once and the process exits once', async () => {
    let planned = 0
    const t = shutdown(() => (planned++, [{ name: 'server', run: async () => {} }]))
    const first = t.s.leave()
    const second = t.s.leave()
    await Promise.all([first, second])
    expect(planned).toBe(1)
    expect(t.exits).toEqual([0])
    expect(t.s.leaving).toBe(true)
  })

  it('ends with its log line and exit 0 even when a step failed', async () => {
    const t = shutdown(() => [{ name: 'sessions', run: () => Promise.reject(new Error('codex would not stop')) }])
    await t.s.leave()
    expect(t.logged.join('\n')).toContain('codex would not stop')
    expect(t.logged.at(-1)).toBe('[agent-host] shutting down (pid 42, stopped)')
    expect(t.logStopped()).toBe(1)
    expect(t.exits).toEqual([0])
  })

  it('a step that never settles does not hold the process: past the bound it says so and exits 1', async () => {
    const t = shutdown(() => [{ name: 'a peer that never answers', run: () => new Promise(() => {}) }])
    void t.s.leave()
    await new Promise((r) => setTimeout(r, 0))
    expect(t.exits).toEqual([])
    t.fireBound()
    expect(t.exits).toEqual([1])
    expect(t.logged.at(-1)).toMatch(/shutting down now \(pid 42\): did not finish within/)
    expect(t.logStopped()).toBe(1)
  })

  it('a bound that fires after a clean exit changes nothing', async () => {
    const t = shutdown(() => [])
    await t.s.leave()
    t.fireBound()
    expect(t.exits).toEqual([0])
  })
})
