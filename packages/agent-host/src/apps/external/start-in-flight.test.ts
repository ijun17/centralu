import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps } from './runtime.js'
import { PROJECT_APPS, plantApp, until } from './test-helpers.js'
import { ownProcesses } from '../../process.test-helpers.js'
import { SLOW } from '../../../../../tooling/test-timing.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'

/**
 * An app still starting when it is stopped (#839, items 14 and 15). The process is spawned at once and counts as
 * started only once it answers its tool list. A host quitting in that window stopped the processes it had, and this one
 * was not yet among them: it ran on after the host was gone. A restart in that window left the abandoned start as the
 * one in progress, so the next call joined it and failed with "this start was abandoned".
 */

const FIXTURE = fileURLToPath(new URL('./test-fixtures/app.mjs', import.meta.url))

let fixture = ''
let projRoot = ''
let appLogs = ''
let hold = ''
let rt: ExternalApps
// What a test has seen end is not ended again afterwards: its number may be someone else's by then (#1308)
let own = ownProcesses()
const alive = (pid: number) => own.alive(pid)

/** The pids the wrapper wrote as each process came up, before it waited */
const spawned = (): number[] => {
  const f = join(appLogs, 'spawned')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []
}
const ref = { projectId: 'p1', appId: 'notes' }

beforeEach(() => {
  own = ownProcesses()
  fixture = tempRoot('cc-apps-starting-')
  projRoot = join(fixture, 'proj')
  appLogs = join(fixture, 'logs')
  for (const d of [join(fixture, 'data'), projRoot, appLogs]) mkdirSync(d)
  hold = join(fixture, 'hold')
  // Writes its pid, waits while the hold file is there, then runs the fixture app
  const wrapper = join(fixture, 'held-app.mjs')
  writeFileSync(
    wrapper,
    [
      "import { appendFileSync, existsSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(join(appLogs, 'spawned'))}, process.pid + '\\n')`,
      `while (existsSync(${JSON.stringify(hold)})) await new Promise((r) => setTimeout(r, 20))`,
      `await import(${JSON.stringify(pathToFileURL(FIXTURE).href)})`,
    ].join('\n'),
  )
  plantApp(join(projRoot, ...PROJECT_APPS), 'notes', {
    server: { command: process.execPath, args: [wrapper, '--log', join(appLogs, 'notes.jsonl'), '--mode', 'normal'] },
  })
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot: join(fixture, 'data'),
    reservedIds: [],
    // Generous: a held start must not end on its own while the test runs
    timing: { idleMs: 60_000, backoffBaseMs: 100, graceMs: 1_500, probeTimeoutMs: 60_000, connectTimeoutMs: 60_000 },
  })
  rt.refresh()
})

afterEach(async () => {
  rmSync(hold, { force: true })
  await rt?.dispose()
  // `dispose` stops them and the test may not have looked: look first, then end only what is still there (#1308)
  await own.endAfter(spawned(), 5_000 * SLOW)
  await removeTree(fixture)
})

describe('an app still starting (#839)', () => {
  it('is stopped by the host quitting, not left running after it', async () => {
    writeFileSync(hold, '')
    void rt.tools(ref).catch(() => {})
    await until(() => spawned().length, (n) => n === 1)
    const pid = spawned()[0]!
    await rt.dispose()
    // The quit's stop: stdin and fd 3 closed, then the group ended after its grace (generous bound)
    await until(() => alive(pid), (a) => a === false, 10_000)
  })

  it('a restart lets the next call start it again, rather than join the start it abandoned', async () => {
    writeFileSync(hold, '')
    const first = rt.tools(ref)
    void first.catch(() => {})
    await until(() => spawned().length, (n) => n === 1)
    await rt.restart(ref)
    // The restart stops the abandoned start's process, while it is still starting: one copy, not two
    const abandoned = spawned()[0]!
    await until(() => alive(abandoned), (a) => a === false, 10_000)
    const next = rt.tools(ref)
    void next.catch(() => {})
    await until(() => spawned().length, (n) => n === 2)
    // A new process, whatever number the abandoned one had (#1308)
    own.forget([spawned()[1]!])
    rmSync(hold)
    await expect(first).rejects.toThrow(/abandoned/)
    expect((await next).map((t) => t.name)).toEqual(['echo'])
    expect(alive(spawned()[1]!)).toBe(true)
  })
})
