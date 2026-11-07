import { both, runSteps, type Step } from './steps.js'

/** What the shutdown stops, as the host wires it. Each is one of the host's services */
export type HostParts = {
  /** Writes the open app views down for the next host (view-handover.ts) */
  handOverViews: () => void
  /** An update's stop lists the terminals and Run commands it is about to end, for the next host (#1902, update-ended.ts) */
  recordEnded: () => void
  terminals: { disposeAll(): void }
  commands: { disposeAll(): void }
  updates: { stop(): void }
  agentVersions: { stop(): void }
  /** Putting idle sessions to sleep (#568, sessions/sleep.ts) */
  sleeper: { stop(): void }
  /** Compacting sessions at rest (#1451, sessions/self-compaction.ts) */
  compaction: { stop(): void }
  /** The mailbox's delivery (#1347): a host that is leaving tells no one anything, the next one delivers */
  mailDelivery: { stop(): void }
  stopActivity: () => void
  /** The git calls still running (`stopGitChildren`, dev-services/git-exec.ts) */
  git: { stopAll(): Promise<void> }
  links: { stop(): Promise<void> }
  apps: { dispose(): Promise<void> }
  sessions: { disposeAll(): Promise<void> }
  appChanges: { dispose(): void }
  themes: { close(): void }
  inlineViews: { dispose(): void }
  views: { dispose(): Promise<void> }
  server: { close(): Promise<void> }
  store: { close(): void }
}

/**
 * The shutdown, as data: the reverse of the start (store, server, services), with two departures
 * the lessons ask for, and the git calls still running ended (#982). Every ending stops what the
 * host started: agents, terminals and commands end with it, whichever way it leaves (#1895).
 *
 * - **Terminals and commands come first, synchronously** (HO8). A pty child runs in
 *   a session of its own, so a supervisor's group SIGKILL after its 3 s budget cannot reach it: if
 *   these did not run before the first await, a dev server was left orphaned. Up to this step they
 *   came after awaiting the ssh links and the sessions.
 * - **The server closes after every service** that may still tell a screen something (a session's
 *   last state), and only then the store, whose close folds its WAL.
 *
 * ssh links and app processes end with the host too (#280 decision 2): a next host opens its own
 * links and starts apps again on demand.
 *
 * `handOver` marks a planned ending under the keeper, after which the keeper starts the next host:
 * the open app views are written down for it, first, before anything below closes them.
 */
export function stopPlan(handOver: boolean, p: HostParts): Step[] {
  const steps: Step[] = []
  if (handOver) steps.push({ name: 'handing the open app views over', run: p.handOverViews })
  // Before the shells go: it reads their screens
  steps.push({ name: 'listing the terminals and commands an update ends', run: p.recordEnded })
  steps.push(
    { name: 'ending the terminals', run: () => p.terminals.disposeAll() },
    { name: 'ending the commands', run: () => p.commands.disposeAll() },
  )
  steps.push(
    { name: 'the update check', run: () => p.updates.stop() },
    { name: 'the agent CLI check', run: () => p.agentVersions.stop() },
    // Before the sessions are let go of: a sweep now would race the sessions' own stop (#568)
    { name: 'putting idle sessions to sleep', run: () => p.sleeper.stop() },
    // And a compact now would reach a process that is being stopped (#1451)
    { name: 'compacting idle sessions', run: () => p.compaction.stop() },
    // Before the sessions are let go of too: a delivery now would wake a session that is being stopped (§4.2)
    { name: 'the mailbox’s delivery', run: () => p.mailDelivery.stop() },
    { name: 'the activity report', run: () => p.stopActivity() },
  )
  /*
   * Git runs in a process group of its own (git-exec.ts), so nothing
   * else ends a commit or push still waiting on a hook or a sign-in, and it would keep the repository's locks for up
   * to its bound. On a swap the drain has already waited, within its bound, for the RPCs that started them (drain.ts);
   * what still runs then is ended here. Before the sessions: their cleanup runs git of its own, and awaits it.
   */
  steps.push({ name: 'the git calls still running', run: () => p.git.stopAll() })
  steps.push(
    // The ssh links are this host's children: they end with it, and the next host opens its own
    { name: 'the linked machines', run: () => p.links.stop() },
    // In parallel: the apps' grace period (1 s) overlaps the sessions' cleanup instead of adding to it
    {
      name: 'app processes and sessions',
      run: () => both(() => p.apps.dispose(), () => p.sessions.disposeAll()),
    },
    { name: 'app change signals', run: () => p.appChanges.dispose() },
    { name: 'the themes watcher', run: () => p.themes.close() },
    { name: 'app views in conversations', run: () => p.inlineViews.dispose() },
    { name: 'app views', run: () => p.views.dispose() },
    { name: 'the server', run: () => p.server.close() },
    { name: 'the store', run: () => p.store.close() },
  )
  return steps
}

