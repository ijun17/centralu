/**
 * The switch to the message tables (docs/plans/mailbox.md §16 M3a-host), over the host's own wiring (`hostMail`): what must hold when live mail moves,
 * and the seams between rules that the M2 review found misses at (D3 vs §7.6, delivery vs turns, turn end vs settling, an update's continue vs mail
 * turns, the host cap vs the person's words, the one hold vs a refused delegation). The last part is a seeded model of delivery, turns and settling.
 */
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { PERSON } from './address.js'
import { reportRecorder } from './delegation.js'
import { at, hostWorld, NOW } from './host-mail.test-helpers.js'
import { oldThread, type OldReceipt } from './v61.test-helpers.js'
import { PAIR_TURNS_PER_HOUR } from './rules.js'
import { turnsOf } from '../dev-services/store/mailbox-turns.test-helpers.js'

const A = at('a')
const B = at('b')
const C = at('c')
const X = at('x')
const ORC = at('orc')

let stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops) s()
  stops = []
})
const started = (w: ReturnType<typeof hostWorld>) => {
  w.afterReady()
  stops.push(w.stop)
  return w
}
const dbOf = (w: ReturnType<typeof hostWorld>) => (w.store as unknown as { db: Database.Database }).db

/** An older build's question to `b` in a thread, still pending in the v61 tables */
function oldQuestion(w: ReturnType<typeof hostWorld>, body = 'Is #12 still open?', receipt: Partial<OldReceipt> = {}) {
  const q = { id: 'hub-aaaaaaaa.m_01ARZ3NDEKTSV4RRFFQ69G5F01', threadId: 'hub-aaaaaaaa.t_01ARZ3NDEKTSV4RRFFQ69G5F01' }
  oldThread(w.store, { id: q.threadId, owner: A, subject: 'about #12', at: w.clock.t }, [{ id: q.id, sender: A, kind: 'question', body, receipts: [{ recipient: B, ...receipt }] }])
  return q
}
const oldReceipt = (w: ReturnType<typeof hostWorld>, id: string) =>
  dbOf(w).prepare<[string, string], { handled_at: number | null; delivered_at: number | null }>(`SELECT handled_at, delivered_at FROM mail_receipts WHERE message_id = ? AND recipient = ?`).get(id, B)

