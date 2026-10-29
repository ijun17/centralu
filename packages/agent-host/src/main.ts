import { takeLaunchEnv } from './lifecycle/launch-env.js'
import { readHandedToken } from './lifecycle/handed-token.js'
import { StartSequence, refuse } from './lifecycle/start.js'
import { parseArgs } from 'node:util'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, writeSync } from 'node:fs'
import { APP_VERSION, autoCompactOf, errorMessage, PROTOCOL_VERSION, RESERVED_APP_IDS, type HostHandover, type HostLogon, type NormalizedEvent } from '@cc/protocol'
import { hostBuild, startActivityReport } from './keeper-link.js'
import { activityCounts, inTurn, updateAtRest as updateAtRestOf, type ActivitySnapshot } from './idle.js'
import { connectHeldChildren } from './keeper/held-children.js'
import { chooseDataDir, dataRoot, keepDataFolderPrivate, migrateLegacyDataDir, privateDataFolderFor } from './data-dir.js'
import { DEFAULT_ALLOWED_ORIGINS, HostServer, parseAllowedOrigins } from './transport/server.js'
import { deriveHttpSecret } from './transport/http.js'
import { recordViewHandover, restoreViewHandover } from './view-handover.js'
import { ViewHost } from './views/view-host.js'
import { attachInlineViews } from './inline-views.js'
import { OriginPorts, parsePortBook, type PortBook } from './views/origin-ports.js'
import { UserAppAdoption, adoptedProjectOf, adoptedUserApp } from './user-app-adoption.js'
import { SessionManager } from './sessions/manager.js'
import { MailService } from './mail/service.js'
import { MailDelivery } from './mail/delivery.js'
import { askedBy, askerFacts, type AskedByHost } from './mail/asked-by.js'
import { parseAddress } from './mail/address.js'
import { MailPerson } from './mail/person.js'
import { takeOverFromEarlierBuild } from './mail/adoption.js'
import { pausedReportKey, readPausedTasks } from './sessions/child-ownership.js'
import { answerRecorder, closingRecorder, delegationRecorder, finishRecorder, personReportRecorder, personWorkRecorder, reportRecorder, turnRecorder } from './mail/delegation.js'
import { recordedAgentDepth } from './sessions/agent-depth.js'
import { COMMAND_CALLS, PLAIN_CALLS } from './mail/frame.js'
import { MailTool } from './mail/tool.js'
import { MailTurns } from './mail/turns.js'
import { mailRelations } from './mail/relations.js'
import { MemoryGate } from './sessions/memory-gate.js'
import { DEFAULT_RARE_TIER, commandsFor, currentRareTier, rareTierFrom, setRareTier, setReaderInstructions } from './sessions/orchestrator-tools.js'
import { setOrchestratorPreamble } from './sessions/orchestrator-home.js'
import { readShared } from './sessions/app-access.js'
import { Store, StoreTooNewError } from './dev-services/store.js'
import { createAdapters } from './adapters/registry.js'
import { createRpcHandler } from './rpc.js'
import { ExternalApps } from './apps/external/runtime.js'
import { storeRunLedger } from './app-run-ledger.js'
import { storePermissionBook } from './app-permission-book.js'
import { runtimeViewSource } from './app-view-source.js'
import { onExternalAppListChanged } from './app-list-events.js'
import { UpdateApplyBroker } from './update-apply.js'
import { broadcastAppChanges, broadcastAppRuns } from './app-change-events.js'
import { ThemeFiles } from './themes.js'
import { TerminalService } from './dev-services/terminal.js'
import { CommandRunner } from './dev-services/commands.js'
import { ensureToolPath } from './env-path.js'
import { hubUpdatesMachines, UpdateService } from './updates.js'
import { installsByDefault, updateSwitches } from './update-switches.js'
import { installedCopyPath } from './os.js'
import { AgentVersionService } from './agent-versions.js'
import { parseSleepSetting, SessionSleeper, sleepOverrideFrom, storedSleepSetting } from './sessions/sleep.js'
import { acquireInstanceLock, lockConflictMessage } from './dev-services/instance-lock.js'
import { hostLogPath, startupBanner, teeStderrToFile } from './log-file.js'
import { hostDrain } from './drain.js'
import { HostRequests } from './host-requests.js'
import { credentialsReport, readCredentialFile, UsedCredentials, type FullCredential } from './lifecycle/serve-credentials.js'
import { createStopGate } from './lifecycle/stop-gate.js'
import { stopGitChildren } from './dev-services/git-exec.js'
import { Gate } from './lifecycle/gate.js'
import { Shutdown, signalMode, stopPlan } from './lifecycle/shutdown.js'
import { crashRecorder, holdSignals, wireEndings } from './lifecycle/endings.js'
import { clearStoppedMark, markQuit, updateResumeFolder } from './lifecycle/stopped-mark.js'
import { bridgeAddress, ControlChannel, KEEPS_AGENTS_ACROSS_SWAP, onDrain, standby, viewPort } from './swap-control.js'
import { installScript, remoteRuntime } from './links/install.js'
import { Links } from './links/links.js'
import { linkedSessions } from './links/linked-sessions.js'
import { linkedViews } from './links/linked-views.js'
import { Router } from './links/router.js'
import { hubSelfId, linkDepsFor, storeProjectOrder } from './links/stored.js'
import { LinkedHubs } from './links/linked-hubs.js'
import { reverseCalls } from './links/reverse-calls.js'
import { projectsHome } from './dev-services/project-folder.js'
import { parseJson } from './dev-services/store/json.js'
import { asObj } from './json-value.js'
import { flagSetting } from './dev-services/store/settings.js'
import { joinWorkJob, workJobLine, workJobWanted } from './lifecycle/work-job.js'
import { PtyBroker, brokerPtyModule, personOpener } from './dev-services/broker-pty.js'
import { detectToken } from './elevation.js'

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
/*
 * Windows (#1067): this host joins a job that ends what it starts when it ends. Terminals are the person's, not the
 * host's work: their broker is started first, so it is outside the job (dev-services/broker-pty.ts). Asked now, so the
 * PowerShell it takes runs while the store opens; awaited at `work job`, before anything else is started.
 */
