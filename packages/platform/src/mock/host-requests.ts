import type { HostRequest } from '@cc/protocol/client'
import type { HostRequestsPort } from '../ports/index.js'
import type { MockClock } from './clock.js'
import type { Emit } from './event-bus.js'

/** The host's requests from the limited credential (#1405), raised by a test (`raiseHostRequest`) and answered here */
export class HostRequestsMock {
  private readonly open: HostRequest[] = []
  /** For tests: every answer this window gave, in order */
  readonly hostRequestAnswers: { requestId: string; decision: 'allow' | 'deny' }[] = []
  private next = 0

  constructor(
    private readonly clock: MockClock,
    private readonly emit: Emit,
  ) {}

  /** For tests: a program asks, as the host's `host_request` event says it */
  raiseHostRequest(question: string, opts: { method?: string; client?: string | null; session?: string | null } = {}): string {
    const createdAt = this.clock.now()
    const request: HostRequest = {
      requestId: `hr-${++this.next}`,
      method: opts.method ?? 'trash.purge',
      question,
      client: opts.client ?? null,
      session: opts.session ?? null,
      createdAt,
      expiresAt: createdAt + 15 * 60_000,
    }
    this.open.push(request)
    this.emit({ type: 'host_request', request })
    return request.requestId
  }

  /** For tests: the program went away before an answer */
  withdrawHostRequest(requestId: string): void {
    const i = this.open.findIndex((r) => r.requestId === requestId)
    if (i < 0) return
    this.open.splice(i, 1)
    this.emit({ type: 'host_request_resolved', requestId, outcome: 'withdrawn' })
  }

  readonly requests: HostRequestsPort = {
    list: async () => this.open.map((r) => ({ ...r })),
    answer: async (requestId, decision) => {
      const i = this.open.findIndex((r) => r.requestId === requestId)
      if (i < 0) return { ok: false }
      this.open.splice(i, 1)
      this.hostRequestAnswers.push({ requestId, decision })
      this.emit({ type: 'host_request_resolved', requestId, outcome: decision === 'allow' ? 'allowed' : 'denied' })
      return { ok: true }
    },
  }
}
