/** The file of full credentials used on a `centralu serve` host (#1712), on the in-memory OS of each family */
import { describe, expect, it } from 'vitest'
import { credentialCheck, credentialsReport, encodeUsedRecord, parseUsedRecords, UsedCredentials, usedEvent, verifierOf, type FullCredential } from './serve-credentials.js'
import { UsedCredentialsFile, usedCredentialsPath } from './used-credentials-file.js'
import { memoryOs } from '../os/memory.js'

const c = (id: string, label: string, o: Partial<FullCredential> = {}): FullCredential => ({ id, label, verifier: verifierOf(id), created: 1, replaced: false, ...o })

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
    const host = (max?: number) => {
      const used = new UsedCredentials(max)
      const store = new UsedCredentialsFile(file, used, os, max, (l) => said.push(l))
      store.load()
      return {
        used,
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

  it('reads the lines a later build adds after these, whatever else they hold', () => {
    const f = folder()
    f.host().hello(c('aaaaaaaa', 'x'))
    f.os.files.appendFileSync(f.file, `${JSON.stringify({ v: 1, id: 'bbbbbbbb', label: 'y', verifier: verifierOf('b'), created: 2, replaced: true, later: 'field' })}\n`)
    expect(f.host().used.records().map((r) => r.id)).toEqual(['aaaaaaaa', 'bbbbbbbb'])
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
