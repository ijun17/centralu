import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { TerminalService, commandShell, interactiveShell, shellPath, shortCwd } from './terminal.js'

/**
 * The terminal has one core rule: **its identity is its cwd.**
 *
 * So switching sessions within the same project keeps the same terminal going, and a git
 * worktree session (a different cwd) automatically gets its own terminal. This checks that rule,
 * plus how it behaves when a shell dies or fails to launch.
 */

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'cc-term-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Checks only the rules, without launching a real shell — what is under test is the grouping logic, not the shell */
function fakePty() {
  const spawned: { cwd: string; cols: number; rows: number }[] = []
  const instances: {
    write: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
    emitData: (d: string) => void
    emitExit: (code: number) => void
  }[] = []
  const mod = {
    spawn(_file: string, _args: string[], opts: Record<string, unknown>) {
      spawned.push({ cwd: opts.cwd as string, cols: opts.cols as number, rows: opts.rows as number })
      let onData = (_d: string) => {}
      let onExit = (_e: { exitCode: number }) => {}
      const inst = {
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
  return { mod, spawned, instances }
}

describe('a terminal is grouped by cwd', () => {
  it('the list belongs to the directory — it stays the same across a session switch', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const cwd = tmp()
    const a = svc.create(cwd, 80, 24)
    // Querying again after switching sessions still returns the same terminal (nothing new is launched)
    expect(svc.list(cwd).map((t) => t.id)).toEqual([a.id])
    expect(fake.spawned).toHaveLength(1)
  })

  it('a different directory means a different list (groundwork for git worktree sessions)', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const one = tmp()
    const two = tmp()
    svc.create(one, 80, 24)
    svc.create(two, 80, 24)

    expect(svc.list(one)).toHaveLength(1)
    expect(svc.list(two)).toHaveLength(1)
    expect(svc.list(one)[0]!.id).not.toBe(svc.list(two)[0]!.id)
  })

  it('querying again returns the output so far (an empty screen is not a real terminal)', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const cwd = tmp()
    svc.create(cwd, 80, 24)
    fake.instances[0]!.emitData('$ pnpm test\r\n254 passed\r\n')

    expect(svc.list(cwd)[0]!.history()).toContain('254 passed')
  })

  it('matches the size of whoever attaches', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const h = svc.create(tmp(), 80, 24)
    svc.resize(h.id, 120, 40)
    expect(fake.instances[0]!.resize).toHaveBeenCalledWith(120, 40)
  })
})

describe('multiple terminals', () => {
  it('opens several in one directory and names them in order', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const cwd = tmp()
    svc.create(cwd, 80, 24)
    svc.create(cwd, 80, 24)
    svc.create(cwd, 80, 24)

    expect(svc.list(cwd).map((t) => t.title)).toEqual(['Terminal 1', 'Terminal 2', 'Terminal 3'])
    expect(fake.spawned).toHaveLength(3)
  })

  it('closing one kills its shell and renumbers the rest', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const cwd = tmp()
    svc.create(cwd, 80, 24)
    const second = svc.create(cwd, 80, 24)
    svc.create(cwd, 80, 24)

    svc.close(second.id)

    expect(fake.instances[1]!.kill).toHaveBeenCalled()
    // Deleting number 2 and leaving 1 and 3 would confuse anyone counting
    expect(svc.list(cwd).map((t) => t.title)).toEqual(['Terminal 1', 'Terminal 2'])
    expect(svc.list(cwd).map((t) => t.id)).not.toContain(second.id)
  })

  it('closing the last one leaves the list empty', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const cwd = tmp()
    const only = svc.create(cwd, 80, 24)
    svc.close(only.id)
    expect(svc.list(cwd)).toEqual([])
  })
})

