/**
 * The OS layer (#1599, docs/plans/os-layer.md): the shipped code touches the OS only in the layer, the files that
 * still do elsewhere are listed in tooling/os-allowlist.txt, which may only shrink, and the Windows job runs the tests
 * that touch the OS, picked by the same judgement (tooling/os-tests.ts).
 *
 * The rule is checked on virtual paths, as platform-checks.test.ts does, so no file is created; the selection is
 * checked on virtual files laid over the repository (`osSelector`).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { virtualFileLinter } from './eslint-virtual.test-helpers.js'
import { addedSince, baseCommit, renamesSince } from './lint-allowlist.js'
import { osSelector, repoFiles, vitestFiles } from './os-tests.js'
import { SLOW } from './test-timing.js'
import * as layer from './os-layer.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const eslint = virtualFileLinter()
const allowlist = layer.readOsAllowlist(ROOT)

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

  it('lets through what runs nothing or reads paths the same way on every OS', async () => {
    expect(await refused(HOST, "import type { Stats } from 'node:fs'\nexport type S = Stats\n")).toEqual([])
    expect(await refused(HOST, "import { type Stats } from 'node:fs'\nexport type S = Stats\n")).toEqual([])
    expect(await refused(HOST, "import { posix, win32 } from 'node:path'\nexport const j = [posix.join, win32.join]\n")).toEqual([])
    expect(await refused(HOST, "import { posix, join } from 'node:path'\nexport const j = [posix.join, join]\n")).toHaveLength(1)
    // Other Node modules are not the OS's
    expect(await refused(HOST, "import { randomUUID } from 'node:crypto'\nimport { fileURLToPath } from 'node:url'\nexport const r = [randomUUID, fileURLToPath]\n")).toEqual([])
  })

  it('lets the layer, its tests and the listed files touch it', async () => {
    const code = "import { readFileSync } from 'node:fs'\nexport const r = readFileSync\n"
    for (const m of layer.OS_LAYER) expect(await refused(m, code), m).toEqual([])
    expect(await refused('packages/agent-host/src/dev-services/kill-tree.test.ts', code)).toEqual([])
    expect(await refused('packages/agent-host/src/os.windows.test.ts', code)).toEqual([])
    const listed = allowlist[0] as string
    expect(await refused(listed, code), listed).toEqual([])
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
    () => {
      // A file that moved behind the layer takes its line out in the same change; one that is gone does too
      expect(osSelector().offenders(repoFiles()), `${layer.OS_ALLOWLIST} as \`tsx tooling/os-tests.ts --offenders\` prints it`).toEqual(allowlist)
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
        console.warn(`os-layer.test.ts: main has no ${layer.OS_ALLOWLIST} yet at ${base}; this change brings it`)
        return
      }
      const renames = renamesSince(ROOT, base)
      const added = addedSince(ROOT, base)
      expect(renames, `the renames since ${base}`).not.toBeNull()
      expect(added, `the files added since ${base}`).not.toBeNull()
      expect(
        grown(main, allowlist, renames ?? [], added ?? []),
        `${layer.OS_ALLOWLIST} lists more than main's: put the new code behind the OS layer instead (docs/plans/os-layer.md)`,
      ).toEqual([])
    },
    60_000 * SLOW,
  )

  it('cannot grow: a new line is refused, a renamed file keeps its line, a file added at a listed path does not', () => {
    const main = ['packages/agent-host/src/a.ts', 'packages/agent-host/src/b.ts']
    expect(grown(main, [...main, 'packages/agent-host/src/c.ts'], [], [])).toEqual(['packages/agent-host/src/c.ts'])
    expect(grown(main, ['packages/agent-host/src/a.ts'], [], [])).toEqual([])
    expect(grown(main, ['packages/agent-host/src/a2.ts', 'packages/agent-host/src/b.ts'], [{ from: 'packages/agent-host/src/a.ts', to: 'packages/agent-host/src/a2.ts' }], [])).toEqual([])
    // b.ts deleted and a new b.ts added: the new file holds nothing from the old line
    expect(grown(main, main, [], ['packages/agent-host/src/b.ts'])).toEqual(['packages/agent-host/src/b.ts'])
    // A rename does not lend its line to a third file
    expect(grown(main, ['packages/agent-host/src/b.ts', 'packages/agent-host/src/c.ts'], [{ from: 'packages/agent-host/src/a.ts', to: 'packages/agent-host/src/a2.ts' }], [])).toEqual([
      'packages/agent-host/src/c.ts',
    ])
  })
})

/** main's allowlist at `base`, or null before it existed */
function mainList(base: string): string[] | null {
  try {
    return layer.parseOsAllowlist(execFileSync('git', ['show', `${base}:${layer.OS_ALLOWLIST}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return null
  }
}

/** The lines `current` has that main's list, carried along this change's renames, has not */
function grown(main: readonly string[], current: readonly string[], renames: ReadonlyArray<{ from: string; to: string }>, added: readonly string[]): string[] {
  const expected = new Set(main)
  for (const { to } of renames) expected.delete(to)
  for (const { from, to } of renames) if (main.includes(from)) expected.add(to)
  for (const file of added) expected.delete(file)
  return current.filter((f) => !expected.has(f))
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

  it('refuses to guess past an import it cannot follow', () => {
    expect(() => pick({ 'packages/ui/src/x/a.test.ts': "import { b } from './gone.js'\nexport const a = b\n" }, 'packages/ui/src/x/a.test.ts')).toThrow(/names no file/)
  })

  it(
    'on the repository: every layer test and every listed test runs, no ui or core test does, and a listed run runs exactly the list',
    async () => {
      const all = await vitestFiles()
      const picked = new Set(osSelector().selectTests(all))
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
