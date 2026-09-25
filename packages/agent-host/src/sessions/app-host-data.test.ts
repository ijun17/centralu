import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionInfo } from '@cc/protocol'
import { PROJECT_APPS, plantApp } from '../apps/external/test-helpers.js'
import { brokerSaid, brokerWorld, type BrokerWorld } from './app-broker.test-helpers.js'

/**
 * host 데이터 (M4 D-3) — 매니저가 이름마다 무엇을 주는가. 진짜 매니저·저장소·git·앱 프로세스로 본다. 창구의 거절(선언·닫힌
 * 목록)은 apps/external/host-data.test.ts가 본다.
 */

let w: BrokerWorld

beforeEach(async () => {
  w = await brokerWorld({ plantApp, PROJECT_APPS })
})

afterEach(async () => {
  await w.dispose()
})

const read = async (caller: SessionInfo, server: string, name: string) => brokerSaid(await w.callFromSession(caller, server, { tool: 'host_data', args: { name } }))

describe('sessions.list', () => {
  it('프로젝트 앱은 그 프로젝트의 세션만 받는다 — 이름·상태는 있고 대화 내용은 없다', async () => {
    w.plant('project', 'notes', { host: ['sessions.list'] })
    w.rt.refresh()
    const other = join(w.root, 'other')
    execFileSync('git', ['init', '-q', '-b', 'main', other])
    const otherId = ((await w.rpc('projects.add', { path: other })) as { id: string }).id
    const prompt = 'plan the launch — the codename is BLUEBIRD, keep it quiet'
    const mine = (await w.rpc('agents.createSession', { projectId: w.projectId, cwd: w.repo, tool: 'claude', initialPrompt: prompt })) as SessionInfo
    await w.rpc('agents.createSession', { projectId: otherId, cwd: other, tool: 'claude' })

    const r = await read(mine, 'app-notes', 'sessions.list')
    expect(r.isError).toBe(false)
    const sessions = (r.structured as { sessions: Record<string, unknown>[] }).sessions
    expect(sessions.map((s) => [s.id, s.project, s.kind, s.tool])).toEqual([[mine.id, 'repo', 'worker', 'claude']])
    expect(Object.keys(sessions[0]!).sort()).toEqual(['appId', 'branch', 'createdAt', 'id', 'kind', 'live', 'name', 'project', 'state', 'tool', 'waitingSince'])
    // 이름은 사이드바의 그 이름(첫 메시지의 앞 40자)까지만 — 그 뒤의 말은 어디에도 없다
    expect(sessions[0]!.name).toBe('plan the launch — the codename is BLUEBI…')
    expect(JSON.stringify(r.structured)).not.toContain('BLUEBIRD')
  })

  it('사용자 폴더 앱은 모든 세션을 받는다 — 사용자 폴더 앱은 오케스트레이터의 것이다', async () => {
    w.plant('user', 'timer', { host: ['sessions.list'] })
    w.rt.refresh()
    const orchestrator = await w.mgr.orchestrator()
    const worker = (await w.rpc('agents.createSession', { projectId: w.projectId, cwd: w.repo, tool: 'claude' })) as SessionInfo
    const r = await read(orchestrator, 'app-timer', 'sessions.list')
    const ids = (r.structured as { sessions: { id: string }[] }).sessions.map((s) => s.id).sort()
    expect(ids).toEqual([orchestrator.id, worker.id].sort())
  })
})

describe('git.status', () => {
  it("프로젝트 앱은 그 프로젝트의 브랜치와 바뀐 파일을 받는다", async () => {
    w.plant('project', 'notes', { host: ['git.status'] })
    w.rt.refresh()
    mkdirSync(join(w.repo, 'docs'))
    writeFileSync(join(w.repo, 'docs', 'plan.md'), 'draft\n')
    const caller = (await w.rpc('agents.createSession', { projectId: w.projectId, cwd: w.repo, tool: 'claude' })) as SessionInfo
    const r = await read(caller, 'app-notes', 'git.status')
    expect(r.isError).toBe(false)
    const status = r.structured as { isRepo: boolean; branch: string; files: { path: string; status: string }[] }
    expect(status.isRepo).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.files.map((f) => [f.path, f.status])).toContainEqual(['docs/plan.md', '?'])
  })

  it('사용자 폴더 앱에는 고를 프로젝트가 없다 — 이유와 함께 거절', async () => {
    w.plant('user', 'timer', { host: ['git.status'] })
    w.rt.refresh()
    const orchestrator = await w.mgr.orchestrator()
    expect(await read(orchestrator, 'app-timer', 'git.status')).toMatchObject({
      isError: true,
      text: 'host_data failed: git.status needs a project — this app lives in your user folder, so there is no project to read',
    })
  })
})
