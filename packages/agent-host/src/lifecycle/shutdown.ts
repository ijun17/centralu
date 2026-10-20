import { both, runSteps, type Step } from './steps.js'

/**
 * How this host leaves (#280 step 2, lessons HO8, HO15).
 *
 *   stop    agents, terminals and commands are stopped with it. Always the answer without the
 *           keeper's child service, and under one when the keeper itself is stopping ("Quit
 *           completely", "Restart completely", the last window closing with background mode off,
 *           idle exit): it says so with `stop` on the child service.
 *   detach  under a keeper that holds the children: a restart, a build switch, a crash, the
 *           keeper's pipe closing. Nothing it holds is stopped; the next host re-attaches to all of
 *           it.
 */
export type LeaveMode = 'stop' | 'detach'

/**
 * What a signal, a crash or the parent going away means (HO15). With the keeper's child service a
 * signal is a restart: the children are the keeper's, and stopping for good comes as `stop` on the
 * service first. Without it the two cannot be told apart, and the host owns its children.
 */
export function signalMode(heldChildren: boolean): LeaveMode {
  return heldChildren ? 'detach' : 'stop'
}

/** What the shutdown stops, as the host wires it. Each is one of the host's services */
export type HostParts = {
  /** Writes the open app views down for the next host (view-handover.ts) */
  handOverViews: () => void
  terminals: { disposeAll(): void; detachAll(): Promise<void> }
  commands: { disposeAll(): void; detachAll(): Promise<void> }
  updates: { stop(): void }
  agentVersions: { stop(): void }
  /** Putting idle sessions to sleep (#568, sessions/sleep.ts) */
  sleeper: { stop(): void }
  /** The mailbox's delivery (#1347): a host that is leaving tells no one anything, the next one delivers */
  mailDelivery: { stop(): void }
  stopActivity: () => void
  /** The git calls still running (`stopGitChildren`, dev-services/git-exec.ts) */
  git: { stopAll(): Promise<void> }
  links: { stop(): Promise<void> }
  apps: { dispose(): Promise<void> }
  sessions: { disposeAll(): Promise<void>; detachAll(): Promise<void> }
  appChanges: { dispose(): void }
  themes: { close(): void }
  inlineViews: { dispose(): void }
  views: { dispose(): Promise<void> }
  server: { close(): Promise<void> }
  store: { close(): void }
  /** The keeper's child service, when there is one */
  children: { close(): void } | null
}

/**
 * The shutdown, as data: the reverse of the start (store, children, server, services), with two
 * departures the lessons ask for, and the git calls still running ended in both modes (#982).
 *
 * - **Terminals and commands come first, synchronously, in stop mode** (HO8). A pty child runs in
 *   a session of its own, so a supervisor's group SIGKILL after its 3 s budget cannot reach it: if
 *   these did not run before the first await, a dev server was left orphaned. Up to this step they
 *   came after awaiting the ssh links and the sessions.
 * - **The server closes after every service** that may still tell a screen something (a session's
 *   last state), and only then the store, whose close folds its WAL, and the keeper connection.
 *
 * In detach mode nothing the keeper holds is stopped: terminals, commands and sessions are let go
 * of. ssh links and app processes end with the host in both modes (#280 decision 2): a next host
 * opens its own links and starts apps again on demand.
 *
 * `handOver` marks a planned ending under the keeper, after which the keeper starts the next host:
 * the open app views are written down for it, first, before anything below closes them.
 */
