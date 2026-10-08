import { parseArgs } from 'node:util'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { appendFileSync, mkdirSync, writeSync } from 'node:fs'
import { APP_VERSION, DATA_DIR, DATA_DIR_DEV, DATA_DIR_LEGACY, PROTOCOL_VERSION, RESERVED_APP_IDS } from '@cc/protocol'
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
import { hostLogPath, rotateIfLarge, startupBanner, teeStderrToFile } from './log-file.js'
import { hostDrain } from './drain.js'
import { stopThenClose } from './shutdown.js'
import { bridgeAddress, ControlChannel, KEEPS_AGENTS_ACROSS_SWAP, onDrain, standby, viewPort } from './swap-control.js'
import { installScript, remoteRuntime } from './links/install.js'
import { Links } from './links/links.js'
import { Router } from './links/router.js'
import { SshTunnel } from './links/tunnel.js'
import { storeMirror, storeRegistry } from './links/stored.js'

/**
 * Agent Host entry point.
 * dev: run directly with `pnpm host`. prod: spawned by Tauri as a sidecar (docs/architecture.md §4)
 */

/**
 * The build identifier. The bundler swaps `__CC_BUILD__` for the actual commit
 * (running straight from source has no substitution, so it stays 'dev').
 */
declare const __CC_BUILD__: string | undefined
const BUILD = typeof __CC_BUILD__ === 'string' ? __CC_BUILD__ : 'dev'

/*
 * What the keeper hands over (#280, keeper-link.ts), read once and then taken out of the
 * environment: everything this host spawns (agents, terminals, commands) inherits it otherwise,
 * and none of them has any use for it.
 */
const underKeeper = process.env.CC_KEEPER === '1'
const keeperSource = process.env.CC_HOST_SOURCE
/*
 * The keeper's front door (#280 step 3): the stable address every client reaches this host
 * through, whichever host is current. The Codex bridge is given this rather than the host's own
 * port, because a running codex keeps the bridge it started and a swap must not cut it off.
 */
const frontDoor = process.env.CC_FRONT_DOOR
/*
 * Started by `centralu serve` (docs/agent-host.md §4.7), the one host `host.stop` may end: it has no
 * keeper or window to stop it, and on Windows a launcher can only be killed, which skips the shutdown.
 */
const startedByServe = process.env.CC_SERVE === '1'
delete process.env.CC_KEEPER
delete process.env.CC_HOST_SOURCE
delete process.env.CC_FRONT_DOOR
delete process.env.CC_SERVE

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '5175' },
    token: { type: 'string' },
    db: { type: 'string' },
    /** Exits together if the parent dies (turned on by the Tauri supervisor) */
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
const control = underKeeper ? new ControlChannel(process.stdin) : null

/** The fact that the data folder was moved, if it was. Recorded once logging is on (see below) */
let movedNote: string | null = null

const token = values.token || process.env.CC_HOST_TOKEN || randomBytes(16).toString('hex')
/* The token is the keeper's only when the keeper started this host and handed it over (#280 step 4, below) */
const keeperToken = underKeeper && !values.token && process.env.CC_HOST_TOKEN ? token : null
/*
 * Out of the environment once read: every terminal, agent and command this host starts inherits
 * it otherwise, and a shell in a project has no business holding the key to every RPC. Under a
 * keeper this is the keeper's token, the same for every host it runs (#280 step 3).
 */
delete process.env.CC_HOST_TOKEN
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
const dbPath = values.memory
  ? ':memory:'
  : (values.db ?? defaultDbPath())

/**
 * The data folder.
 *
 * **dev and the packaged app use different folders.** If they shared one, running both at once
 * would leave two hosts holding the same store.db, each keeping a different session list.
 * Since starting dev with the packaged app still running is natural during development, they are
 * kept entirely separate.
 */
