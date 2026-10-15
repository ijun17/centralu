import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
import { belowFloor, floorOf, oldNodeSentence } from '../packaging/npm/centralu/bin/node-floor.mjs'

/**
 * The launcher refuses a Node below the floor before it starts a host (#699). The bundled database
 * module declares Node-API 10, which Node has from 22.14.0; under 22.12.0 the host crashed on its
 * first database call (an access violation on Windows, SIGSEGV on macOS) and the person got the raw
 * end of `serve.log`. The floor is `engines.node` of the npm package (`tooling/engines.test.ts`).
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'packaging/npm/centralu/bin/centralu.mjs')
const SOURCE_HOST = join(ROOT, 'packages/agent-host/src/main.ts')

const dirs: string[] = []
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'cc-floor-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('the floor and its sentence', () => {
  it('is the plain floor of engines.node, in full', () => {
    expect(floorOf('>=22.14.0')).toBe('22.14.0')
    expect(floorOf('>=22.14')).toBe('22.14.0')
    expect(() => floorOf('>=22')).toThrow(/plain floor/)
    expect(() => floorOf('^22.14.0')).toThrow(/plain floor/)
  })

  it('puts a Node below it, and only that, under the floor', () => {
    expect(belowFloor('22.12.0', '22.14.0')).toBe(true)
    expect(belowFloor('v22.13.1', '22.14.0')).toBe(true)
    expect(belowFloor('V22.13.1', '22.14.0')).toBe(true)
    expect(belowFloor('20.19.0', '22.14.0')).toBe(true)
    expect(belowFloor('22.14.0', '22.14.0')).toBe(false)
    expect(belowFloor('22.23.3', '22.14.0')).toBe(false)
    expect(belowFloor('24.21.0', '22.14.0')).toBe(false)
    // A version it cannot read is not a reason to refuse
    expect(belowFloor('', '22.14.0')).toBe(false)
  })

  it('names the Node it found, the floor and both ways out', () => {
    const s = oldNodeSentence('v22.12.0', '22.14.0') as string
    expect(s).toContain('Node 22.14.0 or newer')
    expect(s).toContain('Node 22.12.0')
    expect(s).toMatch(/update Node on this machine/)
    expect(s).toMatch(/link this machine from a Centralu window/)
    expect(s.split('\n')).toHaveLength(1)
  })
})

describe('centralu serve under a Node below the floor', () => {
  /** Runs the launcher with `process.versions.node` faked, and a host entry that leaves a mark if anything starts it */
  function run(args: string[], fake: string, realEntry = false) {
    const dir = tempDir()
    const preload = join(dir, 'fake-node.mjs')
    writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(fake)} })\n`)
    const mark = join(dir, 'host-started')
    const entry = join(dir, 'main.mjs')
    writeFileSync(entry, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(mark)}, 'started')\n`)
    const data = join(dir, 'data')
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, CLI, 'serve', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, CC_DATA_DIR: data, CENTRALU_HOST_ENTRY: realEntry ? SOURCE_HOST : entry, CI: '1' },
    })
    return { ...r, started: existsSync(mark), data }
  }

  it('refuses in one sentence and starts no host', () => {
    const r = run([], '22.12.0')
    expect(r.status).toBe(1)
    expect(r.stderr.trim()).toBe(`centralu serve: ${oldNodeSentence('22.12.0', '22.14.0')}`)
    expect(r.stdout).toBe('')
    expect(r.started).toBe(false)
    // Nothing was written either: no state, no log, no data folder
    expect(existsSync(r.data)).toBe(false)
  })

  it('answers `--detach` in the line the hub reads, so it can offer its managed install', () => {
    const r = run(['--detach'], '22.13.1')
    expect(r.status).toBe(1)
    expect(r.started).toBe(false)
    const line = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { v: number; detach: Record<string, unknown> }
    expect(line.detach).toMatchObject({ ok: false, reason: 'node_too_old', node: '22.13.1', floor: '22.14.0', message: oldNodeSentence('22.13.1', '22.14.0') })
    expect(existsSync(r.data)).toBe(false)
  })

  it('will not write a boot entry that would start a host on it, but still reads and removes one', () => {
    const on = run(['--autostart', 'on'], '22.12.0')
    expect(on.status).toBe(1)
    expect(on.stderr.trim()).toBe(`centralu serve: ${oldNodeSentence('22.12.0', '22.14.0')}`)
    expect(on.stdout).toBe('')
    for (const action of ['off', 'status']) expect(run(['--autostart', action], '22.12.0').stderr).not.toContain('needs Node')
  })

  it('still answers `--connection`, which starts no host, so the hub can read the Node that runs it', () => {
    const r = run(['--connection'], '22.12.0', true)
    expect(r.stderr).not.toContain('needs Node')
    const line = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { install: { node: string } }
    expect(line.install.node).toBe('22.12.0')
    expect(r.started).toBe(false)
  })

  it('does not refuse the floor itself', () => {
    const r = run(['--connection'], '22.14.0', true)
    expect(r.stderr).not.toContain('needs Node')
    expect(r.status).toBe(0)
  })
})
