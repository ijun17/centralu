import { describe, expect, it } from 'vitest'
import { CONTRACT, outcome, ready } from './contract.test-helpers.js'
import { memoryOs, type MemoryOs, type ProgramContext } from './memory.js'
import { forAll, name, recase } from './property.test-helpers.js'
import type { OsFamily } from './rules.js'
import { CLOSE_AFTER_EXIT_MS, RUN_STOP_GRACE_MS } from './run.js'

/**
 * The in-memory OS (#1599, docs/plans/os-layer.md §7.1) answering as each family does, on whatever OS this runs: the
 * contract's cases with each family's measured answers, properties of its names, and its processes and clock.
 * `real.test.ts` holds it to the real OS on the OS the tests run on.
 */

const FAMILIES: OsFamily[] = ['windows', 'posix']

/** A program that runs until it is ended */
const waits = (ctx: ProgramContext) => new Promise<void>((resolve) => ctx.ended.addEventListener('abort', () => resolve()))
/** The same, saying `ready` first (the contract's waiter) */
const waitsReady = (ctx: ProgramContext) => (ctx.stdout.write('ready'), waits(ctx))

function fresh(family: OsFamily, symlinks = true): MemoryOs {
  const os = memoryOs({ as: family, symlinks })
  os.programs.add(os.env.execPath, waitsReady)
  return os
}

describe('the in-memory OS answers the contract as each family does', () => {
  for (const family of FAMILIES) {
    for (const c of CONTRACT) {
      it(`${family}: ${c.name}`, async () => {
        const os = fresh(family)
        const root = os.files.mkdtempSync(os.paths.path.join(os.env.temp, 'c-'))
        const got = await outcome(() => c.run(os, root, { waiter: (cwd) => ready(os.processes.start(os.env.execPath, ['wait'], { cwd })) }))
        expect(got).toEqual(c.want[family])
      })
    }
  }

  it('windows: a symlink needs the right to make one; a junction does not', async () => {
    const os = fresh('windows', false)
    const t = os.paths.path.join(os.env.temp, 't')
    os.files.mkdirSync(t)
    expect(await outcome(() => os.files.symlinkSync(t, `${t}-s`, 'dir'))).toEqual({ error: 'EPERM' })
    expect(await outcome(() => (os.files.symlinkSync(t, `${t}-j`, 'junction'), 'ok'))).toBe('ok')
    // A junction is absolute: a relative target is read from its folder
    os.files.symlinkSync('t', `${t}-r`, 'junction')
    expect(os.files.readlinkSync(`${t}-r`)).toBe(t)
  })

  it('windows: a junction to a file is made but leads nowhere', async () => {
    const os = fresh('windows')
    const f = os.paths.path.join(os.env.temp, 'f')
    os.files.writeFileSync(f, 'x')
    os.files.symlinkSync(f, `${f}-j`, 'junction')
    expect(os.files.lstatSync(`${f}-j`).isSymbolicLink()).toBe(true)
    expect(await outcome(() => os.files.statSync(`${f}-j`))).toEqual({ error: 'ENOENT' })
  })

  it('a rename across volumes is EXDEV', async () => {
    const win = memoryOs({ as: 'windows', volumes: ['D'] })
    win.files.writeFileSync('C:\\a', 'x')
    win.files.mkdirSync('D:\\d')
    expect(await outcome(() => win.files.renameSync('C:\\a', 'D:\\d\\a'))).toEqual({ error: 'EXDEV' })
    const nix = memoryOs({ as: 'posix', volumes: ['/mnt/usb'] })
    nix.files.writeFileSync('/tmp/a', 'x')
    expect(await outcome(() => nix.files.renameSync('/tmp/a', '/mnt/usb/a'))).toEqual({ error: 'EXDEV' })
    expect(nix.files.statSync('/mnt/usb').dev).not.toBe(nix.files.statSync('/tmp').dev)
  })

  it("windows: a running program's file is renamed but not deleted", async () => {
    const os = fresh('windows')
    const exe = 'C:\\tools\\w.exe'
    os.programs.add(exe, waits)
    const child = os.processes.start(exe, [])
    await new Promise<void>((r) => child.once('spawn', () => r()))
    expect(await outcome(() => os.files.unlinkSync(exe))).toEqual({ error: 'EPERM' })
    expect(await outcome(() => (os.files.renameSync(exe, `${exe}.old`), 'ok'))).toBe('ok')
    await os.processes.stop(child, 0)
    expect(await outcome(() => (os.files.unlinkSync(`${exe}.old`), 'ok'))).toBe('ok')
  })
})