export function stopPlan(mode: LeaveMode, handOver: boolean, p: HostParts): Step[] {
  const steps: Step[] = []
  if (handOver) steps.push({ name: 'handing the open app views over', run: p.handOverViews })
  if (mode === 'stop') {
    steps.push(
      { name: 'ending the terminals', run: () => p.terminals.disposeAll() },
      { name: 'ending the commands', run: () => p.commands.disposeAll() },
    )
  }
  steps.push(
    { name: 'the update check', run: () => p.updates.stop() },
    { name: 'the agent CLI check', run: () => p.agentVersions.stop() },
    // Before the sessions are let go of: a sweep now would end a process the next host is meant to take over (#568)
    { name: 'putting idle sessions to sleep', run: () => p.sleeper.stop() },
    // Before the sessions are let go of too: a delivery now would wake a session the next host is meant to take over (§4.2)
    { name: 'the mailbox’s delivery', run: () => p.mailDelivery.stop() },
    { name: 'the activity report', run: () => p.stopActivity() },
  )
  /*
   * In both modes: the keeper does not hold git, and git runs in a process group of its own (git-exec.ts), so nothing
   * else ends a commit or push still waiting on a hook or a sign-in, and it would keep the repository's locks for up
   * to its bound. On a swap the drain has already waited, within its bound, for the RPCs that started them (drain.ts);
   * what still runs then is ended here. Before the sessions: their cleanup runs git of its own, and awaits it.
   */
  steps.push({ name: 'the git calls still running', run: () => p.git.stopAll() })
  if (mode === 'detach') {
    // Released, not killed: the keeper keeps draining them for the next host
    steps.push({ name: 'letting go of terminals and commands', run: () => both(() => p.terminals.detachAll(), () => p.commands.detachAll()) })
  }
  steps.push(
    // The ssh links are this host's children: they end with it, and the next host opens its own
    { name: 'the linked machines', run: () => p.links.stop() },
    // In parallel: the apps' grace period (1 s) overlaps the sessions' cleanup instead of adding to it
    {
      name: 'app processes and sessions',
      run: () => both(() => p.apps.dispose(), () => (mode === 'detach' ? p.sessions.detachAll() : p.sessions.disposeAll())),
    },
    { name: 'app change signals', run: () => p.appChanges.dispose() },
    { name: 'the themes watcher', run: () => p.themes.close() },
    { name: 'app views in conversations', run: () => p.inlineViews.dispose() },
    { name: 'app views', run: () => p.views.dispose() },
    { name: 'the server', run: () => p.server.close() },
    { name: 'the store', run: () => p.store.close() },
    { name: "the keeper's child service", run: () => p.children?.close() },
  )
  return steps
}

/**
 * Leaving, once (HO8). Whatever asks first (a signal, a crash, the parent going away, `host.stop`,
 * the keeper's `stop` or its drain) decides what happens to the children; a later request runs no
 * second, different ending. The services stop at most once, and a leave ends with its log line and
 * exit 0, also when a step failed.
 *
 * **Bounded.** A step that never settles (a peer, a child that will not die) would hold the process
 * forever where nothing supervises it (`centralu serve`, `pnpm host`): after `boundMs` the host says
 * which ending ran out of time and exits 1. The bound is past the supervisor's own 3 s budget, so
 * under the keeper or the window their stop comes first and this never fires. `force` is the same
 * exit at once, for a person who asks again (a second Ctrl+C, `endings.ts`).
 */
export class Shutdown {
  private mode: LeaveMode | null = null
  private stopping: Promise<void> | null = null
  private ending: Promise<void> | null = null

  constructor(
    private readonly o: {
      plan: (mode: LeaveMode, handOver: boolean) => Step[]
      log: (line: string) => void
      /** Stops copying stderr to host.log, just before the exit */
      stopLog: () => void
      exit: (code: number) => void
      pid: number
      /** How long a leave may take before it exits anyway */
      boundMs?: number
      setTimer?: (f: () => void, ms: number) => void
    },
  ) {}

  private forced = false
  private exited = false

  /** How it is leaving, once it is */
  get leaving(): LeaveMode | null {
    return this.mode
  }

  /**
   * Stops (or hands off) everything the host holds, without exiting: the swap's drain, which says
   * `drained` and exits on its own (swap-control.ts). A second call gets the first one's promise.
   */
  stopServices(mode: LeaveMode, handOver: boolean): Promise<void> {
    if (!this.stopping) {
      this.mode = mode
      this.stopping = runSteps(this.o.plan(mode, handOver), this.o.log)
    }
    return this.stopping
  }

  /** Stops the services, says why it ended, and exits 0 */
  leave(mode: LeaveMode, handOver: boolean): Promise<void> {
    if (this.ending) return this.ending
    // A drain already stopping the services owns the ending: it exits when it has said `drained`
    if (this.stopping) return this.stopping.catch(() => {})
    const stopped = this.stopServices(mode, handOver)
    const setTimer = this.o.setTimer ?? ((f, ms) => void setTimeout(f, ms).unref())
    setTimer(() => this.force(`did not finish within ${this.o.boundMs ?? SHUTDOWN_BOUND_MS}ms`), this.o.boundMs ?? SHUTDOWN_BOUND_MS)
    this.ending = stopped
      .catch((err: unknown) => {
        this.o.log(`[agent-host] a step of shutting down failed; leaving anyway: ${(err as Error)?.stack ?? String(err)}`)
      })
      .then(() => {
        if (this.forced) return
        const how = this.mode === 'detach' ? 'agents, terminals and commands left running in the keeper' : 'stopped'
        // Why it ended becomes the first line of the next investigation; it never disappears silently
        this.o.log(`[agent-host] shutting down (pid ${this.o.pid}, ${how})`)
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
