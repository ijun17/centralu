import { writeSync } from 'node:fs'

/**
 * The host's start, as data (docs/plans/runtime-unification.md step 3).
 *
 * Every row is a step `main.ts` takes, in this order, and `StartSequence` refuses to let it take
 * them in any other: a step entered out of turn, or skipped, throws at once, so a change that
 * moves one breaks every test that starts a host instead of shipping. What each position guards:
 */
export const START_ORDER = [
  // ST16: the launcher's variables leave the environment before anything can be spawned
  'launch variables',
  // The data folder (and moving a legacy one) decides where the log goes
  'data folder',
  // HO3: everything said from here on lands in host.log, the PATH probe's and the lock's words included
  'log',
  // PA1: a GUI app has no login-shell PATH; the tools are found before anything looks for them
  'path',
  // A swap's standby checks the store and waits here, before the lock, until the running host lets go
  'standby',
  // LK2: one host per data folder
  'lock',
  // HO6: right after the lock, a signal is held until the shutdown exists
  'hold signals',
  'store',
  // Under the keeper, the children a previous host left (#280 step 2)
  'keeper children',
  // Sessions, apps, terminals, views, links: wiring only, nothing is pushed to a screen (HO11)
  'services',
  // HO13: loopback only, a busy port is a sentence
  'listen',
  // The ready line; the supervisor reads it from stdout
  'ready',
  // Signals, crashes, the parent's pipe, `host.stop`, the keeper's stop and drain (HO7, HO10, HO15)
  'endings',
] as const

export type StartStep = (typeof START_ORDER)[number]

/** Follows `main.ts` through `START_ORDER`, and throws the moment it strays */
export class StartSequence {
  private next = 0

  constructor(private readonly order: readonly StartStep[] = START_ORDER) {}

  /** `main.ts` is about to take `step`. It must be the next one in the order */
  at(step: StartStep): void {
    const expected = this.order[this.next]
    if (step !== expected) {
      throw new Error(`host start out of order: "${step}" where "${expected ?? '(the end)'}" comes next (lifecycle/start.ts)`)
    }
    this.next += 1
  }

  /** Every step was taken */
  done(): void {
    if (this.next !== this.order.length) {
      throw new Error(`host start ended before "${this.order[this.next]}" (lifecycle/start.ts)`)
    }
  }
}

export type RefusalIo = {
  stderr: (line: string) => void
  /** Written synchronously to stdout (descriptor 1) */
  stdout: (line: string) => void
  exit: (code: number) => void
}

const realIo: RefusalIo = {
  stderr: (line) => console.error(line),
  stdout: (line) => void writeSync(1, `${line}\n`),
  exit: (code) => process.exit(code),
}

/**
 * A final refusal (lessons HO2): the host cannot start, and trying again gets the same answer
 * (another host owns the folder, a store a newer Centralu wrote, ownership that cannot be read).
 *
 * Said on stderr (host.log) **and** on stdout, synchronously, then exit 1 with no ready line. The
 * supervisor reads only stdout: speaking on stderr alone left the sentence in host.log, and the
 * supervisor retried six times and showed "exited (code 1)" (#184). Synchronously, because stdout
 * to a pipe is asynchronous on macOS and the exit follows at once. The supervisor stops retrying on
 * "already using this data" and "written by a newer Centralu": those phrases are a contract.
 */
export function refuse(message: string, io: RefusalIo = realIo): void {
  io.stderr(message)
  try {
    io.stdout(message)
  } catch {
    // stdout closed: stderr (host.log) has it
  }
  io.exit(1)
}
