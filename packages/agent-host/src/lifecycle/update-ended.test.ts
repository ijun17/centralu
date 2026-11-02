import { describe, expect, it, vi } from 'vitest'
import { CommandRunner } from '../dev-services/commands.js'
import { TerminalService } from '../dev-services/terminal.js'
import { memoryUpdateFolder } from './update-resume.test-helpers.js'
import { recordUpdateEnded, UpdateResumeLists } from './update-resume.js'
import { readEnded, restartEnded, RUN_RESTARTED_LINE, type EndedRun, type EndedTerminal } from './update-ended.js'

/** A pty that is only what the services read: it keeps what was written to it and lets a test say what the shell printed */
function fakePty() {
  const ptys: { written: string[]; print: (d: string) => void; end: (code: number) => void }[] = []
  const mod = {
    spawn() {
      let onData = (_d: string) => {}
      let onExit = (_e: { exitCode: number }) => {}
      const written: string[] = []
      ptys.push({ written, print: (d) => onData(d), end: (code) => onExit({ exitCode: code }) })
      return { write: (d: string) => written.push(d), resize: () => {}, kill: () => {}, onData: (cb: (d: string) => void) => (onData = cb), onExit: (cb: (e: { exitCode: number }) => void) => (onExit = cb) }
    },
  }
  return { mod, ptys }
}
const terminalsOn = (mod: unknown) => {
  const svc = new TerminalService(() => {})
  ;(svc as unknown as { loadPty: () => unknown }).loadPty = () => mod
  return svc
}
const runnerOn = (mod: unknown) => {
  const svc = new CommandRunner(() => {})
  ;(svc as unknown as { loadPty: () => unknown }).loadPty = () => mod
  return svc
}
const projectOf = (cwd: string) => (cwd === '/work/app' ? 'p1' : null)

