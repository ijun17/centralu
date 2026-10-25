import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { NormalizedEvent } from '@cc/protocol'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'
import { CodexRequests } from './server-requests.js'
import { permissionOptionsFor, appApprovalModeFor } from './launch-config.js'

/**
 * The `edits` preset on Codex (#1525): Codex has no approval mode that accepts patches and asks for commands, so the
 * adapter answers a file-change request itself when every change adds or updates a file inside the session's folder.
 * `CodexRequests` is driven with its notifications and requests as the app-server sends them (approvals.ts records the
 * measured shapes).
 */
/** The session's own client is a stand-in that keeps the handlers it was given, so a server request can be sent to the session */
const state = vi.hoisted(() => ({ onServerRequest: null as null | ((r: { id: number | string; method: string; params?: unknown }) => void), responses: [] as { id: number | string; result: unknown }[] }))
vi.mock('./client.js', () => ({
  CodexClient: class {
    constructor(handlers: { onServerRequest: NonNullable<typeof state.onServerRequest> }) {
      state.onServerRequest = handlers.onServerRequest
    }
    request(method: string): Promise<unknown> {
      return Promise.resolve(method === 'thread/start' || method === 'thread/resume' ? { thread: { id: 't1' } } : {})
    }
    notify(): void {}
    respond(id: number | string, result: unknown): void {
      state.responses.push({ id, result })
    }
    async dispose(): Promise<void> {}
  },
}))

let base: string
let folder: string
beforeEach(() => {
  base = tempRoot('codex-edits')
  folder = join(base, 'proj')
  mkdirSync(join(folder, 'src'), { recursive: true })
  mkdirSync(join(base, 'outside'))
})
afterEach(() => removeTree(base))

type Change = { path: string; kind: Record<string, unknown> }
const update = (path: string): Change => ({ path, kind: { type: 'update', move_path: null } })
const add = (path: string): Change => ({ path, kind: { type: 'add' } })
const remove = (path: string): Change => ({ path, kind: { type: 'delete' } })

/** What the session did with a request: the answers given to Codex and the cards raised */
async function run(editsFolder: string | null, changes: Change[], extra: Record<string, unknown> = {}) {
  const events: NormalizedEvent[] = []
  const answers: unknown[] = []
  const requests = new CodexRequests({
    sessionId: 's1',
    emit: (e) => events.push(e),
    respond: (_id, result) => answers.push(result),
    threadId: () => 't1',
    appServers: () => new Set(),
    ownServer: () => false,
    editsFolder: () => editsFolder,
  })
  requests.noteFileChange({ method: 'item/started', params: { threadId: 't1', item: { type: 'fileChange', id: 'i1', status: 'inProgress', changes: changes.map((c) => ({ ...c, diff: '@@' })) } } })
  requests.onServerRequest({ id: 7, method: 'item/fileChange/requestApproval', params: { threadId: 't1', turnId: 'u1', itemId: 'i1', reason: null, grantRoot: null, ...extra } })
  // The grant is checked on the disk; wait until the request was answered or a card went up
  for (let end = Date.now() + 20_000; answers.length === 0 && events.length === 0 && Date.now() < end; ) await new Promise((r) => setTimeout(r, 2))
  return { answers, cards: events.filter((e) => e.type === 'approval_request').length }
}

