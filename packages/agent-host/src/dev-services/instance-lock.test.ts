import { describe, expect, it, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { OWNERSHIP_FILE, acquireInstanceLock, lockConflictMessage, processStartTime } from './instance-lock.js'
import { SLOW } from '../../../../tooling/test-timing.js'

/**
 * If two hosts use the same data folder, each carries a different session list while writing to
 * the same file. That makes the "already loaded" check disagree, and the same conversation ends
 * up twice on the list. Refusing to launch and saying why is better than quietly going wrong.
 */
const dirs: string[] = []
const dbIn = () => {
  const d = mkdtempSync(join(tmpdir(), 'cc-lock-'))
  dirs.push(d)
  return join(d, 'store.db')
}
// Every lock a test takes is released before this runs: the ownership lock is an open SQLite file, and Windows cannot
// delete a file that is still open (#14)
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('single-instance lock for the host', () => {
  it('acquiring it for the first time succeeds and creates a lock file', () => {
    const db = dbIn()
    const r = acquireInstanceLock(db)
    expect(r.ok).toBe(true)
    expect(existsSync(join(db, '..', 'host.lock'))).toBe(true)
    if (r.ok) r.release()
  })

  /*
   * Until #461 a live owner named in host.lock refused the start, for hosts from before #82 that
   * knew only the file. Now the file is a description: a host that holds the ownership lock starts
   * whatever the file says, so a pid reused by an unrelated process (Windows reuses them quickly,
   * #14) or a start time that cannot be read never refuses one.
   */
  it('a live, matching owner left in host.lock does not refuse a host that holds ownership', () => {
    const db = dbIn()
    writeFileSync(join(db, '..', 'host.lock'), JSON.stringify({ pid: process.ppid, started: processStartTime(process.ppid) }))
    const r = acquireInstanceLock(db)
    expect(r.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(db, '..', 'host.lock'), 'utf8')).pid).toBe(process.pid)
    if (r.ok) r.release()
  })

  it('a lock left by a dead owner is taken over (the app was force-quit)', () => {
    const db = dbIn()
    // A pid that cannot exist
    writeFileSync(join(db, '..', 'host.lock'), '999999')
    const r = acquireInstanceLock(db)
    expect(r.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(db, '..', 'host.lock'), 'utf8'))).toEqual({
      pid: process.pid,
      started: processStartTime(process.pid),
      at: expect.any(Number),
    })
    if (r.ok) r.release()
  })

  it('releasing it removes the lock file, and the next host can acquire it', () => {
    const db = dbIn()
    const first = acquireInstanceLock(db)
    if (first.ok) first.release()
    expect(existsSync(join(db, '..', 'host.lock'))).toBe(false)
    const next = acquireInstanceLock(db)
    expect(next.ok).toBe(true)
    if (next.ok) next.release()
  })

  it('never releases someone else\'s lock (that would defeat the point of the block)', () => {
    const db = dbIn()
    const mine = acquireInstanceLock(db)
    // The situation where another host took it over in the meantime
    writeFileSync(join(db, '..', 'host.lock'), String(process.ppid))
    if (mine.ok) mine.release()
    expect(readFileSync(join(db, '..', 'host.lock'), 'utf8')).toBe(String(process.ppid))
  })

  it('never blocks an in-memory database, since it can never be shared', () => {
    expect(acquireInstanceLock(':memory:').ok).toBe(true)
  })
})

/*
 * #1223: a desktop window on a linked Windows machine was refused with "close the running window first" while the
 * folder was held by the host a hub's link had started there, and the person had no window to close. host.lock now
 * says who started the host and from where (additive fields), and the refusal names it.
 */
