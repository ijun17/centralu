import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, resultText, type AppRef, type RuntimeTiming } from './runtime.js'
import { appTemplateDir, scaffoldApp } from './scaffold.js'
import { until } from './test-helpers.js'

/**
 * Reflecting changes (M4 C-4) — when the app folder changes, this restarts once, **when the building
 * session's turn ends.** A call in progress is never cut off. If there is no building session, or it
 * is idle, this waits for things to go quiet.
 *
 * This never waits on fs events (#153): the test calls the scan watching would trigger directly
 * (`refresh`). Judged by the pid the app process itself reports, and by the tool list the runtime
 * knows about.
 */

let root = ''
let dataRoot = ''
let projRoot = ''
let busy = false
let rt: ExternalApps

const ID = 'counter'
const ref: AppRef = { projectId: 'p1', appId: ID }
const SESSION = { kind: 'session' as const, sessionId: 's1' }

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-reload-')))
  dataRoot = join(root, 'data')
  projRoot = join(root, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
  busy = false
})

afterEach(async () => {
  await rt?.dispose()
  rmSync(root, { recursive: true, force: true })
})

function make(opts: { builder?: boolean; timing?: Partial<RuntimeTiming> } = {}) {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, reloadQuietMs: 400, turnEndDebounceMs: 100, ...opts.timing },
    ...(opts.builder === false ? {} : { builderBusy: () => busy }),
  })
  rt.refresh()
  return rt
}

const gate = () => join(root, 'gate')
const serverFile = () => join(projRoot, '.centralu', 'apps', ID, 'server.mjs')

/** Expands the template app, adding two test tools (pid, hold) */
function plant(): void {
  const dir = join(projRoot, '.centralu', 'apps', ID)
  mkdirSync(dirname(dir), { recursive: true })
  scaffoldApp(appTemplateDir(), dir, { id: ID, name: 'Counter', description: 'counter' })
  addTools(`
  centralu.tool(server, 'pid', { description: 'The process id', annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: String(process.pid) }] }))
  centralu.tool(server, 'hold', { description: 'Waits for the gate file', annotations: { readOnlyHint: true } }, async () => {
    const { existsSync } = await import('node:fs')
    while (!existsSync(${JSON.stringify(gate())})) await new Promise((r) => setTimeout(r, 20))
    return { content: [{ type: 'text', text: 'held by ' + process.pid }] }
  })`)
}

/** What a building agent does — adds a tool to server.mjs */
function addTools(code: string): void {
  const f = serverFile()
  writeFileSync(f, readFileSync(f, 'utf8').replace('  return server\n})', `${code}\n  return server\n})`))
}
const addTool = (name: string) =>
  addTools(`  centralu.tool(server, ${JSON.stringify(name)}, { description: 'New', annotations: { readOnlyHint: true } }, async () => ({ content: [] }))`)