let ptyBroker: PtyBroker | null = null
if (workJobWanted(launch)) {
  try {
    ptyBroker = PtyBroker.start()
  } catch (err) {
    // Terminals then start in the host, inside the job: they work, but what is started there ends with the host
    console.error(`[agent-host] ${(err as Error).message}; terminals start in the host`)
  }
}
const workJob = joinWorkJob(launch)
/*
 * The token, when the launcher hands it over on stdin (#538) rather than in the environment. Read before the control
 * channel and the parent watch take stdin, which then see only what follows it. Without it no client could reach
 * this host, so a missing line ends the start (the supervisor's retry gets a fresh pipe).
 */
const handedToken = launch.tokenOnStdin
  ? await readHandedToken(process.stdin).catch((e: Error) => {
      console.error(`[agent-host] the launcher did not hand over the token: ${e.message}`)
      process.exit(1)
    })
  : launch.token

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

const token = values.token || handedToken || randomBytes(16).toString('hex')
/* The token is the keeper's only when the keeper started this host and handed it over (#280 step 4, below) */
const keeperToken = launch.underKeeper && !values.token && handedToken ? token : null
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
  const { dir, legacy } = chooseDataDir()
  movedNote = legacy && migrateLegacyDataDir(legacy, dir) ? `[agent-host] data folder moved: ${legacy} -> ${dir}` : null
  mkdirSync(dir, { recursive: true })
  // Pins attachments, the orchestrator home, and worktrees to all live under here (dev and prod diverge)
  process.env.CC_DATA_DIR = dir
  return join(dir, 'store.db')
}
const dbPath = values.memory ? ':memory:' : (values.db ?? defaultDbPath())
/*
 * The data folder is its owner's only (#838), before the store or the log opens a file in it. Only the data folder
 * itself: a `--db` elsewhere (a test's temp folder, a folder of the person's) is left as it is.
 */
const privateFolder = privateDataFolderFor(dbPath)
const madePrivate = privateFolder ? keepDataFolderPrivate(privateFolder) : []

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
if (madePrivate.length > 0) console.error(`[agent-host] data folder made private: ${madePrivate.join(', ')}`)

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
 * How the orchestrator's rare commands are exposed (#512): the commands tier unless this names another, kept
 * selectable for measurement. Set before any session starts, since a session's tool list is its prompt prefix.
 */
setRareTier(rareTierFrom(process.env.CC_RARE_COMMANDS))
if (currentRareTier() !== DEFAULT_RARE_TIER) console.error(`[agent-host] rare commands: ${currentRareTier()} (CC_RARE_COMMANDS)`)
/*
 * "Use Centralu's features first unless the person says otherwise" (#564): the orchestrator's preamble and the
 * ordinary sessions' tool instructions, both on unless these say 0 (kept for measuring them against their absence)
 */
setOrchestratorPreamble(process.env.CC_ORCHESTRATOR_PREAMBLE !== '0')
if (process.env.CC_ORCHESTRATOR_PREAMBLE === '0') console.error('[agent-host] orchestrator preamble off (CC_ORCHESTRATOR_PREAMBLE)')
setReaderInstructions(process.env.CC_READER_INSTRUCTIONS !== '0')
if (process.env.CC_READER_INSTRUCTIONS === '0') console.error("[agent-host] ordinary sessions' tool instructions off (CC_READER_INSTRUCTIONS)")

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
  // Who started it, for the message a second host on this folder prints (#1223)
  lock = acquireInstanceLock(dbPath, undefined, {
    ...(launch.startedBy ? { by: launch.startedBy } : {}),
    ...(launch.serveFrom ? { from: launch.serveFrom } : {}),
  })
} catch (err) {
  // Ownership could not be checked at all (an unreadable ownership file): not starting is the safe answer (#82)
  refuse(`[agent-host] ${(err as Error).message}`)
  throw err
}
if (!lock.ok) {
  refuse(lockConflictMessage(lock.holder ?? lock.heldByPid, lock.lockPath))
  process.exit(1)
}
/*
 * The lock is released by one exit hook, which runs last whichever path led to the exit (HO5). A
 * signal handler that ends the process must never be attached here: handlers run in the order they
 * were added, and one that released the lock and exited first meant the real shutdown never ran.
 */
