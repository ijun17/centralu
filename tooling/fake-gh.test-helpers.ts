import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fakeExe, linkNode, windowsSystemEnv } from '../packages/agent-host/src/fake-exe.test-helpers.js'

/**
 * A fake `gh` for the tests that run the project board app (or one of its scripts) against "GitHub": a Node script on
 * the PATH that logs every call and answers from a state file the test writes and reads (#845).
 *
 * Seven test files each built their own: the same opening lines in the script, the same bin and node folders, the same
 * environment, and their own readers of the log and the state. The copies had drifted. The state is rewritten in place
 * (writeFileSync truncates, then writes), so a read can find it half written while a gh call the app made is saving it,
 * or a gh call can find it half written while the test changes it. Only the merge queue test's reader tried again; the
 * other readers and every fake failed on it. Only that test's read of the log skipped a line still being appended.
 *
 * Both sides now read the state the same way: a read that finds it half written (a truncated JSON object never parses)
 * tries again. Writing a new file and renaming it into place would avoid the half-written read, but Windows refuses to
 * replace a file another process has open, and a test polling the state keeps it open most of the time.
 *
 * The test gives the part of the script that answers. Before it runs, the script has:
 * - `fs`, `args` (gh's arguments) and `stdin` (what `--input -` sent, else null)
 * - `st`, the state as the test last wrote it (`{}` before it writes any), and `save()`, which writes `st` back
 *
 * Every call is logged before the answer, as `{ args, stdin }`.
 */
const PROLOGUE = String.raw`const fs = require('node:fs')
const args = process.argv.slice(2)
const stdin = args.includes('--input') ? fs.readFileSync(0, 'utf8') : null
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, stdin }) + '\n')
const st = (() => {
  for (let i = 0; ; i++) {
    try {
      return fs.existsSync(process.env.FAKE_GH_STATE) ? JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8')) : {}
    } catch (e) {
      if (i >= 50) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
})()
const save = () => fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(st))
`

export type GhCall = { args: string[]; stdin: string | null }

/** The folders of the fakes made in this process (the folder of each one's `bin`), for `endLeftoverFakes` */
const made = new Set<string>()

/**
 * Windows: ends any process still running a script of a fake made in this process. A test ends the app it started with
 * the app's whole tree, while the app (polling every 50 ms) may be starting a `gh`: Windows creates a new process
 * suspended and resumes it a moment later, and one whose parent was killed in that moment stays suspended for ever (0 s of
 * CPU, one thread, the parent gone: five `gh.fake.cjs` of 24 and 26 October stayed on a machine for days, each holding a
 * temporary folder name). Nothing else would collect them: they belong to no tree any more. Only processes whose command line
 * names a folder this process made are touched. Call it once, after the last test of a file (`afterAll`); it costs a
 * PowerShell start, so not after each test. Other systems do not leave them.
 */
export function endLeftoverFakes(): number[] {
  if (process.platform !== 'win32' || made.size === 0) return []
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const roots = [...made].map((r) => `'${r.replaceAll("'", "''")}'`).join(',')
  const query = `$roots = @(${roots}); Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $c = $_.CommandLine; $c -and ($roots | Where-Object { $c.Contains($_) }) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`
  try {
    return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
      .split(/\r?\n/)
      .filter(Boolean)
      .map(Number)
  } catch (e) {
    console.warn(`[test cleanup] could not look for leftover fake gh processes: ${(e as Error).message}`)
    return []
  }
}

export interface FakeGh {
  /** The folder `gh` is in: first on the PATH */
  readonly bin: string
  /** A folder holding only this Node (`linkNode`), so the PATH finds Node and no real `gh` beside it */
  readonly node: string
  readonly statePath: string
  readonly logPath: string
  /**
   * The environment for the code under test: a PATH of `bin`, `node` and then `more`, HOME in the test's folder, what a
   * Windows program needs to start, and where the fake keeps its state and log. `extra` comes last and wins.
   */
  env(extra?: Record<string, string>, more?: readonly string[]): Record<string, string>
  setState(state: unknown): void
  /** The state as the fake last saved it (or the test last set it), read again if it is half written */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each test types its own state
  state<S = any>(): S
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each test types its own state
  patchState<S = any>(fn: (state: S) => void): void
  /** The calls made so far, in order. A line a fake is still appending is not a call yet */
  calls(): GhCall[]
  /** Forgets the calls so far */
  clearCalls(): void
}

/** Puts a fake `gh` running `answer` (see above) into `<root>/bin`, and this Node into `<root>/node` */
export function fakeGh(root: string, answer: string): FakeGh {
  const bin = join(root, 'bin')
  const node = join(root, 'node')
  mkdirSync(bin, { recursive: true })
  linkNode(node)
  fakeExe(bin, 'gh', PROLOGUE + answer)
  made.add(bin)
  const statePath = join(root, 'gh-state.json')
  const logPath = join(root, 'gh.log')
  writeFileSync(logPath, '')
  const state = <S>(): S => {
    for (let i = 0; ; i++) {
      try {
        return JSON.parse(readFileSync(statePath, 'utf8')) as S
      } catch (e) {
        if (i >= 50 || (e as NodeJS.ErrnoException).code === 'ENOENT') throw e
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
      }
    }
  }
  const write = (s: unknown) => writeFileSync(statePath, JSON.stringify(s))
  return {
    bin,
    node,
    statePath,
    logPath,
    env: (extra = {}, more = []) => ({
      PATH: [bin, node, ...more].join(delimiter),
      HOME: root,
      ...windowsSystemEnv(),
      FAKE_GH_STATE: statePath,
      FAKE_GH_LOG: logPath,
      ...extra,
    }),
    setState: write,
    state,
    patchState: (fn) => {
      const s = state()
      fn(s as never)
      write(s)
    },
    calls: () =>
      readFileSync(logPath, 'utf8')
        .split('\n')
        .flatMap((l) => {
          try {
            return l.trim() ? [JSON.parse(l) as GhCall] : []
          } catch {
            return []
          }
        }),
    clearCalls: () => writeFileSync(logPath, ''),
  }
}
