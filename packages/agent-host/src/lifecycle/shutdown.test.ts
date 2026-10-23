/**
 * The host's shutdown as data (docs/runtime-lessons.md HO8, HO15, #396): the order its steps run
 * in, that every one runs, and that leaving happens once.
 */
import { describe, expect, it } from 'vitest'
import { both, runSteps, type Step } from './steps.js'
import { Shutdown, signalMode, stopPlan, type HostParts } from './shutdown.js'

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
    terminals: { disposeAll: rec('terminals end'), detachAll: async () => void did.push('terminals detach') },
    commands: { disposeAll: rec('commands end'), detachAll: async () => void did.push('commands detach') },
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
      detachAll: () => (did.push('sessions detach'), sessionsDone),
    },
    appChanges: { dispose: rec('app changes') },
    themes: { close: rec('themes') },
    inlineViews: { dispose: rec('inline views') },
    views: { dispose: async () => void did.push('views') },
    server: { close: async () => void did.push('server') },
    store: { close: rec('store') },
    children: { close: rec('children') },
  }
  return { did, p, releaseSessions, never }
}

describe('the stop plan (HO8)', () => {
  it('in stop mode terminals and commands end before anything is awaited, even when the links never stop', () => {
    const f = parts()
    f.p.links = { stop: () => (f.did.push('links'), f.never) }
    void runSteps(stopPlan('stop', false, f.p), () => {})
    expect(f.did.slice(0, 2)).toEqual(['terminals end', 'commands end'])
  })

  it('app processes stop while the sessions are still cleaning up, not after', async () => {
    const f = parts()
    const run = runSteps(stopPlan('stop', false, f.p), () => {})
    await new Promise((r) => setTimeout(r, 0))
    expect(f.did).toContain('sessions end')
    expect(f.did).toContain('apps')
    expect(f.did).not.toContain('server')
    f.releaseSessions()
    await run
  })

  it('the server closes after every service, then the store, then the keeper connection', async () => {
    const f = parts()
    f.releaseSessions()
    await runSteps(stopPlan('stop', false, f.p), () => {})
    expect(f.did.slice(-3)).toEqual(['server', 'store', 'children'])
    expect(f.did.indexOf('views')).toBeLessThan(f.did.indexOf('server'))
    expect(f.did.indexOf('sessions end')).toBeLessThan(f.did.indexOf('server'))
  })

  it('a service that fails to stop does not keep the server, the store or the keeper connection open', async () => {
    const f = parts()
    f.releaseSessions()
    f.p.views = { dispose: () => Promise.reject(new Error('a view would not close')) }
    await expect(runSteps(stopPlan('stop', false, f.p), () => {})).rejects.toThrow('a view would not close')
    expect(f.did.slice(-3)).toEqual(['server', 'store', 'children'])
  })

  it('compacting idle sessions stops before the sessions are let go of too, so a sweep cannot send a compact to a process the next host takes over (#1451)', async () => {
    for (const mode of ['detach', 'stop'] as const) {
      const f = parts()
      f.releaseSessions()
      await runSteps(stopPlan(mode, false, f.p), () => {})
      expect(f.did).toContain('compaction')
      expect(f.did.indexOf('compaction')).toBeLessThan(f.did.indexOf(mode === 'detach' ? 'sessions detach' : 'sessions end'))
    }
  })

  it('putting idle sessions to sleep stops before the sessions are let go of, so a sweep cannot end a process the next host takes over (#568)', async () => {
    for (const mode of ['detach', 'stop'] as const) {
      const f = parts()
      f.releaseSessions()
      await runSteps(stopPlan(mode, false, f.p), () => {})
      expect(f.did).toContain('sleeper')
      expect(f.did.indexOf('sleeper')).toBeLessThan(f.did.indexOf(mode === 'detach' ? 'sessions detach' : 'sessions end'))
    }
  })

  it('the mailbox’s delivery stops before the sessions are let go of, so a host that is leaving wakes no session the next one takes over (#1347)', async () => {
    for (const mode of ['detach', 'stop'] as const) {
      const f = parts()
      f.releaseSessions()
      await runSteps(stopPlan(mode, false, f.p), () => {})
      expect(f.did).toContain('mail delivery')
      expect(f.did.indexOf('mail delivery')).toBeLessThan(f.did.indexOf(mode === 'detach' ? 'sessions detach' : 'sessions end'))
    }
  })

  it('a planned ending hands the open views over first, before anything closes them', async () => {
    const f = parts()
    f.releaseSessions()
    await runSteps(stopPlan('detach', true, f.p), () => {})
    expect(f.did[0]).toBe('hand over views')
  })
})

