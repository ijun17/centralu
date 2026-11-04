import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { ENDING_FILE, EndingRecorder, systemEndOf, systemIsStopping, takeEndingRecord, writeEndingRecord, type EndingRecord } from './ending-record.js'

/*
 * #1397: why a host ended is written by that host as it goes, and only a recorded notice of the system ending makes a cut turn the
 * system's. These are the record's rules; sessions/system-end.test.ts is what a start does with it, host-process.test.ts the real host.
 */

const recorder = () => {
  let t = 1_000
  const written: (EndingRecord | null)[] = []
  const r = new EndingRecorder({ write: (x) => written.push(x), now: () => t })
  return { r, written, tick: (ms: number) => (t += ms), last: () => written.at(-1) ?? null }
}

describe('what a host records as it ends', () => {
  it('the first way of leaving stands: the leave it started is the one that runs', () => {
    const { r, last, tick } = recorder()
    r.leaving('quit')
    tick(10)
    r.leaving('parent')
    expect(last()).toEqual({ v: 1, by: 'quit', at: 1_000 })
  })

  it('a direct-mode quit is its parent going, never the system (review finding 1)', () => {
    const { r, last } = recorder()
    r.leaving('parent')
    expect(last()).toMatchObject({ by: 'parent' })
    expect(systemEndOf(last())).toBeNull()
  })

  it.each(['parent', 'signal', 'crash'] as const)('a system notice after %s, which says not who asked, makes it the system’s', (by) => {
    const { r, last, tick } = recorder()
    r.leaving(by)
    tick(50)
    r.systemEnding()
    expect(last()).toEqual({ v: 1, by: 'system', at: 1_000, systemAt: 1_050, detail: by })
    expect(systemEndOf(last())).toEqual({ at: 1_050 })
  })

  it('a notice first, then the quit it leads to (a Mac quits its apps as it shuts down), is the system’s (review finding 6)', () => {
    const { r, last, tick } = recorder()
    r.systemEnding()
    tick(200)
    r.leaving('quit')
    expect(systemEndOf(last())).toEqual({ at: 1_000 })
  })

  it.each(['quit', 'stop', 'update', 'swap'] as const)('a %s asked for before the notice stays what it was', (by) => {
    const { r, last, tick } = recorder()
    r.leaving(by)
    tick(10)
    r.systemEnding()
    expect(last()).toMatchObject({ by })
  })

  it('an end called off is no end', () => {
    const { r, last } = recorder()
    r.systemEnding()
    r.systemEndingCancelled()
    expect(last()).toBeNull()
    r.leaving('parent')
    expect(last()).toMatchObject({ by: 'parent' })
    expect(systemEndOf(last())).toBeNull()
  })

  it('writes nothing once the folder is the next host’s', () => {
    const { r, written } = recorder()
    r.leaving('swap')
    r.close()
    r.systemEnding()
    expect(written).toEqual([{ v: 1, by: 'swap', at: 1_000 }])
  })
})

describe('the record in the data folder', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs.splice(0)) await removeTree(d)
  })
  const folder = () => {
    const d = tempRoot('cc-ending-')
    dirs.push(d)
    return d
  }

  it('is removed when an end is called off before any leave', () => {
    const dir = folder()
    const r = new EndingRecorder({ write: writeEndingRecord(dir) })
    r.systemEnding()
    expect(existsSync(join(dir, ENDING_FILE))).toBe(true)
    r.systemEndingCancelled()
    expect(takeEndingRecord(dir)).toBeNull()
  })

  it('is read once: the start that takes it removes it', () => {
    const dir = folder()
    writeEndingRecord(dir)({ v: 1, by: 'system', at: 5, systemAt: 4 })
    expect(takeEndingRecord(dir)).toEqual({ v: 1, by: 'system', at: 5, systemAt: 4 })
    expect(existsSync(join(dir, ENDING_FILE))).toBe(false)
    expect(takeEndingRecord(dir)).toBeNull()
  })

  it.each([['text that is not JSON', '{"v":1,"by":"sys'], ['a system end with no time', '{"v":1,"by":"system","at":5}'], ['another version', '{"v":2,"by":"quit","at":5}']])(
    'is no record when it holds %s',
    (_, text) => {
      const dir = folder()
      writeFileSync(join(dir, ENDING_FILE), text)
      expect(takeEndingRecord(dir)).toBeNull()
      expect(existsSync(join(dir, ENDING_FILE))).toBe(false)
    },
  )
})

describe('whether a signal is the system ending', () => {
  const answers = (system: string, user: string) => async (args: string[]) => (args[0] === '--user' ? user : system)

  it('asks systemd on Linux: the manager, or the user’s at a sign-out, is stopping', async () => {
    expect(await systemIsStopping({ platform: 'linux', ask: answers('stopping\n', 'running\n') })).toBe(true)
    expect(await systemIsStopping({ platform: 'linux', ask: answers('running\n', 'stopping\n') })).toBe(true)
    expect(await systemIsStopping({ platform: 'linux', ask: answers('running\n', 'degraded\n') })).toBe(false)
  })

  it('is not, where systemd cannot be asked or does not answer in time', async () => {
    expect(await systemIsStopping({ platform: 'linux', ask: () => Promise.reject(new Error('ENOENT')) })).toBe(false)
    expect(await systemIsStopping({ platform: 'linux', ask: () => new Promise(() => {}), timeoutMs: 20 })).toBe(false)
  })

  it.each(['darwin', 'win32'] as const)('is not on %s: a signal alone does not say who sent it', async (platform) => {
    let asked = false
    expect(await systemIsStopping({ platform, ask: async () => ((asked = true), 'stopping') })).toBe(false)
    expect(asked).toBe(false)
  })
})
