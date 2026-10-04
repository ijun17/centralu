import { describe, expect, it, vi } from 'vitest'
import { TerminalService, type Pty } from './terminal.js'
import { CommandRunner } from './commands.js'

/**
 * Terminals and command runs the keeper holds (#280 step 2): a new host takes them over under the
 * same ids, and a host that leaves for a restart lets go of them without killing anything.
 */

function keptPty(pid: number) {
  let onData = (_d: string) => {}
  let onExit = (_e: { exitCode: number }) => {}
  const pty = {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    detach: vi.fn(async () => {}),
    onData: (cb: (d: string) => void) => (onData = cb),
    onExit: (cb: (e: { exitCode: number }) => void) => (onExit = cb),
  }
  return { pty: pty as Pty & typeof pty, data: (d: string) => onData(d), exit: (c: number) => onExit({ exitCode: c }) }
}

function spawningModule() {
  const tags: unknown[] = []
  return {
    tags,
    mod: {
      spawn(_f: string, _a: string[], opts: Record<string, unknown>) {
        tags.push(opts.tag)
        return keptPty(1).pty
      },
    },
  }
}

describe('terminals taken over from the keeper', () => {
  it('keep their ids and replayed screen, and new ones never reuse a kept id', () => {
    const frames: { terminalId: string; data?: string }[] = []
    const { mod, tags } = spawningModule()
    const svc = new TerminalService((f) => frames.push(f), mod)
    const a = keptPty(41)
    const b = keptPty(42)
    svc.adopt([
      { id: 'term-7', cwd: '/p', pty: b.pty, cols: 80, rows: 24 },
      { id: 'term-3', cwd: '/p', pty: a.pty, cols: 80, rows: 24 },
    ])
    a.data('$ npm run dev\r\nready on 5173\r\n')
    const list = svc.list('/p')
    expect(list.map((t) => [t.id, t.title])).toEqual([
      ['term-3', 'Terminal 1'],
      ['term-7', 'Terminal 2'],
    ])
    expect(list[0]!.history()).toContain('ready on 5173')
    expect(frames.at(-1)).toMatchObject({ terminalId: 'term-3' })
    const fresh = svc.create('/p', 80, 24)
    expect(fresh.id).toBe('term-8')
    // The spawn carries what the next host needs to take this one over
    expect(tags).toEqual([{ kind: 'terminal', id: 'term-8', cwd: '/p' }])
    svc.resize('term-3', 100, 30)
    expect(a.pty.resize).toHaveBeenCalledWith(100, 30)
  })

  it('a host leaving for a restart detaches them and kills nothing', async () => {
    const svc = new TerminalService(() => {}, spawningModule().mod)
    const a = keptPty(41)
    svc.adopt([{ id: 'term-1', cwd: '/p', pty: a.pty, cols: 80, rows: 24 }])
    await svc.detachAll()
    expect(a.pty.detach).toHaveBeenCalled()
    expect(a.pty.kill).not.toHaveBeenCalled()
    expect(svc.liveCount()).toBe(0)
  })
})

describe('command runs taken over from the keeper', () => {
  it('a dev server still running comes back under its run id; one that ended keeps its exit code', () => {
    const frames: { terminalId: string; exitCode?: number | null }[] = []
    const { mod, tags } = spawningModule()
    const runner = new CommandRunner((f) => frames.push(f), mod)
    const dev = keptPty(51)
    const build = keptPty(52)
    runner.adopt([
      { cwd: '/p', command: 'pnpm dev', runId: 'run-4', startedAt: 10, pty: dev.pty },
      { cwd: '/p', command: 'pnpm build', runId: 'run-5', startedAt: 20, pty: build.pty },
    ])
    build.data('built\r\n')
    build.exit(1)
    expect(runner.state('/p')).toEqual(
      expect.arrayContaining([
        { command: 'pnpm dev', runId: 'run-4', running: true, exitCode: null, startedAt: 10 },
        { command: 'pnpm build', runId: 'run-5', running: false, exitCode: 1, startedAt: 20 },
      ]),
    )
    expect(runner.log('/p', 'pnpm build')!.history).toBe('built\r\n')
    expect(runner.liveCount()).toBe(1)
    const next = runner.run('/p', 'pnpm test')
    expect(next.runId).toBe('run-6')
    expect(tags.at(-1)).toMatchObject({ kind: 'command', cwd: '/p', command: 'pnpm test', runId: 'run-6' })
  })

  it('a host leaving for a restart detaches them and kills nothing', async () => {
    const runner = new CommandRunner(() => {}, spawningModule().mod)
    const dev = keptPty(51)
    runner.adopt([{ cwd: '/p', command: 'pnpm dev', runId: 'run-1', startedAt: 1, pty: dev.pty }])
    await runner.detachAll()
    expect(dev.pty.detach).toHaveBeenCalled()
    expect(dev.pty.kill).not.toHaveBeenCalled()
  })
})