describe('who holds the folder, said in the refusal (#1223)', () => {
  const at = Date.UTC(2026, 9, 18, 3, 9, 38)

  it('writes who started the host, from where and when, and a second taker reads it back', () => {
    const db = dbIn()
    const first = acquireInstanceLock(db, () => null, { by: 'serve', from: { hub: 'Mac-mini', ssh: '192.168.0.5' } }, () => at)
    expect(first.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(db, '..', 'host.lock'), 'utf8'))).toEqual({
      pid: process.pid,
      started: null,
      at,
      by: 'serve',
      from: { hub: 'Mac-mini', ssh: '192.168.0.5' },
    })
    const second = acquireInstanceLock(db)
    expect(second).toMatchObject({ ok: false, heldByPid: process.pid, holder: { by: 'serve', at, from: { hub: 'Mac-mini' } } })
    if (first.ok) first.release()
  })

  it('names the link a serve host runs for, with what stopping it costs; and an ssh session without a hub', () => {
    const lockPath = '/d/host.lock'
    const serve = lockConflictMessage({ pid: 4072, started: null, at, by: 'serve', from: { hub: 'Mac-mini', ssh: '192.168.0.5' } }, lockPath)
    expect(serve).toContain(
      'Another Centralu is already using this data: the host `centralu serve` runs for the link from Mac-mini (asked for over ssh from 192.168.0.5) (pid 4072, since 2026-10-18T03:09:38Z).',
    )
    expect(serve).toContain('run `centralu serve --stop` here: the link from Mac-mini loses this computer until it reconnects.')
    expect(serve).not.toContain('Close the running window')
    expect(serve).toContain(`Lock file: ${lockPath}`)
    const bare = lockConflictMessage({ pid: 9, started: null, by: 'serve', from: { ssh: '10.0.0.2' } }, lockPath)
    expect(bare).toContain('the host `centralu serve` runs (asked for over ssh from 10.0.0.2) (pid 9)')
    expect(bare).toContain('a hub linked to this computer loses this computer')
  })

  it('names the window’s and the keeper’s hosts, and keeps the old words for a holder that says nothing', () => {
    expect(lockConflictMessage({ pid: 1, started: null, by: 'app' }, 'l')).toContain('the host of the Centralu window on this computer (pid 1)')
    expect(lockConflictMessage({ pid: 1, started: null, by: 'keeper' }, 'l')).toContain('Quit Centralu completely first')
    const old = lockConflictMessage(77, 'l')
    expect(old).toContain('Another Centralu is already using this data: another host (pid 77).')
    expect(old).toContain('Close the running window first')
    expect(lockConflictMessage(null, 'l')).toContain('(pid unknown)')
  })

  it('reads a description it cannot trust as absent: a name that could break the sentence, a by it does not know', () => {
    const db = dbIn()
    const first = acquireInstanceLock(db)
    writeFileSync(join(db, '..', 'host.lock'), JSON.stringify({ pid: process.pid, started: null, at: 'soon', by: 'robot', from: { hub: 'a b\nc', ssh: 7 } }))
    const second = acquireInstanceLock(db)
    expect(second).toMatchObject({ ok: false, holder: { pid: process.pid, started: null } })
    expect(second.ok ? null : second.holder).toEqual({ pid: process.pid, started: null })
    if (first.ok) first.release()
  })
})

/*
 * The desktop supervisor reads only the host's stdout. When the lock-conflict message went only
 * to stderr, the screen showed the supervisor's bare "agent-host exited (code Some(1))" (sidecar.rs;
 * Korean at the time) instead of the reason (#184). This launches a real host and checks which channel
 * the message comes out on.
 */
describe('the lock-conflict message reaches the supervisor', () => {
  it('a blocked host also writes the reason to stdout, and exits with 1', () => {
    const db = dbIn()
    // This test process is the owner: it holds the ownership lock itself, which refuses the host
    // on every OS (a host.lock alone no longer refuses on Windows, #14)
    const held = acquireInstanceLock(db)
    expect(held.ok).toBe(true)
    const root = fileURLToPath(new URL('../../../../', import.meta.url))
    try {
      const r = spawnSync(process.execPath, ['--import', 'tsx', 'packages/agent-host/src/main.ts', '--db', db, '--port', '0'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, CI: '1' },
      })
      expect(r.status).toBe(1)
      expect(r.stdout).toContain('Another Centralu is already using this data')
      expect(r.stdout).toContain(`Lock file: ${join(db, '..', 'host.lock')}`)
    } finally {
      if (held.ok) held.release()
    }
  }, 60_000 * SLOW)
})

/*
 * #82: ownership is an exclusive SQLite lock held for the host's lifetime, not the lock file's
 * check-then-write. Measured on main: 8 hosts started at once produced 2 owners, a second acquire
 * in the same process succeeded, and a missing host.lock let a second owner in while the first
 * was alive. Each test below was run against that code; the failures are quoted in the PR.
 */