/**
 * Leaving, once (HO8). Whatever asks first (a signal, a crash, the parent going away, `host.stop`,
 * the keeper's `stop` or its drain) runs the ending; a later request runs no second one. The services stop at most once, and a leave ends with its log line and
 * exit 0, also when a step failed.
 *
 * **Bounded.** A step that never settles (a peer, a child that will not die) would hold the process
 * forever where nothing supervises it (`centralu serve`, `pnpm host`): after `boundMs` the host says
 * which ending ran out of time and exits 1. The bound is past the supervisor's own 3 s budget, so
 * under the keeper or the window their stop comes first and this never fires. `force` is the same
 * exit at once, for a person who asks again (a second Ctrl+C, `endings.ts`).
 */
export class Shutdown {
  private began = false
  private stopping: Promise<void> | null = null
  private ending: Promise<void> | null = null

  constructor(
    private readonly o: {
      plan: (handOver: boolean) => Step[]
      log: (line: string) => void
      /** Stops copying stderr to host.log, just before the exit */
      stopLog: () => void
      exit: (code: number) => void
      pid: number
      /** How long a leave may take before it exits anyway */
      boundMs?: number
      setTimer?: (f: () => void, ms: number) => void
      /**
       * Waited for before a leave stops anything, whichever way it began (a signal, the parent going, a stop asked for): the host
       * asks the system whether it is ending, and writes the answer before its agents go (#1397, system-end.ts). It is the caller's
       * to keep short; the bound below counts it. `undefined`: nothing to wait for, and the leave begins in this call (HO8)
       */
      beforeLeave?: () => Promise<void> | undefined
    },
  ) {}

  private forced = false
  private exited = false

  /** Whether it is leaving */
  get leaving(): boolean {
    return this.began
  }

  /**
   * Stops everything the host holds, without exiting: the swap's drain, which says
   * `drained` and exits on its own (swap-control.ts). A second call gets the first one's promise.
   */
  stopServices(handOver: boolean): Promise<void> {
    if (!this.stopping) {
      this.began = true
      this.stopping = runSteps(this.o.plan(handOver), this.o.log)
    }
    return this.stopping
  }

  /** Stops the services, says why it ended, and exits 0 */
  leave(handOver: boolean): Promise<void> {
    if (this.ending) return this.ending
    // A drain already stopping the services owns the ending: it exits when it has said `drained`
    if (this.stopping) return this.stopping.catch(() => {})
    this.began = true
    let before: Promise<void> | undefined
    try {
      before = this.o.beforeLeave?.()?.catch(() => {})
    } catch {
      // A throw in the notice must not keep the leave from beginning
    }
    const stopped = before ? before.then(() => this.stopServices(handOver)) : this.stopServices(handOver)
    const setTimer = this.o.setTimer ?? ((f, ms) => void setTimeout(f, ms).unref())
    setTimer(() => this.force(`did not finish within ${this.o.boundMs ?? SHUTDOWN_BOUND_MS}ms`), this.o.boundMs ?? SHUTDOWN_BOUND_MS)
    this.ending = stopped
      .catch((err: unknown) => {
        this.o.log(`[agent-host] a step of shutting down failed; leaving anyway: ${(err as Error)?.stack ?? String(err)}`)
      })
      .then(() => {
        if (this.forced) return
        // Why it ended becomes the first line of the next investigation; it never disappears silently
        this.o.log(`[agent-host] shutting down (pid ${this.o.pid}, stopped)`)
        this.exited = true
        this.o.stopLog()
        this.o.exit(0)
      })
    return this.ending
  }

  /** Exits 1 now, once, saying why: a leave that ran out of time, or a person who asked again */
  force(why: string): void {
    if (this.forced || this.exited) return
    this.forced = true
    this.o.log(`[agent-host] shutting down now (pid ${this.o.pid}): ${why}; whatever was still stopping is left as it is`)
    this.o.stopLog()
    this.o.exit(1)
  }
}

/** How long a leave may take before the host exits anyway (`Shutdown`) */
export const SHUTDOWN_BOUND_MS = 10_000
