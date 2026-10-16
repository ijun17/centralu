// What every tool's handler shares: one write at a time, and a thrown failure answered as one.
import { failure, viewFailure } from './reply.mjs'

// --- One write at a time ---------------------------------------------------------------------------
// An agent may send several calls at once (a live Claude session sent both halves of a round trip
// in parallel). Each write reads the item fresh, so running them in arrival order keeps every
// "from → to" true and the last call the one that wins. A batch is one call: its items run in the
// order given, and no other write runs in between.
let writes = Promise.resolve()
function oneAtATime(fn) {
  const run = writes.then(fn, fn)
  writes = run.catch(() => {})
  return run
}

/** A tool's handler that answers what `fn` throws as a failure, after `prefix` (or `prefix(args)`). */
export const answering =
  (fn, prefix = '') =>
  async (args, ctx) => {
    try {
      return await fn(args, ctx)
    } catch (e) {
      return failure(e, typeof prefix === 'function' ? prefix(args) : prefix)
    }
  }
/** The same for the view's tools: the failure as data (`viewFailure`), so the view says why in place. */
export const forView = (fn) => async (args) => {
  try {
    return await fn(args)
  } catch (e) {
    return viewFailure(e)
  }
}
/** A write's handler: one at a time (`oneAtATime`). */
export const serially = (fn) => (args, ctx) => oneAtATime(() => fn(args, ctx))
