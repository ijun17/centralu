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
  const COPY_NATIVE = `fs.rmSync(dest, { force: true });
fs.copyFileSync(path.join(__dirname, 'native.bin'), dest);`
  const header = `const fs = require('fs'); const path = require('path');
fs.appendFileSync(path.join(__dirname, 'runs.log'), 'run\\n');
const dest = path.join(__dirname, 'bin', 'claude.exe');
`
  const COPIES = header + COPY_NATIVE
  // The setup step that takes a while: the host's loop must keep turning meanwhile
  const SLOW = header + `setTimeout(() => { ${COPY_NATIVE.replace(/\n/g, ' ')} }, 500);`
  // What it prints when a running program holds the file (measured, Claude Code 2.1.296): the error on stderr, exit code 1
  const HELD = `${header}console.error("[@anthropic-ai/claude-code postinstall] Failed to place binary: EBUSY: resource busy or locked, unlink '" + dest + "'");
console.error('  Fallback: node cli-wrapper.cjs');
process.exitCode = 1;`
  // A copy cut short: 2 MB of a 3 MB program written, then the step fails
  const TRUNCATED = `${header}fs.rmSync(dest, { force: true });
fs.writeFileSync(dest, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2_000_000, 7)]));
console.error('ENOSPC: no space left on device, write');
process.exitCode = 1;`
  // The same copy cut short by the time limit: half written, then the step stays busy until it is killed
  const STUCK = `${header}fs.rmSync(dest, { force: true });
fs.writeFileSync(dest, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2_000_000, 7)]));
setTimeout(() => {}, 60_000);`
  const BIG_PROGRAM = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(3_000_000, 9)])
  const runs = () => (existsSync(join(pkg, 'runs.log')) ? readFileSync(join(pkg, 'runs.log'), 'utf8').split('\n').filter(Boolean).length : 0)
  /** The package with its placeholder; `native` is the platform package's program, put where install.cjs finds it unless null */
  const stub = (installer: string | null, native: Buffer | null = PROGRAM) => {
    npmLayout('2.1.311', PLACEHOLDER)
    writeFileSync(join(pkg, 'native.bin'), native ?? PROGRAM)
    if (native) {
      const dir = join(pkg, 'node_modules', '@anthropic-ai', `claude-code-win32-${process.arch}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@anthropic-ai/claude-code-win32-${process.arch}`, version: '2.1.311' }))
      writeFileSync(join(dir, 'claude.exe'), native)
    }
    if (installer === null) rmSync(join(pkg, 'install.cjs'))
    else writeFileSync(join(pkg, 'install.cjs'), installer)
  }
  const message = async (l: ClaudeLinks): Promise<string> => {
    try {
      await l.ensure(exe)
    } catch (e) {
      return (e as Error).message
    }
    return ''
  }

  it('runs install.cjs, checks again and starts the repaired program', async () => {
    stub(COPIES)
    const log: string[] = []
    const run = await links({}, 'win32', log).ensure(exe)
    expect(runs()).toBe(1)
    expect(readFileSync(exe)).toEqual(PROGRAM)
    expect(run.key).toBe(`2.1.311-${PROGRAM.length}`)
    expect(readFileSync(run.path)).toEqual(PROGRAM)
    expect(log.join('\n')).toContain(`running Claude Code's own setup step, ${join(pkg, 'install.cjs')}`)
    expect(log.at(-1)).toBe(`[claude] repaired ${exe}`)
  })

  it("does not stop the host's loop while the setup step runs", async () => {
    stub(SLOW)
    let ticks = 0
    const timer = setInterval(() => ticks++, 10)
    try {
      await links().ensure(exe)
    } finally {
      clearInterval(timer)
    }
    expect(readFileSync(exe)).toEqual(PROGRAM)
    // The step sleeps 500 ms; a blocked loop would have counted none
    expect(ticks).toBeGreaterThanOrEqual(5)
  })

  it('a file a running program holds stays a placeholder, and the message says so', async () => {
    stub(HELD)
    const log: string[] = []
    const msg = await message(links({}, 'win32', log))
    expect(msg).toContain('usually because a running Claude Code held it')
    expect(msg).toContain(`node "${join(pkg, 'install.cjs')}"`)
    expect(readFileSync(exe, 'utf8')).toBe(PLACEHOLDER)
    expect(log.join('\n')).toContain('EBUSY')
  })

  it('runs once per host start, also for starts that arrive together: no loop', async () => {
    stub(HELD)
    const l = links()
    const [a, b, c] = await Promise.all([message(l), message(l), message(l)])
    expect(a).toContain('held it')
    expect([b, c]).toEqual([a, a])
    expect(await message(l)).toBe(a)
    expect(runs()).toBe(1)
    // A second host (a fresh ClaudeLinks) tries once again
    await message(links())
    expect(runs()).toBe(2)
  })

  it('once repaired, a placeholder that appears later is not repaired again by this host', async () => {
    stub(COPIES)
    const l = links()
    await l.ensure(exe)
    rmSync(exe)
    writeFileSync(exe, PLACEHOLDER)
    const msg = await message(l)
    expect(msg).toContain(`Centralu already ran that setup step once since it started (\`node "${join(pkg, 'install.cjs')}"\`) and does not run it again.`)
    expect(runs()).toBe(1)
  })

  it('without install.cjs it explains as before and runs nothing', async () => {
    stub(null)
    const log: string[] = []
    const msg = await message(links({}, 'win32', log))
    expect(msg).toContain('reinstall it with `npm i -g @anthropic-ai/claude-code`')
    expect(msg).not.toContain('Centralu ran')
    expect(log).toEqual([])
  })

  it('a setup step that fails for another reason, or does not finish, says what it said', async () => {
    stub("console.error('Native package not found'); process.exitCode = 1")
    expect(await message(links())).toContain('exit code 1: Native package not found')
    stub('')
    expect(await message(links())).toContain('it left the placeholder in place')
    stub(COPIES)
    const timedOut = await message(links({ runInstaller: async () => ({ status: null, output: 'it did not finish within 30 seconds' }) }))
    expect(timedOut).toContain('it did not repair the file: it did not finish within 30 seconds')
    expect(timedOut).not.toContain('held it')
    expect(runs()).toBe(0)
  })

  it('a copy cut short by a failure is not a repaired program, however large', async () => {
    stub(TRUNCATED, BIG_PROGRAM)
    const l = links()
    const msg = await message(l)
    expect(statSync(exe).size).toBe(2_000_002)
    expect(msg).toContain(`is 2000002 bytes and not the ${BIG_PROGRAM.length} bytes of the Claude program it was copied from`)
    expect(msg).toContain('it did not finish the copy: exit code 1: ENOSPC')
    expect(() => l.prepare(exe)).toThrow(ClaudePlaceholderError)
    // Nothing was linked from it
    expect(existsSync(join(root, 'tools'))).toBe(false)
    // A person who put the program there by hand is believed: the file is not the one the step left
    writeFileSync(exe, BIG_PROGRAM)
    expect(() => l.prepare(exe)).not.toThrow()
  })

  it('a copy cut short by the time limit is not a repaired program either', async () => {
    stub(STUCK, BIG_PROGRAM)
    const log: string[] = []
    const started = Date.now()
    const msg = await message(new ClaudeLinks({ platform: 'win32', root: () => root, log: (l) => log.push(l), installerTimeoutMs: 1000 }))
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(msg).toContain('it did not finish the copy: it did not finish within 1 second')
    expect(msg).toContain('not the 3000002 bytes')
    expect(log.join('\n')).toContain('not proven to be the program')
    expect(existsSync(join(root, 'tools'))).toBe(false)
  })

  it('without the platform package to compare with, the program must run --version and exit 0', async () => {
    stub(COPIES, null)
    const asked: string[][] = []
    const ok = await links({ runProgram: async (_p, args) => (asked.push(args), { status: 0 }) }).ensure(exe)
    expect(asked).toEqual([['--version']])
    expect(readFileSync(ok.path)).toEqual(PROGRAM)

    stub(COPIES, null)
    const bad = await message(links({ runProgram: async () => ({ status: 1 }) }))
    expect(bad).toContain('it does not run (`--version` failed)')
    expect(bad).toContain('it did not finish the copy')
  })

  it('off Windows nothing runs', async () => {
    stub(COPIES)
    expect(await links({}, 'darwin').ensure(exe)).toEqual({ path: exe, key: null })
    expect(runs()).toBe(0)
  })

  it('a program that is already in place does not run it', async () => {
    stub(COPIES)
    rmSync(exe)
    writeFileSync(exe, PROGRAM)
    await links().ensure(exe)
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
