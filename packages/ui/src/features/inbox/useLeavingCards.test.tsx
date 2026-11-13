import { useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MailThreadRow } from '@cc/protocol/client'
import type { WaitingRow } from './inboxList.js'
import { useLeavingCards } from './useLeavingCards.js'

/*
 * The rows of the list are derived on every render (`arrangeInbox` over a clock that moves), so they are a new array each time with the same content. The hook once compared them
 * by identity during render: every pass set state, the render started again, and it never settled. A render of a component that makes its rows afresh on every pass shows it:
 * with the fix it takes one pass, and without it React gives up at its limit on render passes.
 */

const party = { address: 'person', kind: 'person', sessionId: null, name: null, state: null }
const thread = (id: string): MailThreadRow =>
  ({ id, subject: id, state: 'open', outcome: null, next: null, projectId: null, owner: party, assignee: null, unread: 1, held: 0, blocked: 0, ask: { id: `${id}-q`, sender: party, text: 'Which?', open: [`${id}-q`] }, createdAt: 0, updatedAt: 0, last: null })
const rows = (...ids: string[]): WaitingRow[] => ids.map((id) => ({ kind: 'mail', thread: thread(id) }))

describe('the cards on their way out (#2229)', () => {
  it('a list rebuilt on every pass with the same rows settles: a pass for the change that forced it and none of its own', () => {
    let passes = 0
    let seen: ReturnType<typeof useLeavingCards> = []
    function Probe() {
      passes += 1
      // A second pass, as the clock moving makes the Inbox render again, with the rows made afresh
      const [again, setAgain] = useState(false)
      if (!again) setAgain(true)
      seen = useLeavingCards(rows('a', 'b'))
      return null
    }
    renderToStaticMarkup(<Probe />)
    expect(passes).toBe(2)
    expect(seen.map((s) => [s.row.kind === 'mail' ? s.row.thread.id : '', s.place])).toEqual([['a', 0], ['b', 1]])
  })
})
