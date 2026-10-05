import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeLinks, ClaudePlaceholderError, realExeFs, type ExeFs } from './exe-link.js'

/**
 * Where a Claude process starts from on Windows (#353), simulated on any OS with the platform passed
 * in and real files in a temp folder. Windows-only behaviour (a running program cannot be deleted,
 * a link across volumes fails) is made by failing the file operation the way Windows does.
 */

// npm's placeholder as Claude Code 2.1.289 ships it: a few lines of text in bin/claude.exe (about 500 bytes)
const PLACEHOLDER = '@echo off\r\necho Error: claude native binary not installed.\r\necho Either postinstall did not run (--ignore-scripts, some pnpm configs)\r\n'
// A stand-in for the real binary: a PE header and some body
const PROGRAM = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096, 7)])

let dir: string
let root: string
let pkg: string
let exe: string

function npmLayout(version: string, body: Buffer | string): void {
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version }))
  writeFileSync(join(pkg, 'install.cjs'), '// postinstall')
  rmSync(exe, { force: true })
  writeFileSync(exe, body)
}

const links = (fs: Partial<ExeFs> = {}, platform: NodeJS.Platform = 'win32', log: string[] = []) =>
  new ClaudeLinks({ platform, root: () => root, fs: { ...realExeFs, ...fs }, log: (l) => log.push(l) })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-353-'))
  root = join(dir, 'data')
  pkg = join(dir, 'npm', 'node_modules', '@anthropic-ai', 'claude-code')
  exe = join(pkg, 'bin', 'claude.exe')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("npm's placeholder", () => {
  it('is refused before a process starts, naming the file and the fix', () => {
    npmLayout('2.1.289', PLACEHOLDER)
    let err: unknown
    try {
      links().prepare(exe)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ClaudePlaceholderError)
    const msg = (err as Error).message
    expect(msg).toContain(exe)
    expect(msg).toContain(`${Buffer.byteLength(PLACEHOLDER)}-byte placeholder`)
    expect(msg).toContain(`node "${join(pkg, 'install.cjs')}"`)
    expect(msg).toContain('npm i -g @anthropic-ai/claude-code')
    // Nothing was linked from it
    expect(existsSync(join(root, 'tools'))).toBe(false)
  })

  it('outside npm\'s layout the advice is to reinstall, never a command that is not there', () => {
    const native = join(dir, '.local', 'bin', 'claude.exe')
    mkdirSync(join(dir, '.local', 'bin'), { recursive: true })
    writeFileSync(native, 'not a program')
    expect(() => links().prepare(native)).toThrow(/reinstall it with `npm i -g @anthropic-ai\/claude-code`/)
    expect(() => links().prepare(native)).not.toThrow(/install\.cjs/)
  })

  it('a small file that starts with MZ is a program, and a large one is never called a placeholder', () => {
    npmLayout('2.1.289', PROGRAM)
    expect(() => links().prepare(exe)).not.toThrow()
    npmLayout('2.1.290', Buffer.alloc(1_000_001, 0x20))
    expect(() => links().prepare(exe)).not.toThrow()
  })

  it('off Windows nothing is checked or linked: the path found is started as before', () => {
    npmLayout('2.1.289', PLACEHOLDER)
    expect(links({}, 'darwin').prepare(exe)).toEqual({ path: exe, key: null })
    expect(links({}, 'linux').prepare(exe)).toEqual({ path: exe, key: null })
  })
})

