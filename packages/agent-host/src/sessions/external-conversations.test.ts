import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, ExternalSession, SessionInfo } from '@cc/protocol'
import type { AgentAdapter, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { ExternalConversations, type ExternalConversationsHost } from './external-conversations.js'

/*
 * The tools' own conversations on their own (#428): which live session holds one, whether one is gone, and when the
 * catch-up marker is stamped. Import and catch-up run over the real manager (manager-resume.test.ts, history sync).
 */

let store: Store
let meta: Map<string, SessionInfo>
let handles: Map<string, SessionHandle>
let listed: ExternalSession[] | Error
let lists: number
let exclusive: boolean

const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, name: id, tool: 'claude', projectId: 'p1', externalId: null, importedFrom: null, ...extra }) as SessionInfo

function host(): ExternalConversationsHost {
  const adapter = {
    get capabilities() {
      return { exclusiveWriter: exclusive } as AdapterCapabilities
    },
    listExternalSessions: async () => {
      lists++
      if (listed instanceof Error) throw listed
      return listed
    },
  } as unknown as AgentAdapter
  return {
    store,
    meta,
    handles,
    adapters: new Map([['claude', adapter]]),
    emit: () => {},
    cwdFor: () => '/p',
  } as ExternalConversationsHost
}

beforeEach(() => {
  store = new Store()
  meta = new Map()
  handles = new Map()
  listed = []
  lists = 0
  exclusive = true
})
afterEach(() => store.close())

const row = (externalId: string) => ({ externalId, updatedAt: 1 }) as ExternalSession

describe('who holds a conversation', () => {
  it('a live session holding it by its id or the one it resumed from, never the asking one or one asleep', () => {
    meta.set('a', session('a', { externalId: 'x1' }))
    meta.set('b', session('b', { importedFrom: 'x2' }))
    meta.set('asleep', session('asleep', { externalId: 'x3' }))
    handles.set('a', {} as SessionHandle)
    handles.set('b', {} as SessionHandle)
    const ext = new ExternalConversations(host())
    expect(ext.holderOf('x1')?.id).toBe('a')
    expect(ext.holderOf('x2')?.id).toBe('b')
    expect(ext.holderOf('x1', 'a')).toBeNull()
    expect(ext.holderOf('x3')).toBeNull()
  })
})

describe('whether a conversation is gone (#28)', () => {
  it('gone only when the full list says so; an unreadable or cut-short list never blocks', async () => {
    const ext = new ExternalConversations(host())
    const m = session('a', { externalId: 'x1' })
    listed = [row('other')]
    expect(await ext.externalGone(m, '/one')).toBe(true)
    listed = [row('x1')]
    expect(await ext.externalGone(m, '/two')).toBe(false)
    listed = new Error('the tool did not answer')
    expect(await ext.externalGone(m, '/three')).toBe(false)
    listed = Array.from({ length: 200 }, (_, i) => row(`r${i}`))
    expect(await ext.externalGone(m, '/four')).toBe(false)
    expect(await ext.externalGone(session('none'), '/five')).toBe(false)
  })

  it('the resumed-from original still there counts, and a folder is listed once within its 30 s', async () => {
    const ext = new ExternalConversations(host())
    listed = [row('orig')]
    expect(await ext.externalGone(session('a', { externalId: 'new', importedFrom: 'orig' }), '/p')).toBe(false)
    expect(await ext.externalGone(session('b', { externalId: 'orig' }), '/p')).toBe(false)
    expect(lists).toBe(1)
  })
})

describe('the catch-up marker (#162)', () => {
  it('stamped for a tool that writes alone, for a session with a conversation of its own', () => {
    meta.set('a', session('a', { externalId: 'x1' }))
    meta.set('fresh', session('fresh'))
    const ext = new ExternalConversations(host())
    ext.stampExternalSynced('a')
    ext.stampExternalSynced('fresh')
    expect(store.settings.appSetting('external_synced:a')).toMatch(/^\d+$/)
    expect(store.settings.appSetting('external_synced:fresh')).toBeNull()
    exclusive = false
    meta.set('b', session('b', { externalId: 'x2' }))
    ext.stampExternalSynced('b')
    expect(store.settings.appSetting('external_synced:b')).toBeNull()
  })
})
