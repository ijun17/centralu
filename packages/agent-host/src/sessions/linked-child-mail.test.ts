/**
 * Mail to a child this hub started on a linked machine (#2067): the mail tool sends it to that machine (item 2), and with no link to it the send
 * is refused at once as `link_down`, never as a session this host never had (`unknown`) or one in the archive (`gone`) while it is alive there.
 * The mailbox itself never writes to another computer's session (`elsewhere`). Delivery over a real link: links/linked-mail-across.test.ts.
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
const REFUSED = 'Refused (link_down): no machine m1 is linked to this computer, so nothing was sent.'
const ELSEWHERE = `${addr(CHILD.sessionId)} is on another computer, and only a session's mail tool sends mail there: nothing was written.`

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
  it('by its id or address goes to its machine, and with no link to it is refused at once, written nowhere', async () => {
    for (const to of [CHILD.sessionId, addr(CHILD.sessionId)]) {
      const sent = await m.hooks.tool!('h1', { action: 'send', to, text: 'one more thing' })
      expect(sent).toMatchObject({ isError: true, text: REFUSED })
    }
    expect(store.mailbox.postsSince(addr('h1'), 0)).toBe(0)
  })

  it('and the mailbox itself, asked for that address, refuses it as elsewhere, not as gone', () => {
    expect(() => m.service.send(addr('h1'), { to: [addr(CHILD.sessionId)], text: 'one more thing' })).toThrow(ELSEWHERE)
  })

  it('a session this hub never had goes to its machine too, which says whether it has it', async () => {
    expect((await m.hooks.tool!('h1', { action: 'send', to: 'm1.never', text: 'hello' })).text).toBe(REFUSED)
  })
})
