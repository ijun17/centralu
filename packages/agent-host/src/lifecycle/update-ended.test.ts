import { describe, expect, it, vi } from 'vitest'
import { CommandRunner } from '../dev-services/commands.js'
import { TerminalService } from '../dev-services/terminal.js'
import { memoryOs } from '../os/memory.js'
import { memoryUpdateFolder } from './update-resume.test-helpers.js'
import { recordUpdateCut, recordUpdateEnded, UpdateResumeLists } from './update-resume.js'
import { ENDED_MAX_AGE_MS, readEnded, restartEnded, RUN_RESTARTED_LINE, type EndedRun, type EndedTerminal } from './update-ended.js'

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

/** An OS with some folders on its disk, as a project's are */
const diskWith = (...folders: string[]) => {
  const os = memoryOs({ as: 'posix' })
  for (const f of folders) os.files.mkdirSync(f, { recursive: true })
  return os
}

describe('what an update ends in the terminals and Run commands (#1902)', () => {
  it('records each open terminal by folder and size, in the order opened, and nothing of what it showed or was typed into it', () => {
    const fake = fakePty()
    const svc = terminalsOn(fake.mod)
    const a = svc.create('/work/app', 100, 30)
    svc.create('/elsewhere', 80, 24)
    svc.create('/work/app', 80, 24)
    fake.ptys[0]!.print('secret output\r\n')
    svc.input(a.id, 'echo typed\r')
    expect(svc.snapshot()).toEqual([
      { cwd: '/work/app', cols: 100, rows: 30 },
      { cwd: '/elsewhere', cols: 80, rows: 24 },
      { cwd: '/work/app', cols: 80, rows: 24 },
    ])
  })

  it('records the Run commands that are running, not the ones that ended', () => {
    const fake = fakePty()
    const svc = runnerOn(fake.mod)
    svc.run('/work/app', 'pnpm dev')
    svc.run('/work/app', 'pnpm build')
    fake.ptys[1]!.end(0)
    expect(svc.runningSnapshot()).toEqual([{ cwd: '/work/app', command: 'pnpm dev' }])
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

  it('reads only entries it can read whole, with a size when the list has none, and never cuts a command short', () => {
    const ended = readEnded({
      terminals: [{ cwd: '/a' }, { cwd: '/b', cols: 120, rows: 40 }, { cols: 5 }, 4],
      runs: [{ cwd: '/a', command: 'c' }, { cwd: '/a' }, { cwd: '/a', command: 'x'.repeat(5000) }],
    })
    expect(ended.terminals).toEqual([
      { cwd: '/a', cols: 80, rows: 24 },
      { cwd: '/b', cols: 120, rows: 40 },
    ])
    expect(ended.runs).toEqual([{ cwd: '/a', command: 'c' }])
    expect(readEnded('nope')).toEqual({ terminals: [], runs: [] })
  })
})

describe('the list of what an update ended (#1902)', () => {
  const t: EndedTerminal = { cwd: '/work/app', cols: 80, rows: 24 }
  const r: EndedRun = { cwd: '/work/app', command: 'pnpm dev' }
  const T0 = 1_000_000

  it('is a list of its own, taken whole once by the first start after it; the list goes before anything is brought back', () => {
    const f = memoryUpdateFolder()
    recordUpdateEnded(f, { terminals: [t], runs: [r] }, T0)
    expect(f.files.size).toBe(1)
    const lists = new UpdateResumeLists(f)
    expect([...lists.ids()]).toEqual([])
    const taken = lists.takeEnded(T0 + 1000)
    expect(taken).toEqual({ terminals: [t], runs: [r] })
    expect(f.files.size).toBe(0)
    expect(lists.takeEnded(T0 + 1000)).toEqual({ terminals: [], runs: [] })
    // Nothing to list: no file
    recordUpdateEnded(f, { terminals: [], runs: [] })
    expect(f.files.size).toBe(0)
  })

  it('is not used when it is older than the stop plus a few minutes, and goes: a host from before this never removes it', () => {
    const f = memoryUpdateFolder()
    recordUpdateEnded(f, { terminals: [t], runs: [r] }, T0)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const taken = new UpdateResumeLists(f).takeEnded(T0 + ENDED_MAX_AGE_MS + 1)
      expect(taken).toEqual({ terminals: [], runs: [] })
      expect(f.files.size).toBe(0)
      expect(error.mock.calls.map((c) => String(c[0])).some((l) => l.includes('too old'))).toBe(true)
    } finally {
      error.mockRestore()
    }
    // Just inside the bound it is used
    recordUpdateEnded(f, { terminals: [t], runs: [r] }, T0)
    expect(new UpdateResumeLists(f).takeEnded(T0 + ENDED_MAX_AGE_MS).terminals).toEqual([t])
  })

  it('is not used twice when it cannot be removed: nothing is brought back, and the log says so', () => {
    const f = memoryUpdateFolder()
    recordUpdateEnded(f, { terminals: [t], runs: [r] }, T0)
    const held = { ...f, names: f.names, read: f.read, add: f.add, turns: f.turns, ids: f.ids, files: f.files, remove: () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }) } }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(new UpdateResumeLists(held).takeEnded(T0 + 1000)).toEqual({ terminals: [], runs: [] })
      expect(f.files.size).toBe(1)
      const said = error.mock.calls.map((c) => String(c[0]))
      expect(said.some((l) => l.includes('could not be removed') && l.includes('a later start tries again'))).toBe(true)
      // The words that belong to a list of turns are not said about this one
      expect(said.some((l) => l.includes('the turns it names are over'))).toBe(false)
    } finally {
      error.mockRestore()
    }
  })

  it('leaves a list of sessions alone: its turns are dealt with by their own path', () => {
    const f = memoryUpdateFolder()
    recordUpdateCut(f, [{ id: 'a', seq: 2 }])
    recordUpdateEnded(f, { terminals: [t], runs: [] }, T0)
    const lists = new UpdateResumeLists(f)
    expect(lists.takeEnded(T0)).toEqual({ terminals: [t], runs: [] })
    expect(f.files.size).toBe(1)
    expect(lists.cut('a', 2)).toBe(true)
  })
})

