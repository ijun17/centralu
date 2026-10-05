import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, type RuntimeTiming } from './runtime.js'
import { SECRETS_FILE } from './secrets.js'
import { PROJECT_APPS, plantApp, until } from './test-helpers.js'

/**
 * An app process's lifecycle (M4 A-3) — exercised **with a real child process.**
 *
 * The fixture app (test-fixtures/app.mjs) writes what happened to it (it started, which method
 * arrived, what environment it received, it spawned a grandchild) to a file. This test judges by that
 * file and the OS's process table, not by anything the host says — it checks "it started", not
 * "it wrote down that it started".
 */

const FIXTURE = fileURLToPath(new URL('./test-fixtures/app.mjs', import.meta.url))

let fixture = ''
let dataRoot = ''
let projRoot = ''
let appLogs = ''
let trusted = true
let rt: ExternalApps

type Rec = { t: string; pid: number; at: number; method?: string; grandchild?: number; env?: Record<string, string | null> }
const records = (id: string): Rec[] => {
  const f = join(appLogs, `${id}.jsonl`)
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec)
}
const starts = (id: string) => records(id).filter((r) => r.t === 'start')

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Plants one app that starts the fixture */
const plant = (id: string, mode = 'normal', over: Record<string, unknown> = {}) =>
  plantApp(join(projRoot, ...PROJECT_APPS), id, {
    server: { command: process.execPath, args: [FIXTURE, '--log', join(appLogs, `${id}.jsonl`), '--mode', mode] },
    ...over,
  })

const ref = (appId: string) => ({ projectId: 'p1', appId })
const status = (id: string) => rt.list().find((a) => a.appId === id)?.status
const hostLog = (id: string) => {
  const f = join(dataRoot, 'app-logs', 'p1', `${id}.log`)
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

const make = (timing: Partial<RuntimeTiming> = {}, env?: NodeJS.ProcessEnv) => {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted }],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, backoffBaseMs: 100, graceMs: 1_500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, ...timing },
    ...(env ? { env } : {}),
  })
  rt.refresh()
  return rt
}

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-life-')))
  dataRoot = join(fixture, 'data')
  projRoot = join(fixture, 'proj')
  appLogs = join(fixture, 'fixture-logs')
  for (const d of [dataRoot, projRoot, appLogs]) mkdirSync(d)
  trusted = true
})

afterEach(async () => {
  await rt?.dispose()
  rmSync(fixture, { recursive: true, force: true })
})

describe('starts only the first time it is needed', () => {
  it('zero processes even after scanning and checking the list — one starts when the tool list is asked for', async () => {
    plant('notes')
    make()
    expect(status('notes')).toBe('stopped')
    // The fixture writes its first line roughly 100ms after starting — a secret startup during scanning would show up in that window
    await new Promise((r) => setTimeout(r, 400))
    expect(starts('notes')).toHaveLength(0)

    const tools = await rt.tools(ref('notes'))
    expect(tools.map((t) => t.name)).toEqual(['echo'])
    expect(starts('notes')).toHaveLength(1)
    expect(status('notes')).toBe('running')
  })

  it('five simultaneous needs start only one process — never even tries starting a second', async () => {
    plant('notes')
    make()
    await Promise.all([1, 2, 3, 4, 5].map(() => rt.tools(ref('notes'))))
    expect(starts('notes')).toHaveLength(1)
  })

  it('an app in an untrusted project never starts even when a request arrives', async () => {
    trusted = false
    plant('notes')
    make()
    await expect(rt.tools(ref('notes'))).rejects.toThrow(/project is not trusted/)
    expect(starts('notes')).toHaveLength(0)
    expect(status('notes')).toBe('untrusted')
  })

  it('turning off trust immediately stops a running app', async () => {
    plant('notes')
    make()
    await rt.tools(ref('notes'))
    const pid = starts('notes')[0]!.pid
    trusted = false
    rt.refresh()
    await until(() => alive(pid), (a) => a === false)
    expect(status('notes')).toBe('untrusted')
  })
})