const ownership = lock
process.on('exit', ownership.release)
// A host starting here is the person's start again: a linked hub may start one by itself once this one is gone (#1143).
// A host in memory has no data folder to say it in
if (dbPath !== ':memory:') clearStoppedMark(dirname(dbPath))
// The turns an update cut when it stopped the host before this one, and where this one lists those its own update stop ends (#1618)
const updateResume = dbPath === ':memory:' ? undefined : updateResumeFolder(dirname(dbPath))

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
/*
 * What the host opens for the person stays outside its work job (lifecycle/work-job.ts): on Windows the terminal broker,
 * which is outside the job, starts it (Antigravity's sign-in page, review of #1685). Without a broker there is no job of
 * the host's either (or terminals start in the host too, and so does this)
 */
const adapters = createAdapters(personOpener(ptyBroker))

/*
 * Under the keeper, agents, terminals and project commands are spawned by the keeper, not by this
 * host, and a restart leaves them running (#280 step 2, keeper/held-children.ts). What a previous
 * host left there is taken over below. Without a keeper (`pnpm dev`, e2e, a debug app, Windows)
 * this is null and everything is spawned here.
 */
start.at('work job')
const workJobSaid = workJobLine(await workJob)
if (workJobSaid) console.error(workJobSaid)

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
// Putting idle sessions to sleep (#568) hears every session event too: a session that said anything is not quiet
const sleeperRef: { current?: SessionSleeper } = {}
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
    sleeperRef.current?.observe(e)
  },
  (sessionId) => bridgeAddress(launch.frontDoor, port, token, sessionId),
  // Worktrees are created next to the data folder — dev and the packaged app never touch each other's worktrees
  join(dirname(dbPath), 'worktrees'),
  { ...(held ? { processes: held.processes, keptSessions: held.kept.sessionIds } : {}), ...(updateResume ? { updateResume } : {}) },
)
// A new project's default home is this machine's ~/Centralu (#515); wired here, never in tests
mgr.useProjectsHome(() => projectsHome())
// New agent sessions start only while the machine has memory for them (#686); wired here, in tests only where it is the subject
mgr.useMemoryGate(new MemoryGate())
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
  projects: () => store.projects.projectRoots(),
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
  shared: (ref) => readShared(store.settings, ref),
  // A user-folder app registered as a project in place is that project's root app now (#1141)
  adoptedUserApp: (appId, dir) => adoptedUserApp(store, appId, dir),
  adoptedProjectOf: (appId) => adoptedProjectOf(store, appId),
})
externalApps.refresh()
// An app's place or status changed (A-8) — the sidebar and the fixed view re-read apps.list
onExternalAppListChanged(externalApps, () => events.push({ type: 'external_apps_changed' }))
// Attaches apps to a session (A-5) — the manager and the runtime know nothing about each other; this is where they are wired together
mgr.useExternalApps(externalApps)
/*
 * User-folder apps become projects in place (#1141): each one, once, with what was kept under its old key carried to its
 * new one, and the sessions this manager already loaded moved with it. It runs once this host is ready (below).
 */
const userAppAdoption = new UserAppAdoption({
  rt: externalApps,
  store,
  sessionsMoved: (ids, projectId) => mgr.sessionsMovedToProject(ids, projectId),
  changed: () => events.push({ type: 'projects_changed' }),
})
/*
 * The mailbox (#1347, docs/plans/mailbox.md): its model, and the delivery that wakes a receiver with its mail (§5), which starts
 * once the host is ready (below). The host's id is read from the setting a hub already keeps, and only when mail needs it.
 */
