import type { MessageService, SendInput } from './messages.js'

/**
 * The message service of tests whose requests reach the orchestrator: on the person's word, as every request that reaches it is
 * (docs/plans/cited-requests.md). Each send cites the person's newest message (`freshWord` makes one at every call) unless the test says
 * `cite: false`; `cited-requests.test.ts` covers what happens without one.
 */
export function citing(service: MessageService): MessageService {
  return new Proxy(service, {
    get: (target, key) => (key === 'send' ? (sender: string, input: SendInput) => target.send(sender, { cite: true, ...input }) : Reflect.get(target, key, target)),
  })
}

/** `personSaid` for `citing`: a new message of the person's at every call, typed now */
export function freshWord(now: () => number): (sessionId: string) => { seq: number; ts: number } {
  let seq = 0
  return () => ({ seq: ++seq, ts: now() })
}
