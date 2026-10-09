import { takeLaunchEnv } from './lifecycle/launch-env.js'
import { StartSequence, refuse } from './lifecycle/start.js'
import { parseArgs } from 'node:util'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdirSync, writeSync } from 'node:fs'
import { APP_VERSION, DATA_DIR, DATA_DIR_DEV, DATA_DIR_LEGACY, PROTOCOL_VERSION, RESERVED_APP_IDS, type NormalizedEvent } from '@cc/protocol'
import { hostBuild, startActivityReport } from './keeper-link.js'
import { activityCounts, type ActivitySnapshot } from './idle.js'
import { connectHeldChildren } from './keeper/held-children.js'
import { dataRoot, migrateLegacyDataDir } from './data-dir.js'
import { DEFAULT_ALLOWED_ORIGINS, HostServer, parseAllowedOrigins } from './transport/server.js'
import { deriveHttpSecret } from './transport/http.js'
import { recordViewHandover, restoreViewHandover } from './view-handover.js'
import { ViewHost } from './views/view-host.js'
import { attachInlineViews } from './inline-views.js'
import { OriginPorts, type PortBook } from './views/origin-ports.js'
import { SessionManager } from './sessions/manager.js'
import { readShared } from './sessions/app-access.js'
import { Store, StoreTooNewError } from './dev-services/store.js'
import { createAdapters } from './adapters/registry.js'
import { createRpcHandler } from './rpc.js'
import { ExternalApps } from './apps/external/runtime.js'
import { storeRunLedger } from './app-run-ledger.js'
import { storePermissionBook } from './app-permission-book.js'
import { runtimeViewSource } from './app-view-source.js'
import { onExternalAppListChanged } from './app-list-events.js'
import { broadcastAppChanges, broadcastAppRuns } from './app-change-events.js'
import { ThemeFiles } from './themes.js'
import { TerminalService } from './dev-services/terminal.js'
import { CommandRunner } from './dev-services/commands.js'
import { ensureToolPath } from './env-path.js'
import { UpdateService } from './updates.js'
import { AgentVersionService } from './agent-versions.js'
import { acquireInstanceLock, lockConflictMessage } from './dev-services/instance-lock.js'
import { hostLogPath, startupBanner, teeStderrToFile } from './log-file.js'
import { hostDrain } from './drain.js'
import { Gate } from './lifecycle/gate.js'
import { Shutdown, signalMode, stopPlan } from './lifecycle/shutdown.js'
import { crashRecorder, holdSignals, wireEndings } from './lifecycle/endings.js'
import { bridgeAddress, ControlChannel, KEEPS_AGENTS_ACROSS_SWAP, onDrain, standby, viewPort } from './swap-control.js'
import { installScript, remoteRuntime } from './links/install.js'
import { Links } from './links/links.js'
import { Router } from './links/router.js'
import { SshTunnel } from './links/tunnel.js'
import { storeMirror, storeRegistry } from './links/stored.js'

/**
 * Agent Host entry point.
 * dev: run directly with `pnpm host`. prod: started by the keeper or the window (docs/architecture.md §4)
 *
 * The start follows `START_ORDER` (lifecycle/start.ts), and each step below is marked with
 * `start.at(…)`: taking one out of turn throws. The shutdown is `stopPlan` (lifecycle/shutdown.ts),
 * run once by `Shutdown`; every way of ending is wired in `wireEndings` (lifecycle/endings.ts).
 */
const start = new StartSequence()

/*
 * What the launcher hands over (#280, keeper-link.ts), read once and taken out of the environment
 * before anything is spawned (lessons ST16): everything this host spawns (agents, terminals,
 * commands) inherits it otherwise, and none of them has any use for it.
 */
start.at('launch variables')
const launch = takeLaunchEnv()

/**
 * The build identifier. The bundler swaps `__CC_BUILD__` for the actual commit
 * (running straight from source has no substitution, so it stays 'dev').
 */