const mail = new MailService(store.mail, {
  hostId: () => hubSelfId(store),
  // Who may write to whom (§9.1), read from the sessions that are here
  policy: mailRelations({
    session: (id) => mgr.sessionInfo(id),
    orchestratorAsks: () => mgr.orchestratorAsks(),
    ...mgr.mailSeats(() => commandsFor('orchestrator').includes('mail')),
    inThread: (threadId, address) => store.mail.participants(threadId).some((p) => p.address === address && p.leftAt === null),
  }),
})
// What the host knows of a session and its project, for the cards and headers over a session's request to the orchestrator (§9.7)
const askedByHost: AskedByHost = {
  session: (id) => {
    const s = mgr.sessionInfo(id)
    return s && { name: s.name, projectId: s.projectId }
  },
  project: (id) => store.projects.listProjects().find((p) => p.id === id),
}
// The loop and token guards (§7.9): what turns mail started, and what they used
const mailTurns = new MailTurns(store.mail, {
  keepOpen: (id) => mgr.keptInTurn(id),
  // Whose request a turn is, fixed when it begins (§9.7)
  askerOf: (threadId) => {
    const thread = store.mail.thread(threadId)
    return thread ? mail.requestedBy(thread) : undefined
  },
})
const mailTool = new MailTool(
  mail,
  store.mail,
  (id) => (mgr.toolProfileOf(id) === 'orchestrator' && commandsFor('orchestrator').includes('mail') ? COMMAND_CALLS : PLAIN_CALLS),
  (id) => askerFacts(askedByHost, id),
  () => mgr.orchestratorId(),
  (id) => mailTurns.current(id)?.threadId ?? null,
)
const mailDelivery = new MailDelivery(mail, store.mail, mgr.mailSessions(), {
  turns: mailTurns,
  // A request to the orchestrator from a project nobody trusted waits for the person's Release (§9.7)
  untrustedAsker: (address) => {
    const from = parseAddress(address)
    return from?.kind === 'session' && !askerFacts(askedByHost, from.sessionId).trusted
  },
  // When it last ran: a host that was off a long while does not wake a crowd of sleeping sessions (§7.9). A setting the previous build never reads
  heartbeat: {
    read: () => Number(store.settings.appSetting('mail.heartbeat')) || null,
    write: (ms) => {
      if (store.mail.hasThreads()) store.settings.setAppSetting('mail.heartbeat', String(ms))
    },
  },
})
// The person's side of the mailbox (§10.1) and the news that a thread changed, for the Inbox to read again
const mailPerson = new MailPerson(mail, store.mail, mailDelivery, {
  session: (id) => {
    const s = mgr.sessionInfo(id)
    return s ? { name: s.name, state: s.state } : undefined
  },
})
mail.onChange((c) => events.push({ type: 'mail_changed', threadId: c.threadId, toPerson: c.recipients.includes('person') }))
// A session that goes to the trash leaves the work it held in the mailbox to the person or to nobody (§3.3); one that comes
// to rest, answers a card or is restored may now take the mail it was holding
mgr.useMail({ askedBy: (id) => askedBy(askedByHost, mailTurns, id), sessionGone: (id) => void mail.sessionGone(id), handOver: (from, to, which) => mail.handOver(from, to, which), handOverPreview: (from, to) => mail.handOverPreview(from, to), openWork: (id) => mail.openWorkOf(id), sessionChanged: (id) => mailDelivery.poke(id), sessionEvent: (e, ended) => mailTurns.observe(e, ended), tool: (id, args) => mailTool.run(id, args),
  // Work a session gave another is written down as a thread, beside the old path that delivered it (§8.1)
  delegated: delegationRecorder(
    mail,
    (id) => {
      const s = mgr.sessionInfo(id)
      return s && { projectId: s.projectId, depth: recordedAgentDepth(store.settings, id) }
    },
    mailTurns,
  ),
  waitingOn: (ownerId, childId) => mail.waitingOn(mail.sessionAddress(ownerId), mail.sessionAddress(childId)),
  answered: answerRecorder(mail, store.mail),
  finishedWith: finishRecorder(mail),
  // A session a script or the RPC started with a first message: the person owns the work, and its turn is reported to their Inbox (§8.1)
  personWork: {
    started: personWorkRecorder(mail, (id) => {
      const s = mgr.sessionInfo(id)
      return s && { projectId: s.projectId, depth: recordedAgentDepth(store.settings, id) }
    }),
    owes: (id) => mail.personOwes(mail.sessionAddress(id)),
    report: personReportRecorder(mail, store.mail),
  },
  // A turn's end is a report in the thread, and the owner is told as mail when it can read it (§8.1)
  report: reportRecorder(mail, store.mail, (id) => mailTurns.threadOf(id)),
  // Every turn the mailbox did not start is recorded too: whose it is, and the thread it belongs to (§6)
  turnStarted: turnRecorder(mail, store.mail, mailTurns),
})
// A thread whose work was going and is closed stops its running turn and tells the helper once (3.10)
mail.useClosing(
  closingRecorder(mailTurns, {
    inTurn: (id) => {
      const s = mgr.sessionInfo(id)
      return !!s && inTurn(s.state)
    },
    paused: (id, ownerId) => mgr.pausedFor(id, ownerId),
    workClosed: (c) => void mgr.workClosed(c),
  }),
)
/*
 * Terminal and command output can arrive before the server exists: under the keeper an adopted pty
 * replays its buffered output as soon as it is attached (HO11, lifecycle/gate.ts).
 */