describe('pending thread mail across the switch (§6.3): at most once, nothing lost', () => {
  it('is moved at ready, delivered once, never awaited, and its old receipt says handled; the next ready moves nothing', async () => {
    const w = hostWorld()
    const q = oldQuestion(w)
    started(w)
    expect(w.row(q.id, B)).toMatchObject({ settled: 'legacy', deliveredAt: null })
    expect(oldReceipt(w, q.id)!.handled_at).not.toBeNull()
    await w.advance(2_000)
    await w.advance(1)
    expect(w.to('b')).toHaveLength(1)
    expect(w.to('b')[0]!.input.text).toContain(q.id)
    // A second ready (the next host start) finds nothing to move and sends nothing again
    w.stop()
    const again = hostWorld({ store: w.store, clock: w.clock })
    started(again)
    await again.advance(60_000)
    expect(again.delivered).toEqual([])
    expect(w.store.mailbox.recipients(q.id)).toHaveLength(1)
    // Never awaited: no reminder or cover reads it
    expect(w.store.mailbox.watchedTo(B)).toEqual([])
  })

  it('a move that fails midway leaves both sides as they were, the host still starts, and the next ready moves it once', async () => {
    const w = hostWorld()
    const q = oldQuestion(w)
    dbOf(w).exec(`CREATE TRIGGER crash AFTER INSERT ON mail_recipients BEGIN SELECT RAISE(ABORT, 'disk gone'); END`)
    started(w)
    expect(w.store.mailbox.message(q.id)).toBeUndefined()
    expect(oldReceipt(w, q.id)).toMatchObject({ handled_at: null, delivered_at: null })
    await w.advance(60_000)
    expect(w.delivered).toEqual([])
    w.stop()
    dbOf(w).exec(`DROP TRIGGER crash`)
    const next = started(hostWorld({ store: w.store, clock: w.clock }))
    await next.advance(2_000)
    expect(next.to('b')).toHaveLength(1)
    expect(oldReceipt(w, q.id)!.handled_at).not.toBeNull()
  })

  it('an answer delivered and not read yet is still unread after the switch, by the inbox and by its old thread', async () => {
    const w = hostWorld()
    const q = { id: 'hub-aaaaaaaa.m_01ARZ3NDEKTSV4RRFFQ69G5F02', threadId: 'hub-aaaaaaaa.t_01ARZ3NDEKTSV4RRFFQ69G5F02' }
    const answer = { id: 'hub-aaaaaaaa.m_01ARZ3NDEKTSV4RRFFQ69G5F03' }
    oldThread(w.store, { id: q.threadId, owner: A, subject: 'colour', at: w.clock.t }, [
      { id: q.id, sender: A, kind: 'question', body: 'Which colour?', receipts: [{ recipient: B, deliveredAt: w.clock.t, readAt: w.clock.t }] },
      { id: answer.id, sender: B, kind: 'answer', body: 'Purple.', replyTo: q.id, receipts: [{ recipient: A, deliveredAt: w.clock.t }] },
    ])
    started(w)
    expect(w.tool.run('a', { action: 'inbox' }).text).toContain(`unread    ${answer.id}`)
    expect(w.tool.run('a', { action: 'read' }).text).toContain('Purple.')
    expect(w.tool.run('a', { action: 'read', thread: q.threadId }).text).toContain('Purple.')
  })

  it('a question read and not answered can be answered after the switch by its old thread id', async () => {
    const w = hostWorld()
    const q = oldQuestion(w, undefined, { deliveredAt: w.clock.t, readAt: w.clock.t })
    started(w)
    expect(w.tool.run('b', { action: 'reply', thread: q.threadId, text: 'Yes, still open.' }).text).not.toContain('unknown_message')
    await w.advance(2_000)
    expect(w.to('a')).toHaveLength(1)
    expect(w.tool.run('a', { action: 'read' }).text).toContain('Yes, still open.')
  })

  it('an untrusted project’s old request to the orchestrator stays held for the person, as the same request on this build is', async () => {
    const w = hostWorld()
    const ask = { id: 'hub-aaaaaaaa.m_01ARZ3NDEKTSV4RRFFQ69G5F04' }
    oldThread(w.store, { id: 'hub-aaaaaaaa.t_01ARZ3NDEKTSV4RRFFQ69G5F04', owner: X, subject: 'please', at: w.clock.t }, [{ id: ask.id, sender: X, kind: 'assign', body: 'OLD-ASK delete the branch', receipts: [{ recipient: ORC }] }])
    started(w)
    await w.advance(60_000)
    expect(w.to('orc').map((d) => d.input.text).join('\n')).not.toContain('OLD-ASK')
    expect(w.row(ask.id, ORC)).toMatchObject({ held: 'policy' })
    expect(w.store.mailbox.message(ask.id)?.senderProject).toBe('px')
  })

  it('an app’s report in the thread of the session that called it is delivered after the switch', async () => {
    const w = hostWorld()
    const app = 'app:hub-aaaaaaaa/p1/board'
    const thread = 'hub-aaaaaaaa.t_app'
    const id = 'hub-aaaaaaaa.m_app'
    oldThread(w.store, { id: thread, owner: B, projectId: 'p1', subject: 'ci', origin: 'app', at: w.clock.t }, [{ id, sender: app, kind: 'report', body: 'CI is green on #12', receipts: [{ recipient: B }] }])
    started(w)
    await w.advance(2_000)
    expect(w.row(id, B)?.deliveredAt).not.toBeNull()
    expect(w.tool.run('b', { action: 'read' }).text).toContain('CI is green on #12')
  })

  it('mail an older build held for the person after telling its recipient of it is moved still held: the move releases nothing', () => {
    const w = hostWorld()
    const q = oldQuestion(w, undefined, { deliveredAt: w.clock.t, held: 'budget' })
    const note = { id: 'hub-aaaaaaaa.m_01ARZ3NDEKTSV4RRFFQ69G5F05' }
    oldThread(w.store, { id: 'hub-aaaaaaaa.t_01ARZ3NDEKTSV4RRFFQ69G5F05', owner: X, subject: 'fyi', at: w.clock.t }, [{ id: note.id, sender: X, kind: 'note', body: 'A note.', receipts: [{ recipient: B, deliveredAt: w.clock.t, held: 'policy' }] }])
    started(w)
    expect(w.row(q.id, B)).toMatchObject({ held: 'budget' })
    expect(w.row(note.id, B)).toMatchObject({ held: 'policy' })
  })
})

