import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasPs } from '../os.js'
import { findStrays, insideAny, markAsked, markOwnChildren, noTty, OWNER_MARK, ownerMarkFor, parseLsofCwd, parsePsRows, pickStrays, scanProcesses, stopStrays } from './strays.js'
import { SLOW } from '../../../../tooling/test-timing.js'
import { ownProcesses, pidIn } from '../process.test-helpers.js'
import { KILL_GRACE_MS } from '../os/kill-tree.js'

/**
 * Choosing a leftover process (user request, 2026-09-07; by owner mark since #1898).
 *
 * A dev server an agent launched has no controlling terminal (`??`) and carries the host's owner mark in its environment;
 * something the person launched in their own terminal has a tty (`ttys005`), and something the person started outside
 * Centralu has no mark. These check that judgment on recorded tables: they never call ps, lsof or read an environment.
 */
describe('pickStrays', () => {
  const rows = parsePsRows(
    [
      '  100     1 ??       node /srv/dev-server.js', // left behind by an agent: carries our mark
      '  101     1 ttys005  node /srv/dev-server.js', // launched by a person in a terminal
      '  200   100 ??       node child-of-stray.js',
      '  900     1 ??       node host.mjs', // us (the host)
      '  901   900 ??       claude', // our own descendant
      '  300     1 ??       node /elsewhere/other.js', // someone else's folder
      '  400     1 ??       node /srv/old-server.js', // an orphan with no mark: from before it, or started outside Centralu
    ].join('\n'),
  )
  const cwds = new Map([
    [100, '/work/proj'],
    [101, '/work/proj'],
    [200, '/work/proj/sub'],
    [900, '/work/proj'],
    [901, '/work/proj'],
    [300, '/elsewhere'],
    [400, '/work/proj'],
  ])
  const roots = ['/work/proj']
  const marked = new Set([100, 101, 901, 300])

  it('picks only a marked process, and what runs under it, with no terminal in our folder', () => {
    expect(pickStrays(rows, cwds, roots, 900, marked).map((s) => s.pid)).toEqual([100, 200])
  })

  /**
   * An earlier host on this data folder (one that crashed, or the one before an update) left an agent behind: reparented
   * to init, in our folder, with no terminal. It carries this host's mark (one value per data folder), so it is offered
   * with what runs under it.
   */
  it('offers what an earlier host on this folder left behind, and what runs under it, as leftovers', () => {
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
    expect(pickStrays(left, leftCwds, roots, 900, new Set([700, 701])).map((s) => s.pid)).toEqual([700, 701])
  })

  it('leaves alone what a person launched in a terminal (tty is the line, mark or not)', () => {
    expect(pickStrays(rows, cwds, roots, 900, marked).some((s) => s.pid === 101)).toBe(false)
  })

  it('the host\'s own descendant is not on the list: the shutdown procedure already cleans up the whole tree', () => {
    expect(pickStrays(rows, cwds, roots, 900, marked).some((s) => s.pid === 901)).toBe(false)
  })

  it('outside our folder is someone else\'s business', () => {
    expect(pickStrays(rows, cwds, roots, 900, marked).some((s) => s.pid === 300)).toBe(false)
  })

  it('never invents a cwd for a process it could not read one for', () => {
    expect(pickStrays(rows, new Map(), roots, 900, marked)).toEqual([])
  })

  it('offers nothing whose environment could not be read or has no mark', () => {
    expect(pickStrays(rows, cwds, roots, 900, new Set())).toEqual([])
  })

  /**
   * A process another app is **currently using** (a point raised by the user, 2026-09-10): VS Code's extensions had our
   * project for a workspace and were launched over a pipe, so cwd and tty matched. The Claude extension was killed by
   * SIGTERM when an early version ran. Nobody in that tree carries our mark; an agent's orphan does.
   */
  it('a process a living app holds is not on the list (VS Code extensions), nor an unmarked orphan', () => {
    const vscode = parsePsRows(
      [
        '  700     1 ??       Code Helper (Plugin)', // the extension host, outside our folder (cwd /)
        '  701   700 ??       claude --output-format stream-json', // launched by that extension
        '  702   700 ??       node languageServer.js',
        '  800     1 ??       node dev-server.js', // an agent's orphan: marked
        '  810     1 ??       node old-server.js', // an orphan from before the mark, or started outside Centralu
      ].join('\n'),
    )
    const cwd = new Map([
      [700, '/'],
      [701, '/work/proj'],
      [702, '/work/proj'],
      [800, '/work/proj'],
      [810, '/work/proj'],
    ])
    expect(pickStrays(vscode, cwd, roots, 900, new Set([800])).map((s) => s.pid)).toEqual([800])
  })

  /**
   * A systemd desktop (`systemd --user` adopts what detaches, #1882): `code .` from a terminal in the project leaves the
   * editor's main process with its cwd there, no terminal, and `systemd --user` for a parent, the same shape as an agent's
   * orphaned dev server. Only the mark tells them apart: the editor is not offered, the dev server is, and so is the
   * platform binary under it whose own environment macOS does not show.
   */
  it('a detached editor with no mark is not offered; an orphaned marked dev server and what runs under it are', () => {
    const desktop = parsePsRows(
      [
        '    1     0 ?        /sbin/init',
        '  611     1 ?        /usr/lib/systemd/systemd --user',
        '  900   611 ??       node host.mjs',
        '  800   611 ?        /usr/share/code/code .', // the detached editor's main process
        '  801   800 ?        /usr/share/code/code --type=zygote', // its helper
        '  810   611 ?        node node_modules/.bin/vite', // an agent's dev server, orphaned
        '  811   810 ?        /usr/bin/python3 -m http.server', // its child, whose environment was not readable
      ].join('\n'),
    )
    const cwd = new Map([[800, '/work/proj'], [801, '/work/proj'], [810, '/work/proj'], [811, '/work/proj']])
    expect(pickStrays(desktop, cwd, roots, 900, new Set([810])).map((s) => s.pid)).toEqual([810, 811])
  })

  /** The mark may sit on a process that is no candidate itself: a shell outside the project that started the server */
  it('a candidate under a marked process outside our folder is ours', () => {
    const chain = parsePsRows(['  500     1 ??       sh -c cd /work/proj && npm run dev', '  501   500 ??       node server.js'].join('\n'))
    expect(pickStrays(chain, new Map([[500, '/'], [501, '/work/proj']]), roots, 900, new Set([500])).map((s) => s.pid)).toEqual([501])
  })

  /** An update: the old host started the new app, which started the keeper and this host. They carry our mark */
  it('what started the host is never offered, marked or not', () => {
    const update = parsePsRows(['   30     1 ??       centralu-keeper', '  900    30 ??       node host.mjs'].join('\n'))
    expect(pickStrays(update, new Map([[30, '/work/proj'], [900, '/work/proj']]), roots, 900, new Set([30, 900]))).toEqual([])
  })

  it('treats it as someone else\'s when the parent cannot be found in our own account (never fires when in doubt)', () => {
    const rowsUnknownParent = parsePsRows('  400  399 ??       node something.js')
    expect(pickStrays(rowsUnknownParent, new Map([[400, '/work/proj']]), roots, 900, new Set([399]))).toEqual([])
  })
})

