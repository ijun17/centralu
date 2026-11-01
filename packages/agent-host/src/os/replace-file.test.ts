import { describe, expect, it } from 'vitest'
import { memoryOs } from './memory.js'
import type { OsFiles } from './port.js'
import { RENAME_WAITS_MS, createFileSync, replaceFileSync } from './replace-file.js'

/**
 * A data file replaced whole (os/replace-file.ts): over the in-memory OS, with the one call under test made to fail
 * the way the real OS fails it.
 */

const code = (c: string) => Object.assign(new Error(`${c}: simulated`), { code: c })

function folder(family: 'posix' | 'windows') {
  const os = memoryOs({ as: family })
  const dir = os.paths.path.join(os.env.home, 'data')
  os.files.mkdirSync(dir, { recursive: true })
  const path = os.paths.path.join(dir, 'file.json')
  const names = () => os.files.readdirSync(dir).sort()
  /** The files with `call` replaced: `fail(n, args)` throws (or not) on the n-th call of it */
  const failing = <K extends 'writeFileSync' | 'renameSync' | 'rmSync' | 'linkSync'>(call: K, fail: (n: number) => Error | undefined): OsFiles => {
    let n = 0
    return new Proxy(os.files, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown
        if (key !== call) return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
        return (...args: unknown[]) => {
          const e = fail(++n)
          if (e) throw e
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      },
    })
  }
  return { os, dir, path, names, failing, mode: (p: string) => os.files.statSync(p).mode & 0o777 }
}

