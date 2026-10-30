/** The file of full credentials used on a `centralu serve` host (#1712), on the in-memory OS of each family */
import { describe, expect, it } from 'vitest'
import { credentialCheck, credentialsReport, encodeUsedRecord, parseUsedRecords, UsedCredentials, usedEvent, verifierOf, WITHDRAWN_KEPT_MS, type FullCredential, type UsedRecord } from './serve-credentials.js'
import { UsedCredentialsFile, usedCredentialsPath } from './used-credentials-file.js'
import type { Os } from '../os/port.js'
import { memoryOs } from '../os/memory.js'

const c = (id: string, label: string, o: Partial<FullCredential> = {}): FullCredential => ({ id, label, verifier: verifierOf(id), created: 1, replaced: false, ...o })
/** The n-th id, in order */
const idOf = (n: number): string => n.toString(16).padStart(8, '0')
const recordOf = (n: number, o: Partial<UsedRecord> = {}): UsedRecord => ({ id: idOf(n), verifier: verifierOf(idOf(n)), label: 'x', created: n, replaced: false, ...o })

/** An `Os` whose file reads are counted: the bytes `readSync` and `readFileSync` took */
function counted(os: Os) {
  const read = { bytes: 0 }
  const files = new Proxy(os.files, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown
      if (typeof value !== 'function') return value
      const fn = value as (...a: unknown[]) => unknown
      if (key === 'readSync') {
        return (...a: unknown[]) => {
          const n = fn.apply(target, a) as number
          read.bytes += n
          return n
        }
      }
      if (key === 'readFileSync') {
        return (...a: unknown[]) => {
          const out = fn.apply(target, a) as { length: number }
          read.bytes += out.length
          return out
        }
      }
      return fn.bind(target)
    },
  })
  return { os: new Proxy(os, { get: (target, key) => (key === 'files' ? files : Reflect.get(target, key, target)) }), read }
}