async function pid(): Promise<number> {
  const out = await rt.call(ref, 'pid', {}, SESSION)
  return Number(resultText(out.result!))
}
const known = () => rt.knownTools(ref)?.map((t) => t.name) ?? []
const status = () => rt.list().find((a) => a.appId === ID)?.status
const reloads = () => (readFileSync(join(dataRoot, 'app-logs', 'p1', `${ID}.log`), 'utf8').match(/reloading: /g) ?? []).length
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('restarts when the building session\'s turn ends', () => {
  it('stays the same mid-turn even if the folder changes — restarts once, with the new code, once the turn ends', async () => {
    plant()
    make()
    await rt.tools(ref)
    const before = await pid()
    busy = true
    addTool('added')
    rt.refresh() // the scan watching would trigger
    await sleep(700) // even past going quiet (400ms)
    expect(await pid()).toBe(before)
    expect(known()).not.toContain('added')

    busy = false
    // turn end and a state change arriving back to back still produce one restart
    rt.builderTurnEnded(ref)
    rt.builderTurnEnded(ref)
    rt.builderTurnEnded(ref)
    await until(known, (names) => names.includes('added'))
    expect(await pid()).not.toBe(before)
    await sleep(300)
    expect(reloads()).toBe(1)
    expect(status()).toBe('running')
  })

  it('never cuts off a call in progress — waits for it to finish, then restarts', async () => {
    plant()
    make()
    await rt.tools(ref)
    const before = await pid()
    const held = rt.call(ref, 'hold', {}, SESSION)
    await until(() => (rt as unknown as { openRuns: Map<string, unknown> }).openRuns.size, (n) => n === 1)
    addTool('added')
    rt.builderTurnEnded(ref)
    await sleep(500)
    expect(known()).not.toContain('added') // still the old process — a call is in progress
    writeFileSync(gate(), '')
    const out = await held
    expect({ status: out.status, error: out.error }).toEqual({ status: 'ok', error: null })
    expect(resultText(out.result!)).toBe(`held by ${before}`)
    await until(known, (names) => names.includes('added'))
    expect(await pid()).not.toBe(before)
  })

  it('does not restart at turn end if the folder is unchanged', async () => {
    plant()
    make()
    await rt.tools(ref)
    const before = await pid()
    // Writing the same content again is not a change (an editor's save, or checking out the same content)
    writeFileSync(serverFile(), readFileSync(serverFile(), 'utf8'))
    rt.builderTurnEnded(ref)
    await sleep(400)
    expect(await pid()).toBe(before)
  })

  it('starts even an app that went idle and stopped, with the new code, at turn end, to move the tool list forward', async () => {
    plant()
    make()
    await rt.tools(ref)
    await rt.restart(ref) // stops it (never starts it)
    expect(status()).toBe('stopped')
    addTool('added')
    rt.builderTurnEnded(ref)
    await until(known, (names) => names.includes('added'))
    expect(status()).toBe('running')
  })

  it('when the edited code fails to start, the reason is recorded, and it is tried again at the next fix\'s turn end', async () => {
    plant()
    make()
    await rt.tools(ref)
    addTools(`  throw new Error('half-written tool')`)
    rt.builderTurnEnded(ref)
    await until(status, (s) => s === 'crashed')
    expect(rt.list().find((a) => a.appId === ID)!.error).toContain('half-written tool')
    writeFileSync(serverFile(), readFileSync(serverFile(), 'utf8').replace(`  throw new Error('half-written tool')\n`, ''))
    addTool('fixed')
    rt.builderTurnEnded(ref)
    await until(known, (names) => names.includes('fixed'))
    expect(status()).toBe('running')
  })
})

describe('restarts after going quiet when there is no building session', () => {
  it('waits for things to go quiet after the last change — a continuing change resets the count', async () => {
    plant()
    make({ builder: false })
    await rt.tools(ref)
    const before = await pid()
    addTool('one')
    rt.refresh()
    await sleep(250)
    addTool('two')
    rt.refresh() // resets the count — the 400ms starts from here
    await sleep(250)
    expect(await pid()).toBe(before) // 500ms passed since the first change, but only 250ms since the last
    await until(known, (names) => names.includes('one') && names.includes('two'))
    expect(await pid()).not.toBe(before)
    expect(reloads()).toBe(1)
  })

  it('follows the same path when the building session is idle (edited from an editor) — waits for turn end if mid-turn', async () => {
    plant()
    make()
    await rt.tools(ref)
    const before = await pid()
    addTool('edited')
    rt.refresh()
    await until(known, (names) => names.includes('edited'))
    expect(await pid()).not.toBe(before)
  })

  it('never wakes a non-running app because of an edit', async () => {
    plant()
    make({ builder: false })
    await rt.tools(ref)
    await rt.restart(ref)
    addTool('added')
    rt.refresh()
    // Several multiples of going quiet (400ms) — watching could also see this edit and reset its own timer (300ms flush)
    await sleep(1_500)
    expect(status()).toBe('stopped')
  })
})

describe('a call in progress runs to completion even if the manifest changes', () => {
  it('a new call is received by the app under the new manifest, and the old process stops after finishing its call', async () => {
    plant()
    make()
    await rt.tools(ref)
    const before = await pid()
    const held = rt.call(ref, 'hold', {}, SESSION)
    await until(() => (rt as unknown as { openRuns: Map<string, unknown> }).openRuns.size, (n) => n === 1)
    const mf = join(projRoot, '.centralu', 'apps', ID, 'centralu.app.json')
    writeFileSync(mf, readFileSync(mf, 'utf8').replace('"description": "counter"', '"description": "counter, renamed"'))
    rt.refresh()
    expect(rt.list().find((a) => a.appId === ID)!.description).toBe('counter, renamed')
    await sleep(300)
    writeFileSync(gate(), '')
    const out = await held
    expect({ status: out.status, error: out.error }).toEqual({ status: 'ok', error: null })
    expect(resultText(out.result!)).toBe(`held by ${before}`)
    expect(await pid()).not.toBe(before)
    expect(existsSync(gate())).toBe(true)
  })
})

