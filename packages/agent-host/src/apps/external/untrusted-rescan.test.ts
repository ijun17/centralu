import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps } from './runtime.js'
import { PROJECT_APPS, plantApp, until } from './test-helpers.js'
import { alive } from '../../process.test-helpers.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'

/**
 * An app an `auto` session started in an untrusted project (#839, item 4). `auto` opens the trust boundary for its own
 * calls (`setSessionBoundaryPolicy`), so the app runs in a project that was never trusted. Every rescan of that project
 * (a file saved in its apps folder, a refresh) stopped it as "no longer trusted", though it had never been: a call in
 * flight was cut off and the next one started the app again. Only trust lost is a reason to stop it.
 */

const FIXTURE = fileURLToPath(new URL('./test-fixtures/app.mjs', import.meta.url))

let fixture = ''
let projRoot = ''
let appLogs = ''
let trusted = false
let rt: ExternalApps

const starts = (id: string): { pid: number }[] => {
  const f = join(appLogs, `${id}.jsonl`)
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: string; pid: number }).filter((r) => r.t === 'start')
}
const ref = { projectId: 'p1', appId: 'notes' }

beforeEach(() => {
  fixture = tempRoot('cc-apps-trust-')
  projRoot = join(fixture, 'proj')
  appLogs = join(fixture, 'fixture-logs')
  for (const d of [join(fixture, 'data'), projRoot, appLogs]) mkdirSync(d)
  trusted = false
  plantApp(join(projRoot, ...PROJECT_APPS), 'notes', {
    server: { command: process.execPath, args: [FIXTURE, '--log', join(appLogs, 'notes.jsonl'), '--mode', 'normal'] },
  })
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted }],
    dataRoot: join(fixture, 'data'),
    reservedIds: [],
    timing: { idleMs: 60_000, backoffBaseMs: 100, graceMs: 1_500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  // The session `auto-1` is auto: its calls pass the boundary
  rt.setSessionBoundaryPolicy((sessionId) => sessionId === 'auto-1')
  rt.refresh()
})

afterEach(async () => {
  await rt?.dispose()
  await removeTree(fixture)
})

describe('an app auto started in a project never trusted (#839)', () => {
  it('a rescan leaves it running: the next call is served by the same process', async () => {
    await rt.tools(ref, 'model', 'auto-1')
    await until(() => starts('notes').length, (n) => n === 1)
    const pid = starts('notes')[0]!.pid
    rt.refresh()
    await rt.tools(ref, 'model', 'auto-1')
    expect(starts('notes')).toHaveLength(1)
    expect(alive(pid)).toBe(true)
  })

  it('trust given and then taken away still stops it', async () => {
    trusted = true
    rt.refresh()
    await rt.tools(ref, 'model', 'auto-1')
    await until(() => starts('notes').length, (n) => n === 1)
    const pid = starts('notes')[0]!.pid
    trusted = false
    rt.refresh()
    await until(() => alive(pid), (a) => a === false)
  })
})
