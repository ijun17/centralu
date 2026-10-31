/** A `centralu serve` host's full credentials, as serve.json's verifiers (#1405) */
import { describe, expect, it } from 'vitest'
import { credentialCheck, credentialsReport, isFullCredential, LAST_READ_KEPT_MS, readCredentialFile, UsedCredentials, verifierOf, type FullCredential } from './serve-credentials.js'

const KEY = 'k'.repeat(43)
const HUB = 'h'.repeat(43)
const WINDOW = 'w'.repeat(43)
const entry = (id: string, token: string) => ({ id, label: id, verifier: verifierOf(token), created: 1 })

describe('reading the full credentials', () => {
  it('reads each entry of a version 2 file, and none of anything else', () => {
    const file = JSON.stringify({ v: 2, key: KEY, port: 1, full: [entry('aaaaaaaa', HUB), { id: 'bad', verifier: 'not hex' }, entry('bbbbbbbb', WINDOW)] })
    expect(readCredentialFile('v2', () => file).full.map((c) => c.id)).toEqual(['aaaaaaaa', 'bbbbbbbb'])
    expect(readCredentialFile('v1', () => JSON.stringify({ v: 1, token: HUB })).full).toEqual([])
    expect(readCredentialFile('half', () => 'half', () => {}).full).toEqual([])
  })

  it('takes only an entry of the shape the launcher lists and --revoke takes: an 8-hex id and a label', () => {
    const v = verifierOf(HUB)
    const file = JSON.stringify({
      v: 2,
      key: KEY,
      full: [
        { id: 'aaaaaaaa', verifier: v },
        { id: 'zz', label: 'hand', verifier: v },
        { id: 'AAAAAAAA', label: 'hand', verifier: v },
        { id: 'aaaaaaaa', label: 'two words', verifier: v },
        { id: 'aaaaaaaa', label: '', verifier: v },
        { id: 'aaaaaaaa', label: 'x'.repeat(81), verifier: v },
        { id: 'cccccccc', label: 'hub:laptop-0123abcd', verifier: v },
      ],
    })
    expect(readCredentialFile('shapes', () => file).full.map((c) => c.id)).toEqual(['cccccccc'])
  })

  it('lists each credential the host takes as a hub row shows it, never its verifier, and none of a file it cannot read', () => {
    const file = JSON.stringify({
      v: 2,
      key: KEY,
      full: [{ ...entry('aaaaaaaa', HUB), replaced: true }, { id: 'zz', label: 'hand', verifier: verifierOf(HUB) }, entry('bbbbbbbb', WINDOW)],
    })
    const listed = (read: () => string) => credentialsReport('l', read, new UsedCredentials()).credentials
    expect(listed(() => file)).toEqual([
      { id: 'aaaaaaaa', label: 'aaaaaaaa', created: 1, replaced: true },
      { id: 'bbbbbbbb', label: 'bbbbbbbb', created: 1, replaced: false },
    ])
    expect(JSON.stringify(listed(() => file))).not.toContain(verifierOf(HUB))
    expect(listed(() => 'half')).toBeNull()
    expect(listed(() => JSON.stringify({ v: 1, token: HUB }))).toBeNull()
  })

  it('reads again when the file is caught mid-replace, and names none when it stays unreadable', () => {
    let reads = 0
    const flaky = () => (++reads < 3 ? '' : JSON.stringify({ v: 2, key: KEY, full: [entry('aaaaaaaa', HUB)] }))
    expect(readCredentialFile('flaky', flaky, () => {}).full).toHaveLength(1)
    expect(readCredentialFile('never-read', () => { throw new Error('EBUSY') }, () => {}).full).toEqual([])
    // Held past the retries (a scanner on Windows): none for a new hello, what it said last for a socket already in
    const good = JSON.stringify({ v: 2, key: KEY, full: [entry('aaaaaaaa', HUB)] })
    expect(readCredentialFile('held', () => good, () => {}).full).toHaveLength(1)
    const held = readCredentialFile('held', () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) }, () => {})
    expect(held.full).toEqual([])
    expect(held.open.map((c) => c.id)).toEqual(['aaaaaaaa'])
    expect(held.unreadable?.code).toBe('EBUSY')
  })

  // #1405 review: chmod 000 on serve.json kept a credential paired just before at full rights for 30 s, unlisted
  it('names no credential for a new hello while the file is refused, and says since when and why', () => {
    let t = 5_000
    const good = JSON.stringify({ v: 2, key: KEY, full: [entry('aaaaaaaa', HUB)] })
    const denied = () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    }
    expect(readCredentialFile('denied', () => good, () => {}, () => t)).toMatchObject({ unreadable: null })
    expect(readCredentialFile('denied', denied, () => {}, () => t)).toMatchObject({ full: [], unreadable: { code: 'EACCES', since: 5_000 } })
    t += 1_000
    expect(readCredentialFile('denied', denied, () => {}, () => t).unreadable).toEqual({ code: 'EACCES', since: 5_000 })
    // Readable again: no longer said
    expect(readCredentialFile('denied', () => good, () => {}, () => t)).toMatchObject({ unreadable: null, full: [{ id: 'aaaaaaaa' }] })
  })

  it('names none once the file is gone, though it named some before (#1405 review: moved aside)', () => {
    const good = JSON.stringify({ v: 2, key: KEY, full: [entry('aaaaaaaa', HUB)] })
    expect(readCredentialFile('moved', () => good, () => {}).full).toHaveLength(1)
    const gone = () => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    }
    expect(readCredentialFile('moved', gone, () => {}).full).toEqual([])
    // And a refused read after that does not bring the old list back
    expect(readCredentialFile('moved', () => { throw new Error('EBUSY') }, () => {}).full).toEqual([])
  })

  it('keeps the last list for a socket already in only for a while, then names none', () => {
    let t = 1_000
    const good = JSON.stringify({ v: 2, key: KEY, full: [entry('aaaaaaaa', HUB)] })
    const busy = () => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
    }
    expect(readCredentialFile('busy', () => good, () => {}, () => t).full).toHaveLength(1)
    t += LAST_READ_KEPT_MS
    expect(readCredentialFile('busy', busy, () => {}, () => t).open).toHaveLength(1)
    t += 1
    expect(readCredentialFile('busy', busy, () => {}, () => t).open).toEqual([])
  })

  it('takes a credential whose hash is one of them, and nothing else', () => {
    const full: FullCredential[] = [entry('aaaaaaaa', HUB)]
    expect(isFullCredential(full, HUB)?.id).toBe('aaaaaaaa')
    expect(isFullCredential(full, WINDOW)).toBeNull()
    expect(isFullCredential(full, verifierOf(HUB))).toBeNull()
  })
})