describe('what an update ends in the terminals and Run commands (#1902)', () => {
  it('records each open terminal by place and size, in the order opened, and nothing of what it showed or was typed into it', () => {
    const fake = fakePty()
    const svc = terminalsOn(fake.mod)
    const a = svc.create('/work/app', 100, 30)
    svc.create('/elsewhere', 80, 24)
    svc.create('/work/app', 80, 24)
    fake.ptys[0]!.print('secret output\r\n')
    svc.input(a.id, 'echo typed\r')
    expect(svc.snapshot(projectOf)).toEqual([
      { projectId: 'p1', cwd: '/work/app', cols: 100, rows: 30 },
      { projectId: null, cwd: '/elsewhere', cols: 80, rows: 24 },
      { projectId: 'p1', cwd: '/work/app', cols: 80, rows: 24 },
    ])
  })

  it('records the Run commands that are running, not the ones that ended', () => {
    const fake = fakePty()
    const svc = runnerOn(fake.mod)
    svc.run('/work/app', 'pnpm dev')
    svc.run('/work/app', 'pnpm build')
    fake.ptys[1]!.end(0)
    expect(svc.runningSnapshot(projectOf)).toEqual([{ projectId: 'p1', cwd: '/work/app', command: 'pnpm dev' }])
  })

  it('starts a Run command again with a first line in its log that says why', () => {
    const fake = fakePty()
    const svc = runnerOn(fake.mod)
    svc.run('/work/app', 'pnpm dev', 100, 30, 'AGAIN\r\n')
    fake.ptys[0]!.print('ready\r\n')
    expect(svc.log('/work/app', 'pnpm dev')?.history).toBe('AGAIN\r\nready\r\n')
    // Without a line (every other run) the log is the process's output alone
    svc.run('/work/app', 'pnpm test')
    fake.ptys[1]!.print('ok\r\n')
    expect(svc.log('/work/app', 'pnpm test')?.history).toBe('ok\r\n')
  })

  it('is listed in a list of its own, taken whole once by the first start after it, and the list goes', () => {
    const f = memoryUpdateFolder()
    const t: EndedTerminal = { projectId: 'p1', cwd: '/work/app', cols: 80, rows: 24 }
    const r: EndedRun = { projectId: 'p1', cwd: '/work/app', command: 'pnpm dev' }
    recordUpdateEnded(f, { terminals: [t], runs: [r] })
    expect(f.files.size).toBe(1)
    const lists = new UpdateResumeLists(f)
    expect([...lists.ids()]).toEqual([])
    expect(lists.takeEnded()).toEqual({ terminals: [t], runs: [r] })
    expect(f.files.size).toBe(0)
    expect(lists.takeEnded()).toEqual({ terminals: [], runs: [] })
    // Nothing to list: no file
    recordUpdateEnded(f, { terminals: [], runs: [] })
    expect(f.files.size).toBe(0)
  })

  it('reads only entries it can read whole, with a size when the list has none', () => {
    const ended = readEnded({ terminals: [{ cwd: '/a' }, { cwd: '/b', cols: 120, rows: 40, projectId: 'p' }, { cols: 5 }, 4], runs: [{ cwd: '/a', command: 'c' }, { cwd: '/a' }] })
    expect(ended.terminals).toEqual([
      { projectId: null, cwd: '/a', cols: 80, rows: 24 },
      { projectId: 'p', cwd: '/b', cols: 120, rows: 40 },
    ])
    expect(ended.runs).toEqual([{ projectId: null, cwd: '/a', command: 'c' }])
    expect(readEnded('nope')).toEqual({ terminals: [], runs: [] })
  })

  it('brings each back after the update: a terminal for a folder that is still a project, a command started again; one whose project is gone is skipped, one that fails does not stop the rest', () => {
    const log = vi.fn()
    const opened: string[] = []
    const started: string[] = []
    restartEnded(
      {
        terminals: [
          { projectId: 'p1', cwd: '/work/app', cols: 100, rows: 30 },
          { projectId: 'gone', cwd: '/gone', cols: 80, rows: 24 },
          { projectId: 'p1', cwd: '/work/app', cols: 1, rows: 1 },
          { projectId: 'p1', cwd: '/work/app', cols: 90, rows: 20 },
        ],
        runs: [
          { projectId: 'p1', cwd: '/work/app', command: 'pnpm dev' },
          { projectId: 'gone', cwd: '/gone', command: 'pnpm dev' },
        ],
      },
      {
        cwdOf: (projectId, cwd) => (projectId === 'p1' ? cwd : null),
        terminals: {
          create: (cwd, cols, rows) => {
            if (cols === 1) throw new Error('no shell')
            opened.push(`${cwd}|${cols}x${rows}`)
          },
        },
        runs: { run: (cwd, command, _c, _r, before) => void started.push(`${cwd}|${command}|${before}`) },
        log,
      },
    )
    expect(opened).toEqual(['/work/app|100x30', '/work/app|90x20'])
    expect(started).toEqual([`/work/app|pnpm dev|${RUN_RESTARTED_LINE}\r\n`])
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('terminal an update ended is not reopened'),
      expect.stringContaining('could not be reopened: no shell'),
      expect.stringContaining('command an update ended is not started again'),
    ])
  })

  it('reopens a terminal as a fresh shell: its screen is empty until the new shell prints, and nothing is typed into it', () => {
    const fake = fakePty()
    const svc = terminalsOn(fake.mod)
    restartEnded({ terminals: [{ projectId: 'p1', cwd: '/work/app', cols: 100, rows: 30 }], runs: [] }, { cwdOf: (_p, cwd) => cwd, terminals: svc, runs: runnerOn(fake.mod), log: () => {} })
    expect(fake.ptys).toHaveLength(1)
    expect(fake.ptys[0]!.written).toEqual([])
    expect(svc.list('/work/app').map((t) => t.title)).toEqual(['Terminal 1'])
    expect(svc.list('/work/app')[0]!.history()).toBe('')
    fake.ptys[0]!.print('PS> ')
    expect(svc.list('/work/app')[0]!.history()).toBe('PS> ')
  })
})
