import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifySource } from './imports.js'

/**
 * Where an import comes from, under Windows path rules (#14), checked with `path.win32` so it runs
 * on any OS. `C:` looked like a URL scheme, so every Windows path was refused as one.
 */
describe('an import source on Windows', () => {
  it('a drive path is a folder on this machine, not a URL scheme', () => {
    expect(classifySource('C:\\Users\\me\\notes', win32.isAbsolute)).toEqual({
      kind: 'path',
      path: 'C:\\Users\\me\\notes',
      label: 'C:\\Users\\me\\notes',
    })
    expect(classifySource('D:/apps/notes.zip', win32.isAbsolute).kind).toBe('path')
  })

  it('a drive-relative path still has to be a full path', () => {
    expect(() => classifySource('C:notes', win32.isAbsolute)).toThrow(/Only folders and \.zip files/)
  })

  it('an unknown scheme is still refused', () => {
    expect(() => classifySource('ftp://example.com/a.zip', win32.isAbsolute)).toThrow(/Only folders and \.zip files/)
  })

  it('on macOS and Linux a drive path is not absolute, and says so', () => {
    expect(() => classifySource('C:\\Users\\me\\notes', posix.isAbsolute)).toThrow(/Use the full path/)
  })
})