describe('single-writer ownership (#82)', () => {
  const lockModule = fileURLToPath(new URL('./instance-lock.ts', import.meta.url))
  const root = fileURLToPath(new URL('../../../../', import.meta.url))

  /** A separate process that takes the lock, reports, then holds it, exits, or dies by SIGKILL */
  function child(db: string, mode: 'hold' | 'crash', holdMs = 1500) {
    const script = join(dirname(db), `child-${Math.random().toString(36).slice(2)}.mts`)
    writeFileSync(
      script,
      `const { acquireInstanceLock } = await import(${JSON.stringify(pathToFileURL(lockModule).href)})
const r = acquireInstanceLock(${JSON.stringify(db)})
console.log(r.ok ? 'acquired' : 'blocked')
if (r.ok && ${JSON.stringify(mode)} === 'crash') process.kill(process.pid, 'SIGKILL')
setTimeout(() => process.exit(0), ${holdMs})
`,
    )
    const p = spawn(process.execPath, ['--import', 'tsx', script], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    p.stdout.on('data', (d: Buffer) => (out += String(d)))
    const said = new Promise<string>((resolve) => p.stdout.once('data', () => resolve(out.trim())))
    const exited = new Promise<void>((resolve) => p.once('exit', () => resolve()))
    return { said, exited, out: () => out.trim(), kill: () => p.kill('SIGKILL') }
  }

  it('a second acquire in the same process is refused while the first is held', () => {
    const db = dbIn()
    const first = acquireInstanceLock(db)
    expect(first.ok).toBe(true)
    const second = acquireInstanceLock(db)
    expect(second).toMatchObject({ ok: false, heldByPid: process.pid })
    if (first.ok) first.release()
    const third = acquireInstanceLock(db)
    expect(third.ok).toBe(true)
    if (third.ok) third.release()
  })

  it('an owner in another process keeps others out even when host.lock is gone', async () => {
    const db = dbIn()
    const owner = child(db, 'hold', 4000)
    try {
      expect(await owner.said).toBe('acquired')
      // A contender that read the folder before the owner wrote its file, or a person tidying up
      rmSync(join(db, '..', 'host.lock'))
      const r = acquireInstanceLock(db)
      expect(r).toMatchObject({ ok: false, heldByPid: null })
      expect(lockConflictMessage(null, join(db, '..', 'host.lock'))).toContain('already using this data: another host (pid unknown)')
    } finally {
      owner.kill()
      await owner.exited
    }
  }, 20_000 * SLOW)

  it('the operating system releases ownership when the owner is SIGKILLed — the next host starts', async () => {
    const db = dbIn()
    const owner = child(db, 'crash')
    expect(await owner.said).toBe('acquired')
    await owner.exited
    // The killed owner's host.lock is still there, naming a dead pid
    expect(existsSync(join(db, '..', 'host.lock'))).toBe(true)
    const r = acquireInstanceLock(db)
    expect(r.ok).toBe(true)
    if (r.ok) r.release()
  }, 20_000 * SLOW)

  it('of hosts started at the same moment, exactly one owns the folder', async () => {
    const db = dbIn()
    const contenders = Array.from({ length: 6 }, () => child(db, 'hold', 4000))
    try {
      const said = await Promise.all(contenders.map((c) => c.said))
      expect(said.filter((s) => s === 'acquired')).toHaveLength(1)
      expect(said.filter((s) => s === 'blocked')).toHaveLength(5)
    } finally {
      for (const c of contenders) c.kill()
      await Promise.all(contenders.map((c) => c.exited))
    }
  }, 30_000 * SLOW)

  it('an ownership file that cannot be read refuses the start instead of guessing', () => {
    const db = dbIn()
    writeFileSync(join(db, '..', OWNERSHIP_FILE), 'this is not a database, and it is longer than a SQLite header')
    expect(() => acquireInstanceLock(db)).toThrow(/Cannot check who owns this data folder/)
    expect(existsSync(join(db, '..', 'host.lock'))).toBe(false)
  })
})

/*
 * LK2: the ownership is an open SQLite handle, and a handle the garbage collector takes is closed,
 * which releases the lock (measured: a second taker in the same process gets it after `gc()`). A
 * caller that keeps nothing of the result must still be the owner, so the module keeps the handle
 * reachable itself. Run in a process of its own, with `--expose-gc`, so the collection is real.
 */
describe('ownership survives garbage collection (LK2)', () => {
  const lockModule = fileURLToPath(new URL('./instance-lock.ts', import.meta.url))
  const root = fileURLToPath(new URL('../../../../', import.meta.url))

  it('a lock whose result nobody kept is still held after a collection', () => {
    const db = dbIn()
    const script = join(dirname(db), 'gc-check.mts')
    writeFileSync(
      script,
      `const { acquireInstanceLock } = await import(${JSON.stringify(pathToFileURL(lockModule).href)})
;(() => { acquireInstanceLock(${JSON.stringify(db)}) })()
for (let i = 0; i < 5; i++) { globalThis.gc(); await new Promise((r) => setTimeout(r, 20)) }
console.log(acquireInstanceLock(${JSON.stringify(db)}).ok ? 'second owner' : 'still held')
process.exit(0)
`,
    )
    const r = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', script], { cwd: root, encoding: 'utf8', timeout: 30_000 })
    expect(r.stdout.trim()).toBe('still held')
  }, 30_000 * SLOW)
})

/*
 * LK3: a pid is not an identity, and reading it must not depend on the reader. `ps -o lstart=`
 * follows the locale, so a Korean-locale writer and a C-locale reader read the same start time
 * differently and stole a live lock (the start time is still recorded in `host.lock`).
 */
describe('reading another process (LK3)', () => {
  // Windows has no ps and records no start time; ownership there is the SQLite lock alone
  it.skipIf(process.platform === 'win32')('ps runs in the C locale whatever the host was started with', () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-ps-'))
    dirs.push(d)
    writeFileSync(join(d, 'ps'), '#!/bin/sh\necho "locale=$LC_ALL"\n', { mode: 0o755 })
    const saved = { PATH: process.env.PATH, LC_ALL: process.env.LC_ALL }
    try {
      process.env.PATH = `${d}:${saved.PATH}`
      process.env.LC_ALL = 'ko_KR.UTF-8'
      expect(processStartTime(process.pid)).toBe('locale=C')
    } finally {
      process.env.PATH = saved.PATH
      if (saved.LC_ALL === undefined) delete process.env.LC_ALL
      else process.env.LC_ALL = saved.LC_ALL
    }
  })
})
