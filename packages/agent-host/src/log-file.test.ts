import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_LOG_BYTES, hostLogPath, rotateIfLarge, startupBanner, teeStderrToFile } from './log-file.js'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'cc-log-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('the host log file', () => {
  it('text written to stderr also remains in the file', () => {
    const path = hostLogPath(tmp())
    const stop = teeStderrToFile(path)
    try {
      // Writes directly to the spot console.error ultimately calls —
      // vitest intercepts console, so console.error cannot exercise the real path
      process.stderr.write('[agent-host] hello\n')
    } finally {
      stop()
    }
    expect(readFileSync(path, 'utf8')).toContain('[agent-host] hello')
  })

  /*
   * If output is only siphoned off to a file, it disappears from view when launched from a
   * terminal — which is more inconvenient during development. The file is "one more audience,"
   * not a replacement.
   */
  it('the original stderr still flows through as well (not intercepted)', () => {
    const path = hostLogPath(tmp())
    const seen: string[] = []
    const real = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((c: unknown) => {
      seen.push(String(c))
      return true
    }) as typeof process.stderr.write
    const stop = teeStderrToFile(path)
    try {
      process.stderr.write('보이는가\n')
    } finally {
      stop()
      process.stderr.write = real
    }
    expect(seen.join('')).toContain('보이는가')
    expect(readFileSync(path, 'utf8')).toContain('보이는가')
  })

  it('rolls over and keeps only one prior generation once it overflows (does not silently eat up the folder)', () => {
    const path = hostLogPath(tmp())
    writeFileSync(path, 'x'.repeat(100))
    expect(rotateIfLarge(path, 50)).toBe(true)
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it('leaves it alone while it is still small', () => {
    const path = hostLogPath(tmp())
    writeFileSync(path, 'x'.repeat(10))
    expect(rotateIfLarge(path, MAX_LOG_BYTES)).toBe(false)
    expect(existsSync(`${path}.1`)).toBe(false)
  })

  it('rolls over even if it overflows mid-write, and keeps writing', () => {
    const path = hostLogPath(tmp())
    const stop = teeStderrToFile(path, 64)
    try {
      for (let i = 0; i < 12; i++) process.stderr.write(`line ${i} ${'y'.repeat(20)}\n`)
      // The key question is whether writing continues **even after** the rollover — stopping here
      // means going silently blind
      process.stderr.write('after-roll\n')
    } finally {
      stop()
    }
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('after-roll')
  })

  /*
   * If a rollover fails during the rename after close, the **closed fd number** used to be kept
   * around as is. The OS soon reissues that number to a different file (SQLite WAL, a pty), so the
   * next writeSync silently corrupted someone else's file with log lines. Even on the failure path,
   * the fd is cleared and reopened, and this checks that subsequent lines **still** end up in this
   * log file.
   */
  it('does not hold onto a dead fd when the rollover fails, and keeps writing to the same file', () => {
    const dir = tmp()
    const path = hostLogPath(dir)
    const stop = teeStderrToFile(path, 64)
    try {
      // Makes the rename fail — EACCES when the directory has no write permission
      chmodSync(dir, 0o555)
      for (let i = 0; i < 12; i++) process.stderr.write(`line ${i} ${'y'.repeat(20)}\n`)
      process.stderr.write('after-failed-roll\n')
    } finally {
      chmodSync(dir, 0o755)
      stop()
    }
    // The rollover failed (stayed in one file), but the log kept flowing into this file
    expect(existsSync(`${path}.1`)).toBe(false)
    expect(readFileSync(path, 'utf8')).toContain('after-failed-roll')
  })

  /*
   * "Which commit was the running app built from" used to have to be answered by matching the
   * binary's mtime against commit timestamps. If the log states it outright, that whole guessing
   * game disappears.
   */
  it('the startup banner states the build, DB, and pid on its own', () => {
    const b = startupBanner({ build: 'abc1234', db: '/x/store.db', pid: 42 })
    expect(b).toContain('abc1234')
    expect(b).toContain('/x/store.db')
    expect(b).toContain('42')
  })
})

/*
 * stdout is deliberately not part of this. `main.ts` prints exactly one line there — the
 * handshake the Tauri supervisor parses for the port and the auth token — so teeing stdout
 * would copy that token into a plaintext file under the user's home directory.
 *
 * That makes "just log it" genuinely wrong in this package, and the trade has a cost: a
 * `console.log` anywhere in the host is invisible in a Finder-launched `.app`, where stdout
 * goes nowhere at all. It happened — the v21 migration announced itself on stdout and left
 * no trace of having run. The lint rule (`no-console` in eslint.config.js) is the guard on
 * the writing side; this is the guard on the plumbing side.
 */
describe('stdout does not leak into the file', () => {
  it('teeStderrToFile does not touch stdout — the token goes out that way', () => {
    const path = hostLogPath(tmp())
    const before = process.stdout.write
    const stop = teeStderrToFile(path)
    try {
      expect(process.stdout.write).toBe(before)
      process.stdout.write('{"ready":true,"token":"secret-token"}\n')
    } finally {
      stop()
    }
    expect(existsSync(path) ? readFileSync(path, 'utf8') : '').not.toContain('secret-token')
  })
})
