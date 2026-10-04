import { parseArgs } from 'node:util'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { appendFileSync, mkdirSync, writeSync } from 'node:fs'
import { DATA_DIR, DATA_DIR_DEV, DATA_DIR_LEGACY } from '@cc/protocol'
import { dataRoot, migrateLegacyDataDir } from './data-dir.js'
import { DEFAULT_ALLOWED_ORIGINS, HostServer, parseAllowedOrigins } from './transport/server.js'
import { ViewHost } from './views/view-host.js'
import { attachInlineViews } from './inline-views.js'
import { OriginPorts, type PortBook } from './views/origin-ports.js'
import { SessionManager } from './sessions/manager.js'
import { Store, StoreTooNewError } from './dev-services/store.js'
import { createAdapters } from './adapters/registry.js'
import { createRpcHandler } from './rpc.js'
import { ExternalApps } from './apps/external/runtime.js'
import { storeRunLedger } from './app-run-ledger.js'
import { storePermissionBook } from './app-permission-book.js'
import { runtimeViewSource } from './app-view-source.js'
import { onExternalAppListChanged } from './app-list-events.js'
import { broadcastAppChanges, broadcastAppRuns } from './app-change-events.js'
import { HOST_APPS } from './apps/registry.js'
import { TerminalService } from './dev-services/terminal.js'
import { CommandRunner } from './dev-services/commands.js'
import { ensureToolPath } from './env-path.js'
import { UpdateService } from './updates.js'
import { acquireInstanceLock, lockConflictMessage } from './dev-services/instance-lock.js'
import { hostLogPath, rotateIfLarge, startupBanner, teeStderrToFile } from './log-file.js'

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

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '5175' },
    token: { type: 'string' },
    db: { type: 'string' },
    /** Exits together if the parent dies (turned on by the Tauri supervisor) */
    'watch-parent': { type: 'boolean' },
    memory: { type: 'boolean', default: false },
  },
})

/** The fact that the data folder was moved, if it was. Recorded once logging is on (see below) */
let movedNote: string | null = null

const token = values.token || process.env.CC_HOST_TOKEN || randomBytes(16).toString('hex')
/*
 * The secret for the HTTP door (M4 P-2). A **different value** from the WebSocket token. Since
 * this value ends up as a path segment in an iframe's address and travels around in a URL, even if
 * it leaks the RPC door must stay closed. There is no way to set it from outside. The address is
 * built by the host as part of the RPC answer, so nobody needs to know this value in advance.
 */
const httpSecret = randomBytes(32).toString('base64url')
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
 * A signal handler must never be attached here.
 *
 * This used to register lock.release() + process.exit(0) on SIGINT/SIGTERM first. Since handlers
 * run in registration order, the real shutdown() registered afterward **never ran at all** — every
 * time it exited, the child processes (claude, codex) were left orphaned and the WAL checkpoint was
 * skipped. Releasing the lock through a single exit hook is enough (it runs last no matter which
 * path led to exit).
 */
process.on('exit', lock.release)

/*
 * A store a newer Centralu wrote, past what this host can read (#292), is refused here, in the same way as a lock
 * conflict: one plain sentence on stderr (host.log) and stdout (the supervisor), then exit 1. The supervisor shows it
 * at once rather than retrying, since a retry gets the same answer. Any other failure to open still throws as before.
 */
let store: Store
try {
  store = new Store(dbPath)
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
 * Tells the manager the host's own address — the bridge of an adapter that cannot attach a tool
 * in-process connects back through this address. Since the port is only decided after listen(),
 * this is given as a function rather than a value.
 */
const mgr = new SessionManager(
  store,
  adapters,
  (e) => server.broadcast(e),
  () => (port ? { url: `ws://127.0.0.1:${port}`, token } : null),
  // Worktrees are created next to the data folder — dev and the packaged app never touch each other's worktrees
  join(dirname(dbPath), 'worktrees'),
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
  reservedIds: HOST_APPS.map((a) => a.id),
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
})
externalApps.refresh()
// An app's place or status changed (A-8) — the sidebar and the fixed view re-read apps.list
onExternalAppListChanged(externalApps, () => server.broadcast({ type: 'external_apps_changed' }))
// Attaches apps to a session (A-5) — the manager and the runtime know nothing about each other; this is where they are wired together
mgr.useExternalApps(externalApps)
const terminals = new TerminalService((f) => server.pushTerminal(f))
// Runner for frequently used commands (#60) — its output rides the same frame lane as the terminal
const commandRuns = new CommandRunner((f) => server.pushTerminal(f))
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
 * it is never done silently — it happens only when they click it.
 */
