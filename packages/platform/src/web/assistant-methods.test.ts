import { describe, expect, it } from 'vitest'
import { createWebPlatform } from './index.js'

/** A socket that records what the window sends, and has answered the handshake */
class RecordingSocket {
  static last: RecordingSocket | null = null
  readyState = 0
  sent: { id?: string; method?: string }[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    RecordingSocket.last = this
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as { id?: string; method?: string })
  }
  close(): void {
    this.readyState = 3
  }
  ready(): void {
    this.readyState = 1
    this.onopen?.()
    this.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 0, streamEpoch: 'e' })
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)
  }
  /** Answers the last call as a host answers a method it does not have */
  unknown(): void {
    const call = this.sent.at(-1)!
    this.receive({ kind: 'res', id: call.id, ok: false, error: { code: 'internal', message: `Unknown method: ${call.method}. This Centralu host does not have it; the window may be from another build.`, retryable: false } })
  }
}

const methods = () => RecordingSocket.last!.sent.map((f) => f.method).filter((m) => m !== undefined)
const turn = () => new Promise((r) => setTimeout(r, 0))

/**
 * The window calls the Assistant's methods by their new names only (docs/plans/assistant-rename.md §3.4): every host it
 * can meet from #2532 on knows them, so a host that does not is not asked again under the old name.
 */
describe("the window's calls to the Assistant", () => {
  it('use the new names', async () => {
    const p = createWebPlatform({ token: 't', WebSocketImpl: RecordingSocket as unknown as typeof WebSocket })
    RecordingSocket.last!.ready()
    void p.agents.assistant().catch(() => {})
    void p.agents.assistantPeek().catch(() => {})
    void p.agents.configureAssistant('claude').catch(() => {})
    void p.agents.assistantSkills().catch(() => {})
    void p.agents.deleteAssistantSkill('x').catch(() => {})
    await Promise.resolve()
    expect(methods()).toEqual(['assistant.get', 'assistant.peek', 'assistant.configure', 'agents.assistantSkills', 'agents.deleteAssistantSkill'])
    await p.dispose()
  })

  it('pass on a host that does not know a new name, without asking under the old one', async () => {
    const p = createWebPlatform({ token: 't', WebSocketImpl: RecordingSocket as unknown as typeof WebSocket })
    const socket = RecordingSocket.last!
    socket.ready()
    const asked = p.agents.assistant()
    await turn()
    socket.unknown()
    await expect(asked).rejects.toThrow('Unknown method: assistant.get')
    await turn()
    expect(methods()).toEqual(['assistant.get'])
    await p.dispose()
  })
})
