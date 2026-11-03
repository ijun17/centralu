import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
import { beforeHostStart, clockOf, decodeSwitch, lockIsLive, parseServeArgs, processStartTime, prune, readSwitch, runSwitch, RUNNER_ENV, SWITCH_FILE, SWITCH_LOCK, SWITCH_RUNNER } from '../packaging/npm/centralu/bin/serve.mjs'

/**
 * The machine's own switch of the install the hub manages (`serve --switch`, serve-switch.mjs, docs/plans/remote-hub.md
 * §10.5a), in a temporary data folder with versions placed as the installer places them. The switch end to end, through
 * real shells and fake versions, is in packages/agent-host/src/links/install-windows.test.ts and update.test.ts
 */

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../packaging/npm/centralu/bin/centralu.mjs')
const NODE = '24.21.0'
const v = (version: string) => ({ version, node: NODE })
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A data folder with `versions` placed and `current` naming the first */
function placed(...versions: string[]): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-switch-'))
  dirs.push(d)
  for (const name of versions) {
    mkdirSync(join(d, 'remote', 'versions', name), { recursive: true })
    writeFileSync(join(d, 'remote', 'versions', name, 'install.json'), '{}')
  }
  mkdirSync(join(d, 'remote', 'node', `v${NODE}`), { recursive: true })
  writeFileSync(join(d, 'remote', 'current'), `${versions[0]} ${NODE}\n`)
  return d
}

/** A switch from 1.0.0 to 2.0.0 left at `step`, with `holder` in its lock */
function switchAt(d: string, step: string, holder: { pid: number; started: string | null; at: number } | null) {
  writeFileSync(
    join(d, 'remote', SWITCH_FILE),
    JSON.stringify({ v: 1, id: 'switch-test-0001', by: 'hub-a', to: v('2.0.0'), keep: v('1.0.0'), was: { current: v('1.0.0'), previous: null }, saveStore: false, step, startedAt: 1, wasRunning: true }),
  )
  if (holder) writeFileSync(join(d, 'remote', SWITCH_LOCK), JSON.stringify({ id: 'switch-test-0001', ...holder }))
}

/** This test process, as a live switcher's lock names it */
const live = () => ({ pid: process.pid, started: processStartTime(process.pid), at: Date.now() })
/** A pid no process has any more: a child that ran and exited */
const dead = () => ({ pid: spawnSync(process.execPath, ['-e', '']).pid, started: null, at: Date.now() })

describe('serve --switch, --switch-run and --switch-status, the hub’s commands', () => {
  it('takes each as a whole command of its own, with one argument the hub wrote, or --seen and a switch id', () => {
    expect(parseServeArgs(['--switch', 'eyJpZCI6IngifQ_-'])).toEqual({ mode: 'switch', port: null, switchArg: 'eyJpZCI6IngifQ_-' })
    expect(parseServeArgs(['--switch-run', 'abc'])).toEqual({ mode: 'switch-run', port: null, switchArg: 'abc', dataDir: null })
    expect(parseServeArgs(['--switch-run', 'abc', 'L3RtcC9jYw'])).toEqual({ mode: 'switch-run', port: null, switchArg: 'abc', dataDir: 'L3RtcC9jYw' })
    expect(parseServeArgs(['--switch-status'])).toEqual({ mode: 'switch-status', port: null, seen: null })
    expect(parseServeArgs(['--switch-status', '--seen', 'switch-test-0001'])).toEqual({ mode: 'switch-status', port: null, seen: 'switch-test-0001' })
    for (const bad of [['--switch'], ['--switch', 'a b'], ['--switch', 'a', 'b'], ['--switch-run', 'a', 'b c'], ['--switch', 'a', '--port', '1'], ['--switch-status', '--port', '1'], ['--switch-status', '--seen', 'x;y']]) {
      expect(parseServeArgs(bad), bad.join(' ')).toHaveProperty('error')
    }
  })

  it('reads back the switch the hub wrote, as the hub wrote it, and refuses a malformed one', () => {
    const params = { id: 'switch-test-0001', by: 'hub-a', to: v('2.0.0'), keep: v('1.0.0'), was: { current: v('1.0.0'), previous: null }, saveStore: true }
    expect(decodeSwitch(Buffer.from(JSON.stringify(params)).toString('base64url'))).toEqual(params)
    for (const bad of [{ ...params, id: 'x' }, { ...params, to: { version: '../2.0.0', node: NODE } }, { ...params, to: null }]) {
      expect(decodeSwitch(Buffer.from(JSON.stringify(bad)).toString('base64url'))).toBeNull()
    }
    expect(decodeSwitch('not base64 json')).toBeNull()
  })
})

describe('whether a switcher is alive', () => {
  it('believes a Windows pid whose creation time cannot be read for ten minutes, and the rule of host.lock otherwise', () => {
    const at = Date.now()
    expect(lockIsLive({ pid: 7, at }, () => null)).toBe(true)
    expect(lockIsLive({ pid: 7, at: at - 11 * 60_000 }, () => null)).toBe(false)
    expect(lockIsLive({ pid: 7, at }, () => false)).toBe(false)
    expect(lockIsLive({ pid: 7, at: at - 11 * 60_000 }, () => true)).toBe(true)
    expect(lockIsLive(null)).toBe(false)
    expect(lockIsLive(live())).toBe(true)
    expect(lockIsLive(dead())).toBe(false)
  })
})

