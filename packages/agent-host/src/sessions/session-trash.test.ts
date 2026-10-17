import { describe, expect, it } from 'vitest'
import type { Store } from '../dev-services/store.js'
import { SessionTrash, type SessionTrashHost } from './session-trash.js'
import type { WorktreeSessions } from './worktree-sessions.js'

/*
 * The trash's own rules (#428): a session is deleted once however often it is asked, a cleanup never rides on a plain
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

describe('the trash itself', () => {
  it('emptying goes on past a failure and says which', async () => {
    const store = { trash: { listTrash: () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }] } } as unknown as Store
    const trash = trashWith({ store })
    trash.purgeSession = async (id: string) => {
      if (id === 'b') throw new Error('the folder is in use')
    }
    expect(await trash.emptyTrash()).toEqual({ purged: 2, failed: [{ sessionId: 'b', name: 'B', error: 'the folder is in use' }] })
  })

  it('reading a session that is not in the trash says so', async () => {
    const trash = trashWith({ store: { trash: { isTrashed: () => false } } as unknown as Store })
    await expect(trash.readTrashed('s', 10)).rejects.toThrow('Not in the trash: s')
  })
})

describe('a restore or purge while the delete still runs (#839)', () => {
  it('is refused: the delete has put the session in the trash, and its last steps are still to come', async () => {
    const worktrees = { worktreeCleanup: new Map<string, string>() } as unknown as WorktreeSessions
    const trash = trashWith({ worktrees })
    let finish!: () => void
    // The store has moved it to the trash and is dropping its index in chunks; the deleted event is still to come
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
