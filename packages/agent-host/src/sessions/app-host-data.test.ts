import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionInfo } from '@cc/protocol'
import { PROJECT_APPS, plantApp } from '../apps/external/test-helpers.js'
import { brokerSaid, brokerWorld, type BrokerWorld } from './app-broker.test-helpers.js'

/**
 * Host data (M4 D-3) — what the manager gives back for each name. Checked with a real manager,
 * store, git and app process. The gate's own refusals (declaration, a closed list) are covered by
 * apps/external/host-data.test.ts.
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
  it('a project app receives only that project\'s sessions — a name and state, but no conversation content', async () => {
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
    // The name is only the sidebar's name (the first 40 characters of the first message) — nothing after it appears anywhere
    expect(sessions[0]!.name).toBe('plan the launch — the codename is BLUEBI…')
    expect(JSON.stringify(r.structured)).not.toContain('BLUEBIRD')
  })

  it('a user-folder app receives every session — a user-folder app belongs to the orchestrator', async () => {
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
  it('a project app receives that project\'s branch and changed files', async () => {
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

  it('a user-folder app has no project to pick — refused, with a reason', async () => {
    w.plant('user', 'timer', { host: ['git.status'] })
    w.rt.refresh()
    const orchestrator = await w.mgr.orchestrator()
    expect(await read(orchestrator, 'app-timer', 'git.status')).toMatchObject({
      isError: true,
      text: 'host_data failed: git.status needs a project — this app lives in your user folder, so there is no project to read',
    })
  })
})
