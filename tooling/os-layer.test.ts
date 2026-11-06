/**
 * The OS layer (#1599, docs/plans/os-layer.md): the shipped code touches the OS only in the layer, the files that
 * still do elsewhere are listed in tooling/os-allowlist.txt, which may only shrink, and the Windows job runs the tests
 * that touch the OS, picked by the same judgement (tooling/os-tests.ts).
 *
 * The rule is checked on virtual paths, as platform-checks.test.ts does, so no file is created; the selection is
 * checked on virtual files laid over the repository (`osSelector`).
 */
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { virtualFileLinter } from './eslint-virtual.test-helpers.js'
import { baseCommit, renamesSince } from './lint-allowlist.js'
import { DURATIONS, balance, splitFilesAt, splitPieces, type SplitFiles, durationsFromReports, formatDurations, osSelector, parseDurations, refreshDurations, refreshDurationsFile, remoteNodeTests, repoFiles, tightened, vitestFiles } from './os-tests.js'
import { SLOW } from './test-timing.js'
import * as layer from './os-layer.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const eslint = virtualFileLinter()
const allowlist = layer.readOsAllowlist(ROOT)

let repoPick: Promise<{ all: string[]; picked: string[] }> | undefined
/** Every test file of the repository and the ones that run on every OS: a whole-repository lint scan, so once per file */
const pickedOnRepo = () =>
  (repoPick ??= (async () => {
    const all = await vitestFiles()
    return { all, picked: await osSelector().selectTests(all) }
  })())

async function refused(filePath: string, code: string): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath: join(ROOT, filePath), warnIgnored: false })
  return (res?.messages ?? []).filter((m) => m.ruleId === 'local/os-imports').map((m) => m.message)
}

const HOST = 'packages/agent-host/src/sessions/anything.ts'

