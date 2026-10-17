import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PermissionPreset } from '@cc/protocol'
import type { HistoryMessage, OrchestratorTools } from '../adapters/contract.js'
import { crossWorld, type CrossAdapter, type CrossWorld } from './cross-project.test-helpers.js'
import { MemoryGate } from './memory-gate.js'
import { runOrchestratorTool } from './orchestrator-tools.js'

/**
 * What a child session costs the machine (#686, owner decision 2026-10-15):
 *   - a child starts without code intelligence (its CLI's language servers) unless its caller asks for it, and keeps
 *     that through every wake; sessions the person starts keep the person's own setting;
 *   - a new child is started only while the machine has memory for it: below the floor, start_agent queues the start
 *     and answers with a handle, a fork becomes a place in the busy session's queue, and an app's agent waits inside
 *     the app's call.
 */

const GB = 1024 ** 3

describe('child sessions and the machine (#686)', () => {
  let w: CrossWorld
  let free: number
  beforeEach(async () => {
    w = await crossWorld()
    free = 8 * GB
  })
  afterEach(async () => {
    await w.dispose()
  })

  const claude = () => w.adapters.get('claude')!
  const handleOf = (id: string) => claude().handles.get(id)!
  const childrenOf = (id: string) => w.mgr.listSessions().filter((s) => s.askedBy === id)
  const session = async (preset: PermissionPreset = 'normal') =>
    (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: preset })).id
  const allowProject = () => w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
  const gate = (maxWaitMs = 10_000) => {
    const g = new MemoryGate({ read: async () => free, recheckMs: 20, maxWaitMs })
    w.mgr.useMemoryGate(g)
    return g
  }
  const said = (id: string, what: string) => w.store.messages.loadMessages(id, 50).some((m) => JSON.stringify(m.payload).includes(what))

  describe('code intelligence', () => {
    it("a start_agent child starts without it and keeps that through a wake; the person's session keeps their setting", async () => {
      allowProject()
      const s = await session()
      expect(handleOf(s).opts.noCodeIntelligence).toBeUndefined()
      const r = await w.mgr.startAgent(s, { task: 'add a test', wait: false })
      if (!r.ok) throw new Error(r.error)
      expect(handleOf(r.sessionId).opts.noCodeIntelligence).toBe(true)

      // A new process (a restart, a wake, a host's resume) starts as the first one did
      handleOf(r.sessionId).externalId = 'ext-child'
      handleOf(r.sessionId).answer('done')
      await w.mgr.agentSession(s, { sessionId: r.sessionId, action: 'wait' })
      const before = handleOf(r.sessionId)
      await w.mgr.restartSession(r.sessionId)
      expect(handleOf(r.sessionId)).not.toBe(before)
      expect(handleOf(r.sessionId).opts.noCodeIntelligence).toBe(true)
    })

    it('keeps it for a child whose caller asks (lsp: true), through the tool call', async () => {
      allowProject()
      const s = await session()
      const startAgent = (opts: Parameters<typeof w.mgr.startAgent>[1]) => w.mgr.startAgent(s, opts)
      const out = await runOrchestratorTool({ startAgent } as OrchestratorTools, 'start_agent', { task: 'rename the store API', wait: false, lsp: true }, { sessionId: s, profile: 'reader' })
      expect(out.isError).not.toBe(true)
      const [child] = childrenOf(s)
      expect(handleOf(child!.id).opts.noCodeIntelligence).toBeUndefined()
    })

    it('an agent an app asked for starts without it', async () => {
      const id = await new Promise<string>((resolve, reject) => {
        w.mgr
          .runAppAgent(
            { app: { projectId: w.caller.id, appId: 'app-notes' }, appName: 'Notes', tool: 'claude', prompt: 'look around' },
            { signal: new AbortController().signal, progress: () => {}, onSession: resolve },
          )
          .catch(reject)
      })
      expect(handleOf(id).opts.noCodeIntelligence).toBe(true)
    })
  })

  describe('memory', () => {
    it('queues a start_agent start below the floor, with a handle and a notice, and starts it when memory recovers', async () => {
      gate()
      allowProject()
      const s = await session()
      free = 1 * GB
      const r = await w.mgr.startAgent(s, { task: 'refactor the parser', wait: false, lsp: true })
      expect(r).toMatchObject({ ok: true, state: 'pending', lowMemory: { available: '1.0 GB', floor: '2.0 GB' } })
      const handle = r.ok ? r.sessionId : ''
      expect(childrenOf(s)).toEqual([])
      // The person reads why in the caller's session; the model reads "queued: low memory" and the handle
      expect(w.events).toContainEqual(expect.objectContaining({ type: 'notice', sessionId: s, label: 'waiting for memory' }))
      const text = (await runOrchestratorTool({ startAgent: async () => r } as unknown as OrchestratorTools, 'start_agent', { task: 'x' }, { sessionId: s, profile: 'reader' })).text
      expect(text).toMatch(/^queued: low memory/)
      expect(text).toContain(handle)
      expect(await w.mgr.agentSession(s, { sessionId: handle, action: 'status' })).toMatchObject({ state: 'pending', lowMemory: { floor: '2.0 GB' } })
      expect(await w.mgr.agentSession(s, { sessionId: handle, action: 'send', text: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('waiting for memory') })
      // Stored as allowed: a host that takes it over waits for memory, never asks the person again
      expect(w.store.children.listAgentStartRequests()).toEqual([expect.objectContaining({ requestId: handle, request: expect.objectContaining({ allowed: true, lsp: true }) })])

      await new Promise((r) => setTimeout(r, 100))
      expect(childrenOf(s)).toEqual([])
      free = 4 * GB
      await w.until(() => childrenOf(s).length === 1)
      const child = childrenOf(s)[0]!.id
      await w.until(() => handleOf(child).sent.length === 1)
      expect(handleOf(child).sent[0]).toContain('refactor the parser')
      // The choice made at the call is the child's
      expect(handleOf(child).opts.noCodeIntelligence).toBeUndefined()
      expect(w.store.children.listAgentStartRequests()).toEqual([])
      // The handle now leads to the child, and the caller is told when its turn ends
      expect(await w.mgr.agentSession(s, { sessionId: handle, action: 'status' })).toMatchObject({ ok: true, sessionId: child })
      handleOf(child).answer('parser refactored')
      await w.until(() => handleOf(s).sent.some((t) => t.includes(`sourceSessionId: ${child}`)))
    })

    it('starts at once while memory is above the floor', async () => {
      gate()
      allowProject()
      const s = await session()
      free = 2.5 * GB
      expect(await w.mgr.startAgent(s, { task: 'quick fix', wait: false })).toMatchObject({ ok: true, state: 'working' })
      expect(childrenOf(s)).toHaveLength(1)
    })

    it('gives up after the bound, and the caller and the person are told', async () => {
      gate(150)
      allowProject()
      const s = await session()
      free = 0.5 * GB
      const r = await w.mgr.startAgent(s, { task: 'long job', wait: false })
      const handle = r.ok ? r.sessionId : ''
      await w.until(() => handleOf(s).sent.some((t) => t.includes(`start_agent request ${handle} did not start a session`)), 3000)
      expect(handleOf(s).sent.at(-1)).toContain('Memory stayed below 2.0 GB')
      expect(said(s, 'memory stayed below 2.0 GB')).toBe(true)
      expect(childrenOf(s)).toEqual([])
      expect(w.store.children.listAgentStartRequests()).toEqual([])
    })

    it('a request withdrawn while it waits never starts', async () => {
      gate()
      allowProject()
      const s = await session()
      free = 1 * GB
      const r = await w.mgr.startAgent(s, { task: 'later', wait: false })
      const handle = r.ok ? r.sessionId : ''
      expect(await w.mgr.agentSession(s, { sessionId: handle, action: 'stop' })).toMatchObject({ ok: true, state: 'stopped' })
      free = 4 * GB
      await new Promise((r) => setTimeout(r, 100))
      expect(childrenOf(s)).toEqual([])
    })

    it('a fork below the floor becomes a place in the busy session\'s queue, and starts no process', async () => {
      gate()
      allowProject()
      const b = await session()
      const started = await w.mgr.startAgent(b, { task: 'first job', wait: false })
      if (!started.ok) throw new Error(started.error)
      const a = started.sessionId
      handleOf(a).externalId = 'ext-a'
      handleOf(a).answer('first job done')
      await w.mgr.agentSession(b, { sessionId: a, action: 'wait' })
      await w.mgr.send(a, "the person's own work")
      let forks = 0
      const fake = claude() as CrossAdapter & { forkConversation?: () => Promise<string>; readExternalHistory?: () => Promise<HistoryMessage[]> }
      fake.forkConversation = async () => `fork-${++forks}`
      fake.readExternalHistory = async () => []

      free = 1 * GB
      const r = await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'review the schema', ifBusy: 'fork_read' })
      expect(r).toMatchObject({ ok: true, state: 'queued', sessionId: a, position: 1, lowMemory: expect.stringContaining('1.0 GB free') })
      expect(forks).toBe(0)
      expect(w.mgr.listSessions().filter((s) => s.forkedFrom)).toEqual([])
      const text = (await runOrchestratorTool({ agentSession: async () => r } as unknown as OrchestratorTools, 'agent_session', { sessionId: a, action: 'send', text: 'x' }, { sessionId: b, profile: 'reader' })).text
      expect(text).toMatch(/^Not forked: memory is low/)

      // With memory, the fork goes ahead, and the copy starts without code intelligence
      free = 8 * GB
      const forked = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'read the logs', ifBusy: 'fork_read' })
      await w.until(() => w.mgr.listSessions().some((s) => s.forkedFrom === a))
      const fork = w.mgr.listSessions().find((s) => s.forkedFrom === a)!
      expect(handleOf(fork.id).opts.noCodeIntelligence).toBe(true)
      await w.until(() => handleOf(fork.id).sent.length === 1)
      handleOf(fork.id).answer('read')
      await forked
    })

    it("an app's agent waits inside the app's call, says so as progress, and starts when memory recovers", async () => {
      gate()
      free = 1 * GB
      const progress: string[] = []
      let sessionId: string | undefined
      void w.mgr
        .runAppAgent(
          { app: { projectId: w.caller.id, appId: 'app-notes' }, appName: 'Notes', tool: 'claude', prompt: 'look around' },
          { signal: new AbortController().signal, progress: (m) => progress.push(m), onSession: (id) => (sessionId = id) },
        )
        .catch(() => {})
      await w.until(() => progress.length > 0)
      expect(progress[0]).toContain('waiting for memory: 1.0 GB free, 2.0 GB needed')
      await new Promise((r) => setTimeout(r, 100))
      expect(sessionId).toBeUndefined()
      free = 4 * GB
      await w.until(() => !!sessionId)
    })

    it("an app's agent waiting for memory ends without a session when the app's call is cancelled", async () => {
      gate()
      free = 1 * GB
      const ctl = new AbortController()
      let sessionId: string | undefined
      const run = w.mgr.runAppAgent(
        { app: { projectId: w.caller.id, appId: 'app-notes' }, appName: 'Notes', tool: 'claude', prompt: 'look around' },
        { signal: ctl.signal, progress: () => {}, onSession: (id) => (sessionId = id) },
      )
      await new Promise((r) => setTimeout(r, 50))
      ctl.abort()
      await expect(run).rejects.toThrow('waiting for memory')
      free = 4 * GB
      await new Promise((r) => setTimeout(r, 100))
      expect(sessionId).toBeUndefined()
    })
  })
})