function defaultDbPath(): string {
  // Packaged when run from the bundled output, dev when run from source (the supervisor tells this)
  const isDev = process.env.CC_DEV === '1'
  const dir = join(homedir(), isDev ? DATA_DIR_DEV : DATA_DIR)
  const legacy = join(homedir(), isDev ? DATA_DIR_LEGACY.dev : DATA_DIR_LEGACY.prod)
  /*
   * The move happens here, but **announcing it is deferred.**
   *
   * The log file is only opened after this function decides the path. Calling console.error here
   * would send that line into thin air (the parent process's stderr) instead of the file — on the
   * very first move, `host.log` genuinely ended up with nothing in it, even though this is the one
   * line that explains why the folder disappeared.
   */
  movedNote = migrateLegacyDataDir(legacy, dir) ? `[agent-host] data folder moved: ${legacy} -> ${dir}` : null
  mkdirSync(dir, { recursive: true })
  // Pins attachments, the orchestrator home, and worktrees to all live under here (dev and prod diverge)
  process.env.CC_DATA_DIR = dir
  return join(dir, 'store.db')
}


/**
 * **Logging is turned on before anything else.**
 *
 * Everything said below this line (PATH augmentation, instance-lock conflicts, codex's stderr,
 * unhandled rejections) ends up in the file. Turning it on late misses exactly the cases that go
 * wrong at startup — that was exactly the gap that went unseen before.
 */
const stopLog = dbPath === ':memory:' ? () => {} : teeStderrToFile(hostLogPath(dirname(dbPath)))
if (dbPath !== ':memory:') console.error(startupBanner({ build: BUILD, db: dbPath, pid: process.pid }))
// Right after the banner — which startup did the move has to be readable in the same spot
if (movedNote) console.error(movedNote)

// A GUI app does not inherit the login shell's PATH — it has to be augmented first to find the CLI
// (measured). Since it asks the user's own login shell directly, nvm, mise, and manual installs are
// all caught too.
const pathResult = ensureToolPath()
if (pathResult.source !== 'unchanged') {
  console.error(`[agent-host] PATH augmented (${pathResult.source === 'shell' ? 'login shell' : 'default candidates'})`)
}

/*
 * A swap's standby (#280 step 3): checks the store without writing to it, reports, and waits here,
 * before the ownership lock, until the keeper says the running host has let go.
 */
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
 * Two hosts on the same data folder desync the session list and contend over SQLite.
 * Failing to start with a stated reason is better than going quietly wrong.
 */
let lock: ReturnType<typeof acquireInstanceLock>
try {
  lock = acquireInstanceLock(dbPath)
} catch (err) {
  // Ownership could not be checked at all (an unreadable ownership file) — not starting is the safe answer (#82)
  const message = `[agent-host] ${(err as Error).message}`
  console.error(message)
  try {
    writeSync(1, `${message}\n`)
  } catch {
    // stderr (host.log) has it
  }
  process.exit(1)
}
if (!lock.ok) {
  const message = lockConflictMessage(lock.heldByPid, lock.lockPath)
  console.error(message)
  /*
   * Also written to stdout (#184). The desktop supervisor only reads the host's stdout (the same
   * spot as the ready line). Speaking only on stderr left this sentence stuck in host.log, so the
   * supervisor's branch meant to immediately report a lock conflict ("already using this data")
   * never once fired, and after six backoff attempts the screen just showed "exited (code 1)."
   * Written synchronously — process.exit follows right after, and on macOS stdout to a pipe is
   * asynchronous, so a plain write could end the process before the sentence actually got through.
   */
  try {
    writeSync(1, `${message}\n`)
  } catch {
    // Even if stdout is closed, it still made it into stderr (host.log)
  }
  process.exit(1)
}
/*
 * A signal handler that ends the process must never be attached here (the one below only holds
 * the signal for later).
 *
 * This used to register lock.release() + process.exit(0) on SIGINT/SIGTERM first. Since handlers
 * run in registration order, the real shutdown() registered afterward **never ran at all** — every
 * time it exited, the child processes (claude, codex) were left orphaned and the WAL checkpoint was
 * skipped. Releasing the lock through a single exit hook is enough (it runs last no matter which
 * path led to exit).
 */
process.on('exit', lock.release)

/*
 * A signal that arrives before shutdown() exists is held, not obeyed (#82). Until a process has a
 * listener for SIGINT or SIGTERM the kernel's default applies, which ends it on the spot: no
 * shutdown, no WAL checkpoint, and whatever it had started already left behind. The ready line
 * goes out well before the real handlers below are attached (the services start in between), and
 * `centralu serve` measured the gap: a Ctrl+C passed on as soon as the ready line was read killed
 * the host by SIGINT every time, while the same signal 3 s later shut it down cleanly. These only
 * record the signal; the real handlers replace them and act on it (see `pendingSignal` below). A second
 * signal before then exits at once, so a start that hangs can still be stopped from the terminal.
 */
