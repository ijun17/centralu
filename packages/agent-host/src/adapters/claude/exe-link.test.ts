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

/** A file's id, as a bigint: an NTFS id is above 2^53, and as Numbers two files' ids can come out equal (#368) */
const fileId = (path: string) => statSync(path, { bigint: true }).ino

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

describe("repairing npm's placeholder with the package's own setup step (#1645)", () => {
  // What install.cjs does in the package: put the platform package's program over bin/claude.exe
  const COPIES = `const fs = require('fs'); const path = require('path');
fs.appendFileSync(path.join(__dirname, 'runs.log'), 'run\\n');
const dest = path.join(__dirname, 'bin', 'claude.exe');
fs.rmSync(dest, { force: true });
fs.copyFileSync(path.join(__dirname, 'native.bin'), dest);`
  // What it prints when a running program holds the file (measured, Claude Code 2.1.296): the error on stderr, exit code 1
  const HELD = `const fs = require('fs'); const path = require('path');
fs.appendFileSync(path.join(__dirname, 'runs.log'), 'run\\n');
console.error("[@anthropic-ai/claude-code postinstall] Failed to place binary: EBUSY: resource busy or locked, unlink '" + path.join(__dirname, 'bin', 'claude.exe') + "'");
console.error('  Fallback: node cli-wrapper.cjs');
process.exitCode = 1;`
  const runs = () => (existsSync(join(pkg, 'runs.log')) ? readFileSync(join(pkg, 'runs.log'), 'utf8').split('\n').filter(Boolean).length : 0)
  const stub = (installer: string | null) => {
    npmLayout('2.1.311', PLACEHOLDER)
    writeFileSync(join(pkg, 'native.bin'), PROGRAM)
    if (installer === null) rmSync(join(pkg, 'install.cjs'))
    else writeFileSync(join(pkg, 'install.cjs'), installer)
  }
  const message = (l: ClaudeLinks): string => {
    try {
      l.prepare(exe)
    } catch (e) {
      return (e as Error).message
    }
    return ''
  }

  it('runs install.cjs, checks again and starts the repaired program', () => {
    stub(COPIES)
    const log: string[] = []
    const run = links({}, 'win32', log).prepare(exe)
    expect(runs()).toBe(1)
    expect(readFileSync(exe)).toEqual(PROGRAM)
    expect(run.key).toBe(`2.1.311-${PROGRAM.length}`)
    expect(readFileSync(run.path)).toEqual(PROGRAM)
    expect(log.join('\n')).toContain(`running Claude Code's own setup step, ${join(pkg, 'install.cjs')}`)
    expect(log.at(-1)).toBe(`[claude] repaired ${exe}`)
  })

  it('a file a running program holds stays a placeholder, and the message says so', () => {
    stub(HELD)
    const log: string[] = []
    const msg = message(links({}, 'win32', log))
    expect(msg).toContain('a running Claude Code holds it')
    expect(msg).toContain(`node "${join(pkg, 'install.cjs')}"`)
    expect(readFileSync(exe, 'utf8')).toBe(PLACEHOLDER)
    expect(log.join('\n')).toContain('EBUSY')
  })

  it('runs once per host start: later starts and detects are not a loop', () => {
    stub(HELD)
    const l = links()
    const first = message(l)
    expect(message(l)).toBe(first)
    expect(message(l)).toBe(first)
    expect(runs()).toBe(1)
    // A second host (a fresh ClaudeLinks) tries once again
    message(links())
    expect(runs()).toBe(2)
  })

  it('once repaired, a placeholder that appears later is not repaired again by this host', () => {
    stub(COPIES)
    const l = links()
    l.prepare(exe)
    writeFileSync(join(pkg, 'native.bin'), PROGRAM)
    rmSync(exe)
    writeFileSync(exe, PLACEHOLDER)
    expect(message(l)).toContain('does not run it again')
    expect(runs()).toBe(1)
  })

  it('without install.cjs it explains as before and runs nothing', () => {
    stub(null)
    const log: string[] = []
    const msg = message(links({}, 'win32', log))
    expect(msg).toContain('reinstall it with `npm i -g @anthropic-ai/claude-code`')
    expect(msg).not.toContain('Centralu ran')
    expect(log).toEqual([])
  })

  it('a setup step that fails for another reason, or does not finish, says what it said', () => {
    stub("console.error('Native package not found'); process.exitCode = 1")
    expect(message(links())).toContain('exit code 1: Native package not found')
    stub('')
    expect(message(links())).toContain('it left the placeholder in place')
    stub(COPIES)
    const timedOut = message(links({ runInstaller: () => ({ status: null, output: 'it did not finish within 60 seconds' }) }))
    expect(timedOut).toContain('it did not repair the file: it did not finish within 60 seconds')
    expect(timedOut).not.toContain('holds it')
    expect(runs()).toBe(0)
  })

  it('off Windows nothing runs', () => {
    stub(COPIES)
    expect(links({}, 'darwin').prepare(exe)).toEqual({ path: exe, key: null })
    expect(runs()).toBe(0)
  })

  it('a program that is already in place does not run it', () => {
    stub(COPIES)
    rmSync(exe)
    writeFileSync(exe, PROGRAM)
    links().prepare(exe)
    expect(runs()).toBe(0)
  })
})

describe('starting Claude from a hard link in the data folder', () => {
  it("links npm's claude.exe under tools/claude/<version>-<size> and starts it from there", () => {
    npmLayout('2.1.289', PROGRAM)
    const run = links().prepare(exe)
    expect(run.key).toBe(`2.1.289-${PROGRAM.length}`)
    expect(run.path).toBe(join(root, 'tools', 'claude', run.key!, 'claude.exe'))
    // The same file under a second name: no copy, no extra disk
    expect(fileId(run.path)).toBe(fileId(exe))
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
    expect(fileId(run.path)).not.toBe(fileId(exe))
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
