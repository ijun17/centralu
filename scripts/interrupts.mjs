// How pre-pr (scripts/pre-pr.mjs) starts git, pnpm, gh and Node: through runTool, which counts each
// tool an interrupt ended. Ctrl-C and Ctrl-Break reach every process of the terminal, the tool too, and the tool fails. The run
// is synchronous while a tool runs, so its own signal handler runs only once the run is over: how the tool ended is what tells
// the run it was interrupted, and not that the tool failed.
import { execFileSync } from 'node:child_process'
import { constants } from 'node:os'

/** The signals an interrupt sends: Ctrl-C, a TERM (a board cancelling the run), and Ctrl-Break on Windows */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK']
/** Windows' exit status for a process Ctrl-C or Ctrl-Break ended (STATUS_CONTROL_C_EXIT) */
const CONTROL_C_EXIT = 0xc000013a

/**
 * Whether execFileSync's error says an interrupt ended the tool: killed by one of SIGNALS; an exit status of 128 and one of
 * their numbers (130 for SIGINT: a tool that caught it, or run-limited.mjs passing on how its program ended); or Windows' status
 * for Ctrl-C and Ctrl-Break.
 */
export function endedByInterrupt(e) {
  if (SIGNALS.includes(e?.signal)) return true
  if (typeof e?.status !== 'number') return false
  return e.status >>> 0 === CONTROL_C_EXIT || SIGNALS.some((s) => constants.signals[s] !== undefined && e.status === 128 + constants.signals[s])
}

let interrupts = 0

/** How many tools an interrupt has ended in this process: a run compares it with the count it began at. */
export const interruptsSoFar = () => interrupts

/** execFileSync, counting a tool an interrupt ended ({@link endedByInterrupt}). Answers and throws what execFileSync does. */
export function runTool(file, args, options) {
  try {
    return execFileSync(file, args, options)
  } catch (e) {
    if (endedByInterrupt(e)) interrupts++
    throw e
  }
}
