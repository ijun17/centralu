import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { CommandRunner } from './commands.js'

/**
 * The contract for the frequently used command runner (#60):
 *   - one, the most recent run per command (running again kills the old one and starts fresh, replacing the log)
 *   - different commands run at the same time
 *   - once it ends, a log with an exit code is left (no distinction between one-shot and long-running)
 */

function fakePty() {
  const instances: {
    kill: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    emitData: (d: string) => void
    emitExit: (code: number) => void
  }[] = []
  const mod = {
    /** Giving a real pid brings the group-kill path to life — only ever do this in a test that has mocked process.kill */
    pid: undefined as number | undefined,
    spawn(_file: string, args: string[], _opts: Record<string, unknown>) {
      let onData = (_d: string) => {}
      let onExit = (_e: { exitCode: number }) => {}
      const inst = {
        pid: mod.pid,
        args,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        emitData: (d: string) => onData(d),
        emitExit: (code: number) => onExit({ exitCode: code }),
        onData: (cb: (d: string) => void) => (onData = cb),
        onExit: (cb: (e: { exitCode: number }) => void) => (onExit = cb),
      }
      instances.push(inst)
      return inst
    },
  }
  return { mod, instances }
}

function stub(svc: CommandRunner, mod: unknown): void {
  ;(svc as unknown as { loadPty: () => unknown }).loadPty = () => mod
}

describe('CommandRunner', () => {
  it('output accumulates in the log, and an exit code is left once it ends', () => {
    const fake = fakePty()
    const frames: unknown[] = []
    const svc = new CommandRunner((f) => frames.push(f))
    stub(svc, fake.mod)

    const r = svc.run('/tmp/p', 'pnpm test')
    fake.instances[0]!.emitData('0 errors\r\n')
    fake.instances[0]!.emitExit(0)

    const log = svc.log('/tmp/p', 'pnpm test')!
    expect(log.history).toBe('0 errors\r\n')
    expect(log.running).toBe(false)
    expect(log.exitCode).toBe(0)
    expect(frames).toContainEqual({ terminalId: r.runId, data: '0 errors\r\n' })
    expect(frames).toContainEqual({ terminalId: r.runId, exitCode: 0 })
  })

  it('rerunning kills the old one, starts fresh, and replaces the log — with a new runId too', () => {
    const fake = fakePty()
    const svc = new CommandRunner(() => {})
    stub(svc, fake.mod)

    const r1 = svc.run('/tmp/p', 'pnpm dev')
    fake.instances[0]!.emitData('old log')
    const r2 = svc.run('/tmp/p', 'pnpm dev')

    expect(fake.instances[0]!.kill).toHaveBeenCalled()
    expect(r2.runId).not.toBe(r1.runId)
    expect(svc.log('/tmp/p', 'pnpm dev')!.history).toBe('')
    // The dying old process's last output does not mix into the new log
    fake.instances[0]!.emitData('ghost output')
    expect(svc.log('/tmp/p', 'pnpm dev')!.history).toBe('')
  })

  it('different commands run at the same time — one process per command', () => {
    const fake = fakePty()
    const svc = new CommandRunner(() => {})
    stub(svc, fake.mod)

    svc.run('/tmp/p', 'pnpm dev')
    svc.run('/tmp/p', 'pnpm test')
    expect(fake.instances).toHaveLength(2)
    expect(fake.instances[0]!.kill).not.toHaveBeenCalled()

    const state = svc.state('/tmp/p')
    expect(state.map((s) => s.command).sort()).toEqual(['pnpm dev', 'pnpm test'])
    expect(state.every((s) => s.running)).toBe(true)
  })

  it('stop kills only the process — the log survives (an exit is a result too)', () => {
    const fake = fakePty()
    const svc = new CommandRunner(() => {})
    stub(svc, fake.mod)

    svc.run('/tmp/p', 'pnpm dev')
    fake.instances[0]!.emitData('server up\r\n')
    svc.stop('/tmp/p', 'pnpm dev')
    fake.instances[0]!.emitExit(130)

    const log = svc.log('/tmp/p', 'pnpm dev')!
    expect(log.running).toBe(false)
    expect(log.history).toBe('server up\r\n')
    expect(log.exitCode).toBe(130)
  })

  it('the log of a command that has never run is null — distinct from an empty log', () => {
    const svc = new CommandRunner(() => {})
    stub(svc, fakePty().mod)
    expect(svc.log('/tmp/p', 'pnpm build')).toBeNull()
  })

  it('the same command in a different directory is a separate entry (groundwork for worktrees — the same rule as a terminal)', () => {
    const fake = fakePty()
    const svc = new CommandRunner(() => {})
    stub(svc, fake.mod)
    svc.run('/tmp/a', 'pnpm dev')
    svc.run('/tmp/b', 'pnpm dev')
    expect(fake.instances).toHaveLength(2)
    expect(svc.state('/tmp/a')).toHaveLength(1)
  })
})

