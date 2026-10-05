import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KeeperAgentProcess } from './agent-process.js'
import { KeeperChildren } from './children-client.js'
import { KeeperPty } from './keeper-pty.js'
import { FakeKeeper } from './fake-keeper.test-helpers.js'

/**
 * The host's side of the keeper's child service (#280 step 2): a process the keeper holds behaves
 * like a child of this host for the adapters, except that leaving never ends it.
 */

let keeper: FakeKeeper
let children: KeeperChildren

/*
 * The keeper is macOS and Linux only: on Windows the host runs on the direct path and nothing connects to a keeper
 * (docs/agent-host.md). Its service is a unix-domain socket, which this fake cannot listen on there (EACCES) (#14).
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

  it('reports an exit when the keeper itself goes away, since the pipes went with it', async () => {
    const p = KeeperAgentProcess.spawn(children, echo, tag)
    await until(() => p.childId !== null)
    const exited = new Promise<[number | null, string | null]>((r) => p.once('exit', (c, s) => r([c, s])))
    await keeper.close()
    expect(await exited).toEqual([null, 'SIGHUP'])
  })
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

describe.skipIf(keeperless)('the keeper asking this host to stop', () => {
  it('arrives as a stop event on the control connection', async () => {
    const stopped = new Promise<void>((r) => children.once('stop', r))
    keeper.askStop()
    await stopped
  })
})