declare const __CC_BUILD__: string | undefined
const BUILD = typeof __CC_BUILD__ === 'string' ? __CC_BUILD__ : 'dev'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '5175' },
    token: { type: 'string' },
    db: { type: 'string' },
    /** Exits together if the parent dies (turned on by the supervisor) */
    'watch-parent': { type: 'boolean' },
    memory: { type: 'boolean', default: false },
    /** Started by the keeper next to a running host, for a swap (#280 step 3, swap-control.ts) */
    standby: { type: 'boolean', default: false },
  },
})

/*
 * Control lines from the keeper on stdin (#280 step 3). Only under a keeper: anyone else's stdin is
 * not ours to read.
 */
const control = launch.underKeeper ? new ControlChannel(process.stdin) : null

const token = values.token || launch.token || randomBytes(16).toString('hex')
/* The token is the keeper's only when the keeper started this host and handed it over (#280 step 4, below) */
const keeperToken = launch.underKeeper && !values.token && launch.token ? token : null
/*
 * The secret for the HTTP door (M4 P-2). A **different value** from the WebSocket token. Since
 * this value ends up as a path segment in an iframe's address and travels around in a URL, even if
 * it leaks the RPC door must stay closed. There is no way to set it from outside. The address is
 * built by the host as part of the RPC answer, so nobody needs to know this value in advance.
 *
 * Under the keeper it is derived one-way from the keeper's token instead of drawn at random, so
 * every host the keeper runs has the same one and a view's address survives a swap (#280 step 4;
 * why that keeps the two doors apart: `deriveHttpSecret`).
 */
const httpSecret = keeperToken ? deriveHttpSecret(keeperToken) : randomBytes(32).toString('base64url')

/**
 * The data folder.
 *
 * **dev and the packaged app use different folders.** If they shared one, running both at once
 * would leave two hosts holding the same store.db, each keeping a different session list.
 * Since starting dev with the packaged app still running is natural during development, they are
 * kept entirely separate.
 *
 * The move of a legacy folder happens here, but **announcing it is deferred** until the log is on:
 * said earlier, the line went to the parent's stderr instead of the file, and on the very first move
 * `host.log` had nothing in it, though this is the one line that explains why the folder disappeared.
 */
start.at('data folder')
let movedNote: string | null = null
function defaultDbPath(): string {
  // Packaged when run from the bundled output, dev when run from source (the supervisor tells this)
  const isDev = process.env.CC_DEV === '1'
  const dir = join(homedir(), isDev ? DATA_DIR_DEV : DATA_DIR)
  const legacy = join(homedir(), isDev ? DATA_DIR_LEGACY.dev : DATA_DIR_LEGACY.prod)
  movedNote = migrateLegacyDataDir(legacy, dir) ? `[agent-host] data folder moved: ${legacy} -> ${dir}` : null
  mkdirSync(dir, { recursive: true })
  // Pins attachments, the orchestrator home, and worktrees to all live under here (dev and prod diverge)
  process.env.CC_DATA_DIR = dir
  return join(dir, 'store.db')
}
const dbPath = values.memory ? ':memory:' : (values.db ?? defaultDbPath())

/**
 * **Logging is turned on before anything else** (lessons HO3).
 *
 * Everything said below this line (PATH augmentation, instance-lock conflicts, codex's stderr,
 * unhandled rejections) ends up in the file. A Finder-launched app has stderr on /dev/null, so
 * turning it on late misses exactly the cases that go wrong at startup.
 */
start.at('log')
const stopLog = dbPath === ':memory:' ? () => {} : teeStderrToFile(hostLogPath(dirname(dbPath)))
if (dbPath !== ':memory:') console.error(startupBanner({ build: BUILD, db: dbPath, pid: process.pid }))
// Right after the banner: which start did the move has to be readable in the same spot
if (movedNote) console.error(movedNote)

/*
 * A GUI app does not inherit the login shell's PATH: it is augmented first, to find the CLIs
 * (measured). It asks the person's own login shell, so nvm, mise and manual installs are caught too.
 */
start.at('path')
const pathResult = ensureToolPath()
if (pathResult.source !== 'unchanged') {
  console.error(`[agent-host] PATH augmented (${pathResult.source === 'shell' ? 'login shell' : 'default candidates'})`)
}

