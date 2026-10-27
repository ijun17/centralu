import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { posix, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { whichTool } from '../env-path.js'
import { canSymlink } from '../link.test-helpers.js'
import { traitsFor } from '../os.js'
import { removeTree } from '../temp-dir.test-helpers.js'
import { CONTRACT, outcome, ready } from './contract.test-helpers.js'
import { memoryOs } from './memory.js'
import { forAll, name } from './property.test-helpers.js'
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
    it.skipIf(c.symlinks && !canSymlink)(`${HOST_FAMILY}: ${c.name}`, async () => {
      const root = realpathSync.native(mkdtempSync(os.paths.path.join(tmpdir(), 'cc-os-contract-')))
      roots.push(root)
      const real = await outcome(() =>
        c.run(os, root, {
          waiter: (cwd) => ready(os.processes.start(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })),
        }),
      )
      const memory = memoryOs({ as: HOST_FAMILY, symlinks: canSymlink })
      const waits = memory.env.execPath
      memory.programs.add(waits, (ctx) => {
        ctx.stdout.write('ready')
        return new Promise<void>((resolve) => ctx.ended.addEventListener('abort', () => resolve()))
      })
      const memoryRoot = memory.files.mkdtempSync(memory.paths.path.join(memory.env.temp, 'c-'))
      const fake = await outcome(() => c.run(memory, memoryRoot, { waiter: (cwd) => ready(memory.processes.start(waits, [], { cwd })) }))
      expect(real, 'the real OS').toEqual(c.want[HOST_FAMILY])
      expect(fake, 'the in-memory OS').toEqual(real)
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
})

describe('the real OS is made of the layer modules', () => {
  it("answers the layer's questions, finds tools and runs programs as they do", async () => {
    expect(os.traits).toEqual(traitsFor())
    expect(os.tools.find('node')).toBe(whichTool('node'))
    const r = await os.processes.run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout); process.exitCode = 3'], { input: 'hé' })
    expect({ code: r.code, stdout: r.stdout.toString() }).toEqual({ code: 3, stdout: 'hé' })
    await expect(os.processes.run(os.paths.path.join(tmpdir(), 'cc-no-such-program'), [])).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('ends a run past its time, its whole tree, and says so', async () => {
    const r = await os.processes.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 })
    expect(r.ended).toBe('timeout')
    expect(r.code === 0 && r.signal === null).toBe(false)
  })
})
