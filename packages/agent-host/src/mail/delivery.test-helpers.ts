import { parseAddress } from './address.js'
import { MailDelivery, type MailDeliveryOptions, type MailInput, type MailSessions, type ReceiverState } from './delivery.js'
import { MessageService, type SendInput, type SendResult } from './messages.js'
import { world as messageWorld } from './messages.test-helpers.js'
import { MailTurns } from './turns.js'

/**
 * The message service, the turns and the delivery over one in-memory store, with a clock and a scheduler that move only when a test moves them
 * (docs/plans/mailbox.md §8). The sessions of `messages.test-helpers` (a, b in p1; c in p2; x, y in the untrusted px; orc; w, a's child)
 */
export function deliveryWorld(opts: { heartbeat?: number | null; delivery?: MailDeliveryOptions; keepOpen?: (sessionId: string) => boolean } = {}) {
  const base = messageWorld()
  const { store, clock, reach } = base
  const timers: { at: number; fn: () => void; id: number }[] = []
  let nextId = 1
  const states = new Map<string, ReceiverState>()
  const delivered: { sessionId: string; input: MailInput }[] = []
  const notes: { sessionId: string; text: string }[] = []
  const behaviour: { fail: Error | null; hold: Promise<void> | null; notAtRest: boolean } = { fail: null, hold: null, notAtRest: false }
  const lates: ((e: Error) => void)[] = []
  const sessions: MailSessions = {
    receiver: (id) => states.get(id) ?? { kind: 'ready', live: true, quiet: true },
    note: (sessionId, text) => void notes.push({ sessionId, text }),
    deliver: async (sessionId, input, late) => {
      delivered.push({ sessionId, input })
      if (late) lates.push(late)
      if (behaviour.hold) await behaviour.hold
      if (behaviour.fail) throw behaviour.fail
    },
  }
  const beat = { value: opts.heartbeat ?? null }
  // Filled once the turns exist: the service reads a session's turn through it
  const box: { turns?: MailTurns } = {}
  const mail = new MessageService(store.mailbox, reach, {
    hostId: 'hub-aaaaaaaa',
    now: () => clock.t,
    turn: (address) => {
      const party = parseAddress(address)
      return (party?.kind === 'session' && box.turns?.current(party.sessionId)) || null
    },
  })
  box.turns = new MailTurns(store.mailbox, {
    now: () => clock.t,
    ...(opts.keepOpen ? { keepOpen: opts.keepOpen } : {}),
    askerOf: (sessionId, messageId) => (sessionId === 'orc' ? store.mailbox.message(messageId)?.sender : undefined),
  })
  const mailTurns = box.turns
  const delivery = new MailDelivery(mail, store.mailbox, sessions, {
    now: () => clock.t,
    turns: mailTurns,
    heartbeat: { read: () => beat.value, write: (ms) => void (beat.value = ms) },
    schedule: (ms, fn) => {
      const id = nextId++
      timers.push({ at: clock.t + ms, fn, id })
      return () => {
        const i = timers.findIndex((t) => t.id === id)
        if (i >= 0) timers.splice(i, 1)
      }
    },
    ...opts.delivery,
  })
  /** Moves time on and runs what falls due, in order, letting each delivery finish */
  const advance = async (ms: number) => {
    const end = clock.t + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > end) break
      timers.shift()
      clock.t = Math.max(clock.t, next.at)
      next.fn()
      await settle()
    }
    clock.t = end
    await settle()
  }
  /** The session's turn ended (its tool said so): what `observe` hears */
  const endTurn = (sessionId: string, acted = true) => {
    if (acted) mailTurns.observe({ type: 'tool_call', sessionId } as never, false)
    mailTurns.observe({ type: 'turn_complete', sessionId } as never, true)
  }
  const to = (sessionId: string) => delivered.filter((d) => d.sessionId === sessionId)
  /** `send` with the clock moved on first, so a test's messages come in the order it wrote them */
  const send = (sender: string, input: Partial<SendInput> & { text: string }): SendResult => {
    clock.t += 10
    return mail.send(sender, { to: [], ...input })
  }
  return { ...base, mail, send, turns: mailTurns, states, delivered, notes, behaviour, lates, delivery, advance, timers, beat, endTurn, to }
}

export const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise<void>((r) => setImmediate(r))
}