describe('the spec generation is remembered per app (S-4)', () => {
  it('only the first startup asks with server/discover — a later start after going idle connects directly with the remembered generation', async () => {
    plant('notes')
    make({ idleMs: 150 })
    await rt.tools(ref('notes'))
    const first = starts('notes')[0]!.pid
    await until(() => status('notes'), (s) => s === 'stopped')
    await rt.tools(ref('notes'))
    const second = starts('notes')[1]!.pid

    const methodsOf = (pid: number) => records('notes').filter((r) => r.t === 'method' && r.pid === pid).map((r) => r.method)
    expect(methodsOf(first)).toContain('server/discover')
    expect(methodsOf(second)).not.toContain('server/discover')
    expect(methodsOf(second)).toContain('tools/list')
    expect(hostLog('notes')).toMatch(/ready: pid \d+ era modern \(2026-07-28\) via cached verdict/)
  })
})

describe('crashing', () => {
  it('defers with exponential backoff, and stops holding the reason after three consecutive failures', async () => {
    plant('broken', 'crash-on-start')
    // A large base is chosen — the fixture alone takes roughly 170ms to start, so a small base would be satisfied without any backoff at all
    make({ backoffBaseMs: 400 })

    const failedAt: number[] = []
    for (let i = 0; i < 3; i++) {
      const err = await rt.tools(ref('broken')).catch((e: Error) => e)
      failedAt.push(Date.now())
      expect(err).toBeInstanceOf(Error)
      // The reason carries the last line the app left on stderr too
      expect((err as Error).message).toContain('fixture: cannot open the thing it needs')
      expect((err as Error).message).toContain('code 3')
    }
    const s = starts('broken')
    expect(s).toHaveLength(3)
    // The second only started after 400ms, the third after 800ms (the nth consecutive failure → base × 2^(n-1))
    expect(s[1]!.at - failedAt[0]!).toBeGreaterThanOrEqual(390)
    expect(s[2]!.at - failedAt[1]!).toBeGreaterThanOrEqual(790)

    const info = rt.list().find((a) => a.appId === 'broken')!
    expect(info.status).toBe('failed')
    expect(info.error).toContain('fixture: cannot open the thing it needs')

    // A stopped app is never started again
    await expect(rt.tools(ref('broken'))).rejects.toThrow(/stopped after failing 3 times in a row/)
    expect(starts('broken')).toHaveLength(3)

    // Restarting clears the count, and the next need starts it
    await rt.restart(ref('broken'))
    expect(status('broken')).toBe('stopped')
    await rt.tools(ref('broken')).catch(() => {})
    expect(starts('broken')).toHaveLength(4)
  })
})

describe('an idle app stops', () => {
  it('with no call in progress and no open screen, the process ends after idleMs', async () => {
    plant('notes')
    make({ idleMs: 200 })
    await rt.tools(ref('notes'))
    const pid = starts('notes')[0]!.pid
    expect(alive(pid)).toBe(true)
    await until(() => alive(pid), (a) => a === false)
    expect(status('notes')).toBe('stopped')
  })

  it('never stops while a screen is open — the count starts once the screen is closed', async () => {
    plant('notes')
    make({ idleMs: 200 })
    const release = rt.retainView(ref('notes'))
    await rt.tools(ref('notes'))
    const pid = starts('notes')[0]!.pid
    await new Promise((r) => setTimeout(r, 600))
    expect(alive(pid)).toBe(true)
    release()
    await until(() => alive(pid), (a) => a === false)
  })
})

