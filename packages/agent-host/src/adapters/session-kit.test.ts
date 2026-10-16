import { describe, expect, it } from 'vitest'
import { PendingCards, adapterNotice, couldNotStop, undeliveredError } from './session-kit.js'

/*
 * The bookkeeping both adapters share (#428). The adapters' own tests run these through real handles; this pins the
 * rules each helper carries on its own.
 */

describe('PendingCards', () => {
  it('hands a card over once', () => {
    const cards = new PendingCards<string>()
    cards.set('a', 'card a')
    expect(cards.take('a')).toBe('card a')
    expect(cards.take('a')).toBeUndefined()
    expect(cards.size).toBe(0)
  })

  it('releases the cards a match picks, in the order raised, and leaves the rest open', () => {
    const cards = new PendingCards<{ thread: string }>()
    cards.set('a', { thread: 't1' })
    cards.set('b', { thread: 't2' })
    cards.set('c', { thread: 't1' })
    const closed: string[] = []
    cards.release((id) => closed.push(id), (card) => card.thread === 't1')
    expect(closed).toEqual(['a', 'c'])
    expect(cards.ids()).toEqual(['b'])
  })

  it('removes a card before closing it, so an answer from inside the close finds nothing', () => {
    const cards = new PendingCards<string>()
    cards.set('a', 'card a')
    const seen: (string | undefined)[] = []
    cards.release((id) => seen.push(cards.take(id)))
    expect(seen).toEqual([undefined])
    expect(cards.size).toBe(0)
  })
})

describe('what an adapter says itself', () => {
  it('a notice is its own message, never the id of an earlier one', () => {
    const a = adapterNotice('s', 'one')
    const b = adapterNotice('s', 'two')
    expect(a).toMatchObject({ type: 'message_delta', role: 'assistant', text: 'one' })
    expect(a.type === 'message_delta' && a.messageId).toMatch(/^centralu-notice-\d+$/)
    expect(a.type === 'message_delta' && b.type === 'message_delta' && a.messageId !== b.messageId).toBe(true)
  })

  it('undelivered messages and a Stop that did not land are errors with a way forward', () => {
    expect(undeliveredError('s', 2, 'were still queued when the session closed')).toEqual({
      type: 'error',
      sessionId: 's',
      error: { code: 'internal', message: '2 message(s) were still queued when the session closed and were not delivered — please resend', retryable: false },
    })
    expect(couldNotStop('s', new Error('gone'))).toEqual({
      type: 'error',
      sessionId: 's',
      error: { code: 'internal', message: 'Could not stop: gone', retryable: true },
    })
  })
})