describe('touching the OS outside the OS layer', () => {
  it('refuses each OS module, bare or node:, however it is imported', async () => {
    for (const m of ['fs', 'fs/promises', 'child_process', 'os', 'path']) {
      for (const spec of [m, `node:${m}`]) {
        expect(await refused(HOST, `import * as x from '${spec}'\nexport const y = x\n`), spec).toEqual([expect.stringContaining(`'${m}'`)])
      }
    }
    expect(await refused(HOST, "import { readFileSync } from 'node:fs'\nexport const r = readFileSync\n")).toHaveLength(1)
    expect(await refused(HOST, "export { join } from 'node:path'\n")).toHaveLength(1)
    expect(await refused(HOST, "export * from 'node:os'\n")).toHaveLength(1)
    expect(await refused(HOST, "export const load = () => import('node:child_process')\n")).toHaveLength(1)
    expect(await refused(HOST, 'export const load = () => import(`node:child_process`)\n')).toHaveLength(1)
    expect(await refused(HOST, "export const fs = process.getBuiltinModule('node:fs')\n")).toHaveLength(1)
    expect(await refused(HOST, "import fs = require('node:fs')\nexport const f = fs\n")).toHaveLength(1)
    expect(await refused('packages/agent-host/src/sessions/anything.js', "import fs from 'node:fs'\nexport const f = fs\n")).toHaveLength(1)
    expect(await refused(HOST.replace(/\.ts$/, '.mjs'), "import { createRequire } from 'node:module'\nconst require = createRequire(import.meta.url)\nexport const fs = require('fs')\n")).toHaveLength(1)
  })

  it('refuses it in tests and in every checked package, not only the host', async () => {
    const code = "import { mkdtempSync } from 'node:fs'\nexport const m = mkdtempSync\n"
    expect(await refused('packages/agent-host/src/sessions/anything.test.ts', code)).toHaveLength(1)
    expect(await refused('packages/agent-host/src/sessions/anything.test-helpers.ts', code)).toHaveLength(1)
    expect(await refused('packages/ui/src/components/thing.test.tsx', code)).toHaveLength(1)
    expect(await refused('packages/protocol/src/thing.ts', code)).toHaveLength(1)
    expect(await refused('apps/web/src/thing.ts', code)).toHaveLength(1)
    expect(await refused('packaging/npm/centralu/bin/semver.mjs', code)).toHaveLength(1)
  })

  it('refuses sockets, servers, workers and the installed modules that reach the OS: the terminal, SQLite, WebSockets', async () => {
    const modules = [['net', 'net'], ['node:net', 'net'], ['node:http', 'http'], ['https', 'https'], ['node:dgram', 'dgram'], ['node:worker_threads', 'worker_threads']]
    for (const [spec, module] of [...modules, ['node-pty', 'node-pty'], ['better-sqlite3', 'better-sqlite3'], ['ws', 'ws']]) {
      expect(await refused(HOST, `import * as x from '${spec}'\nexport const y = x\n`), spec).toEqual([expect.stringContaining(`'${module}'`)])
    }
    expect(await refused(HOST, "import type { AddressInfo } from 'node:net'\nexport type A = AddressInfo\n")).toEqual([])
  })

  it('lets through what runs nothing or reads paths the same way on every OS', async () => {
    expect(await refused(HOST, "import type { Stats } from 'node:fs'\nexport type S = Stats\n")).toEqual([])
    expect(await refused(HOST, "import { type Stats } from 'node:fs'\nexport type S = Stats\n")).toEqual([])
    expect(await refused(HOST, "import { posix, win32 } from 'node:path'\nexport const j = [posix.join, win32.join]\n")).toEqual([])
    expect(await refused(HOST, "import { posix, join } from 'node:path'\nexport const j = [posix.join, join]\n")).toHaveLength(1)
    // Other Node modules are not the OS's, nor what of node:url does not convert paths
    expect(await refused(HOST, "import { randomUUID } from 'node:crypto'\nimport { URL, type fileURLToPath } from 'node:url'\nexport const r = [randomUUID, URL]\nexport type F = typeof fileURLToPath\n")).toEqual([])
  })

  it("refuses the OS reached without importing an OS module: process's, and node:url's path conversions", async () => {
    for (const [code, what] of [
      ['export const k = (pid: number) => process.kill(pid)\n', 'process.kill'],
      ['export const c = process.cwd()\n', 'process.cwd'],
      ["export const c = () => process.chdir('/')\n", 'process.chdir'],
      ['export const e = process.execPath\n', 'process.execPath'],
      ['export const p = process.env.PATH\n', 'process.env.PATH'],
      ["export const p = process.env['Path']\n", 'process.env.PATH'],
      ["import { fileURLToPath } from 'node:url'\nexport const f = fileURLToPath\n", 'url.fileURLToPath'],
      ["import { pathToFileURL as p } from 'url'\nexport const f = p\n", 'url.pathToFileURL'],
      ["import * as url from 'node:url'\nexport const f = url.fileURLToPath\n", 'url.fileURLToPath'],
      ["import { default as u } from 'node:url'\nexport const f = u.pathToFileURL\n", 'url.pathToFileURL'],
      ["export { fileURLToPath } from 'node:url'\n", 'url.fileURLToPath'],
      ['const { cwd } = process\nexport const c = cwd\n', 'process.cwd'],
      ['const { PATH: p } = process.env\nexport const c = p\n', 'process.env.PATH'],
      ['const { env: { Path } } = process\nexport const c = Path\n', 'process.env.PATH'],
      ['export const p = process.env[`PATH`]\n', 'process.env.PATH'],
      ['export const c = globalThis.process.cwd()\n', 'process.cwd'],
      ['export const c = process?.cwd()\n', 'process.cwd'],
      ["import { cwd } from 'node:process'\nexport const c = cwd\n", 'process.cwd'],
      ["import { env } from 'node:process'\nexport const p = env.PATH\n", 'process.env.PATH'],
      ["import p from 'node:process'\nexport const k = p.kill\n", 'process.kill'],
    ] as const) {
      expect(await refused(HOST, code), code).toEqual([expect.stringContaining(`'${what}'`)])
    }
    // What is the same on every OS, a `process` of the file's own, and what is not seen (docs/plans/os-layer.md §5)
    expect(await refused(HOST, "export const a = [process.argv, process.env.HOME, process.exitCode]\nexport const k = (name: 'kill') => process[name]\n")).toEqual([])
    expect(await refused(HOST, 'export const stop = (process: { kill(): void }) => process.kill()\n')).toEqual([])
    expect(await refused(HOST, "import { argv, type cwd } from 'node:process'\nexport const a = argv\nexport type C = typeof cwd\n")).toEqual([])
  })

  it('lets the layer, its tests and the listed files touch it', async () => {
    const code = "import { readFileSync } from 'node:fs'\nexport const r = readFileSync\n"
    for (const m of layer.OS_LAYER) expect(await refused(m, code), m).toEqual([])
    expect(await refused('packages/agent-host/src/dev-services/kill-tree.test.ts', code)).toEqual([])
    expect(await refused('packages/agent-host/src/dev-services/kill-tree.test-helpers.ts', code)).toEqual([])
    const listed = allowlist[0] as string
    expect(await refused(listed, code), listed).toEqual([])
  })

  it("lets a layer module's test in by its exact name only, not a name that starts like it", async () => {
    const code = "import { readFileSync } from 'node:fs'\nexport const r = readFileSync\n"
    for (const f of ['packages/agent-host/src/os.windows.test.ts', 'packages/agent-host/src/os.sessions.test.ts', 'packages/agent-host/src/os-extra.test.ts', 'packages/agent-host/src/sessions/os.test.ts']) {
      expect(await refused(f, code), f).toHaveLength(1)
      expect(layer.inOsLayer(f), f).toBe(false)
    }
  })

  it('does not check build scripts, tooling or e2e, which work on the repository', async () => {
    const code = "import { readFileSync } from 'node:fs'\nexport const r = readFileSync\n"
    expect(await refused('scripts/release-npm.mts', code)).toEqual([])
    expect(await refused('packages/agent-host/scripts/bundle.mjs', code)).toEqual([])
    expect(await refused('tooling/anything.test.ts', code)).toEqual([])
    expect(await refused('e2e/fixtures/anything.ts', code)).toEqual([])
  })

  it('names only layer modules that exist', () => {
    for (const m of layer.OS_LAYER) expect(readFileSync(join(ROOT, m), 'utf8').length, m).toBeGreaterThan(0)
  })
})