/*
 * A swap's standby (#280 step 3): checks the store without writing to it, reports, and waits here,
 * before the ownership lock, until the keeper says the running host has let go.
 */
start.at('standby')
const swapping = values.standby === true && control !== null
if (values.standby && !control) {
  console.error('[agent-host] --standby is only meaningful under a keeper; starting normally')
}
if (swapping) {
  await standby({
    control: control!,
    inspect: () => Store.inspect(dbPath),
    write: (line) => void writeSync(1, `${line}\n`),
    log: (line) => console.error(line),
    exit: (code) => process.exit(code),
  })
}

/**
 * Two hosts on the same data folder desync the session list and contend over SQLite (lessons LK2).
 * Failing to start with a stated reason is better than going quietly wrong.
 */
start.at('lock')
let lock: ReturnType<typeof acquireInstanceLock>
try {
  lock = acquireInstanceLock(dbPath)
} catch (err) {
  // Ownership could not be checked at all (an unreadable ownership file): not starting is the safe answer (#82)
  refuse(`[agent-host] ${(err as Error).message}`)
  throw err
}
if (!lock.ok) {
  refuse(lockConflictMessage(lock.heldByPid, lock.lockPath))
  process.exit(1)
}
/*
 * The lock is released by one exit hook, which runs last whichever path led to the exit (HO5). A
 * signal handler that ends the process must never be attached here: handlers run in the order they
 * were added, and one that released the lock and exited first meant the real shutdown never ran.
 */
const ownership = lock
process.on('exit', ownership.release)

start.at('hold signals')
const signals = holdSignals(process, (line) => console.error(line))

/*
 * A store a newer Centralu wrote, past what this host can read (#292), is refused like a lock
 * conflict (HO2). Any other failure to open still throws.
 */
start.at('store')
let store: Store
try {
  // Taking over in a swap: only what the previous build can still read runs now (store.ts, "During a swap")
  store = new Store(dbPath, { swap: swapping })
} catch (err) {
  if (!(err instanceof StoreTooNewError)) throw err
  refuse(err.message)
  process.exit(1)
}
const adapters = createAdapters()

/*
 * Under the keeper, agents, terminals and project commands are spawned by the keeper, not by this
 * host, and a restart leaves them running (#280 step 2, keeper/held-children.ts). What a previous
 * host left there is taken over below. Without a keeper (`pnpm dev`, e2e, a debug app, Windows)
 * this is null and everything is spawned here.
 */
start.at('keeper children')
const held = launch.underKeeper ? await connectHeldChildren(dirname(dbPath)) : null

start.at('services')
/*
 * What services send to screens goes through these until the server exists (HO11, lifecycle/gate.ts):
 * before then nobody is connected, and a frame or an event is not sent.
 */
const screens = new Gate<Parameters<HostServer['pushTerminal']>[0]>()
const events = new Gate<NormalizedEvent>()

/*
 * Moving sessions to a newly installed agent CLI (#297) hears every session event: a session that just said something
 * is not quiet yet. Declared ahead of the manager, whose events can start before the service below exists.
 */
const versionsRef: { current?: AgentVersionService } = {}
/*
 * The manager is told the host's own address as a function: the bridge of an adapter that cannot
 * attach a tool in-process connects back through it, and the port is only known after listen().
 */
let port: number | undefined
const mgr = new SessionManager(
  store,
  adapters,
  (e) => {
    events.push(e)
    versionsRef.current?.observe(e)
  },
  () => bridgeAddress(launch.frontDoor, port, token),
  // Worktrees are created next to the data folder — dev and the packaged app never touch each other's worktrees
  join(dirname(dbPath), 'worktrees'),
  held ? { processes: held.processes, keptSessions: held.kept.sessionIds } : {},
)
/*
 * The external app runtime (M4 A). Startup **only scans** — an app process starts only the first
 * time it is needed (performance budget: zero app processes at idle, even with 5 apps installed).
 * The data folder is the one defaultDbPath above pinned via CC_DATA_DIR — dev and the packaged app
 * diverge here.
 */
