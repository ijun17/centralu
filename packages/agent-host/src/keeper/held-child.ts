import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { constants } from 'node:os'
import { ExitAfterDrain } from '../exit-after-drain.js'
import { raceTimeout, waitForEvent } from '../timing.js'
import { ATTACH_TIMEOUT_MS, type ChildExit, type KeeperChildren, type KeptChild } from './children-client.js'

/**
 * What an agent process (`agent-process.ts`) and a pty (`keeper-pty.ts`) the keeper holds have in common (#428): the
 * spawn's answer, the attach of their streams, the exit reported after the output, the release of the keeper's record,
 * and the detach that leaves the child running for the next host. Each adds the surface its callers expect (a
 * `ChildProcess`, a node-pty handle).
 *
 * **A child whose streams cannot be attached is ended, not let go of.** The keeper refuses to release a running child,
 * so releasing one whose attach failed left it running with nobody to read it or stop it. It is signalled (its whole
 * group, KILL) and released once the keeper reports its exit.
 *
 * **A child adopted from a previous host gets a second chance first.** It survived a swap or a restart, and its attach
 * can fail for a moment then: a loaded machine, or a keeper handoff that holds the service still. So the attach is
 * tried once more with a longer bound (`ADOPT_ATTACH_RETRY_MS`). If that fails too, what happens is the subclass's
 * call (`endsUnreadableAdopted`): an agent is ended, since its session starts a new CLI on the same conversation and
 * two CLIs on one thread conflict (codex refuses a second writer); a terminal or a command run is left running in the
 * keeper, where the next host can take it over, as before this rule.
 */

/** How long a detach waits for the attach still under way, and then for the keeper to end the stream */
export const DETACH_WAIT_MS = 2000
/** The bound of the second attach an adopted child gets (see the file header); the first one has `ATTACH_TIMEOUT_MS` */
export const ADOPT_ATTACH_RETRY_MS = 15_000

/** An `EventEmitter`, since the agent process is one (`ChildProcess`'s `exit` and `error`) */
export abstract class HeldChild extends EventEmitter {
  pid: number | undefined
  /** The keeper's id for this child, once the spawn has answered */
  childId: string | null = null
  protected detached = false
  /** The exit the keeper reported, once it has */
  protected exit: ChildExit | null = null
  /** The stream whose end means the output is all here (`out`), once attached */
  protected main: Socket | null = null
  protected ready: Promise<void> = Promise.resolve()
  private readonly report = new ExitAfterDrain(() => this.reportExit())

  protected constructor(protected readonly keeper: KeeperChildren) {
    super()
  }

  /** Starts following the child: called once, at the end of the subclass's constructor. `adopted`: a previous host's */
  protected begin(child: Promise<KeptChild>, streams: readonly ('out' | 'err')[], adopted = false): void {
    this.ready = this.start(child, streams, adopted)
  }

  /** Whether an adopted child whose streams still cannot be attached after the second try is ended (see the file header) */
  protected abstract readonly endsUnreadableAdopted: boolean

  /** The streams are attached and wired to the child: the subclass connects them to its surface */
  protected abstract attached(socks: Socket[]): void
  /** No spawn, or no attach: the subclass says so the way its callers expect. Nothing will be reported after this */
  protected abstract failed(e: Error): void
  /** The exit, after the output (`ExitAfterDrain`) */
  protected abstract exited(exit: ChildExit): void
  /** The exit is known, before the output has drained (the agent process sets its codes here) */
  protected noteExit(_exit: ChildExit): void {}

  private async start(childP: Promise<KeptChild>, streams: readonly ('out' | 'err')[], adopted: boolean): Promise<void> {
    let child: KeptChild
    try {
      child = await childP
    } catch (e) {
      // Nothing was started
      return this.failed(e as Error)
    }
    this.childId = child.id
    this.pid = child.pid
    this.keeper.on('exit', this.onChildExit)
    this.keeper.once('lost', this.onLost)
    let socks: Socket[]
    try {
      socks = await this.attachAll(child.id, streams, ATTACH_TIMEOUT_MS).catch((e: Error) => {
        if (!adopted || this.detached) throw e
        console.error(`[keeper] could not attach ${child.id} taken over from a previous host (${e.message}); trying once more`)
        return this.attachAll(child.id, streams, ADOPT_ATTACH_RETRY_MS)
      })
    } catch (e) {
      this.unsubscribe()
      // A host letting go meanwhile leaves the child for the next one, which attaches anew
      if (this.detached) return
      if (!adopted || this.endsUnreadableAdopted) this.abandon(child)
      else console.error(`[keeper] left ${child.id} running in the keeper for the next host: its streams did not attach (${(e as Error).message})`)
      return this.failed(e as Error)
    }
    if (this.detached) {
      for (const s of socks) s.destroy()
      return
    }
    const main = socks[0]!
    this.main = main
    main.on('end', () => this.report.drained())
    for (const s of socks) s.on('error', () => {})
    this.attached(socks)
    const known = child.exit ?? this.keeper.exitOf(child.id)
    if (known) this.recordExit(known)
  }

