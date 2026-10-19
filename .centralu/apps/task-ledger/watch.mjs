// Hearing of the project's sessions for as long as the app runs (`centralu.watchSessions`, uses.sessions: ["observe"]).
//
// One poll at a time is all Centralu allows an app, so the safety sweep's "whole project, from nothing" is the same
// loop: every `sweepMs` it drops its cursor and Centralu answers with every session. Nothing else is needed to find
// what an event missed (docs/plans/task-ledger.md §4).

const POLL_MS = 20_000
const MIN_WAIT_MS = 1_000
const LONGEST_RETRY_MS = 5 * 60_000

export function startWatching({ ledger, watchSessions, sweepMs, now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.error }) {
  let stopped = false
  const abort = new AbortController()
  void (async () => {
    let cursor
    let nextFull = now()
    let retry = 1_000
    while (!stopped) {
      const t = now()
      if (t >= nextFull) {
        cursor = undefined
        nextFull = t + sweepMs()
      }
      try {
        const answer = await watchSessions({ after: cursor, waitMs: Math.min(POLL_MS, Math.max(MIN_WAIT_MS, nextFull - t)), signal: abort.signal })
        retry = 1_000
        cursor = answer.cursor
        await ledger.applyObservation(answer)
      } catch (e) {
        if (stopped) return
        const why = String(e?.message ?? e).replace(/^centralu\.watchSessions failed: /, '')
        ledger.observationFailed(why)
        log(`[task-ledger] not hearing of the sessions: ${why}`)
        // An answer that never arrives is tried again from nothing
        cursor = undefined
        await wait(retry)
        retry = Math.min(retry * 2, LONGEST_RETRY_MS)
      }
    }
  })()
  return () => {
    stopped = true
    abort.abort()
  }
}

/** The sweep: GitHub, what it settles, what is due. Again after `sweepMs()`, read each time so a changed setting counts */
export function startSweeping({ ledger, sweepMs, schedule = (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return () => clearTimeout(h) }, log = console.error }) {
  let stopped = false
  let cancel = () => {}
  const next = () => {
    if (stopped) return
    cancel = schedule(async () => {
      try {
        await ledger.sweep()
        await ledger.flush()
      } catch (e) {
        log(`[task-ledger] the sweep failed: ${e?.message ?? e}`)
      }
      next()
    }, sweepMs())
  }
  // At the start too: whatever happened while the app was not running is found now
  void (async () => {
    try {
      await ledger.sweep()
    } catch (e) {
      log(`[task-ledger] the first sweep failed: ${e?.message ?? e}`)
    }
    next()
  })()
  return () => {
    stopped = true
    cancel()
  }
}
