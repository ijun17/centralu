import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasPs } from '../os.js'
import { insideAny, noTty, orphanAdopter, parseLsofCwd, parsePsRows, pickStrays, scanProcesses, stopStrays } from './strays.js'
import { SLOW } from '../../../../tooling/test-timing.js'
import { ownProcesses } from '../process.test-helpers.js'

/**
 * Choosing a leftover process (user request, 2026-09-07).
 *
 * Measurement set the rules: a dev server an agent launched has ppid=1 with no controlling
 * terminal (`??`), while something the person launched in their own terminal has a tty
 * (`ttys005`). That line is what separates "safe to clean up" from "someone else's work." This
 * only checks that judgment — it never actually calls ps or lsof.
 */
describe('pickStrays', () => {
  const rows = parsePsRows(
    [
      '  100     1 ??       node /srv/dev-server.js', // left behind by an agent
      '  101     1 ttys005  node /srv/dev-server.js', // launched by a person in a terminal
      '  200   100 ??       node child-of-stray.js',
      '  900     1 ??       node host.mjs', // us (the host)
      '  901   900 ??       claude', // our own descendant
      '  300     1 ??       node /elsewhere/other.js', // someone else's folder
    ].join('\n'),
  )
  const cwds = new Map([
    [100, '/work/proj'],
    [101, '/work/proj'],
    [200, '/work/proj/sub'],
    [900, '/work/proj'],
    [901, '/work/proj'],
    [300, '/elsewhere'],
  ])
  const roots = ['/work/proj']

  it('picks only someone else\'s process running with no terminal in our folder', () => {
    const picked = pickStrays(rows, cwds, roots, 900).map((s) => s.pid)
    expect(picked).toEqual([100, 200])
  })

  /**
   * The host no longer leaves its agents with the keeper, but a keeper of an older build that died while it held some
   * left them behind: reparented to init, in our folder, with no terminal. Nothing holds them any more, so they are ordinary
   * leftovers, offered with what runs under them.
   */
  it('offers what a dead keeper left behind, and what runs under it, as leftovers', () => {
    const left = parsePsRows(
      [
        '  700     1 ??       claude --output-format stream-json', // once held by a keeper that died, reparented
        '  701   700 ??       node /work/proj/build.js', // its Bash tool's command
        '  900     1 ??       node host.mjs',
      ].join('\n'),
    )
    const leftCwds = new Map([
      [700, '/work/proj'],
      [701, '/work/proj'],
      [900, '/work/proj'],
    ])
    expect(pickStrays(left, leftCwds, roots, 900).map((s) => s.pid)).toEqual([700, 701])
  })

  it('leaves alone what a person launched in a terminal — tty is the line', () => {
    expect(pickStrays(rows, cwds, roots, 900).some((s) => s.pid === 101)).toBe(false)
  })

  it('the host\'s own descendant is not on the list — the shutdown procedure already cleans up the whole tree', () => {
    expect(pickStrays(rows, cwds, roots, 900).some((s) => s.pid === 901)).toBe(false)
  })

  it('outside our folder is someone else\'s business', () => {
    expect(pickStrays(rows, cwds, roots, 900).some((s) => s.pid === 300)).toBe(false)
  })

  it('never invents a cwd for a process it could not read one for', () => {
    expect(pickStrays(rows, new Map(), roots, 900)).toEqual([])
  })

  it('keeps a child an orphan spawned together with it — the whole tree has to be selectable on one screen', () => {
    // 200 is a child of the orphan (100). Since the chain only passes candidates on the way to init, it has no owner
    expect(pickStrays(rows, cwds, roots, 900).map((s) => s.pid)).toContain(200)
  })

  /**
   * A process another app is **currently using** (a point raised by the user, 2026-09-10).
   *
   * VS Code's extensions ran straight into this: the workspace was our project, so cwd matched,
   * and they were launched over a pipe, so they had no tty either. Measured, their parent turns
   * out to be a living extension host (cwd `/`) — not an orphan. Rules 1 through 3 alone could
   * not tell the difference, and the Claude extension was killed by SIGTERM when this actually ran.
   */
  it('a process a living app still holds is not on the list (VS Code extensions)', () => {
    const vscode = parsePsRows(
      [
        '  700     1 ??       Code Helper (Plugin)', // the extension host — alive, and outside our folder (cwd /)
        '  701   700 ??       claude --output-format stream-json', // launched by that extension
        '  702   700 ??       node languageServer.js',
        '  800     1 ??       node dev-server.js', // a genuine orphan — this one is kept
      ].join('\n'),
    )
    const cwd = new Map([
      [700, '/'],
      [701, '/work/proj'],
      [702, '/work/proj'],
      [800, '/work/proj'],
    ])
    expect(pickStrays(vscode, cwd, roots, 900).map((s) => s.pid)).toEqual([800])
  })

  /**
   * Under a subreaper the orphan's parent is alive: WSL's `/init` session helper, a user `systemd --user`, a container's
   * init (#1882). WSL's `/init` helper, where it adopts our orphans, counts as init; any other living parent still owns what it
   * holds, and what started the host is never offered (the keeper, a launcher).
   */
  it('an orphan adopted by the machine\'s subreaper is on the list; what a living parent holds is not, and nor is what started the host', () => {
    const wsl = parsePsRows(
      [
        '    1     0 ?        systemd',
        '   60     1 ?        /init', // the subreaper: orphans land here
        '   30    60 ??       centralu-keeper', // what started the host, in our folder, no terminal; its app has quit, so /init holds it
        '  900    30 ??       node host.mjs',
        '  800    60 ??       node dev-server.js', // adopted by /init after its shell ended
        '  700    60 ??       Code Helper (Plugin)', // a sibling app, also under /init
        '  701   700 ??       claude --output-format stream-json',
        '   40    30 ??       claude', // an agent that runs its own tools
        '   41    40 ??       node mcp-server.js',
      ].join('\n'),
    )
    const cwd = new Map([[800, '/work/proj'], [701, '/work/proj'], [900, '/work/proj'], [30, '/work/proj'], [40, '/work/proj'], [41, '/work/proj']])
    expect(pickStrays(wsl, cwd, roots, 900, 60).map((s) => s.pid)).toEqual([800])
    expect(pickStrays(wsl, cwd, roots, 900).map((s) => s.pid)).toEqual([])
  })

  /**
   * A systemd desktop (`systemd --user` adopts what detaches): `code .` from a terminal in the project leaves the editor's
   * main process with its cwd there, no terminal, and `systemd --user` for a parent. It is not a leftover. Only WSL's
   * `/init` is taken for init, so nothing is offered; this desktop's own leftovers are missed by choice.
   */
  it('an editor that detached itself under `systemd --user` is not offered, even though that process adopts orphans', async () => {
    const desktop = parsePsRows(
      [
        '    1     0 ?        /sbin/init',
        '  611     1 ?        /usr/lib/systemd/systemd --user',
        '  900   611 ??       node host.mjs',
        '  800   611 ?        /usr/share/code/code .', // the detached editor's main process
        '  801   800 ?        /usr/share/code/code --type=zygote', // its helper
        '  802   800 ?        /usr/share/code/code --type=renderer',
      ].join('\n'),
    )
    const cwd = new Map([[800, '/work/proj'], [801, '/work/proj'], [802, '/work/proj']])
    // The probe's orphan is 4242; where it landed (611) and what that process runs are what the machine answers
    const probe = (adopterCommand: string) => async (file: string, args: string[]) => ({
      stdout: file === '/bin/sh' ? '4242\n' : args[1] === 'ppid=' ? ' 611\n' : adopterCommand + '\n',
    })
    const ended: number[] = []
    const systemd = await orphanAdopter(probe('/usr/lib/systemd/systemd --user'), (pid) => void ended.push(pid))
    expect(systemd).toBeNull()
    expect(pickStrays(desktop, cwd, roots, 900, systemd).map((s) => s.pid)).toEqual([])
    // The same table with WSL's helper in that place: it is the machine's init, and what it holds is listed
    const init = await orphanAdopter(probe('/init'), (pid) => void ended.push(pid))
    expect(init).toBe(611)
    expect(pickStrays(desktop, cwd, roots, 900, init).map((s) => s.pid)).toEqual([800, 801, 802])
    // The probe's own process is ended each time, and only that
    expect(ended).toEqual([4242, 4242])
  })

  it('treats it as someone else\'s when the parent cannot be found in our own account — never fires when in doubt', () => {
    const rowsUnknownParent = parsePsRows('  400  399 ??       node something.js')
    expect(pickStrays(rowsUnknownParent, new Map([[400, '/work/proj']]), roots, 900)).toEqual([])
  })
})