  /** Every stream of the child, or none: one that attached is closed again when another did not */
  private async attachAll(id: string, streams: readonly ('out' | 'err')[], timeoutMs: number): Promise<Socket[]> {
    const tries = await Promise.allSettled(streams.map((s) => this.keeper.attach(id, s, timeoutMs)))
    const failure = tries.find((t) => t.status === 'rejected')
    if (!failure) return tries.map((t) => (t as PromiseFulfilledResult<Socket>).value)
    for (const t of tries) if (t.status === 'fulfilled') t.value.destroy()
    throw failure.reason
  }

  /** Ends a child this host cannot read (see the file header), and releases it once it has exited */
  private abandon(child: KeptChild): void {
    const id = child.id
    const release = (cid: string) => {
      if (cid !== id) return
      this.keeper.off('exit', release)
      void this.keeper.release(id).catch(() => {})
    }
    // An adopted child may have exited before this host connected: its exit came with the list, never as an event
    if (child.exit ?? this.keeper.exitOf(id)) return release(id)
    this.keeper.on('exit', release)
    void this.keeper.signal(id, 'SIGKILL', true).catch((e: Error) => console.error(`[keeper] could not end ${id}, whose streams did not attach: ${e.message}`))
  }

  private onChildExit = (id: string, exit: ChildExit): void => {
    if (id === this.childId) this.recordExit(exit)
  }

  /** The keeper is gone, and with it the pipes this child wrote to: it cannot be alive */
  private onLost = (): void => {
    if (this.detached || this.exit) return
    this.recordExit({ code: null, signal: constants.signals.SIGHUP })
    this.report.drained()
  }

  private recordExit(exit: ChildExit): void {
    if (this.detached || this.exit) return
    this.exit = exit
    this.noteExit(exit)
    // Reported once the output has all arrived, so a reader never sees the exit before the last line
    this.report.exited(!this.main || this.main.readableEnded)
  }

  private reportExit(): void {
    if (this.detached || !this.exit) return
    this.unsubscribe()
    this.exited(this.exit)
    // Its output is all here: the keeper's record has nothing more to give anyone
    if (this.childId) void this.keeper.release(this.childId).catch(() => {})
  }

  private unsubscribe(): void {
    this.keeper.off('exit', this.onChildExit)
    this.keeper.off('lost', this.onLost)
  }

  /** Whether the child has exited or this host let go of it: nothing more is sent to it */
  protected get gone(): boolean {
    return this.detached || this.exit !== null
  }

  /** Signals the child (`group`: its whole process group) once the spawn has answered */
  protected signalChild(signal: string, group: boolean, what: string): void {
    void this.ready
      .then(() => (this.childId ? this.keeper.signal(this.childId, signal, group) : undefined))
      .catch((e: Error) => console.error(`[keeper] could not signal ${this.childId ?? what}: ${e.message}`))
  }

  /**
   * Lets go of the child and leaves it running for the next host. Output that arrives until the keeper ends the
   * stream is still delivered, so whoever reads it keeps reading until this resolves.
   */
  async detach(): Promise<void> {
    if (this.detached) return
    this.detached = true
    this.report.cancel()
    this.unsubscribe()
    await raceTimeout(this.ready, DETACH_WAIT_MS, undefined)
    const main = this.main
    if (!main) return
    if (!main.readableEnded && !main.destroyed) {
      const ended = waitForEvent(main, ['end', 'close'], DETACH_WAIT_MS)
      main.end()
      await ended
    }
    main.destroy()
    this.detachedStreams()
  }

  /** The other streams, once the main one has ended on a detach */
  protected detachedStreams(): void {}
}
