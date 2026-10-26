import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities } from '@cc/protocol'
import { managerWorld } from './manager.test-helpers.js'

/**
 * A tool that declares what it cannot keep (`presets`, `keepsRepoFilesOut`, `roleText`, docs/plans/acp-adapter.md §7)
 * is refused before its process starts, whichever path launches it: the host is the gate, the picker only shows it.
 */

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-refusal-')))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function limitedWorld() {
  const world = managerWorld()
  const limits: Partial<AdapterCapabilities> = { presets: ['normal', 'edits', 'auto'], keepsRepoFilesOut: false, roleText: false }
  Object.assign(world.codexAdapter, { capabilities: { ...world.codexAdapter.capabilities, ...limits } })
  world.codexAdapter.descriptor = { ...world.codexAdapter.descriptor, name: 'codex', label: 'Limited' }
  return world
}

describe('launching a tool that declares limits', () => {
  it('refuses an untrusted project before any process starts', async () => {
    const world = limitedWorld()
    const p = (await world.rpc('projects.add', { path: dir })) as { id: string }
    await expect(world.rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: 'codex' })).rejects.toThrow(/Limited.*trusted projects/)
    expect(world.codexAdapter.lastOpts).toBeNull()
  })

  it('starts it in a trusted project', async () => {
    const world = limitedWorld()
    const p = (await world.rpc('projects.add', { path: dir })) as { id: string }
    await world.rpc('projects.setTrusted', { projectId: p.id, trusted: true })
    await world.rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: 'codex' })
    expect(world.codexAdapter.lastOpts?.projectTrusted).toBe(true)
  })

  it('refuses a preset it does not list', async () => {
    const world = limitedWorld()
    const p = (await world.rpc('projects.add', { path: dir })) as { id: string }
    await world.rpc('projects.setTrusted', { projectId: p.id, trusted: true })
    await expect(world.rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: 'codex', permissionPreset: 'safe' })).rejects.toThrow(/Limited.*Safe/)
    expect(world.codexAdapter.lastOpts).toBeNull()
  })

  it('refuses that preset on a running session too, and keeps the one in force', async () => {
    const world = limitedWorld()
    const p = (await world.rpc('projects.add', { path: dir })) as { id: string }
    await world.rpc('projects.setTrusted', { projectId: p.id, trusted: true })
    const s = (await world.rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: 'codex' })) as { id: string }
    await expect(world.rpc('agents.updateSettings', { sessionId: s.id, permissionPreset: 'safe' })).rejects.toThrow(/Limited.*Safe/)
    const kept = (await world.rpc('sessions.list', {})) as { id: string; permissionPreset?: string }[]
    expect(kept.find((x) => x.id === s.id)?.permissionPreset).toBe('normal')
  })

  it('refuses switching a session to a tool that cannot keep its preset, and leaves it on its tool', async () => {
    const world = limitedWorld()
    const p = (await world.rpc('projects.add', { path: dir })) as { id: string }
    await world.rpc('projects.setTrusted', { projectId: p.id, trusted: true })
    const s = (await world.rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: 'claude', permissionPreset: 'safe' })) as { id: string }
    await expect(world.rpc('agents.switchTool', { sessionId: s.id, tool: 'codex' })).rejects.toThrow(/Limited.*Safe/)
    const kept = (await world.rpc('sessions.list', {})) as { id: string; tool: string; permissionPreset?: string }[]
    expect(kept.find((x) => x.id === s.id)).toMatchObject({ tool: 'claude', permissionPreset: 'safe' })
    expect(world.codexAdapter.lastOpts).toBeNull()
  })

  it('refuses a tool that takes no role text as the orchestrator, and keeps the one chosen', async () => {
    const world = limitedWorld()
    await world.rpc('orchestrator.configure', { tool: 'claude' })
    await expect(world.rpc('orchestrator.configure', { tool: 'codex' })).rejects.toThrow(/Limited.*role instructions/)
    expect(world.store.settings.appSetting('orchestrator_tool')).toBe('claude')
  })

  it('leaves a tool without limits as it was', async () => {
    const world = managerWorld()
    const p = (await world.rpc('projects.add', { path: dir })) as { id: string }
    await world.rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: 'codex', permissionPreset: 'safe' })
    expect(world.codexAdapter.lastOpts?.permissionPreset).toBe('safe')
  })
})
