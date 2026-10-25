import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent } from '@cc/protocol'
import { AcpAdapter } from '../acp/adapter.js'
import { FakeAcpPeer, INIT_RESULT, type PeerScript } from '../acp/fake-peer.test-helpers.js'
import type { AcpProfile } from '../acp/profile.js'
import { loadRecording } from '../frames/replay.test-helpers.js'
import { centraluToolOfCall } from './index.js'

/**
 * A call to Centralu's own tools (the stdio bridge) is answered without a card, as Claude and Codex take the bridge (#1562
 * review: every call from Cursor was a raw-JSON card that could not be set to always). The request is Cursor's own, as
 * recorded on a temporary host (`recordings/cursor-agent-2026.10.22/centralu-tool.jsonl`, the `recall` tool).
 */

const RECORDED = loadRecording(fileURLToPath(new URL('../acp/recordings/cursor-agent-2026.10.22/centralu-tool.jsonl', import.meta.url)))
const REQUEST = RECORDED.frames.find((f) => f.dir === 'in' && f.msg?.method === 'session/request_permission')!.msg!.params as {
  toolCall: Record<string, unknown>
  options: unknown[]
}

class FakeAdapter extends AcpAdapter {
  readonly tool = 'fake'
}

const SID = 'ses-a'
const base: PeerScript = (method) => {
  if (method === 'initialize') return { result: INIT_RESULT }
  if (method === 'session/new') return { result: { sessionId: SID } }
  if (method === 'session/prompt') return { hold: true }
  return { result: null }
}

const profile: AcpProfile = {
  descriptor: { name: 'fake', label: 'Fake', mark: 'F', install: 'install it', login: 'log in' },
  capabilities: { approvals: true, contextUsage: 'none', resume: true, autoTitle: true } as AdapterCapabilities,
  surface: undefined as never,
  launch: async () => ({ command: 'fake', args: ['acp'] }),
  detect: async () => ({ tool: 'fake', installed: true, loggedIn: true, detail: '' }),
  installedVersion: async () => '0.0.1',
  centraluToolOf: centraluToolOfCall,
}

async function ask(title: unknown) {
  let peer: FakeAcpPeer | undefined
  const events: NormalizedEvent[] = []
  let carded = () => {}
  const card = new Promise<void>((resolve) => (carded = resolve))
  const emit = (e: NormalizedEvent) => {
    events.push(e)
    if (e.type === 'approval_request') carded()
  }
  const adapter = new FakeAdapter(profile, () => (peer = new FakeAcpPeer(base)), 60_000)
  const s = await adapter.createSession({ sessionId: 's1', cwd: '/work', permissionPreset: 'normal', projectTrusted: true }, emit)
  s.send('go')
  await peer!.next((m) => m.method === 'session/prompt')
  const answer = peer!.ask('session/request_permission', { ...REQUEST, sessionId: SID, toolCall: { ...REQUEST.toolCall, title } })
  return { answer, events, card, peer: peer! }
}

describe("Centralu's own tools from Cursor", () => {
  it('reads which tool the recorded request is, and no other server as ours', () => {
    expect(REQUEST.toolCall.title).toBe('centralu-recall: recall')
    expect(centraluToolOfCall({ title: 'centralu-recall: recall', kind: 'other' })).toBe('recall')
    expect(centraluToolOfCall({ title: 'github-search: search' })).toBeNull()
    expect(centraluToolOfCall({ title: 'centralu-recall: mail' })).toBeNull()
    expect(centraluToolOfCall({ title: 'Delete `x`' })).toBeNull()
    // A call that does something else under the same name is no MCP call
    expect(centraluToolOfCall({ title: 'centralu-recall: recall', kind: 'edit' })).toBeNull()
  })

  it('answers the recorded call allow-once with no card, under Normal', async () => {
    const { answer, events } = await ask(REQUEST.toolCall.title)
    expect(await answer).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    expect(events.some((e) => e.type === 'approval_request')).toBe(false)
  })

  it('still asks for a call to a server of the person’s own', async () => {
    const { events, card, peer } = await ask('github-search: search')
    await card
    expect(events.filter((e) => e.type === 'approval_request')).toHaveLength(1)
    peer.kill()
  })
})