// An app's "changed" broadcast is collected per app — even if an open view's re-read becomes a loop, it never exceeds 4 per second per app (app-change-events.ts)
const appChanges = broadcastAppChanges(events.push)
// The run panel's signal is collected separately — a chain started by a read-only tool is reported too, but never wakes a view (app-change-events.ts)
const appRunChanges = broadcastAppRuns(events.push)
const externalApps = new ExternalApps({
  projects: () => store.projectRoots(),
  dataRoot: dataRoot(),
  reservedIds: RESERVED_APP_IDS,
  // The run record (A-6) — the store fills in the shape the runtime declared. The runtime does not know Store
  runs: storeRunLedger(store),
  // The answer to a capability approval (D-4) — the same flip. An answer given once remains even after the host restarts
  permissions: storePermissionBook(store),
  // Every time a non-read-only call that reached the app ends — the signal for an open view to re-read (the UI store carries this to AppFrame's changeSignal)
  emitChanged: appChanges.emit,
  // Every time an entry visible in the run panel starts or ends — the signal for the run panel to re-read (the UI store carries this to RunsPanel)
  emitRunsChanged: appRunChanges.emit,
  // Even if the app folder changes, if the building session is mid-turn it waits until the turn ends (C-4) — the manager tells the runtime when the turn ends
  builderBusy: (ref) => mgr.builderBusy(ref),
  // Whether the person shares a project app with their other projects (#371 part A) — read fresh, like trust
  shared: (ref) => readShared(store, ref),
})
externalApps.refresh()
// An app's place or status changed (A-8) — the sidebar and the fixed view re-read apps.list
onExternalAppListChanged(externalApps, () => events.push({ type: 'external_apps_changed' }))
// Attaches apps to a session (A-5) — the manager and the runtime know nothing about each other; this is where they are wired together
mgr.useExternalApps(externalApps)
/*
 * Terminal and command output can arrive before the server exists: under the keeper an adopted pty
 * replays its buffered output as soon as it is attached (HO11, lifecycle/gate.ts).
 */
const terminals = new TerminalService(screens.push, held?.ptys)
// Runner for frequently used commands (#60) — its output rides the same frame lane as the terminal
const commandRuns = new CommandRunner(screens.push, held?.ptys)
if (held) {
  terminals.adopt(held.kept.terminals)
  commandRuns.adopt(held.kept.runs)
}
/*
 * The update check is done by **the host** — not by the launcher (issue #43).
 *
 * The launcher has the same code, but what runs there is the copy **already installed** on the
 * user's machine, and the beta.1 copy has a broken version comparison (#42). That defect cannot be
 * fixed retroactively: the thing that would have to notice it was fixed is that exact broken
 * comparison. Checking here instead runs code shipped alongside the app itself, so it can never be
 * older than the app, and it skips the stale launcher entirely.
 *
 * The check result **only informs** the person. Swapping out the running app is irreversible, so
 * it is never done silently — it happens only when they click it, or when they turned on
 * "Apply updates automatically when idle" (#352), and then only once nothing is running.
 */
const AUTO_UPDATE_CHECK_KEY = 'updates.auto'
const AUTO_APPLY_UPDATES_KEY = 'updates.autoApply'
// Custom themes are files in <data>/themes, watched so a hand edit shows up live (#312, themes.ts)
const themes = new ThemeFiles(join(dataRoot(), 'themes'), () => events.push({ type: 'themes_changed' }))
await themes.start().catch((e: Error) => console.error(`[themes] the themes folder is unavailable: ${e.message}`))

const updates = new UpdateService((status) => events.push({ type: 'update_status', status }), {
  // On by default when nothing has been saved yet. Since the check is read-only and every failure
  // is swallowed, leaving it on costs nothing, while leaving it off traps **someone who never once
  // opens settings** on an old version forever — that person is exactly the one most likely to stay
  // stale.
  readAuto: () => store.appSetting(AUTO_UPDATE_CHECK_KEY) !== 'false',
  writeAuto: (enabled) => store.setAppSetting(AUTO_UPDATE_CHECK_KEY, String(enabled)),
  // Off unless the person turned it on (#352): installing without a click is asked for, never assumed
  readAutoApply: () => store.appSetting(AUTO_APPLY_UPDATES_KEY) === 'true',
  writeAutoApply: (enabled) => store.setAppSetting(AUTO_APPLY_UPDATES_KEY, String(enabled)),
})
/*
 * The installed agent CLIs, and moving idle sessions onto them (#297). "Move idle sessions to a newly installed agent
 * CLI" is on unless the person turned it off (the owner's decision, 2026-10-05): a restart only happens when nothing in
 * the session would be lost, the conversation continues through resume, and a line in the conversation says so.
 */
