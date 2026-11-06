import { describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent } from '@cc/protocol'
import { AcpAdapter } from './adapter.js'
import { FakeAcpPeer, INIT_RESULT, type PeerScript } from './fake-peer.test-helpers.js'
import type { AcpProfile } from './profile.js'
import { cursorProfile } from '../cursor-agent/index.js'

/**
 * #1569: a tool whose model's provider refuses a turn (a usage limit, a quota) may retry on its own and send no frame
 * meanwhile (OpenCode, measured: about 70 s of silence, then a JSON-RPC error). A profile that can tell from the tool's
 * stderr (`AcpToolShape.refusalOf`) cancels the tool at once so it stops retrying, and the turn ends with the provider's words.
 */

const SID = 'ses-a'

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
  // Only this session's own requests count (OpenCode's log also names a sub-agent's)
  shape: { refusalOf: (line, conversation) => (conversation === SID ? /^refused: (.+)$/.exec(line)?.[1] ?? null : null) },
}

const script: PeerScript = (method) => {
  if (method === 'initialize') return { result: INIT_RESULT }
  if (method === 'session/new') return { result: { sessionId: SID } }
  if (method === 'session/prompt') return { hold: true }
  return { result: null }
}

async function start(using: AcpProfile = profile) {
  const peers: FakeAcpPeer[] = []
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
  const adapter = new FakeAdapter(using, () => (peers.push(new FakeAcpPeer(script)), peers.at(-1)!), 60_000)
  const handle = await adapter.createSession({ sessionId: 's1', cwd: '/work', permissionPreset: 'normal', projectTrusted: true }, emit)
  return { peer: () => peers.at(-1)!, events, event, handle }
}

const isPrompt = (m: Record<string, unknown>) => m.method === 'session/prompt'
const isError = (e: NormalizedEvent) => e.type === 'error'

describe('a provider refusal the tool only retries quietly', () => {
  // OpenCode answers the cancel with end_turn (measured); the spec's answer is cancelled
  it.each(['end_turn', 'cancelled'])('cancels the tool at once and ends the turn with the provider’s words when it answers %s, before the next input starts', async (stopReason) => {
    const w = await start()
    w.handle.send('hello')
    await w.peer().next(isPrompt)
    // Said twice, as a retrying tool does: one cancel, one ending
    w.peer().stderr.write('noise\nrefused: Free usage limit reached\nrefused: Free usage limit reached\n')
    await w.peer().next((m) => m.method === 'session/cancel')
    w.handle.send('again')
    // The tool is still unwinding its turn: nothing ends, and the next input waits for it
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    expect(w.events.some(isError)).toBe(false)
    expect(w.peer().methods().filter((m) => m === 'session/prompt')).toHaveLength(1)
    w.peer().release('session/prompt', { result: { stopReason } })
    const err = await w.event(isError)
    expect(err).toMatchObject({ type: 'error', error: { code: 'internal', message: "Fake's model refused the turn: Free usage limit reached", retryable: false } })
    await w.peer().next((m) => isPrompt(m) && JSON.stringify(m).includes('again'))
    w.peer().release('session/prompt', { result: { stopReason: 'end_turn' } })
    await w.event((e) => e.type === 'turn_complete')
    expect(w.events.filter(isError)).toHaveLength(1)
    expect(w.peer().methods().filter((m) => m === 'session/cancel')).toHaveLength(1)
  })

  it('ends the turn as refused when the tool answers the cancel with an error', async () => {
    const w = await start()
    w.handle.send('hello')
    await w.peer().next(isPrompt)
    w.peer().stderr.write('refused: Free usage limit reached\n')
    await w.peer().next((m) => m.method === 'session/cancel')
    w.peer().release('session/prompt', { error: { code: -32603, message: 'Internal error: Free usage limit reached' } })
    expect(await w.event(isError)).toMatchObject({ error: { message: "Fake's model refused the turn: Free usage limit reached", retryable: false } })
  })

  it('answers a permission request that comes after the refusal as cancelled, with no card', async () => {
    const w = await start()
    w.handle.send('hello')
    await w.peer().next(isPrompt)
    w.peer().stderr.write('refused: Free usage limit reached\n')
    await w.peer().next((m) => m.method === 'session/cancel')
    const options = [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }]
    const answer = await w.peer().ask('session/request_permission', { sessionId: SID, options, toolCall: { toolCallId: 'call-1', kind: 'execute', title: 'ls', rawInput: { command: 'ls' } } })
    expect(answer).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(w.events.some((e) => e.type === 'approval_request')).toBe(false)
  })

  it('leaves a turn the person already stopped as stopped', async () => {
    const w = await start()
    w.handle.send('hello')
    await w.peer().next(isPrompt)
    w.handle.interrupt()
    await w.peer().next((m) => m.method === 'session/cancel')
    w.peer().stderr.write('refused: Free usage limit reached\n')
    w.peer().release('session/prompt', { result: { stopReason: 'cancelled' } })
    await w.event((e) => e.type === 'state_change' && e.state === 'waiting_input')
    expect(w.events.some(isError)).toBe(false)
    expect(w.peer().methods().filter((m) => m === 'session/cancel')).toHaveLength(1)
  })

  it('says nothing about a line with no turn running, or one that is not a refusal', async () => {
    const w = await start()
    w.peer().stderr.write('refused: Free usage limit reached\n')
    w.handle.send('hello')
    await w.peer().next(isPrompt)
    w.peer().stderr.write('some other line\n')
    w.peer().release('session/prompt', { result: { stopReason: 'end_turn' } })
    await w.event((e) => e.type === 'turn_complete')
    expect(w.events.some(isError)).toBe(false)
    expect(w.peer().methods()).not.toContain('session/cancel')
  })
})