describe('no host starts beside a switch (§10.5a)', () => {
  it('refuses between the stop and the start of a live switcher, and not once it is starting the host itself', async () => {
    const d = placed('2.0.0', '1.0.0')
    for (const step of ['stop', 'backup', 'switch', 'restore_store', 'roll_back']) {
      switchAt(d, step, live())
      expect(await beforeHostStart({ dataDir: d, env: {}, version: '2.0.0' }), step).toEqual({ go: false, by: 'hub-a', startedAt: 1 })
    }
    for (const step of ['start', 'check', 'restart', 'prune']) {
      switchAt(d, step, live())
      expect(await beforeHostStart({ dataDir: d, env: {}, version: '2.0.0' }), step).toEqual({ go: true })
    }
    // A switch that ended is no reason
    writeFileSync(join(d, 'remote', SWITCH_FILE), JSON.stringify({ ...readSwitch(d), outcome: 'done' }))
    expect(await beforeHostStart({ dataDir: d, env: {}, version: '2.0.0' })).toEqual({ go: true })
  })

  it('finishes a switcher that died between the switch and the check: the pointers go back, and the old version serves', async () => {
    const d = placed('2.0.0', '1.0.0')
    switchAt(d, 'start', dead())
    const gate = await beforeHostStart({ dataDir: d, env: { CENTRALU_MANAGED: '1' }, version: '2.0.0' })
    expect(gate).toEqual({ go: false, rerun: v('1.0.0') })
    expect(readSwitch(d)).toMatchObject({ outcome: 'put_back', why: 'interrupted', interrupted: true })
    expect(readFileSync(join(d, 'remote', 'current'), 'utf8')).toBe(`1.0.0 ${NODE}\n`)
    expect(existsSync(join(d, 'remote', SWITCH_LOCK))).toBe(false)
  })

  it('finishes a switcher that died before the switch: nothing changed, and the version current names serves', async () => {
    const d = placed('1.0.0', '2.0.0')
    switchAt(d, 'stop', dead())
    expect(await beforeHostStart({ dataDir: d, env: { CENTRALU_MANAGED: '1' }, version: '1.0.0' })).toEqual({ go: true })
    expect(readSwitch(d)).toMatchObject({ outcome: 'failed', stage: 'interrupted', interrupted: true })
    expect(readFileSync(join(d, 'remote', 'current'), 'utf8')).toBe(`1.0.0 ${NODE}\n`)
  })

  it('takes no second switch while a live one runs, and starts nothing for it nor names itself the switch’s reader', async () => {
    const d = placed('1.0.0', '2.0.0')
    switchAt(d, 'switch', live())
    writeFileSync(join(d, 'remote', SWITCH_RUNNER), `2.0.0 ${NODE}\n`)
    const lines: string[] = []
    const raw = Buffer.from(JSON.stringify({ id: 'switch-test-0002', by: 'hub-b', to: v('3.0.0'), keep: null, was: { current: v('1.0.0'), previous: null }, saveStore: false })).toString('base64url')
    let started = 0
    const env = { CC_DATA_DIR: d, [RUNNER_ENV]: `3.0.0 ${NODE}` }
    const code = await runSwitch({ env, home: d, raw, cliPath: 'centralu.mjs', start: async () => (started++, { ok: true, pid: 1 }), write: (l: string) => void lines.push(l) })
    expect(code).toBe(1)
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ v: 1, switch: { ok: false, reason: 'busy', by: 'hub-a', startedAt: 1, message: `another switch runs there, from hub-a since ${clockOf(1)}` } })
    expect(clockOf(1)).toMatch(/^\d\d:\d\d$/)
    expect(started).toBe(0)
    expect(readSwitch(d)?.id).toBe('switch-test-0001')
    expect(readFileSync(join(d, 'remote', SWITCH_RUNNER), 'utf8')).toBe(`2.0.0 ${NODE}\n`)
  })

  /*
   * #1907: `serve` and `--detach` exited on a missing host entry (or a Node below the floor, or a host already
   * answering) before they asked the switch, so a dead switcher stayed unfinished until a hub read the status
   */
  it('finishes a dead switcher before the launcher refuses for a reason of its own, here a missing host entry', () => {
    const d = placed('1.0.0', '2.0.0')
    switchAt(d, 'prune', dead())
    const r = spawnSync(process.execPath, [CLI, 'serve', '--detach'], { env: { ...process.env, CC_DATA_DIR: d, CENTRALU_HOST_ENTRY: '', CENTRALU_MANAGED: '1' }, encoding: 'utf8', timeout: 60_000 })
    expect(r.status).not.toBe(0)
    expect(readSwitch(d)).toMatchObject({ outcome: 'done', interrupted: true })
  })
})

describe('what a switch prunes', () => {
  it('keeps current, previous and the version that ran the switch (which reads its outcome), and removes the rest', () => {
    const d = placed('4.0.0', '3.0.0', '2.0.0', '1.0.0')
    writeFileSync(join(d, 'remote', 'previous'), `3.0.0 ${NODE}\n`)
    writeFileSync(join(d, 'remote', SWITCH_RUNNER), `2.0.0 ${NODE}\n`)
    mkdirSync(join(d, 'remote', 'node', 'v20.0.0'))
    expect(prune(d)).toEqual({ removed: ['1.0.0', 'v20.0.0'], left: [] })
    expect(readdirSync(join(d, 'remote', 'versions')).sort()).toEqual(['2.0.0', '3.0.0', '4.0.0'])
  })
})
