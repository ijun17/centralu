/**
 * Hands one value to every subscriber, each on its own (#972 item 4). A subscriber that throws is reported and the
 * rest still get the value: the sender has already moved past it (an event's seq is the cursor, a connection change
 * has already happened), so nothing would ever hand it to them again, and a throw from inside a socket callback would
 * also leave the sender half-way through what it was doing. The web client and the mock both fan out through here, so
 * a test on the mock sees what the app does when one subscriber breaks.
 */
export function deliver<T>(handlers: Iterable<(v: T) => void>, value: T): void {
  for (const h of handlers) {
    try {
      h(value)
    } catch (e) {
      console.error('A subscriber of the host connection threw', e)
    }
  }
}
