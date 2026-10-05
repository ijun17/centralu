import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ASK_WAIT_MS, clipAnswer, pathsIn, readableGrants, underGrant } from './ask-project.js'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

/**
 * ask_project (#371 part B): a session in one project asks another project to do a task, and reads the answer
 * back — through the person's consent for the pair, in a visible session of the target project, with the files the
 * answer names made readable to the caller and nothing broader.
 */

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
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id) ?? w.adapters.get('codex')!.handles.get(id)
  const delegatedIn = (callerId: string) => w.mgr.listSessions().filter((s) => s.askedBy === callerId)

  it('without the person\'s consent, nothing is started in the other project and the model reads a refusal', async () => {
    const s = await w.callerSession()
    const p = w.mgr.askProject(s, { project: w.target.name, task: 'export the sprites' })
    await w.until(() => !!w.card(s))
    expect(w.card(s)!.detail).toMatchObject({ access: 'delegate', to: { name: w.target.name }, text: 'export the sprites' })
    w.mgr.respondApproval(s, w.card(s)!.requestId, 'deny')
    const r = await p
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('did not allow')
    expect(w.mgr.listSessions().filter((x) => x.projectId === w.target.id)).toEqual([])
  })

  it('opens a visible session in the target project, with its folder, default tool and the normal preset, marked as asked', async () => {
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
    expect(d.name).toMatch(new RegExp(`^Asked by ${w.caller.name} · \\d\\d:\\d\\d$`))
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
    expect(!back.ok && back.error).toContain('cannot ask a third')
    handleOf(d)!.answer('done')
    await p
  })
})
