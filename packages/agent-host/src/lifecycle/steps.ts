/**
 * Running an ordered list of steps where every step runs (lessons HO8, #396).
 *
 * A host's shutdown is a list, not a function: the order is data a test can read, and running it
 * cannot skip a step because an earlier one threw. Before this, the services stopped in one
 * function and only the store and the keeper connection were closed "however the rest went": a
 * session cleanup that threw skipped the app views and the server, and the server's sockets held
 * the process until the supervisor's SIGKILL.
 *
 * - **In order, one at a time.** A step that returns a promise is awaited before the next one
 *   starts; a step that returns anything else is followed at once, in the same tick. So the steps
 *   at the head of a list that are synchronous have all run before the first await (HO8: ptys
 *   before anything that can take time, because a supervisor's SIGKILL does not reach a pty's own
 *   session).
 * - **Every step runs.** A step that throws or rejects does not stop the ones after it.
 * - **The first error wins.** It is the one thrown at the end; every later one is logged, so a
 *   close failing on the way out does not hide why the shutdown went wrong.
 */

export type Step = {
  /** Said in the log when the step fails */
  name: string
  run: () => unknown
}

export function runSteps(steps: readonly Step[], log: (line: string) => void): Promise<void> {
  let failed: { err: unknown } | null = null
  const fail = (step: Step, err: unknown) => {
    if (failed) log(`[agent-host] ${step.name} failed on the way out as well: ${describe(err)}`)
    else failed = { err }
  }
  const from = (i: number): Promise<void> => {
    for (; i < steps.length; i++) {
      const step = steps[i]!
      let result: unknown
      try {
        result = step.run()
      } catch (err) {
        fail(step, err)
        continue
      }
      if (isThenable(result)) {
        const next = i + 1
        return Promise.resolve(result).then(
          () => from(next),
          (err: unknown) => {
            fail(step, err)
            return from(next)
          },
        )
      }
    }
    return failed ? Promise.reject(failed.err) : Promise.resolve()
  }
  return from(0)
}

/**
 * Two things that go on at once, as one step: both run to their end whatever the other does, and
 * the first one's error is the step's. (App processes stop in parallel with sessions, HO8: their
 * grace period overlaps the sessions' cleanup instead of adding to it.)
 */
export async function both(a: () => Promise<unknown>, b: () => Promise<unknown>): Promise<void> {
  const [ra, rb] = await Promise.allSettled([call(a), call(b)])
  if (ra.status === 'rejected') throw ra.reason
  if (rb.status === 'rejected') throw rb.reason
}

/** A function that throws synchronously becomes a rejection, so `both` still waits for the other */
async function call(f: () => Promise<unknown>): Promise<unknown> {
  return f()
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (typeof v === 'object' || typeof v === 'function') && v !== null && typeof (v as { then?: unknown }).then === 'function'
}

function describe(err: unknown): string {
  return (err as Error)?.stack ?? String(err)
}