describe('the full credentials used here (#1405 review)', () => {
  const c = (id: string, label: string, o: Partial<FullCredential> = {}): FullCredential => ({ id, label, verifier: verifierOf(id), created: 1, replaced: false, ...o })

  it('lists one used and then withdrawn before any read, as gone: pair, hello, revoke within 135 ms', () => {
    const used = new UsedCredentials()
    used.saw(c('aaaaaaaa', 'x'))
    expect(used.gone([{ id: 'aaaaaaaa' }])).toEqual([])
    expect(used.gone([])).toEqual([{ id: 'aaaaaaaa', label: 'x', created: 1, replaced: false, gone: true }])
  })

  it('leaves out a credential its own pairer took the place of: the window at each start, a hub at each link', () => {
    const used = new UsedCredentials()
    used.saw(c('aaaaaaaa', 'window', { via: 'window' }))
    used.saw(c('bbbbbbbb', 'window', { via: 'window' }))
    used.saw(c('cccccccc', 'hub:mac-0123abcd'))
    used.saw(c('dddddddd', 'hub:mac-0123abcd'))
    expect(used.gone([{ id: 'bbbbbbbb' }, { id: 'dddddddd' }])).toEqual([])
  })

  it('lists one whose successor was asked for another way, and the window credential that one took the place of', () => {
    const used = new UsedCredentials()
    used.saw(c('aaaaaaaa', 'window', { via: 'window' }))
    // `--pair window` by something else, used, then the window's next start
    used.saw(c('bbbbbbbb', 'window', { via: 'pair', replaced: true }))
    used.saw(c('cccccccc', 'window', { via: 'window', replaced: true }))
    expect(used.gone([{ id: 'cccccccc' }]).map((g) => g.id)).toEqual(['aaaaaaaa', 'bbbbbbbb'])
    // A later routine start does not hide what came before it
    used.saw(c('dddddddd', 'window', { via: 'window' }))
    expect(used.gone([{ id: 'dddddddd' }]).map((g) => g.id)).toEqual(['aaaaaaaa', 'bbbbbbbb'])
  })

  it("keeps nothing of the launcher's own one-call credential, and at most its bound", () => {
    const used = new UsedCredentials(2)
    used.saw(c('aaaaaaaa', 'handover', { via: 'handover' }))
    expect(used.gone([])).toEqual([])
    for (const id of ['11111111', '22222222', '33333333']) used.saw(c(id, id))
    expect(used.gone([]).map((g) => g.id)).toEqual(['22222222', '33333333'])
  })

  // #1405 review: hub 1 paired again; hub 2's next read, before hub 1's new credential said hello, listed hub 1's last as gone
  it('leaves out one whose label the file names again, paired the same way, before that one said hello here', () => {
    const used = new UsedCredentials()
    used.saw(c('aaaaaaaa', 'hub:studio-0123abcd'))
    expect(used.gone([{ id: 'bbbbbbbb', label: 'hub:studio-0123abcd', replaced: false }])).toEqual([])
    // Asked for another way, it is a change: listed
    expect(used.gone([{ id: 'bbbbbbbb', label: 'hub:studio-0123abcd', replaced: true }]).map((g) => g.id)).toEqual(['aaaaaaaa'])
  })

  // #1405 review: a hub's label taken while its link was down, used, withdrawn; the hub's next link left no trace
  it('gives every credential used under a hub label, listed or gone, by first use, for that hub to check', () => {
    const used = new UsedCredentials()
    used.saw(c('aaaaaaaa', 'hub:mac-0123abcd'))
    used.saw(c('bbbbbbbb', 'window', { via: 'window' }))
    used.saw(c('cccccccc', 'hub:mac-0123abcd'))
    used.saw(c('dddddddd', 'hub:mac-0123abcd'))
    used.saw(c('aaaaaaaa', 'hub:mac-0123abcd'))
    // The host takes each hub-label one for its pairer again (the window's, with nothing after it, is listed)
    expect(used.gone([{ id: 'dddddddd', label: 'hub:mac-0123abcd', replaced: false }]).map((g) => g.id)).toEqual(['bbbbbbbb'])
    expect(used.underHubLabels().map((u) => u.id)).toEqual(['aaaaaaaa', 'cccccccc', 'dddddddd'])
  })

  it('answers host.credentials with the list, those gone, the hub-label ids, and why the file cannot be read (#1405 review)', () => {
    const used = new UsedCredentials()
    used.saw(c('aaaaaaaa', 'x'))
    used.saw(c('cccccccc', 'hub:mac-0123abcd'))
    const file = JSON.stringify({ v: 2, key: KEY, full: [{ ...entry('cccccccc', HUB), label: 'hub:mac-0123abcd' }] })
    expect(credentialsReport('report', () => file, used)).toEqual({
      credentials: [
        { id: 'cccccccc', label: 'hub:mac-0123abcd', created: 1, replaced: false },
        { id: 'aaaaaaaa', label: 'x', created: 1, replaced: false, gone: true },
      ],
      unreadable: null,
      usedUnderHubLabels: [{ id: 'cccccccc', label: 'hub:mac-0123abcd', created: 1 }],
      // Every id in the record, also one the list leaves out (#1712)
      usedIds: ['aaaaaaaa', 'cccccccc'],
    })
    const denied = () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    }
    expect(credentialsReport('report-denied', denied, used)).toMatchObject({ credentials: null, unreadable: 'EACCES' })
  })

  // #1405 review: a hub tells its own credential from one that only reuses its id by a check of its nonce, never by a verifier
  it('gives each entry a check of the hub’s nonce, keeps a reused id with another secret apart, and never gives a verifier', () => {
    const used = new UsedCredentials()
    used.saw({ ...c('cccccccc', 'hub:mac-0123abcd'), verifier: verifierOf(HUB) })
    used.saw({ ...c('cccccccc', 'hub:mac-0123abcd'), verifier: verifierOf('another secret'), created: 2 })
    const file = JSON.stringify({ v: 2, key: KEY, full: [{ ...entry('cccccccc', HUB), label: 'hub:mac-0123abcd' }] })
    const r = credentialsReport('report-check', () => file, used, 'nonce-nonce')
    expect(r.usedUnderHubLabels.map((u) => u.check)).toEqual([credentialCheck(verifierOf(HUB), 'nonce-nonce'), credentialCheck(verifierOf('another secret'), 'nonce-nonce')])
    // Both used under one id, one listed: the host takes the other for the pairer again (same way, same label), the hub tells
    expect(r.credentials?.map((e) => [e.id, e.gone === true, e.check])).toEqual([['cccccccc', false, credentialCheck(verifierOf(HUB), 'nonce-nonce')]])
    // Not listed (a different secret under the id), under another label: it is gone, by its own check
    const gone = new UsedCredentials()
    gone.saw({ ...c('cccccccc', 'x'), verifier: verifierOf('another secret') })
    expect(credentialsReport('report-check', () => file, gone, 'nonce-nonce').credentials?.map((e) => [e.id, e.gone === true, e.check])).toEqual([
      ['cccccccc', false, credentialCheck(verifierOf(HUB), 'nonce-nonce')],
      ['cccccccc', true, credentialCheck(verifierOf('another secret'), 'nonce-nonce')],
    ])
    expect(JSON.stringify(r)).not.toContain(verifierOf('another secret'))
    // No nonce asked: no check at all
    expect(JSON.stringify(credentialsReport('report-check', () => file, used))).not.toContain('check')
  })
})

// What a host does with them at hello, over a real socket: transport/limited-token.test.ts