describe('starting Claude from a hard link in the data folder', () => {
  it("links npm's claude.exe under tools/claude/<version>-<size> and starts it from there", () => {
    npmLayout('2.1.289', PROGRAM)
    const run = links().prepare(exe)
    expect(run.key).toBe(`2.1.289-${PROGRAM.length}`)
    expect(run.path).toBe(join(root, 'tools', 'claude', run.key!, 'claude.exe'))
    // The same file under a second name: no copy, no extra disk
    expect(statSync(run.path).ino).toBe(statSync(exe).ino)
    expect(statSync(exe).nlink).toBe(2)
    // No temporary name is left next to it
    expect(readdirSync(join(root, 'tools', 'claude', run.key!))).toEqual(['claude.exe'])
  })

  it('the next session reuses the link without placing anything', () => {
    npmLayout('2.1.289', PROGRAM)
    let linked = 0
    const l = links({ link: (a, b) => (linked++, realExeFs.link(a, b)) })
    const first = l.prepare(exe)
    const second = l.prepare(exe)
    expect(second).toEqual(first)
    expect(linked).toBe(1)
  })

  it.each(['EXDEV', 'EPERM'])('copies the program when a link fails with %s', (code) => {
    npmLayout('2.1.289', PROGRAM)
    const log: string[] = []
    const l = links({ link: () => { throw Object.assign(new Error(code), { code }) } }, 'win32', log)
    const run = l.prepare(exe)
    expect(run.path).toBe(join(root, 'tools', 'claude', `2.1.289-${PROGRAM.length}`, 'claude.exe'))
    expect(statSync(run.path).ino).not.toBe(statSync(exe).ino)
    expect(readFileSync(run.path)).toEqual(PROGRAM)
    expect(log.join('\n')).toContain(code)
  })

  it('when neither a link nor a copy can be made, it starts from where it was found and says so in the log', () => {
    npmLayout('2.1.289', PROGRAM)
    const log: string[] = []
    const fail = () => {
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
    }
    expect(links({ link: fail, copy: fail }, 'win32', log).prepare(exe)).toEqual({ path: exe, key: null })
    expect(log.at(-1)).toContain('ENOSPC')
    expect(readdirSync(join(root, 'tools', 'claude', `2.1.289-${PROGRAM.length}`))).toEqual([])
  })

  it('a new version gets its own folder', () => {
    const l = links()
    npmLayout('2.1.289', PROGRAM)
    const old = l.prepare(exe)
    l.acquire(old.key)
    npmLayout('2.1.290', Buffer.concat([PROGRAM, Buffer.from('new')]))
    const next = l.prepare(exe)
    expect(next.key).toBe(`2.1.290-${PROGRAM.length + 3}`)
    expect(next.path).not.toBe(old.path)
  })

  it('outside npm the key is the size and modification time', () => {
    const native = join(dir, '.local', 'bin', 'claude.exe')
    mkdirSync(join(dir, '.local', 'bin'), { recursive: true })
    writeFileSync(native, PROGRAM)
    const run = links().prepare(native)
    expect(run.key).toBe(`${PROGRAM.length}-${Math.floor(statSync(native).mtimeMs)}`)
  })
})

describe('removing links nothing runs from', () => {
  const base = () => join(root, 'tools', 'claude')
  const folders = () => readdirSync(base()).sort()

  it('keeps the current link and the ones sessions run from, and removes the rest once their session ends', () => {
    const l = links()
    npmLayout('2.1.287', PROGRAM)
    const a = l.prepare(exe)
    l.acquire(a.key) // a session still runs 2.1.287
    npmLayout('2.1.288', Buffer.concat([PROGRAM, Buffer.from('x')]))
    const b = l.prepare(exe) // prepared, its session already gone
    npmLayout('2.1.289', Buffer.concat([PROGRAM, Buffer.from('xy')]))
    const c = l.prepare(exe) // what new sessions start from
    expect(folders()).toEqual([a.key, c.key].sort())
    expect(b.key).not.toBeNull()

    l.release(a.key)
    expect(folders()).toEqual([c.key])
  })

  it('at host start, leftovers from an earlier run go and the installed version stays', () => {
    npmLayout('2.1.289', PROGRAM)
    for (const k of ['2.1.280-1', '2.1.288-2', `2.1.289-${PROGRAM.length}`]) {
      mkdirSync(join(base(), k), { recursive: true })
      writeFileSync(join(base(), k, 'claude.exe'), PROGRAM)
    }
    const l = links()
    l.keep(exe)
    l.sweep()
    expect(folders()).toEqual([`2.1.289-${PROGRAM.length}`])
  })

  it('a link Windows refuses to delete (a process still runs it) stays for a later sweep, and the rest still go', () => {
    for (const k of ['busy', 'old']) {
      mkdirSync(join(base(), k), { recursive: true })
      writeFileSync(join(base(), k, 'claude.exe'), PROGRAM)
    }
    let busy = true
    const l = links({
      removeDir: (d) => {
        if (busy && d.endsWith('busy')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        realExeFs.removeDir(d)
      },
    })
    expect(() => l.sweep()).not.toThrow()
    expect(folders()).toEqual(['busy'])
    busy = false
    l.sweep()
    expect(existsSync(base()) ? folders() : []).toEqual([])
  })

  it('off Windows the folder is never touched', () => {
    mkdirSync(join(base(), 'x'), { recursive: true })
    links({}, 'darwin').sweep()
    expect(folders()).toEqual(['x'])
  })
})
