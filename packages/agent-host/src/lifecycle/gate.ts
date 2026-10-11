/**
 * Nothing is pushed to a screen before the server exists (lessons HO11, #348).
 *
 * Services start sending before the server is declared: an adopted pty replays its buffered output
 * as soon as it is attached, a session event or a themes change can fire, and any `await` between
 * their start and the server's lets that in. Reaching the server then touched it before its
 * declaration ran: every host restart that held a terminal crashed with "Cannot read properties of
 * undefined (reading 'pushTerminal')", five times, until the keeper gave up (found 2026-10-05 by
 * scripts/keeper-children-integration.mjs). Until the server is up nobody is connected, so an early
 * frame is simply not sent; the services keep their own scrollback, which a screen reads when it
 * attaches. Services are handed `gate.push`, never the server itself.
 */
export class Gate<T> {
  private send: ((value: T) => void) | null = null

  /** Sends to `send` from now on */
  open(send: (value: T) => void): void {
    this.send = send
  }

  /** Sent once the gate is open; dropped before */
  readonly push = (value: T): void => {
    this.send?.(value)
  }
}
