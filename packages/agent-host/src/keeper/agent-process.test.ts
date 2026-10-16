import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KeeperAgentProcess } from './agent-process.js'
import { KeeperChildren } from './children-client.js'
import { KeeperPty } from './keeper-pty.js'
import { FakeKeeper } from './fake-keeper.test-helpers.js'
import { alive, fakeAgentCli, goneWithin, helperPid, killLeftovers } from '../adapters/fake-agent-cli.test-helpers.js'

/**
 * The host's side of the keeper's child service (#280 step 2): a process the keeper holds behaves
 * like a child of this host for the adapters, except that leaving never ends it.
 */

let keeper: FakeKeeper
let children: KeeperChildren

/*
 * The keeper is macOS and Linux only: on Windows the host runs on the direct path and nothing connects to a keeper
 * (docs/agent-host.md). Its service is a unix-domain socket, which this fake cannot listen on there (EACCES) (#14).
 * The direct path's agent processes are adapters/local-process.test.ts, which runs there.
 */
const keeperless = process.platform === 'win32'

beforeEach(async () => {
  keeper = await FakeKeeper.start()
  children = await KeeperChildren.connect(keeper.sock)
})

afterEach(async () => {
  children.close()
  await keeper.close()
})

const tag = { kind: 'agent', tool: 'claude', sessionId: 's1' } as const
const echo = { command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], env: process.env }

function readUntil(p: { stdout: NodeJS.ReadableStream }, needle: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let got = ''
    const t = setTimeout(() => reject(new Error(`never saw ${needle}: ${got}`)), 5000)
    p.stdout.on('data', (d: Buffer) => {
      got += d.toString()
      if (got.includes(needle)) {
        clearTimeout(t)
        resolve(got)
      }
    })
  })
}

async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(ok()).toBe(true)
}

describe.skipIf(keeperless)('an agent process the keeper holds', () => {
  it('carries stdin and stdout like a child of this host', async () => {
    const p = KeeperAgentProcess.spawn(children, echo, tag)
    p.stdin.write('{"hello":1}\n')
    expect(await readUntil(p, '{"hello":1}')).toContain('hello')
    expect(keeper.ops('spawn')[0]!.tag).toEqual(tag)
    expect(p.pid).toBeGreaterThan(0)
  })

  /** codex removes its thread lock on stdin EOF, not on a signal (#57) */
  it('ends stdin with a keeper close_stdin request, and reports the exit after the output', async () => {
    const p = KeeperAgentProcess.spawn(
      children,
      { command: process.execPath, args: ['-e', 'process.stdin.on("end", () => { console.log("bye"); process.exit(3) }); process.stdin.resume()'], env: process.env },
      tag,
    )
    let out = ''
    p.stdout.on('data', (d: Buffer) => (out += d))
    const exited = new Promise<[number | null, string | null]>((r) => p.once('exit', (code, sig) => r([code, sig])))
    await until(() => p.childId !== null)
    p.stdin.end()
    expect(await exited).toEqual([3, null])
    expect(out).toContain('bye')
    expect(keeper.ops('close_stdin')).toHaveLength(1)
    expect(keeper.ops('signal')).toHaveLength(0)
  })

  /**
   * The SDK kills its processes when its owner exits, and a closing query kills after a grace. Once
   * this host has let go, neither may reach the keeper: the next host owns the process now.
   */
  it('sends no signal and no EOF once detached, and the process keeps running', async () => {
    const p = KeeperAgentProcess.spawn(children, echo, tag)
    p.stdin.write('ping\n')
    await readUntil(p, 'ping')
    const id = p.childId!
    await p.detach()
    expect(p.kill('SIGTERM')).toBe(false)
    p.stdin.end()
    await new Promise((r) => setTimeout(r, 200))
    expect(keeper.ops('signal')).toHaveLength(0)
    expect(keeper.ops('close_stdin')).toHaveLength(0)
    expect(keeper.detaches).toContain(id)
    expect(keeper.alive(id)).toBe(true)
  })

  /** The detach's bound on the attach was never cleared: every detach kept the host's loop for 2 s more (#428) */
  it('leaves no timer running once a detach has finished', async () => {
    const p = KeeperAgentProcess.spawn(children, echo, tag)
    p.stdin.write('{"hello":1}\n')
    await readUntil(p, 'hello')
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    const before = timers()
    await p.detach()
    expect(timers()).toBeLessThanOrEqual(before)
  })

  it('forgets an exit once the child is released (#392)', async () => {
    const p = KeeperAgentProcess.spawn(children, echo, tag)
    await until(() => p.childId !== null)
    const id = p.childId!
    const exited = new Promise((r) => p.once('exit', r))
    p.kill('SIGTERM')
    await exited
    await until(() => keeper.ops('release').length === 1)
    await until(() => children.exitOf(id) === undefined)
  })

  it('a kill before detaching is a keeper signal request', async () => {
    const p = KeeperAgentProcess.spawn(children, echo, tag)
    await until(() => p.childId !== null)
    const exited = new Promise((r) => p.once('exit', r))
    expect(p.kill('SIGTERM')).toBe(true)
    await exited
    expect(keeper.ops('signal')[0]).toMatchObject({ id: p.childId, signal: 'SIGTERM' })
    expect(p.signalCode).toBe('SIGTERM')
  })

  it('a new host adopting it gets the output produced while nobody was attached', async () => {
    const id = keeper.spawnDirect(process.execPath, ['-e', 'console.log("said while alone"); process.stdin.pipe(process.stdout)'], tag)
    await new Promise((r) => setTimeout(r, 300))
    const p = KeeperAgentProcess.adopt(children, keeper.info(id) as never)
    expect(await readUntil(p, 'said while alone')).toContain('alone')
    p.stdin.write('after\n')
    await readUntil(p, 'after')
  })

  /** Claude's and Codex's crash reasons carry it; it was only kept for a child of this host (#428) */
  it('keeps the end of stderr for a failure message, what the keeper buffered before the attach included', async () => {
    const script = "const b = Buffer.from('실패: 한글\\n'); process.stderr.write(b.subarray(0, 4)); setTimeout(() => { process.stderr.write(b.subarray(4)); process.exit(1) }, 200)"
    const id = keeper.spawnDirect(process.execPath, ['-e', script], tag)
    await new Promise((r) => setTimeout(r, 100))
    const p = KeeperAgentProcess.adopt(children, keeper.info(id) as never)
    await new Promise((r) => p.once('exit', r))
    await until(() => p.stderrTail() === '실패: 한글\n')
  })

  /**
   * The keeper refuses to release a running child, so one whose streams did not attach ran on with nobody to read or
   * stop it, and the listeners stayed on the control connection (#428)
   */
  it('ends a child whose streams cannot be attached, and releases it once it has exited', async () => {
    keeper.refuseAttach = true
    const p = KeeperAgentProcess.spawn(children, echo, tag)
    const failed = new Promise<Error>((r) => p.once('error', r))
    expect((await failed).message).toMatch(/attach refused/)
    const id = p.childId!
    await until(() => !keeper.alive(id))
    expect(keeper.ops('signal')[0]).toMatchObject({ id, signal: 'SIGKILL', group: true })
    await until(() => keeper.ops('release').length === 1)
    expect(children.listenerCount('exit')).toBe(0)
    expect(children.listenerCount('lost')).toBe(0)
  })

  it('reports an exit when the keeper itself goes away, since the pipes went with it', async () => {
    const p = KeeperAgentProcess.spawn(children, echo, tag)
    await until(() => p.childId !== null)
    const exited = new Promise<[number | null, string | null]>((r) => p.once('exit', (c, s) => r([c, s])))
    await keeper.close()
    expect(await exited).toEqual([null, 'SIGHUP'])
  })
})

