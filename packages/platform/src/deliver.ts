/**
 * A subscriber that throws is reported and the rest still get the value: the sender has moved past it (an event's seq
 * is the cursor), and a throw inside a socket callback would leave the sender half-way. The web client and the mock
 * both fan out here, so a test on the mock sees what the app does.
 */
export function deliver<A extends unknown[]>(handlers: Iterable<(...v: A) => void>, ...value: A): void {
  for (const h of handlers) {
    try {
      h(...value)
    } catch (e) {
      console.error('A subscriber of the host connection threw', e)
    }
  }
}