describe.each(['posix', 'windows'] as const)('replaceFileSync on %s', (family) => {
  const folder_ = () => folder(family)
  it('replaces the file whole and leaves no temp file', () => {
    const f = folder_()
    f.os.files.writeFileSync(f.path, 'old')
    replaceFileSync(f.os.files, f.path, 'new')
    expect(f.os.files.readFileSync(f.path, 'utf8')).toBe('new')
    expect(f.names()).toEqual(['file.json'])
  })

  it('creates the temp file at the mode asked for, and the file keeps it', () => {
    const f = folder_()
    const modes: number[] = []
    const files = new Proxy(f.os.files, {
      get: (t, k) => (k === 'renameSync' ? (from: string, to: string) => (modes.push(f.mode(from)), t.renameSync(from, to)) : (Reflect.get(t, k, t) as unknown)),
    })
    replaceFileSync(files, f.path, '{}', { mode: 0o600 })
    // Windows has no such mode: the file answers 0o666 there, whatever is asked
    const want = family === 'posix' ? 0o600 : 0o666
    expect(modes).toEqual([want])
    expect(f.mode(f.path)).toBe(want)
  })

  it('writes each time under a name of its own, exclusively, that ends in .tmp', () => {
    const f = folder_()
    const seen: { path: string; flag?: string }[] = []
    const files = new Proxy(f.os.files, {
      get: (t, k) => (k === 'writeFileSync' ? (p: string, d: string, o?: { flag?: 'wx' }) => (seen.push({ path: p, flag: o?.flag }), t.writeFileSync(p, d, o)) : (Reflect.get(t, k, t) as unknown)),
    })
    replaceFileSync(files, f.path, 'a')
    replaceFileSync(files, f.path, 'b')
    expect(new Set(seen.map((s) => s.path)).size).toBe(2)
    for (const s of seen) {
      expect(s.path).toMatch(/file\.json\.\d+-[0-9a-f]{8}\.tmp$/)
      expect(s.flag).toBe('wx')
    }
  })

  it('removes the temp file when the write fails part way, and throws the write error', () => {
    const f = folder_()
    f.os.files.writeFileSync(f.path, 'old')
    const files = new Proxy(f.os.files, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown
        if (key !== 'writeFileSync') return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
        return (p: string, data: string, o?: object) => {
          target.writeFileSync(p, data.slice(0, 2), o)
          throw code('ENOSPC')
        }
      },
    })
    expect(() => replaceFileSync(files, f.path, 'new text')).toThrow(/ENOSPC/)
    expect(f.names()).toEqual(['file.json'])
    expect(f.os.files.readFileSync(f.path, 'utf8')).toBe('old')
  })

  it('removes the temp file when the rename is refused for good, and throws the rename error', () => {
    const f = folder_()
    f.os.files.writeFileSync(f.path, 'old')
    expect(() => replaceFileSync(f.failing('renameSync', () => code('ENOSPC')), f.path, 'new')).toThrow(/ENOSPC/)
    expect(f.names()).toEqual(['file.json'])
    expect(f.os.files.readFileSync(f.path, 'utf8')).toBe('old')
  })

  it('says the write error, not the one of removing the temp file, when a scanner holds it', () => {
    const f = folder_()
    const rename = f.failing('renameSync', () => code('ENOSPC'))
    const files = new Proxy(rename, { get: (t, k) => (k === 'rmSync' ? () => { throw code('EBUSY') } : (Reflect.get(t, k, t) as unknown)) })
    expect(() => replaceFileSync(files, f.path, 'new')).toThrow(/ENOSPC/)
    expect(f.names().filter((n) => n.endsWith('.tmp'))).toHaveLength(1)
  })

  it.each(['EPERM', 'EBUSY', 'EACCES'])('tries a rename again that Windows refuses for a moment (%s), and succeeds', (c) => {
    const f = folder_()
    f.os.files.writeFileSync(f.path, 'old')
    const waits: number[] = []
    let renames = 0
    const files = f.failing('renameSync', (n) => ((renames = n), n <= 2 ? code(c) : undefined))
    replaceFileSync(files, f.path, 'new', { sleep: (ms) => waits.push(ms) })
    expect(renames).toBe(3)
    expect(waits).toEqual(RENAME_WAITS_MS.slice(0, 2))
    expect(f.os.files.readFileSync(f.path, 'utf8')).toBe('new')
    expect(f.names()).toEqual(['file.json'])
  })

  it('gives up after its bound and throws the last refusal, leaving the old file and no temp file', () => {
    const f = folder_()
    f.os.files.writeFileSync(f.path, 'old')
    const waits: number[] = []
    let renames = 0
    const files = f.failing('renameSync', (n) => ((renames = n), code('EPERM')))
    expect(() => replaceFileSync(files, f.path, 'new', { sleep: (ms) => waits.push(ms) })).toThrow(/EPERM/)
    expect(renames).toBe(RENAME_WAITS_MS.length + 1)
    expect(waits).toEqual([...RENAME_WAITS_MS])
    expect(f.names()).toEqual(['file.json'])
    expect(f.os.files.readFileSync(f.path, 'utf8')).toBe('old')
  })

  it('does not retry a refusal that waiting cannot change', () => {
    const f = folder_()
    const waits: number[] = []
    let renames = 0
    const files = f.failing('renameSync', (n) => ((renames = n), code('ENOENT')))
    expect(() => replaceFileSync(files, f.path, 'new', { sleep: (ms) => waits.push(ms) })).toThrow(/ENOENT/)
    expect(renames).toBe(1)
    expect(waits).toEqual([])
  })
})

describe.each(['posix', 'windows'] as const)('createFileSync on %s', (family) => {
  const folder_ = () => folder(family)
  it('writes the file while there is none, at the mode asked for, and leaves no temp file', () => {
    const f = folder_()
    expect(createFileSync(f.os.files, f.path, 'first', { mode: 0o600 })).toBe(true)
    expect(f.os.files.readFileSync(f.path, 'utf8')).toBe('first')
    expect(f.mode(f.path)).toBe(family === 'posix' ? 0o600 : 0o666)
    expect(f.names()).toEqual(['file.json'])
  })

  it('answers false for a file that is there, leaves it as it is, and leaves no temp file', () => {
    const f = folder_()
    f.os.files.writeFileSync(f.path, 'kept')
    expect(createFileSync(f.os.files, f.path, 'second')).toBe(false)
    expect(f.os.files.readFileSync(f.path, 'utf8')).toBe('kept')
    expect(f.names()).toEqual(['file.json'])
  })

  it('throws what is not "there is one", with no temp file left', () => {
    const f = folder_()
    expect(() => createFileSync(f.failing('linkSync', () => code('EPERM')), f.path, 'x')).toThrow(/EPERM/)
    expect(f.names()).toEqual([])
  })
})
