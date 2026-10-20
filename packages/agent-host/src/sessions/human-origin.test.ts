import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type { NormalizedEvent } from '@cc/protocol'
import { SessionManager } from './manager.js'
import type { ChildReports } from './child-reports.js'
import type { FakeAdapter } from './manager.test-helpers.js'
import { managerWorld } from './manager.test-helpers.js'
import type { createRpcHandler } from '../rpc.js'

/**
 * What the person types reaches the tool stamped as theirs (`InputOrigin`, mailbox plan slice 0): the tool's strict
 * `isHuman()` gates treat an unstamped user message as unattributed. Only the person's own input is stamped; a message
 * with a source (a caller's delivery, a report), an app's notice and words Centralu framed are not.
 */

let adapter: FakeAdapter
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>
let events: NormalizedEvent[]

beforeEach(() => {
  ;({ adapter, mgr, rpc, events } = managerWorld())
})

async function session() {
  const p = (await rpc('projects.add', { path: tmpdir() })) as { id: string; path: string }
  return (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
}

const human = { kind: 'human' }

describe('the person\'s input is stamped human', () => {
  it('a message sent from the screen (the composer, a slash command, Continue are all this call)', async () => {
    const s = await session()
    await rpc('agents.send', { sessionId: s.id, text: 'hello' })
    await rpc('agents.send', { sessionId: s.id, text: '/compact' })
    await rpc('agents.send', { sessionId: s.id, text: 'Continue where you stopped. Check what already happened before repeating a step.' })
    expect(adapter.last!.sent).toHaveLength(3)
    expect(adapter.last!.origins).toEqual([human, human, human])
  })

  it('a message to a session that has no process yet: woken first, then stamped', async () => {
    const s = await session()
    await mgr.sleepSession(s.id)
    await rpc('agents.send', { sessionId: s.id, text: 'wake up' })
    expect(adapter.last!.sent.at(-1)).toBe('wake up')
    expect(adapter.last!.origins.at(-1)).toEqual(human)
  })
})

describe('nothing else is stamped', () => {
  it("the first message of a new session: the UI's handoff opening quotes a note an agent wrote", async () => {
    const p = (await rpc('projects.add', { path: tmpdir() })) as { id: string; path: string }
    await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude', initialPrompt: 'start here, from the note' })
    expect(adapter.last!.sent).toEqual(['start here, from the note'])
    expect(adapter.last!.origins).toEqual([undefined])
  })

  it("a person's message with a line of Centralu's in front of it (the orchestrator's one-time root apps notice)", async () => {
    const s = await session()
    const apps = (mgr as unknown as { apps: { rootAppsNotice(id: string): string | null } }).apps
    const notice = vi.spyOn(apps, 'rootAppsNotice').mockReturnValueOnce('Your root apps are gone.')
    await rpc('agents.send', { sessionId: s.id, text: 'hello' })
    await rpc('agents.send', { sessionId: s.id, text: 'hello again' })
    expect(notice).toHaveBeenCalled()
    expect(adapter.last!.sent).toEqual(['[Centralu] Your root apps are gone.\n\nhello', 'hello again'])
    expect(adapter.last!.origins).toEqual([undefined, human])
  })

  it('another session\'s delivery, also with the person\'s flag passed along by mistake', async () => {
    const s = await session()
    await mgr.send(s.id, 'do this', undefined, { sessionId: 'caller', name: 'Caller' })
    await mgr.send(s.id, 'and this', undefined, { sessionId: 'caller', name: 'Caller' }, true)
    expect(adapter.last!.origins).toEqual([undefined, undefined])
  })

  it('a send with no flag: a builder request or a Centralu frame the host sends on the person\'s click', async () => {
    const s = await session()
    await mgr.send(s.id, '[Centralu] A frame')
    expect(adapter.last!.origins).toEqual([undefined])
  })

  it('an app\'s notice, an inline app view\'s message, and a report', async () => {
    const s = await session()
    const app = { appId: 'project-board', projectId: null, name: 'Project board' }
    await mgr.appNotice(s.id, 'merged #77', app)
    await mgr.sendFromApp(s.id, 'from the view', app)
    await (mgr as unknown as { reports: ChildReports }).reports.tellSession(s.id, '[Centralu] The assigned work finished.', { sessionId: 'child', name: 'Child' }, true)
    expect(adapter.last!.sent).toHaveLength(3)
    expect(adapter.last!.origins).toEqual([undefined, undefined, undefined])
    expect(events.some((e) => e.type === 'user_message')).toBe(true)
  })
})
