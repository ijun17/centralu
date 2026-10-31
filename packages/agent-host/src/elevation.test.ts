import { describe, expect, it } from 'vitest'
import { detectToken } from './elevation.js'
import { elevatedFromGroups, elevationSource, logonFromGroups } from './os.js'

/** Whether a host runs with administrator rights, said to a hub that links to it (#702) */

// `whoami /groups /fo csv /nh` on Windows 11, trimmed; the group names are in the account's language, the SIDs are not
const GROUPS = (level: string) =>
  [
    '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"',
    '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"',
    `"Mandatory Label\\${level}","Label","${{ Medium: 'S-1-16-8192', High: 'S-1-16-12288', System: 'S-1-16-16384' }[level]}",""`,
  ].join('\r\n')

describe('telling an elevated host (#702)', () => {
  it('reads the integrity level whoami lists: High and System are elevated, Medium (an administrator under UAC) is not', () => {
    expect(elevatedFromGroups(GROUPS('High'))).toBe(true)
    expect(elevatedFromGroups(GROUPS('System'))).toBe(true)
    expect(elevatedFromGroups(GROUPS('Medium'))).toBe(false)
    expect(elevatedFromGroups('')).toBeNull()
  })

  it('asks System32’s whoami by its whole path on Windows, and the uid elsewhere', () => {
    expect(elevationSource('win32', { SystemRoot: 'D:\\Win' })).toEqual({ kind: 'command', file: 'D:\\Win\\System32\\whoami.exe', args: ['/groups', '/fo', 'csv', '/nh'] })
    expect(elevationSource('linux')).toEqual({ kind: 'uid' })
  })

  it('answers from whoami on Windows, and says nothing when whoami cannot be run', async () => {
    expect((await detectToken({ platform: 'win32', env: {}, run: async () => GROUPS('High') })).elevated).toBe(true)
    expect((await detectToken({ platform: 'win32', env: {}, run: async () => GROUPS('Medium') })).elevated).toBe(false)
    expect((await detectToken({ platform: 'win32', env: {}, run: () => Promise.reject(new Error('ENOENT')) })).elevated).toBeNull()
  })

  it('is root elsewhere, and unknown where there is no uid', async () => {
    expect((await detectToken({ platform: 'linux', getuid: () => 0 })).elevated).toBe(true)
    expect((await detectToken({ platform: 'darwin', getuid: () => 501 })).elevated).toBe(false)
    expect((await detectToken({ platform: 'linux', getuid: undefined })).elevated).toBeNull()
  })

  it.runIf(process.platform === 'win32')('gets an answer from this Windows machine’s own whoami', async () => {
    expect(typeof ((await detectToken()).elevated)).toBe('boolean')
  })
})

/**
 * Which Windows logon a host runs in (#1224). The fixtures are the logon groups of `whoami /groups /fo csv /nh` as a
 * linked Windows 11 PC printed them (2026-10-19): the host the hub started over ssh carries NETWORK, the person's own
 * sign-in INTERACTIVE
 */
const LOGON = (sid: string, name: string) =>
  [
    '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"',
    `"NT AUTHORITY\\${name}","Well-known group","${sid}","Mandatory group, Enabled by default, Enabled group"`,
    '"NT AUTHORITY\\Authenticated Users","Well-known group","S-1-5-11","Mandatory group, Enabled by default, Enabled group"',
    '"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""',
  ].join('\r\n')

describe('telling which Windows logon a host runs in (#1224)', () => {
  it('reads the logon group whoami lists, by its SID, whatever the account’s language', () => {
    expect(logonFromGroups(LOGON('S-1-5-4', 'INTERACTIVE'))).toBe('interactive')
    expect(logonFromGroups(LOGON('S-1-5-2', 'NETWORK'))).toBe('network')
    expect(logonFromGroups(LOGON('S-1-5-3', 'BATCH'))).toBe('batch')
    expect(logonFromGroups(LOGON('S-1-5-6', 'SERVICE'))).toBe('service')
    expect(logonFromGroups(LOGON('S-1-5-4', '대화형'))).toBe('interactive')
    // Not a prefix match: S-1-5-21-… (an account) and S-1-5-32-544 (Administrators) are no logon
    expect(logonFromGroups('"BUILTIN\\Administrators","Alias","S-1-5-32-544",""\r\n"jun\\x","Alias","S-1-5-21-1-2-3-1002",""')).toBeNull()
    expect(logonFromGroups('')).toBeNull()
  })

  it('answers the elevation and the logon from one whoami on Windows, and neither when it cannot be run', async () => {
    const calls: string[] = []
    const run = async (file: string) => {
      calls.push(file)
      return LOGON('S-1-5-2', 'NETWORK')
    }
    expect(await detectToken({ platform: 'win32', env: {}, run })).toEqual({ elevated: true, logon: 'network' })
    expect(calls).toHaveLength(1)
    expect(await detectToken({ platform: 'win32', env: {}, run: () => Promise.reject(new Error('ENOENT')) })).toEqual({ elevated: null, logon: null })
  })

  it('says no logon off Windows, where a saved sign-in does not depend on it', async () => {
    expect(await detectToken({ platform: 'linux', getuid: () => 1000 })).toEqual({ elevated: false, logon: null })
  })

  it.runIf(process.platform === 'win32')('gets a logon from this Windows machine’s own whoami', async () => {
    expect(['interactive', 'network', 'batch', 'service']).toContain((await detectToken()).logon)
  })
})
