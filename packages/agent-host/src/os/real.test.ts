import { copyFileSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { posix, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { SLOW } from '../../../../tooling/test-timing.js'
import { whichTool } from '../env-path.js'
import { canSymlink } from '../link.test-helpers.js'
import { traitsFor } from '../os.js'
import { removeTree } from '../temp-dir.test-helpers.js'
import { CONTRACT, memoryContext, outcome, ready } from './contract.test-helpers.js'
import { memoryOs } from './memory.js'
import { forAll, name, recase, sameOnNtfs } from './property.test-helpers.js'
import { HOST_FAMILY, realOs } from './real.js'
import { fileUrlToPath, pathRules, pathToFileUrl, type OsFamily } from './rules.js'

/**
 * The real OS against the in-memory one (#1599, docs/plans/os-layer.md §7.1), on whatever OS this runs (every OS the
 * tests run on: Linux in `verify`, Windows in its job): each contract case answers on the real OS what the in-memory OS
 * answers as this OS's family, and both answer what was measured for the family. A case the in-memory OS gets wrong
 * fails here on the OS it is wrong for.
 */

const os = realOs()
const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await removeTree(r)
})

describe('the real OS and the in-memory one answer the contract alike', () => {
  for (const c of CONTRACT) {
    it.skipIf((c.symlinks && !canSymlink) || (c.linux && process.platform === 'darwin'))(`${HOST_FAMILY}: ${c.name}`, async () => {
      const root = realpathSync.native(mkdtempSync(os.paths.path.join(tmpdir(), 'cc-os-contract-')))
      roots.push(root)
      const real = await outcome(() =>
        c.run(os, root, {
          waiter: (cwd) => ready(os.processes.start(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })),
          program: (path) => copyFileSync(process.execPath, path),
          cat: { command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'] },
        }),
      )
      const memory = memoryOs({ as: HOST_FAMILY, symlinks: canSymlink })
      memory.programs.add(memory.env.execPath, (ctx) => {
        ctx.stdout.write('ready')
        return new Promise<void>((resolve) => ctx.ended.addEventListener('abort', () => resolve()))
      })
      const memoryRoot = memory.files.mkdtempSync(memory.paths.path.join(memory.env.temp, 'c-'))
      const fake = await outcome(() => c.run(memory, memoryRoot, memoryContext(memory)))
      // macOS answers as Linux but where a case says otherwise (`darwin`); the in-memory OS models Linux
      const mac = process.platform === 'darwin' && c.darwin !== undefined
      expect(real, 'the real OS').toEqual(mac ? c.darwin : c.want[HOST_FAMILY])
      expect(fake, 'the in-memory OS').toEqual(mac ? c.want[HOST_FAMILY] : real)
    })
  }
})

describe("the rules are Node's own", () => {
  const absolute = (r: Parameters<Parameters<typeof forAll>[0]>[0], family: OsFamily) => {
    const names = Array.from({ length: r.int(0, 5) }, () => name(r) + r.pick(['', ' a', '#1', '%20', '?q']))
    return family === 'windows' ? win32.join(`${r.pick(['C', 'd'])}:\\`, ...names) : posix.join('/', ...names)
  }
  // The host's own family: Node answers the other one oddly off its OS (pathToFileURL('/', { windows: false }) is
  // file://// on Windows); rules.test.ts holds both families to the round trip
  for (const family of [HOST_FAMILY]) {
    it(`${family}: a path's file URL, and back, as Node's pathToFileURL and fileURLToPath give them`, () => {
      const windows = family === 'windows'
      forAll(
        (r) => absolute(r, family),
        (p) => {
          const url = pathToFileURL(p, { windows })
          expect(pathToFileUrl(p, family).href).toBe(url.href)
          expect(fileUrlToPath(url, family)).toBe(fileURLToPath(url, { windows }))
          expect(fileUrlToPath(url, family)).toBe(pathRules(family).resolve(p))
        },
        200,
      )
    })
  }

  it.runIf(HOST_FAMILY === 'windows')("a file URL of \\\\?\\UNC\\server\\share is the share's, as Node reads it", () => {
    const unc = '\\\\?\\UNC\\server\\share\\x'
    expect(pathToFileUrl(unc, 'windows').href).toBe(pathToFileURL(unc, { windows: true }).href)
    expect(pathToFileUrl(unc, 'windows').href).toBe('file://server/share/x')
  })
})