/**
 * #1969: out of quota, Cursor (agent 2026.10.22, signed in) answers every prompt with the plain text "Upgrade your plan to
 * continue" and `end_turn`, with no error frame and nothing on stderr. The recording of that (`out-of-quota`, replayed in
 * `replay.test.ts`) is the whole-answer case as the agent sends it. The frames below stay hand-written for what no run can be
 * made to send: the answer chunked at other places, in other case, or as part of a longer answer.
 */
describe('a provider refusal that arrives as the turn’s whole answer (Cursor out of quota)', () => {
  const cursor: AcpProfile = { ...cursorProfile(), launch: async () => ({ command: 'agent', args: ['acp'] }), installedVersion: async () => '2026.10.22' }
  const say = (w: Awaited<ReturnType<typeof start>>, ...chunks: string[]) => {
    for (const text of chunks) w.peer().update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  }
  const answered = async (chunks: string[]) => {
    const w = await start(cursor)
    w.handle.send('hello')
    await w.peer().next(isPrompt)
    say(w, ...chunks)
    w.peer().release('session/prompt', { result: { stopReason: 'end_turn' } })
    await w.event((e) => e.type === 'error' || e.type === 'turn_complete')
    return w
  }

  it.each([[['Upgrade your plan', ' to continue']], [['  upgrade your PLAN to continue\n']]])('ends the turn as refused by the provider, in its words: %j', async (chunks) => {
    const w = await answered(chunks)
    expect(w.events.filter(isError)).toMatchObject([
      { error: { code: 'internal', message: `Cursor's model refused the turn: ${chunks.join('').trim()}`, retryable: false } },
    ])
    expect(w.events.some((e) => e.type === 'turn_complete')).toBe(false)
  })

  it('leaves an answer that only contains the sentence as an ordinary answer', async () => {
    const w = await answered(['The error reads "Upgrade your plan to continue" and comes from the billing page.'])
    expect(w.events.some(isError)).toBe(false)
    expect(w.events.some((e) => e.type === 'turn_complete')).toBe(true)
  })

  it('leaves a turn that answered more than the sentence as an ordinary answer', async () => {
    const w = await answered(['Upgrade your plan to continue', ' Done.'])
    expect(w.events.some(isError)).toBe(false)
  })

  it('leaves a turn the person already stopped as stopped', async () => {
    const w = await start(cursor)
    w.handle.send('hello')
    await w.peer().next(isPrompt)
    w.handle.interrupt()
    await w.peer().next((m) => m.method === 'session/cancel')
    say(w, 'Upgrade your plan to continue')
    w.peer().release('session/prompt', { result: { stopReason: 'end_turn' } })
    await w.event((e) => e.type === 'error' || e.type === 'turn_complete')
    expect(w.events.some(isError)).toBe(false)
  })
})
