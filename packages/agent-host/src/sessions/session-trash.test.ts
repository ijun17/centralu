import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { codeIntelligenceKey } from './tool-profiles.js'
import type { Store } from '../dev-services/store.js'
import { SessionTrash, type SessionTrashHost } from './session-trash.js'
import type { WorktreeSessions } from './worktree-sessions.js'

/*
 * The session archive's own rules (#428): a session is deleted once however often it is asked, a cleanup never rides on a plain
 * delete (#647), one restore or delete at a time, and emptying goes on past a failure. The deletion itself, restore and
 * purge run over the real manager and store (trash.test.ts, manager.test.ts).
 */

type Private = {
  trashSessionOnce(...a: unknown[]): Promise<void>
  trashOp<T>(id: string, run: () => Promise<T>): Promise<T>
}
const privates = (t: SessionTrash) => t as unknown as Private

function trashWith(host: Partial<SessionTrashHost>): SessionTrash {
  return new SessionTrash(host as SessionTrashHost)
}

describe('deleting', () => {
  it('two deletes at once share one deletion, and a cleanup cannot join one already running', async () => {
    const trash = trashWith({})
    let runs = 0
    let finish!: () => void
    privates(trash).trashSessionOnce = () => {
      runs++
      return new Promise<void>((r) => (finish = r))
    }
    const a = trash.trashSession('s')
    const b = trash.trashSession('s')
    await expect(trash.trashSession('s', true, false, undefined, true)).rejects.toThrow('The session is already being deleted without its recovery snapshot')
    finish()
    await Promise.all([a, b])
    expect(runs).toBe(1)
    expect(trash.trashing.has('s')).toBe(false)
  })
})

describe('one restore or delete at a time', () => {
  it('refuses a second operation on the session, and one during its worktree cleanup', async () => {
    const worktrees = { worktreeCleanup: new Map<string, string>() } as unknown as WorktreeSessions
    const trash = trashWith({ worktrees })
    let release!: () => void
    const first = privates(trash).trashOp('s', () => new Promise<void>((r) => (release = r)))
    await expect(privates(trash).trashOp('s', async () => {})).rejects.toThrow('That session is already being restored or deleted')
    release()
    await first
    await expect(privates(trash).trashOp('s', async () => 'ok')).resolves.toBe('ok')
    ;(worktrees.worktreeCleanup as Map<string, string>).set('s', '/w')
    await expect(privates(trash).trashOp('s', async () => {})).rejects.toThrow('That session is already being restored or deleted')
  })
})

describe('the session archive itself', () => {
  it('emptying goes on past a failure and says which', async () => {
    const store = { trash: { listTrash: () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }] }, subagentSteps: { listTrashed: () => [] } } as unknown as Store
    const trash = trashWith({ store })
    trash.purgeSession = async (id: string) => {
      if (id === 'b') throw new Error('the folder is in use')
    }
    expect(await trash.emptyTrash()).toEqual({ purged: 2, failed: [{ sessionId: 'b', name: 'B', error: 'the folder is in use' }] })
  })

  it('reading a session that is not in the session archive says so', async () => {
    const trash = trashWith({ store: { trash: { isTrashed: () => false } } as unknown as Store })
    await expect(trash.readTrashed('s', 10)).rejects.toThrow('Not in the session archive: s')
  })
})

describe('a restore or purge while the delete still runs (#839)', () => {
  it('is refused: the delete has put the session in the session archive, and its last steps are still to come', async () => {
    const worktrees = { worktreeCleanup: new Map<string, string>() } as unknown as WorktreeSessions
    const trash = trashWith({ worktrees })
    let finish!: () => void
    // The store has moved it to the session archive and is dropping its index in chunks; the deleted event is still to come
    privates(trash).trashSessionOnce = () => new Promise<void>((r) => (finish = r))
    const deleting = trash.trashSession('s')
    await expect(privates(trash).trashOp('s', async () => 'restored')).rejects.toThrow('That session is already being restored or deleted')
    finish()
    await deleting
    await expect(privates(trash).trashOp('s', async () => 'restored')).resolves.toBe('restored')
  })
})

describe('a delete while a restore still runs (#839 review)', () => {
  it('is refused: the restore makes the session live only at its end', async () => {
    const worktrees = { worktreeCleanup: new Map<string, string>() } as unknown as WorktreeSessions
    const trash = trashWith({ worktrees })
    let runs = 0
    privates(trash).trashSessionOnce = async () => {
      runs++
    }
    let finish!: () => void
    const restoring = privates(trash).trashOp('s', () => new Promise<void>((r) => (finish = r)))
    await expect(trash.trashSession('s')).rejects.toThrow('That session is already being restored or deleted')
    expect(runs).toBe(0)
    finish()
    await restoring
    await trash.trashSession('s')
    expect(runs).toBe(1)
  })
})

/*
 * What a purge lets go of, and what a restore puts right (a sample of hand mutations found none of these asserted).
 * The store is a recording stub: the real rows are the store's own tests.
 */