describe('the allowlist', () => {
  const text = readFileSync(join(ROOT, layer.OS_ALLOWLIST), 'utf8').replace(/\r\n/g, '\n')

  it('is sorted, one path per line, none in the layer and all in the checked code', () => {
    expect(allowlist).toEqual([...new Set(allowlist)].sort())
    expect(allowlist.filter((f) => layer.inOsLayer(f) || !layer.isChecked(f))).toEqual([])
    expect(text.endsWith('\n')).toBe(true)
  })

  it(
    'says no more than is true: every listed file exists and still touches the OS, and every such file is listed',
    async () => {
      // A file that moved behind the layer takes its line out in the same change; one that is gone does too
      expect(await osSelector().offenders(repoFiles()), `${layer.OS_ALLOWLIST} as \`tsx tooling/os-tests.ts --offenders\` prints it`).toEqual(allowlist)
    },
    120_000 * SLOW,
  )

  it(
    "lists nothing main's list does not: no new line but a file git sees renamed",
    () => {
      const ref = process.env.CC_LINT_BASE ?? 'origin/main'
      const base = baseCommit(ROOT, ref)
      if (!base) {
        // CI's verify job fetches main's history and sets CC_LINT_BASE: there, main's list has to be read
        expect(process.env.CC_LINT_BASE, `no merge base with ${ref}`).toBeUndefined()
        console.warn(`os-layer.test.ts: not compared with main's list (no merge base with ${ref})`)
        return
      }
      const main = mainList(base)
      if (main === null) {
        // Once main has the layer, its list must be readable: a list renamed or unreadable there would pass anything
        expect(gitOk(['cat-file', '-e', `${base}:tooling/os-layer.js`]), `main has tooling/os-layer.js at ${base} but no readable ${layer.OS_ALLOWLIST}`).toBe(false)
        console.warn(`os-layer.test.ts: main has no ${layer.OS_ALLOWLIST} yet at ${base}; this change brings it`)
        return
      }
      const renames = renamesSince(ROOT, base)
      expect(renames, `the renames since ${base}`).not.toBeNull()
      expect(
        grown(main, allowlist, renames ?? [], splitFilesAt(base)),
        `${layer.OS_ALLOWLIST} lists more than main's: put the new code behind the OS layer instead (docs/plans/os-layer.md)`,
      ).toEqual([])
    },
    60_000 * SLOW,
  )

  it("holds the repository's apps to their own door for starting programs, and nothing else of theirs", async () => {
    const app = '.centralu/apps/project-board/github.mjs'
    for (const code of [
      "import { execFile } from 'node:child_process'\nexport const e = execFile\n",
      "import * as cp from 'child_process'\nexport const e = cp\n",
      "export const cp = await import('node:child_process')\n",
      "export const cp = process.getBuiltinModule('node:child_process')\n",
      "import { createRequire } from 'node:module'\nexport const cp = createRequire(import.meta.url)('child_process')\n",
      "export const cp = module.createRequire(import.meta.url)('node:child_process')\n",
    ]) {
      expect(await refused(app, code), code).toEqual([expect.stringContaining("this app's door (.centralu/apps/project-board/system.mjs)")])
    }
    expect(await refused('.centralu/apps/project-board/system.mjs', "import { execFile } from 'node:child_process'\nexport const e = execFile\n")).toEqual([])
    // Its own files and paths stay its own: an app is plain Node
    expect(await refused(app, "import { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\nexport const r = [readFileSync, join, process.cwd()]\n")).toEqual([])
    expect(await refused('.centralu/apps/another/server.mjs', "import { spawn } from 'node:child_process'\nexport const s = spawn\n")).toEqual([
      expect.stringContaining('REPO_APP_DOORS'),
    ])
  })

  it("reads the board app's time only through its clock (clock.mjs)", async () => {
    const lint = async (filePath: string, code: string) => {
      const [res] = await eslint.lintText(code, { filePath: join(ROOT, filePath), warnIgnored: false })
      return (res?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-properties' || m.ruleId === 'no-restricted-syntax').map((m) => m.message)
    }
    const code = 'export const a = Date.now()\nexport const b = new Date()\nexport const c = Date()\nexport const d = new Date(5)\n'
    expect(await lint('.centralu/apps/project-board/queue.mjs', code)).toEqual([
      expect.stringContaining("the app's clock"),
      expect.stringContaining("the app's clock"),
      expect.stringContaining("the app's clock"),
    ])
    expect(await lint('.centralu/apps/project-board/bin/merge-queue.mjs', code)).toHaveLength(3)
    // Under another name, or from globalThis, it is the same clock
    for (const alias of ['const D = Date\nexport const a = D.now()\n', 'const { now } = Date\nexport const a = now()\n', 'export const a = globalThis.Date.now()\n', 'let D\nD = Date\nexport const a = D.now()\n']) {
      expect((await lint('.centralu/apps/project-board/queue.mjs', alias)).length, alias).toBeGreaterThan(0)
    }
    expect(await lint('.centralu/apps/project-board/clock.mjs', 'const D = Date\nexport const a = D.now()\n')).toEqual([])
    expect(await lint('.centralu/apps/project-board/clock.mjs', code)).toEqual([])
  })

  it('cannot grow: a new line is refused, a renamed file keeps its line, and only that file', () => {
    const main = ['packages/agent-host/src/a.ts', 'packages/agent-host/src/b.ts']
    expect(grown(main, [...main, 'packages/agent-host/src/c.ts'], [])).toEqual(['packages/agent-host/src/c.ts'])
    expect(grown(main, ['packages/agent-host/src/a.ts'], [])).toEqual([])
    expect(grown(main, ['packages/agent-host/src/a2.ts', 'packages/agent-host/src/b.ts'], [{ from: 'packages/agent-host/src/a.ts', to: 'packages/agent-host/src/a2.ts' }])).toEqual([])
    // A rename does not lend its line to a third file
    expect(grown(main, ['packages/agent-host/src/b.ts', 'packages/agent-host/src/c.ts'], [{ from: 'packages/agent-host/src/a.ts', to: 'packages/agent-host/src/a2.ts' }])).toEqual([
      'packages/agent-host/src/c.ts',
    ])
  })

  describe('hands the line of a removed file to the pieces it was split into, and to no other new file', () => {
    const dir = 'packages/agent-host/src/links/'
    const text = (n: number) => 'x\n'.repeat(n)
    const old = `${dir}install-windows.test.ts`
    const main = [old, `${dir}other.test.ts`]
    const pieces = [`${dir}install-windows-install.test.ts`, `${dir}install-windows-update.test.ts`, `${dir}install-windows.test-helpers.ts`]
    const base: Record<string, string> = { [old]: text(500), [`${dir}other.test.ts`]: text(5) }
    /** The files as `now` has them (the removed file is not there); the base has only what it had */
    const over = (now: Record<string, string>) => ({ base: (f: string) => base[f] ?? null, now: (f: string) => now[f] ?? null })
    const split: Record<string, string> = { [`${dir}other.test.ts`]: text(5), [pieces[0] as string]: text(200), [pieces[1] as string]: text(200), [pieces[2] as string]: text(150) }
    const listed = [...pieces, `${dir}other.test.ts`]

    it('takes the pieces, in the list and in tightening', () => {
      expect(grown(main, listed, [], over(split))).toEqual([])
      const offenders = new Set(listed)
      expect(tightened(`# h\n${main.join('\n')}\n`, offenders, [], over(split))).toBe(`# h\n${[...listed].sort().join('\n')}\n`)
      // Without the split files given, tightening adds nothing: the pieces are new offenders
      expect(tightened(`# h\n${main.join('\n')}\n`, offenders)).toBe(`# h\n${dir}other.test.ts\n`)
    })

    it('refuses a brand-new file of another name, a name that only begins like the stem, and one in another folder', () => {
      const stranger = `${dir}brand-new.test.ts`
      expect(grown(main, [...listed, stranger], [], over({ ...split, [stranger]: text(10) }))).toEqual([stranger])
      const near = [`${dir}install-windowsX.test.ts`, 'packages/agent-host/src/install-windows-update.test.ts']
      expect(grown(main, [...listed, ...near], [], over({ ...split, [near[0] as string]: text(10), [near[1] as string]: text(10) }))).toEqual(near)
      // A file still there lends nothing
      expect(grown(main, listed, [], over({ ...split, [old]: text(500) }))).toEqual(pieces)
    })

    it('(A) hands nothing to a file that was there before, such as shipped code with the same stem', () => {
      const away = [`packages/agent-host/src/links/away.test.ts`, `packages/agent-host/src/links/away.ts`]
      const files = { base: (f: string) => (f === away[0] || f === away[1] ? text(100) : null), now: (f: string) => (f === away[1] ? text(100) : null) }
      expect(grown(away, [away[1] as string], [], files)).toEqual([])
      // Even when the shipped file is new on the list of a main that did not have it
      expect(grown([away[0] as string], [away[1] as string], [], files)).toEqual([away[1]])
    })

    it('(B) does not let the allowance grow with the number of pieces, and caps them', () => {
      const many = Array.from({ length: 10 }, (_, i) => `${dir}install-windows-p${i}.test.ts`)
      const now = Object.fromEntries(many.map((f) => [f, text(79)]))
      expect(grown(main, [...many, `${dir}other.test.ts`], [], over({ ...now, [`${dir}other.test.ts`]: text(5) }))).toEqual(many)
      const five = many.slice(0, 5)
      expect(grown(main, [...five, `${dir}other.test.ts`], [], over({ ...Object.fromEntries(five.map((f) => [f, text(100)])), [`${dir}other.test.ts`]: text(5) }))).toEqual([])
      expect(grown(main, [...five, `${dir}other.test.ts`], [], over({ ...Object.fromEntries(five.map((f) => [f, text(140)])), [`${dir}other.test.ts`]: text(5) }))).toEqual(five)
    })

    it('hands nothing to a file that existed at the base and not on the list, though it reaches the OS now', () => {
      const x = `${dir}x.test.ts`
      const other = `${dir}x-other.test.ts`
      const files = { base: (f: string) => (f === x || f === other ? text(100) : null), now: (f: string) => (f === other ? text(100) : null) }
      expect(grown([x], [other], [], files)).toEqual([other])
      // The same file, new at the base, is a piece
      expect(grown([x], [other], [], { ...files, base: (f: string) => (f === x ? text(100) : null) })).toEqual([])
    })

    it('caps the pieces at five, though six small ones are within the line budget', () => {
      const six = Array.from({ length: 6 }, (_, i) => `${dir}install-windows-q${i}.test.ts`)
      const small = (fs: string[]) => over(Object.fromEntries([...fs.map((f) => [f, text(10)]), [`${dir}other.test.ts`, text(5)]]))
      expect(grown(main, [...six, `${dir}other.test.ts`], [], small(six))).toEqual(six)
      expect(grown(main, [...six.slice(0, 5), `${dir}other.test.ts`], [], small(six.slice(0, 5)))).toEqual([])
    })

    it('(C) hands a test no line for shipped code, nor the other way round', () => {
      const code = `${dir}install-windows-extra.ts`
      expect(grown(main, [code, `${dir}other.test.ts`], [], over({ [code]: text(400), [`${dir}other.test.ts`]: text(5) }))).toEqual([code])
      const src = `${dir}link.ts`
      const files = { base: (f: string) => (f === src ? text(100) : null), now: (f: string) => (f === `${dir}link-new.test.ts` ? text(50) : null) }
      expect(grown([src], [`${dir}link-new.test.ts`], [], files)).toEqual([`${dir}link-new.test.ts`])
    })
  })

  it('is tightened from the code (pnpm os:tighten): lines no longer needed go, comments stay, nothing is added', () => {
    const text = '# header\npackages/agent-host/src/a.ts\npackages/agent-host/src/b.ts\npackages/agent-host/src/c.ts\n'
    // Two changes took out b and c, which sit next to each other: git conflicts on them; the merged tree does not
    const offenders = new Set(['packages/agent-host/src/a.ts', 'packages/agent-host/src/new.ts'])
    expect(tightened(text, offenders)).toBe('# header\npackages/agent-host/src/a.ts\n')
    expect(tightened('packages/agent-host/src/a.ts\r\n', offenders)).toBe('packages/agent-host/src/a.ts\n')
    expect(tightened(text, new Set(layer.parseOsAllowlist(text)))).toBe(text)
  })

  it('is tightened along renames: a renamed file keeps its line under its new path, sorted, and lends it to no other', () => {
    const text = '# header\npackages/agent-host/src/a.ts\npackages/agent-host/src/b.ts\npackages/agent-host/src/c.ts\n'
    const renames = [{ from: 'packages/agent-host/src/a.ts', to: 'packages/agent-host/src/z/a.ts' }]
    // The queue took main's list on a conflict; this change renamed a.ts and took out b.ts
    const offenders = new Set(['packages/agent-host/src/z/a.ts', 'packages/agent-host/src/c.ts', 'packages/agent-host/src/new.ts'])
    expect(tightened(text, offenders, renames)).toBe('# header\npackages/agent-host/src/c.ts\npackages/agent-host/src/z/a.ts\n')
    // Without the rename the line would be gone, and the renamed file an offender off the list
    expect(tightened(text, offenders)).toBe('# header\npackages/agent-host/src/c.ts\n')
  })

  it('is a mechanical file for the merge queue, regenerated by os:tighten and checked by this test', () => {
    const board = JSON.parse(readFileSync(join(ROOT, '.centralu/apps/project-board/project.json'), 'utf8')) as {
      queue: { conflicts: { mechanical: Array<{ files: string[]; run: string[][] }> } }
    }
    const entry = board.queue.conflicts.mechanical.find((e) => e.files.includes(layer.OS_ALLOWLIST))
    expect(entry?.run.map((c) => c.join(' '))).toEqual(['pnpm install --frozen-lockfile --ignore-scripts', 'pnpm os:tighten', 'pnpm exec vitest run tooling/os-layer.test.ts'])
    const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts['os:tighten']).toBe('tsx tooling/os-tests.ts --tighten')
  })
})

