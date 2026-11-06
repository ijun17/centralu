import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_VERSION, PROTOCOL_VERSION, type NormalizedEvent, type ProjectInfo } from '@cc/protocol'
import { Store } from './dev-services/store.js'
import { SessionManager } from './sessions/manager.js'
import { scriptedAdapters } from './links/scripted-agent.test-helpers.js'
import { createRpcHandler } from './rpc.js'
import { HostServer } from './transport/server.js'
import { eventually } from '../../../tooling/test-timing.js'

/**
 * A per-project setting written through RPC reaches every other client (#719): two real clients on one host, one
 * writes, the other hears `projects_changed` and reads the new value. Without the event the other window kept the old
 * value until it re-read the list by chance.
 */

const TOKEN = 'tok'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function host() {
  const store = new Store()
  const adapters = scriptedAdapters()
  const mgr = new SessionManager(store, adapters, (e) => server.broadcast(e))
  const server: HostServer = new HostServer({
    port: 0,
    token: TOKEN,
    onRpc: createRpcHandler(mgr, adapters, {}),
    build: { commit: 'abc1234', protocolVersion: PROTOCOL_VERSION, version: APP_VERSION },
  })
  const port = await server.listen()
  cleanups.push(async () => {
    await mgr.disposeAll()
    await server.close()
  })
  const dir = mkdtempSync(join(tmpdir(), 'cc-settings-events-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const project = await mgr.addProject(dir)
  return { port, project }
}

async function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const frames: Record<string, any>[] = []
  const pending = new Map<string, (f: any) => void>()
  let n = 0
  await new Promise<void>((resolve) => {
    ws.onopen = () => ws.send(JSON.stringify({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION }))
    ws.onmessage = (m) => {
      const f = JSON.parse(String(m.data))
      frames.push(f)
      if (f.kind === 'hello_ok') resolve()
      if (f.kind === 'res') pending.get(f.id)?.(f)
    }
  })
  cleanups.push(() => ws.close())
  const call = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = String(++n)
      pending.set(id, (f) => (f.ok ? resolve(f.result) : reject(new Error(f.error.message))))
      ws.send(JSON.stringify({ kind: 'rpc', id, method, params }))
    })
  const events = () => frames.filter((f) => f.kind === 'event').map((f) => f.event as NormalizedEvent)
  const changes = () => events().filter((e) => e.type === 'projects_changed').length
  return { call, changes }
}

const read = async (c: Awaited<ReturnType<typeof client>>, id: string) =>
  ((await c.call('projects.list')) as ProjectInfo[]).find((p) => p.id === id)!

describe('a project setting another client wrote is announced (#719)', () => {
  it('trust', async () => {
    const { port, project } = await host()
    const [a, b] = [await client(port), await client(port)]
    expect((await read(b, project.id)).trusted).toBe(false)
    await a.call('projects.setTrusted', { projectId: project.id, trusted: true })
    await eventually(() => b.changes() >= 1)
    expect((await read(b, project.id)).trusted).toBe(true)
    const before = b.changes()
    await a.call('projects.setTrusted', { projectId: project.id, trusted: false })
    await eventually(() => b.changes() > before)
    expect((await read(b, project.id)).trusted).toBe(false)
  })

  it('saved commands', async () => {
    const { port, project } = await host()
    const [a, b] = [await client(port), await client(port)]
    await a.call('projects.setCommands', { projectId: project.id, commands: [{ command: 'pnpm dev', label: 'Dev' }] })
    await eventually(() => b.changes() >= 1)
    expect((await read(b, project.id)).commands).toEqual([{ command: 'pnpm dev', label: 'Dev' }])
  })

  it('worktree setup', async () => {
    const { port, project } = await host()
    const [a, b] = [await client(port), await client(port)]
    await a.call('projects.setWorktreeSetup', { projectId: project.id, setup: { command: 'pnpm i', copyFiles: ['.env'] } })
    await eventually(() => b.changes() >= 1)
    expect((await read(b, project.id)).worktreeSetup).toEqual({ command: 'pnpm i', copyFiles: ['.env'] })
  })

  it('the default tool and the model a session was last set to', async () => {
    const { port, project } = await host()
    const [a, b] = [await client(port), await client(port)]
    const made = await a.call('agents.createSession', { projectId: project.id, cwd: project.path, tool: 'codex' })
    await eventually(() => b.changes() >= 1)
    expect((await read(b, project.id)).defaultTool).toBe('codex')
    const heard = b.changes()
    await a.call('agents.updateSettings', { sessionId: made.id, model: 'a-model', effort: 'high' })
    await eventually(() => b.changes() > heard)
    expect((await read(b, project.id)).defaultModels.codex).toEqual({ model: 'a-model', effort: 'high' })
    // The same choice again changes nothing, so it says nothing
    const settled = b.changes()
    await a.call('agents.updateSettings', { sessionId: made.id, model: 'a-model', effort: 'high' })
    await new Promise((r) => setTimeout(r, 100))
    expect(b.changes()).toBe(settled)
  })

  it('says nothing when a write saves what was already there', async () => {
    const { port, project } = await host()
    const [a, b] = [await client(port), await client(port)]
    await a.call('projects.setTrusted', { projectId: project.id, trusted: true })
    await a.call('projects.setCommands', { projectId: project.id, commands: [{ command: 'pnpm dev' }] })
    await a.call('projects.setWorktreeSetup', { projectId: project.id, setup: { command: 'pnpm i', copyFiles: [] } })
    await eventually(() => b.changes() >= 3)
    const settled = b.changes()
    await a.call('projects.setTrusted', { projectId: project.id, trusted: true })
    await a.call('projects.setCommands', { projectId: project.id, commands: [{ command: ' pnpm dev ' }] })
    await a.call('projects.setWorktreeSetup', { projectId: project.id, setup: { command: 'pnpm i', copyFiles: [''] } })
    await new Promise((r) => setTimeout(r, 150))
    expect(b.changes()).toBe(settled)
  })

  it('says nothing for a project that does not exist', async () => {
    const { port } = await host()
    const [a, b] = [await client(port), await client(port)]
    await expect(a.call('projects.setTrusted', { projectId: 'nope', trusted: true })).rejects.toThrow(/Project not found/)
    await new Promise((r) => setTimeout(r, 100))
    expect(b.changes()).toBe(0)
  })
})