describe('insideAny', () => {
  it('measures by segment boundary — /a/proj-old is not inside /a/proj', () => {
    expect(insideAny('/a/proj-old/x', ['/a/proj'])).toBeNull()
    expect(insideAny('/a/proj/x', ['/a/proj'])).toBe('/a/proj')
    expect(insideAny('/a/proj', ['/a/proj'])).toBe('/a/proj')
  })

  it('matches nothing when there are no roots', () => {
    expect(insideAny('/a/proj/x', [])).toBeNull()
  })
})

describe('reading output', () => {
  it('pulls pid, ppid, tty and command out of a ps line (even with spaces in the command)', () => {
    expect(parsePsRows('  42     1 ??       node -e setInterval(...)')).toEqual([
      { pid: 42, ppid: 1, tty: '??', command: 'node -e setInterval(...)' },
    ])
  })

  it('pulls cwd per pid out of lsof -Fpn', () => {
    expect(parseLsofCwd('p10\nfcwd\nn/work/a\np11\nfcwd\nn/work/b\n')).toEqual(
      new Map([
        [10, '/work/a'],
        [11, '/work/b'],
      ]),
    )
  })

  it('recognizes both the macOS (??) and Linux (?) notation for no controlling terminal', () => {
    expect(noTty('??')).toBe(true)
    expect(noTty('?')).toBe(true)
    expect(noTty('ttys005')).toBe(false)
  })
})

