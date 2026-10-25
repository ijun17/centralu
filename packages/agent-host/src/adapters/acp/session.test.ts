import { describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent } from '@cc/protocol'
import type { AgentProcess, CreateSessionOpts, ProcessSource } from '../contract.js'
import { AcpAdapter } from './adapter.js'
import { FakeAcpPeer, INIT_RESULT, type PeerScript } from './fake-peer.test-helpers.js'
import type { AcpProfile } from './profile.js'

/**
 * What the adapter does with frames a real tool cannot be made to send on cue (docs/plans/acp-adapter.md §10.3). Every
 * wait here is for an event or a frame, never for time.
 */

class FakeAdapter extends AcpAdapter {
  readonly tool = 'fake'
}

const profile: AcpProfile = {
  descriptor: { name: 'fake', label: 'Fake', mark: 'F', install: 'install it', login: 'log in' },
  capabilities: { approvals: true, contextUsage: 'exact', resume: true, autoTitle: true } as AdapterCapabilities,
  surface: undefined as never,
  launch: async () => ({ command: 'fake', args: ['acp'] }),
  detect: async () => ({ tool: 'fake', installed: true, loggedIn: true, detail: '' }),
  installedVersion: async () => '0.0.1',
}

const SID = 'ses-a'
const base: PeerScript = (method) => {
  if (method === 'initialize') return { result: INIT_RESULT }
  if (method === 'session/new') return { result: { sessionId: SID } }
  if (method === 'session/load') return { result: {} }
  if (method === 'session/prompt') return { hold: true }
  return { result: null }
}

function world(script: PeerScript = base, opts: Partial<CreateSessionOpts> = {}) {
  const peers: FakeAcpPeer[] = []
  const spawn = () => {
    const p = new FakeAcpPeer(script)
    peers.push(p)
    return p
  }
  const events: NormalizedEvent[] = []
  const waiting: { pick(e: NormalizedEvent): boolean; resolve(e: NormalizedEvent): void }[] = []
  const emit = (e: NormalizedEvent) => {
    events.push(e)
    for (const w of [...waiting]) if (w.pick(e)) {
      waiting.splice(waiting.indexOf(w), 1)
      w.resolve(e)
    }
  }
  const event = (pick: (e: NormalizedEvent) => boolean) => {
    const seen = events.find(pick)
    return seen ? Promise.resolve(seen) : new Promise<NormalizedEvent>((resolve) => waiting.push({ pick, resolve }))
  }
  const adapter = new FakeAdapter(profile, spawn, 60_000)
  const start = () => adapter.createSession({ sessionId: 's1', cwd: '/work', permissionPreset: 'normal', projectTrusted: true, ...opts }, emit)
  return { peers, events, event, start, adapter }
}

const isPrompt = (m: Record<string, unknown>) => m.method === 'session/prompt'

