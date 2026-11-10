import { describe, expect, it } from 'vitest'
import { createWebPlatform } from './index.js'

/** A socket that records what the window sends, and has answered the handshake */
class RecordingSocket {
  static last: RecordingSocket | null = null
  readyState = 0
  sent: { method?: string }[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    RecordingSocket.last = this
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as { method?: string })
  }
  close(): void {
    this.readyState = 3
  }
  ready(): void {
    this.readyState = 1
    this.onopen?.()
    this.onmessage?.({ data: JSON.stringify({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 0, streamEpoch: 'e' }) } as MessageEvent)
  }
}

/**
 * The window calls the Assistant's methods by their old names (#2133, docs/plans/assistant-rename.md §3.3): it can reach a
 * host older than step 3 (a keeper of an earlier release, or on Windows the data folder's `centralu serve`), which knows
 * only `orchestrator.*`. Every host answers the old names.
 */
describe("the window's calls to the Assistant", () => {
  it('use the names every host answers', async () => {
    const p = createWebPlatform({ token: 't', WebSocketImpl: RecordingSocket as unknown as typeof WebSocket })
    RecordingSocket.last!.ready()
    void p.agents.assistant().catch(() => {})
    void p.agents.assistantPeek().catch(() => {})
    void p.agents.configureAssistant('claude').catch(() => {})
    await Promise.resolve()
    const methods = RecordingSocket.last!.sent.map((f) => f.method).filter((m) => m !== undefined)
    expect(methods).toEqual(['orchestrator.get', 'orchestrator.peek', 'orchestrator.configure'])
    await p.dispose()
  })
})
