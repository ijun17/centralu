import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function world(script: PeerScript = base, opts: Partial<CreateSessionOpts> = {}, withProfile: AcpProfile = profile) {
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
  const adapter = new FakeAdapter(withProfile, spawn, 60_000)
  const start = () => adapter.createSession({ sessionId: 's1', cwd: '/work', permissionPreset: 'normal', projectTrusted: true, ...opts }, emit)
  return { peers, events, event, start, adapter }
}

const isPrompt = (m: Record<string, unknown>) => m.method === 'session/prompt'

const near = (n: number) => expect.closeTo(n, 6)

/** The cost each turn reports, one turn per running total the agent sends at its end */
async function turnCosts(w: ReturnType<typeof world>, s: Awaited<ReturnType<ReturnType<typeof world>['start']>>, totals: number[]) {
  const peer = w.peers.at(-1)!
  const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
  for (const [i, total] of totals.entries()) {
    s.send(`turn ${i}`)
    await peer.next((m) => isPrompt(m) && JSON.stringify(m).includes(`turn ${i}`))
    peer.update(SID, { sessionUpdate: 'usage_update', used: 1_000, size: 200_000, cost: { amount: total, currency: 'USD' } })
    peer.release('session/prompt', { result: { stopReason: 'end_turn', usage } })
    await w.event((e) => e.type === 'turn_complete' && w.events.filter((x) => x.type === 'usage_update').length === i + 1)
  }
  return w.events.flatMap((e) => (e.type === 'usage_update' ? [e.tokens.costUsd] : []))
}

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

  it('under Edits grants an edit inside the folder, and asks about a delete or a move there', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cc-acp-edits-')))
    try {
      const w = world(base, { cwd, permissionPreset: 'edits' })
      const s = await w.start()
      s.send('go')
      const peer = w.peers[0]!
      await peer.next(isPrompt)
      const options = [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }]
      const ask = (kind: string, path: string) =>
        peer.ask('session/request_permission', { sessionId: SID, options, toolCall: { toolCallId: `call-${kind}`, kind, title: kind, locations: [{ path: join(cwd, path) }] } })
      expect(await ask('edit', 'a.ts')).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } })
      void ask('delete', 'b.ts')
      void ask('move', 'c.ts')
      // A command always asks under Edits: once its card is up, the two before it have had theirs, or were granted
      void ask('execute', 'd.ts')
      await w.event((e) => e.type === 'approval_request' && e.detail.kind === 'command')
      const cards = w.events.flatMap((e) => (e.type === 'approval_request' ? [e.detail.kind === 'file_edit' ? e.detail.path.slice(-4) : e.detail.kind] : []))
      expect(cards).toEqual(['b.ts', 'c.ts', 'command'])
      s.interrupt()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('answers a question asked after Stop as cancelled, with no card, and sends the lost cancel again', async () => {
    const w = world()
    const s = await w.start()
    s.send('go')
    const peer = w.peers[0]!
    await peer.next(isPrompt)
    s.interrupt()
    const options = [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }]
    const answer = await peer.ask('session/request_permission', { sessionId: SID, options, toolCall: { toolCallId: 'call-1', kind: 'execute', title: 'ls', rawInput: { command: 'ls' } } })
    expect(answer).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(w.events.some((e) => e.type === 'approval_request')).toBe(false)
    expect(peer.methods().filter((m) => m === 'session/cancel')).toHaveLength(2)
  })

  it('logs a frame it cannot parse and goes on with the turn, rather than failing the running prompt', async () => {
    const w = world()
    const s = await w.start()
    s.send('go')
    const peer = w.peers[0]!
    await peer.next(isPrompt)
    peer.stdout.write('{"jsonrpc":"2.0","id":\n')
    peer.release('session/prompt', { result: { stopReason: 'end_turn' } })
    await w.event((e) => e.type === 'turn_complete' || e.type === 'error')
    expect(w.events.filter((e) => e.type === 'error')).toEqual([])
  })

  it('closes the calls a turn had open when the session is disposed mid-turn, so no card spins after a restart', async () => {
    const w = world()
    const s = await w.start()
    s.send('go')
    const peer = w.peers[0]!
    await peer.next(isPrompt)
    peer.update(SID, { sessionUpdate: 'tool_call', toolCallId: 'call-1', kind: 'execute', title: 'sleep 42', status: 'in_progress', rawInput: { command: 'sleep 42' } })
    await w.event((e) => e.type === 'tool_call')
    await s.dispose()
    expect(w.events.filter((e) => e.type === 'tool_result')).toMatchObject([{ callId: 'call-1', ok: false }])
  })

  describe('a tool whose /compact leaves no protocol frame', () => {
    const inferring: AcpProfile = { ...profile, infersCompaction: true }
    const end = { result: { stopReason: 'end_turn' } }

    /** One ordinary turn read at `before`, then `text` sent as given, read at `after` */
    async function compactAfter(text: string, sendOpts: { compact?: boolean }, withProfile: AcpProfile, before = 9_889, after = 429) {
      const w = world(base, {}, withProfile)
      const s = await w.start()
      const peer = w.peers[0]!
      s.send('first')
      await peer.next(isPrompt)
      peer.update(SID, { sessionUpdate: 'usage_update', used: before, size: 200_000 })
      peer.release('session/prompt', end)
      await w.event((e) => e.type === 'turn_complete')
      s.send(text, sendOpts)
      await peer.next((m) => isPrompt(m) && JSON.stringify(m).includes(text))
      peer.update(SID, { sessionUpdate: 'usage_update', used: after, size: 200_000 })
      peer.release('session/prompt', end)
      await w.event((e) => e.type === 'turn_complete' && w.events.filter((x) => x.type === 'turn_complete').length === 2)
      return w.events
    }

    it('marks a compaction at the end of the compact turn Centralu started, when the reading went down', async () => {
      const events = await compactAfter('/compact', { compact: true }, inferring)
      expect(events.filter((e) => e.type === 'compaction')).toEqual([{ type: 'compaction', sessionId: 's1', failed: false, trigger: 'manual' }])
      // Before the turn's end, so the ending event is the compact's
      expect(events.findIndex((e) => e.type === 'compaction')).toBeLessThan(events.findLastIndex((e) => e.type === 'turn_complete'))
    })

    it('marks none for the person typing /compact, a reading that did not go down, or a tool that does not infer', async () => {
      expect((await compactAfter('/compact', {}, inferring)).some((e) => e.type === 'compaction')).toBe(false)
      expect((await compactAfter('/compact', { compact: true }, inferring, 9_889, 9_950)).some((e) => e.type === 'compaction')).toBe(false)
      expect((await compactAfter('/compact', { compact: true }, profile)).some((e) => e.type === 'compaction')).toBe(false)
    })
  })

  it("says a compaction in protocol frames is manual inside Centralu's compact turn, and auto elsewhere", async () => {
    const w = world()
    const s = await w.start()
    const peer = w.peers[0]!
    for (const [text, opts] of [['go', {}], ['/compact', { compact: true }]] as const) {
      s.send(text, opts)
      await peer.next((m) => isPrompt(m) && JSON.stringify(m).includes(text))
      peer.update(SID, { sessionUpdate: 'compaction_update', compactionId: text, status: 'completed' })
      peer.release('session/prompt', { result: { stopReason: 'end_turn' } })
      await w.event((e) => e.type === 'turn_complete' && w.events.filter((x) => x.type === 'compaction').length === (text === 'go' ? 1 : 2))
    }
    expect(w.events.filter((e) => e.type === 'compaction').map((e) => e.type === 'compaction' && e.trigger)).toEqual(['auto', 'manual'])
  })

  it("carries a turn's spend to the next turn it reports when it ended with no usage to carry the cost (review of PR 3)", async () => {
    const w = world()
    const s = await w.start()
    const peer = w.peers[0]!
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
    for (const [text, total, withUsage] of [['one', 0.1, true], ['two', 0.25, false], ['three', 0.3, true]] as const) {
      s.send(text)
      await peer.next((m) => isPrompt(m) && JSON.stringify(m).includes(text))
      peer.update(SID, { sessionUpdate: 'usage_update', used: 1_000, size: 200_000, cost: { amount: total, currency: 'USD' } })
      peer.release('session/prompt', { result: { stopReason: 'end_turn', ...(withUsage ? { usage } : {}) } })
      await w.event((e) => e.type === 'turn_complete' && w.events.filter((x) => x.type === 'turn_complete').length === (text === 'one' ? 1 : text === 'two' ? 2 : 3))
    }
    const costs = w.events.flatMap((e) => (e.type === 'usage_update' ? [e.tokens.costUsd] : []))
    expect(costs).toHaveLength(2)
    expect(costs[1]).toBeCloseTo(0.2)
  })

  it("takes a turn's cost as what it added to the running total the agent sends, a new conversation's from 0", async () => {
    const kept: number[] = []
    const w = world(base, { runningCost: { last: 5, keep: (t) => kept.push(t) } })
    const s = await w.start()
    expect(await turnCosts(w, s, [0.1, 0.25])).toEqual([0.1, 0.15].map(near))
    expect(kept).toEqual([0, 0.1, 0.25])
  })

  it("keeps the total across a new process, so the first turn after a restart or a host swap has its cost (review of PR 3)", async () => {
    const kept: number[] = []
    const resumed = world(base, { resumeExternalId: SID, runningCost: { last: 0.1, keep: (t) => kept.push(t) } })
    expect(await turnCosts(resumed, await resumed.start(), [0.25])).toEqual([near(0.15)])
    expect(kept).toEqual([0.25])
    const unknown = world(base, { resumeExternalId: SID, runningCost: { last: null, keep: () => {} } })
    expect(await turnCosts(unknown, await unknown.start(), [0.25, 0.3])).toEqual([undefined, near(0.05)])
  })

  it('closes a process a previous host left (with its open calls), and opens the conversation again in a new one', async () => {
    const old = new FakeAcpPeer(base)
    let oldGone = false
    old.once('exit', () => (oldGone = true))
    const spawned: AgentProcess[] = []
    const goneAtSpawn: boolean[] = []
    const source: ProcessSource = {
      spawn: () => {
        goneAtSpawn.push(oldGone)
        const p = new FakeAcpPeer(base)
        spawned.push(p)
        return p
      },
      adopt: { process: old, openCalls: [{ callId: 'call-9', tool: 'Bash' }] },
    }
    const w = world(base, { processSource: source, resumeExternalId: SID })
    await w.start()
    expect(old.killed).toBe(true)
    // The new process loads the same conversation, so the old one is gone first
    expect(goneAtSpawn).toEqual([true])
    expect(w.peers).toHaveLength(0)
    expect((spawned[0] as FakeAcpPeer).methods()).toEqual(['initialize', 'session/load'])
    expect(w.events.filter((e) => e.type === 'tool_result')).toMatchObject([{ callId: 'call-9', ok: false }])
  })
})