const AUTO_APPLY_AGENT_VERSIONS_KEY = 'agents.autoApplyVersions'
const AGENT_VERSIONS_SEEN_KEY = 'agents.versionsSeen'
const agentVersions = new AgentVersionService({
  tools: () => [...adapters.values()].map((a) => ({ tool: a.tool, installedVersion: a.installedVersion?.bind(a) })),
  sessions: mgr,
  // Not listening yet: the first window asks
  publish: (status) => events.push({ type: 'agent_versions', status }),
  readAutoApply: () => store.appSetting(AUTO_APPLY_AGENT_VERSIONS_KEY) !== 'false',
  writeAutoApply: (enabled) => store.setAppSetting(AUTO_APPLY_AGENT_VERSIONS_KEY, String(enabled)),
  readSeen: () => {
    try {
      const raw = JSON.parse(store.appSetting(AGENT_VERSIONS_SEEN_KEY) ?? '{}') as unknown
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, string>) : {}
    } catch {
      return {}
    }
  },
  writeSeen: (seen) => store.setAppSetting(AGENT_VERSIONS_SEEN_KEY, JSON.stringify(seen)),
})
versionsRef.current = agentVersions
mgr.useVersionHint((tool) => agentVersions.installedNow(tool))
// The escape hatch for the origin allow list — the rejection log states exactly the value to put
// here. An app view's proxy uses the same list too: only a parent able to connect over WebSocket
// can ever render a view
const allowedOrigins = parseAllowedOrigins(process.env.CC_HOST_ALLOWED_ORIGINS) ?? [...DEFAULT_ALLOWED_ORIGINS]
/*
 * App view hosting (M4 B-3). The document is read from the app by the external app runtime, the
 * origin method is decided by the manifest's `view.origin`, and an open view holds its app from
 * being shut down as idle (app-view-source.ts). The per-app origin port assignment table lives in
 * app_settings. The table never shrinks (origin-ports.ts). Giving a port that was once assigned to
 * a different app would let that app read someone else's browser storage.
 */
const VIEW_PORTS_KEY = 'apps.viewPorts'
const views = new ViewHost({
  secret: httpSecret,
  allowedOrigins,
  source: runtimeViewSource(externalApps),
  ports: new OriginPorts({
    load: () => {
      const raw = store.appSetting(VIEW_PORTS_KEY)
      if (!raw) return null
      try {
        return JSON.parse(raw) as PortBook
      } catch {
        return null
      }
    },
    save: (book) => store.setAppSetting(VIEW_PORTS_KEY, JSON.stringify(book)),
  }),
  // Under the keeper, the front door's port: the address outlives this host (swap-control.ts)
  hostPort: () => viewPort(launch.frontDoor, port),
})
/*
 * An app view inside a conversation (M4 B-1). When a session's agent calls an app tool with a view,
 * the view opens under that card. Calls are heard through the manager's own attachment, and events
 * go out through the manager's record and broadcast path (inline-views.ts).
 */
const inlineViews = attachInlineViews(mgr, externalApps, views)
/*
 * The views the previous host had open, if it handed them over in a planned ending (#280 step 4,
 * view-handover.ts). Before listen(), so the first client to reconnect already finds them.
 */
if (launch.underKeeper) {
  try {
    const { restored, skipped } = restoreViewHandover(store, views, inlineViews)
    if (restored + skipped > 0) console.error(`[agent-host] app views handed over: ${restored} restored, ${skipped} not`)
  } catch (err) {
    console.error(`[agent-host] could not restore the app views handed over: ${(err as Error).stack ?? err}`)
  }
}
/*
 * `host.stop` (`centralu serve --stop`). The server listens before the endings are wired below, so
 * a request in between is held and acted on once they are, like a signal during startup.
 */