/**
 * A manifest change mid-turn (C-4) — measured: within a building session's turn (10:09:55-10:11:09),
 * the manifest changed at 10:10:45 and the app went down with "stopping: manifest changed", and the
 * screen went blank and reopened with the half-edited code. The manifest is treated the same as any
 * other file in the folder — once, at turn end.
 */
describe('a manifest change mid-turn still happens once, at turn end', () => {
  const log = () => readFileSync(join(dataRoot, 'app-logs', 'p1', `${ID}.log`), 'utf8')
  const count = (re: RegExp) => (log().match(re) ?? []).length
  const description = () => rt.list().find((a) => a.appId === ID)?.description

  it('the old manifest\'s app keeps running mid-turn — at turn end, it stops once, then starts once under the new manifest', async () => {
    plant()
    make()
    await rt.tools(ref)
    const before = await pid()
    busy = true
    const mf = join(projRoot, '.centralu', 'apps', ID, 'centralu.app.json')
    writeFileSync(mf, readFileSync(mf, 'utf8').replace('"description": "counter"', '"description": "counter, renamed"'))
    rt.refresh() // the scan watching would trigger
    await sleep(700) // even past going quiet (400ms)
    expect(await pid()).toBe(before)
    expect(description()).toBe('counter')
    expect(count(/stopping: manifest changed/g)).toBe(0)

    busy = false
    // turn end and a state change arriving back to back still produce one restart
    rt.builderTurnEnded(ref)
    rt.builderTurnEnded(ref)
    await until(description, (d) => d === 'counter, renamed')
    // starts without being called — this moves the building session's tool list to the app under the new manifest
    await until(status, (s) => s === 'running')
    expect(await pid()).not.toBe(before)
    await sleep(300)
    expect(count(/stopping: manifest changed/g)).toBe(1)
    expect(count(/starting: /g)).toBe(2)
  })
})

/**
 * The list's `codeStamp` (C-4, the screen side) — the key an open screen uses to know "my HTML is old
 * code". Changes only when a process that actually started has different code: starting again with
 * the same code (died and came back, restarted) and new code that fails to start both leave it
 * unchanged — reopening the screen then would show either nothing different or only a failure. This
 * distinction is what keeps a screen from reopening repeatedly.
 */
describe('the list\'s codeStamp — the fingerprint of the code currently running', () => {
  const stamp = () => rt.list().find((a) => a.appId === ID)?.codeStamp

  it('is absent before starting, unchanged when it starts again with the same code, and changes when it starts again with new code (turn end, check)', async () => {
    plant()
    make()
    expect(stamp()).toBeUndefined()
    await rt.tools(ref)
    const first = stamp()
    expect(first).toMatch(/^[0-9a-f]{16}$/)

    // Died and came back on the next call — the same code
    const before = await pid()
    process.kill(before, 'SIGKILL')
    await until(status, (s) => s === 'crashed')
    expect(await pid()).not.toBe(before)
    expect(stamp()).toBe(first)
    // A person restarted it — still the same code
    await rt.restart(ref)
    await pid()
    expect(stamp()).toBe(first)

    // Starts again with new code at the building session's turn end
    busy = true
    addTool('added')
    rt.refresh()
    busy = false
    rt.builderTurnEnded(ref)
    await until(known, (names) => names.includes('added'))
    const second = stamp()
    expect(second).toMatch(/^[0-9a-f]{16}$/)
    expect(second).not.toBe(first)

    // A check mid-turn starts with the current files — it changes without waiting for turn end (turn end has nothing left to do at that point)
    busy = true
    addTool('checked')
    await rt.check(ref)
    expect(stamp()).not.toBe(second)
  })

  it('new code that fails to start never changes the fingerprint — it was never the code actually running', async () => {
    plant()
    make()
    await rt.tools(ref)
    const first = stamp()
    addTools(`  throw new Error('half-written tool')`)
    rt.builderTurnEnded(ref)
    await until(status, (s) => s === 'crashed')
    expect(stamp()).toBe(first)
  })
})
