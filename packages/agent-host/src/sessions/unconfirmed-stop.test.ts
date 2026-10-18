import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PermissionPreset } from '@cc/protocol'
import { stopNotConfirmed } from '../adapters/session-kit.js'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

/**
 * A Stop the tool refused leaves the turn running, for the host too (#1060). The Claude adapter used to say a refused
 * interrupt as an `error` event, which moves the session to `error`: the manager took that as the turn's end, so a
 * delegation wait settled and a queued request went in while the CLI was still working. It is said as a notice now
 * (`stopNotConfirmed`), which moves no state; the turn ends when the tool says so.
 */
describe('a Stop the tool refused (#1060)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    await w.dispose()
  })

  const claude = () => w.adapters.get('claude')!
  const handleOf = (id: string) => claude().handles.get(id)!
  const info = (id: string) => w.mgr.listSessions().find((s) => s.id === id)!
  const session = async (preset: PermissionPreset = 'normal') =>
    (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: preset })).id
  /** B with a child A it started and is working on */
  const child = async () => {
    w.store.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const b = await session()
    const started = await w.mgr.startAgent(b, { task: 'first job', wait: false })
    if (!started.ok) throw new Error(started.error)
    return { a: started.sessionId, b }
  }
  /** The person presses Stop on A, and the tool refuses it the way the Claude adapter says so */
  const refusedStop = (a: string) => {
    const h = handleOf(a)
    const interrupt = h.interrupt.bind(h)
    h.interrupt = () => {
      interrupt()
      h.event(stopNotConfirmed(a, 'Could not stop: the control request was lost. The turn is still running.'))
    }
    w.mgr.interrupt(a)
  }
  const settles = (p: Promise<unknown>) => Promise.race([p.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 30))])

  it('a delegation wait stays pending while the turn runs on, and gets the answer the turn ends with', async () => {
    const { a, b } = await child()
    const waiting = w.mgr.agentSession(b, { sessionId: a, action: 'wait' })
    refusedStop(a)

    expect(info(a).state).toBe('working')
    expect(await settles(waiting)).toBe(false)

    // The person's Stop did not take effect, so the child's finished answer is its own, not "the person stopped it"
    handleOf(a).answer('first job done')
    expect(await waiting).toMatchObject({ ok: true, state: 'done', answer: 'first job done' })
  })

  it('a queued request is held until the turn really ends', async () => {
    const { a, b } = await child()
    handleOf(a).answer('first job done')
    await w.mgr.agentSession(b, { sessionId: a, action: 'wait' })
    await w.mgr.send(a, "the person's own work")
    expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'add the index', ifBusy: 'queue' })).toMatchObject({ state: 'queued' })
    const sent = handleOf(a).sent.length

    refusedStop(a)
    await new Promise((r) => setTimeout(r, 30))
    expect(info(a).state).toBe('working')
    expect(handleOf(a).sent).toHaveLength(sent)
    expect(w.store.listQueuedRequests()).toHaveLength(1)

    handleOf(a).answer("the person's answer")
    await w.until(() => handleOf(a).sent.length === sent + 1)
    expect(handleOf(a).sent.at(-1)).toContain('add the index')
  })
})
