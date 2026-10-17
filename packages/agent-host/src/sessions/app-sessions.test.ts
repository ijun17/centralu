import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionInfo } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { AppSessions, type AppSessionsHost } from './app-sessions.js'

/*
 * An app's builder slot on its own (#428, M4 C-3): the slot names the session, a session is the builder only while the
 * slot names it, and clearing for one session leaves a slot another has taken since. Creating builders and running app
 * agents go through the real manager (app-builder.test.ts, app-agents.test.ts).
 */

let store: Store
let meta: Map<string, SessionInfo>
let apps: AppSessions
const notes = { projectId: 'p1', appId: 'notes' }
const at = (id: string, extra: Partial<SessionInfo> = {}) => ({ id, appId: 'notes', projectId: 'p1', state: 'idle', ...extra }) as SessionInfo

beforeEach(() => {
  store = new Store()
  meta = new Map()
  apps = new AppSessions({ store, meta } as unknown as AppSessionsHost)
})
afterEach(() => store.close())

describe("an app's builder slot", () => {
  it('names the builder; a session of the same app is not the builder unless the slot names it', () => {
    meta.set('b1', at('b1'))
    meta.set('w1', at('w1'))
    apps.setBuilder(notes, 'b1')
    expect(apps.builderOf(notes)?.id).toBe('b1')
    expect(apps.builderRefOf(meta.get('b1')!)).toEqual(notes)
    expect(apps.builderRefOf(meta.get('w1')!)).toBeNull()
    expect(apps.builderRefOf(at('x', { appId: null }))).toBeNull()
  })

  it("clearing for one session leaves a slot another session has taken since", () => {
    apps.setBuilder(notes, 'b1')
    apps.setBuilder(notes, 'b2')
    apps.setBuilder(notes, null, 'b1')
    expect(JSON.parse(store.settings.appSetting('apps.builders')!)).toEqual({ 'p1/notes': 'b2' })
    apps.setBuilder(notes, null, 'b2')
    expect(JSON.parse(store.settings.appSetting('apps.builders')!)).toEqual({})
  })

  it('a slot naming a session of another app, or none, gives no builder; an unreadable slot reads as empty', () => {
    meta.set('b1', at('b1', { appId: 'other' }))
    apps.setBuilder(notes, 'b1')
    expect(apps.builderOf(notes)).toBeNull()
    store.settings.setAppSetting('apps.builders', 'not json')
    expect(apps.builderOf(notes)).toBeNull()
    apps.setBuilder({ projectId: null, appId: 'todo' }, 'u1')
    expect(JSON.parse(store.settings.appSetting('apps.builders')!)).toEqual({ '_user/todo': 'u1' })
    // JSON that is not a map (an older or broken write) reads as empty too, and the next write replaces it
    store.settings.setAppSetting('apps.builders', '"x"')
    apps.setBuilder(notes, 'b9')
    expect(JSON.parse(store.settings.appSetting('apps.builders')!)).toEqual({ 'p1/notes': 'b9' })
  })

  it('busy while its builder is in a turn', () => {
    meta.set('b1', at('b1', { state: 'working' }))
    apps.setBuilder(notes, 'b1')
    expect(apps.builderBusy(notes)).toBe(true)
    meta.get('b1')!.state = 'idle'
    expect(apps.builderBusy(notes)).toBe(false)
  })
})