/** Stop sent one SIGTERM and nothing after it: a dev server that traps TERM ran on (#428) */
describe('stopStrays', () => {
  const stray = (pid: number) => ({ pid, command: 'node server.js', cwd: '/p' })

  it('KILLs what is still a leftover once the grace is over, measured again first', async () => {
    const sent: [number, string][] = []
    const scans = [[stray(10), stray(11), stray(12)], [stray(10)]]
    const r = await stopStrays([10, 11, 99], ['/p'], 1, {
      find: async () => scans.shift() ?? [],
      kill: (pid, signal) => void sent.push([pid, signal]),
      graceMs: 5,
    })
    expect(r).toEqual({ stopped: 2 })
    // 11 left during the grace, and 99 was never a leftover: only 10 gets the second shot
    await vi.waitFor(() => expect(sent).toEqual([[10, 'SIGTERM'], [11, 'SIGTERM'], [10, 'SIGKILL']]))
  })

  it('does not KILL a number that runs another program by the second measurement', async () => {
    const sent: [number, string][] = []
    const scans = [[stray(10)], [{ pid: 10, command: 'vim notes.md', cwd: '/p' }]]
    await stopStrays([10], ['/p'], 1, { find: async () => scans.shift() ?? [], kill: (pid, signal) => void sent.push([pid, signal]), graceMs: 5 })
    await new Promise((r) => setTimeout(r, 50))
    expect(sent).toEqual([[10, 'SIGTERM']])
  })

  /*
   * A real leftover: started by a shell that exits at once, in a session of its own (no terminal), working in the project
   * folder, and it ignores TERM. Not on Windows, which has no ps (`hasPs`).
   *
   * Where the orphan goes is the machine's business: init, or a subreaper (WSL's /init session helper, a user systemd, a
   * container's init). The scan and the stop are the real ones, so the orphan is judged as the machine re-parented it (#1882).
   */
  it.skipIf(!hasPs())('a real leftover that ignores TERM is gone after the grace', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-stray-')))
    const pidFile = join(dir, 'pid')
    const script = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
    // `detached`: a session of its own, so the leftover has no controlling terminal even when the tests run in one
    const sh = spawn('/bin/sh', ['-c', `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)} </dev/null >/dev/null 2>&1 &`], { cwd: dir, detached: true, stdio: 'ignore' })
    await new Promise((r) => sh.once('exit', r))
    let pid = 0
    // Once the wait below has seen the leftover end, its number is no longer ours to signal (#1308)
    const own = ownProcesses()
    try {
      await vi.waitFor(() => (pid = Number(readFileSync(pidFile, 'utf8'))) > 0, { timeout: 10_000 * SLOW })
      expect(await stopStrays([pid], [dir], process.pid)).toEqual({ stopped: 1 })
      await vi.waitFor(() => expect(own.alive(pid)).toBe(false), { timeout: 10_000 * SLOW, interval: 100 })
    } finally {
      own.end([pid])
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000 * SLOW)

  /** A `ps` or `lsof` that did not answer is not "no leftovers": it is said on stderr (#1793) */
  it('says on stderr when a listing could not be read, rather than passing for an empty one', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const timedOut = Object.assign(new Error('Command failed: lsof'), { killed: true, signal: 'SIGTERM' })
      const run = async (file: string) => {
        if (file === 'ps') return { stdout: '  100     1 ??       node dev.js\n' }
        throw timedOut
      }
      const { rows, cwdOf } = await scanProcesses(run)
      expect(rows.map((r) => r.pid)).toEqual([100])
      expect(cwdOf.size).toBe(0)
      expect(said.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/\[strays\] the working folders could not be read.*leftovers may be missing/)])
      said.mockClear()
      await scanProcesses(async () => {
        throw timedOut
      })
      expect(said.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/the process list could not be read/)])
      // lsof's exit 1 (some process unreadable) is its own answer, not a failure to read
      said.mockClear()
      await scanProcesses(async (file) => {
        if (file === 'ps') return { stdout: '  100     1 ??       node dev.js\n' }
        throw Object.assign(new Error('exit 1'), { code: 1, stdout: 'p100\nn/work/proj\n' })
      })
      expect(said).not.toHaveBeenCalled()
    } finally {
      said.mockRestore()
    }
  })
})
