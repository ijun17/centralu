/**
 * `local/platform-checks` (tooling/eslint-platform-checks.js): asking which OS this is is reported
 * everywhere in the shipped code except the platform modules. Lints virtual paths, as
 * boundaries.test.ts does, so no file is created.
 */
import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error — the lint configuration is plain JavaScript, no types on purpose
import { PLATFORM_MODULES as MODULES } from '../eslint.config.js'

const PLATFORM_MODULES = MODULES as string[]

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const eslint = new ESLint({ cwd: ROOT })

async function checks(filePath: string, code: string): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath: join(ROOT, filePath), warnIgnored: false })
  return (res?.messages ?? []).filter((m) => m.ruleId === 'local/platform-checks').map((m) => m.message)
}

const HOST = 'packages/agent-host/src/sessions/anything.ts'

describe('asking which OS this is, outside a platform module', () => {
  it('reports reading process.platform', async () => {
    expect(await checks(HOST, 'export const p = process.platform\n')).toEqual([expect.stringContaining('process.platform')])
    expect(await checks(HOST, "export const p = process['platform']\n")).toHaveLength(1)
    expect(await checks(HOST, 'export const k = `${process.platform}-${process.arch}`\n')).toHaveLength(1)
  })

  it('reports os.platform() and os.type(), however os is imported', async () => {
    expect(await checks(HOST, "import os from 'node:os'\nexport const p = os.platform()\n")).toHaveLength(1)
    expect(await checks(HOST, "import * as os from 'os'\nexport const t = os.type()\n")).toHaveLength(1)
    expect(await checks(HOST, "import { platform } from 'node:os'\nexport const p = platform()\n")).toHaveLength(1)
    // Other things from os are fine
    expect(await checks(HOST, "import { homedir } from 'node:os'\nexport const h = homedir()\n")).toEqual([])
  })

  it('reports a comparison with an OS name, whatever is compared', async () => {
    const code = (expr: string) => `declare const deps: { platform: string }\nexport const w = ${expr}\n`
    expect(await checks(HOST, code("deps.platform === 'win32'"))).toEqual([expect.stringContaining("'win32'")])
    expect(await checks(HOST, code("'darwin' !== deps.platform"))).toHaveLength(1)
    expect(await checks(HOST, code("deps.platform == 'linux'"))).toHaveLength(1)
    expect(
      await checks(HOST, "declare const p: string\nexport function f() {\n  switch (p) {\n    case 'win32':\n      return 1\n  }\n  return 0\n}\n"),
    ).toHaveLength(1)
    // A string that only contains an OS name is not a check
    expect(await checks(HOST, code("deps.platform === 'win32-x64'"))).toEqual([])
  })

  it('is checked in the UI, the apps and the npm launcher too', async () => {
    const code = 'export const p = process.platform\n'
    expect(await checks('packages/ui/src/components/thing.tsx', code)).toHaveLength(1)
    expect(await checks('packages/platform/src/tauri/thing.ts', code)).toHaveLength(1)
    expect(await checks('apps/desktop/src/thing.tsx', code)).toHaveLength(1)
    expect(await checks('packaging/npm/centralu/bin/semver.mjs', code)).toHaveLength(1)
  })
})

describe('where it may be asked', () => {
  const code = "export const w = process.platform === 'win32'\n"

  it('in every platform module', async () => {
    for (const m of PLATFORM_MODULES) {
      const file = m.endsWith('/**') ? `${m.slice(0, -3)}/anything.ts` : m
      expect(await checks(file, code), m).toEqual([])
    }
  })

  it('in tests, which skip cases by OS', async () => {
    expect(await checks('packages/agent-host/src/sessions/anything.test.ts', code)).toEqual([])
  })

  it('in build and release scripts, which are about one platform’s artifacts', async () => {
    expect(await checks('scripts/release-npm.mts', code)).toEqual([])
    expect(await checks('packages/agent-host/scripts/bundle.mjs', code)).toEqual([])
  })

  it('names only modules that exist', () => {
    for (const m of PLATFORM_MODULES) {
      expect(existsSync(join(ROOT, m.replace(/\/\*\*$/, ''))), m).toBe(true)
    }
  })
})