describe('bringing back what an update ended (#1902)', () => {
  it('opens each terminal again and starts each command again, for a folder that is still a project and on the disk', () => {
    const dir = '/work/app'
    const opened: string[] = []
    const started: string[] = []
    restartEnded(
      { terminals: [{ cwd: dir, cols: 100, rows: 30 }, { cwd: dir, cols: 90, rows: 20 }], runs: [{ cwd: dir, command: 'pnpm dev' }] },
      {
        projectFolders: new Set([dir]),
        terminals: { create: (cwd, cols, rows) => void opened.push(`${cwd}|${cols}x${rows}`) },
        runs: { run: (cwd, command, _c, _r, before) => void started.push(`${cwd}|${command}|${before}`) },
        log: () => {},
      },
      diskWith(dir),
    )
    expect(opened).toEqual([`${dir}|100x30`, `${dir}|90x20`])
    expect(started).toEqual([`${dir}|pnpm dev|${RUN_RESTARTED_LINE}\r\n`])
  })

  it('skips a folder that is no longer a project, and one that is gone from the disk; one that fails to open does not stop the rest', () => {
    const dir = '/work/app'
    const gone = '/work/removed'
    const other = '/work/other'
    const log = vi.fn()
    const opened: string[] = []
    const started: string[] = []
    restartEnded(
      {
        terminals: [
          { cwd: dir, cols: 100, rows: 30 },
          { cwd: other, cols: 80, rows: 24 },
          { cwd: gone, cols: 80, rows: 24 },
          { cwd: dir, cols: 2, rows: 2 },
          { cwd: dir, cols: 90, rows: 20 },
        ],
        runs: [
          { cwd: dir, command: 'pnpm dev' },
          { cwd: gone, command: 'pnpm gone' },
        ],
      },
      {
        // Only `dir` and `gone` are projects; the second folder exists but no project has it
        projectFolders: new Set([dir, gone]),
        terminals: {
          create: (cwd, cols, rows) => {
            if (cols === 2) throw new Error('no shell')
            opened.push(`${cwd}|${cols}x${rows}`)
          },
        },
        runs: { run: (cwd, command) => void started.push(`${cwd}|${command}`) },
        log,
      },
      // `gone` is a project's folder that is no longer on the disk; `other` is on the disk and no project's
      diskWith(dir, other),
    )
    expect(opened).toEqual([`${dir}|100x30`, `${dir}|90x20`])
    expect(started).toEqual([`${dir}|pnpm dev`])
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('terminal an update ended is not reopened'),
      expect.stringContaining('terminal an update ended is not reopened'),
      expect.stringContaining('could not be reopened: no shell'),
      expect.stringContaining('command an update ended is not started again'),
    ])
  })

  it('reopens a terminal as a fresh shell: its screen is empty until the new shell prints, and nothing is typed into it', () => {
    const dir = '/work/app'
    const fake = fakePty()
    const svc = terminalsOn(fake.mod)
    restartEnded({ terminals: [{ cwd: dir, cols: 100, rows: 30 }], runs: [] }, { projectFolders: new Set([dir]), terminals: svc, runs: runnerOn(fake.mod), log: () => {} }, diskWith(dir))
    expect(fake.ptys).toHaveLength(1)
    expect(fake.ptys[0]!.written).toEqual([])
    expect(svc.list(dir).map((t) => t.title)).toEqual(['Terminal 1'])
    expect(svc.list(dir)[0]!.history()).toBe('')
    fake.ptys[0]!.print('PS> ')
    expect(svc.list(dir)[0]!.history()).toBe('PS> ')
  })
})
