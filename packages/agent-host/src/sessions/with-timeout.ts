/**
 * Do not let a call that never answers hold the screen hostage.
 *
 * The `label` is the diagnosis. An unnamed timeout only ever surfaced as the outer RPC's 30-second
 * "RPC timed out: agents.resumeSession", and that message does not say **where** it stopped — when
 * an actual MGH session died that way, there was no way to find out after the fact. If each stage
 * fails carrying its own name, the next occurrence of the same incident is its own diagnosis.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label = 'A call'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within ${Math.round(ms / 1000)}s`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
