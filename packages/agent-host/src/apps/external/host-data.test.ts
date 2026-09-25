import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, type AppRef, type HostCapability } from './runtime.js'
import { PROJECT_APPS, fakeBrokerHost, plantApp } from './test-helpers.js'

/**
 * host 데이터 (M4 D-3) — 앱이 fd 3으로 `host_data`를 부탁하면 창구가 닫힌 목록과 선언을 본 뒤에만 host에 묻는다. 무엇을 주는지는
 * 매니저의 일이라(sessions/app-host-data.test.ts가 진짜로 본다) 여기서는 host 자리에 가짜를 앉혀 **언제 묻는가**만 본다.
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

describe('host_data — 닫힌 목록, 기본은 거절', () => {
  it('선언하지 않은 이름은 host에 묻지도 않는다', async () => {
    plant('notes', {})
    rt.refresh()
    expect(await ask('notes', { name: 'sessions.list' })).toMatchObject({
      isError: true,
      text: 'host_data refused: "sessions.list" is not in this app\'s "uses.host" — declare it in centralu.app.json: "uses": { "host": ["sessions.list"] }',
    })
    expect(asked).toEqual([])
  })

  it('목록 밖의 이름은 선언했어도 없는 능력이다 — 줄 수 있는 목록을 말한다', async () => {
    plant('notes', { host: ['sessions.list', 'files.read'] })
    rt.refresh()
    expect(await ask('notes', { name: 'files.read' })).toMatchObject({
      isError: true,
      text: 'host_data: Centralu has no host capability "files.read" — it can give: sessions.list, git.status',
    })
    expect(asked).toEqual([])
  })

  it('선언한 이름은 host가 답하고, 답은 JSON 그대로 온다 — host가 못 주면 그 이유가 온다', async () => {
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
