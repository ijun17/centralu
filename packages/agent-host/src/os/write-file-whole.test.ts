import { describe, expect, it } from 'vitest'
import { memoryOs } from './memory.js'
import type { OsFiles } from './port.js'
import { writeFileWhole } from './write-file-whole.js'

/** A data file written whole (os/write-file-whole.ts), over the in-memory OS, with one call made to fail as the real OS fails it */

type Real = (...a: unknown[]) => unknown
type Over = Record<string, (real: Real, ...a: unknown[]) => unknown>
const refusal = (c: string) => Object.assign(new Error(`${c}: simulated`), { code: c })

function folder(family: 'posix' | 'windows') {
  const os = memoryOs({ as: family })
  const dir = os.paths.path.join(os.env.home, 'data')
  os.files.mkdirSync(dir, { recursive: true })
  const path = os.paths.path.join(dir, 'file.json')
  /** The files with each call in `over` replaced */
  const wrap = (over: Over): OsFiles =>
    new Proxy(os.files, {
      get(target, key: string) {
        const value = Reflect.get(target, key, target) as unknown
        if (typeof value !== 'function') return value
        const real = value.bind(target) as Real
        return (...a: unknown[]) => (over[key] ? over[key](real, ...a) : real(...a))
      },
    })
  return { os, path, wrap, names: () => os.files.readdirSync(dir), read: () => os.files.readFileSync(path, 'utf8') }
}

describe.each(['posix', 'windows'] as const)('writeFileWhole on %s', (family) => {
  const mode = family === 'posix' ? 0o600 : 0o666 // Windows has no such mode
  it('replaces the file whole at the mode asked for, under a temp name of its own, and leaves no temp file', () => {
    const f = folder(family)
    f.os.files.writeFileSync(f.path, 'old')
    const temps: { path: unknown; mode: number }[] = []
    const files = f.wrap({
      renameSync: (real, from, to) => (temps.push({ path: from, mode: f.os.files.statSync(String(from)).mode & 0o777 }), real(from, to)),
    })
    expect(writeFileWhole(files, f.path, 'a', { mode: 0o600 })).toBe(true)
    writeFileWhole(files, f.path, 'b', { mode: 0o600 })
    expect(f.read()).toBe('b')
    expect(f.names()).toEqual(['file.json'])
    expect(f.os.files.statSync(f.path).mode & 0o777).toBe(mode)
    expect(temps.map((t) => t.mode)).toEqual([mode, mode])
    expect(new Set(temps.map((t) => t.path)).size).toBe(2)
    for (const t of temps) expect(t.path).toMatch(/file\.json\.\d+-[0-9a-f]{8}\.tmp$/)
  })

  it('writes exclusively', () => {
    const f = folder(family)
    const flags: unknown[] = []
    writeFileWhole(f.wrap({ writeFileSync: (real, p, d, o) => (flags.push((o as { flag?: string }).flag), real(p, d, o)) }), f.path, 'a')
    expect(flags).toEqual(['wx'])
  })

  it('removes the temp file when the write fails part way, and throws the write error', () => {
    const f = folder(family)
    f.os.files.writeFileSync(f.path, 'old')
    const files = f.wrap({ writeFileSync: (real, p, d, o) => (real(p, String(d).slice(0, 2), o), (() => { throw refusal('ENOSPC') })()) })
    expect(() => writeFileWhole(files, f.path, 'new text')).toThrow(/ENOSPC/)
    expect(f.names()).toEqual(['file.json'])
    expect(f.read()).toBe('old')
  })

  it('says the write error, not the one of removing the temp file, when a scanner holds it', () => {
    const f = folder(family)
    const files = f.wrap({ renameSync: () => { throw refusal('ENOSPC') }, rmSync: () => { throw refusal('EBUSY') } })
    expect(() => writeFileWhole(files, f.path, 'new')).toThrow(/ENOSPC/)
    expect(f.names().filter((n) => n.endsWith('.tmp'))).toHaveLength(1)
  })

  it('with create, writes while there is no file, and answers false over one, leaving it and no temp file', () => {
    const f = folder(family)
    expect(writeFileWhole(f.os.files, f.path, 'first', { create: true })).toBe(true)
    expect(writeFileWhole(f.os.files, f.path, 'second', { create: true })).toBe(false)
    expect(f.read()).toBe('first')
    expect(f.names()).toEqual(['file.json'])
    expect(() => writeFileWhole(f.wrap({ linkSync: () => { throw refusal('EPERM') } }), f.path + '2', 'x', { create: true })).toThrow(/EPERM/)
    expect(f.names()).toEqual(['file.json'])
  })
})