describe('purging a session for good', () => {
  let data = ''
  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), 'cc-purge-'))
    vi.stubEnv('CC_DATA_DIR', data)
  })
  afterEach(() => {
    rmSync(data, { recursive: true, force: true })
  })

  type Opts = { removeExternal?: boolean; externalId?: string | null; held?: boolean; worktree?: boolean; adapter?: boolean }
  function setup(id: string, o: Opts = {}) {
    const calls: string[] = []
    const deleteExternalConversation = vi.fn(async () => {})
    const session = {
      id, tool: 'claude', externalId: o.externalId === undefined ? 'ext-1' : o.externalId, importedFrom: null,
      worktree: o.worktree ? { path: join(data, 'gone-worktree'), branch: 'b' } : null,
    } as unknown as SessionInfo
    const record = { projectId: null, projectPath: o.worktree ? join(data, 'gone-repo') : null, removeExternal: o.removeExternal ?? false, removeWorktree: o.worktree ?? false }
    const host = {
      recoveryRepair: Promise.resolve(),
      worktrees: { worktreeCleanup: new Map() },
      meta: new Map<string, SessionInfo>(o.held ? [['other', { tool: 'claude', externalId: 'ext-1' } as SessionInfo]] : []),
      adapters: new Map<string, AgentAdapter>([['claude', (o.adapter === false ? {} : { deleteExternalConversation }) as unknown as AgentAdapter]]),
      restartPolicy: { forgetBackground: (i: string) => calls.push(`forgetBackground:${i}`) },
      sweepOrphanHandoffNotes: async () => {},
      forgetUsage: () => {},
      store: {
        trash: { trashedSession: () => ({ session, record }), purgeSession: async () => void calls.push('rows') },
        sessions: { sessionCwd: () => join(data, 'cwd') },
        settings: { deleteAppSetting: (k: string) => calls.push(`setting:${k}`) },
      },
    }
    return { trash: trashWith(host as unknown as Partial<SessionTrashHost>), calls, deleteExternalConversation }
  }

  it('lets go of its attachments, its settings key and its background state, and asks nothing of the tool by default', async () => {
    const id = randomUUID()
    const dir = join(data, 'attachments', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.png'), 'x')
    const { trash, calls, deleteExternalConversation } = setup(id)
    await trash.purgeSession(id)
    expect(existsSync(dir)).toBe(false)
    expect(calls).toEqual(['rows', `forgetBackground:${id}`, `setting:${codeIntelligenceKey(id)}`])
    expect(deleteExternalConversation).not.toHaveBeenCalled()
  })

  it('removes the tool conversation file when chosen, in the folder it ran in', async () => {
    const id = randomUUID()
    const { trash, deleteExternalConversation } = setup(id, { removeExternal: true })
    await trash.purgeSession(id)
    expect(deleteExternalConversation).toHaveBeenCalledWith('ext-1', join(data, 'cwd'))
  })

  it('has no file to remove when the session has no external id, however it was chosen', async () => {
    const id = randomUUID()
    const { trash, deleteExternalConversation } = setup(id, { removeExternal: true, externalId: null })
    await trash.purgeSession(id)
    expect(deleteExternalConversation).not.toHaveBeenCalled()
  })

  it('leaves the file alone while a live session holds the same conversation', async () => {
    const id = randomUUID()
    const { trash, deleteExternalConversation, calls } = setup(id, { removeExternal: true, held: true })
    await trash.purgeSession(id)
    expect(deleteExternalConversation).not.toHaveBeenCalled()
    expect(calls).toContain('rows')
  })

  it('stops, with the session still in the session archive, when the tool cannot delete its file', async () => {
    const id = randomUUID()
    const { trash, calls } = setup(id, { removeExternal: true, adapter: false })
    await expect(trash.purgeSession(id)).rejects.toThrow('claude does not support deleting its conversation file')
    expect(calls).not.toContain('rows')
  })

  it('is not an error when the worktree it was to remove is already gone', async () => {
    const id = randomUUID()
    const { trash, calls } = setup(id, { worktree: true })
    await expect(trash.purgeSession(id)).resolves.toBeUndefined()
    expect(calls).toContain('rows')
  })
})

describe('restoring a session', () => {
  function restoring(session: Partial<SessionInfo>, orchestratorId: string | null = null) {
    const upserted: SessionInfo[] = []
    const meta = new Map<string, SessionInfo>()
    const base = { id: 's', kind: 'session', worktree: null, ...session } as SessionInfo
    const host = {
      recoveryRepair: Promise.resolve(),
      worktrees: { worktreeCleanup: new Map() },
      meta,
      emit: () => {},
      // A session that comes back may take the mail that waited for it (#1347)
      mailPoke: () => {},
      store: {
        projects: { listProjects: () => [] },
        trash: { trashedSession: () => ({ session: base, record: { projectId: null } }), restoreSession: async () => base },
        sessions: { orchestratorId: () => orchestratorId, upsertSession: (s: SessionInfo) => upserted.push(s) },
        // A session started from a linked computer keeps its mark here (#1273); none of these was
        settings: { appSetting: () => null },
      },
    }
    return { trash: trashWith(host as unknown as Partial<SessionTrashHost>), upserted, meta }
  }

  it.each(['working', 'waiting_approval'] as const)('brings a session deleted %s back idle, saved so', async (state) => {
    const { trash, upserted, meta } = restoring({ state, waitingSince: 123 })
    const { session } = await trash.restoreSession('s')
    expect(session.state).toBe('idle')
    expect(session.waitingSince).toBeNull()
    expect(meta.get('s')?.state).toBe('idle')
    expect(upserted).toHaveLength(1)
    expect(upserted[0]).toMatchObject({ state: 'idle', waitingSince: null })
  })

  it('brings a session that was not mid-turn back as it was, without a rewrite', async () => {
    const { trash, upserted } = restoring({ state: 'error', waitingSince: null })
    const { session } = await trash.restoreSession('s')
    expect(session.state).toBe('error')
    expect(upserted).toEqual([])
  })

  it('refuses an orchestrator while another one is in place, and restores it when none is', async () => {
    const taken = restoring({ kind: 'orchestrator', state: 'idle' }, 'other')
    await expect(taken.trash.restoreSession('s')).rejects.toThrow('Another orchestrator is in place')
    expect(taken.meta.size).toBe(0)
    const free = restoring({ kind: 'orchestrator', state: 'idle' }, null)
    await expect(free.trash.restoreSession('s')).resolves.toBeDefined()
  })
})
