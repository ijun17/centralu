/**
 * The packaged host folder carries Antigravity's gate hook (docs/plans/antigravity-adapter.md §5): the command and the file
 * it imports, side by side. `agy` runs `node <folder>/agy-gate.mjs`; with only the first file it fails on its import, and a
 * hook that fails or prints nothing is the failure that opens the gate (§1.2).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { AGY_GATE_FILES, copyAgyGate } from '../packages/agent-host/scripts/agy-gate-files.mjs'
import { gatePath } from '../packages/agent-host/src/adapters/agy/gate-path.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'agy-gate-bundle-'))
afterAll(() => rmSync(out, { recursive: true, force: true }))

describe('the gate files in the packaged host folder', () => {
  it('are both copied beside main.mjs', () => {
    expect(AGY_GATE_FILES).toEqual(['agy-gate.mjs', 'gate-answer.mjs'])
    copyAgyGate(ROOT, out)
    for (const f of AGY_GATE_FILES) expect(existsSync(join(out, f)), f).toBe(true)
  })

  it('are found by the host from the packaged layout and from the source tree', () => {
    writeFileSync(join(out, 'main.mjs'), '')
    expect(gatePath(pathToFileURL(join(out, 'main.mjs')).href)).toBe(join(out, 'agy-gate.mjs'))
    expect(gatePath().split(sep).join('/')).toMatch(/adapters\/agy\/agy-gate\.mjs$/)
  })

  it('start on their own and answer deny when they know no gate address', () => {
    const r = spawnSync(process.execPath, [join(out, 'agy-gate.mjs')], { cwd: out, input: '{}', env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 20_000 })
    expect(r.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/)
    expect(JSON.parse(r.stdout.trim().split('\n').pop() ?? '')).toMatchObject({ decision: 'deny' })
  })

  it('are copied by the bundle step', () => {
    expect(readFileSync(join(ROOT, 'packages/agent-host/scripts/bundle.mjs'), 'utf8')).toContain('copyAgyGate(ROOT, OUT)')
  })
})