describe.each(['posix', 'windows'] as const)('the record of used full credentials, kept in a file (#1712), on %s', (family) => {
  /** A data folder, and hosts that start in it one after the other, as a restart does */
  function folder() {
    const os = memoryOs({ as: family })
    const dir = os.paths.path.join(os.env.home, 'data')
    os.files.mkdirSync(dir, { recursive: true })
    const serveState = os.paths.path.join(dir, 'serve.json')
    const file = usedCredentialsPath(serveState, os)
    const said: string[] = []
    /** What a host does at a full hello (main.ts `onFullHello`) */
    const host = (max?: number, osOf: Os = os) => {
      const used = new UsedCredentials(max)
      const store = new UsedCredentialsFile(file, used, osOf, max, (l) => said.push(l))
      store.load()
      return {
        used,
        store,
        hello: (cred: FullCredential) => {
          const first = used.saw(cred)
          if (first) store.add(first)
          return first
        },
      }
    }
    return { os, serveState, file, host, said }
  }

  it('is written at the first use, so a host that starts again reports it as gone once the file no longer names it', () => {
    const f = folder()
    f.host().hello(c('aaaaaaaa', 'x'))
    // The host is stopped right after and starts again: a new process, the same folder
    const again = f.host()
    expect(credentialsReport(f.serveState, () => JSON.stringify({ v: 2, key: 'k', full: [] }), again.used).credentials).toEqual([
      { id: 'aaaaaaaa', label: 'x', created: 1, replaced: false, gone: true },
    ])
  })

  it('counts a credential once, in memory and in the file, however often it says hello and across a restart', () => {
    const f = folder()
    const first = f.host()
    expect(first.hello(c('aaaaaaaa', 'x'))).not.toBeNull()
    expect(first.hello(c('aaaaaaaa', 'x'))).toBeNull()
    const again = f.host()
    // Read back from the file, then used again: not new, so not written or told a second time
    expect(again.hello(c('aaaaaaaa', 'x'))).toBeNull()
    expect(f.os.files.readFileSync(f.file, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(again.used.gone([])).toHaveLength(1)
    // Another secret under the same id is another credential
    expect(again.hello(c('aaaaaaaa', 'y', { verifier: verifierOf('other') }))).not.toBeNull()
    expect(f.host().used.gone([])).toHaveLength(2)
  })

  it('does not write the launcher’s own one-call credential, and keeps the verifier but never a credential', () => {
    const f = folder()
    const h = f.host()
    expect(h.hello(c('aaaaaaaa', 'handover', { via: 'handover' }))).toBeNull()
    expect(f.os.files.existsSync(f.file)).toBe(false)
    h.hello(c('bbbbbbbb', 'x'))
    // The verifier is on disk as in serve.json beside it
    expect(f.os.files.readFileSync(f.file, 'utf8')).toContain(verifierOf('bbbbbbbb'))
  })

  it('skips a line cut short by a stop and one written by hand, and keeps the rest', () => {
    const good = encodeUsedRecord({ id: 'aaaaaaaa', verifier: verifierOf('a'), label: 'x', created: 1, replaced: false })
    const lines = [good, '{"v":1,"id":"bbbbbbbb","verifier":"abc', 'not json', `{"v":1,"id":"zz","label":"x","verifier":"${verifierOf('b')}"}`, `{"v":2,"id":"cccccccc","label":"x","verifier":"${verifierOf('b')}"}`]
    expect(parseUsedRecords(lines.join('\n')).map((r) => r.id)).toEqual(['aaaaaaaa'])
  })

  it('starts empty, and says why, when the file cannot be read; a host before this one wrote none', () => {
    const f = folder()
    expect(f.host().used.gone([])).toEqual([])
    expect(f.said).toEqual([])
    // A folder where the file should be: not a reason for the host not to start
    f.os.files.mkdirSync(f.file)
    expect(f.host().used.gone([])).toEqual([])
    expect(f.said.join()).toContain('cannot be read')
  })

  it('lets the hello go on when the record cannot be written, and says so', () => {
    const f = folder()
    f.os.files.mkdirSync(f.file)
    const h = f.host()
    expect(() => h.hello(c('aaaaaaaa', 'x'))).not.toThrow()
    expect(f.said.join()).toContain('could not be written down')
    // Still in memory, for the next read
    expect(h.used.gone([])).toHaveLength(1)
  })

  it('keeps at most what the memory keeps, the oldest dropped, and rewrites a file that grew far past it', () => {
    const f = folder()
    const h = f.host(2)
    for (const id of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd', 'eeeeeeee', 'ffffffff', '11111111', '22222222', '33333333']) h.hello(c(id, 'x'))
    // 9 added, 2 kept; rewritten once it held more than 2 * 4
    expect(f.os.files.readFileSync(f.file, 'utf8').trim().split('\n').length).toBeLessThanOrEqual(3)
    expect(f.host(2).used.records().map((r) => r.id)).toEqual(['22222222', '33333333'])
  })

  it('writes a first use without reading the file back, and counts its line where it stands (#1715 recheck: the read-back cost milliseconds on Windows)', () => {
    const f = folder()
    const { os, read } = counted(f.os)
    const h = f.host(256, os)
    for (let i = 1; i <= 3; i++) h.hello(c(idOf(i), 'x'))
    read.bytes = 0
    expect(h.hello(c(idOf(4), 'x'))).not.toBeNull()
    expect(read.bytes).toBe(0)
    // The next report reads nothing of it, and a line another program adds after it is read once, alone
    h.store.refresh()
    expect(read.bytes).toBe(0)
    const line = encodeUsedRecord(recordOf(5))
    f.os.files.appendFileSync(f.file, line)
    h.store.refresh()
    h.store.refresh()
    expect(read.bytes).toBe(line.length)
    expect(h.used.records().map((r) => r.id)).toEqual([1, 2, 3, 4, 5].map(idOf))
    expect(f.host().used.records().map((r) => r.id)).toEqual([1, 2, 3, 4, 5].map(idOf))
  })

  it('leaves its line to the next report when the file is not as long as what was read: another host wrote first, the file was replaced, or it ends in a cut line', () => {
    const f = folder()
    const mine = f.host()
    const other = f.host()
    other.hello(c(idOf(1), 'x'))
    // Another host added a line this one has not read: this use is written after it, and the report reads both, in the file's order
    mine.hello(c(idOf(2), 'x'))
    mine.store.refresh()
    expect(mine.used.records().map((r) => r.id)).toEqual([idOf(1), idOf(2)])
    mine.store.refresh()
    expect(mine.used.records().map((r) => r.id)).toEqual([idOf(1), idOf(2)])
    // The file replaced by another of the same length (a rename over it): not the one read, so not counted as read
    const tmp = `${f.file}.other`
    f.os.files.writeFileSync(tmp, f.os.files.readFileSync(f.file, 'utf8'))
    f.os.files.renameSync(tmp, f.file)
    mine.hello(c(idOf(3), 'x'))
    mine.store.refresh()
    expect(f.host().used.records().map((r) => r.id)).toEqual([idOf(1), idOf(2), idOf(3)])
    expect(mine.used.records().map((r) => r.id)).toEqual([idOf(1), idOf(2), idOf(3)])
    // Cut short by a stop: the use that follows is on a line of its own, and is read
    f.os.files.appendFileSync(f.file, '{"v":1,"id":"cc')
    mine.hello(c(idOf(4), 'x'))
    mine.store.refresh()
    expect(f.host().used.records().map((r) => r.id)).toEqual([1, 2, 3, 4].map(idOf))
  })

  it('shortens a file that grows past what is kept even when no report ever reads it', () => {
    const f = folder()
    const mine = f.host(2)
    const other = f.host(2)
    // Every use of this host is written after a line it has not read: none is counted at the write
    for (let i = 1; i <= 12; i++) {
      other.hello(c(idOf(100 + i), 'y'))
      mine.hello(c(idOf(i), 'x'))
    }
    expect(f.os.files.readFileSync(f.file, 'utf8').trim().split('\n').length).toBeLessThan(24)
  })

  it('takes in a line another host of the folder wrote since it started, at its next report', () => {
    const f = folder()
    const mine = f.host()
    const other = f.host()
    other.hello(c('aaaaaaaa', 'x'))
    expect(mine.used.gone([])).toEqual([])
    // The host being replaced in a swap went on serving after this one read the file
    const store = new UsedCredentialsFile(f.file, mine.used, f.os, 256, () => {})
    store.refresh()
    expect(mine.used.gone([]).map((g) => g.id)).toEqual(['aaaaaaaa'])
    store.refresh()
    expect(mine.used.ids()).toEqual(['aaaaaaaa'])
  })

  it('reads the lines a later build adds after these, whatever else they hold', () => {
    const f = folder()
    f.host().hello(c('aaaaaaaa', 'x'))
    f.os.files.appendFileSync(f.file, `${JSON.stringify({ v: 1, id: 'bbbbbbbb', label: 'y', verifier: verifierOf('b'), created: 2, replaced: true, later: 'field' })}\n`)
    expect(f.host().used.records().map((r) => r.id)).toEqual(['aaaaaaaa', 'bbbbbbbb'])
  })

  it('holds the file’s newest records however often it is read, and a use made with no hub linked shows at every read and after a restart (more in the file than are kept)', () => {
    const f = folder()
    // A host before this one left 30 records; this one keeps 8 and rewrites the file past 32 lines
    f.os.files.writeFileSync(f.file, Array.from({ length: 30 }, (_, i) => encodeUsedRecord(recordOf(i + 1))).join(''))
    const h = f.host(8)
    const ids = () => h.used.records().map((r) => Number.parseInt(r.id, 16))
    expect(ids()).toEqual([23, 24, 25, 26, 27, 28, 29, 30])
    // Read again and again: the same newest 8, not the older half put back as newest and the newest dropped
    for (let i = 0; i < 4; i++) {
      h.store.refresh()
      expect(ids()).toEqual([23, 24, 25, 26, 27, 28, 29, 30])
    }
    // A use of something paired, used and withdrawn with no hub linked
    expect(h.hello(c(idOf(31), 'x'))).not.toBeNull()
    for (let i = 0; i < 4; i++) {
      h.store.refresh()
      expect(ids()).toEqual([24, 25, 26, 27, 28, 29, 30, 31])
      expect(h.used.gone([]).map((g) => g.id)).toContain(idOf(31))
    }
    // The hub's own link, and a window, say hello: the file passes 32 lines and is rewritten from the memory
    h.hello(c(idOf(32), 'hub:test-0123abcd'))
    h.hello(c(idOf(33), 'window'))
    expect(f.os.files.readFileSync(f.file, 'utf8').trim().split('\n')).toHaveLength(8)
    for (let i = 0; i < 4; i++) {
      h.store.refresh()
      expect(ids()).toEqual([26, 27, 28, 29, 30, 31, 32, 33])
      expect(h.used.gone([]).map((g) => g.id)).toContain(idOf(31))
    }
    // And after a restart, with the file as it was left
    const again = f.host(8)
    expect(again.used.records().map((r) => r.id)).toContain(idOf(31))
    expect(again.used.ids()).toContain(idOf(31))
    expect(again.used.gone([]).map((g) => g.id)).toContain(idOf(31))
  })

  it('keeps a credential whose newest line is among the kept ones when an older line of it is far back', () => {
    const f = folder()
    // Used long ago, then 12 others, then written again (a record evicted from memory is new at its next hello)
    const lines = [recordOf(1), ...Array.from({ length: 12 }, (_, i) => recordOf(i + 2)), recordOf(1)]
    f.os.files.writeFileSync(f.file, lines.map(encodeUsedRecord).join(''))
    const h = f.host(8)
    expect(h.used.ids()).toContain(idOf(1))
    expect(h.used.ids()).toHaveLength(8)
    expect(h.hello(c(idOf(1), 'x'))).toBeNull()
  })

  it('writes a newline first when the file ends in a line that was cut short, so the next record is not lost with it', () => {
    const f = folder()
    f.os.files.writeFileSync(f.file, `${encodeUsedRecord(recordOf(1))}{"v":1,"id":"bbbbbbbb","verif`)
    const h = f.host()
    expect(h.used.ids()).toEqual([idOf(1)])
    expect(h.hello(c(idOf(2), 'x'))).not.toBeNull()
    // Still read by this host (its memory), and by one that starts after it
    expect(h.used.ids()).toEqual([idOf(1), idOf(2)])
    expect(f.host().used.ids()).toEqual([idOf(1), idOf(2)])
    // A file that ends in a newline gets no empty line before the record
    const g = folder()
    g.host().hello(c(idOf(1), 'x'))
    g.host().hello(c(idOf(2), 'x'))
    expect(g.os.files.readFileSync(g.file, 'utf8')).not.toMatch(/\n\n/)
    expect(g.os.files.readFileSync(g.file, 'utf8').split('\n')).toHaveLength(3)
  })

  it('reads a line cut short once it is finished, and not before', () => {
    const f = folder()
    const h = f.host()
    const line = encodeUsedRecord(recordOf(1))
    f.os.files.appendFileSync(f.file, line.slice(0, 30))
    h.store.refresh()
    expect(h.used.ids()).toEqual([])
    f.os.files.appendFileSync(f.file, line.slice(30))
    h.store.refresh()
    expect(h.used.ids()).toEqual([idOf(1)])
  })

  it('reads the lines another program appended once, and not again at every report', () => {
    const f = folder()
    const { os, read } = counted(f.os)
    const h = f.host(256, os)
    const foreign = Array.from({ length: 3000 }, (_, i) => encodeUsedRecord(recordOf(i + 1))).join('')
    f.os.files.appendFileSync(f.file, foreign)
    read.bytes = 0
    h.store.refresh()
    expect(read.bytes).toBeGreaterThanOrEqual(foreign.length)
    expect(read.bytes).toBeLessThan(foreign.length + 1024)
    // Nothing new: nothing read, however many reports
    read.bytes = 0
    for (let i = 0; i < 5; i++) h.store.refresh()
    expect(read.bytes).toBe(0)
    // One line more: that line, not the file
    f.os.files.appendFileSync(f.file, encodeUsedRecord(recordOf(3001)))
    read.bytes = 0
    h.store.refresh()
    expect(read.bytes).toBeLessThan(400)
    expect(h.used.records().at(-1)?.id).toBe(idOf(3001))
  })

  it('takes at most a set size of new lines at a read, the newest, and says so', () => {
    const f = folder()
    const used = new UsedCredentials()
    const h = new UsedCredentialsFile(f.file, used, f.os, 256, (l) => f.said.push(l), 2048)
    f.os.files.writeFileSync(f.file, Array.from({ length: 200 }, (_, i) => encodeUsedRecord(recordOf(i + 1))).join(''))
    h.load()
    const ids = used.records().map((r) => Number.parseInt(r.id, 16))
    // The newest lines that fit, whole ones: it ends at the last line and starts inside the file
    expect(ids.at(-1)).toBe(200)
    expect(ids.length).toBeGreaterThan(5)
    expect(ids.length).toBeLessThan(15)
    expect(ids[0]).toBeGreaterThan(180)
    expect(f.said.join()).toContain('are taken in, the rest is skipped')
    // And the next read starts where this one ended
    f.os.files.appendFileSync(f.file, encodeUsedRecord(recordOf(201)))
    h.refresh()
    expect(used.records().at(-1)?.id).toBe(idOf(201))
    expect(f.said).toHaveLength(1)
  })

  it('reads a file that was replaced or made shorter from its start', () => {
    const f = folder()
    const h = f.host(8)
    for (let i = 1; i <= 5; i++) f.os.files.appendFileSync(f.file, encodeUsedRecord(recordOf(i)))
    h.store.refresh()
    expect(h.used.ids()).toHaveLength(5)
    // Another host shortened it (a rewrite): one record, none of the above
    f.os.files.writeFileSync(f.file, encodeUsedRecord(recordOf(9)))
    h.store.refresh()
    expect(h.used.ids()).toContain(idOf(9))
    // And removed, then made again with a record
    f.os.files.rmSync(f.file)
    h.store.refresh()
    f.os.files.writeFileSync(f.file, encodeUsedRecord(recordOf(10)))
    h.store.refresh()
    expect(h.used.ids()).toContain(idOf(10))
  })

  it('notes a withdrawn credential when it first finds it so, keeps that across a restart, and drops the record 7 days after, from memory and the file', () => {
    const f = folder()
    const h = f.host()
    h.hello(c(idOf(1), 'x'))
    h.hello(c(idOf(2), 'y'))
    const held = [{ id: idOf(2), verifier: verifierOf(idOf(2)) }]
    const t0 = Date.UTC(2026, 5, 1)
    // Found withdrawn at t0 (the second is still named, so it is not touched)
    h.store.settle(held, t0)
    expect(f.os.files.readFileSync(f.file, 'utf8')).toContain(`"goneAt":${t0}`)
    expect(h.used.ids()).toEqual([idOf(1), idOf(2)])
    // A host that starts again later keeps the clock where it was, not where it started: a restart a day does not renew it
    const day = 24 * 60 * 60 * 1000
    let restarted = f.host()
    restarted.store.settle(held, t0 + 3 * day)
    expect(restarted.used.ids()).toEqual([idOf(1), idOf(2)])
    restarted = f.host()
    restarted.store.settle(held, t0 + WITHDRAWN_KEPT_MS - 1)
    expect(restarted.used.ids()).toEqual([idOf(1), idOf(2)])
    restarted.store.settle(held, t0 + WITHDRAWN_KEPT_MS)
    expect(restarted.used.ids()).toEqual([idOf(2)])
    expect(restarted.used.gone(held)).toEqual([])
    // And from the file: a host that starts after has only the one still named
    expect(f.os.files.readFileSync(f.file, 'utf8')).not.toContain(idOf(1))
    expect(f.host().used.ids()).toEqual([idOf(2)])
  })

  it('forgets the note of a credential that serve.json names again, so a later withdrawal starts a new week and is reported, also after a restart', () => {
    const f = folder()
    const h = f.host()
    h.hello(c(idOf(1), 'x'))
    const day = 24 * 60 * 60 * 1000
    const t0 = Date.UTC(2026, 5, 1)
    const named = [{ id: idOf(1), verifier: verifierOf(idOf(1)) }]
    // Withdrawn at t0, then named again (a restored serve.json) three days after
    h.store.settle([], t0)
    h.store.settle(named, t0 + 3 * day)
    // Withdrawn again after the first note is older than a week: a new week, not the old one
    h.store.settle([], t0 + 9 * day)
    expect(h.used.ids()).toEqual([idOf(1)])
    expect(h.used.gone([]).map((g) => g.id)).toEqual([idOf(1)])
    expect(f.os.files.readFileSync(f.file, 'utf8')).toContain(`"goneAt":${t0 + 9 * day}`)
    // The week of the new note, from the file
    const restarted = f.host()
    restarted.store.settle([], t0 + 9 * day + WITHDRAWN_KEPT_MS - 1)
    expect(restarted.used.ids()).toEqual([idOf(1)])
    restarted.store.settle([], t0 + 9 * day + WITHDRAWN_KEPT_MS)
    expect(restarted.used.ids()).toEqual([])
    // A restart between the restore and the second withdrawal does not bring the first note back
    const g = folder()
    const first = g.host()
    first.hello(c(idOf(1), 'x'))
    first.store.settle([], t0)
    first.store.settle(named, t0 + 3 * day)
    const second = g.host()
    expect(second.used.records()).toEqual([{ id: idOf(1), verifier: verifierOf(idOf(1)), label: 'x', created: 1, replaced: false }])
    second.store.settle([], t0 + 9 * day)
    expect(second.used.ids()).toEqual([idOf(1)])
  })

  it('notes nothing withdrawn while serve.json cannot be read, and never drops a credential still named', () => {
    const f = folder()
    const h = f.host()
    h.hello(c(idOf(1), 'x'))
    // credentialsReport tells `settle` only what it read: nothing when it cannot read the file
    const settled: unknown[] = []
    credentialsReport(f.serveState, () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }, h.used, undefined, (l) => settled.push(l))
    expect(settled).toEqual([])
    const named = JSON.stringify({ v: 2, key: 'k', full: [{ id: idOf(1), label: 'x', verifier: verifierOf(idOf(1)), created: 1 }] })
    const report = credentialsReport(f.serveState, () => named, h.used, undefined, (l) => h.store.settle(l, Date.now() + 365 * 24 * 60 * 60 * 1000))
    expect(report.usedIds).toEqual([idOf(1)])
    expect(f.os.files.readFileSync(f.file, 'utf8')).not.toContain('goneAt')
  })
})

describe('the record in memory', () => {
  it('counts a credential once however many lines name it: it keeps the place of its first use, whichever way it is read again', () => {
    const used = new UsedCredentials()
    const a = recordOf(1, { label: 'x' })
    const b = recordOf(2, { label: 'x' })
    used.load([a, b])
    // Read again, the file replaced by one that holds only the first (a swap's rewrite, a re-read from its start)
    used.load([a])
    expect(used.records().map((r) => r.id)).toEqual([idOf(2), idOf(1)])
    expect(used.ids().sort()).toEqual([idOf(1), idOf(2)])
    // The first is still the earlier use: the second is its pairer again, so only the second is news
    expect(used.gone([]).map((g) => g.id)).toEqual([idOf(2)])
  })

  it('drops the one whose newest line is the oldest, not the one used longest ago', () => {
    const used = new UsedCredentials(2)
    used.load([recordOf(1), recordOf(2), recordOf(3)])
    expect(used.ids().sort()).toEqual([idOf(2), idOf(3)])
    // Used again: known, so no new line and no new place
    expect(used.saw({ ...c(idOf(2), 'x'), verifier: verifierOf(idOf(2)) })).toBeNull()
    used.load([recordOf(4)])
    expect(used.ids().sort()).toEqual([idOf(3), idOf(4)])
  })
})

describe('what a hub is told (#1712)', () => {
  it('carries the record without its verifier, and a check of its own nonce that only a holder of the secret can make', () => {
    const rec = { id: 'aaaaaaaa', verifier: verifierOf('secret'), label: 'x', created: 5, replaced: false }
    const e = usedEvent(rec, 'bm9uY2Vub25jZQ')
    expect(e).toEqual({ type: 'host_credential_used', credential: { id: 'aaaaaaaa', label: 'x', created: 5, replaced: false, nonce: 'bm9uY2Vub25jZQ', check: credentialCheck(verifierOf('secret'), 'bm9uY2Vub25jZQ') } })
    expect(JSON.stringify(e)).not.toContain(rec.verifier)
    // A fresh nonce each time, so a check of one event is not another's
    expect(usedEvent(rec).credential.nonce).not.toBe(usedEvent(rec).credential.nonce)
  })
})
