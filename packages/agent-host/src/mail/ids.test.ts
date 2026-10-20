import { describe, expect, it } from 'vitest'
import { CENTRALU, PERSON, appAddress, hostOf, parseAddress, sessionAddress } from './address.js'
import { UlidMaker, messageIdOf, parseMailId, threadIdOf } from './ids.js'

describe('ids (§11.4)', () => {
  it('a thread id is <hostId>.t_<ulid> and a message id <hostId>.m_<ulid>, and each parses back', () => {
    const ulid = new UlidMaker().next(1_800_000_000_000)
    expect(ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(threadIdOf('hub-1a2b3c4d', ulid)).toBe(`hub-1a2b3c4d.t_${ulid}`)
    expect(parseMailId(threadIdOf('hub-1a2b3c4d', ulid))).toEqual({ host: 'hub-1a2b3c4d', kind: 'thread', ulid })
    expect(parseMailId(messageIdOf('hub-1a2b3c4d', ulid))).toEqual({ host: 'hub-1a2b3c4d', kind: 'message', ulid })
  })

  it('what is not an id does not parse: a wrong length, a letter Crockford leaves out, lower case, no host, another prefix', () => {
    const ulid = new UlidMaker().next(1_800_000_000_000)
    for (const bad of [
      `hub-1a2b3c4d.t_${ulid.slice(1)}`,
      `hub-1a2b3c4d.t_${ulid}0`,
      `hub-1a2b3c4d.t_${'U'.repeat(26)}`,
      `hub-1a2b3c4d.t_${ulid.toLowerCase()}`,
      `t_${ulid}`,
      `.t_${ulid}`,
      `hub-1a2b3c4d.x_${ulid}`,
      `HUB.t_${ulid}`,
      '',
    ]) {
      expect(parseMailId(bad), bad).toBeNull()
    }
  })

  it('ULIDs rise in time order, and strictly within one millisecond and when the clock steps back', () => {
    const maker = new UlidMaker()
    const seen: string[] = []
    for (let i = 0; i < 500; i++) seen.push(maker.next(1_800_000_000_000))
    seen.push(maker.next(1_799_999_999_000))
    seen.push(maker.next(1_800_000_000_001))
    expect([...seen].sort()).toEqual(seen)
    expect(new Set(seen).size).toBe(seen.length)
    // The time part orders two hosts' ids by when they were made
    const a = new UlidMaker().next(1_800_000_000_000)
    const b = new UlidMaker().next(1_800_000_001_000)
    expect(a < b).toBe(true)
  })

  it('two makers do not repeat each other', () => {
    const ids = new Set<string>()
    for (let m = 0; m < 20; m++) {
      const maker = new UlidMaker()
      for (let i = 0; i < 50; i++) ids.add(maker.next(1_800_000_000_000))
    }
    expect(ids.size).toBe(1000)
  })

  it('counts up from the random part within one millisecond, the last digit first', () => {
    const zeros = (): Uint8Array => new Uint8Array(10).fill(0x00)
    const maker = new UlidMaker(zeros)
    const first = maker.next(5)
    const second = maker.next(5)
    expect(first.slice(10)).toBe('0'.repeat(16))
    expect(second.slice(10)).toBe(`${'0'.repeat(15)}1`)
  })
})

describe('addresses (§2, §11.4)', () => {
  it('a session, an app, the person and Centralu parse; the first two carry the host', () => {
    expect(parseAddress(sessionAddress('hub-1a2b3c4d', '9f2c'))).toEqual({ kind: 'session', host: 'hub-1a2b3c4d', sessionId: '9f2c' })
    expect(parseAddress(appAddress('hub-1a2b3c4d', 'p1', 'project-board'))).toEqual({ kind: 'app', host: 'hub-1a2b3c4d', projectId: 'p1', appId: 'project-board' })
    expect(parseAddress(PERSON)).toEqual({ kind: 'person' })
    expect(parseAddress(CENTRALU)).toEqual({ kind: 'centralu' })
    expect(hostOf(parseAddress(sessionAddress('hub-1a2b3c4d', 's'))!)).toBe('hub-1a2b3c4d')
    expect(hostOf({ kind: 'person' })).toBeNull()
  })

  it('text that is not an address does not parse, and one cannot be built from a part with a separator in it', () => {
    for (const bad of ['', 'session:s1', 'session:hub-a/', 'session:/s1', 'session:hub-a/s 1', 'session:hub-a/s1/extra', 'app:hub-a/p1', 'app:hub-a/p1/b/c', 'person2', 'Centralu', 'session:hub-a/s1\n']) {
      expect(parseAddress(bad), JSON.stringify(bad)).toBeNull()
    }
    expect(() => sessionAddress('hub-a', 's/1')).toThrow('Not a mail address')
    expect(() => appAddress('hub-a', 'p1', '')).toThrow('Not a mail address')
  })
})

describe('the length of an address part (L11)', () => {
  it('is at most 64 characters, so an app id, which its author chooses, does not reach the wake frame at any length', () => {
    expect(parseAddress(appAddress('hub-1a2b3c4d', 'p1', 'a'.repeat(64)))).not.toBeNull()
    expect(() => appAddress('hub-1a2b3c4d', 'p1', 'a'.repeat(65))).toThrow('Not a mail address')
    expect(parseAddress(`app:hub-1a2b3c4d/p1/${'a'.repeat(65)}`)).toBeNull()
    expect(parseAddress(`session:hub-1a2b3c4d/${'s'.repeat(65)}`)).toBeNull()
    expect(parseAddress(`session:hub-1a2b3c4d/${'s'.repeat(64)}`)).not.toBeNull()
  })
})