/**
 * The bug where Stop did not actually work (dogfooding, 2026-09-07): node-pty's kill() sends a
 * signal to only one pty child pid, but a command is launched via `zsh -lc`, so the real server was
 * a tree underneath it.
 * The contract: given a pid, SIGTERM goes to the process **group** (-pid); if it has not died
 * within the grace period, SIGKILL follows.
 */
describe('CommandRunner — tree kill', () => {
  /*
   * The pid has to be **genuinely alive.** killTree walks the tree with ps, and if ps was read but
   * that pid is missing from it, it is treated as "already dead" and nothing is fired at all (the
   * rule against hitting a recycled pid). A made-up pid would trip that rule and leave nothing here
   * to actually verify.
   *
   * Launched detached so it gets **its own process group** — if it stayed in our own group,
   * killTree would see it as "itself" and skip it.
   */
  const spawned: number[] = []
  const livePid = (): number => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    child.unref()
    spawned.push(child.pid!)
    return child.pid!
  }
  afterEach(() => {
    for (const pid of spawned.splice(0)) {
      try {
        process.kill(-pid, 'SIGKILL') // actually cleans it up (the process.kill mock has already been restored by this point)
      } catch {
        // already gone
      }
    }
  })

  it('stop sends SIGTERM to the process group, and SIGKILL if it is still alive after the grace period', () => {
    vi.useFakeTimers()
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const fake = fakePty()
      const pid = livePid()
      fake.mod.pid = pid
      const svc = new CommandRunner(() => {})
      stub(svc, fake.mod)

      svc.run('/tmp/p', 'pnpm dev')
      svc.stop('/tmp/p', 'pnpm dev')
      expect(killSpy).toHaveBeenCalledWith(-pid, 'SIGTERM')
      // this never fell back to a single-pid kill — the group is the target
      expect(fake.instances[0]!.kill).not.toHaveBeenCalled()

      vi.advanceTimersByTime(3000)
      expect(killSpy).toHaveBeenCalledWith(-pid, 'SIGKILL')
    } finally {
      killSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('no SIGKILL if it dies within the grace period — a polite exit is honored', () => {
    vi.useFakeTimers()
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const fake = fakePty()
      const pid = livePid()
      fake.mod.pid = pid
      const svc = new CommandRunner(() => {})
      stub(svc, fake.mod)

      svc.run('/tmp/p', 'pnpm dev')
      svc.stop('/tmp/p', 'pnpm dev')
      fake.instances[0]!.emitExit(143) // died after receiving SIGTERM
      vi.advanceTimersByTime(3000)
      expect(killSpy).not.toHaveBeenCalledWith(-pid, 'SIGKILL')
    } finally {
      killSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('an app shutdown (disposeAll) sends SIGKILL to the group immediately — there is no process to wait a grace period for', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const fake = fakePty()
      const pid = livePid()
      fake.mod.pid = pid
      const svc = new CommandRunner(() => {})
      stub(svc, fake.mod)

      svc.run('/tmp/p', 'pnpm dev')
      svc.disposeAll()
      expect(killSpy).toHaveBeenCalledWith(-pid, 'SIGKILL')
    } finally {
      killSpy.mockRestore()
    }
  })

  it('falls back to pty.kill as before when there is no pid (a fake pty, win32)', () => {
    const fake = fakePty()
    const svc = new CommandRunner(() => {})
    stub(svc, fake.mod)

    svc.run('/tmp/p', 'pnpm dev')
    svc.stop('/tmp/p', 'pnpm dev')
    expect(fake.instances[0]!.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
