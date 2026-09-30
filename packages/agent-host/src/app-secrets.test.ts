import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalAppInfo, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter } from './adapters/contract.js'
import { onExternalAppListChanged } from './app-list-events.js'
import { storeRunLedger } from './app-run-ledger.js'
import { ExternalApps, type AppRef } from './apps/external/runtime.js'
import { SECRETS_FILE } from './apps/external/secrets.js'
import { PROJECT_APPS, plantApp, until } from './apps/external/test-helpers.js'
import { Store } from './dev-services/store.js'
import { createRpcHandler } from './rpc.js'
import { SessionManager } from './sessions/manager.js'

/**
 * The secrets field (M4 E) — does a value the person enters **leak nowhere inside the host**, and
 * does the app receive it?
 *
 * A real RPC door (`createRpcHandler`), a real run record from the store (`storeRunLedger`), a
 * real app process (env-app.mjs). Every place a value could pass through is collected and searched
 * as text: the app's log file, the run record (arguments, errors, a failure it left behind), error
 * bundles, the list, broadcasts, the host's console, and RPC answers and rejection messages. The
 * app deliberately leaks the value (into stderr on startup, into a failure message, into an
 * argument) — redaction cannot be tested with an app that never leaks it.
 */

const APP = fileURLToPath(new URL('./apps/external/test-fixtures/env-app.mjs', import.meta.url))
/** The value to enter — 4 characters or longer, so it is subject to redaction (short values are not redacted, see secrets.ts) */
const VALUE = 'sk-live-6f1d2c9a8b7e'

let root = ''
let dataRoot = ''
let projRoot = ''
let store: Store
let rt: ExternalApps
let rpc: ReturnType<typeof createRpcHandler>
let events: NormalizedEvent[] = []
let broadcasts = 0
let changedRefs: AppRef[] = []
let consoleText: string[] = []

const ref: AppRef = { projectId: 'p1', appId: 'keys' }
const info = () => (rt.list() as ExternalAppInfo[]).find((a) => a.appId === 'keys')!
const setSecret = (name: string, value: string | null) => rpc('apps.setSecret', { appId: 'keys', projectId: 'p1', name, value })
const envSeen = async () => {
  const out = await rt.call(ref, 'env', {}, { kind: 'session', sessionId: 's1' })
  const text = out.result?.content.map((c) => (c.type === 'text' ? c.text : '')).join('') ?? ''
  return { text, pid: Number(/pid=(\d+)/.exec(text)?.[1] ?? 0) }
}

function plant(args: string[], secrets = ['API_KEY']) {
  plantApp(join(projRoot, ...PROJECT_APPS), 'keys', {
    server: { command: process.execPath, args: [APP, '--env', 'API_KEY', ...args] },
    secrets,
  })
}

