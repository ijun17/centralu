/**
 * Mail to a child this hub started on a linked machine (#2067, first slice): mail does not cross a link yet, so it is refused as `elsewhere`, with
 * the way that does reach the child, never as a session this host never had (`unknown`) or one in the archive (`gone`) while it is alive there.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionLiveDefaults } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import type { HostMail } from '../mail/host-mail.js'
import { scriptedAdapters } from '../links/scripted-agent.test-helpers.js'
import { addressOf as addr, wireHostMail } from './host-mail.test-helpers.js'
import { SessionManager } from './manager.js'
import { REMOTE_AGENTS_KEY } from './remote-agents.js'

const CHILD = { sessionId: 'm1.c1', callerId: 'h1', machineId: 'm1', machine: 'Box', name: 'Child', tool: 'claude', project: 'api', startedAt: 1, sent: 'TASK' }
const REFUSED = `Refused (elsewhere): ${addr(CHILD.sessionId)} is on another computer, and mail does not reach other computers yet: the session that started it there reaches it with agent_session send.`

let store: Store
let mgr: SessionManager
let m: HostMail

beforeEach(() => {
  store = new Store()
  store.sessions.upsertSession({
    id: 'h1', projectId: null, kind: 'worker', name: 'Parent', tool: 'claude', externalId: 'ext-h1', autoNamed: false,
    state: 'idle', lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null, verbosity: null,
    serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null,
    roleAppend: null, appId: null, ...sessionLiveDefaults(),
  })
  // The hub's record of the child it started on the linked machine, as a hub restart reads it back
  store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify([CHILD]))
  mgr = new SessionManager(store, scriptedAdapters(), () => {})
  m = wireHostMail(mgr, store)
})
afterEach(async () => {
  m.delivery.stop()
  await mgr.tenure.disposeAll()
  store.close()
})

describe('mail to a child on a linked machine (#2067)', () => {
  it('by its id or address is refused as elsewhere, naming what does reach it', () => {
    for (const to of [CHILD.sessionId, addr(CHILD.sessionId)]) {
      const sent = m.hooks.tool!('h1', { action: 'send', to, text: 'one more thing' })
      expect(sent).toMatchObject({ isError: true, text: REFUSED })
    }
  })

  it('and the mailbox itself, asked for that address, refuses it the same way, not as gone', () => {
    expect(() => m.service.send(addr('h1'), { to: [addr(CHILD.sessionId)], text: 'one more thing' })).toThrow(REFUSED.slice('Refused (elsewhere): '.length))
  })

  it('a session this hub never had is still unknown', () => {
    expect(m.hooks.tool!('h1', { action: 'send', to: 'm1.never', text: 'hello' }).text).toMatch(/^Refused \(unknown\)/)
  })
})