const terminals = new TerminalService(screens.push, held?.ptys ?? (ptyBroker ? brokerPtyModule(ptyBroker) : undefined))
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
 * Installing happens when the person clicks, or by itself with "Automatic updates" on (#352; on unless the person turned
 * it off, owner decision 2026-10-20), and then only once nothing is running; relaunching into the new build is the
 * window's step.
 */
// Both on for a person who never chose (2026-10-20); installing only in the person's desktop app: update-switches.ts
const installByDefault = installsByDefault({
  build: BUILD,
  startedBy: launch.startedBy,
  bundlePath: hostBuild(BUILD, launch.keeperSource).bundlePath ?? null,
  installedCopy: installedCopyPath(),
  env: process.env,
})
const { auto: autoUpdateCheck, autoApply: autoApplyUpdates } = updateSwitches(store.settings, { installByDefault })
// Custom themes are files in <data>/themes, watched so a hand edit shows up live (#312, themes.ts)
const themes = new ThemeFiles(join(dataRoot(), 'themes'), () => events.push({ type: 'themes_changed' }))
await themes.start().catch((e: Error) => console.error(`[themes] the themes folder is unavailable: ${e.message}`))

const updates = new UpdateService((status) => events.push({ type: 'update_status', status }), {
  // A host from source never installs by itself, whatever is stored (#1501 review, `installsByItself`)
  build: BUILD,
  // On by default when nothing has been saved yet. Since the check is read-only and every failure
  // is swallowed, leaving it on costs nothing, while leaving it off traps **someone who never once
  // opens settings** on an old version forever — that person is exactly the one most likely to stay
  // stale.
  readAuto: autoUpdateCheck.read,
  writeAuto: autoUpdateCheck.write,
  readAutoApply: autoApplyUpdates.read,
  writeAutoApply: autoApplyUpdates.write,
})
mgr.useUpdates(updates)
/*
 * An agent's "Apply now" (#665): the windows are asked over the event stream and answer by RPC (update-apply.ts). The
 * server is made further down; it is only read once a call runs, after listen.
 */
const updateApply = new UpdateApplyBroker({ push: (e) => events.push(e), windows: () => server.clientCount })
mgr.useUpdateApply(updateApply)
/*
 * The installed agent CLIs, and moving idle sessions onto them (#297). "Move idle sessions to a newly installed agent
 * CLI" is on unless the person turned it off (the owner's decision, 2026-10-05): a restart only happens when nothing in
 * the session would be lost, the conversation continues through resume, and a line in the conversation says so.
 */
const AUTO_APPLY_AGENT_VERSIONS_KEY = 'agents.autoApplyVersions'
const AGENT_VERSIONS_SEEN_KEY = 'agents.versionsSeen'
const autoApplyAgentVersions = flagSetting(store.settings, AUTO_APPLY_AGENT_VERSIONS_KEY, true)
const agentVersions = new AgentVersionService({
  tools: () => [...adapters.values()].map((a) => ({ tool: a.tool, installedVersion: a.installedVersion?.bind(a) })),
  sessions: mgr,
  // Not listening yet: the first window asks
  publish: (status) => events.push({ type: 'agent_versions', status }),
  readAutoApply: autoApplyAgentVersions.read,
  writeAutoApply: autoApplyAgentVersions.write,
  readSeen: () => asObj(parseJson(store.settings.appSetting(AGENT_VERSIONS_SEEN_KEY))) as Record<string, string>,
  writeSeen: (seen) => store.settings.setAppSetting(AGENT_VERSIONS_SEEN_KEY, JSON.stringify(seen)),
})
// A tool's own install and sign-in (#59) tell every window as they go: no RPC is waiting when a download ends
for (const a of adapters.values()) a.setup?.onChange((setup) => events.push({ type: 'tool_setup', tool: a.tool, setup }))
versionsRef.current = agentVersions
mgr.useVersionHint((tool) => agentVersions.installedNow(tool))
/*
 * Idle sessions go to sleep (#568, sessions/sleep.ts): after 15 minutes by default ("Put idle sessions to sleep after",
 * saved as `agents.sleepAfterMinutes`, `off` for never). `CC_SLEEP_AFTER_MS` sets a shorter quiet period over the
 * setting, for probes and tests.
 */