/**
 * An agent CLI's helpers (a language server, an MCP server, a shell) share the CLI's process group,
 * which the keeper made the CLI's own. Stopping the agent signals that group, so the helpers end
 * with it instead of being left running under launchd/init. The keeper also sweeps the group once
 * the CLI has exited (tested against the real keeper in `keeper/children/tests.rs`).
 */
describe.skipIf(keeperless)('stopping an agent the keeper holds', () => {
  const started: number[] = []
  afterEach(() => killLeftovers(started))

  it('ends the helper a CLI leaves behind when it dies of TERM', async () => {
    const p = KeeperAgentProcess.spawn(children, { ...fakeAgentCli(), env: process.env }, tag)
    const helper = await helperPid(p.stdout)
    started.push(helper)
    const exited = new Promise((r) => p.once('exit', r))
    p.kill('SIGTERM')
    await exited
    expect(await goneWithin(helper, 5000)).toBe(true)
    expect(keeper.ops('signal')[0]).toMatchObject({ signal: 'SIGTERM', group: true })
  }, 30_000)

  it('ends a helper that ignores TERM with the KILL that follows', async () => {
    const p = KeeperAgentProcess.spawn(children, { ...fakeAgentCli({ ignoreTerm: true }), env: process.env }, tag)
    const helper = await helperPid(p.stdout)
    started.push(helper)
    const exited = new Promise((r) => p.once('exit', r))
    // The SDK's close: TERM, and KILL once the grace is over
    p.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 300))
    expect(alive(helper)).toBe(true)
    p.kill('SIGKILL')
    await exited
    expect(await goneWithin(helper, 5000)).toBe(true)
  }, 30_000)
})