let pendingSignal: NodeJS.Signals | null = null
const holdSignal = (sig: NodeJS.Signals) => {
  // A second one while still starting is someone insisting on a start that hangs: obey it
  if (pendingSignal) process.exit(1)
  pendingSignal = sig
  console.error(`[agent-host] ${sig} while starting; shutting down once started (send it again to stop now)`)
}
process.on('SIGINT', holdSignal)
process.on('SIGTERM', holdSignal)

/*
 * A store a newer Centralu wrote, past what this host can read (#292), is refused here, in the same way as a lock
 * conflict: one plain sentence on stderr (host.log) and stdout (the supervisor), then exit 1. The supervisor shows it
 * at once rather than retrying, since a retry gets the same answer. Any other failure to open still throws as before.
 */
let store: Store
try {
  // Taking over in a swap: only what the previous build can still read runs now (store.ts, "During a swap")
  store = new Store(dbPath, { swap: swapping })
} catch (err) {
  if (!(err instanceof StoreTooNewError)) throw err
  console.error(err.message)
  try {
    writeSync(1, `${err.message}\n`)
  } catch {
    // stderr (host.log) has it
  }
  process.exit(1)
}
const adapters = createAdapters()

/*
 * Under the keeper, agents, terminals and project commands are spawned by the keeper, not by this
 * host, and a restart leaves them running (#280 step 2, keeper/held-children.ts). What a previous
 * host left there is taken over below. Without a keeper — `pnpm dev`, e2e, a debug app, Windows —
 * this is null and everything is spawned here, exactly as before.
 */
const held = underKeeper ? await connectHeldChildren(dirname(dbPath)) : null

/*
 * Tells the manager the host's own address — the bridge of an adapter that cannot attach a tool
 * in-process connects back through this address. Since the port is only decided after listen(),
 * this is given as a function rather than a value.
 */
/*
 * Moving sessions to a newly installed agent CLI (#297) hears every session event: a session that just said something
 * is not quiet yet. Declared ahead of the manager, whose events can start before the service below exists.
 */
