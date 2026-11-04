import { afterEach, describe, expect, it } from 'vitest'
import { systemStoppingQueries } from '../os.js'
import { realOs } from '../os/real.js'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { takeSystemEnd, writeSystemEnd } from './stopped-mark.js'
import { SYSTEM_END_FILE, SYSTEM_END_TAIL_MS, SystemEndNotice, askSystemStopping, type SystemEnd } from './system-end.js'

const { files } = realOs()
const join = (...parts: string[]) => realOs().paths.path.join(...parts)

/*
 * #1397: a host writes that the system is ending when it is told so, and nothing else; the next start reads it. These are the
 * notice's rules; sessions/system-end.test.ts is what a start does with it, host-process.test.ts the real host.
 */

const notice = () => {
  let t = 1_000
  const written: (SystemEnd | null)[] = []
  const timers: (() => void)[] = []
  let outlived = 0
  const n = new SystemEndNotice({ write: (x) => written.push(x), now: () => t, setTimer: (f, ms) => (expect(ms).toBe(SYSTEM_END_TAIL_MS), void timers.push(f)), outlived: () => void outlived++ })
  return { n, written, timers, outlived: () => outlived, tick: (ms: number) => (t += ms), last: () => written.at(-1) ?? null }
}

describe('a host’s notice that the system is ending', () => {
  it('is written when told, once, and removed when called off', () => {
    const t = notice()
    t.n.notice()
    t.tick(10)
    t.n.notice()
    expect(t.written).toEqual([{ at: 1_000 }])
    t.n.cancel()
    expect(t.last()).toBeNull()
  })

  it('is called off when the host outlives it: the system did not go', () => {
    const t = notice()
    t.n.notice()
    t.timers[0]!()
    expect(t.outlived()).toBe(1)
    expect(t.last()).toBeNull()
  })

  it('is not called off by the timer of an earlier notice, in the same millisecond or not (deep review 4)', () => {
    const t = notice()
    t.n.notice()
    t.n.cancel()
    t.n.notice()
    t.timers[0]!()
    expect(t.outlived()).toBe(0)
    expect(t.last()).toEqual({ at: 1_000 })
  })

  it('writes nothing once the folder is the next host’s', () => {
    const t = notice()
    t.n.close()
    t.n.notice()
    expect(t.written).toEqual([])
  })
})

describe('the notice in the data folder', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs.splice(0)) await removeTree(d)
  })
  const folder = () => {
    const d = tempRoot('cc-system-end-')
    dirs.push(d)
    return d
  }

  it('is read once: the start that takes it removes it', () => {
    const dir = folder()
    writeSystemEnd(dir)({ at: 5 })
    expect(takeSystemEnd(dir)).toEqual({ at: 5 })
    expect(files.existsSync(join(dir, SYSTEM_END_FILE))).toBe(false)
    expect(takeSystemEnd(dir)).toBeNull()
  })

  it('is removed by a notice called off', () => {
    const dir = folder()
    const n = new SystemEndNotice({ write: writeSystemEnd(dir) })
    n.notice()
    expect(files.existsSync(join(dir, SYSTEM_END_FILE))).toBe(true)
    n.cancel()
    expect(takeSystemEnd(dir)).toBeNull()
  })

  it.each([['text that is not JSON', '{"v":1,"a'], ['no time', '{"v":1}'], ['another version', '{"v":2,"at":5}']])('is none when it holds %s', (_, text) => {
    const dir = folder()
    files.writeFileSync(join(dir, SYSTEM_END_FILE), text)
    expect(takeSystemEnd(dir)).toBeNull()
    expect(files.existsSync(join(dir, SYSTEM_END_FILE))).toBe(false)
  })
})

describe('asking whether the system is ending', () => {
  const queries = systemStoppingQueries('linux')
  /** A run whose answers are given per query, `null` for one that never answers; the children it started, and those it was told to end */
  const runs = (answers: Record<string, string | null>) => {
    const killed: string[] = []
    const run = (_command: string, args: readonly string[], options: { onChild: (child: { kill(): boolean }) => void }) => {
      const key = args.join(' ')
      options.onChild({ kill: () => (killed.push(key), true) })
      const word = answers[key]
      return word === null || word === undefined ? new Promise<{ stdout: Buffer }>(() => {}) : Promise.resolve({ stdout: Buffer.from(`${word}\n`) })
    }
    return { run, killed }
  }

  it('asks systemd on Linux: the manager, or the user’s at a sign-out, is stopping', async () => {
    expect(queries).toEqual([
      ['systemctl', 'is-system-running'],
      ['systemctl', '--user', 'is-system-running'],
    ])
    for (const [system, user, yes] of [['stopping', 'running', true], ['running', 'stopping', true], ['running', 'degraded', false]] as const) {
      const r = runs({ 'is-system-running': system, '--user is-system-running': user })
      expect(await askSystemStopping({ queries, run: r.run }).stopping).toBe(yes)
    }
  })

  it('answers as soon as one says stopping, and ends the one still running (deep review 2, 3)', async () => {
    const r = runs({ 'is-system-running': 'stopping', '--user is-system-running': null })
    const started = Date.now()
    expect(await askSystemStopping({ queries, run: r.run, timeoutMs: 5_000 }).stopping).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_000)
    await Promise.resolve()
    expect(r.killed).toEqual(['is-system-running', '--user is-system-running'])
  })

  it('is no, in time, when systemd cannot be asked or does not answer; `end` ends what still runs', async () => {
    expect(await askSystemStopping({ queries, run: () => Promise.reject(new Error('ENOENT')) }).stopping).toBe(false)
    const hung = runs({ 'is-system-running': null, '--user is-system-running': null })
    const asked = askSystemStopping({ queries, run: hung.run, timeoutMs: 20 })
    asked.end()
    expect(hung.killed.sort()).toEqual(['--user is-system-running', 'is-system-running'])
    expect(await asked.stopping).toBe(false)
  })

  it.each(['darwin', 'win32'] as const)('has no question on %s: a signal alone does not say who sent it', (platform) => {
    expect(systemStoppingQueries(platform)).toBeNull()
    expect(askSystemStopping({ queries: systemStoppingQueries(platform) }).stopping).toBeNull()
  })
})
