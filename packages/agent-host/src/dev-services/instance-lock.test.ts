import { describe, expect, it, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireInstanceLock, processStartTime } from './instance-lock.js'

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
    const r = acquireInstanceLock(db)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.heldByPid).toBe(process.ppid)
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

  it('blocked when both pid and start time match, and reports the lock file\'s location', () => {
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
    expect(acquireInstanceLock(db, () => null).ok).toBe(false)
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
    // This test process is the owner — it is alive and its start time matches
    writeFileSync(join(db, '..', 'host.lock'), JSON.stringify({ pid: process.pid, started: processStartTime(process.pid) }))
    const root = fileURLToPath(new URL('../../../../', import.meta.url))
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'packages/agent-host/src/main.ts', '--db', db, '--port', '0'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, CI: '1' },
    })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('Another Centralu is already using this data')
    expect(r.stdout).toContain(`Lock file: ${join(db, '..', 'host.lock')}`)
  }, 60_000)
})