function make(timing: Record<string, number> = {}) {
  store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>()
  const mgr = new SessionManager(store, adapters, (e) => events.push(e))
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    runs: storeRunLedger(store),
    timing: { idleMs: 60_000, graceMs: 500, backoffBaseMs: 10, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, ...timing },
    emitChanged: (r) => changedRefs.push(r),
  })
  rt.refresh()
  // The same seam as the host's main — broadcasts whenever the list changes
  onExternalAppListChanged(rt, () => {
    broadcasts++
    events.push({ type: 'external_apps_changed' })
  })
  rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-secrets-')))
  dataRoot = join(root, 'data')
  projRoot = join(root, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
  events = []
  broadcasts = 0
  changedRefs = []
  consoleText = []
  // The host's console is searched too — if the value slips into a `[apps] …` line, it ends up in host.log
  for (const m of ['error', 'log', 'warn'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleText.push(a.map(String).join(' ')))
  }
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rt?.dispose()
  store?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('set or unset is visible, but the value is not', () => {
  it('the list says "not set" while a declared secret is empty, and says "set" once entered, broadcasting the change — the value is nowhere in the list', async () => {
    plant([], ['API_KEY', 'OTHER_TOKEN'])
    make()
    expect(info().secrets).toEqual([
      { name: 'API_KEY', set: false },
      { name: 'OTHER_TOKEN', set: false },
    ])
    const before = broadcasts
    await expect(setSecret('API_KEY', VALUE)).resolves.toEqual({ ok: true })
    expect(info().secrets).toEqual([
      { name: 'API_KEY', set: true },
      { name: 'OTHER_TOKEN', set: false },
    ])
    await until(() => broadcasts, (n) => n > before)
    expect(JSON.stringify(rt.list())).not.toContain(VALUE)
    // Clearing it returns it to not set
    await setSecret('API_KEY', null)
    expect(info().secrets?.[0]).toEqual({ name: 'API_KEY', set: false })
  })

  it('an app that declares no secrets has no field for it', () => {
    plant([], [])
    make()
    expect(info().secrets).toBeUndefined()
  })
})

describe("an entered value becomes the app's environment on its next startup", () => {
  it('a running app shuts down, and the next call starts it with the new value — changing it and clearing it behave the same way', async () => {
    plant([])
    make()
    const first = await envSeen()
    expect(first.text).toContain('API_KEY=(none)')

    await setSecret('API_KEY', VALUE)
    // No call is in progress, so it shuts down immediately — the next call starts a new process
    const second = await envSeen()
    expect(second.text).toContain(`API_KEY=${VALUE}`)
    expect(second.pid).not.toBe(first.pid)

    await setSecret('API_KEY', 'sk-live-replaced-0000')
    expect((await envSeen()).text).toContain('API_KEY=sk-live-replaced-0000')

    await setSecret('API_KEY', null)
    expect((await envSeen()).text).toContain('API_KEY=(none)')
  })

  it('an app stopped after repeated failures to start for lack of a key also starts up again once the value is entered', async () => {
    plant(['--require-env'])
    make({ maxFailures: 1 })
    const refused = await rt.call(ref, 'env', {}, { kind: 'session', sessionId: 's1' })
    expect(refused.status).toBe('error')
    expect(info().status).toBe('failed')

    await setSecret('API_KEY', VALUE)
    expect(info().status).toBe('stopped')
    expect((await envSeen()).text).toContain(`API_KEY=${VALUE}`)
  })

  it('rejects an undeclared name and an empty value — the rejection message carries no value either', async () => {
    plant([])
    make()
    await expect(setSecret('NOT_DECLARED', VALUE)).rejects.toThrow('This app does not declare a secret named NOT_DECLARED')
    await expect(setSecret('API_KEY', '')).rejects.toThrow('Enter a value, or clear the secret instead')
    // A value that is too long is blocked first by the RPC's shape check — that message carries no value either
    const long = VALUE.repeat(1000)
    const err = await setSecret('API_KEY', long).then(
      () => null,
      (e: Error) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).not.toContain(VALUE)
    for (const e of [
      await setSecret('NOT_DECLARED', VALUE).catch((x: Error) => x),
      await setSecret('API_KEY', `${VALUE}\0`).catch((x: Error) => x),
    ]) {
      expect((e as Error).message).not.toContain(VALUE)
    }
    expect(info().secrets?.[0]?.set).toBe(false)
  })
})

describe('the value is left nowhere inside the host', () => {
  it('even when the app leaks the value into stderr, a failure message, or an argument, only the name remains in the log, run record, error bundles, list, broadcasts, console, and RPC answer', async () => {
    plant(['--leak'])
    make()
    const reply = await setSecret('API_KEY', VALUE)
    // The app received the value — redaction cannot be tested with an app that never receives it
    expect((await envSeen()).text).toContain(VALUE)
    await rt.call(ref, 'echo', { text: `the key is ${VALUE}` }, { kind: 'view' })
    await rt.call(ref, 'leak_fail', {}, { kind: 'session', sessionId: 's1' })
    const logFile = join(dataRoot, 'app-logs', 'p1', 'keys.log')
    await until(() => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''), (t) => t.includes('about to fail'))
    const bundles = await until(() => rt.errors(ref).latest, (b) => !!b && b.stderr.some((l) => l.includes('about to fail')))

    const places: Record<string, string> = {
      'app log': readFileSync(logFile, 'utf8'),
      'run records': JSON.stringify(await rpc('apps.runs', { appId: 'keys', projectId: 'p1', limit: 100 })),
      'error bundles': JSON.stringify(await rpc('apps.errors', { appId: 'keys', projectId: 'p1' })) + JSON.stringify(bundles),
      'app list': JSON.stringify(await rpc('apps.list', {})),
      broadcasts: JSON.stringify(events) + JSON.stringify(changedRefs),
      'host console': consoleText.join('\n'),
      'setSecret reply': JSON.stringify(reply),
    }
    for (const [where, text] of Object.entries(places)) expect(text, where).not.toContain(VALUE)
    // Redacted by name — the place it leaked is not erased, a name stands in its place
    expect(places['app log']).toContain('[redacted:API_KEY]')
    expect(places['run records']).toContain('[redacted:API_KEY]')
    expect(places['error bundles']).toContain('[redacted:API_KEY]')

    // The one place the value lives is this file, with mode 0600
    const file = join(dataRoot, SECRETS_FILE)
    expect(readFileSync(file, 'utf8')).toContain(VALUE)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
