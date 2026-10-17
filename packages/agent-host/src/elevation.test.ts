import { describe, expect, it } from 'vitest'
import { detectElevation } from './elevation.js'
import { elevatedFromGroups, elevationSource } from './os.js'

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
    expect(await detectElevation({ platform: 'win32', env: {}, run: async () => GROUPS('High') })).toBe(true)
    expect(await detectElevation({ platform: 'win32', env: {}, run: async () => GROUPS('Medium') })).toBe(false)
    expect(await detectElevation({ platform: 'win32', env: {}, run: () => Promise.reject(new Error('ENOENT')) })).toBeNull()
  })

  it('is root elsewhere, and unknown where there is no uid', async () => {
    expect(await detectElevation({ platform: 'linux', getuid: () => 0 })).toBe(true)
    expect(await detectElevation({ platform: 'darwin', getuid: () => 501 })).toBe(false)
    expect(await detectElevation({ platform: 'linux', getuid: undefined })).toBeNull()
  })

  it.runIf(process.platform === 'win32')('gets an answer from this Windows machine’s own whoami', async () => {
    expect(typeof (await detectElevation())).toBe('boolean')
  })
})