describe('the shutdown rule (S-5)', () => {
  it('closing stdin and fd 3 together lets even an app holding fd 3 open end on its own within the grace period', async () => {
    plant('holder', 'hold-fd3')
    make({ graceMs: 3_000 })
    await rt.tools(ref('holder'))
    const pid = starts('holder')[0]!.pid

    const t0 = Date.now()
    await rt.restart(ref('holder'))
    expect(alive(pid)).toBe(false)
    // Not the result of using up the full grace period (3s) and killing the tree — it ended on its own
    expect(Date.now() - t0).toBeLessThan(1_500)
    expect(hostLog('holder')).not.toContain('did not exit within')
  })

  it('an app that does not end even with its input closed has its descendants ended too after the grace period — no orphan is left behind', async () => {
    plant('stubborn', 'ignore-eof')
    make({ graceMs: 300 })
    await rt.tools(ref('stubborn'))
    const pid = starts('stubborn')[0]!.pid
    const grandchild = records('stubborn').find((r) => r.t === 'grandchild')!.grandchild!
    expect(alive(grandchild)).toBe(true)

    await rt.restart(ref('stubborn'))
    await until(() => [alive(pid), alive(grandchild)], ([a, b]) => !a && !b)
    expect(hostLog('stubborn')).toContain('did not exit within 300ms')
  })

  it('even a descendant left by an app that ended cleanly on its own is collected — its entire group is ended', async () => {
    plant('parent', 'grandchild')
    make()
    await rt.tools(ref('parent'))
    const pid = starts('parent')[0]!.pid
    const grandchild = records('parent').find((r) => r.t === 'grandchild')!.grandchild!

    await rt.restart(ref('parent'))
    expect(alive(pid)).toBe(false)
    expect(hostLog('parent')).not.toContain('did not exit within')
    await until(() => alive(grandchild), (a) => a === false)
  })

  // Windows has no SIGTERM to hold off: every shot there is the forceful one, so this test's first-blow premise does not
  // exist. What it guards, that no orphan is left behind, is the Windows test below (#14).
  it.skipIf(process.platform === 'win32')('a descendant that ignores SIGTERM, left by an app that ended on its own, is collected with SIGKILL after the grace period — no orphan is left behind', async () => {
    plant('parent', 'stubborn-grandchild')
    make()
    await rt.tools(ref('parent'))
    const pid = starts('parent')[0]!.pid
    // Recorded only after the grandchild attaches its own signal handler — signalling it earlier would not test what this test is about (a descendant that holds on)
    const grandchild = (await until(() => records('parent').find((r) => r.t === 'grandchild'), (r) => r !== undefined))!.grandchild!
    try {
      await rt.restart(ref('parent'))
      expect(alive(pid)).toBe(false)
      expect(hostLog('parent')).not.toContain('did not exit within')
      // The first blow (SIGTERM) was held off — proof that this test is watching the second blow
      await new Promise((r) => setTimeout(r, 500))
      expect(alive(grandchild)).toBe(true)
      await until(() => alive(grandchild), (a) => a === false, 6_000)
    } finally {
      if (alive(grandchild)) process.kill(grandchild, 'SIGKILL')
    }
    // The test's own cap must exceed the wait (6s) for `finally` to run — a shorter one would leave the grandchild orphaned on a failing day
  }, 15_000)

  /*
   * Windows (#14) has no groups. A child Node spawns without `detached` dies with the app (libuv's job), so the test
   * above passes there with or without any collecting. This one is a child outside that job, like every child of a
   * Python app: its parent link outlives the app, and only following it ends the child. Not on macOS or Linux: a
   * detached child calls setsid there and leaves the app's group, which nothing can follow (kill-tree.ts).
   */
  it.runIf(process.platform === 'win32')('on Windows, a descendant started outside the app\'s job, left by an app that ended on its own, is ended — no orphan is left behind', async () => {
    plant('parent', 'detached-grandchild')
    make()
    await rt.tools(ref('parent'))
    const pid = starts('parent')[0]!.pid
    const grandchild = records('parent').find((r) => r.t === 'grandchild')!.grandchild!
    try {
      expect(alive(grandchild)).toBe(true)
      await rt.restart(ref('parent'))
      expect(alive(pid)).toBe(false)
      expect(hostLog('parent')).not.toContain('did not exit within')
      await until(() => alive(grandchild), (a) => a === false, 8_000)
      await until(() => hostLog('parent'), (log) => log.includes('process(es) it left running'), 2_000)
    } finally {
      if (alive(grandchild)) process.kill(grandchild)
    }
  }, 15_000)

  it('when the host exits (dispose), an old process still waiting to finish a call after its entry was replaced also stops', async () => {
    plant('keeper', 'attach')
    make()
    const first = rt.call(ref('keeper'), 'hold', {}, { kind: 'session', sessionId: 's1' })
    await until(() => records('keeper').some((r) => r.t === 'holding'), (x) => x)
    const pid = starts('keeper')[0]!.pid
    try {
      // The manifest changes — a new entry is created, and the old process waits to finish the call it is holding (it belongs to no entry at all)
      plant('keeper', 'attach', { description: 'a changed description' })
      rt.refresh()
      expect(alive(pid)).toBe(true)
      await rt.dispose()
      await until(() => alive(pid), (a) => a === false, 6_000)
      expect((await first).status).not.toBe('ok')
    } finally {
      if (alive(pid)) process.kill(-pid, 'SIGKILL')
    }
  }, 15_000)

  it('when the host exits (dispose), every running app stops', async () => {
    plant('a1')
    plant('a2', 'ignore-eof')
    make()
    await Promise.all([rt.tools(ref('a1')), rt.tools(ref('a2'))])
    const pids = [starts('a1')[0]!.pid, starts('a2')[0]!.pid]
    await rt.dispose()
    await until(() => pids.map(alive), (xs) => xs.every((x) => !x), 6_000)
  })
})

