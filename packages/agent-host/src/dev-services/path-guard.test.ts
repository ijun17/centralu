import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathParts, UnsafePathError } from './path-guard.js'

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

describe('path segments under POSIX rules', () => {
  it('splits only on / (a backslash is part of a file name there)', () => {
    expect(pathParts('/home/me/proj', 'src/a\\b.ts', posix)).toEqual(['src', 'a\\b.ts'])
  })
})