describe('the edits preset, Codex (#1525)', () => {
  it('accepts a patch that only adds or updates files inside the folder, with no card', async () => {
    const r = await run(folder, [update(join(folder, 'src', 'a.ts')), add(join(folder, 'src', 'b.ts'))])
    expect(r).toEqual({ answers: [{ decision: 'accept' }], cards: 0 })
  })

  it('asks for a delete, a move, a path outside the folder, and a protected name', async () => {
    for (const changes of [
      [remove(join(folder, 'src', 'a.ts'))],
      [{ path: join(folder, 'src', 'a.ts'), kind: { type: 'update', move_path: join(folder, 'src', 'b.ts') } }],
      [update(join(base, 'outside', 'x.ts'))],
      [update(join(folder, 'src', 'a.ts')), update(join(base, 'outside', 'x.ts'))],
      [update(join(folder, '.git', 'config'))],
      [update(join(folder, '.codex', 'config.toml'))],
      [],
    ]) {
      expect(await run(folder, changes), JSON.stringify(changes)).toEqual({ answers: [], cards: 1 })
    }
  })

  it('asks for a link inside the folder that leads out of it', async () => {
    symlinkSync(join(base, 'outside'), join(folder, 'link'), 'junction')
    expect(await run(folder, [update(join(folder, 'link', 'x.ts'))])).toEqual({ answers: [], cards: 1 })
  })

  it('asks when the request names extra access: a grant root or a reason', async () => {
    const inside = [update(join(folder, 'src', 'a.ts'))]
    expect(await run(folder, inside, { grantRoot: base })).toEqual({ answers: [], cards: 1 })
    expect(await run(folder, inside, { reason: 'write outside the sandbox' })).toEqual({ answers: [], cards: 1 })
  })

  it('asks under any other preset: normal and safe have no folder to grant', async () => {
    expect(await run(null, [update(join(folder, 'src', 'a.ts'))])).toEqual({ answers: [], cards: 1 })
  })

  it('does not accept a command: only a file-change request is granted', async () => {
    const events: NormalizedEvent[] = []
    const answers: unknown[] = []
    const requests = new CodexRequests({ sessionId: 's1', emit: (e) => events.push(e), respond: (_i, r) => answers.push(r), threadId: () => 't1', appServers: () => new Set(), ownServer: () => false, editsFolder: () => folder })
    requests.onServerRequest({ id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: 't1', turnId: 'u1', itemId: 'c1', command: 'rm -rf src', cwd: folder } })
    expect(answers).toEqual([])
    expect(events.filter((e) => e.type === 'approval_request')).toHaveLength(1)
  })

  it('leaves a request alone that Codex ended while the folder was being checked: no answer, no card that never closes', async () => {
    const events: NormalizedEvent[] = []
    const answers: unknown[] = []
    const requests = new CodexRequests({ sessionId: 's1', emit: (e) => events.push(e), respond: (_i, r) => answers.push(r), threadId: () => 't1', appServers: () => new Set(), ownServer: () => false, editsFolder: () => folder })
    const changes = [{ ...update(join(base, 'outside', 'x.ts')), diff: '@@' }] // would be a card
    requests.noteFileChange({ method: 'item/started', params: { threadId: 't1', item: { type: 'fileChange', id: 'i1', changes } } })
    requests.onServerRequest({ id: 7, method: 'item/fileChange/requestApproval', params: { threadId: 't1', turnId: 'u1', itemId: 'i1' } })
    requests.noteRequestEnded({ method: 'serverRequest/resolved', params: { threadId: 't1', requestId: 7 } })
    // The check reads the disk; give it far longer than it takes
    await new Promise((r) => setTimeout(r, 300))
    expect({ answers, cards: events.length }).toEqual({ answers: [], cards: 0 })
  })

  it('answers the older applyPatchApproval the same way: an update inside accepts, a delete asks', async () => {
    const ask = async (fileChanges: Record<string, unknown>) => {
      const events: NormalizedEvent[] = []
      const answers: unknown[] = []
      const requests = new CodexRequests({ sessionId: 's1', emit: (e) => events.push(e), respond: (_i, r) => answers.push(r), threadId: () => 't1', appServers: () => new Set(), ownServer: () => false, editsFolder: () => folder })
      requests.onServerRequest({ id: 9, method: 'applyPatchApproval', params: { conversationId: 't1', callId: 'c1', fileChanges } })
      for (let end = Date.now() + 20_000; answers.length === 0 && events.length === 0 && Date.now() < end; ) await new Promise((r) => setTimeout(r, 2))
      return { answers, cards: events.filter((e) => e.type === 'approval_request').length }
    }
    expect(await ask({ [join(folder, 'src', 'a.ts')]: { type: 'update', unified_diff: '@@', move_path: null } })).toEqual({ answers: [{ decision: 'accept' }], cards: 0 })
    expect(await ask({ [join(folder, 'src', 'a.ts')]: { type: 'delete', content: '' } })).toEqual({ answers: [], cards: 1 })
  })

  it('reads the preset live: lowering edits to normal takes effect at once, and raising it back too, with no new process', async () => {
    const { CodexAdapter } = await import('./index.js')
    state.responses.length = 0
    const events: NormalizedEvent[] = []
    const handle = await new CodexAdapter().createSession({ sessionId: 's1', cwd: folder, permissionPreset: 'edits' }, (e) => events.push(e))
    const announce = (id: string, path: string) => (handle as unknown as { onNotification(n: unknown): void }).onNotification({ method: 'item/started', params: { threadId: 't1', item: { type: 'fileChange', id, changes: [{ path, kind: { type: 'update', move_path: null }, diff: '@@' }] } } })
    const ask = async (id: string, path: string) => {
      announce(id, path)
      const before = { answers: state.responses.length, cards: events.filter((e) => e.type === 'approval_request').length }
      state.onServerRequest!({ id: 'srv-' + id, method: 'item/fileChange/requestApproval', params: { threadId: 't1', turnId: 'u1', itemId: id } })
      for (let end = Date.now() + 20_000; state.responses.length === before.answers && events.filter((e) => e.type === 'approval_request').length === before.cards && Date.now() < end; ) await new Promise((r) => setTimeout(r, 2))
      return state.responses.length > before.answers ? 'accepted' : 'card'
    }
    const file = join(folder, 'src', 'a.ts')
    expect(await ask('i1', file)).toBe('accepted')
    handle.setPermissionPreset!('normal')
    expect(await ask('i2', file)).toBe('card')
    handle.setPermissionPreset!('edits')
    expect(await ask('i3', file)).toBe('accepted')
    await handle.dispose()
  })

  it('launches as normal does, and its app tools follow the person\'s policy as normal\'s', () => {
    expect(permissionOptionsFor('edits')).toEqual(permissionOptionsFor('normal'))
    expect(permissionOptionsFor('edits')).toEqual({})
    expect(appApprovalModeFor('edits', 'never')).toBe('approve')
    expect(appApprovalModeFor('edits', 'on-request')).toBe('writes')
    expect(appApprovalModeFor('normal', 'never')).toBe('approve')
  })
})
