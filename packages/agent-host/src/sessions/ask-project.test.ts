import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ASK_WAIT_MS, askFrame, clipAnswer, matchProjects, pathsIn, projectChoice, readableGrants, underGrant, type AskableProject } from './ask-project.js'
import { SessionManager } from './manager.js'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

/**
 * ask_project (#371 part B): a session in one project asks another project to do a task, and reads the answer
 * back — through the person's consent for the pair, in a visible session of the target project, with the files the
 * answer names made readable to the caller and nothing broader.
 */

describe('the projects a name points at, here and on linked machines (#700)', () => {
  const here = (id: string, name: string): AskableProject => ({ id, name, machine: null, machineId: null })
  const there = (machineId: string, machine: string, id: string, name: string): AskableProject => ({ id: `${machineId}.${id}`, name, machine, machineId })
  const all = [here('p1', 'vibe'), here('p2', 'cc'), there('ijun1', 'Windows PC', 'p9', 'cc'), there('ijun1', 'Windows PC', 'p8', 'solo'), there('box', 'Linux box', 'p3', 'Solo')]

  it('takes a name that exists once, wherever it is, and an id or a machine-qualified form always', () => {
    expect(matchProjects('vibe', all).map((p) => p.id)).toEqual(['p1'])
    expect(matchProjects('solo', all).map((p) => p.id)).toEqual(['ijun1.p8'])
    expect(matchProjects('ijun1.p9', all).map((p) => p.id)).toEqual(['ijun1.p9'])
    expect(matchProjects('p2', all).map((p) => p.id)).toEqual(['p2'])
    // The machine by its id or by the name the person gave it, case aside; the project by its name, case aside last
    for (const wanted of ['ijun1/cc', 'Windows PC/cc', 'windows pc/CC']) expect(matchProjects(wanted, all).map((p) => p.id)).toEqual(['ijun1.p9'])
    expect(matchProjects('box/solo', all).map((p) => p.id)).toEqual(['box.p3'])
  })

  it('returns every machine that has the name, so the caller can refuse and list them; two on one machine count once', () => {
    expect(matchProjects('cc', all).map((p) => p.id)).toEqual(['p2', 'ijun1.p9'])
    expect(matchProjects('cc', [here('a', 'cc'), here('b', 'cc')]).map((p) => p.id)).toEqual(['a'])
    expect(matchProjects('nothing', all)).toEqual([])
    expect(matchProjects('ijun1/nothing', all)).toEqual([])
    expect(matchProjects('nowhere/cc', all)).toEqual([])
  })

  it('prefers the exact spelling anywhere over a spelling that differs in case, and this computer’s exact name over a machine’s', () => {
    const mixed = [here('p1', 'Solo'), there('ijun1', 'Windows PC', 'p9', 'solo'), there('box', 'Linux box', 'p3', 'SOLO')]
    // Written as the machine’s project is: only that one, though this computer’s differs by case alone
    expect(matchProjects('solo', mixed).map((p) => p.id)).toEqual(['ijun1.p9'])
    // Written as this computer’s is: it is not beaten by the machines’ projects that differ by case
    expect(matchProjects('Solo', mixed).map((p) => p.id)).toEqual(['p1'])
    // Spelled in none of the ways: every project of that name, any case, is a choice
    expect(matchProjects('sOlO', mixed).map((p) => p.id)).toEqual(['p1', 'ijun1.p9', 'box.p3'])
    // The machine’s exact name wins within it too
    expect(matchProjects('ijun1/solo', [...mixed, there('ijun1', 'Windows PC', 'p10', 'Solo')]).map((p) => p.id)).toEqual(['ijun1.p9'])
  })

  it('tells the choices apart by id and machine', () => {
    expect(projectChoice(here('p2', 'cc'))).toBe('cc [p2] on this computer')
    expect(projectChoice(there('ijun1', 'Windows PC', 'p9', 'cc'))).toBe('cc [ijun1.p9] on Windows PC')
  })
})

describe('the paths an answer names', () => {
  it('finds absolute paths around quotes, backticks and punctuation, and nothing that names no file', () => {
    expect(pathsIn('Wrote `/p/out/a.png` and "/p/out/b.png". Also see (/p/log.txt), then /tmp/x.')).toEqual([
      '/p/out/a.png',
      '/p/out/b.png',
      '/p/log.txt',
      '/tmp/x',
    ])
    expect(pathsIn('Saved to C:\\work\\out\\a.png and a relative out/b.png, and / alone')).toEqual(['C:\\work\\out\\a.png'])
  })
})