const AUTO_UPDATE_CHECK_KEY = 'updates.auto'
const updates = new UpdateService((status) => server.broadcast({ type: 'update_status', status }), {
  // On by default when nothing has been saved yet. Since the check is read-only and every failure
  // is swallowed, leaving it on costs nothing, while leaving it off traps **someone who never once
  // opens settings** on an old version forever — that person is exactly the one most likely to stay
  // stale.
  readAuto: () => store.appSetting(AUTO_UPDATE_CHECK_KEY) !== 'false',
  writeAuto: (enabled) => store.setAppSetting(AUTO_UPDATE_CHECK_KEY, String(enabled)),
})
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
  hostPort: () => port ?? null,
})
/*
 * An app view inside a conversation (M4 B-1). When a session's agent calls an app tool with a view,
 * the view opens under that card. Calls are heard through the manager's own attachment, and events
 * go out through the manager's record and broadcast path (inline-views.ts).
 */
const inlineViews = attachInlineViews(mgr, externalApps, views)
const server: HostServer = new HostServer({
  port: Number(values.port),
  token,
  allowedOrigins,
  onRpc: createRpcHandler(mgr, adapters, { terminals, updates, commands: commandRuns, externalApps, views, inlineViews }),
  // Every HTTP route sits behind this secret (transport/http.ts)
  http: { secret: httpSecret, routes: views.routes },
})

let port: number
try {
  port = await server.listen()
} catch (err) {
  console.error(`\n[agent-host] failed to start\n${(err as Error).message}\n`)
  process.exit(1)
}
// This line is parsed by the Tauri supervisor (the path through which port and token are handed off)
console.log(JSON.stringify({ ready: true, port, token, db: dbPath }))

/*
 * Once right after startup, and then every 6 hours (issue #43).
 *
 * **Called after listen.** The check result goes out as a broadcast, and there is no socket to send
 * it to before that. Right after startup is chosen as the first check because that is exactly the
 * moment a new version is most likely to have shipped while the app was closed. Since people leave
 * this app open for days at a time, the recurring check afterward is still needed.
 */
updates.start()

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

process.on('unhandledRejection', (reason) => record('Unhandled rejection', reason))
process.on('uncaughtException', (err) => {
  record('Uncaught exception', err)
  void shutdown()
})

const shutdown = async () => {
  updates.stop()
  /*
   * **The PTY is cut off first.** This used to come after awaiting mgr.disposeAll(), but the Tauri
   * supervisor's budget is 3 seconds, and if this does not finish within that, the host gets
   * SIGKILLed — meaning these two lines never run at all, and a dev server is left orphaned.
   * Cleaning up sessions late still leaves no process behind, but a PTY does. Whichever one lingers
   * is the one that has to go first.
   *
   * (A PTY child has its own session via setsid(), so even the supervisor's group kill cannot reach
   *  it — if this does not kill it, nothing else will.)
   */
  terminals.disposeAll()
  commandRuns.disposeAll()
  // App processes are shut down **in parallel** with session cleanup — the grace period (1 second) overlaps with the session cleanup time
  const appsDown = externalApps.dispose()
  await mgr.disposeAll()
  await appsDown
  appChanges.dispose()
  inlineViews.dispose()
  await views.dispose()
  await server.close()
  store.close()
  // Why it ended becomes the first line of the next investigation — it never disappears silently
  console.error(`[agent-host] shutting down (pid ${process.pid})`)
  stopLog()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

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
    void shutdown()
  }
  process.stdin.on('end', onParentGone)
  process.stdin.on('close', onParentGone)
  process.stdin.on('error', onParentGone)
}