describe.skipIf(keeperless)('a pty the keeper holds', () => {
  it('delivers output and exit like node-pty, then releases the record', async () => {
    const pty = KeeperPty.spawn(children, process.execPath, ['-e', 'console.log("from the shell"); process.exit(2)'], {
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 24,
      tag: { kind: 'command', cwd: '/x', command: 'run', runId: 'run-1', startedAt: 1 },
    })
    let out = ''
    pty.onData((d) => (out += d))
    const exit = await new Promise<{ exitCode: number }>((r) => pty.onExit(r))
    expect(exit.exitCode).toBe(2)
    expect(out).toContain('from the shell')
    await until(() => keeper.ops('release').length === 1)
  })

  it('a pty whose stream cannot be attached says so on screen, and is ended before its record is released (#428)', async () => {
    keeper.refuseAttach = true
    const pty = KeeperPty.spawn(children, process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: process.cwd(), env: process.env, cols: 80, rows: 24, tag: { kind: 'terminal', id: 'term-9', cwd: '/x' } })
    let screen = ''
    pty.onData((d) => (screen += d))
    const exit = await new Promise((r) => pty.onExit(r))
    expect(exit).toEqual({ exitCode: 1 })
    expect(screen).toMatch(/Could not start: attach refused/)
    await until(() => keeper.ops('release').length === 1)
    expect(keeper.ops('signal')[0]).toMatchObject({ signal: 'SIGKILL', group: true })
    expect(keeper.alive(pty.childId!)).toBe(false)
  })

  it('detaching leaves the shell running and signals nothing', async () => {
    const pty = KeeperPty.spawn(children, process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 24,
      tag: { kind: 'terminal', id: 'term-1', cwd: '/x' },
    })
    await until(() => pty.childId !== null)
    await pty.detach()
    pty.kill()
    await new Promise((r) => setTimeout(r, 100))
    expect(keeper.ops('signal')).toHaveLength(0)
    expect(keeper.alive(pty.childId!)).toBe(true)
  })
})

/**
 * A child a previous host left in the keeper survived a swap or a restart; its attach can fail for a moment then (a
 * loaded machine, a keeper handoff holding the service still). Ending it at the first failure KILLed a terminal or a
 * dev server that used to stay adoptable (#428 review).
 */
describe.skipIf(keeperless)('a child taken over from a previous host whose attach fails', () => {
  const termTag = { kind: 'terminal', id: 'term-7', cwd: '/x' } as const
  const forever = ['-e', 'console.log("still here"); setInterval(() => {}, 1000)']

  it('is attached on a second try, and nothing is signalled', async () => {
    const id = keeper.spawnDirect(process.execPath, forever, termTag)
    await new Promise((r) => setTimeout(r, 200))
    keeper.refuseAttach = 1
    const pty = KeeperPty.adopt(children, keeper.info(id) as never)
    let screen = ''
    pty.onData((d) => (screen += d))
    await until(() => screen.includes('still here'))
    expect(keeper.ops('signal')).toEqual([])
    expect(keeper.alive(id)).toBe(true)
  })

  it('a terminal that still cannot be attached is left running in the keeper for the next host', async () => {
    const id = keeper.spawnDirect(process.execPath, forever, termTag)
    keeper.refuseAttach = true
    const pty = KeeperPty.adopt(children, keeper.info(id) as never)
    await new Promise((r) => pty.onExit(r))
    // Long enough for a signal request sent at the failure to have reached the keeper
    await new Promise((r) => setTimeout(r, 500))
    expect(keeper.ops('signal')).toEqual([])
    expect(keeper.ops('release')).toEqual([])
    expect(keeper.alive(id)).toBe(true)
  })

  it('an agent that still cannot be attached is ended, since its session starts a new CLI on the same thread', async () => {
    const id = keeper.spawnDirect(process.execPath, forever, tag)
    keeper.refuseAttach = true
    const p = KeeperAgentProcess.adopt(children, keeper.info(id) as never)
    await new Promise((r) => p.once('error', r))
    await until(() => !keeper.alive(id))
    expect(keeper.ops('signal')[0]).toMatchObject({ id, signal: 'SIGKILL', group: true })
    await until(() => keeper.ops('release').length === 1)
  })

  it('one that had already exited before this host connected is released, with no listener left behind', async () => {
    const id = keeper.spawnDirect(process.execPath, ['-e', 'process.exit(3)'], tag)
    await until(() => !keeper.alive(id))
    // A host that connects after the exit learns of it only from the list, never as an event
    const late = await KeeperChildren.connect(keeper.sock)
    try {
      keeper.refuseAttach = true
      const p = KeeperAgentProcess.adopt(late, keeper.info(id) as never)
      await new Promise((r) => p.once('error', r))
      await until(() => keeper.ops('release').length === 1)
      expect(late.listenerCount('exit')).toBe(0)
      expect(keeper.ops('signal')).toEqual([])
    } finally {
      late.close()
    }
  })
})

describe.skipIf(keeperless)('the keeper asking this host to stop', () => {
  it('arrives as a stop event on the control connection', async () => {
    const stopped = new Promise<void>((r) => children.once('stop', r))
    keeper.askStop()
    await stopped
  })
})
