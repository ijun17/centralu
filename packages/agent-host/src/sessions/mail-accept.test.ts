/**
 * A wake counts as delivered when the tool took it, not when the write returned (#1347, docs/plans/mailbox.md §7.6.2): the
 * delivery waits for the tool to say so, and a failure before that is a failure the mailbox tries again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InputObserver, SessionHandle } from '../adapters/contract.js'
import { MAIL_ACCEPT_MS, SessionEvents, type SessionEventsHost } from './session-events.js'

function world(handle: Partial<SessionHandle>) {
  const events: unknown[] = []
  const handles = new Map<string, SessionHandle>([['s1', { sessionId: 's1', ...handle } as SessionHandle]])
  const host = {
    restartPolicy: { deferredRestarts: new Map() },
    openSession: () => {},
    resuming: new Set<string>(),
    handles,
    resumeSession: async () => ({ resumed: true }),
    notBeingRemoved: () => {},
    requireHandle: (id: string) => handles.get(id),
    record: { closeStream: () => {} },
    cardRests: { turnAsked: () => {} },
  }
  const sessionEvents = new SessionEvents(host as unknown as SessionEventsHost)
  Object.assign(sessionEvents, { onEvent: (e: unknown) => void events.push(e) })
  return { sessionEvents, events }
}
const input = { text: 'mail', quiet: false, line: '✉ 1 message' }
const tick = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => vi.useRealTimers())

describe('handing a wake to a tool that tracks its inputs', () => {
  it('waits until the tool says it took it, passes the channel stamp, and writes the line only then', async () => {
    let observer!: InputObserver
    let origin: unknown
    const w = world({
      sendTracked: (_text, o, opts) => {
        observer = o!
        origin = opts?.origin
        return new Promise(() => {})
      },
    })
    let settled = false
    const delivery = w.sessionEvents.deliverMail('s1', input).then(() => (settled = true))
    await tick()
    expect(settled).toBe(false)
    expect(w.events).toEqual([])
    observer.accepted?.()
    await delivery
    expect(origin).toEqual({ kind: 'channel', server: 'centralu' })
    expect(w.events).toHaveLength(1)
  })

  it('fails, writing no line, when the tool failed it before it took it: the mailbox keeps the mail and tries again', async () => {
    let observer!: InputObserver
    const w = world({
      sendTracked: (_text, o) => {
        observer = o!
        return new Promise(() => {})
      },
    })
    const delivery = w.sessionEvents.deliverMail('s1', input)
    const refused = expect(delivery).rejects.toThrow('closed with it queued')
    await tick()
    observer.fail(new Error('the session closed with it queued'))
    await refused
    expect(w.events).toEqual([])
  })

  it('a failure after it was taken changes nothing: it was delivered', async () => {
    let observer!: InputObserver
    const w = world({
      sendTracked: (_text, o) => {
        observer = o!
        return new Promise(() => {})
      },
    })
    const delivery = w.sessionEvents.deliverMail('s1', input)
    await tick()
    observer.accepted?.()
    await delivery
    observer.fail(new Error('the turn failed'))
    expect(w.events).toHaveLength(1)
  })

  it('a tool that never says is taken as having taken it after a while, not sent again', async () => {
    vi.useFakeTimers()
    const w = world({ sendTracked: () => new Promise(() => {}) })
    let settled = false
    const delivery = w.sessionEvents.deliverMail('s1', input).then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(MAIL_ACCEPT_MS - 1_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    await delivery
    expect(w.events).toHaveLength(1)
  })

  it('a tool that fails it after the wait ran out is told to the mailbox, which puts the mail back; one that took it is not', async () => {
    vi.useFakeTimers()
    let observer!: InputObserver
    const w = world({
      sendTracked: (_text, o) => {
        observer = o!
        return new Promise(() => {})
      },
    })
    const late = vi.fn()
    const delivery = w.sessionEvents.deliverMail('s1', input, undefined, late)
    await vi.advanceTimersByTimeAsync(MAIL_ACCEPT_MS + 1_000)
    await delivery
    expect(late).not.toHaveBeenCalled()
    observer.fail(new Error('the session closed with it queued'))
    expect(late).toHaveBeenCalledTimes(1)
    expect(late).toHaveBeenCalledWith(expect.objectContaining({ message: 'the session closed with it queued' }))
    // Said once
    observer.fail(new Error('again'))
    expect(late).toHaveBeenCalledTimes(1)

    // The tool said it took it, though late: sending again could run the work twice
    const took = world({
      sendTracked: (_text, o) => {
        observer = o!
        return new Promise(() => {})
      },
    })
    const tookLate = vi.fn()
    const second = took.sessionEvents.deliverMail('s1', input, undefined, tookLate)
    await vi.advanceTimersByTimeAsync(MAIL_ACCEPT_MS + 1_000)
    await second
    observer.accepted?.()
    observer.fail(new Error('the turn failed'))
    expect(tookLate).not.toHaveBeenCalled()
  })

  it('a tool that cannot track has taken it when the write returns, as before', async () => {
    const sent: unknown[] = []
    const w = world({ send: (text, opts) => void sent.push([text, opts]) })
    await w.sessionEvents.deliverMail('s1', input)
    expect(sent).toEqual([['mail', { origin: { kind: 'channel', server: 'centralu' } }]])
    expect(w.events).toHaveLength(1)
  })
})