describe('an update’s stop and continue mid mail-started turn (§8.2 step 6, #1902)', () => {
  /** The orchestrator in the turn `a`'s request started, then the host stopped for an update and the next one took the turn up */
  async function continued(kept = true) {
    const first = started(hostWorld())
    const request = first.mail.send(A, { to: [ORC], text: 'please check CI', needsReply: true }).message.id
    await first.advance(2_000)
    expect(first.to('orc')).toHaveLength(1)
    const seq = first.turns.current('orc')!.turnSeq
    first.stop()
    const next = started(hostWorld({ store: first.store, clock: first.clock, kept: new Set(kept ? ['orc'] : []) }))
    return { first, next, request, seq }
  }

  it('keeps that turn’s row, cause and depth: no new mail_turns row, no host-cap count, no depth hop', async () => {
    const { next, request, seq } = await continued()
    expect(turnsOf(next.store, 'orc')).toEqual([expect.objectContaining({ turnSeq: seq, starterId: request, endedAt: null })])
    expect(next.turns.current('orc')).toMatchObject({ turnSeq: seq, starter: request, messageId: request, asker: A })
    // What the continued turn sends has the original turn's cause: an answer back to the asker keeps depth 0, a word on to another adds the one hop it would have
    next.clock.t += 10
    const answer = next.mail.send(ORC, { to: [], replyTo: request, text: 'CI is green' })
    next.clock.t += 10
    const onward = next.mail.send(ORC, { to: [C], text: 'please rerun the flaky job', needsReply: false })
    expect(answer.message).toMatchObject({ causeId: request, depth: 0 })
    expect(onward.message).toMatchObject({ causeId: request, depth: 1 })
    expect(next.turns.mailStartedSince(0)).toBe(1)
  })

  it('the request settles at the continued turn’s end, reported to the asker as its request turn', async () => {
    const { next, request } = await continued()
    next.endTurn('orc')
    const as = reportRecorder(next.service, next.store.mailbox, next.turns)('a', 'orc', { outcome: 'finished', body: 'x', then: 'review', delivery: 'wake' })
    expect(as).toBe('mailed')
    expect(next.row(request, ORC)!.settled).toBe('reported')
    expect(next.store.mailbox.reportsOn(request)[0]!.body).toContain('ended its turn on your request')
  })

  it('without the turn taken up (a stop that did not continue it) the row is closed lost and what is sent has no cause', async () => {
    const { next, request } = await continued(false)
    expect(turnsOf(next.store, 'orc')[0]).toMatchObject({ outcome: 'lost' })
    next.clock.t += 10
    expect(next.mail.send(ORC, { to: [], replyTo: request, text: 'late' }).message.causeId).toBeNull()
  })

  it('the person’s own Continue after their Stop is the person’s word: a turn of theirs, what it sends starts at depth 0 and the pair guard counts anew', async () => {
    const { next } = await continued()
    // The person's Stop ended the turn; their Continue starts one of theirs
    next.endTurn('orc')
    next.hooks.turnStarted!('orc', { by: 'person', added: false, cli: false, source: 'caller' })
    expect(next.turns.current('orc')).toMatchObject({ by: 'person', starter: null })
    next.clock.t += 10
    expect(next.mail.send(ORC, { to: [C], text: 'from the person’s turn', needsReply: false }).message).toMatchObject({ causeId: null, depth: 0 })
    expect(next.store.mailbox.lastPersonTurn('orc')).toBe(next.clock.t - 10)
  })
})

describe('the one hold and a refused delegation (§7.4, S15, S16)', () => {
  it('a session of an untrusted project: its message out is held, its delegation out is refused with S15; on trust the message goes in order and the caller gets one S16', async () => {
    const w = started(hostWorld())
    const held = w.mail.send(X, { to: [A], text: 'from px' })
    expect(held.held).toEqual([{ recipient: A, why: 'policy' }])
    const refusal = w.hooks.refusesDelegation!('x', { projectId: 'p1' }, { tool: 'start_agent', target: 'p1', text: 'build the thing\nand more' })
    expect(refusal).toBe(
      'Refused (untrusted_project): your project Pex is not trusted, so work you give outside it (to p1) waits for the person to trust Pex. Nothing was started. Centralu shows the person how, and tells you when Pex is trusted; give it again then.',
    )
    // Within its own project nothing is refused
    expect(w.hooks.refusesDelegation!('x', { sessionId: 'x' }, { tool: 'agent_session', target: 'xi', text: 'hi' })).toBeNull()
    await w.advance(60_000)
    expect(w.to('a')).toEqual([])
    expect(w.service.heldByProject()).toEqual([{ projectId: 'px', count: 1, refused: 1, recipients: [A, 'p1'] }])
    w.store.projects.setProjectTrusted('px', true)
    for (const r of w.service.trustChanged('px')) w.delivery.poke(r.slice(r.lastIndexOf('/') + 1))
    await w.advance(2_000)
    expect(w.to('a')).toHaveLength(1)
    expect(w.to('a')[0]!.input.text).toContain(held.message.id)
    const s16 = w.store.mailbox.feedOf(X, { limit: 10 }).filter((m) => m.facts.trusted)
    expect(s16).toHaveLength(1)
    expect(s16[0]!.body).toBe('Pex is trusted now. The calls refused for it can be given again: start_agent to p1 ("build the thing")')
    // Given again now, it is not refused
    expect(w.hooks.refusesDelegation!('x', { projectId: 'p1' }, { tool: 'start_agent', target: 'p1', text: 'build the thing' })).toBeNull()
  })
})