const SLEEP_AFTER_KEY = 'agents.sleepAfterMinutes'
const sleeper = new SessionSleeper({
  sessions: mgr,
  canSleep: (tool) => !!adapters.get(tool)?.capabilities.sleep,
  readAfterMinutes: () => parseSleepSetting(store.settings.appSetting(SLEEP_AFTER_KEY)),
  writeAfterMinutes: (minutes) => store.settings.setAppSetting(SLEEP_AFTER_KEY, storedSleepSetting(minutes)),
  overrideMs: sleepOverrideFrom(process.env.CC_SLEEP_AFTER_MS),
})
sleeperRef.current = sleeper
if (process.env.CC_SLEEP_AFTER_MS) console.error(`[agent-host] idle sessions sleep after ${sleeper.afterMs() ?? 'never'} ms (CC_SLEEP_AFTER_MS)`)
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
/** The unreadable row last said (#384): every serve reads the book, and the row is said once until it changes */
let portBookSaid: string | null = null
function parseStoredPortBook(raw: string | null): PortBook | null {
  return parsePortBook(raw, (line) => {
    if (portBookSaid === raw) return
    portBookSaid = raw
    console.error(`[agent-host] app_settings.${VIEW_PORTS_KEY} ${line}`)
  })
}
const views: ViewHost = new ViewHost({
  secret: httpSecret,
  allowedOrigins,
  source: runtimeViewSource(externalApps),
  ports: new OriginPorts({
    load: () => parseStoredPortBook(store.settings.appSetting(VIEW_PORTS_KEY)),
    save: (book) => store.settings.setAppSetting(VIEW_PORTS_KEY, JSON.stringify(book)),
    update: (fn) => store.settings.updateAppSetting(VIEW_PORTS_KEY, (raw) => JSON.stringify(fn(parseStoredPortBook(raw)))),
  }),
  // Under the keeper, the front door's port: the address outlives this host (swap-control.ts)
  hostPort: () => viewPort(launch.frontDoor, port),
  // A linked machine's views are served here too, their documents asked of that machine through the router (#82)
  remote: linkedViews((method, params) => router.handle(method, params)),
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
    const { restored, skipped } = restoreViewHandover(store.settings, views, inlineViews)
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
const stopFromRequest = (o: { forUpdate: boolean }) => {
  console.error(`[agent-host] asked to stop (centralu serve --stop${o.forUpdate ? ', for an update' : ''})`)
  // A linked hub's update: the turns this stop ends are listed for the host it starts next (#1618)
  if (o.forUpdate) mgr.stopForUpdate()
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
/** This computer's name as a linked machine shows who sent its session an instruction (`MacBook-Pro`, not `.local`) */
const hubName = (): string => hostname().replace(/\.local$/i, '') || 'a linked computer'
const links = new Links(linkDepsFor(store, {
  hub: { version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, dev: BUILD === 'dev' },
  // The orchestrator also hears a machine's events: a report it asked for waits on a turn there (#82 phase 4)
  broadcast: (e) => {
    events.push(e)
    mgr.observeLinked(e)
  },
  terminal: screens.push,
  installer: { runtime: remoteRuntime, script: installScript },
  log: (line) => console.error(line),
  // A child start_agent started on a machine names the session here that started it as its `askedBy` (#1038); the window draws it in that machine's project and points to it from that session (#1416)
  ownerOf: (sessionId) => mgr.remoteAgentParent(sessionId),
  /*
   * The reverse direction (#550, docs/plans/remote-hub.md §12.7): who this hub is, offered to a machine whose switch is
   * on, and the allowlist a machine's call is answered from (ask_project into this computer's projects, nothing else)
   */
  hubSelf: () => ({ id: hubSelfId(store), name: hubName() }),
  // When agents compact: this hub's setting governs the machines it links (#1376)
  autoCompact: () => autoCompactOf(mgr.uiPreferences()),
  // Automatic updates cover the linked machines too (#1508): one on an older release follows this hub's version; none starts mid-swap
  autoUpdate: () => hubUpdatesMachines({ build: BUILD, current: APP_VERSION, autoApply: autoApplyUpdates.read(), draining: hostDrain.draining }),
  reverse: reverseCalls({
    allowed: (machineId) => store.machines.linkedMachineAsks(machineId),
    projects: () => mgr.projectsForMachines(),
    ask: (machine, params, signal) => mgr.askFromMachine(machine, params, signal),
    selfName: hubName,
  }),
}))
/*
 * The other side of it (#550): the hubs linked to this host that let its sessions ask their projects, each called back
 * on the connection it offered on (`HostServer.call`)
 */
const hubs = new LinkedHubs({ call: (client, method, params, opts) => server.call(client, method, params, opts) })
mgr.useLinkedHubs(hubs)
mgr.useHubName(hubName)
mgr.useLinkedSessions((id) => links.knowsSession(id))
// Grid panels of a linked machine's apps are kept while that machine, and a project app's project, are known (#82)
mgr.useLinkedApps({ linked: (id) => links.linked(id), projectMachine: (id) => links.projectMachine(id) })
// The orchestrator reaches every linked machine's sessions too, each through its own machine (#82 phase 4)
mgr.useLinkedReader(linkedSessions(() => links.all(), (method, params) => router.handle(method, params), hubName()))
// The orchestrator's list_machines reads the list Settings shows (#1220)
mgr.useMachineList(() => links.list())
// And changes them, behind the person's card where it matters (#1219)
mgr.useMachineOps(links)
// And the window's own calls, for its settings commands: the same router the window's socket reaches (#1219)
mgr.useWindowRpc((method, params) => router.handle(method, params))
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
/**
 * Whether the person's Automatic updates are on and the host is idle (#1509): applying an update then is what the host does by
 * itself, so the cards that guard it (an agent's `update_centralu` apply, a script's `updates.apply`) are not raised. `besides`
 * is the session asking, whose own turn is not counted (`hostBusyBesides`). Never while the host drains for a swap
 */
const updateAtRest = (besides?: string): boolean =>
  updateAtRestOf({ automatic: autoApplyUpdates.read(), draining: hostDrain.draining, activity: activity(), ...(besides !== undefined ? { besides } : {}) })
mgr.useUpdateAtRest(updateAtRest)
/**
 * The limited credential's calls that wait for the person (#1405, host-requests.ts): raised while a window that shows
 * them is attached, run through the router once allowed, as a call this host serves (a swap's drain refuses or cuts it)
 */
const requests: HostRequests = new HostRequests({
  emit: (e) => events.push(e),
  rpc: (method, params, ctx) => hostDrain.track(`request ${method}`, () => router.handle(method, params, ctx)),
  canShow: (): boolean => server.showsHostRequests(),
  // Which session a session credential's card says asked (#1405)
  sessionName: (sessionId) => mgr.sessionName(sessionId),
})
/** The full credentials a socket said hello with on this host, for `host.credentials` once they are gone (#1405 review) */
const usedCredentials = new UsedCredentials()
const router: Router = new Router({
  forwarding: (method, params) => mgr.forwarding(method, params),
  local: createRpcHandler(mgr, adapters, {
    // A deleted project gives back the user-folder app it had become, once the session archive cannot restore it (#1204)
    settleDeletedProjects: () => userAppAdoption.settle(),
    // And what a delete may do to the folder, for the dialog that asks (#1301)
    deleteOutlook: (projectId) => userAppAdoption.outlook(projectId),
    // A serve host's full credentials, for the hub's machine row between links (#1405, `host.credentials`)
    // And those a socket said hello with here that went since, before a hub could read them listed (#1405 review)
    serveCredentials: (nonce) => (launch.serveState ? credentialsReport(launch.serveState, (f) => readFileSync(f, 'utf8'), usedCredentials, nonce) : null),
    themes,
    terminals,
    updates,
    agentVersions,
    sleeper,
    commands: commandRuns,
    externalApps,
    views,
    inlineViews,
    heldPids: held?.heldPids,
    machines: links,
    stopHost: launch.startedByServe && !launch.underKeeper ? (o) => stopFromRequest(o) : undefined,
    // `host.stop {ifIdle}`: the check and the refusal of new calls in one step (#1224, lifecycle/stop-gate.ts)
    stopGate: launch.startedByServe && !launch.underKeeper ? createStopGate({ drain: hostDrain, activity: () => activityCounts(activity()) }) : undefined,
    // A sign-in's serve says it waits to take over, or gave up (#1224): kept for every hello, and told to who is connected
    handover: (h) => {
      handover = h
      server.broadcast({ type: 'host_handover', handover: h })
    },
    activity: () => activityCounts(activity()),
    updateApply,
    hubs,
    mail: mailPerson,
    requests,
  }),
  machines: () => links.all(),
  order: storeProjectOrder(store),
})
/*
 * Whether this host runs with administrator rights (#702), for every hello: asked once, while the rest starts, and
 * awaited before the server listens (a few tens of milliseconds for `whoami` on Windows, bounded), so the first hello
 * a hub gets already says it. A hello carries nothing only if `whoami` did not answer within the bound
 */
let elevated: boolean | null = null
// And on Windows which logon it runs in (#1224): one `whoami` answers both
let logon: HostLogon | null = null
/** What a serve in the person's Windows sign-in last said about taking over from this host (#1224, `host.handover`) */
let handover: HostHandover | null = null
const elevation = detectToken().then((t) => {
  elevated = t.elevated
  logon = t.logon
  if (t.elevated) console.error('[agent-host] this host runs with administrator rights (an elevated token, or root): so does every agent it starts')
  if (t.logon === 'network') {
    console.error(
      '[agent-host] this host runs in a network logon (started over ssh), not in the Windows sign-in: Git here cannot use a sign-in saved in Windows Credential Manager',
    )
  }
})
/** Where a `centralu serve` host's full credentials are (#1405), when it is one */
const serveState = launch.serveState
const server = new HostServer({
  port: Number(values.port),
  ...(launch.startedByServe ? { servedBy: 'serve' as const } : {}),
  token,
  /*
   * A `centralu serve` host that takes verifiers (#1405): what it was handed is its key, and the full credentials are
   * the ones serve.json names, read at each hello (lifecycle/serve-credentials.ts)
   */
  ...(serveState
    ? { fullCredentials: () => readCredentialFile(serveState, (f) => readFileSync(f, 'utf8')), onFullHello: (c: FullCredential) => usedCredentials.saw(c) }
    : {}),
  allowedOrigins,
  onRpc: router.handle,
  // A limited call that cannot be undone waits for the person's card (#1405)
  onAsk: (method, params, from, signal): Promise<unknown> => requests.ask(method, params, from, signal),
  // What a conditional right reads of this host (method-rights.ts): an idle update of a machine that follows this hub (#1508), and whether applying an update is what Automatic updates would do now (#1509)
  rightsHost: { followsHub: (machineId) => links.followsHub(machineId), updateAtRest: () => updateAtRest() },
  // A card nobody can see is withdrawn once no window shows them for a while (host-requests.ts)
  onShowing: (count) => requests.showingChanged(count),
  // A session credential names one of this host's sessions, or it is refused at hello (#1405)
  knowsSession: (sessionId) => mgr.hasSession(sessionId),
  // A window's connection ended: the pinned views it leased wait for a claim, then close (#392, view-host.ts)
  onClientGone: (client) => {
    views.holderGone(client)
    // The folders only that window had open stop being watched (#842 item 6)
    mgr.forgetWatchHolder(client)
    // A window told to relaunch closing is its relaunch; one that had not answered is one less to wait for (#665)
    updateApply.clientGone(client)
    // A hub that offered on that connection is not reachable until it offers again (#550)
    hubs.gone(client)
  },
  // Every HTTP route sits behind this secret (transport/http.ts)
  http: { secret: httpSecret, routes: views.routes },
  // Which build this is and where it came from, in every hello_ok (#280, keeper-link.ts)
  build: hostBuild(BUILD, launch.keeperSource),
  // Whether it runs with administrator rights, for a hub linked to it (#702); asked once below
  elevated: () => elevated,
  // Which Windows logon it runs in, for a hub linked to it (#1224); asked with the elevation
  logon: () => logon,
  handover: () => handover,
  // The turns this host continued after an update cut them, for a linked hub's callers (#1618)
  updateContinued: () => mgr.updateContinued(),
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
          const n = recordViewHandover(store.settings, views, inlineViews)
          if (n > 0) console.error(`[agent-host] ${n} open app views handed over to the next host`)
        } catch (err) {
          console.error(`[agent-host] could not hand the open app views over: ${(err as Error).stack ?? err}`)
        }
      },
      terminals,
      commands: commandRuns,
      updates,
      agentVersions,
      sleeper,
      compaction: { stop: () => mgr.stopSelfCompaction() },
      mailDelivery,
      stopActivity: () => stopActivity(),
      git: { stopAll: () => stopGitChildren() },
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
await Promise.race([elevation, new Promise<void>((resolve) => setTimeout(resolve, 3_000).unref())])
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
 * User-folder apps become projects in place (#1141, user-app-adoption.ts) once this host is ready, where the steps a
 * swap left for later run: by then the host it replaced is gone, so a host failing before ready never leaves the
 * previous build serving on copies already marked as moved. One that appears later (an approved MCP server) follows.
 */
setTimeout(() => {
  userAppAdoption.run().catch((e: Error) => console.error(`[apps] moving user-folder apps into projects failed: ${e.message}`))
  userAppAdoption.watch()
}, 0)
/*
 * The mailbox's delivery and its sweep (retention among them) start once the host is ready: by now the host this one replaced
 * is gone, so only one host delivers (§4.2). The sweep is delivery's own, every 60 s.
 */
setTimeout(() => {
  // What an older build did while it served this store (§4.2): its report marks become threads, and the work it finished is closed here
  try {
    takeOverFromEarlierBuild(mail, store, {
      info: (id) => mgr.sessionInfo(id),
      depth: (id) => recordedAgentDepth(store.settings, id),
      paused: (id) => readPausedTasks(store.settings.appSetting(pausedReportKey(id)))?.length ?? null,
    })
  } catch (e) {
    console.error(`[mail] taking over from an older build failed: ${errorMessage(e)}`)
  }
  mailDelivery.start()
}, 0)
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
// Idle sessions go to sleep from now on (#568); the clock of each starts here for this host
sleeper.start()
// A session at rest over the lower share is compacted before its next turn (#1451)
mgr.startSelfCompaction()

// The agents a previous host left running come back live, mid-turn if they were (#280 step 2)
if (held) void mgr.adoptKept(held.kept.agents).then(() => mgr.refreshToolDefinitions())
else void mgr.refreshToolDefinitions()

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
  force: (why) => shutdown.force(why),
  record: crashRecorder(join(dirname(dbPath), 'host-errors.log'), (line) => console.error(line)),
  stdin: process.stdin,
  watchParent: values['watch-parent'] === true,
  log: (line) => console.error(line),
  // The person quit Centralu here: a linked hub must not start a host in this folder by itself (#1143)
  quit: () => {
    if (dbPath !== ':memory:') markQuit(dirname(dbPath))
  },
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
