import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linuxDesktop, makeProjectFolder, projectFolderTarget, windowsDesktop, type RunFile } from './project-folder.js'

/**
 * Where a new project goes by default (#515): the Desktop of the machine it lives on, which a person may have moved
 * or which may carry their language's name. No real Desktop is read here: the program and the files are injected.
 */

/** What PowerShell prints for a path: the base64 of its UTF-8 bytes */
const printed = (path: string) => `${Buffer.from(path, 'utf8').toString('base64')}\r\n`

describe('the Windows Desktop', () => {
  it("asks Windows for the known folder, and reads a localized, redirected path whole whatever the console's code page", async () => {
    // A Korean Windows names it with Hangul and OneDrive moves it; printed as text through CP949 it would arrive mangled
    const desktop = 'C:\\Users\\me\\OneDrive\\\uBC14\uD0D5 \uD654\uBA74'
    const calls: { file: string; args: string[] }[] = []
    const run: RunFile = async (file, args) => {
      calls.push({ file, args })
      return printed(desktop)
    }
    expect(await windowsDesktop(run, { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' }, 'C:\\Users\\me')).toBe(desktop)
    expect(calls[0]!.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    // The script goes encoded: no shell quoting (cmd.exe under ssh) stands between it and PowerShell
    const encoded = calls[0]!.args[calls[0]!.args.indexOf('-EncodedCommand') + 1]!
    const script = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(script).toContain("GetFolderPath('Desktop'")
    expect(script).toContain('ToBase64String')
  })

  it('falls back to the profile\'s Desktop when PowerShell cannot answer, or answers nothing usable', async () => {
    const env = { USERPROFILE: 'C:\\Users\\me' }
    expect(await windowsDesktop(async () => Promise.reject(new Error('no powershell')), env, 'C:\\x')).toBe('C:\\Users\\me\\Desktop')
    expect(await windowsDesktop(async () => '\r\n', env, 'C:\\x')).toBe('C:\\Users\\me\\Desktop')
    expect(await windowsDesktop(async () => printed('relative\\path'), env, 'C:\\x')).toBe('C:\\Users\\me\\Desktop')
  })
})

describe('making the folder', () => {
  it('refuses a name taken between the check and the making, and leaves what is there alone', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-pfold-')))
    try {
      const target = projectFolderTarget({ name: 'race' }, join(root, 'Desktop'))
      // Someone makes it after the check (or while the orchestrator's card stood)
      mkdirSync(target.path, { recursive: true })
      writeFileSync(join(target.path, 'keep.txt'), 'mine')
      expect(() => makeProjectFolder(target)).toThrow(/already in/)
      expect(readdirSync(target.path)).toEqual(['keep.txt'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the Linux Desktop (WSL included)', () => {
  const home = '/home/me'
  const files = (map: Record<string, string>) => (f: string) => {
    if (f in map) return map[f]!
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }

  it('is ~/Desktop where no XDG user directories are set (WSL, a server)', () => {
    expect(linuxDesktop(home, {}, files({}))).toBe('/home/me/Desktop')
  })

  it("is the XDG Desktop when one is set, in the desktop's own language", () => {
    const dirs = '# written by xdg-user-dirs-update\nXDG_DOCUMENTS_DIR="$HOME/Dokumente"\nXDG_DESKTOP_DIR="$HOME/Schreibtisch"\n'
    expect(linuxDesktop(home, {}, files({ '/home/me/.config/user-dirs.dirs': dirs }))).toBe('/home/me/Schreibtisch')
    // XDG_CONFIG_HOME moves the file
    expect(linuxDesktop(home, { XDG_CONFIG_HOME: '/cfg' }, files({ '/cfg/user-dirs.dirs': 'XDG_DESKTOP_DIR="/data/desk"' }))).toBe('/data/desk')
  })

  it('is ~/Desktop when XDG says "none" (the home itself) or gives no absolute path', () => {
    expect(linuxDesktop(home, {}, files({ '/home/me/.config/user-dirs.dirs': 'XDG_DESKTOP_DIR="$HOME/"' }))).toBe('/home/me/Desktop')
    expect(linuxDesktop(home, {}, files({ '/home/me/.config/user-dirs.dirs': 'XDG_DESKTOP_DIR="desk"' }))).toBe('/home/me/Desktop')
  })
})
