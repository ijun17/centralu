import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, type AppRef, type HostCapability } from './runtime.js'
import { PROJECT_APPS, fakeBrokerHost, plantApp } from './test-helpers.js'

/**
 * Host data (M4 D-3) — when an app asks for `host_data` over fd 3, the desk consults the closed
 * list and the declaration before it ever asks the host. What the host actually gives back is the
 * manager's job (sessions/app-host-data.test.ts checks that for real); here the host is a stand-in,
 * and the only thing under test is **when it gets asked**.
 */

const FIXTURE = fileURLToPath(new URL('./test-fixtures/app.mjs', import.meta.url))

let root = ''
let rt: ExternalApps
let asked: { name: HostCapability; app: AppRef }[] = []

const plant = (id: string, uses: Record<string, unknown>) =>
  plantApp(join(root, 'p1', ...PROJECT_APPS), id, { server: { command: process.execPath, args: [FIXTURE, '--mode', 'mediation'] }, uses })
const ask = async (appId: string, args: Record<string, unknown>) => {
  const out = await rt.call({ projectId: 'p1', appId }, 'ask_broker', { mode: 'run', tool: 'host_data', args }, { kind: 'session', sessionId: 's1' })
  return out.result!.structuredContent as { isError: boolean; text: string; structured: unknown }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-host-data-')))
  mkdirSync(join(root, 'p1'))
  mkdirSync(join(root, 'data'))
  asked = []
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: join(root, 'p1'), trusted: true }],
    dataRoot: join(root, 'data'),
    reservedIds: [],
    timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  rt.attachBrokerHost(
    fakeBrokerHost({
      hostData: async (name, app) => {
        asked.push({ name, app })
        if (name === 'git.status') throw new Error('git.status needs a project')
        return { sessions: [{ id: 's1', name: 'first' }] }
      },
    }),
  )
})

afterEach(async () => {
  await rt.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('host_data — closed list, default is refusal', () => {
  it('does not even ask the host for a name that was not declared', async () => {
    plant('notes', {})
    rt.refresh()
    expect(await ask('notes', { name: 'sessions.list' })).toMatchObject({
      isError: true,
      text: 'host_data refused: "sessions.list" is not in this app\'s "uses.host" — declare it in centralu.app.json: "uses": { "host": ["sessions.list"] }',
    })
    expect(asked).toEqual([])
  })

  it('a name outside the list is a capability that does not exist even if declared — it names what it can give', async () => {
    plant('notes', { host: ['sessions.list', 'files.read'] })
    rt.refresh()
    expect(await ask('notes', { name: 'files.read' })).toMatchObject({
      isError: true,
      text: 'host_data: Centralu has no host capability "files.read" — it can give: sessions.list, git.status',
    })
    expect(asked).toEqual([])
  })

  it('a declared name gets answered by the host, and the answer comes through as plain JSON — if the host cannot give it, the reason comes through instead', async () => {
    plant('notes', { host: ['sessions.list', 'git.status'] })
    rt.refresh()
    expect(await ask('notes', { name: 'sessions.list' })).toEqual({
      isError: false,
      text: '{"sessions":[{"id":"s1","name":"first"}]}',
      structured: { sessions: [{ id: 's1', name: 'first' }] },
    })
    expect(await ask('notes', { name: 'git.status' })).toMatchObject({ isError: true, text: 'host_data failed: git.status needs a project' })
    expect(asked).toEqual([
      { name: 'sessions.list', app: { projectId: 'p1', appId: 'notes' } },
      { name: 'git.status', app: { projectId: 'p1', appId: 'notes' } },
    ])
  })
})
