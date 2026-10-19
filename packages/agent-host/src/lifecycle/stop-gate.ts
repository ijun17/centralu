import type { HostActivity } from '@cc/protocol'
import type { Drain } from '../drain.js'

/**
 * `host.stop {ifIdle}` (#1224): the hand-over into the person's Windows sign-in stops a host only while nothing runs on
 * it, and the check and the stop are one step. Asked over two calls (the activity, then the stop), a turn the hub
 * started in between was ended with the host.
 *
 * Busy is the host's one idle rule (`hostBusy`: a turn, an approval or a question waiting, background work, an open
 * terminal, a running command) or any call in flight besides the asking one: a call can be about to start a turn
 * (`sessions.send` between its arrival and its first state change). Idle, the drain begins in the same tick, before
 * anything else can run: from then on every new call is refused as retryable (`DrainCut`), so no turn, terminal or
 * command starts on a host that is going.
 */
export type StopGate = {
  /** What runs, when anything does: the activity and the calls in flight besides the asking one. Null when idle */
  busy(): { busy: HostActivity; calls: number } | null
  /** Refuses every new call from now on (the drain), for the stop that follows */
  refuse(): void
}

export function createStopGate(o: { drain: Drain; activity: () => HostActivity; boundMs?: number }): StopGate {
  return {
    busy() {
      const a = o.activity()
      // The asking call itself is in flight too, when it came through the transport (which tracks every call)
      const calls = Math.max(0, o.drain.running - 1)
      const any = calls > 0 || Object.values(a).some((n) => typeof n === 'number' && n > 0)
      return any ? { busy: a, calls } : null
    },
    refuse() {
      void o.drain.drain(o.boundMs ?? 10_000)
    },
  }
}