/** Does this git command succeed? */
function gitOk(args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** main's allowlist at `base`, or null when there is none to read */
function mainList(base: string): string[] | null {
  try {
    return layer.parseOsAllowlist(execFileSync('git', ['show', `${base}:${layer.OS_ALLOWLIST}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return null
  }
}

/** The lines `current` has that main's list, carried along this change's renames and its split files (`splitPieces`), has not */
function grown(main: readonly string[], current: readonly string[], renames: ReadonlyArray<{ from: string; to: string }>, files?: SplitFiles): string[] {
  const expected = new Set(main)
  for (const { to } of renames) expected.delete(to)
  for (const { from, to } of renames) if (main.includes(from)) expected.add(to)
  const added = current.filter((f) => !expected.has(f))
  if (!files) return added
  const claimed = new Set([...splitPieces(main, current, added, files).values()].flat())
  return added.filter((f) => !claimed.has(f))
}

describe('the tests that run on every OS', () => {
  const pick = (files: Record<string, string>, test: string) => osSelector(new Map(Object.entries(files))).whyEveryOs(test)

  it('picks a test that imports the layer, directly or through other modules', () => {
    expect(pick({ 'packages/agent-host/src/x/a.test.ts': "import { hasPs } from '../os.js'\n" }, 'packages/agent-host/src/x/a.test.ts')).toMatch(/os\.ts/)
    const files = {
      'packages/agent-host/src/x/a.test.ts': "import { b } from './b.js'\n",
      'packages/agent-host/src/x/b.ts': "export { c as b } from './c.js'\n",
      'packages/agent-host/src/x/c.ts': "import { killTree } from '../dev-services/kill-tree.js'\nexport const c = killTree\n",
    }
    expect(pick(files, 'packages/agent-host/src/x/a.test.ts')).toBe('imports packages/agent-host/src/x/b.ts → packages/agent-host/src/x/c.ts → packages/agent-host/src/dev-services/kill-tree.ts')
  })

  it('picks a test that imports a listed file, or is one', () => {
    const listedSource = allowlist.find((f) => !/\.test\.|test-helpers/.test(f)) as string
    const listedTest = allowlist.find((f) => /\.test\.tsx?$/.test(f)) as string
    const spec = `./${listedSource.split('/').slice(-1)[0]?.replace(/\.ts$/, '.js')}`
    const test = listedSource.replace(/[^/]+$/, 'virtual.test.ts')
    expect(pick({ [test]: `import * as x from '${spec}'\nexport const y = x\n` }, test)).toBe(`imports ${listedSource}`)
    expect(pick({}, listedTest)).not.toBeNull()
  })

  it('leaves a pure ui or core test to Linux, and a tooling test that only reads the repository', () => {
    expect(pick({ 'packages/ui/src/x/a.test.tsx': "import { b } from './b.js'\nexport const a = b\n", 'packages/ui/src/x/b.ts': 'export const b = 1\n' }, 'packages/ui/src/x/a.test.tsx')).toBeNull()
    expect(pick({ 'packages/core/src/x/a.test.ts': "import { isWaiting } from '@cc/protocol'\nexport const a = isWaiting\n" }, 'packages/core/src/x/a.test.ts')).toBeNull()
    expect(pick({ 'tooling/x.test.ts': "import { readFileSync } from 'node:fs'\nexport const a = readFileSync\n" }, 'tooling/x.test.ts')).toBeNull()
  })

  it('picks a test that asks which OS this is, and one that touches the OS through a test helper', () => {
    expect(pick({ 'tooling/x.test.ts': "export const w = process.platform === 'win32'\n" }, 'tooling/x.test.ts')).toBe('asks which OS this is')
    expect(pick({ 'tooling/x.test.ts': "import { h } from '../packages/agent-host/src/x/h.test-helpers.js'\nexport const a = h\n", 'packages/agent-host/src/x/h.test-helpers.ts': "import { tmpdir } from 'node:os'\nexport const h = tmpdir\n" }, 'tooling/x.test.ts')).toMatch(/h\.test-helpers\.ts$/)
  })

  it('follows every way a test loads a module, as the lint rule reads it, and vitest loading the real one', () => {
    const helper = { 'packages/agent-host/src/x/h.ts': "import { tmpdir } from 'node:os'\nexport const h = tmpdir\n" }
    const T = 'packages/agent-host/src/x/a.test.ts'
    for (const load of [
      "import h = require('./h.js')\nexport const a = h\n",
      'export const a = () => import(`./h.js`)\n',
      "export * from './h.js'\n",
      "import { vi } from 'vitest'\nexport const a = () => vi.importActual('./h.js')\n",
      "import { vi } from 'vitest'\nvi.mock('./h.js', () => ({ h: () => '' }))\n",
    ]) {
      expect(pick({ ...helper, [T]: load }, T), load).toBe('imports packages/agent-host/src/x/h.ts')
    }
  })

  it('picks a test that reaches the OS through process, or converts a path with node:url', () => {
    const T = 'packages/agent-host/src/x/a.test.ts'
    const helper = (code: string) => ({ 'packages/agent-host/src/x/h.ts': code, [T]: "import { h } from './h.js'\nexport const a = h\n" })
    expect(pick(helper('export const h = (pid: number) => process.kill(pid)\n'), T)).toBe('imports packages/agent-host/src/x/h.ts')
    expect(pick(helper("import { pathToFileURL } from 'node:url'\nexport const h = pathToFileURL\n"), T)).toBe('imports packages/agent-host/src/x/h.ts')
    expect(pick(helper('export const h = process.argv\n'), T)).toBeNull()
  })

  it("counts the repository's own apps, which run on the person's machine, but not tooling helpers", () => {
    const app = { '.centralu/apps/x/git.mjs': "import { execFileSync } from 'node:child_process'\nexport const git = execFileSync\n" }
    expect(pick({ ...app, 'tooling/x.test.ts': "import { git } from '../.centralu/apps/x/git.mjs'\nexport const a = git\n" }, 'tooling/x.test.ts')).toBe('imports .centralu/apps/x/git.mjs')
    const helper = { 'tooling/x-helper.ts': "import { spawnSync } from 'node:child_process'\nexport const run = spawnSync\n" }
    expect(pick({ ...helper, 'tooling/x.test.ts': "import { run } from './x-helper.js'\nexport const a = run\n" }, 'tooling/x.test.ts')).toBeNull()
  })

  it("adds to the macOS job's full run the tests that make folders in the OS temp folder, and only those", async () => {
    const T = 'tooling/x.test.ts'
    const select = (files: Record<string, string>) => osSelector(new Map(Object.entries(files)))
    const code = (...body: string[]) => ({ [T]: body.join('\n') + '\n' })
    expect(await select(code("import { it } from 'vitest'", "it('x', () => {})")).selectMacTests([T])).toEqual([])
    for (const files of [
      code("import { mkdtempSync } from 'node:fs'", "mkdtempSync('x')"),
      code("import os from 'node:os'", 'os.tmpdir()'),
      code("import { realpathSync } from 'node:fs'", "realpathSync('.')"),
      code("import fs from 'node:fs'", "fs.realpathSync.native('.')"),
      code("import { realpathSync } from 'node:fs'", "realpathSync.native('.')"),
      code("export const t = process.env.TMPDIR"),
      code("export const t = process.env['TEMP']"),
    ]) {
      // Tooling tests do not count their own OS imports, so the Windows rule leaves them to Linux
      expect(await select(files).selectTests([T]), files[T]).toEqual([])
      expect(await select(files).selectMacTests([T]), files[T]).toEqual([T])
    }
    // A module it imports does: the script a test checks makes its temp folder
    const helper = { 'tooling/x-helper.mjs': "import { mkdtempSync } from 'node:fs'; export const h = () => mkdtempSync('x')", [T]: "import { h } from './x-helper.mjs'; export const a = h" }
    expect(await select(helper).selectMacTests([T])).toEqual([T])
    // Reading a file of the repository is not it
    expect(await select(code("import { readFileSync } from 'node:fs'", "readFileSync('x')")).selectMacTests([T])).toEqual([])
  })

  it('refuses to guess past an import it cannot follow', () => {
    expect(() => pick({ 'packages/ui/src/x/a.test.ts': "import { b } from './gone.js'\nexport const a = b\n" }, 'packages/ui/src/x/a.test.ts')).toThrow(/names no file/)
  })

  it(
    'on the repository: every layer test and every listed test runs, no ui or core test does, and a listed run runs exactly the list',
    async () => {
      const { all, picked: pickedList } = await pickedOnRepo()
      const picked = new Set(pickedList)
      for (const t of all.filter((f) => layer.inOsLayer(f) || allowlist.includes(f))) expect(picked.has(t), t).toBe(true)
      for (const { file } of layer.EVERY_OS_TESTS) expect(picked.has(file), file).toBe(true)
      expect([...picked].filter((t) => /^packages\/(ui|core)\//.test(t))).toEqual([])
      // vitest.config.ts `CC_TEST_FILES`, across both projects (one is the external-app runtime's own)
      const sample = [...picked].filter((_, i) => i % 50 === 0)
      sample.push(all.find((t) => t.startsWith('packages/agent-host/src/apps/external/')) as string)
      const list = join(mkdtempSync(join(tmpdir(), 'os-tests-')), 'list.txt')
      writeFileSync(list, sample.join('\r\n') + '\r\n')
      expect(await vitestFiles(list)).toEqual([...new Set(sample)].sort())
    },
    120_000 * SLOW,
  )
})

describe('a listed run (vitest.config.ts `CC_TEST_FILES`)', () => {
  const listFile = (lines: string[]) => {
    const list = join(mkdtempSync(join(tmpdir(), 'os-tests-')), 'list.txt')
    writeFileSync(list, lines.map((l) => `${l}\n`).join(''))
    return list
  }

  it('refuses a line that is not an existing repository path, rather than run less without a word', async () => {
    for (const bad of ['tooling\\os-layer.test.ts', './tooling/os-layer.test.ts', 'tooling/gone.test.ts', 'tooling/fixtures']) {
      await expect(vitestFiles(listFile(['tooling/test-timing.test.ts', bad])), bad).rejects.toThrow(/CC_TEST_FILES: '.*' is not a test file's repository path/)
    }
  }, 60_000 * SLOW)

  it("does not pass its list on: a listed test that starts a vitest of its own runs that vitest's files", async () => {
    // tooling/vitest-stall-watch.test.ts does this; its child once found no test files on the Windows shard (#1600)
    const out = await new Promise<{ code: number | null; text: string }>((done) => {
      const child = execFile(
        process.execPath,
        [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', '--project', 'unit', '--maxWorkers=1'],
        {
          cwd: ROOT,
          timeout: 60_000 * SLOW,
          env: { ...process.env, CC_TEST_FILES: listFile(['tooling/fixtures/listed/outer.test.ts']), CC_LISTED_PROBE: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
        },
        (_e, stdout, stderr) => done({ code: child.exitCode, text: `${stdout}\n${stderr}` }),
      )
    })
    expect(out.text).toMatch(/Tests {2}1 passed/)
    expect(out.code, out.text).toBe(0)
  }, 70_000 * SLOW)
})

describe("the Windows shards, split by each file's measured time", () => {
  it('puts every test in exactly one shard, the longest apart, and the same split on every shard', () => {
    const durations = { 'a.test.ts': 875, 'b.test.ts': 861, 'c.test.ts': 168, 'd.test.ts': 142, 'e.test.ts': 1, 'f.test.ts': 1 }
    const tests = Object.keys(durations)
    const lists = balance(tests, durations, 2)
    expect(lists.flat().sort()).toEqual(tests)
    expect(lists.findIndex((l) => l.includes('a.test.ts'))).not.toBe(lists.findIndex((l) => l.includes('b.test.ts')))
    const secs = lists.map((l) => l.reduce((s, t) => s + (durations[t as keyof typeof durations] ?? 0), 0))
    expect(Math.abs((secs[0] ?? 0) - (secs[1] ?? 0))).toBeLessThanOrEqual(30)
    expect(balance([...tests].reverse(), durations, 2)).toEqual(lists)
  })

  it('weighs a file with no measured time as the median one, at least a second', () => {
    const durations = { 'a.test.ts': 10, 'b.test.ts': 2, 'c.test.ts': 2 }
    // new1 and new2 weigh 2 each: a holds 10, the other shard takes b, c and both new files
    expect(balance(['a.test.ts', 'b.test.ts', 'c.test.ts', 'new1.test.ts', 'new2.test.ts'], durations, 2)).toEqual([['a.test.ts'], ['b.test.ts', 'c.test.ts', 'new1.test.ts', 'new2.test.ts']])
    expect(balance(['x.test.ts', 'y.test.ts'], {}, 2)).toEqual([['x.test.ts'], ['y.test.ts']])
  })

  it("reads each file's time from vitest JSON reports, wherever the runner checked the repository out", () => {
    const report = (name: string, ms: number) => ({ testResults: [{ name, startTime: 1000, endTime: 1000 + ms }] })
    expect(
      durationsFromReports([
        report('D:\\a\\centralu\\centralu\\packages\\agent-host\\src\\os.test.ts', 1234),
        report('/home/runner/work/centralu/centralu/tooling/launcher-cmd.test.ts', 50),
      ]),
    ).toEqual({ 'packages/agent-host/src/os.test.ts': 1.2, 'tooling/launcher-cmd.test.ts': 0.1 })
    expect(() => durationsFromReports([{ not: 'a report' }])).toThrow(/testResults/)
  })

  describe('--refresh-durations, on a durations file and reports in a folder', () => {
    const tests = ['tooling/a.test.ts', 'tooling/b.test.ts', 'tooling/c.test.ts', 'tooling/d.test.ts']
    const report = (times: Record<string, number>) => ({ testResults: Object.entries(times).map(([name, secs]) => ({ name: `/w/${name}`, startTime: 0, endTime: secs * 1000 })) })
    /** A folder with the durations file and one report of the run; the paths of both */
    function setup(current: Record<string, number>, run: unknown) {
      const dir = mkdtempSync(join(tmpdir(), 'os-tests-durations-'))
      const file = join(dir, 'test-durations.json')
      const reportFile = join(dir, 'vitest-times.json')
      writeFileSync(file, formatDurations(current, 'an older run, 2026-01-01'))
      writeFileSync(reportFile, JSON.stringify(run))
      return { file, reportFile, text: () => readFileSync(file, 'utf8') }
    }
    const read = (text: string) => parseDurations(text)

    it('writes the run over the file for the tests that exist, and keeps or drops the rest (#1983)', () => {
      // The run predates a split (old.test.ts became c and d) and a delete (gone.test.ts)
      const f = setup({ 'tooling/a.test.ts': 1, 'tooling/b.test.ts': 3, 'tooling/c.test.ts': 5 }, report({ 'tooling/a.test.ts': 9, 'tooling/b.test.ts': 4, 'tooling/old.test.ts': 400, 'tooling/gone.test.ts': 7 }))
      const said = refreshDurationsFile(f.file, [f.reportFile], tests, new Date('2026-11-05T03:00:00Z'))
      // a and b from the run, c kept, d new at the median of those (4, 5, 9 -> 5)
      expect(read(f.text())).toEqual({ 'tooling/a.test.ts': 9, 'tooling/b.test.ts': 4, 'tooling/c.test.ts': 5, 'tooling/d.test.ts': 5 })
      expect(JSON.parse(f.text()).source).toContain('2026-11-05')
      expect(said).toContain('2 timed by the run, 1 kept, 1 new')
    })

    it('leaves the file alone when only the date would change, and says so', () => {
      const same = { 'tooling/a.test.ts': 1, 'tooling/b.test.ts': 3, 'tooling/c.test.ts': 5, 'tooling/d.test.ts': 5 }
      const f = setup(same, report({ 'tooling/a.test.ts': 1, 'tooling/b.test.ts': 3, 'tooling/c.test.ts': 5, 'tooling/d.test.ts': 5, 'tooling/gone.test.ts': 2 }))
      const before = f.text()
      const said = refreshDurationsFile(f.file, [f.reportFile], tests, new Date('2026-11-05T03:00:00Z'))
      expect(f.text()).toBe(before)
      expect(said).toContain('unchanged')
      // A name only the run has (gone here) is not a drop from the file
      expect(said).toContain('0 dropped')
    })

    it('refuses reports that time fewer than half of the selected tests, and writes nothing', () => {
      const f = setup({ 'tooling/a.test.ts': 1 }, report({}))
      const before = f.text()
      expect(() => refreshDurationsFile(f.file, [f.reportFile], tests)).toThrow(/time 0 of the 4 tests/)
      expect(f.text()).toBe(before)
      const wrong = setup({ 'tooling/a.test.ts': 1 }, report({ 'tooling/a.test.ts': 2, 'tooling/other.test.ts': 2, 'tooling/x.test.ts': 2 }))
      expect(() => refreshDurationsFile(wrong.file, [wrong.reportFile], tests)).toThrow(/fewer than half/)
      // Exactly half is enough
      const half = setup({}, report({ 'tooling/a.test.ts': 2, 'tooling/b.test.ts': 2 }))
      expect(() => refreshDurationsFile(half.file, [half.reportFile], tests)).not.toThrow()
    })
  })

  it('refreshes from a run that predates a split and a delete: the files on this checkout, never the ones the run knew', () => {
    // The run is from before install-windows.test.ts became three files and before gone.test.ts was deleted. The
    // file now holds one piece (update) and none of the others (#1983).
    const run = durationsFromReports([
      { testResults: [{ name: '/w/tooling/links/install-windows.test.ts', startTime: 0, endTime: 368_900 }, { name: '/w/tooling/gone.test.ts', startTime: 0, endTime: 5000 }, { name: '/w/tooling/a.test.ts', startTime: 0, endTime: 10_000 }] },
      { testResults: [{ name: '/w/tooling/b.test.ts', startTime: 0, endTime: 2000 }] },
    ])
    const current = { 'tooling/a.test.ts': 4, 'tooling/b.test.ts': 6, 'tooling/c.test.ts': 8, 'tooling/links/install-windows-update.test.ts': 6 }
    const tests = ['tooling/a.test.ts', 'tooling/b.test.ts', 'tooling/c.test.ts', 'tooling/links/install-windows-install.test.ts', 'tooling/links/install-windows-switch.test.ts', 'tooling/links/install-windows-update.test.ts']
    // The reports alone, which is all the first refresh wrote, name the old file and miss the pieces
    expect(Object.keys(run)).toContain('tooling/links/install-windows.test.ts')
    expect(Object.keys(run)).not.toContain('tooling/links/install-windows-switch.test.ts')
    // Timed by the run (a, b); kept (c, update); the median of those four, 2, 6, 8 and 10 -> 8, for the two new pieces
    expect(refreshDurations(current, run, tests)).toEqual({
      'tooling/a.test.ts': 10,
      'tooling/b.test.ts': 2,
      'tooling/c.test.ts': 8,
      'tooling/links/install-windows-install.test.ts': 8,
      'tooling/links/install-windows-switch.test.ts': 8,
      'tooling/links/install-windows-update.test.ts': 6,
    })
  })

  it(`keeps ${DURATIONS} as --refresh-durations writes it, with a time for most tests Windows runs`, async () => {
    const text = readFileSync(join(ROOT, DURATIONS), 'utf8').replace(/\r\n/g, '\n')
    const durations = parseDurations(text)
    const source = (JSON.parse(text) as { source: string }).source
    expect(formatDurations(durations, source)).toBe(text)
    // A missing file only weighs the median; most having a time is what keeps the shards even
    const { all, picked } = await pickedOnRepo()
    expect(picked.filter((t) => durations[t] !== undefined).length / picked.length).toBeGreaterThan(0.8)
    // And for the remote Node's Windows shards, which split by the same file (review of #2017: 94 of 525 had none, 6.0 and 9.1 minutes)
    const remote = remoteNodeTests(all)
    expect(remote.filter((t) => durations[t] !== undefined).length / remote.length).toBeGreaterThan(0.9)
  }, 120_000 * SLOW)
})