describe('names, by property', () => {
  for (const family of FAMILIES) {
    it(`${family}: a name written is read in any case on Windows, only as written elsewhere, and listed as written`, () => {
      forAll(
        (r) => {
          const names = [...new Set(Array.from({ length: r.int(1, 6) }, () => name(r)))]
          return { names, asked: names.map((n) => recase(r, n)) }
        },
        ({ names, asked }) => {
          const os = memoryOs({ as: family })
          const dir = os.files.mkdtempSync(os.paths.path.join(os.env.temp, 'p-'))
          const written: string[] = []
          for (const n of names) {
            // On Windows two names that differ only by case are one file: the first one written keeps its spelling
            if (family === 'windows' && written.some((w) => w.toLowerCase() === n.toLowerCase())) continue
            os.files.writeFileSync(os.paths.path.join(dir, n), n)
            written.push(n)
          }
          expect(new Set(os.files.readdirSync(dir))).toEqual(new Set(written))
          names.forEach((n, i) => {
            const p = os.paths.path.join(dir, asked[i]!)
            const owner = written.find((w) => (family === 'windows' ? w.toLowerCase() === asked[i]!.toLowerCase() : w === asked[i]))
            expect(os.files.existsSync(p)).toBe(owner !== undefined)
            if (owner) {
              expect(os.files.readFileSync(p, 'utf8')).toBe(owner)
              expect(os.paths.path.basename(os.files.realpathNativeSync(p))).toBe(owner)
            }
          })
        },
        100,
      )
    })

    it(`${family}: a tree copied, renamed and removed leaves exactly what the steps say`, () => {
      forAll(
        (r) => Array.from({ length: r.int(1, 6) }, () => [name(r), name(r)] as const),
        (pairs) => {
          const os = memoryOs({ as: family })
          const { join } = os.paths.path
          const root = os.files.mkdtempSync(join(os.env.temp, 't-'))
          for (const [dir, file] of pairs) {
            // A name that is a folder already (or, on Windows, one in another case) is not written as a file
            if (os.files.existsSync(join(root, 'src', dir, file)) && os.files.statSync(join(root, 'src', dir, file)).isDirectory()) continue
            os.files.mkdirSync(join(root, 'src', dir), { recursive: true })
            os.files.writeFileSync(join(root, 'src', dir, file), `${dir}/${file}`)
          }
          const before = os.files.readdirSync(join(root, 'src'), { recursive: true }).sort()
          os.files.cpSync(join(root, 'src'), join(root, 'copy'), { recursive: true })
          os.files.renameSync(join(root, 'src'), join(root, 'moved'))
          expect(os.files.readdirSync(join(root, 'moved'), { recursive: true }).sort()).toEqual(before)
          expect(os.files.readdirSync(join(root, 'copy'), { recursive: true }).sort()).toEqual(before)
          os.files.rmSync(join(root, 'moved'), { recursive: true })
          expect(os.files.existsSync(join(root, 'moved'))).toBe(false)
          expect(os.files.existsSync(join(root, 'src'))).toBe(false)
        },
        100,
      )
    })
  }
})

