import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

/**
 * A tool switch or a fork that waits on the tool while the session is deleted (#839, item 13). Both read the session
 * once, waited (the new tool's check, the old process's close, the tool's fork), then wrote what they read: the deleted
 * session's row in the trash was rewritten with the new tool, or the fork's conversation, and the windows were told a
 * state for a session no longer there.
 */
describe('a session deleted while a switch or a fork waits (#839)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    await w.dispose()
  })

  const session = async () => {
    const id = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal' })).id
    w.adapters.get('claude')!.handles.get(id)!.externalId = 'ext-1'
    w.adapters.get('claude')!.handles.get(id)!.event({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'Ready.' })
    return id
  }
  /** Holds a promise the code under test waits on, until the returned function is called */
  const held = () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    return { gate, release }
  }

  it('a tool switch is refused, and the trashed row keeps its tool', async () => {
    const id = await session()
    const codex = w.adapters.get('codex')!
    const { gate, release } = held()
    const detect = codex.detect.bind(codex)
    let checking = false
    codex.detect = async () => {
      checking = true
      await gate
      return detect()
    }
    const switching = w.mgr.switchTool(id, 'codex')
    void switching.catch(() => {})
    await w.until(() => checking)
    await w.mgr.trashSession(id)
    const events = w.events.length
    release()
    await expect(switching).rejects.toMatchObject({ code: 'session_not_found' })
    expect(w.store.trashedSession(id)?.session.tool).toBe('claude')
    expect(w.events.slice(events).filter((e) => e.sessionId === id)).toEqual([])
  })

  it('a fork gives up, and the trashed row keeps its conversation', async () => {
    const id = await session()
    const claude = w.adapters.get('claude')!
    const { gate, release } = held()
    let forking = false
    Object.assign(claude, {
      forkConversation: async () => {
        forking = true
        await gate
        return 'ext-fork'
      },
    })
    const fork = w.mgr.forkConversation(id)
    await w.until(() => forking)
    await w.mgr.trashSession(id)
    release()
    expect(await fork).toMatchObject({ resumed: false })
    expect(w.store.trashedSession(id)?.session.externalId).toBe('ext-1')
  })
})