describe('the host cap and the person’s words (§7.5)', () => {
  it('a wake that carries the person’s words goes over the cap, and its turn is the person’s: it counts toward nothing and what it sends starts at depth 0', async () => {
    const w = started(hostWorld())
    const starter = w.mail.send(C, { to: [B], text: 'warm up', needsReply: false }).message.id
    for (let i = 0; i < 130; i++) w.store.mailbox.startTurn({ sessionId: i < 20 ? 'a' : 'c', turnSeq: 500 + i, messageId: null, starterId: starter, startedBy: 'mail', startedAt: w.clock.t })
    w.clock.t += 10
    const fromB = w.mail.send(B, { to: [A], text: 'a question', needsReply: true })
    await w.advance(2_000)
    const before = w.turns.mailStartedSince(0)
    expect(w.row(fromB.message.id, A)!.deliveredAt).toBeNull()
    w.mail.send(PERSON, { to: [A], text: 'please answer beta' })
    await w.advance(1)
    expect(w.row(fromB.message.id, A)!.deliveredAt).not.toBeNull()
    expect(w.turns.current('a')!.starter).not.toBe(fromB.message.id)
    expect(w.turns.mailStartedSince(0)).toBe(before)
    w.clock.t += 10
    expect(w.mail.send(A, { to: [C], text: 'on it', needsReply: false }).message.depth).toBe(0)
  })
})

describe('delivery and turns, turn end and settling', () => {
  it('a report that comes while the request it answers is open is delivered (#1683): no one-open rule', async () => {
    const w = started(hostWorld())
    w.mail.send(A, { to: [ORC], text: 'first ask' })
    await w.advance(2_000)
    const task = w.mail.task(ORC, A, { text: 'do it', origin: 'agent_session', delivered: true })
    w.clock.t += 10
    const second = w.mail.send(A, { to: [ORC], text: 'second ask' })
    expect(second.message.id).toBeTruthy()
    const r = w.mail.report(task.id, { outcome: 'finished', body: 'done' })
    expect('message' in r).toBe(true)
  })

  it('an orchestrator that ends a request turn without sending anything is not left owing it: the request row is settled', async () => {
    const w = started(hostWorld())
    const q = w.mail.send(A, { to: [ORC], text: 'can you?', needsReply: true })
    await w.advance(2_000)
    w.endTurn('orc')
    reportRecorder(w.service, w.store.mailbox, w.turns)('a', 'orc', { outcome: 'finished', body: 'x', then: 'review', delivery: 'wake' })
    expect(w.row(q.message.id, ORC)).toMatchObject({ settled: 'reported' })
    expect(w.store.mailbox.watchedTo(ORC)).toEqual([])
  })

  it('a host restarted mid-turn keeps the turn’s starter: what the turn sends after the restart has its cause and depth', async () => {
    const first = started(hostWorld())
    const q = first.mail.send(A, { to: [B], text: 'can you pass this to gamma?' })
    await first.advance(2_000)
    first.stop()
    const next = started(hostWorld({ store: first.store, clock: first.clock, kept: new Set(['b']) }))
    next.clock.t += 10
    expect(next.mail.send(B, { to: [C], text: 'from alpha', needsReply: false }).message).toMatchObject({ causeId: q.message.id, depth: 1 })
  })

  it('the pair guard counts no turn twice across a restart that took a turn up', async () => {
    const first = started(hostWorld())
    first.mail.send(A, { to: [B], text: 'ping' })
    await first.advance(2_000)
    first.stop()
    const next = started(hostWorld({ store: first.store, clock: first.clock, kept: new Set(['b']) }))
    expect(next.store.mailbox.pairTurnsSince(A, B, 0)).toBe(1)
    expect(next.turns.pairLoopSpent(A, B)).toBe(PAIR_TURNS_PER_HOUR < 1)
  })
})

// ── A seeded model of delivery, turns and settling ──

