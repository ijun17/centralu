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

  it('leaves a tool without limits as it was', async () => {
    const world = managerWorld()
    const p = (await world.rpc('projects.add', { path: dir })) as { id: string }
    await world.rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: 'codex', permissionPreset: 'safe' })
    expect(world.codexAdapter.lastOpts?.permissionPreset).toBe('safe')
  })
})