describe('when a shell ends or fails to launch', () => {
  it('reports the exit and can relaunch with the history kept', () => {
    const fake = fakePty()
    const seen: { terminalId: string; exitCode?: number | null }[] = []
    const svc = new TerminalService((e) => seen.push(e))
    stubPty(svc, fake.mod)

    const cwd = tmp()
    const h = svc.create(cwd, 80, 24)
    fake.instances[0]!.emitData('traces of earlier work\r\n')
    fake.instances[0]!.emitExit(0)

    expect(seen.some((e) => e.exitCode === 0)).toBe(true)

    const again = svc.restart(h.id, 80, 24)!
    expect(again.alive).toBe(true)
    // The history is the clue to what led to this — it is never erased
    expect(again.history()).toContain('traces of earlier work')
    expect(fake.spawned).toHaveLength(2)
  })

  /*
   * The bug where restart was effectively a button that killed the terminal forever.
   * The killed old shell's onExit arrives late, **after** the new shell has already taken the
   * slot, and that callback unconditionally cleared the pty, marking the just-launched new shell
   * as dead.
   */
  it('a late exit from the old shell does not overwrite the new shell', () => {
    const fake = fakePty()
    const seen: { terminalId: string; data?: string; exitCode?: number | null }[] = []
    const svc = new TerminalService((e) => seen.push(e))
    stubPty(svc, fake.mod)

    const cwd = tmp()
    const h = svc.create(cwd, 80, 24)
    svc.restart(h.id, 80, 24)
    expect(fake.instances[0]!.kill).toHaveBeenCalled()

    // The onExit resulting from the kill only arrives now
    fake.instances[0]!.emitExit(0)

    // The new shell has to stay alive, and no broadcast claiming it died is allowed either
    expect(svc.list(cwd)[0]!.alive).toBe(true)
    expect(seen.some((e) => e.exitCode !== undefined)).toBe(false)

    // The old shell's last-gasp output does not mix into the new screen either
    fake.instances[0]!.emitData('dying words')
    expect(svc.list(cwd)[0]!.history()).not.toContain('dying words')

    // The genuine new shell's exit is still delivered as-is
    fake.instances[1]!.emitExit(1)
    expect(svc.list(cwd)[0]!.alive).toBe(false)
    expect(seen.some((e) => e.exitCode === 1)).toBe(true)
  })

  it('never fails silently when the shell cannot launch, and leaves the reason on screen', () => {
    const seen: { terminalId: string; data?: string }[] = []
    const svc = new TerminalService((e) => seen.push(e))
    stubPty(svc, {
      spawn() {
        throw new Error('posix_spawnp failed')
      },
    })

    const h = svc.create(tmp(), 80, 24)
    expect(h.alive).toBe(false)
    expect(h.history()).toContain('posix_spawnp failed')
    expect(seen.some((e) => e.data?.includes('posix_spawnp failed'))).toBe(true)
  })
})

describe('shell selection', () => {
  it.skipIf(process.platform === 'win32')('picks the shell the user actually uses (so their aliases and prompt show up as-is)', () => {
    expect(shellPath()).toMatch(/\/(zsh|bash|sh|fish)$/)
  })

  it('a terminal tab runs the login shell with -l off Windows', () => {
    expect(interactiveShell('darwin')).toEqual({ file: shellPath(), args: ['-l'] })
  })

  /*
   * Windows (#14), simulated. Windows PowerShell 5.1 has no `-l`: it read it as the start of
   * `-Command`, failed and exited, so the tab died and the Run button never ran anything.
   */
  it('on Windows a tab runs PowerShell 7 when it is installed, with no -l', () => {
    const shell = interactiveShell('win32', {}, (name) => (name === 'pwsh' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null))
    expect(shell).toEqual({ file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'] })
  })

  it('on Windows without PowerShell 7, the Windows PowerShell under the system folder', () => {
    const shell = interactiveShell('win32', { SystemRoot: 'C:\\Windows' }, () => null)
    expect(shell).toEqual({ file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo'] })
    expect(shell.args).not.toContain('-l')
  })

  it('a project command runs under the login shell off Windows, and cmd.exe on Windows', () => {
    expect(commandShell('npm run dev', 'linux')).toEqual({ file: shellPath(), args: ['-lc', 'npm run dev'] })
    expect(commandShell('npm run dev -- --port 3000', 'win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' })).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      // One string: node-pty passes it verbatim, so the command is not re-quoted on its way to cmd
      args: '/d /s /c "npm run dev -- --port 3000"',
    })
  })

  it('shortens the home path to ~', () => {
    // homedir(), not $HOME: Windows has no HOME (#14)
    expect(shortCwd(join(homedir(), 'work'))).toBe(`~${sep}work`)
    expect(shortCwd('/opt/x')).toBe('/opt/x')
  })
})

/**
 * Substitutes a fake node-pty.
 * Launching a real shell would leave a test at the mercy of the environment (shell
 * configuration, login scripts) — real PTY behavior is checked separately in an L3 smoke test.
 */
function stubPty(svc: TerminalService, mod: unknown): void {
  ;(svc as unknown as { loadPty: () => unknown }).loadPty = () => mod
}

/**
 * Opening a terminal has to be noticeably fast.
 *
 * This used to call ensureToolPath() on every create(), launching a whole login shell, which cost
 * 1 to 4 seconds to open a single terminal (measured on the test runner). To the user, clicking
 * "+ add" would look like nothing happened for a long while.
 * A test that measures time is fragile, so the budget here is set generously, catching only a
 * regression on the scale of "relaunching a shell" (one shell probe takes about 1 second; the
 * budget here is 1.5 seconds for three).
 */
describe('open speed', () => {
  it('opening several in a row does not repeat the shell probe', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)
    const cwd = tmp()

    const started = process.hrtime.bigint()
    svc.create(cwd, 80, 24)
    svc.create(cwd, 80, 24)
    svc.create(cwd, 80, 24)
    const ms = Number(process.hrtime.bigint() - started) / 1e6

    expect(fake.spawned).toHaveLength(3)
    expect(ms).toBeLessThan(1500)
  })
})