const versionsRef: { current?: AgentVersionService } = {}
const mgr = new SessionManager(
  store,
  adapters,
  (e) => {
    server.broadcast(e)
    versionsRef.current?.observe(e)
  },
  () => bridgeAddress(frontDoor, port, token),
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
const appChanges = broadcastAppChanges((e) => server.broadcast(e))
// The run panel's signal is collected separately — a chain started by a read-only tool is reported too, but never wakes a view (app-change-events.ts)
const appRunChanges = broadcastAppRuns((e) => server.broadcast(e))
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
onExternalAppListChanged(externalApps, () => server.broadcast({ type: 'external_apps_changed' }))
// Attaches apps to a session (A-5) — the manager and the runtime know nothing about each other; this is where they are wired together
mgr.useExternalApps(externalApps)
/*
 * Terminal and command output can arrive before `server` below exists. Under the keeper, an
 * adopted pty replays its buffered output as soon as it is attached, and any `await` between here
 * and `new HostServer` lets that output in (the themes folder's start, #329, is one). Reaching
 * `server` then touched it before its declaration ran: every host restart that held a terminal or
 * a dev server crashed with "Cannot read properties of undefined (reading 'pushTerminal')", five
 * times, until the keeper gave up (found 2026-10-05 by scripts/keeper-children-integration.mjs).
 * Until the server is up nobody is connected, so a frame is simply not sent; the services keep
 * their own scrollback, which a screen reads when it attaches.
 */
let serverUp = false
const toScreens = (f: Parameters<HostServer['pushTerminal']>[0]) => {
  if (serverUp) server.pushTerminal(f)
}
const terminals = new TerminalService(toScreens, held?.ptys)
// Runner for frequently used commands (#60) — its output rides the same frame lane as the terminal
const commandRuns = new CommandRunner(toScreens, held?.ptys)
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
// (The watcher can fire before `server` below exists; a change that early has no screen to tell yet.)
const themes = new ThemeFiles(join(dataRoot(), 'themes'), () => {
  try {
    server.broadcast({ type: 'themes_changed' })
  } catch {
    /* not listening yet */
  }
})
await themes.start().catch((e: Error) => console.error(`[themes] the themes folder is unavailable: ${e.message}`))

const updates = new UpdateService((status) => server.broadcast({ type: 'update_status', status }), {
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
  publish: (status) => {
    try {
      server.broadcast({ type: 'agent_versions', status })
    } catch {
      /* not listening yet: the first window asks */
    }
  },
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
  hostPort: () => viewPort(frontDoor, port),
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
if (underKeeper) {
  try {
    const { restored, skipped } = restoreViewHandover(store, views, inlineViews)
    if (restored + skipped > 0) console.error(`[agent-host] app views handed over: ${restored} restored, ${skipped} not`)
  } catch (err) {
    console.error(`[agent-host] could not restore the app views handed over: ${(err as Error).stack ?? err}`)
  }
}
/*
 * Linked machines (#82, docs/plans/remote-hub.md): this host is the hub for its own UI, and reaches
 * the hosts of other machines the person linked, each over the person's own ssh. The router stands
 * in front of the RPC handler and sends a call that names another machine's session, project or
 * terminal there; every other call reaches the handler as before. With no machine linked it passes
 * everything through. The links start after listen (below), so a slow ssh never holds up the window.
 */
/*
 * `host.stop` (`centralu serve --stop`). The server listens before `shutdown` exists below, so a
 * request in between is held and acted on once it does, like a signal during startup.
 */
let stopNow: (() => void) | null = null
let stopAsked = false
const stopFromRequest = () => {
  console.error('[agent-host] asked to stop (centralu serve --stop)')
  if (stopNow) stopNow()
  else stopAsked = true
}
const links = new Links({
  hub: { version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dev: BUILD === 'dev' },
  broadcast: (e) => server.broadcast(e),
  terminal: (f) => toScreens(f),
  mirror: storeMirror(store),
  registry: storeRegistry(store),
  tunnelFor: (record) => new SshTunnel({ target: record.sshTarget, remote: record.remote, log: (line) => console.error(line) }),
  installer: { runtime: remoteRuntime, script: installScript },
  log: (line) => console.error(line),
})
mgr.useLinkedSessions((id) => links.knowsSession(id))
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
    stopHost: startedByServe && !underKeeper ? () => stopFromRequest() : undefined,
    activity: () => activityCounts(activity()),
  }),
  machines: () => links.all(),
})
const server: HostServer = new HostServer({
  port: Number(values.port),
  token,
  allowedOrigins,
  onRpc: router.handle,
  // Every HTTP route sits behind this secret (transport/http.ts)
  http: { secret: httpSecret, routes: views.routes },
  // Which build this is and where it came from, in every hello_ok (#280, keeper-link.ts)
  build: hostBuild(BUILD, keeperSource),
  // A planned swap waits for running RPCs, within a bound (#280 step 3, drain.ts)
  drain: hostDrain,
})
serverUp = true