describe('markAsked', () => {
  it('reads the environment of each candidate and of what it descends from, never init, the host\'s tree or a terminal\'s', () => {
    const rows = parsePsRows(
      [
        '   30     1 ??       centralu-keeper',
        '  900    30 ??       node host.mjs',
        '  901   900 ??       claude',
        '  500     1 ??       sh -c npm run dev',
        '  501   500 ??       node server.js',
        '  101     1 ttys005  node server.js',
      ].join('\n'),
    )
    const cwds = new Map([[30, '/work/proj'], [900, '/work/proj'], [901, '/work/proj'], [500, '/'], [501, '/work/proj'], [101, '/work/proj']])
    expect(markAsked(rows, cwds, ['/work/proj'], 900)).toEqual([500, 501])
  })
})

describe('the owner mark', () => {
  it('is one value per data folder: the same after a restart or an update, another for another folder', () => {
    const a = ownerMarkFor('/home/me/.centralu/store.db')
    expect(ownerMarkFor('/home/me/.centralu/store.db')).toBe(a)
    expect(ownerMarkFor('/tmp/e2e-1/store.db')).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is a value of its own for each host whose store is in memory', () => {
    expect(ownerMarkFor(':memory:')).not.toBe(ownerMarkFor(':memory:'))
  })

  it('replaces a mark the host inherited from another host\'s agent', () => {
    const env: Record<string, string | undefined> = { [OWNER_MARK]: 'outer', PATH: '/bin' }
    markOwnChildren('/tmp/dev/store.db', env)
    expect(env).toEqual({ [OWNER_MARK]: ownerMarkFor('/tmp/dev/store.db'), PATH: '/bin' })
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
   * Real leftovers: each started by a shell that exits at once, in a session of its own (no terminal), working in the
   * project folder, ignoring TERM. One carries the owner mark, as what an agent starts does; the other has none, as what
   * the person starts outside Centralu (the test's own environment may carry a real host's mark: it is taken out). Not on
   * Windows, which has no ps (`hasPs`) and no leftover finder.
   *
   * Where the orphans go is the machine's business: init, or a subreaper (WSL's /init session helper, a user systemd, a
   * container's init). The scan, the environment read and the stop are the real ones (#1882, #1898).
   */
  it.skipIf(!hasPs())('a real marked leftover is offered and gone after the grace; an unmarked one beside it is neither', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-stray-')))
    const mark = ownerMarkFor(join(dir, 'store.db'))
    const start = async (name: string, env: Record<string, string | undefined>): Promise<void> => {
      const pidFile = join(dir, name)
      const script = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
      // `detached`: a session of its own, so the leftover has no controlling terminal even when the tests run in one
      const sh = spawn('/bin/sh', ['-c', `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)} </dev/null >/dev/null 2>&1 &`], { cwd: dir, detached: true, stdio: 'ignore', env })
      await new Promise((r) => sh.once('exit', r))
    }
    const { [OWNER_MARK]: _inherited, ...unmarked } = process.env
    const marked = { ...unmarked }
    markOwnChildren(join(dir, 'store.db'), marked)
    await start('marked', marked)
    await start('unmarked', unmarked)
    // Once a wait below has seen a leftover end, its number is no longer ours to signal (#1308)
    const own = ownProcesses()
    const pids: number[] = []
    try {
      const [ours, theirs] = [await pidIn(join(dir, 'marked'), 10_000 * SLOW), await pidIn(join(dir, 'unmarked'), 10_000 * SLOW)]
      pids.push(ours, theirs)
      expect((await findStrays([dir], process.pid, mark)).map((s) => s.pid)).toEqual([ours])
      const deps = { find: (roots: readonly string[], self?: number) => findStrays(roots, self, mark), kill: (pid: number, signal: NodeJS.Signals) => void process.kill(pid, signal), graceMs: KILL_GRACE_MS }
      expect(await stopStrays([ours, theirs], [dir], process.pid, deps)).toEqual({ stopped: 1 })
      await vi.waitFor(() => expect(own.alive(ours)).toBe(false), { timeout: 10_000 * SLOW, interval: 100 })
      expect(own.alive(theirs)).toBe(true)
    } finally {
      own.end(pids)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000 * SLOW)

  /** A `ps` or `lsof` that did not answer is not "no leftovers": it is said on stderr (#1793) */
  it('says on stderr when a listing could not be read, rather than passing for an empty one', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const timedOut = Object.assign(new Error('Command failed: lsof'), { ended: 'timeout' })
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
