import type { NormalizedEvent, PermissionPreset } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, CreateSessionOpts, ProcessSource, SessionHandle } from '../contract.js'

/**
 * The scenarios of a conversation that changes hands while its app-server lives on: a host swap under the keeper, where the
 * new host takes over the process the old one started (`ProcessSource.adopt`, #280). Recorded by `scripts/frames-record.mts`,
 * replayed by `codex/adopt.test.ts`.
 *
 * A scenario has two halves. `before` runs on the session that starts the process and is not recorded (the recording begins
 * at the swap, as a new host's own tap does: it records from the adoption on). `after` runs on the session that adopts, and is
 * what a recording holds: the handshake an adopted process refuses, the `thread/resume` it answers on the same connection, and
 * whatever the thread does from there. A replay runs `after` alone, against the recorded process.
 */

export type Side = {
  readonly events: NormalizedEvent[]
  session(): SessionHandle
  /** The next event after the ones already waited for that `pick` accepts */
  waitFor(label: string, pick: (e: NormalizedEvent) => boolean): Promise<NormalizedEvent>
}

export type SwapScenario = {
  name: string
  /** A model the scenario asks for in place of the run's (a failed turn names one that does not exist) */
  model?: string
  preset?: PermissionPreset
  before(side: Side): Promise<void>
  after(side: Side): Promise<void>
}

const ended = (e: NormalizedEvent) => e.type === 'turn_complete' || e.type === 'error' || (e.type === 'state_change' && e.state === 'waiting_input')

export const SWAP_SCENARIOS: readonly SwapScenario[] = [
  {
    // The thread is mid-turn when the new host asks about it: `thread/resume` on the connection that runs it says `active`
    name: 'adopt-running',
    async before(a) {
      a.session().send('Count from 1 to 300, one number per line.')
      await a.waitFor('the first output', (e) => e.type === 'message_delta')
    },
    async after(b) {
      await b.waitFor('the turn going on', (e) => e.type === 'message_delta')
      b.session().interrupt()
      await b.waitFor('the stop', (e) => e.type === 'state_change' && e.state === 'waiting_input')
      b.session().send('Say ok.')
      await b.waitFor('the end of the next turn', ended)
    },
  },
  {
    // The turn failed before the swap: the kept process answers `thread/resume` with the status the failure left (`systemError`)
    name: 'adopt-failed',
    model: 'no-such-model-xyz',
    async before(a) {
      a.session().send('Reply with exactly: hello')
      await a.waitFor('the failure', (e) => e.type === 'error')
    },
    async after(b) {
      b.session().send('Reply with exactly: hello')
      await b.waitFor('the failure of the next turn', (e) => e.type === 'error')
    },
  },
]

function side(sessionOf: () => SessionHandle, bound: number, label: string): { side: Side; emit: (e: NormalizedEvent) => void } {
  const events: NormalizedEvent[] = []
  let seen = 0
  let waiter: { pick(e: NormalizedEvent): boolean; resolve(e: NormalizedEvent): void } | null = null
  const emit = (e: NormalizedEvent) => {
    events.push(e)
    if (waiter && seen === events.length - 1) {
      seen++
      if (waiter.pick(e)) {
        const w = waiter
        waiter = null
        w.resolve(e)
      }
    }
  }
  return {
    emit,
    side: {
      events,
      session: sessionOf,
      waitFor: (what, pick) =>
        new Promise((resolve, reject) => {
          while (seen < events.length) {
            const e = events[seen++]!
            if (pick(e)) return resolve(e)
          }
          const timer = bound > 0 ? setTimeout(() => reject(new Error(`${label}: no ${what} within ${bound} ms`)), bound) : null
          waiter = {
            pick,
            resolve: (e) => {
              if (timer) clearTimeout(timer)
              resolve(e)
            },
          }
        }),
    },
  }
}

/** The adopting session's half alone: `process` is the app-server it takes over, `externalId` the thread it runs (a replay has no first half) */
export async function driveAdopted(
  adapter: AgentAdapter,
  scenario: SwapScenario,
  opts: CreateSessionOpts,
  process: AgentProcess,
  externalId: string,
  bound: number,
  /** Rejects when the run cannot go on (a replay that met a line it does not have): the scenario then fails with that, not by waiting */
  failed?: Promise<never>,
): Promise<NormalizedEvent[]> {
  let handle: SessionHandle | null = null
  const second = side(() => handle!, bound, `${scenario.name} (after the swap)`)
  const processSource: ProcessSource = {
    spawn: () => {
      throw new Error('an adopted session starts no process of its own')
    },
    adopt: { process, openCalls: [] },
  }
  handle = await adapter.createSession({ ...opts, resumeExternalId: externalId, processSource }, second.emit)
  try {
    await (failed ? Promise.race([scenario.after(second.side), failed]) : scenario.after(second.side))
  } finally {
    await handle.dispose()
  }
  return second.side.events
}

/**
 * Both halves against the real tool: `before` on a session that starts the app-server (`opts.processSource` spawns it, and
 * `process()` names it), then the swap (the first session lets go of the process without closing it), `startRecording`, and
 * `after` on a session that adopts it
 */
export async function driveSwap(
  adapter: AgentAdapter,
  scenario: SwapScenario,
  firstOpts: CreateSessionOpts,
  secondId: string,
  process: () => AgentProcess | null,
  startRecording: () => void,
  bound: number,
): Promise<NormalizedEvent[]> {
  let first: SessionHandle | null = null
  const before = side(() => first!, bound, `${scenario.name} (before the swap)`)
  first = await adapter.createSession(firstOpts, before.emit)
  let live: AgentProcess | null = null
  try {
    await scenario.before(before.side)
    live = process()
    if (!live || !first.externalId || !first.detach) throw new Error(`${scenario.name}: nothing to hand over (process ${live ? 'found' : 'missing'}, thread ${first.externalId ?? 'unnamed'})`)
    await first.detach()
    startRecording()
  } catch (e) {
    // The app-server was never handed over: it ends here, not when the recorder does
    await first.dispose().catch(() => {})
    live?.kill('SIGKILL')
    throw e
  }
  try {
    return await driveAdopted(adapter, scenario, { ...firstOpts, sessionId: secondId }, live, first.externalId, bound)
  } catch (e) {
    live.kill('SIGKILL')
    throw e
  }
}