let port: number
try {
  port = await server.listen()
} catch (err) {
  console.error(`\n[agent-host] failed to start\n${(err as Error).message}\n`)
  process.exit(1)
}
// This line is parsed by the Tauri supervisor (the path through which port and token are handed off)
console.log(JSON.stringify({ ready: true, port, token, db: dbPath }))
// What a swap would cost with this build, for the app to say before it asks (#280 step 3, swap-control.ts)
if (underKeeper) console.log(JSON.stringify({ swap: { keepsAgents: KEEPS_AGENTS_ACROSS_SWAP && held !== null } }))
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
 * Once right after startup, and then every 6 hours (issue #43).
 *
 * **Called after listen.** The check result goes out as a broadcast, and there is no socket to send
 * it to before that. Right after startup is chosen as the first check because that is exactly the
 * moment a new version is most likely to have shipped while the app was closed. Since people leave
 * this app open for days at a time, the recurring check afterward is still needed.
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
const stopActivity =
  underKeeper
    ? startActivityReport(
        activity,
        // The same stream as the ready line, so the two keep their order
        (line) => void process.stdout.write(`${line}\n`),
      )
    : () => {}

/**
 * A single rejection does not kill this process.
 *
 * Node **terminates the process** the moment an unhandled rejection surfaces. Since this host is
 * the parent of every session, one rejection leaking from anywhere **cuts off every live
 * session** — this actually happened once, where adding a project cut off unrelated sessions along
 * with it. On top of that, stderr goes nowhere at all in the packaged app, so there was not even a
 * way to know why it died.
 *
 * So two things are done here:
 *   1. A rejection is **logged loudly, never swallowed,** but the process is kept alive. It is
 *      usually the problem of one request, not a situation where the whole process has become
 *      unusable. Cutting off every session is a far bigger cost.
 *   2. Exceptions and rejections are **recorded to a file.** The next time this happens, nobody has
 *      to guess.
 *
 * uncaughtException is different, because state may have broken — it is recorded, and then this
 * shuts down through the normal path.
 */
const crashLog = join(dirname(dbPath), 'host-errors.log')

function record(kind: string, err: unknown): void {
  const e = err as Error
  const line = `[${new Date().toISOString()}] ${kind}: ${e?.stack ?? String(err)}\n`
  console.error(`[agent-host] ${kind}`, e?.stack ?? err)
  try {
    // Keeps only one generation, the same rule as host.log — on a day when rejections repeat,
    // this file would otherwise silently eat up the user's folder (appending with no rollover has
    // no cap)
    rotateIfLarge(crashLog)
    appendFileSync(crashLog, line)
  } catch {
    // If even the log cannot be written, stderr is the last resort — nothing is thrown again here
  }
}

/**
 * How this host leaves (#280 step 2).
 *
 *   stop    today's ending: agents, terminals and commands are stopped with it. Always the answer
 *           without a keeper, and under one when the keeper itself is stopping ("Quit
 *           completely", "Restart completely", the last window closing with background mode off,
 *           idle exit) — it says so with
 *           `stop` on the child service.
 *   detach  under a keeper that keeps the children: a restart, a build switch, a crash, the keeper's
 *           pipe closing. Nothing is stopped; the next host re-attaches to all of it.
 */
type LeaveMode = 'stop' | 'detach'
const onSignalMode: LeaveMode = held ? 'detach' : 'stop'

process.on('unhandledRejection', (reason) => record('Unhandled rejection', reason))
process.on('uncaughtException', (err) => {
  record('Uncaught exception', err)
  // A crash: nothing is handed over, the state that threw is not one to carry forward (view-handover.ts)
  void shutdown(onSignalMode, false)
})

/**
 * Stops or hands off everything this host holds, without exiting (see LeaveMode). `detach` is also
 * the swap's hook (#280 step 3, onDrain below): the draining host lets go of keeper-held agents,
 * terminals and commands, and the next host re-attaches to them.
 *
 * `handOver` marks a planned ending under the keeper, after which the keeper starts the next host:
 * the open app views are written down for it (view-handover.ts). First, before anything below
 * closes them.
 */
async function stopServices(mode: LeaveMode, handOver: boolean): Promise<void> {
  /*
   * The store closes however the rest goes (#396). It used to close only if every step before it succeeded: one that
   * threw left the store open and its WAL unfolded, and on the signal path the host never reached its exit and waited
   * to be killed. Each close runs whatever the other does, and neither hides the error that came first (shutdown.ts).
   */
  await stopThenClose(
    () => stopServicesBeforeStore(mode, handOver),
    [() => store.close(), () => held?.children.close()],
    (line) => console.error(line),
  )
}

async function stopServicesBeforeStore(mode: LeaveMode, handOver: boolean): Promise<void> {
  if (handOver) {
    try {
      const n = recordViewHandover(store, views, inlineViews)
      if (n > 0) console.error(`[agent-host] ${n} open app views handed over to the next host`)
    } catch (err) {
      console.error(`[agent-host] could not hand the open app views over: ${(err as Error).stack ?? err}`)
    }
  }
  updates.stop()
  versionsRef.current?.stop()
  // The ssh links are this host's children: they end with it, and the next host opens its own
  await links.stop()
  stopActivity()
  if (mode === 'detach') {
    // Released, not killed: the keeper keeps draining them for the next host
    await Promise.all([terminals.detachAll(), commandRuns.detachAll()])
  } else {
    /*
     * **The PTY is cut off first.** This used to come after awaiting mgr.disposeAll(), but the
     * supervisor's budget is 3 seconds, and if this does not finish within that, the host gets
     * SIGKILLed — meaning these two lines never run at all, and a dev server is left orphaned.
     * Cleaning up sessions late still leaves no process behind, but a PTY does. Whichever one
     * lingers is the one that has to go first.
     *
     * (A PTY child has its own session via setsid(), so even the supervisor's group kill cannot
     *  reach it — if this does not kill it, nothing else will. Under the keeper, the keeper's own
     *  stop is the backstop.)
     */
    terminals.disposeAll()
    commandRuns.disposeAll()
  }
  // App processes are shut down **in parallel** with session cleanup — the grace period (1 second) overlaps with the session cleanup time.
  // They stay with the host in both modes (#280 decision 2): a new host starts them again on demand
  const appsDown = externalApps.dispose()
  await (mode === 'detach' ? mgr.detachAll() : mgr.disposeAll())
  await appsDown
  appChanges.dispose()
  themes.close()
  inlineViews.dispose()
  await views.dispose()
  await server.close()
}

let leaving: LeaveMode | null = null
const shutdown = async (mode: LeaveMode, handOver: boolean) => {
  // A second signal while leaving changes nothing: the first decided what happens to the children
  if (leaving) return
  leaving = mode
  await stopServices(mode, handOver).catch((err) => {
    console.error(`[agent-host] a step of shutting down failed; leaving anyway: ${(err as Error).stack ?? err}`)
  })
  // Why it ended becomes the first line of the next investigation — it never disappears silently
  console.error(`[agent-host] shutting down (pid ${process.pid}, ${mode === 'detach' ? 'agents, terminals and commands left running in the keeper' : 'stopped'})`)
  stopLog()
  process.exit(0)
}
/*
 * With the keeper's child service, a signal is a restart: stopping for good comes as `stop` below,
 * first, so a signal after it changes nothing. The next host takes the open views over. Without the
 * service the two cannot be told apart, and nothing is handed over.
 */
process.on('SIGINT', () => void shutdown(onSignalMode, onSignalMode === 'detach'))
process.on('SIGTERM', () => void shutdown(onSignalMode, onSignalMode === 'detach'))
process.off('SIGINT', holdSignal)
process.off('SIGTERM', holdSignal)
// One that came while starting: the same ending it would have had, now that there is one
if (pendingSignal) void shutdown(onSignalMode, onSignalMode === 'detach')
stopNow = () => void shutdown('stop', false)
if (stopAsked) stopNow()
// The keeper is stopping for good and asks this host to stop its children the way it always did. No next host to hand views to
held?.children.on('stop', () => void shutdown('stop', false))

/*
 * The keeper's drain (#280 step 3, swap-control.ts): finish or cut what the host serves itself,
 * detach, let go of the lock, say so, exit. The next host takes over from there.
 */
if (control) {
  onDrain(control, {
    drain: hostDrain,
    // With the keeper's child service, a detach really hands agents, terminals and commands over (step 2)
    detach: async () => {
      // A signal arriving mid-drain must not run a second, different ending
      leaving = held ? 'detach' : 'stop'
      // A swap: the next host is already waiting, and it takes the open views over whether or not it takes the agents
      await stopServices(leaving, true)
    },
    keepsAgents: KEEPS_AGENTS_ACROSS_SWAP && held !== null,
    release: lock.release,
    write: (line) => void writeSync(1, `${line}\n`),
    log: (line) => console.error(line),
    exit: (code) => {
      stopLog()
      process.exit(code)
    },
  })
}

/**
 * Shuts itself down when the parent (the Tauri supervisor) disappears.
 *
 * Since the supervisor keeps stdin open as a pipe, whatever reason the app dies for — a normal
 * exit, a crash, SIGKILL — this pipe closes and EOF arrives. Relying only on an exit hook would
 * leave the host orphaned and still holding its port when force-killed (confirmed by measurement).
 * **Only turned on by an explicit flag** — when stdin is /dev/null (when some other script launches
 * it), EOF also arrives immediately, so deciding this by whether it is a TTY would make it kill
 * itself for the wrong reason (confirmed by measurement).
 */
if (values['watch-parent']) {
  process.stdin.resume()
  const onParentGone = () => {
    console.error('[agent-host] parent process exited; shutting down')
    // The keeper (or the supervisor) is gone: nothing is known to start a next host
    void shutdown(onSignalMode, false)
  }
  process.stdin.on('end', onParentGone)
  process.stdin.on('close', onParentGone)
  process.stdin.on('error', onParentGone)
}
