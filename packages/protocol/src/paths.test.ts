import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { osPathBaseName, wireBaseName, wireJoin, wireSegments } from './paths.js'

/**
 * The wire encoding (issue #47).
 *
 * These pin the wire helpers against `node:path`, which is what the host reaches for once a path
 * stops being a wire path and becomes a place on a disk. Pinning both flavours — `posix` and
 * `win32` — is the point: the running machine is only ever one of them, so the disagreement that
 * matters is the one this file can see and the machine cannot.
 */

describe('wire paths are POSIX', () => {
  it('the root is the empty part, and it contributes no separator', () => {
    // `/a.ts` would be absolute, and every check downstream refuses those — the bug would read
    // as "the root folder is the one place you cannot drop a file"
    expect(wireJoin('', 'a.ts')).toBe('a.ts')
    expect(wireJoin('sub', 'a.ts')).toBe('sub/a.ts')
    expect(wireJoin('sub', 'deep', 'a.ts')).toBe('sub/deep/a.ts')
  })

  it('the base name is the last segment, trailing separator or not', () => {
    expect(wireBaseName('sub/a.ts')).toBe('a.ts')
    expect(wireBaseName('sub/')).toBe('sub')
    expect(wireBaseName('a.ts')).toBe('a.ts')
    expect(wireBaseName('')).toBe('')
    expect(wireBaseName('/')).toBe('')
  })

  it('it answers what node:path answers, on the platform the wire is spelled for', () => {
    for (const p of ['sub/a.ts', 'sub/deep/a.ts', 'a.ts', 'sub/.gitignore']) {
      expect(wireBaseName(p)).toBe(posix.basename(p))
    }
  })

  /**
   * `\` is an ordinary character in a file name on the machines this runs on today, so a wire
   * path can legitimately contain one and it must survive intact. The host is where that stops
   * being true — `baseName` there asks the platform whether the result is still a name.
   */
  it('a backslash is a character, not a separator', () => {
    expect(wireBaseName('sub/a\\b.txt')).toBe('a\\b.txt')
    expect(wireSegments('a\\b/c.ts')).toEqual(['a\\b', 'c.ts'])
  })

  it('segments keep the empty ones, so "absolute" stays visible', () => {
    expect(wireSegments('a/../b')).toEqual(['a', '..', 'b'])
    expect(wireSegments('/a')).toEqual(['', 'a'])
    expect(wireSegments('a//b')).toEqual(['a', '', 'b'])
  })
})

describe('native paths are read under either separator', () => {
  it('matches node:path for a Windows directory', () => {
    const dir = 'C:\\Users\\me\\proj'
    expect(osPathBaseName(dir)).toBe(win32.basename(dir))
    expect(osPathBaseName(dir)).toBe('proj')
    // …which is exactly what reading only `/` could not do: the whole string comes back as one
    // segment, and a project ends up named after its full path
    expect(posix.basename(dir)).toBe(dir)
  })

  it('matches node:path for a POSIX directory', () => {
    for (const dir of ['/Users/me/proj', '/tmp/alpha', '/opt/x/y']) {
      expect(osPathBaseName(dir)).toBe(posix.basename(dir))
    }
  })

  it('a trailing separator does not empty the name', () => {
    expect(osPathBaseName('/tmp/alpha/')).toBe('alpha')
    expect(osPathBaseName('C:\\Users\\me\\proj\\')).toBe('proj')
  })
})
