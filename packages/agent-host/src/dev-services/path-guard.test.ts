import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, posix, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isInside as rulesIsInside } from '../os/rules.js'
import { assertCreatePath, assertExistingPath, assertExistingPathSync, isInside, pathParts, UnsafePathError } from './path-guard.js'

/**
 * The segments the guard walks, under Windows path rules (#14), checked with `path.win32` so it
 * runs on any OS. On Windows `relative()` returns an absolute path for another drive or a UNC
 * share; split into segments, that used to be walked inside the project.
 */
describe('path segments under Windows rules', () => {
  const root = 'C:\\Users\\me\\proj'

  it('a path inside the project splits on either separator', () => {
    expect(pathParts(root, 'src\\a.ts', win32)).toEqual(['src', 'a.ts'])
    expect(pathParts(root, 'src/deep/b.ts', win32)).toEqual(['src', 'deep', 'b.ts'])
  })

  it('a path on another drive is refused, not walked as the segments D: and secret', () => {
    expect(() => pathParts(root, 'D:\\secret', win32)).toThrow(UnsafePathError)
  })

  it('a UNC path is refused, not walked as evil/share/x inside the project', () => {
    expect(() => pathParts(root, '\\\\evil\\share\\x', win32)).toThrow(UnsafePathError)
  })

  it('a drive-letter case difference is still the same project (Windows paths ignore case)', () => {
    expect(pathParts(root, 'c:\\users\\ME\\proj\\src\\a.ts', win32)).toEqual(['src', 'a.ts'])
  })

  it('leaving the root by .. is left for the walk to refuse, as on every OS', () => {
    expect(pathParts(root, '..\\other', win32)).toEqual(['..', 'other'])
  })
})

/*
 * #849: a root spelled with a Windows short name (GitHub's runners give temp folders as `C:\Users\RUNNER~1\…`). The
 * sync walk used the JS realpath, which keeps the short spelling, while a junction's target comes back in full, so a
 * link inside the project was refused as leaving it; the async walk's realpath already gave the long name.
 */
