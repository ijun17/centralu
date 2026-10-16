/**
 * What an approval callback did with one call (#845): its own answer if it gave one, or `'still asking'` once a
 * card for the person went up. Both sides are things that happen. The tests used to read "it is asking" from a
 * 20–200 ms timer, which also stood for "the answer was slow": on a loaded machine an allow lost that race and the
 * test failed for load. The card is looked for after every turn of the event loop; a call that neither answers
 * nor raises a card runs into the test's own timeout.
 *
 * `cards` counts the cards raised so far; only one raised by this call counts.
 */
export async function answerOrCard<T>(call: () => Promise<T>, cards: () => number): Promise<T | 'still asking'> {
  const before = cards()
  let done = false
  const asked = new Promise<'still asking'>((resolve) => {
    const look = () => {
      if (done) return
      if (cards() > before) resolve('still asking')
      else setImmediate(look)
    }
    look()
  })
  try {
    return await Promise.race([call(), asked])
  } finally {
    done = true
  }
}

/**
 * Whether a promise has settled once every reaction already queued has run, with no timer involved: a
 * `setImmediate` runs after the microtask queue drains. For "this stays unanswered" when the only way it could
 * be answered is a synchronous `resolve` (an answer routed to the wrong request), a fixed wait adds nothing.
 */
export function settledNow(p: Promise<unknown>): Promise<'answered' | 'still asking'> {
  return Promise.race([p.then(() => 'answered' as const, () => 'answered' as const), new Promise<'still asking'>((r) => setImmediate(() => r('still asking')))])
}