describe('what the caller may read', () => {
  let root: string
  let project: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-grant-')))
    project = join(root, 'toolkit')
    mkdirSync(join(project, 'out'), { recursive: true })
    writeFileSync(join(project, 'out', 'a.png'), 'x')
    writeFileSync(join(project, 'README.md'), 'x')
    writeFileSync(join(root, 'secret.txt'), 'x')
    symlinkSync(root, join(project, 'escape'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('grants named files and output folders inside the target project, never its root, never outside it', () => {
    const r = readableGrants(
      [join(project, 'out', 'a.png'), join(project, 'out'), join(project, 'README.md'), project, join(root, 'secret.txt'), join(project, 'escape', 'secret.txt'), join(project, 'gone.png')],
      project,
    )
    expect(r.granted).toEqual([join(project, 'out', 'a.png'), join(project, 'out'), join(project, 'README.md')])
    expect(r.outside).toEqual([project, join(root, 'secret.txt'), join(project, 'escape', 'secret.txt'), join(project, 'gone.png')])
  })

  it('a granted file opens that file only; a granted folder opens what is under it', () => {
    const grants = [join(project, 'README.md'), join(project, 'out')]
    expect(underGrant(join(project, 'README.md'), grants, '/')).toBe(true)
    expect(underGrant(join(project, 'out', 'a.png'), grants, '/')).toBe(true)
    expect(underGrant('out/a.png', grants, project)).toBe(true)
    expect(underGrant(join(project, 'package.json'), grants, '/')).toBe(false)
    expect(underGrant(join(project, 'outside.png'), grants, '/')).toBe(false)
    // A link inside a granted folder still resolves to where it points
    symlinkSync(join(root, 'secret.txt'), join(project, 'out', 'link.txt'))
    expect(underGrant(join(project, 'out', 'link.txt'), grants, '/')).toBe(false)
  })

  it('reads a path in another spelling of the same place as the grant: a link to the root, another case (#428)', () => {
    const grants = readableGrants([join(project, 'out')], project).granted
    // The temp folder as the system names it can be a link (macOS: /var is /private/var); a file not made yet included
    const viaLink = join(tmpdir(), basename(root), 'toolkit', 'out', 'new.png')
    expect(underGrant(viaLink, grants, '/')).toBe(true)
    // A volume that folds case names the same folder in either case; the grant is read in its case on disk
    if (existsSync(join(root, 'TOOLKIT'))) expect(underGrant(join(root, 'TOOLKIT', 'out', 'a.png'), grants, '/')).toBe(true)
    // Still closed outside the grant, in any spelling
    expect(underGrant(join(tmpdir(), basename(root), 'toolkit', 'README.md'), grants, '/')).toBe(false)
    expect(underGrant(join(root, 'secret.txt'), grants, '/')).toBe(false)
  })

  it('cuts a long answer in the middle and says where the whole of it is', () => {
    const long = `${'a'.repeat(5000)}${'b'.repeat(3000)}/p/out/a.png`
    const cut = clipAnswer(long, 'Asked by consumer')
    expect(cut.length).toBeLessThan(long.length)
    expect(cut.startsWith('a'.repeat(4500))).toBe(true)
    expect(cut.endsWith('/p/out/a.png')).toBe(true)
    expect(cut).toContain('the whole answer is in the session "Asked by consumer"')
  })
})

describe('asking another project', () => {
  let w: CrossWorld
  let targetSession: string
  beforeEach(async () => {
    w = await crossWorld()
    targetSession = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'codex', model: 'gpt-5.6-luna', effort: 'low', permissionPreset: 'normal' })).id
    w.mgr.rename(targetSession, 'Sprites')
  })
  afterEach(async () => {
    vi.useRealTimers()
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id) ?? w.adapters.get('codex')!.handles.get(id)
  const delegatedIn = (_callerId: string) => w.mgr.listSessions().filter((s) => s.id === targetSession)
  /** A caller whose preset lets it add a note to a turn that is not its own (#606, #677) */
  const autoCaller = async () => {
    const c = await w.callerSession()
    await w.mgr.updateSettings(c, { permissionPreset: 'auto' })
    return c
  }

  it('refuses an empty project without consent, adapter discovery or session creation, including under auto', async () => {
    await w.mgr.trashSession(targetSession)
    const caller = await w.callerSession()
    await w.mgr.updateSettings(caller, { permissionPreset: 'auto' })
    const create = vi.spyOn(w.mgr, 'createSession')
    const detect = vi.spyOn(w.adapters.get('codex')!, 'detect')
    expect(await w.mgr.askProject(caller, { project: w.target.id, task: 'export' })).toMatchObject({ ok: false, error: expect.stringContaining('The person has to open one there') })
    expect(create).not.toHaveBeenCalled()
    expect(detect).not.toHaveBeenCalled()
    expect(w.card(caller)).toBeUndefined()
  })

  it('lists multiple sessions with their names, states and last activity, then accepts a name or id', async () => {
    const caller = await w.callerSession()
    const other = await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })
    w.mgr.rename(other.id, 'Review')
    handleOf(other.id)!.answer('old answer')
    const list = await w.mgr.askProject(caller, { project: w.target.id, task: 'export' })
    expect(!list.ok && list.error).toContain('Name a session')
    expect(!list.ok && list.error).toContain('"name":"Sprites","state":"idle","lastActive":null')
    expect(!list.ok && list.error).toContain('"name":"Review","state":"waiting_input","lastActive":"')
    expect(w.card(caller)).toBeUndefined()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    for (const session of ['Sprites', targetSession]) {
      const call = w.mgr.askProject(caller, { project: w.target.id, session, task: 'export' })
      await w.until(() => handleOf(targetSession)!.sent.length === (session === 'Sprites' ? 1 : 2))
      handleOf(targetSession)!.answer('done')
      expect(await call).toMatchObject({ ok: true, sessionId: targetSession })
    }
    expect(handleOf(other.id)!.sent).toEqual([])
  })

  it('refuses duplicate names, unknown names and a session from another project without creating or sending', async () => {
    const caller = await w.callerSession()
    const other = await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })
    w.mgr.rename(other.id, 'Sprites')
    for (const session of ['Sprites', 'missing', caller]) {
      expect(await w.mgr.askProject(caller, { project: w.target.id, session, task: 'export' })).toMatchObject({ ok: false, error: expect.stringContaining('No unique ordinary session') })
    }
    expect(handleOf(targetSession)!.sent).toEqual([])
    expect(w.card(caller)).toBeUndefined()
  })

  it('excludes the orchestrator, builders and app agents from selection', async () => {
    const caller = await w.callerSession()
    const excluded = []
    for (const params of [{ kind: 'orchestrator' as const }, { appId: 'builder', builderOf: { projectId: w.target.id, appId: 'builder' } }, { appId: 'agent', appAgent: {} }]) {
      excluded.push(await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal', ...params }))
    }
    for (const session of excluded) {
      expect(await w.mgr.askProject(caller, { project: w.target.id, session: session.id, task: 'export' })).toMatchObject({ ok: false })
    }
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const call = w.mgr.askProject(caller, { project: w.target.id, task: 'export' })
    await w.until(() => handleOf(targetSession)!.sent.length === 1)
    handleOf(targetSession)!.answer('done')
    expect(await call).toMatchObject({ ok: true, sessionId: targetSession })
  })

  it("never names the person's blank session after the incoming task; the person's own first words still do (#646)", async () => {
    const caller = await w.callerSession()
    const blank = await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })
    expect(blank).toMatchObject({ name: 'New session', autoNamed: true })
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const call = w.mgr.askProject(caller, { project: w.target.id, session: blank.id, task: 'export the sprites' })
    await w.until(() => handleOf(blank.id)!.sent.length === 1)
    expect(w.mgr.listSessions().find((s) => s.id === blank.id)).toMatchObject({ name: 'New session', autoNamed: true })
    expect(w.events.filter((e) => e.type === 'session_title' && e.sessionId === blank.id)).toEqual([])
    handleOf(blank.id)!.answer('exported')
    expect(await call).toMatchObject({ ok: true, answer: 'exported' })
    await w.mgr.send(blank.id, 'now the tiles')
    expect(w.mgr.listSessions().find((s) => s.id === blank.id)!.name).toBe('now the tiles')
  })

  it.each(['claude', 'codex'] as const)('%s delivers a busy session a visible mid-turn note and waits for its receipt', async (tool) => {
    await w.mgr.switchTool(targetSession, tool)
    const caller = await autoCaller()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    await w.mgr.send(targetSession, 'person work')
    const h = handleOf(targetSession)!
    const call = w.mgr.askProject(caller, { project: w.target.id, task: 'export', ifBusy: 'note' })
    await w.until(() => h.sent.length === 2)
    expect(h.interrupted).toBe(0)
    expect(h.sent[1]).toContain("through Centralu's ask_project")
    expect(w.events).toContainEqual(expect.objectContaining({ type: 'user_message', sessionId: targetSession, from: expect.objectContaining({ sessionId: caller }) }))
    let answered = false
    void call.then(() => { answered = true })
    h.answer('old turn answer', false)
    await Promise.resolve()
    expect(answered).toBe(false)
    h.answer('note answer')
    expect(await call).toMatchObject({ ok: true, answer: 'note answer', sessionId: targetSession })
  })

  it('keeps an existing report-back marker until the mid-turn task completes, then reports once', async () => {
    const caller = await autoCaller()
    const directing = await w.mgr.createSession({ projectId: null, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal', kind: 'orchestrator' })
    const directingHandle = handleOf(directing.id)!
    await directingHandle.opts.orchestratorTools!.sendToSession(targetSession, 'original task', true)
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const call = w.mgr.askProject(caller, { project: w.target.id, task: 'export', ifBusy: 'note' })
    const h = handleOf(targetSession)!
    await w.until(() => h.sent.length === 2)
    h.answer('old turn', false)
    await Promise.resolve()
    expect(directingHandle.sent).toEqual([])
    h.answer('note answer')
    expect(await call).toMatchObject({ ok: true, answer: 'note answer' })
    await w.until(() => directingHandle.sent.length === 1)
    expect(directingHandle.sent[0]).toContain(`sourceSessionId: ${targetSession}`)
    h.answer('later turn')
    await Promise.resolve()
    expect(directingHandle.sent).toHaveLength(1)
  })

  it.each(['working', 'waiting_approval'] as const)('returns the choices for a busy session (%s), with no note when its CLI cannot take one (#677)', async (state) => {
    const caller = await autoCaller()
    // Through working: the host keeps the window's table (#428), and idle → waiting_approval is not in it
    handleOf(targetSession)!.event({ type: 'state_change', sessionId: targetSession, state: 'working' })
    handleOf(targetSession)!.event({ type: 'state_change', sessionId: targetSession, state })
    w.adapters.get('codex')!.capabilities.midTurnInput = false
    expect(await w.mgr.askProject(caller, { project: w.target.id, task: 'export' })).toMatchObject({
      ok: true, state: 'busy', sessionState: state,
      choices: [
        { choice: 'note', available: false, why: expect.stringContaining('cannot take a note') },
        { choice: 'queue', available: true },
        { choice: 'fork', available: false, why: expect.stringContaining('another project') },
      ],
    })
    expect(await w.mgr.askProject(caller, { project: w.target.id, task: 'export', ifBusy: 'note' })).toMatchObject({ ok: false, error: expect.stringContaining('cannot take a note') })
    expect(handleOf(targetSession)!.sent).toEqual([])
    expect(w.card(caller)).toBeUndefined()
  })

  it('rechecks a session deleted while its consent card was open and never replaces it', async () => {
    const caller = await w.callerSession()
    const call = w.mgr.askProject(caller, { project: w.target.id, task: 'export' })
    await w.until(() => !!w.card(caller))
    expect(w.card(caller)!.detail).toMatchObject({ session: { id: targetSession, name: 'Sprites' } })
    await w.mgr.trashSession(targetSession)
    w.mgr.respondApproval(caller, w.card(caller)!.requestId, 'allow')
    expect(await call).toMatchObject({ ok: false, error: expect.stringContaining('no longer available') })
    expect(w.mgr.listSessions().filter((s) => s.projectId === w.target.id)).toEqual([])
  })

  it("does not replace another caller's active delegation watcher", async () => {
    const caller = await w.callerSession()
    const other = await w.callerSession()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const first = w.mgr.askProject(caller, { project: w.target.id, task: 'export' })
    await w.until(() => handleOf(targetSession)!.sent.length === 1)
    // Busy with another caller's task (#677): the choices, and no note into that task even for auto
    expect(await w.mgr.askProject(other, { project: w.target.id, task: 'review' })).toMatchObject({ ok: true, state: 'busy', choices: [{ choice: 'note', available: false }, { choice: 'queue', available: true }, { choice: 'fork', available: false }] })
    await w.mgr.updateSettings(other, { permissionPreset: 'auto' })
    expect(await w.mgr.askProject(other, { project: w.target.id, task: 'review', ifBusy: 'note' })).toMatchObject({ ok: false, error: expect.stringContaining("another session's task") })
    expect(handleOf(targetSession)!.sent).toHaveLength(1)
    handleOf(targetSession)!.answer('original answer')
    expect(await first).toMatchObject({ ok: true, answer: 'original answer' })
  })

  it.each(['live', 'trashed', 'purged'] as const)('restores old cross-project asked sessions as ordinary sessions when their caller is %s', async (ownerState) => {
    const caller = await w.callerSession()
    const original = w.mgr.listSessions().find((s) => s.id === targetSession)!
    await w.mgr.send(targetSession, askFrame(w.caller.name, 'old task'), undefined, { sessionId: caller, name: 'Old caller' })
    handleOf(targetSession)!.answer('old history')
    w.store.upsertSession({ ...original, name: 'Asked by consumer · 10:00', askedBy: caller })
    if (ownerState !== 'live') await w.mgr.trashSession(caller)
    if (ownerState === 'purged') await w.mgr.purgeSession(caller)
    await w.mgr.disposeAll()
    w.mgr = new SessionManager(w.store, w.adapters, (e) => w.events.push(e), undefined, join(w.target.path, 'test-worktrees'))
    const restored = w.mgr.listSessions().find((s) => s.id === targetSession)!
    expect(restored.askedBy).toBeUndefined()
    expect(restored.name).toBe('Asked by consumer · 10:00')
    expect(w.store.loadMessages(targetSession, 10)).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ text: 'old history' }) }))
    expect(w.store.listSessions().find((s) => s.id === targetSession)?.askedBy).toBeNull()
  })

  it('refuses every cross-project child creation even under auto', async () => {
    const caller = await w.callerSession()
    await w.mgr.updateSettings(caller, { permissionPreset: 'auto' })
    await expect(w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'codex', permissionPreset: 'auto', askedBy: caller })).rejects.toThrow('cannot create a session in another project')
  })

  it('without the person\'s consent, nothing is started in the other project and the model reads a refusal', async () => {
    const s = await w.callerSession()
    const p = w.mgr.askProject(s, { project: w.target.name, task: 'export the sprites' })
    await w.until(() => !!w.card(s))
    expect(w.card(s)!.detail).toMatchObject({ access: 'delegate', to: { name: w.target.name }, text: 'export the sprites' })
    w.mgr.respondApproval(s, w.card(s)!.requestId, 'deny')
    const r = await p
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('did not allow')
    expect(w.mgr.listSessions().filter((x) => x.projectId === w.target.id)).toHaveLength(1)
    expect(handleOf(targetSession)!.sent).toEqual([])
  })

  it('delivers to the only existing ordinary session and preserves its name, CLI, settings and provenance', async () => {
    w.store.setProjectDefaultTool(w.target.id, 'codex')
    w.store.setProjectToolDefaults(w.target.id, 'codex', { model: 'gpt-5.6-luna', effort: 'low' })
    const s = await w.callerSession()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const p = w.mgr.askProject(s, { project: w.target.name, task: 'export the sprites' })
    await w.until(() => delegatedIn(s).length === 1 && !!handleOf(delegatedIn(s)[0]!.id)?.sent.length)
    const d = delegatedIn(s)[0]!
    expect(d.projectId).toBe(w.target.id)
    expect(d.tool).toBe('codex')
    expect([d.model, d.effort]).toEqual(['gpt-5.6-luna', 'low'])
    expect(d.permissionPreset).toBe('normal')
    expect(d.name).toBe('Sprites')
    expect(d.askedBy).toBeUndefined()
    const h = handleOf(d.id)!
    expect(h.opts.cwd).toBe(w.target.path)
    // The task travels framed: who asks, and how the answer gets back
    expect(h.sent[0]).toContain(`A session in the project "${w.caller.name}" asks this project`)
    expect(h.sent[0]).toContain('export the sprites')
    // Shown in that session as sent by the caller, not by the person
    const asked = w.store.loadMessages(d.id, 10).find((m) => m.role === 'user')
    expect((asked?.payload as { from?: { sessionId: string } }).from?.sessionId).toBe(s)

    mkdirSync(join(w.target.path, 'out'))
    writeFileSync(join(w.target.path, 'out', 'a.png'), 'x')
    h.answer(`Exported 1 sprite: ${join(w.target.path, 'out', 'a.png')}`)
    const r = await p
    expect(r).toMatchObject({ ok: true, state: 'done', project: w.target.name, sessionId: d.id, readable: [join(w.target.path, 'out', 'a.png')], outside: [] })
    expect(r.ok && r.state === 'done' && r.answer).toContain('Exported 1 sprite')
  })

  it('makes the files the answer names readable to the caller, and only those', async () => {
    const s = await w.callerSession()
    const callerHandle = handleOf(s)!
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    mkdirSync(join(w.target.path, 'out'))
    writeFileSync(join(w.target.path, 'out', 'a.png'), 'x')
    writeFileSync(join(w.target.path, 'secret.env'), 'x')
    const p = w.mgr.askProject(s, { project: w.target.name, task: 'export' })
    await w.until(() => !!delegatedIn(s)[0] && !!handleOf(delegatedIn(s)[0]!.id)?.sent.length)
    expect(callerHandle.opts.mayRead?.(join(w.target.path, 'out', 'a.png'))).toBe(false)
    handleOf(delegatedIn(s)[0]!.id)!.answer(`Done: ${join(w.target.path, 'out', 'a.png')}`)
    await p
    expect(callerHandle.opts.mayRead?.(join(w.target.path, 'out', 'a.png'))).toBe(true)
    expect(callerHandle.opts.mayRead?.(join(w.target.path, 'secret.env'))).toBe(false)
    // The delegated session itself was given nothing
    expect(handleOf(delegatedIn(s)[0]!.id)!.opts.mayRead?.(join(w.target.path, 'out', 'a.png'))).toBe(false)
  })

  it('the next ask from the same caller goes to the same session, which keeps its context', async () => {
    const s = await w.callerSession()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const first = w.mgr.askProject(s, { project: w.target.name, task: 'export' })
    await w.until(() => !!delegatedIn(s)[0] && !!handleOf(delegatedIn(s)[0]!.id)?.sent.length)
    const d = delegatedIn(s)[0]!.id
    handleOf(d)!.answer('done')
    await first
    expect(w.mgr.listSessions().find((x) => x.id === d)?.state).toBe('waiting_input')
    const second = w.mgr.askProject(s, { project: w.target.name, task: 'fix the one that came out wrong' })
    await w.until(() => handleOf(d)!.sent.length === 2)
    handleOf(d)!.answer('fixed')
    expect(await second).toMatchObject({ ok: true, state: 'done', sessionId: d })
    expect(delegatedIn(s)).toHaveLength(1)
  })

  it('Stop on the caller stops the delegated turn, and the model reads that it was stopped', async () => {
    const s = await w.callerSession()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const p = w.mgr.askProject(s, { project: w.target.name, task: 'export' })
    await w.until(() => !!delegatedIn(s)[0] && !!handleOf(delegatedIn(s)[0]!.id)?.sent.length)
    const h = handleOf(delegatedIn(s)[0]!.id)!
    w.mgr.interrupt(s)
    const r = await p
    expect(h.interrupted).toBe(1)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('the person stopped the session that asked')
  })

  it('the call\'s own cancellation stops the delegated turn too', async () => {
    const s = await w.callerSession()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const ac = new AbortController()
    const p = w.mgr.askProject(s, { project: w.target.name, task: 'export' }, ac.signal)
    await w.until(() => !!delegatedIn(s)[0] && !!handleOf(delegatedIn(s)[0]!.id)?.sent.length)
    ac.abort()
    const r = await p
    expect(handleOf(delegatedIn(s)[0]!.id)!.interrupted).toBe(1)
    expect(!r.ok && r.error).toContain('cancelled')
  })

  it.each([
    ['claude', 'stop'], ['claude', 'cancel'], ['codex', 'stop'], ['codex', 'cancel'],
  ] as const)("%s: caller %s ends its wait without interrupting the person's running turn", async (tool, action) => {
    await w.mgr.switchTool(targetSession, tool)
    const caller = await autoCaller()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    await w.mgr.send(targetSession, 'person work')
    const h = handleOf(targetSession)!
    const ac = new AbortController()
    const asking = w.mgr.askProject(caller, { project: w.target.id, task: 'export', ifBusy: 'note' }, ac.signal)
    await w.until(() => h.sent.length === 2)
    const observer = await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool, permissionPreset: 'auto' })
    const observing = w.mgr.agentSession(observer.id, { sessionId: targetSession, action: 'wait' })
    if (action === 'stop') w.mgr.interrupt(caller)
    else ac.abort()
    const result = await asking
    expect(h.interrupted).toBe(0)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('left running') })
    expect(h.receipts).toHaveLength(1)
    expect(w.mgr.listSessions().find((s) => s.id === targetSession)?.state).toBe('working')
    // Ending this caller's wait must not end another session's observation or the note receipt.
    h.answer('person turn answer', false)
    let observed = false
    void observing.then(() => { observed = true })
    await Promise.resolve()
    expect(observed).toBe(false)
    h.answer('note answer')
    expect(await observing).toMatchObject({ ok: true, answer: 'note answer' })
  })

  it('an explicit stop of the target still interrupts a task that joined its running turn', async () => {
    const caller = await autoCaller()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    await w.mgr.send(targetSession, 'person work')
    const h = handleOf(targetSession)!
    const asking = w.mgr.askProject(caller, { project: w.target.id, task: 'export', ifBusy: 'note' })
    await w.until(() => h.sent.length === 2)
    const observer = await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'codex', permissionPreset: 'auto' })
    expect(await w.mgr.agentSession(observer.id, { sessionId: targetSession, action: 'stop' })).toMatchObject({ ok: true, state: 'stopped' })
    expect(h.interrupted).toBe(1)
    expect(await asking).toMatchObject({ ok: false, error: expect.stringContaining('stopped') })
  })

  it.each([false, true])('Stop after an ask bound leaves the target running (joined turn: %s)', async (joinedTurn) => {
    const caller = joinedTurn ? await autoCaller() : await w.callerSession()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    if (joinedTurn) await w.mgr.send(targetSession, 'person work')
    const h = handleOf(targetSession)!
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const asking = w.mgr.askProject(caller, { project: w.target.id, task: 'export', ...(joinedTurn ? { ifBusy: 'note' as const } : {}) })
    for (let n = 0; n < 50 && h.sent.length < (joinedTurn ? 2 : 1); n++) await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS)
    expect(await asking).toMatchObject({ ok: true, state: 'working' })
    vi.useRealTimers()
    w.mgr.interrupt(caller)
    expect(h.interrupted).toBe(0)
    expect(w.mgr.listSessions().find((s) => s.id === targetSession)?.state).toBe('working')
    h.answer('finished after the bound')
    expect(await w.mgr.askProject(caller, { project: w.target.id })).toMatchObject({ ok: true, state: 'done', answer: 'finished after the bound' })
  })

  it('Stop reaches an assigned idle target again while the caller waits after the bound', async () => {
    const caller = await w.callerSession()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const h = handleOf(targetSession)!
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const asking = w.mgr.askProject(caller, { project: w.target.id, task: 'export' })
    for (let n = 0; n < 50 && !h.sent.length; n++) await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS)
    expect(await asking).toMatchObject({ ok: true, state: 'working' })
    vi.useRealTimers()
    w.mgr.interrupt(caller)
    expect(h.interrupted).toBe(0)
    const waitingAgain = w.mgr.askProject(caller, { project: w.target.id })
    w.mgr.interrupt(caller)
    expect(await waitingAgain).toMatchObject({ ok: false, error: expect.stringContaining('the person stopped') })
    expect(h.interrupted).toBe(1)
  })

  it('a failed delegated turn comes back as an error naming the session and what to do', async () => {
    const s = await w.callerSession()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const p = w.mgr.askProject(s, { project: w.target.name, task: 'export' })
    await w.until(() => !!delegatedIn(s)[0] && !!handleOf(delegatedIn(s)[0]!.id)?.sent.length)
    const d = delegatedIn(s)[0]!.id
    handleOf(d)!.event({ type: 'error', sessionId: d, error: { code: 'internal', message: 'the extractor crashed', retryable: true } })
    const r = await p
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('the extractor crashed')
    expect(!r.ok && r.error).toContain(`[${d}]`)
  })

  it('past the bound it answers "still working", and a call with no task waits for the same turn', async () => {
    const s = await w.callerSession()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = w.mgr.askProject(s, { project: w.target.name, task: 'export' })
    for (let i = 0; i < 50 && !delegatedIn(s)[0]; i++) await vi.advanceTimersByTimeAsync(0)
    const d = delegatedIn(s)[0]!.id
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS)
    expect(await first).toMatchObject({ ok: true, state: 'working', sessionId: d })
    // A new task while that one runs is refused, pointing at the way to wait
    const busy = await w.mgr.askProject(s, { project: w.target.name, task: 'something else' })
    expect(!busy.ok && busy.error).toContain('no task to wait for it')
    const again = w.mgr.askProject(s, { project: w.target.name })
    await vi.advanceTimersByTimeAsync(0)
    handleOf(d)!.answer('done at last')
    vi.useRealTimers()
    const r = await again
    expect(r).toMatchObject({ ok: true, state: 'done', sessionId: d })
    expect(handleOf(d)!.sent).toHaveLength(1)
  })

  it('a turn the network stopped past the bound is told to the session that asked, which waits on nothing now (#698)', async () => {
    const s = await w.callerSession()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = w.mgr.askProject(s, { project: w.target.name, task: 'export' })
    for (let i = 0; i < 50 && !delegatedIn(s)[0]; i++) await vi.advanceTimersByTimeAsync(0)
    const d = delegatedIn(s)[0]!.id
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS)
    expect(await first).toMatchObject({ ok: true, state: 'working', sessionId: d })
    vi.useRealTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    handleOf(d)!.event({ type: 'error', sessionId: d, error: { code: 'internal', message: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", retryable: true } })
    const told = () => w.store.loadMessages(s, 50).map((m) => JSON.stringify(m.payload)).filter((t) => t.includes('[Centralu] The assigned work') && t.includes(d))
    await w.until(() => told().length === 1)
    expect(told()[0]).toContain('stopped before finishing: a network error ended its turn')
  })

  /*
   * Owner decision 2026-10-11 (#382, questions 2 and 3): an untrusted project cannot ask (attach_app's rule), and an
   * untrusted one can be asked, with the card saying so — the session opened there follows that trust.
   */
  it('a session in an untrusted project cannot ask another project: no card, nothing started', async () => {
    w.mgr.setProjectTrusted(w.caller.id, false)
    const s = await w.callerSession()
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const r = await w.mgr.askProject(s, { project: w.target.name, task: 'export the sprites' })
    expect(!r.ok && r.error).toContain("This session's project is not trusted, so it cannot ask another project")
    expect(w.card(s)).toBeUndefined()
    expect(w.mgr.listSessions().filter((x) => x.projectId === w.target.id)).toHaveLength(1)
    expect(handleOf(targetSession)!.sent).toEqual([])
  })

  it('asking into an untrusted project raises a card that says the target is not trusted; a trusted target is said to be', async () => {
    const s = await w.callerSession()
    const p = w.mgr.askProject(s, { project: w.target.name, task: 'export the sprites' })
    await w.until(() => !!w.card(s))
    expect(w.card(s)!.detail).toMatchObject({ access: 'delegate', to: { id: w.target.id, trusted: false } })
    w.mgr.respondApproval(s, w.card(s)!.requestId, 'deny')
    await p

    w.mgr.setProjectTrusted(w.target.id, true)
    const q = w.mgr.askProject(s, { project: w.target.name, task: 'export the sprites' })
    await w.until(() => !!w.card(s))
    expect(w.card(s)!.detail).toMatchObject({ to: { id: w.target.id, trusted: true } })
    w.mgr.respondApproval(s, w.card(s)!.requestId, 'deny')
    await q
  })

  it('refuses its own project, an unknown one (naming the others), and an ask from a session that was itself asked', async () => {
    const s = await w.callerSession()
    const own = await w.mgr.askProject(s, { project: w.caller.name, task: 'x' })
    expect(!own.ok && own.error).toContain("this session's own project")
    const unknown = await w.mgr.askProject(s, { project: 'nowhere', task: 'x' })
    expect(!unknown.ok && unknown.error).toContain(`The other projects are: ${w.target.name}`)

    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const p = w.mgr.askProject(s, { project: w.target.name, task: 'export' })
    await w.until(() => !!delegatedIn(s)[0] && !!handleOf(delegatedIn(s)[0]!.id)?.sent.length)
    const d = delegatedIn(s)[0]!.id
    w.store.setProjectConsent(w.target.id, w.caller.id, 'delegate')
    const back = await w.mgr.askProject(d, { project: w.caller.name, task: 'do it for me' })
    expect(!back.ok && back.error).toContain('cannot ask a project')
    handleOf(d)!.answer('done')
    await p
  })

  describe('what an ask rests on, read again once its card is answered', () => {
    it("withdraws the card when the caller's project loses trust: nothing is delivered, and the call reads why", async () => {
      const s = await w.callerSession()
      const p = w.mgr.askProject(s, { project: w.target.name, task: 'export the sprites' })
      await w.until(() => !!w.card(s))
      void w.mgr.setProjectTrusted(w.caller.id, false)
      expect(w.card(s)).toBeUndefined()
      expect(await p).toMatchObject({ ok: false, error: expect.stringContaining("This session's project is not trusted") })
      expect(handleOf(targetSession)!.sent).toEqual([])
    })

    it('refuses an approval that comes after the trust it rested on is gone', async () => {
      const s = await w.callerSession()
      const p = w.mgr.askProject(s, { project: w.target.name, task: 'export the sprites' })
      await w.until(() => !!w.card(s))
      // Trust taken away at the store, so only the read after the answer can see it
      w.store.setProjectTrusted(w.caller.id, false)
      w.mgr.respondApproval(s, w.card(s)!.requestId, 'allow')
      // Either the call settles or the task reaches the target, whichever comes first
      let settled = false
      void p.then(() => (settled = true))
      await w.until(() => settled || handleOf(targetSession)!.sent.length > 0)
      expect(handleOf(targetSession)!.sent).toEqual([])
      expect(await p).toMatchObject({ ok: false, error: expect.stringContaining("This session's project is not trusted") })
    })

    it('withdraws the card when the asked project is removed, and the call reads a clean refusal', async () => {
      const s = await w.callerSession()
      const p = w.mgr.askProject(s, { project: w.target.name, task: 'export the sprites' })
      await w.until(() => !!w.card(s))
      const removing = w.mgr.deleteProject(w.target.id)
      expect(w.card(s)).toBeUndefined()
      await removing
      expect(await p).toMatchObject({ ok: false, error: expect.stringContaining('was not reached') })
      expect(w.store.listProjectConsents()).toEqual([])
    })

    it('remembers nothing for a pair whose project was removed while "always" was being answered', async () => {
      const s = await w.callerSession()
      const p = w.mgr.askProject(s, { project: w.target.name, task: 'export the sprites' })
      await w.until(() => !!w.card(s))
      // Removed at the store, so the card is still up when the person answers it
      w.store.deleteProject(w.target.id)
      w.mgr.respondApproval(s, w.card(s)!.requestId, 'always')
      expect(await p).toMatchObject({ ok: false, error: expect.stringContaining('removed') })
      expect(w.store.listProjectConsents()).toEqual([])
    })
  })
})