describe('the real OS is made of the layer modules', () => {
  it("answers the layer's questions, finds tools and runs programs as they do", async () => {
    expect(os.traits).toEqual(traitsFor())
    expect(os.tools.find('node')).toBe(whichTool('node'))
    const r = await os.processes.run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout); process.exitCode = 3'], { input: 'hé' })
    expect({ code: r.code, stdout: r.stdout.toString() }).toEqual({ code: 3, stdout: 'hé' })
    await expect(os.processes.run(os.paths.path.join(tmpdir(), 'cc-no-such-program'), [])).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('copies a tree with promises.cp without holding the event loop: other work runs between its steps', async () => {
    const root = realpathSync.native(mkdtempSync(os.paths.path.join(tmpdir(), 'cc-os-cp-')))
    roots.push(root)
    const { join } = os.paths.path
    for (let i = 0; i < 20; i++) os.files.mkdirSync(join(root, 't', `d${i}`), { recursive: true })
    let turns = 0
    let copying = true
    const count = () => {
      turns++
      if (copying) setImmediate(count)
    }
    setImmediate(count)
    await os.files.promises.cp(join(root, 't'), join(root, 'out'), { recursive: true })
    copying = false
    expect(os.files.readdirSync(join(root, 'out'))).toHaveLength(20)
    // A copy done in one synchronous go lets no turn run before it ends
    expect(turns).toBeGreaterThan(1)
  })

  it('ends a run past its time, its whole tree, and says so', async () => {
    // A child that starts a grandchild, says its pid, and waits: the grandchild must end with it
    const grandchild = "setInterval(() => {}, 1000)"
    const parent = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); process.stdout.write(String(c.pid)); setInterval(() => {}, 1000)`
    const r = await os.processes.run(process.execPath, ['-e', parent], { timeoutMs: 3000 })
    expect(r.ended).toBe('timeout')
    expect(r.code === 0 && r.signal === null).toBe(false)
    const pid = Number(r.stdout.toString())
    expect(pid).toBeGreaterThan(0)
    expect(os.processes.alive(pid)).toBe(false)
  }, 30_000 * SLOW)

  it('signals a process by pid, and answers false once it is gone', async () => {
    const child = await ready(os.processes.start(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] }))
    const pid = child.pid ?? 0
    expect(os.processes.signal(pid, 'SIGTERM')).toBe(true)
    await child.exited
    expect(os.processes.alive(pid)).toBe(false)
    expect(os.processes.signal(pid, 'SIGTERM')).toBe(false)
  }, 30_000 * SLOW)

  it('runs a command line through the OS shell', async () => {
    const r = await os.processes.runShell('echo hi')
    expect({ code: r.code, stdout: r.stdout.toString().trim() }).toEqual({ code: 0, stdout: 'hi' })
  })

  it.runIf(HOST_FAMILY === 'windows')("windows: the shell is the child's own ComSpec, not the host's", async () => {
    // A ComSpec that is not cmd: had the host's been used, `echo hi` would print hi
    const r = await os.processes.runShell('echo hi', { env: { ...process.env, ComSpec: process.execPath } })
    expect(r.stdout.toString().trim()).not.toBe('hi')
    expect(r.code).not.toBe(0)
  })

  it('stop ends what a child left running after it exited on its own', async () => {
    // The grandchild outlives its parent: on Windows outside the parent's job (detached), on POSIX in its group
    const grandchild = 'setInterval(() => {}, 1000)'
    const parent = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore', detached: process.platform === 'win32' }); c.unref(); process.stdout.write(String(c.pid))`
    const child = os.processes.start(process.execPath, ['-e', parent], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout?.on('data', (d: Buffer) => (out += String(d)))
    await child.exited
    const pid = Number(out)
    expect(pid).toBeGreaterThan(0)
    try {
      expect(os.processes.alive(pid)).toBe(true)
      await os.processes.stop(child, 1000)
      // POSIX's TERM to the group arrives a moment later
      for (let i = 0; i < 50 && os.processes.alive(pid); i++) await new Promise((r) => setTimeout(r, 100))
      expect(os.processes.alive(pid)).toBe(false)
    } finally {
      if (os.processes.alive(pid)) os.processes.signal(pid, 'SIGKILL')
    }
  }, 30_000 * SLOW)

  it("a run whose grandchild holds its output ends soon after the program exits", async () => {
    const grandchild = 'setInterval(() => {}, 1000)'
    const parent = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }); c.unref(); process.stdout.write(String(c.pid))`
    const started = Date.now()
    const r = await os.processes.run(process.execPath, ['-e', parent])
    const pid = Number(r.stdout.toString())
    try {
      expect(r.code).toBe(0)
      expect(Date.now() - started).toBeLessThan(10_000)
    } finally {
      if (pid > 0 && os.processes.alive(pid)) os.processes.signal(pid, 'SIGKILL')
    }
  }, 30_000 * SLOW)

  it('unref lets the host end while the child runs', async () => {
    const child = os.processes.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore'] })
    await new Promise<void>((r) => child.once('spawn', () => r()))
    const held = () => process.getActiveResourcesInfo().filter((k) => k === 'ProcessWrap').length
    const before = held()
    child.unref()
    expect(held()).toBe(before - 1)
    await os.processes.stop(child, 1000)
  }, 30_000 * SLOW)

  it('reads the temporary folder from the environment when asked', () => {
    const name = HOST_FAMILY === 'windows' ? 'TEMP' : 'TMPDIR'
    const was = process.env[name]
    const other = os.paths.path.join(tmpdir(), 'cc-os-temp-elsewhere')
    process.env[name] = other
    try {
      expect(os.env.temp).toBe(other)
    } finally {
      if (was === undefined) delete process.env[name]
      else process.env[name] = was
    }
  })

  it('runSync: ENOBUFS past maxBuffer with the output kept, and bytes as written when asked', () => {
    const big = os.processes.runSync(process.execPath, ['-e', "process.stdout.write('x'.repeat(70000))"], { maxBuffer: 65_536 })
    expect({ code: big.code, signal: big.signal, error: big.error?.code, length: big.stdout.length }).toEqual({ code: null, signal: 'SIGTERM', error: 'ENOBUFS', length: 70_000 })
    const bytes = os.processes.runSync(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xc7, 0xd1]))'], { encoding: 'buffer' })
    expect(bytes.stdout).toEqual(Buffer.from([0xc7, 0xd1]))
    const slow = os.processes.runSync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 300 })
    expect({ code: slow.code, signal: slow.signal, error: slow.error?.code }).toEqual({ code: null, signal: 'SIGTERM', error: 'ETIMEDOUT' })
  }, 30_000 * SLOW)

  // The share names the folder, and `realpath` does not lead back to the drive: before the parents were compared by
  // their numbers (Node's `checkParentPaths`), both copies ran until the disk was full (#1650 review)
  it.skipIf(process.platform !== 'win32')('refuses a copy into itself through a share to the same disk (\\\\localhost\\C$)', async (ctx) => {
    const root = realpathSync.native(mkdtempSync(win32.join(tmpdir(), 'cc-os-unc-')))
    roots.push(root)
    const s = win32.join(root, 's')
    os.files.mkdirSync(s)
    os.files.writeFileSync(win32.join(s, 'f'), '')
    const share = `\\\\localhost\\${root[0]}$${root.slice(2)}`
    // Administrative shares are off on some machines, and reach only for an administrator
    if (!os.files.existsSync(share)) return ctx.skip()
    expect({
      copy: await outcome(() => os.files.cpSync(s, win32.join(share, 's', 'sub'), { recursive: true })),
      promised: await outcome(() => os.files.promises.cp(s, win32.join(share, 's', 'sub'), { recursive: true })),
    }).toEqual({ copy: { error: 'ERR_FS_CP_EINVAL' }, promised: { error: 'ERR_FS_CP_EINVAL' } })
  })
})

describe('names on the real OS, by property', () => {
  it(`${HOST_FAMILY}: a name is read in another case exactly when the OS folds it, as the in-memory OS answers`, () => {
    const dir = realpathSync.native(mkdtempSync(os.paths.path.join(tmpdir(), 'cc-os-names-')))
    roots.push(dir)
    const memory = memoryOs({ as: HOST_FAMILY })
    const memoryDir = memory.files.mkdtempSync(memory.paths.path.join(memory.env.temp, 'n-'))
    let run = 0
    forAll(
      (r) => {
        const n = name(r)
        return { n, asked: recase(r, n) }
      },
      ({ n, asked }) => {
        const sub = `r${run++}`
        const answer = (o: typeof os, d: string) => {
          const { join } = o.paths.path
          o.files.mkdirSync(join(d, sub))
          o.files.writeFileSync(join(d, sub, n), n)
          return { found: o.files.existsSync(join(d, sub, asked)), list: o.files.readdirSync(join(d, sub)) }
        }
        const real = answer(os, dir)
        expect(real.found, 'the real OS').toBe(HOST_FAMILY === 'windows' ? sameOnNtfs(n, asked) : n === asked)
        expect(answer(memory, memoryDir), 'the in-memory OS').toEqual(real)
      },
      process.platform === 'darwin' ? 0 : 60,
    )
  })
})