/** mulberry32: a small seeded generator, so a failing seed can be run again */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('a seeded model of delivery, turns and settling', () => {
  const PEOPLE = ['a', 'b', 'c', 'w']
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
    it(`seed ${seed}: no message is delivered twice, none is lost, held rows never go, and settled rows stay settled`, async () => {
      const r = rng(seed)
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
      const w = started(hostWorld())
      const settled = new Map<string, string>()
      const sentIds: { id: string; to: string }[] = []
      for (let step = 0; step < 60; step++) {
        const roll = r()
        const from = pick(PEOPLE)
        const to = pick(PEOPLE.filter((p) => p !== from))
        try {
          if (roll < 0.35) {
            const target = sentIds.filter((s) => s.to === from).at(-1)
            const sent = target && r() < 0.5 ? w.mail.send(at(from), { to: [], replyTo: target.id, text: `re ${step}`, needsReply: r() < 0.3 }) : w.mail.send(at(from), { to: [at(to)], text: `msg ${step}`, needsReply: r() < 0.6 })
            for (const row of w.store.mailbox.recipients(sent.message.id)) sentIds.push({ id: sent.message.id, to: row.recipient.slice(row.recipient.lastIndexOf('/') + 1) })
          } else if (roll < 0.45) {
            const t = w.mail.task(at(from), at(to), { text: `task ${step}`, origin: 'agent_session', delivered: false })
            sentIds.push({ id: t.id, to })
          } else if (roll < 0.6) {
            w.endTurn(pick(PEOPLE))
            for (const p of PEOPLE) w.delivery.poke(p)
          } else if (roll < 0.7) {
            w.states.set(pick(PEOPLE), r() < 0.5 ? { kind: 'busy', why: 'turn' } : { kind: 'ready', live: r() < 0.7, quiet: true })
          } else if (roll < 0.8) {
            const mine = w.store.mailbox.watchedTo(at(from))[0]
            if (mine) w.mail.done(at(from), mine.messageId)
          } else if (roll < 0.88) {
            const task = w.store.mailbox.newestTask(at(to), at(from))
            if (task) reportRecorder(w.service, w.store.mailbox, w.turns)(to, from, { outcome: r() < 0.3 ? 'paused' : 'finished', paused: 1, body: 'b', then: r() < 0.3 ? 'running' : 'review', delivery: 'wake' })
          }
        } catch {
          // A guard refused it (rate, pair rate, repeat): the model goes on
        }
        await w.advance(Math.floor(r() * 40_000))
        // Settled rows stay settled, with the same word
        for (const s of sentIds) {
          const row = w.row(s.id, at(s.to))
          if (!row) continue
          const key = `${s.id}|${s.to}`
          if (settled.has(key)) expect(row.settled, key).toBe(settled.get(key))
          if (row.settled !== null) settled.set(key, row.settled)
        }
      }
      // At the end everyone is at rest and poked: nothing due is left undelivered, and nothing was delivered twice
      for (const p of PEOPLE) {
        w.states.set(p, { kind: 'ready', live: true, quiet: true })
        w.endTurn(p)
      }
      for (let i = 0; i < 6; i++) {
        for (const p of PEOPLE) w.delivery.poke(p)
        await w.advance(61_000)
        for (const p of PEOPLE) w.endTurn(p)
      }
      const seen = new Map<string, number>()
      for (const d of w.delivered) {
        for (const id of d.input.text.match(/id="([^"]+)"/g) ?? []) seen.set(`${d.sessionId}|${id}`, (seen.get(`${d.sessionId}|${id}`) ?? 0) + 1)
      }
      for (const [key, n] of seen) {
        const [sessionId, raw] = key.split('|') as [string, string]
        const id = raw.slice(4, -1)
        // A message is told of again only while it is unread (a wake points at it again); one read whole is told once
        if (w.row(id, at(sessionId))?.readAt !== null && n > 1) {
          const row = w.row(id, at(sessionId))!
          expect(row.lastError === 'maybe_repeated' || row.readAt === null, `${key} delivered ${n} times`).toBe(true)
        }
      }
      for (const s of sentIds) {
        const row = w.row(s.id, at(s.to))
        if (!row || row.held !== null || row.readAt !== null || row.settled === 'withdrawn' || row.settled === 'gone') continue
        expect(row.deliveredAt, `${s.id} to ${s.to} was not delivered`).not.toBeNull()
      }
      // Every delivered row names a turn of its session that the delivery began, or none (quiet)
      for (const s of sentIds) {
        const row = w.row(s.id, at(s.to))
        if (row?.turnSeq == null) continue
        expect(turnsOf(w.store, s.to).some((t) => t.turnSeq === row.turnSeq), `${s.id} names turn ${row.turnSeq}`).toBe(true)
      }
      void NOW
    })
  }
})
