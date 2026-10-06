import { describe, expect, it } from 'vitest'
import { acceptanceKey, compareVersions, mayConnect } from './versions.js'

const side = (version: string, protocolVersion = 1, dev = false) => ({ version, protocolVersion, dev })

describe('the version check before a link connects (docs/plans/remote-hub.md §4)', () => {
  it('connects when both sides run the same version', () => {
    const v = compareVersions(side('0.1.0-beta.11'), side('0.1.0-beta.11'), false)
    expect(v).toMatchObject({ older: null, compatible: true })
    expect(mayConnect(v)).toBe(true)
  })

  it('names the older side and holds the link until the person declines to align', () => {
    const remoteOlder = compareVersions(side('0.1.0-beta.11'), side('0.1.0-beta.10'), false)
    expect(remoteOlder.older).toBe('remote')
    expect(mayConnect(remoteOlder)).toBe(false)
    const hubOlder = compareVersions(side('0.1.0-beta.10'), side('0.1.0-beta.11'), false)
    expect(hubOlder.older).toBe('hub')
    expect(mayConnect(hubOlder)).toBe(false)
    // Declined: connects as it is
    expect(mayConnect(compareVersions(side('0.1.0-beta.10'), side('0.1.0-beta.11'), true))).toBe(true)
  })

  it('never connects across protocols, accepted or not', () => {
    const v = compareVersions(side('0.2.0', 2), side('0.1.0', 1), true)
    expect(v).toMatchObject({ compatible: false, accepted: false, older: 'remote' })
    expect(mayConnect(v)).toBe(false)
  })

  it('a dev build has no newer; it connects on one protocol', () => {
    const v = compareVersions(side('0.1.0-beta.10', 1, true), side('0.1.0-beta.11'), false)
    expect(v.older).toBeNull()
    expect(mayConnect(v)).toBe(true)
    expect(mayConnect(compareVersions(side('0.1.0', 1, true), side('0.1.0', 2), false))).toBe(false)
  })

  it('does not rank a beta against a stable release', () => {
    const v = compareVersions(side('0.1.0'), side('0.2.0-beta.1'), false)
    expect(v).toMatchObject({ sameChannel: false, older: null })
    expect(mayConnect(v)).toBe(false)
  })

  it('keeps what the person accepted per pair: either side moving asks again', () => {
    expect(acceptanceKey(side('0.1.0-beta.10'), side('0.1.0-beta.11'))).not.toBe(acceptanceKey(side('0.1.0-beta.10'), side('0.1.0-beta.12')))
  })
})
