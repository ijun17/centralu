import { describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent } from '@cc/protocol'
import { AcpAdapter } from './adapter.js'
import { FakeAcpPeer, INIT_RESULT, type PeerScript } from './fake-peer.test-helpers.js'
import type { AcpProfile } from './profile.js'

/**
 * #1569: a tool whose model's provider refuses a turn (a usage limit, a quota) may retry on its own and send no frame
 * meanwhile (OpenCode, measured: about 70 s of silence, then a JSON-RPC error). A profile that can tell from the tool's
 * stderr (`AcpToolShape.refusalOf`) cancels the tool at once so it stops retrying, and the turn ends with the provider's words.
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
  shape: { refusalOf: (line) => /^refused: (.+)$/.exec(line)?.[1] ?? null },
}

const SID = 'ses-a'
const script: PeerScript = (method) => {
  if (method === 'initialize') return { result: INIT_RESULT }
  if (method === 'session/new') return { result: { sessionId: SID } }
  if (method === 'session/prompt') return { hold: true }
  return { result: null }
}

async function start() {
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
  const adapter = new FakeAdapter(profile, () => (peers.push(new FakeAcpPeer(script)), peers.at(-1)!), 60_000)
  const handle = await adapter.createSession({ sessionId: 's1', cwd: '/work', permissionPreset: 'normal', projectTrusted: true }, emit)
  return { peer: () => peers.at(-1)!, events, event, handle }
}

const isPrompt = (m: Record<string, unknown>) => m.method === 'session/prompt'
const isError = (e: NormalizedEvent) => e.type === 'error'

describe('a provider refusal the tool only retries quietly', () => {
  it('cancels the tool at once and ends the turn with the provider’s words when it answers, before the next input starts', async () => {
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
    w.peer().release('session/prompt', { result: { stopReason: 'end_turn' } })
    const err = await w.event(isError)
    expect(err).toMatchObject({ type: 'error', error: { code: 'internal', message: "Fake's model refused the turn: Free usage limit reached", retryable: false } })
    await w.peer().next((m) => isPrompt(m) && JSON.stringify(m).includes('again'))
    w.peer().release('session/prompt', { result: { stopReason: 'end_turn' } })
    await w.event((e) => e.type === 'turn_complete')
    expect(w.events.filter(isError)).toHaveLength(1)
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
