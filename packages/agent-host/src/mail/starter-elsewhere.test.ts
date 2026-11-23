/**
 * A machine's view of who started a session a hub's start_agent made there (`ReachHost.starterElsewhere`, #2520): the sender of the first start_agent
 * task to that session, when the session was started from a hub and that sender is a session of another computer. Over a real store.
 */
import { describe, expect, it } from 'vitest'
import type { MailRow } from '../dev-services/store/mailbox.js'
import { sessionAddress } from './address.js'
import { HOST, at, hostWorld } from './host-mail.test-helpers.js'

const HUB = 'hub-bbbbbbbb'

/** Stores a task from `sender` to `to`, each one later than the one before */
const taskIn = (w: ReturnType<typeof hostWorld>) => {
  let n = 0
  return (to: string, sender: string, origin: MailRow['origin']) =>
    w.store.mailbox.insert(
      {
        id: `${HOST}.m_01JZZZZZZZZZZZZZZZZZZZZZZ${++n}`, sender, senderProject: null, kind: 'task', body: 'work', origin, needsReply: true, replyTo: null, causeId: null,
        depth: 0, urgent: false, facts: {}, choices: null, subject: null, dedupeKey: null, legacyThread: null, createdAt: w.clock.t + n,
      },
      [{ recipient: to, recipientProject: 'p1', dueAt: w.clock.t }],
    )
}

describe("the parent a hub's start_agent gives a session on this machine (#2520)", () => {
  it('is the sender of the first start_agent task to it: not an earlier task of another origin, not a later start_agent', () => {
    const w = hostWorld({ fromHub: ['b', 'c'] })
    const task = taskIn(w)
    task(at('b'), sessionAddress(HUB, 'h9'), 'agent_session')
    task(at('b'), sessionAddress(HUB, 'h1'), 'start_agent')
    task(at('b'), sessionAddress(HUB, 'h2'), 'start_agent')
    expect(w.reach.parentOf(at('b'))).toBe(sessionAddress(HUB, 'h1'))
    // A session not started from a hub has none, whatever its tasks say
    task(at('a'), sessionAddress(HUB, 'h1'), 'start_agent')
    expect(w.reach.parentOf(at('a'))).toBeNull()
    // Nor does one whose first start_agent came from a session of this computer
    task(at('c'), at('x'), 'start_agent')
    task(at('c'), sessionAddress(HUB, 'h1'), 'start_agent')
    expect(w.reach.parentOf(at('c'))).toBeNull()
    w.stop()
  })

  // On the hub: a handoff gives the heir the start_agent task its original gave a child across a link, settled or not, and no one else's
  it("is the original's to give its heir in a handoff only when the original sent it", () => {
    const w = hostWorld()
    const task = taskIn(w)
    const mine = task(at('m1.x'), at('a'), 'start_agent')
    const others = task(at('m1.y'), at('w'), 'start_agent')
    w.store.mailbox.settle(mine.id, at('m1.x'), 'answered', w.clock.t)
    w.mail.handOver(at('a'), at('b'), 'all', [at('m1.x'), at('m1.y')])
    expect(w.store.mailbox.message(mine.id)?.sender).toBe(at('b'))
    expect(w.store.mailbox.message(others.id)?.sender).toBe(at('w'))
    expect(w.mail.takeMoves()).toEqual([{ from: at('a'), to: at('b'), ids: [mine.id] }])
    w.stop()
  })
})
