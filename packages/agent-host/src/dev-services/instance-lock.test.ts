import { describe, expect, it, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { OWNERSHIP_FILE, acquireInstanceLock, lockConflictMessage, processStartTime } from './instance-lock.js'

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

  it('blocked when a living process still holds it', () => {
    const db = dbIn()
    // A pid guaranteed to be alive: the parent (the process that launched this test)
    writeFileSync(join(db, '..', 'host.lock'), String(process.ppid))
    const r = acquireInstanceLock(db, processStartTime, true)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.heldByPid).toBe(process.ppid)
  })

  /*
   * Windows (#14): no host older than #82 ever ran there, so the file is only a description, and
   * a start time cannot be read to tell a reused pid apart. A file naming a live, unrelated process
   * (Windows reuses pids quickly) must not refuse a host that holds the ownership lock.
   */
  it('on Windows a live pid left in host.lock does not refuse a host that holds ownership', () => {
    const db = dbIn()
    writeFileSync(join(db, '..', 'host.lock'), String(process.ppid))
    const r = acquireInstanceLock(db, () => null, false)
    expect(r.ok).toBe(true)
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
    })
  })

  /*
   * The lock is only released on the exit event — it is left behind after a SIGKILL or a power
   * loss. If the leftover pid is reused by a process unrelated to Centralu, pid alone could not
   * tell the difference, startup was rejected, and with no window to close there was no way to
   * get unstuck (#184). A different start time means it belongs to someone else.
   */
  it('even with a living pid, a different start time means the number was reused by someone else — it is taken over', () => {
    const db = dbIn()
    writeFileSync(join(db, '..', 'host.lock'), JSON.stringify({ pid: process.ppid, started: 'Thu Jan  1 00:00:00 1970' }))
    const r = acquireInstanceLock(db, () => 'Sun Sep 27 00:21:23 2026')
    expect(r.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(db, '..', 'host.lock'), 'utf8')).pid).toBe(process.pid)
  })

  // `ps` reads the start time; Windows has neither, and skips the file check (above)
  it.skipIf(process.platform === 'win32')('blocked when both pid and start time match, and reports the lock file\'s location', () => {
    const db = dbIn()
    const started = processStartTime(process.ppid)
    expect(started).not.toBeNull()
    writeFileSync(join(db, '..', 'host.lock'), JSON.stringify({ pid: process.ppid, started }))
    const r = acquireInstanceLock(db)
    expect(r).toEqual({ ok: false, heldByPid: process.ppid, lockPath: join(db, '..', 'host.lock') })
  })

  it('blocked when that pid\'s current start time cannot be read — stealing the lock when in doubt is the riskier choice', () => {
    const db = dbIn()
    writeFileSync(join(db, '..', 'host.lock'), JSON.stringify({ pid: process.ppid, started: 'Thu Jan  1 00:00:00 1970' }))
    expect(acquireInstanceLock(db, () => null, true).ok).toBe(false)
  })

  it('releasing it removes the lock file, and the next host can acquire it', () => {
    const db = dbIn()
    const first = acquireInstanceLock(db)
    if (first.ok) first.release()
    expect(existsSync(join(db, '..', 'host.lock'))).toBe(false)
    expect(acquireInstanceLock(db).ok).toBe(true)
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
  }, 60_000)
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
      expect(lockConflictMessage(null, join(db, '..', 'host.lock'))).toContain('already using this data (pid unknown)')
    } finally {
      owner.kill()
      await owner.exited
    }
  }, 20_000)

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
  }, 20_000)

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
  }, 30_000)

  it('an ownership file that cannot be read refuses the start instead of guessing', () => {
    const db = dbIn()
    writeFileSync(join(db, '..', OWNERSHIP_FILE), 'this is not a database, and it is longer than a SQLite header')
    expect(() => acquireInstanceLock(db)).toThrow(/Cannot check who owns this data folder/)
    expect(existsSync(join(db, '..', 'host.lock'))).toBe(false)
  })
})