describe('processes in memory', () => {
  for (const family of FAMILIES) {
    it(`${family}: runs a program found on PATH, with its input, output and exit code`, async () => {
      const os = memoryOs({ as: family })
      const bin = family === 'windows' ? 'C:\\Windows\\System32\\echo.exe' : '/usr/bin/echo'
      os.programs.add(bin, async (ctx) => {
        let input = ''
        for await (const chunk of ctx.stdin) input += String(chunk)
        ctx.stdout.write(`${ctx.args.join(' ')}:${input}`)
        ctx.stderr.write('note')
        return 3
      })
      const r = await os.processes.run('echo', ['a', 'b'], { input: 'in' })
      expect({ code: r.code, signal: r.signal, stdout: r.stdout.toString(), stderr: r.stderr.toString() }).toEqual({ code: 3, signal: null, stdout: 'a b:in', stderr: 'note' })
      await expect(os.processes.run('nowhere', [])).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it(`${family}: a run past its time is ended, and says so, only when the clock moves`, async () => {
      const os = memoryOs({ as: family })
      os.programs.add(os.env.execPath, waits)
      const run = os.processes.run(os.env.execPath, [], { timeoutMs: 5000 })
      let settled = false
      void run.then(() => (settled = true))
      await os.clock.advance(4999)
      expect(settled).toBe(false)
      await os.clock.advance(1)
      await os.clock.advance(3000)
      const r = await run
      expect(r.ended).toBe('timeout')
      expect(r).toMatchObject(family === 'windows' ? { code: 1, signal: null } : { code: null, signal: 'SIGTERM' })
    })

    it(`${family}: stop ends the tree: at once on Windows, TERM then KILL after the grace elsewhere`, async () => {
      const os = memoryOs({ as: family })
      const kid = family === 'windows' ? 'C:\\bin\\kid.exe' : '/usr/bin/kid'
      const root = family === 'windows' ? 'C:\\bin\\root.exe' : '/usr/bin/root'
      // The child ignores TERM; the root starts it and waits
      os.programs.add(kid, (ctx) => {
        ctx.onSignal((s) => s === 'SIGTERM')
        return waits(ctx)
      })
      os.programs.add(root, (ctx) => {
        ctx.start(kid, [])
        return waits(ctx)
      })
      const child = os.processes.start(root, [])
      await new Promise<void>((r) => child.once('spawn', () => r()))
      await os.clock.advance(0)
      const kidRow = () => os.processTable().find((p) => p.command === kid)!
      expect(kidRow().alive).toBe(true)
      const stopped = os.processes.stop(child, 3000)
      const exit = await stopped
      if (family === 'windows') {
        expect(exit).toEqual({ code: 1, signal: null })
        expect(kidRow().alive).toBe(false)
      } else {
        expect(exit).toEqual({ code: null, signal: 'SIGTERM' })
        expect(kidRow().alive).toBe(true)
        await os.clock.advance(3000)
        expect(kidRow().exit).toEqual({ code: null, signal: 'SIGKILL' })
      }
    })

    it(`${family}: a never-started child says why with 'error', and its exit carries it`, async () => {
      const os = memoryOs({ as: family })
      const child = os.processes.start('missing', [])
      const error = await new Promise((r) => child.once('error', r))
      expect(error).toMatchObject({ code: 'ENOENT' })
      expect((await child.exited).error).toMatchObject({ code: 'ENOENT' })
      expect(child.pid).toBeUndefined()
    })
  }

  it('windows: a bare name is looked for in the working folder before PATH, as Windows does', async () => {
    const os = memoryOs({ as: 'windows' })
    os.programs.add('C:\\proj\\git.exe', () => 7)
    os.programs.add('C:\\Program Files\\Git\\cmd\\git.exe', () => 0)
    os.env.set('Path', `${os.env.get('Path')};C:\\Program Files\\Git\\cmd`)
    expect((await os.processes.run('git', [], { cwd: 'C:\\proj' })).code).toBe(7)
    // Which is why the host starts what `tools.program` answers
    expect(os.tools.program('git')).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
    expect((await os.processes.run(os.tools.program('git'), [], { cwd: 'C:\\proj' })).code).toBe(0)
  })

  it('windows: tools resolve a batch shim to the program it starts', () => {
    const os = memoryOs({ as: 'windows' })
    const dir = `${os.env.get('APPDATA')}\\npm`
    os.files.mkdirSync(`${dir}\\node_modules\\@openai\\codex\\bin`, { recursive: true })
    os.files.writeFileSync(`${dir}\\node_modules\\@openai\\codex\\bin\\codex.js`, '')
    os.files.writeFileSync(`${dir}\\codex.cmd`, '@"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n')
    os.env.set('PATH', `${os.env.get('PATH')};${dir}`)
    expect(os.tools.find('codex')).toBe(`${dir}\\codex.cmd`)
    expect(os.tools.resolve('codex')).toEqual({ command: os.env.execPath, args: [`${dir}\\node_modules\\@openai\\codex\\bin\\codex.js`] })
  })

  for (const family of FAMILIES) {
    it(`${family}: a signal by pid reaches a live process, and answers false for one that is gone`, async () => {
      const os = memoryOs({ as: family })
      os.programs.add(os.env.execPath, waits)
      const child = os.processes.start(os.env.execPath, [])
      const pid = child.pid ?? 0
      expect(os.processes.signal(pid, 'SIGTERM')).toBe(true)
      expect(await child.exited).toMatchObject({ signal: 'SIGTERM' })
      expect(os.processes.signal(pid, 'SIGTERM')).toBe(false)
    })
  }

  it('the temporary folder is read from the environment as set now', () => {
    const os = memoryOs({ as: 'posix' })
    expect(os.env.temp).toBe('/tmp')
    os.env.set('TMPDIR', '/var/tmp')
    expect(os.env.temp).toBe('/var/tmp')
  })

  it('maxBuffer counts stdout and stderr each on its own, and ends the run past it', async () => {
    const os = memoryOs({ as: 'posix' })
    os.programs.add('/usr/bin/both', (ctx) => {
      ctx.stdout.write('o'.repeat(60))
      ctx.stderr.write('e'.repeat(60))
    })
    expect((await os.processes.run('both', [], { maxBuffer: 100 })).ended).toBeUndefined()
    os.programs.add('/usr/bin/much', (ctx) => (ctx.stdout.write('o'.repeat(101)), waits(ctx)))
    const run = os.processes.run('much', [], { maxBuffer: 100 })
    await os.clock.advance(RUN_STOP_GRACE_MS + CLOSE_AFTER_EXIT_MS)
    expect((await run).ended).toBe('overflow')
  })

  it('runSync answers a program that answers at once, and runShell goes through the shell', async () => {
    const os = memoryOs({ as: 'posix' })
    os.programs.add('/usr/bin/ps', () => 0, { sync: ({ args }) => ({ stdout: `rows for ${args.join(' ')}` }) })
    expect(os.processes.runSync('ps', ['-A'])).toEqual({ code: 0, signal: null, stdout: 'rows for -A', stderr: '' })
    os.programs.add('/bin/sh', (ctx) => void ctx.stdout.write(ctx.args.join('|')))
    expect((await os.processes.runShell('make setup && echo ok')).stdout.toString()).toBe('-c|make setup && echo ok')
  })
})

describe('the clock and watches in memory', () => {
  it('fires a timer only when time is moved past it, in order', async () => {
    const os = memoryOs({ as: 'posix' })
    const fired: number[] = []
    os.clock.setTimeout(() => fired.push(2), 200)
    os.clock.setTimeout(() => fired.push(1), 100)
    const t = os.clock.setTimeout(() => fired.push(3), 150)
    t.cancel()
    await os.clock.advance(150)
    expect(fired).toEqual([1])
    await os.clock.advance(50)
    expect(fired).toEqual([1, 2])
    expect(os.clock.pending()).toBe(0)
  })

  for (const family of FAMILIES) {
    it(`${family}: a watch hears a change in its folder, and below it when recursive`, async () => {
      const os = memoryOs({ as: family })
      const { join } = os.paths.path
      const dir = os.files.mkdtempSync(join(os.env.temp, 'w-'))
      os.files.mkdirSync(join(dir, 'sub'))
      const flat: Array<[string, string | null]> = []
      const deep: Array<[string, string | null]> = []
      const a = os.files.watch(dir, {}, (e, n) => flat.push([e, n]))
      const b = os.files.watch(dir, { recursive: true }, (e, n) => deep.push([e, n]))
      os.files.writeFileSync(join(dir, 'f'), 'x')
      os.files.writeFileSync(join(dir, 'sub', 'g'), 'y')
      await os.clock.advance(0)
      expect(flat.map(([, n]) => n)).toContain('f')
      expect(flat.map(([, n]) => n)).not.toContain(join('sub', 'g'))
      expect(deep.map(([, n]) => n)).toContain(join('sub', 'g'))
      a.close()
      b.close()
    })
  }
})
