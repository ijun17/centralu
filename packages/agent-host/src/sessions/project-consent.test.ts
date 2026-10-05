import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

/**
 * The person's consent for one project to reach another (#371) — the one gate both parts go through: ask_project
 * (kind 'delegate') and another project's app tools (kind 'apps'). It stands as an approval card in the calling
 * session; "always" is remembered for the pair and kind and revoked in Settings; "once" and "deny" are not kept.
 */
let w: CrossWorld
beforeEach(async () => {
  w = await crossWorld()
})
afterEach(async () => {
  await w.dispose()
})

const what = { text: 'export the sprites' }

describe('consent from one project to another', () => {
  it('asks in the calling session, and "always" is remembered for the pair, so the next reach does not ask', async () => {
    const s = await w.callerSession()
    const first = w.mgr.ensureProjectAccess(s, w.target.id, 'delegate', what)
    await w.until(() => !!w.card(s))
    const card = w.card(s)!
    expect(card.detail).toEqual({
      kind: 'project_access',
      access: 'delegate',
      from: { id: w.caller.id, name: w.caller.name },
      to: { id: w.target.id, name: w.target.name },
      text: 'export the sprites',
    })
    expect(w.mgr.listSessions().find((x) => x.id === s)?.state).toBe('waiting_approval')

    w.mgr.respondApproval(s, card.requestId, 'always')
    expect(await first).toEqual({ ok: true })
    expect(w.events.some((e) => e.type === 'project_consents_changed')).toBe(true)
    expect(w.mgr.projectConsents()).toMatchObject([{ fromProjectId: w.caller.id, fromName: w.caller.name, toProjectId: w.target.id, toName: w.target.name, kind: 'delegate' }])

    // Remembered: no second card
    expect(await w.mgr.ensureProjectAccess(s, w.target.id, 'delegate', what)).toEqual({ ok: true })
    expect(w.card(s)).toBeUndefined()
    // …but only for that kind and that direction
    const apps = w.mgr.ensureProjectAccess(s, w.target.id, 'apps', { text: '', app: { appId: 'extractor', name: 'Extractor' } })
    await w.until(() => !!w.card(s))
    expect(w.card(s)!.detail).toMatchObject({ access: 'apps', app: { appId: 'extractor', name: 'Extractor' } })
    w.mgr.respondApproval(s, w.card(s)!.requestId, 'deny')
    expect((await apps).ok).toBe(false)
  })

  it('"allow once" passes this call only, and asks again next time', async () => {
    const s = await w.callerSession()
    const first = w.mgr.ensureProjectAccess(s, w.target.id, 'delegate', what)
    await w.until(() => !!w.card(s))
    w.mgr.respondApproval(s, w.card(s)!.requestId, 'allow')
    expect(await first).toEqual({ ok: true })
    expect(w.mgr.projectConsents()).toEqual([])

    const second = w.mgr.ensureProjectAccess(s, w.target.id, 'delegate', what)
    await w.until(() => !!w.card(s))
    w.mgr.respondApproval(s, w.card(s)!.requestId, 'allow')
    expect(await second).toEqual({ ok: true })
  })

  it('a denial is refused in words the model can act on, and is not remembered', async () => {
    const s = await w.callerSession()
    const p = w.mgr.ensureProjectAccess(s, w.target.id, 'delegate', what)
    await w.until(() => !!w.card(s))
    w.mgr.respondApproval(s, w.card(s)!.requestId, 'deny')
    const r = await p
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain(`did not allow ${w.caller.name} to reach ${w.target.name}`)
    expect(!r.ok && r.error).toContain('Do not ask again')
    expect(w.mgr.projectConsents()).toEqual([])
    // The session goes back to work — it is still inside the tool call that asked
    expect(w.mgr.listSessions().find((x) => x.id === s)?.state).toBe('working')
  })

  it('a revoked pair asks again', async () => {
    const s = await w.callerSession()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    expect(await w.mgr.ensureProjectAccess(s, w.target.id, 'delegate', what)).toEqual({ ok: true })

    w.events.length = 0
    w.mgr.revokeProjectConsent(w.caller.id, w.target.id, 'delegate')
    expect(w.events.some((e) => e.type === 'project_consents_changed')).toBe(true)
    expect(w.mgr.projectConsents()).toEqual([])

    const p = w.mgr.ensureProjectAccess(s, w.target.id, 'delegate', what)
    await w.until(() => !!w.card(s))
    w.mgr.respondApproval(s, w.card(s)!.requestId, 'deny')
    expect((await p).ok).toBe(false)
  })

  it('a withdrawn question takes its card down and refuses', async () => {
    const s = await w.callerSession()
    const ac = new AbortController()
    const p = w.mgr.ensureProjectAccess(s, w.target.id, 'delegate', what, ac.signal)
    await w.until(() => !!w.card(s))
    const requestId = w.card(s)!.requestId
    ac.abort()
    const r = await p
    expect(r.ok).toBe(false)
    expect(w.card(s)).toBeUndefined()
    expect(w.events.some((e) => e.type === 'approval_resolved' && e.requestId === requestId)).toBe(true)
  })

  it('needs no consent inside its own project, and none from a session with no project', async () => {
    const s = await w.callerSession()
    expect(await w.mgr.ensureProjectAccess(s, w.caller.id, 'delegate', what)).toEqual({ ok: true })
    expect(w.card(s)).toBeUndefined()
    const orc = await w.mgr.orchestrator()
    expect((await w.mgr.ensureProjectAccess(orc.id, w.target.id, 'delegate', what)).ok).toBe(false)
  })

  it('lists and revokes through the RPC Settings uses', async () => {
    const { createRpcHandler } = await import('../rpc.js')
    const rpc = createRpcHandler(w.mgr, w.adapters as never)
    w.store.setProjectConsent(w.caller.id, w.target.id, 'apps')
    const list = (await rpc('projectConsents.list', {})) as { toName: string; kind: string }[]
    expect(list).toMatchObject([{ toName: w.target.name, kind: 'apps' }])
    await rpc('projectConsents.revoke', { fromProjectId: w.caller.id, toProjectId: w.target.id, kind: 'apps' })
    expect(await rpc('projectConsents.list', {})).toEqual([])
  })
})