let stopNow: (() => void) | null = null
let stopAsked = false
const stopFromRequest = () => {
  console.error('[agent-host] asked to stop (centralu serve --stop)')
  if (stopNow) stopNow()
  else stopAsked = true
}
/*
 * Linked machines (#82, docs/plans/remote-hub.md): this host is the hub for its own UI, and reaches
 * the hosts of other machines the person linked, each over the person's own ssh. The router stands
 * in front of the RPC handler and sends a call that names another machine's session, project or
 * terminal there; every other call reaches the handler as before. With no machine linked it passes
 * everything through. The links start after listen (below), so a slow ssh never holds up the window.
 */
const links = new Links({
  hub: { version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dev: BUILD === 'dev' },
  broadcast: events.push,
  terminal: screens.push,
  mirror: storeMirror(store),
  registry: storeRegistry(store),
  tunnelFor: (record) => new SshTunnel({ target: record.sshTarget, remote: record.remote, log: (line) => console.error(line) }),
  installer: { runtime: remoteRuntime, script: installScript },
  log: (line) => console.error(line),
})
mgr.useLinkedSessions((id) => links.knowsSession(id))
/**
 * What is running right now, for the one idle rule (`hostBusy`, idle.ts). The keeper's idle exit,
 * the switch's question and applying an update when idle (#352) all read it through the activity
 * report. The session list carries what the rule reads besides the state: pending approvals and
 * questions, and background tasks (#290). Moving one session to a new agent CLI (#297) uses the
 * per-session rule instead (`sessionIdle`, through the manager).
 */
const activity = (): ActivitySnapshot => ({
  sessions: mgr.listSessions(),
  terminals: terminals.liveCount(),
  commandRuns: commandRuns.liveCount(),
})
const router = new Router({
  local: createRpcHandler(mgr, adapters, {
    themes,
    terminals,
    updates,
    agentVersions,
    commands: commandRuns,
    externalApps,
    views,
    inlineViews,
    heldPids: held?.heldPids,
    machines: links,
    stopHost: launch.startedByServe && !launch.underKeeper ? () => stopFromRequest() : undefined,
    activity: () => activityCounts(activity()),
  }),
  machines: () => links.all(),
})
const server = new HostServer({
  port: Number(values.port),
  ...(launch.startedByServe ? { servedBy: 'serve' as const } : {}),
  token,
  allowedOrigins,
  onRpc: router.handle,
  // Every HTTP route sits behind this secret (transport/http.ts)
  http: { secret: httpSecret, routes: views.routes },
  // Which build this is and where it came from, in every hello_ok (#280, keeper-link.ts)
  build: hostBuild(BUILD, launch.keeperSource),
  // A planned swap waits for running RPCs, within a bound (#280 step 3, drain.ts)
  drain: hostDrain,
})
// From here on what services send reaches the server: its replay buffer, then whoever connects
screens.open((f) => server.pushTerminal(f))
events.open((e) => server.broadcast(e))

/*
 * The shutdown, as data (lifecycle/shutdown.ts): run at most once, whatever asks first; every step
 * runs even after one fails. Its steps refer to the services above, so it exists before listen and
 * any ending wired below can use it.
 */
let stopActivity: () => void = () => {}
const shutdown = new Shutdown({
  plan: (mode, handOver) =>
    stopPlan(mode, handOver, {
      handOverViews: () => {
        try {
          const n = recordViewHandover(store, views, inlineViews)
          if (n > 0) console.error(`[agent-host] ${n} open app views handed over to the next host`)
        } catch (err) {
          console.error(`[agent-host] could not hand the open app views over: ${(err as Error).stack ?? err}`)
        }
      },
      terminals,
      commands: commandRuns,
      updates,
      agentVersions,
      stopActivity: () => stopActivity(),
      links,
      apps: externalApps,
      sessions: mgr,
      appChanges,
      themes,
      inlineViews,
      views,
      server,
      store,
      children: held?.children ?? null,
    }),
  log: (line) => console.error(line),
  stopLog,
  exit: (code) => process.exit(code),
  pid: process.pid,
})

