// The board app's one clock (#1599, the review of #1627): every time the app reads, it reads here, and lint refuses
// `Date.now()` and `new Date()` anywhere else in the app (eslint.config.js). Its own module, with nothing of the OS, so
// the pure decision modules (queue.mjs, ci.mjs) can read it without importing the door that starts programs.

let offset = 0

/**
 * The time, in milliseconds since 1970: the system clock's, moved on in a stepped test run (`advanceClock`). The merge
 * queue's own clocks (polls, holds, the main guard, reposts, probes), the times the app writes and the waits it measures
 * all read it, so a stepped run sees one time.
 */
export const now = () => Date.now() + offset

/**
 * The system clock itself, which every process on the machine shares: only for what two processes compare, the lease
 * between the app's driver and a watch command (queue-driver.mjs `takeLease`). A stepped run moves this process's
 * `now` and not the other's, so a lease written on it would look held for as long as the steps had added.
 */
export const systemNow = () => Date.now()

/** Tests only (queue-driver.mjs `STEP_ON_READ`): each step of the queue is this much later */
export const advanceClock = (ms) => {
  offset += ms
}