describe('detach or stop (HO15)', () => {
  it('a signal detaches only when the keeper holds the children', () => {
    expect(signalMode(true)).toBe('detach')
    expect(signalMode(false)).toBe('stop')
  })

  it('a detach lets go of terminals, commands and sessions, but still ends the ssh links and app processes', async () => {
    const f = parts()
    f.releaseSessions()
    await runSteps(stopPlan('detach', false, f.p), () => {})
    expect(f.did).toEqual(expect.arrayContaining(['terminals detach', 'commands detach', 'sessions detach', 'links', 'apps']))
    expect(f.did).not.toContain('terminals end')
    expect(f.did).not.toContain('commands end')
    expect(f.did).not.toContain('sessions end')
  })

  // #982: git runs in a group of its own, out of reach of the keeper's stop and of a Ctrl+C; nothing else ends it
  it.each(['stop', 'detach'] as const)('ends the git calls still running (%s), before the sessions are let go of', async (mode) => {
    const f = parts()
    f.releaseSessions()
    await runSteps(stopPlan(mode, false, f.p), () => {})
    expect(f.did).toContain('git')
    expect(f.did.indexOf('git')).toBeLessThan(f.did.indexOf(mode === 'stop' ? 'sessions end' : 'sessions detach'))
  })
})

describe('leaving, once (HO8)', () => {
  function shutdown(plan: (mode: string) => Step[]) {
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
    })
    return { s, logged, exits, logStopped: () => logStopped, fireBound: () => timers.forEach((f) => f()) }
  }

  it('a second ending changes nothing: the services stop once and the process exits once', async () => {
    let planned = 0
    const t = shutdown(() => (planned++, [{ name: 'server', run: async () => {} }]))
    const first = t.s.leave('detach', true)
    const second = t.s.leave('stop', false)
    await Promise.all([first, second])
    expect(planned).toBe(1)
    expect(t.exits).toEqual([0])
    expect(t.s.leaving).toBe('detach')
  })

  it('ends with its log line and exit 0 even when a step failed', async () => {
    const t = shutdown(() => [{ name: 'sessions', run: () => Promise.reject(new Error('codex would not stop')) }])
    await t.s.leave('stop', false)
    expect(t.logged.join('\n')).toContain('codex would not stop')
    expect(t.logged.at(-1)).toBe('[agent-host] shutting down (pid 42, stopped)')
    expect(t.logStopped()).toBe(1)
    expect(t.exits).toEqual([0])
  })

  it('a signal during a drain runs no second ending: the drain exits on its own', async () => {
    let planned = 0
    const t = shutdown(() => (planned++, []))
    await t.s.stopServices('detach', true)
    await t.s.leave('stop', false)
    expect(planned).toBe(1)
    expect(t.exits).toEqual([])
  })

  it('a step that never settles does not hold the process: past the bound it says so and exits 1', async () => {
    const t = shutdown(() => [{ name: 'a peer that never answers', run: () => new Promise(() => {}) }])
    void t.s.leave('stop', false)
    await new Promise((r) => setTimeout(r, 0))
    expect(t.exits).toEqual([])
    t.fireBound()
    expect(t.exits).toEqual([1])
    expect(t.logged.at(-1)).toMatch(/shutting down now \(pid 42\): did not finish within/)
    expect(t.logStopped()).toBe(1)
  })

  it('a bound that fires after a clean exit changes nothing', async () => {
    const t = shutdown(() => [])
    await t.s.leave('stop', false)
    t.fireBound()
    expect(t.exits).toEqual([0])
  })
})
