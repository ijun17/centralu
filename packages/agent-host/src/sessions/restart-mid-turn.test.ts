import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

/**
 * A restart or a tool switch in the middle of a turn ends that turn (#839, item 1). The old process goes, and Claude's
 * dispose says nothing of the turn; the new process is stated `idle` by the host, which is not a turn's end that the
 * waits read. Before, a delegation on that turn never settled (it kept its place under the agent limit), its caller's
 * report waited for the next unrelated turn and reported that turn's answer as the delegated result.
 */
describe('a turn its process took with it (#839)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
  })
  afterEach(async () => {
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id) ?? w.adapters.get('codex')!.handles.get(id)
  const childrenOf = (id: string) => w.mgr.listSessions().filter((s) => s.askedBy === id)
  const parent = async () => (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal' })).id
  /** The reports of a child's work the parent was given */
  const reports = (s: string, child: string) =>
    w.store.messages.loadMessages(s, 50).map((m) => JSON.stringify(m.payload)).filter((t) => t.includes('[Centralu] The assigned work') && t.includes(child))
  /** The child's tool names its conversation, as a real one does on its first output, so a restart can resume it */
  const named = (child: string) => {
    const h = handleOf(child)!
    h.externalId = `ext-${child}`
    h.event({ type: 'message_delta', sessionId: child, role: 'assistant', text: 'Reading the grammar…' })
    return child
  }
  /** A waited start_agent whose child is mid-turn */
  const waitedChild = async (s: string) => {
    const call = w.mgr.startAgent(s, { task: 'write the parser' })
    await w.until(() => childrenOf(s).length === 1 && !!handleOf(childrenOf(s)[0]!.id)?.sent.length)
    return { call, child: named(childrenOf(s)[0]!.id) }
  }

  it.each([
    ['a restart', (w: CrossWorld, id: string) => w.mgr.restartSession(id)],
    ['a tool switch', (w: CrossWorld, id: string) => w.mgr.switchTool(id, 'codex')],
  ])('%s settles a waited start_agent as stopped', async (_, swap) => {
    const s = await parent()
    const { call, child } = await waitedChild(s)
    expect(w.mgr.listSessions().find((x) => x.id === child)?.state).toBe('working')
    await swap(w, child)
    const r = await call
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('stopped before it finished')
  })

  it("a child's report says it stopped, and its next turn is not reported as the delegated result", async () => {
    const s = await parent()
    const r = await w.mgr.startAgent(s, { task: 'write the parser', wait: false })
    expect(r).toMatchObject({ ok: true, state: 'working' })
    const child = named(childrenOf(s)[0]!.id)
    const told = () => reports(s, child)
    expect((await w.mgr.restartSession(child)).resumed).toBe(true)
    await w.until(() => told().length === 1)
    expect(told()[0]).toContain('stopped before finishing')
    // The person's own turn in the child afterwards is not the parent's to hear about
    await w.mgr.send(child, 'something else')
    handleOf(child)!.answer('Unrelated answer.')
    await new Promise((r) => setImmediate(r))
    expect(told()).toHaveLength(1)
  })

  it('a restart at rest ends no turn: no report and no stop', async () => {
    const s = await parent()
    const r = await w.mgr.startAgent(s, { task: 'write the parser', wait: false })
    expect(r.ok).toBe(true)
    const child = named(childrenOf(s)[0]!.id)
    handleOf(child)!.answer('Parser done.')
    await w.until(() => reports(s, child).length === 1)
    const events = w.events.length
    expect((await w.mgr.restartSession(child)).resumed).toBe(true)
    expect(w.events.slice(events).filter((e) => e.type === 'state_change' && e.sessionId === child && e.reason === 'interrupted')).toEqual([])
    expect(reports(s, child)).toHaveLength(1)
  })
})
