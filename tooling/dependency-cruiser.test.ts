/**
 * The orphan rule of tooling/dependency-cruiser.cjs, run by dependency-cruiser itself on a small tree (#1667): a type
 * declaration beside a plain `.mjs` file is no orphan, a real orphan is one, and `pnpm verify` fails on it as `pnpm pre-pr` does.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { cruise } from 'dependency-cruiser'
import { afterEach, describe, expect, it } from 'vitest'

const config = createRequire(import.meta.url)('./dependency-cruiser.cjs')
let dir = ''
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function orphans(files: Record<string, string>): Promise<{ from: string; severity: string }[]> {
  dir = mkdtempSync(join(tmpdir(), 'cruise-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'src', name), text)
  const { output } = await cruise(['src'], { ruleSet: { forbidden: config.forbidden.filter((r: { name: string }) => r.name === 'no-orphans') }, baseDir: dir, validate: true })
  if (typeof output === 'string') throw new Error('expected a result object')
  return output.summary.violations.map((v) => ({ from: v.from, severity: v.rule.severity }))
}

describe('no-orphans', () => {
  it('lets declaration files of every module kind stand beside their source', async () => {
    expect(await orphans({ 'a.d.ts': 'export {}', 'b.d.mts': 'export {}', 'c.d.cts': 'export {}' })).toEqual([])
  })

  it('still names a real orphan, as an error', async () => {
    expect(await orphans({ 'lonely.mts': 'export const x = 1', 'b.d.mts': 'export {}' })).toEqual([{ from: 'src/lonely.mts', severity: 'error' }])
  })
})