describe.skipIf(process.platform !== 'win32')('a project root spelled with a short name', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('follows a junction inside it, on the async walk and on the sync one', async () => {
    const long = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-guard-long-folder-name-')))
    dirs.push(long)
    mkdirSync(join(long, 'real'))
    writeFileSync(join(long, 'real', 'a.txt'), 'x')
    symlinkSync(join(long, 'real'), join(long, 'link'), 'junction')
    const short = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`], {
      windowsVerbatimArguments: true,
    }).stdout.toString().trim()
    expect(short, 'this volume makes short names').not.toBe(long)
    expect((await assertExistingPath(short, 'link/a.txt')).isFile()).toBe(true)
    expect(assertExistingPathSync(short, 'link/a.txt').isFile()).toBe(true)
  })
})

/*
 * A junction to a volume path (`\\?\Volume{…}\…`) needs no privilege to make, and libuv cannot read its target, so
 * `lstat` follows it and calls it a plain folder. The walk went on inside it as if it were in the project: the file
 * tree listed the folder it led to and a dropped file was written there (measured on Windows 11).
 */
describe.skipIf(process.platform !== 'win32')('a junction to a volume path', () => {
  const dirs: string[] = []
  const links: string[] = []
  afterEach(() => {
    // Removed as links first: a recursive rm would go through one into what it leads to
    for (const l of links.splice(0)) rmdirSync(l)
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const viaVolume = (path: string) => {
    const mountvol = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'mountvol.exe')
    const volume = spawnSync(mountvol, [path.slice(0, 2), '/L'], { encoding: 'utf8' }).stdout.trim()
    expect(volume).toMatch(/^\\\\\?\\Volume\{[0-9a-f-]+\}\\$/i)
    return volume + path.slice(3)
  }
  const shortName = (path: string) =>
    spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], {
      windowsVerbatimArguments: true,
    }).stdout.toString().trim()
  const setup = () => {
    const top = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-guard-volume-')))
    dirs.push(top)
    const root = join(top, 'project')
    const outside = join(top, 'outside')
    mkdirSync(join(root, 'inside'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'outside')
    writeFileSync(join(root, 'inside', 'a.txt'), 'inside')
    const junction = (target: string, name: string) => {
      const at = join(root, name)
      symlinkSync(viaVolume(target), at, 'junction')
      links.push(at)
      // What the walk has to go by
      expect(lstatSync(at).isSymbolicLink()).toBe(false)
      return at
    }
    return { root, outside, junction }
  }

  it('refuses one leading outside the project, on the async walk and on the sync one, however it is spelled', async () => {
    const { root, outside, junction } = setup()
    const at = junction(outside, 'volume-link')
    const short = basename(shortName(at))
    expect(short, 'this volume makes short names').not.toBe('volume-link')
    for (const name of ['volume-link', 'VOLUME-LINK', short]) {
      await expect(assertExistingPath(root, `${name}/secret.txt`), name).rejects.toThrow(UnsafePathError)
      await expect(assertExistingPath(root, name), name).rejects.toThrow(UnsafePathError)
      expect(() => assertExistingPathSync(root, `${name}/secret.txt`), name).toThrow(UnsafePathError)
      // A file dropped into it would have been written outside
      await expect(assertCreatePath(root, `${name}/dropped.txt`), name).rejects.toThrow(UnsafePathError)
    }
  })

  it('still follows one leading inside the project', async () => {
    const { root, junction } = setup()
    junction(join(root, 'inside'), 'volume-link')
    expect((await assertExistingPath(root, 'volume-link/a.txt')).isFile()).toBe(true)
    expect(assertExistingPathSync(root, 'volume-link/a.txt').isFile()).toBe(true)
  })
})

describe('path segments under POSIX rules', () => {
  it('splits only on / (a backslash is part of a file name there)', () => {
    expect(pathParts('/home/me/proj', 'src/a\\b.ts', posix)).toEqual(['src', 'a\\b.ts'])
  })
})

describe('isInside (#428)', () => {
  it('judges by segment, under POSIX rules', () => {
    expect(isInside('/a/wt', '/a/wt')).toBe(true)
    expect(isInside('/a/wt', '/a/wt/x')).toBe(true)
    expect(isInside('/a/wt', '/a/wt-old')).toBe(false)
    expect(isInside('/a/wt', '/a')).toBe(false)
    expect(isInside('/a/wt', '/a/wt/../b')).toBe(false)
    // A name that only starts with two dots is a name, not a step up
    expect(isInside('/a/wt', '/a/wt/..cache/x')).toBe(true)
    // The file system's root holds everything
    expect(isInside('/', '/etc/hosts')).toBe(true)
  })

  it('judges by segment under Windows rules: case aside, another drive and a share outside', () => {
    expect(isInside('C:\\Work\\Proj', 'c:\\work\\proj\\src\\a.ts', win32)).toBe(true)
    expect(isInside('C:\\Work\\Proj', 'C:\\Work\\Proj-old', win32)).toBe(false)
    expect(isInside('C:\\Work\\Proj', 'D:\\Work\\Proj\\a', win32)).toBe(false)
    expect(isInside('C:\\Work\\Proj', '\\\\evil\\share\\Proj\\a', win32)).toBe(false)
  })

  // One definition of inside (`isInside` in os/rules.ts): NTFS tells the Kelvin sign (U+212A) from `k`, which Node's `relative()` does not
  it('takes the Kelvin sign for another letter than k on Windows, as the OS layer does', () => {
    const kelvin = '\u212a'
    expect(isInside('C:\\a\\k', 'C:\\a\\K\\f', win32)).toBe(true)
    expect(isInside('C:\\a\\k', `C:\\a\\${kelvin}\\f`, win32)).toBe(false)
    expect(isInside('C:\\a\\k', `C:\\a\\${kelvin}\\f`, win32)).toBe(rulesIsInside('C:\\a\\k', `C:\\a\\${kelvin}\\f`, 'windows'))
  })

  // A drive root as the project (#849): judged by a prefix with a separator added, `D:\` became `D:\\` and held nothing
  it('takes a drive root as holding everything on that drive, and nothing on another', () => {
    expect(isInside('D:\\', 'D:\\src\\a.ts', win32)).toBe(true)
    expect(isInside('D:\\', 'd:\\', win32)).toBe(true)
    expect(isInside('D:\\', 'C:\\src', win32)).toBe(false)
    expect(pathParts('D:\\', 'src\\a.ts', win32)).toEqual(['src', 'a.ts'])
  })
})