describe('what an app receives', () => {
  it('receives its data folder (created for it) and only its declared secrets, never the host\'s own variables', async () => {
    plant('notes', 'normal', { secrets: ['FIXTURE_SECRET'] })
    make({}, { ...process.env, CC_HOST_TOKEN: 'host-ws-token', CC_DATA_DIR: '/somewhere' })
    rt.setSecret(ref('notes'), 'FIXTURE_SECRET', 's3cret-value')
    rt.setSecret(ref('notes'), 'UNDECLARED_SECRET', 'not-for-this-app')
    await rt.tools(ref('notes'))

    const env = starts('notes')[0]!.env!
    const dataDir = join(dataRoot, 'app-data', 'p1', 'notes')
    expect(env).toMatchObject({
      CENTRALU_APP_ID: 'notes',
      CENTRALU_APP_DATA: dataDir,
      FIXTURE_SECRET: 's3cret-value',
      UNDECLARED_SECRET: null,
      CC_HOST_TOKEN: null,
      CC_DATA_DIR: null,
    })
    expect(statSync(dataDir).isDirectory()).toBe(true)
    // Windows has no mode bits (Node reports 0o666); the profile folder's ACL guards the file there (#14)
    if (process.platform !== 'win32') expect(statSync(join(dataRoot, SECRETS_FILE)).mode & 0o777).toBe(0o600)
  })

  it('stderr goes to the app\'s own log, with secret values masked by name', async () => {
    plant('leaky', 'secret-to-stderr', { secrets: ['FIXTURE_SECRET'] })
    make()
    rt.setSecret(ref('leaky'), 'FIXTURE_SECRET', 's3cret-value')
    await rt.tools(ref('leaky'))
    await until(() => hostLog('leaky'), (l) => l.includes('about to use token='))
    expect(hostLog('leaky')).toContain('about to use token=[redacted:FIXTURE_SECRET]')
    expect(hostLog('leaky')).not.toContain('s3cret-value')
  })

  it('an app\'s own log rolls one generation at the size cap', async () => {
    plant('noisy', 'flood-stderr')
    make({ logMaxBytes: 4_096 })
    await rt.tools(ref('noisy'))
    const log = join(dataRoot, 'app-logs', 'p1', 'noisy.log')
    await until(() => existsSync(`${log}.1`), (x) => x)
    expect(statSync(log).size).toBeLessThanOrEqual(4_096 + 200)
  })
})

describe('the naming rule is enforced at the point the tool list is read', () => {
  it('a tool with `__` in its name is dropped from the list, and the reason is recorded as a warning', async () => {
    plant('sneaky', 'bad-tool-name')
    make()
    expect((await rt.tools(ref('sneaky'))).map((t) => t.name)).toEqual(['echo'])
    expect(rt.list().find((a) => a.appId === 'sneaky')!.warnings.join('\n')).toContain('sneaky__tool')
  })
})
