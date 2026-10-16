import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasPs } from '../os.js'
import { insideAny, noTty, parseLsofCwd, parsePsRows, pickStrays, stopStrays } from './strays.js'
import { SLOW } from '../../../../tooling/test-timing.js'

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
   * A child the keeper holds for us (#280 step 2) is not our descendant — after a keeper handover
   * (step 4) its parent is init — but it is ours: the host and keeper stop it. Without the keeper's
   * list it looks exactly like pid 100, an agent's leftover.
   */
  it('never offers a child the keeper holds for this host, or what runs under it', () => {
    const held = parsePsRows(
      [
        '  700     1 ??       claude --output-format stream-json', // held by the keeper, reparented
        '  701   700 ??       node /work/proj/build.js', // its Bash tool's command
        '  900     1 ??       node host.mjs',
      ].join('\n'),
    )
    const heldCwds = new Map([
      [700, '/work/proj'],
      [701, '/work/proj'],
      [900, '/work/proj'],
    ])
    expect(pickStrays(held, heldCwds, roots, 900, [700]).map((s) => s.pid)).toEqual([])
    expect(pickStrays(held, heldCwds, roots, 900).map((s) => s.pid)).toEqual([700, 701])
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
    const r = await stopStrays([10, 11, 99], ['/p'], 1, [], {
      find: async () => scans.shift() ?? [],
      kill: (pid, signal) => void sent.push([pid, signal]),
      graceMs: 5,
    })
    expect(r).toEqual({ stopped: 2 })
    // 11 left during the grace, and 99 was never a leftover: only 10 gets the second shot
    await vi.waitFor(() => expect(sent).toEqual([[10, 'SIGTERM'], [11, 'SIGTERM'], [10, 'SIGKILL']]))
  })

  /** After a keeper handoff its agents are init's children: with its list missing they read as leftovers (#428 review) */
  it('stops nothing when the keeper could not say what it holds', async () => {
    const sent: number[] = []
    const r = stopStrays([10], ['/p'], 1, null, { find: async () => [stray(10)], kill: (pid) => void sent.push(pid), graceMs: 5 })
    await expect(r).rejects.toThrow(/nothing was stopped/)
    expect(sent).toEqual([])
  })

  it('does not KILL a number that runs another program by the second measurement', async () => {
    const sent: [number, string][] = []
    const scans = [[stray(10)], [{ pid: 10, command: 'vim notes.md', cwd: '/p' }]]
    await stopStrays([10], ['/p'], 1, [], { find: async () => scans.shift() ?? [], kill: (pid, signal) => void sent.push([pid, signal]), graceMs: 5 })
    await new Promise((r) => setTimeout(r, 50))
    expect(sent).toEqual([[10, 'SIGTERM']])
  })

  /*
   * A real leftover: started by a shell that exits at once, so it is init's child, in a session of its own (no
   * terminal), working in the project folder, and it ignores TERM. Not on Windows, which has no ps (`hasPs`).
   */
  it.skipIf(!hasPs())('a real leftover that ignores TERM is gone after the grace', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-stray-')))
    const pidFile = join(dir, 'pid')
    const script = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
    // `detached`: a session of its own, so the leftover has no controlling terminal even when the tests run in one
    const sh = spawn('/bin/sh', ['-c', `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)} </dev/null >/dev/null 2>&1 &`], { cwd: dir, detached: true, stdio: 'ignore' })
    await new Promise((r) => sh.once('exit', r))
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    let pid = 0
    try {
      await vi.waitFor(() => (pid = Number(readFileSync(pidFile, 'utf8'))) > 0, { timeout: 10_000 })
      // Not this test's process: the host's descendants are not leftovers
      expect(await stopStrays([pid], [dir], 999_999)).toEqual({ stopped: 1 })
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000, interval: 100 })
    } finally {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000 * SLOW)
})
