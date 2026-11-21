/**
 * Steps run in order and every one runs (lessons HO8): a step that threw cannot skip the rest. A promise is awaited before the
 * next step; a synchronous one is followed in the same tick, so those at the head all run before the first await. The first
 * error is thrown at the end and later ones logged, so a close failing on the way out hides nothing.
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
 * Two things that go on at once, as one step: both run to their end whatever the other does, and the first one's error is the
 * step's (App processes stop in parallel with sessions, HO8: their grace overlaps the sessions' cleanup instead of adding to
 * it)
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
