import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { NO_ANSWER, NO_WINDOW, UpdateApplyBroker } from './update-apply.js'

type Verdict = { ready: true; version?: string } | { ready: false; reason: string } | 'silent'

/**
 * Windows played by the test (#665). Each answers a request with its verdict, as the store does, and holds the ticket
 * it got; told to go with its own ticket it relaunches (counted) and reports, or closes before reporting.
 */
function host(verdicts: Verdict[], opts: { closeOnGo?: boolean; reportError?: string; answerMs?: number } = {}) {
  const events: NormalizedEvent[] = []
  const tickets = new Map<number, Map<string, string>>()
  const relaunched: number[] = []
  let open = verdicts.length
  const broker: UpdateApplyBroker = new UpdateApplyBroker({
    windows: () => open,
    answerMs: opts.answerMs ?? 1_000,
    outcomeMs: 1_000,
    push: (e) => {
      events.push(e)
      verdicts.forEach((v, i) => {
        const client = i + 1
        queueMicrotask(() => {
          if (e.type === 'update_apply_request' && v !== 'silent') {
            const { ticket } = broker.answer(client, { requestId: e.requestId, ...v })
            if (ticket) tickets.set(client, new Map([...(tickets.get(client) ?? []), [e.requestId, ticket]]))
          }
          if (e.type === 'update_apply_go' && tickets.get(client)?.get(e.requestId) === e.ticket) {
            relaunched.push(client)
            if (opts.closeOnGo) {
              open--
              broker.clientGone(client)
            } else broker.report(client, { requestId: e.requestId, ticket: e.ticket, ...(opts.reportError ? { error: opts.reportError } : {}) })
          }
        })
      })
    },
  })
  const close = (client: number) => {
    open--
    broker.clientGone(client)
  }
  return { broker, events, relaunched, tickets, close }
}

const allow = async () => null

describe('UpdateApplyBroker (#665)', () => {
  it('relaunches the one ready window, and reports the version it starts', async () => {
    const h = host([{ ready: true, version: '9.9.9' }])
    expect(await h.broker.apply(allow)).toEqual({ ok: true, version: '9.9.9' })
    expect(h.relaunched).toEqual([1])
  })

  it('two ready windows: only one is told to go', async () => {
    const h = host([{ ready: true }, { ready: true }])
    expect(await h.broker.apply(allow)).toMatchObject({ ok: true })
    expect(h.relaunched).toEqual([1])
    expect(h.events.filter((e) => e.type === 'update_apply_go')).toHaveLength(1)
  })

  it('a browser window that cannot relaunch beside a desktop one: the desktop one goes', async () => {
    const h = host([{ ready: false, reason: 'A window that cannot relaunch itself answered.' }, { ready: true }])
    expect(await h.broker.apply(allow)).toMatchObject({ ok: true })
    expect(h.relaunched).toEqual([2])
  })

  it('no window open: says so at once, asking nobody', async () => {
    const h = host([])
    let asked = false
    expect(await h.broker.apply(async () => ((asked = true), null))).toEqual({ ok: false, error: NO_WINDOW })
    expect(asked).toBe(false)
    expect(h.events).toEqual([])
  })

  it('nothing installed: the windows say why, and consent is never asked', async () => {
    const h = host([{ ready: false, reason: 'No update is installed to apply.' }, { ready: false, reason: 'No update is installed to apply.' }])
    let asked = false
    const out = await h.broker.apply(async () => ((asked = true), null))
    // The same reason from two windows is said once
    expect(out).toEqual({ ok: false, error: 'Nothing was relaunched. No update is installed to apply.' })
    expect(asked).toBe(false)
  })

  it('a window of an older build never answers: bounded, and says what to do instead', async () => {
    const h = host(['silent'], { answerMs: 50 })
    expect(await h.broker.apply(allow)).toEqual({ ok: false, error: NO_ANSWER })
  })

  it('consent refused: no window is told to go', async () => {
    const h = host([{ ready: true }])
    expect(await h.broker.apply(async () => 'The person did not allow it.')).toEqual({ ok: false, error: 'The person did not allow it.' })
    expect(h.events.some((e) => e.type === 'update_apply_go')).toBe(false)
    expect(h.relaunched).toEqual([])
  })

  it('asks again after consent: a window that stopped being ready in the meantime is not told to go', async () => {
    const verdicts: Verdict[] = [{ ready: true }]
    const h = host(verdicts)
    const out = await h.broker.apply(async () => {
      // The person pressed Apply now themselves while the card stood, so the window runs the new build now
      verdicts[0] = { ready: false, reason: 'The window already runs 9.9.9.' }
      return null
    })
    expect(out).toEqual({ ok: false, error: 'Nothing was relaunched. The window already runs 9.9.9.' })
    expect(h.relaunched).toEqual([])
  })

  it('the window closing after its go is the relaunch', async () => {
    const h = host([{ ready: true, version: '9.9.9' }], { closeOnGo: true })
    expect(await h.broker.apply(allow)).toEqual({ ok: true, version: '9.9.9' })
  })

  it("the window's refusal reaches the agent", async () => {
    const h = host([{ ready: true }], { reportError: 'Not relaunched: the keeper is too old.' })
    expect(await h.broker.apply(allow)).toEqual({ ok: false, error: 'Not relaunched: the keeper is too old.' })
  })

  it('a replayed request, a late answer and a stale or foreign report start nothing', async () => {
    const h = host([{ ready: true }])
    await h.broker.apply(allow)
    const request = h.events.find((e) => e.type === 'update_apply_request') as Extract<NormalizedEvent, { type: 'update_apply_request' }>
    // A reconnecting window answers the replayed request: the host is no longer asking
    expect(h.broker.answer(1, { requestId: request.requestId, ready: true })).toEqual({ ticket: null })
    // A report for a go that already settled, or from another connection, is dropped without throwing
    const go = h.events.find((e) => e.type === 'update_apply_go') as Extract<NormalizedEvent, { type: 'update_apply_go' }>
    h.broker.report(2, { requestId: go.requestId, ticket: go.ticket, error: 'late' })
    h.broker.report(1, { requestId: go.requestId, ticket: go.ticket, error: 'late' })
  })

  it('a host swap mid-apply: the next host knows no request, so a window answering it gets no ticket', () => {
    // The next host is a new broker with nothing waiting; the window's answer to the old host's request lands there
    const next = new UpdateApplyBroker({ windows: () => 1, push: () => {} })
    expect(next.answer(1, { requestId: 'from-the-old-host', ready: true })).toEqual({ ticket: null })
  })

  it('the last silent window closing ends the wait without the bound', async () => {
    const h = host(['silent'], { answerMs: 60_000 })
    const out = h.broker.probe()
    await Promise.resolve()
    h.close(1)
    expect(await out).toEqual({ ready: false, error: NO_WINDOW })
  })
})