start.at('listen')
try {
  port = await server.listen()
} catch (err) {
  console.error(`\n[agent-host] failed to start\n${(err as Error).message}\n`)
  process.exit(1)
}

start.at('ready')
// This line is parsed by the supervisor (the path through which port and token are handed off)
console.log(JSON.stringify({ ready: true, port, token, db: dbPath }))
// What a swap would cost with this build, for the app to say before it asks (#280 step 3, swap-control.ts)
if (launch.underKeeper) console.log(JSON.stringify({ swap: { keepsAgents: KEEPS_AGENTS_ACROSS_SWAP && held !== null } }))
/*
 * The heavy and breaking steps a swap left for later (store.ts, "During a swap"), and a vacuum a
 * stopped host left owed (#396). By the time this timer fires the ready line has gone out and the
 * keeper has pointed the front door here: the host this one replaced is gone, so a breaking step can
 * no longer strand it.
 */
if (swapping && (store.deferredSteps.length > 0 || store.vacuumOwed)) {
  setTimeout(() => {
    try {
      store.runDeferred()
    } catch (err) {
      console.error(`[store] a step left from the swap failed; it runs again on the next start: ${(err as Error).stack ?? err}`)
    }
  }, 0)
}

/*
 * Once right after startup, and then every 6 hours (issue #43). **After listen**: the result goes
 * out as a broadcast, and right after startup is exactly when a new version is most likely to have
 * shipped while the app was closed. People leave this app open for days, so the recurring check
 * is still needed.
 */
updates.start()
// The linked machines (#82): each opens its ssh link in the background and reports through `machine_status`
links.start()
// The installed agent CLIs are read now and every ten minutes (#297); a window gaining focus asks too
agentVersions.start()

// The agents a previous host left running come back live, mid-turn if they were (#280 step 2)
if (held) void mgr.adoptKept(held.kept.agents)

/*
 * The activity report the keeper's idle rule reads (#280, keeper-link.ts). Only under a keeper:
 * stdout is otherwise the ready line's alone.
 */
if (launch.underKeeper) {
  stopActivity = startActivityReport(
    activity,
    // The same stream as the ready line, so the two keep their order
    (line) => void process.stdout.write(`${line}\n`),
  )
}

/*
 * Every way of ending, wired to the one shutdown (lifecycle/endings.ts): signals (and one held
 * while starting), a crash, the parent's pipe with `--watch-parent`, `host.stop`, the keeper's
 * `stop` on the child service, and its drain for a swap.
 */
start.at('endings')
const endings = wireEndings({
  proc: process,
  signals,
  heldChildren: held !== null,
  leave: (mode, handOver) => void shutdown.leave(mode, handOver),
  record: crashRecorder(join(dirname(dbPath), 'host-errors.log'), (line) => console.error(line)),
  stdin: process.stdin,
  watchParent: values['watch-parent'] === true,
  log: (line) => console.error(line),
})
stopNow = endings.stopAsked
if (stopAsked) stopNow()
// The keeper is stopping for good and asks this host to stop its children the way it always did
held?.children.on('stop', endings.keeperStop)

/*
 * The keeper's drain (#280 step 3, swap-control.ts): finish or cut what the host serves itself,
 * detach, let go of the lock, say so, exit. The next host takes over from there.
 */
if (control) {
  onDrain(control, {
    drain: hostDrain,
    // A swap: the next host is already waiting, and it takes the open views over whether or not it
    // takes the agents. With the keeper's child service a detach really hands agents, terminals and
    // commands over (step 2); a signal arriving mid-drain runs no second, different ending.
    detach: () => shutdown.stopServices(signalMode(held !== null), true),
    keepsAgents: KEEPS_AGENTS_ACROSS_SWAP && held !== null,
    release: ownership.release,
    write: (line) => void writeSync(1, `${line}\n`),
    log: (line) => console.error(line),
    exit: (code) => {
      stopLog()
      process.exit(code)
    },
  })
}
start.done()