describe('the ACP session against a scripted agent', () => {
  it('never calls authenticate, and says the tool is not logged in', async () => {
    const w = world((method) => (method === 'session/new' ? { error: { code: -32000, message: 'Authentication required' } } : base(method, {}, null as never)))
    await expect(w.start()).rejects.toMatchObject({ code: 'not_logged_in' })
    expect(w.peers[0]!.methods()).toEqual(['initialize', 'session/new'])
  })

  it('reports a conversation it cannot load, and does not start a new one in its place', async () => {
    const w = world((method) => (method === 'session/load' ? { error: { code: -32002, message: 'Session not found' } } : base(method, {}, null as never)), { resumeExternalId: 'gone' })
    await expect(w.start()).rejects.toThrow(/Session not found/)
    expect(w.peers[0]!.methods()).not.toContain('session/new')
  })

  it('sends the cancel again when the agent goes on with the turn, and the next turn is not taken for stopped', async () => {
    let cancels = 0
    const w = world((method) => {
      if (method === 'session/cancel') {
        cancels++
        // The first cancel came before the agent's turn had begun, and it was lost; the second one stops it
        if (cancels === 2) w.peers[0]!.release('session/prompt', { result: { stopReason: 'cancelled' } })
        return { result: null }
      }
      return base(method, {}, null as never)
    })
    const s = await w.start()
    s.send('first')
    await w.peers[0]!.next(isPrompt)
    s.interrupt()
    w.peers[0]!.update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still going' } })
    await w.event((e) => e.type === 'state_change' && e.state === 'waiting_input')
    expect(cancels).toBe(2)
    s.send('second')
    await w.peers[0]!.next((m) => isPrompt(m) && JSON.stringify(m).includes('second'))
    w.peers[0]!.release('session/prompt', { result: { stopReason: 'end_turn' } })
    await w.event((e) => e.type === 'turn_complete')
    expect(w.events.filter((e) => e.type === 'state_change' && e.state === 'waiting_input').map((e) => e.type === 'state_change' && e.reason)).toEqual(['interrupted'])
  })

  it('takes a compaction from protocol frames only: its marker, its summary and a failed one', async () => {
    const w = world()
    const s = await w.start()
    s.send('go')
    const peer = w.peers[0]!
    await peer.next(isPrompt)
    peer.update(SID, { sessionUpdate: 'compaction_update', compactionId: 'k1', status: 'in_progress' })
    peer.update(SID, { sessionUpdate: 'compaction_summary_chunk', compactionId: 'k1', content: { type: 'text', text: 'The summary.' } })
    peer.update(SID, { sessionUpdate: 'compaction_update', compactionId: 'k1', status: 'completed' })
    peer.update(SID, { sessionUpdate: 'compaction_update', compactionId: 'k2', status: 'failed', error: 'Not enough messages' })
    peer.release('session/prompt', { result: { stopReason: 'end_turn' } })
    await w.event((e) => e.type === 'turn_complete')
    expect(w.events.filter((e) => e.type === 'compaction')).toMatchObject([
      { failed: false, reason: 'The summary.' },
      { failed: true, reason: 'Not enough messages' },
    ])
  })

  it('reads the context share from usage_update, and drops the zero a cancelled turn reads', async () => {
    const w = world()
    const s = await w.start()
    s.send('go')
    const peer = w.peers[0]!
    await peer.next(isPrompt)
    peer.update(SID, { sessionUpdate: 'usage_update', used: 0, size: 200_000 })
    peer.update(SID, { sessionUpdate: 'usage_update', used: 11_176, size: 200_000 })
    peer.update(SID, { sessionUpdate: 'something_new', x: 1 })
    peer.release('session/prompt', { result: { stopReason: 'end_turn' } })
    await w.event((e) => e.type === 'turn_complete')
    expect(w.events.filter((e) => e.type === 'context_update')).toEqual([{ type: 'context_update', sessionId: 's1', used: 11_176, window: 200_000, exactness: 'exact' }])
  })

  it('says a process that ended while idle went to sleep, and one that ended in a turn crashed', async () => {
    const idle = world()
    await idle.start()
    idle.peers[0]!.exit(0)
    expect(await idle.event((e) => e.type === 'session_live')).toMatchObject({ live: false, reason: 'asleep' })

    const busy = world()
    const s = await busy.start()
    s.send('go')
    await busy.peers[0]!.next(isPrompt)
    busy.peers[0]!.exit(1)
    expect(await busy.event((e) => e.type === 'error')).toMatchObject({ error: { code: 'adapter_crashed' } })
  })

  it('closes a process a previous host left (with its open calls), and opens the conversation again in a new one', async () => {
    const old = new FakeAcpPeer(base)
    const spawned: AgentProcess[] = []
    const source: ProcessSource = {
      spawn: () => {
        const p = new FakeAcpPeer(base)
        spawned.push(p)
        return p
      },
      adopt: { process: old, openCalls: [{ callId: 'call-9', tool: 'Bash' }] },
    }
    const w = world(base, { processSource: source, resumeExternalId: SID })
    await w.start()
    expect(old.killed).toBe(true)
    expect(w.peers).toHaveLength(0)
    expect((spawned[0] as FakeAcpPeer).methods()).toEqual(['initialize', 'session/load'])
    expect(w.events.filter((e) => e.type === 'tool_result')).toMatchObject([{ callId: 'call-9', ok: false }])
  })
})
