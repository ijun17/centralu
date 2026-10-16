import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertExistingPath, assertExistingPathSync, isInside, pathParts, UnsafePathError } from './path-guard.js'

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
})
