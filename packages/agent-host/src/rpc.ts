import { scriptLabel } from './mail/script-label.js'
import { relative } from 'node:path'
import type { z } from 'zod'
import { ThemeFiles } from './themes.js'
import { RpcMethods, hubAutoOf, noSuchAppText, setupOfDetection, type RpcMethodName } from '@cc/protocol'
import type { SessionManager } from './sessions/manager.js'
import { searchFiles } from './dev-services/file-search.js'
import type { TerminalHandle, TerminalService } from './dev-services/terminal.js'
import type { CommandRunner } from './dev-services/commands.js'
import { findStrays, stopStrays } from './dev-services/strays.js'
import { gitLogPath } from './dev-services/git.js'
import { rpcError } from './rpc-error.js'
import { createUiCrashLog } from './ui-crash-log.js'

/** Internal handle → protocol shape (history is rendered as a fresh snapshot each time) */
const toInfo = (h: TerminalHandle) => ({
  terminalId: h.id,
  cwd: h.cwd,
  title: h.title,
  history: h.history(),
  alive: h.alive,
})
import type { UpdateService } from './updates.js'
import type { UpdateApplyBroker } from './update-apply.js'
import type { HostRequests } from './host-requests.js'
import type { AgentVersionService } from './agent-versions.js'
import type { SessionSleeper } from './sessions/sleep.js'
import type { StopGate } from './lifecycle/stop-gate.js'
import { resultText, type ExternalApps } from './apps/external/runtime.js'
import { openHomeView } from './app-home-view.js'
import { askBuilder, sendErrorToBuilder } from './builder-requests.js'
import { orchestratorToolSchemas } from './sessions/orchestrator-tools.js'
import type { AgentAdapter, ToolSetupControl } from './adapters/contract.js'
import type { ViewHost } from './views/view-host.js'
import type { MailPerson } from './mail/person.js'
import type { InlineViews } from './inline-views.js'
import type { CredentialsReport } from './lifecycle/serve-credentials.js'
import type {
  HostActivity,
  HostHandover,
  HubOffer,
  MachineAutostartResult,
  MachineInfo,
  MachineInstallResult,
  MachineProbe,
  MachineUninstallResult,
  RemoteShell,
  SshHostList,
  ToolName,
} from '@cc/protocol'

/**
 * The optional services a host has. Without one, that feature simply does not exist on this host
 * (tests wire in only what they need).
 * Received by name — so that as more services get added later, there is never a spot that has to
 * count in `undefined` placeholders.
 */
export type RpcServices = {
  /**
   * A project was deleted or sessions left the trash for good: a deleted project that a user-folder app had become gives
   * that folder back once nothing in the trash can restore it (#1204, `UserAppAdoption.settle`)
   */
  settleDeletedProjects?: () => Promise<void>
  /** What deleting a project may do to its folder (#1301, `UserAppAdoption.outlook`); absent: nothing does */
  deleteOutlook?: (projectId: string) => Promise<'stays' | 'may_move' | 'around_may_move' | 'unsure'>
  terminals?: TerminalService
  updates?: UpdateService
  commands?: CommandRunner
  /**
   * The external app runtime (M4 A). Optional like the other services — without it, this is a host
   * with no external apps. When projects are added or removed or trust changes, **this door**
   * tells the runtime to rescan: the manager does not know the runtime (the core does not know
   * apps), and the runtime does not know the manager.
   */
  externalApps?: ExternalApps
  /** App view hosting (M4 B-3) — the sandbox proxy's address and the resource a view reads */
  views?: ViewHost
  /** An app view inside a conversation (M4 B-1) — the instance a session's app call opened. Closing it also updates this side's record */
  inlineViews?: InlineViews
  /** Pids of the children the keeper holds for this host (#280 step 2) — never offered as strays */
  heldPids?: () => Promise<number[]>
  /** The themes folder (#312, themes.ts) */
  themes?: ThemeFiles
  /** The installed agent CLIs, and moving sessions to them (#297, agent-versions.ts) */
  agentVersions?: AgentVersionService
  /** Putting idle sessions to sleep (#568, sessions/sleep.ts) */
  sleeper?: SessionSleeper
  /** Linked machines (#82, links/links.ts). Without it this host links to nothing */
  machines?: MachinesPort
  /**
   * Ends this host the way a signal would (`host.stop`, for `centralu serve --stop`). Called after
   * the answer is on its way. Absent under the app's keeper, which stops a host itself and would only
   * start it again: the call is refused there. `forUpdate` (#1618): a linked hub's update stops it, and the turns it ends are
   * listed for the host it starts next
   */
  stopHost?: (o: { forUpdate: boolean }) => void
  /** `host.stop {ifIdle}`'s check and refusal of new work (#1224, lifecycle/stop-gate.ts); without it `ifIdle` is refused */
  stopGate?: StopGate
  /** Where `host.handover` is kept and said (#1224) */
  handover?: (h: HostHandover | null) => void
  /** What would stop if this host stopped now (`host.activity`, idle.ts `activityCounts`) */
  activity?: () => HostActivity
  /** The windows' answers to an agent's "Apply now" (#665, update-apply.ts) */
  updateApply?: UpdateApplyBroker
  /**
   * The hubs linked to this host that offer the reverse direction (#550, links/linked-hubs.ts): `host.hubOffer` records
   * one on the connection it came in on. Without it an offer is taken and forgotten, as a host that cannot call back
   */
  hubs?: { offer(client: number, o: HubOffer): void }
  /** The person's side of the mailbox (#1347, mail/person.ts); without it this host has no Inbox mail */
  mail?: MailPerson
  /** The calls of the limited credential waiting for the person (#1405, host-requests.ts) */
  requests?: Pick<HostRequests, 'list' | 'answer'>
  /** A `centralu serve` host's full credentials as the launcher lists them (#1405, `host.credentials`); absent or null: none */
  serveCredentials?: (nonce?: string) => CredentialsReport | null
}

/** What the `machines.*` methods need from the hub's links (links/links.ts) */
export type MachinesPort = {
  list(): MachineInfo[]
  add(spec: { name: string; sshTarget: string; shell: RemoteShell; wslDistro?: string | null; command?: string | null }): MachineInfo
  remove(id: string): Promise<void>
  reconnect(id: string, opts?: { start?: boolean }): MachineInfo
  /** Closes the link until the person connects it again (#1134) */
  disconnect(id: string): Promise<MachineInfo>
  /** One of the machine's other full credentials withdrawn there (#1405) */
  revokeCredential(id: string, credentialId: string): Promise<MachineInfo>
  /** Auto reconnect on or off (#1341) */
  setAutoReconnect(id: string, autoReconnect: boolean): MachineInfo
  acceptVersions(id: string): MachineInfo
  install(id: string): Promise<MachineInstallResult>
  /** `unasked`: no one approved it, automatic updates cover it (#1508); it stops no session it cannot see */
  update(id: string, opts?: { when?: 'idle' | 'now'; unasked?: boolean }): Promise<MachineInstallResult>
  /** Ends an update's wait for the sessions there to finish (#1399) */
  cancelUpdate(id: string): MachineInfo
  rollback(id: string): Promise<MachineInstallResult>
  uninstall(id: string): Promise<MachineUninstallResult>
  /** The ssh config's hosts, and what one target runs (#514) */
  sshHosts(): Promise<SshHostList>
  probe(sshTarget: string): Promise<MachineProbe>
  /** Tells every connected machine this hub's auto-compact setting (#1376); best effort, a machine from before it keeps applying nothing */
  offerAutoCompact?(): Promise<void>
  autostart(id: string, on?: boolean): Promise<MachineAutostartResult>
  activity(id: string): Promise<HostActivity | null>
  /** That machine's "Allow auto from a linked computer", read or set over the link (#1273 review) */
  hubAuto(id: string, allowed?: boolean): Promise<'on' | 'off' | 'older' | 'unreachable'>
  /** The reverse direction's switch for one machine (#550) */
  setAsks(id: string, on: boolean): Promise<MachineInfo>
  /** Every connected machine on an older release starts following this hub's version (#1508), as automatic updates went on */
  followHub?(): void
}

type RpcContext = { client: number; rights?: 'full' | 'limited'; label?: string | null; covered?: boolean }

/** RPC routing. Parameters are validated exactly once, at the boundary (docs/protocol.md §4) */
export function createRpcHandler(
  mgr: SessionManager,
  adapters: Map<ToolName, AgentAdapter>,
  { settleDeletedProjects, deleteOutlook, terminals, updates, commands, externalApps, views, inlineViews, heldPids, themes, agentVersions, sleeper, machines, stopHost, stopGate, handover, activity, updateApply, hubs, mail, requests, serveCredentials }: RpcServices = {},
) {
  const reportUiCrash = createUiCrashLog((line) => console.error(line))
  const requireThemes = (): ThemeFiles => {
    if (!themes) throw rpcError('Theme files are unavailable')
    return themes
  }
  /** The pids the keeper holds for this host, or null when the keeper could not answer: a stop must not guess (`stopStrays`) */
  const heldOrUnknown = async (): Promise<number[] | null> => (heldPids ? heldPids().catch(() => null) : [])
  const requireTerminals = (): TerminalService => {
    if (!terminals) throw rpcError('Terminals are unavailable')
    return terminals
  }
  const requireCommands = (): CommandRunner => {
    if (!commands) throw rpcError('Command runs are unavailable')
    return commands
  }
  const requireExternalApps = (): ExternalApps => {
    if (!externalApps) throw rpcError('External apps are unavailable')
    return externalApps
  }
  const requireViews = (): ViewHost => {
    if (!views) throw rpcError('App views are unavailable')
    return views
  }
  const requireAgentVersions = (): AgentVersionService => {
    if (!agentVersions) throw rpcError('Agent version checks are unavailable')
    return agentVersions
  }
  const requireSleeper = (): SessionSleeper => {
    if (!sleeper) throw rpcError('Putting sessions to sleep is unavailable on this host')
    return sleeper
  }
  const requireMachines = (): MachinesPort => {
    if (!machines) throw rpcError('Linked machines are unavailable on this host')
    return machines
  }
  const requireMail = (): MailPerson => {
    if (!mail) throw rpcError('The mailbox is unavailable on this host')
    return mail
  }
  const requireUpdates = (): UpdateService => {
    if (!updates) throw rpcError('Update checks are unavailable')
    return updates
  }
  /** A tool's own install and sign-in (#59); a tool installed and signed in from a terminal says so */
  const toolSetup = (tool: string): ToolSetupControl => {
    const a = adapters.get(tool)
    if (!a) throw rpcError(`Unknown tool: ${tool}`, 'tool_not_installed')
    if (!a.setup) throw rpcError(`${a.descriptor.label} is installed and signed in from a terminal: ${a.descriptor.install}`, 'refused')
    return a.setup
  }

  /*
   * These methods read their parameters themselves, as they always did, because something comes first: `host.credentials` and
   * `host.stop` accept no parameters (`p ?? {}`) and `host.stop` checks it can stop; the rest ask for an optional service
   * (`requireX()`, `service?.`) before the parse, so a host without it answers that, not a validation error. Every other
   * method has its parameters parsed once, by the dispatcher below.
   */
  const raw = {
    'host.credentials': async (p: unknown) => serveCredentials?.(RpcMethods['host.credentials'].params.parse(p ?? {}).nonce) ?? { credentials: null },
    'host.stop': async (p: unknown) => {
      if (!stopHost) {
        throw rpcError('This host runs under the Centralu app, which stops it: quit the app instead')
      }
      const { ifIdle, forUpdate } = RpcMethods['host.stop'].params.parse(p ?? {})
      if (ifIdle) {
        if (!stopGate) throw rpcError('This host cannot tell whether it is idle')
        // No await from the check to the refusal: nothing can start in between (lifecycle/stop-gate.ts)
        const running = stopGate.busy()
        if (running) return { ok: false as const, ...running }
        stopGate.refuse()
      }
      // After this answer has been written: the shutdown closes the socket it travels on
      setTimeout(() => stopHost({ forUpdate: forUpdate === true }), 50)
      return { ok: true as const }
    },
    'agents.versions': async (p: unknown) => requireAgentVersions().check(RpcMethods['agents.versions'].params.parse(p).force),
    'agents.setAutoApplyVersions': async (p: unknown) =>
      requireAgentVersions().setAutoApply(RpcMethods['agents.setAutoApplyVersions'].params.parse(p).enabled),
    'agents.applyVersions': async (p: unknown) => requireAgentVersions().applyNow({ keepQuiet: RpcMethods['agents.applyVersions'].params.parse(p).keepQuiet === true }),
    'agents.setSleepPolicy': async (p: unknown) => requireSleeper().setAfterMinutes(RpcMethods['agents.setSleepPolicy'].params.parse(p).afterMinutes),
    'mail.resume': async (p: unknown) => {
      requireMail().resume(RpcMethods['mail.resume'].params.parse(p))
      return { ok: true as const }
    },
    'mail.wake': async (p: unknown) => {
      requireMail().wake(RpcMethods['mail.wake'].params.parse(p).wake)
      return { ok: true as const }
    },
    'apps.inlineViews': async (p: unknown) => inlineViews?.list(RpcMethods['apps.inlineViews'].params.parse(p).sessionId) ?? [],
    'apps.importPrepare': async (p: unknown) => requireExternalApps().prepareImport(RpcMethods['apps.importPrepare'].params.parse(p).source),
    'apps.importCancel': async (p: unknown) => {
      requireExternalApps().cancelImport(RpcMethods['apps.importCancel'].params.parse(p).token)
      return { ok: true as const }
    },
    'projects.deleteOutlook': async (p: unknown) => ({ folder: (await deleteOutlook?.(RpcMethods['projects.deleteOutlook'].params.parse(p).projectId)) ?? 'stays' }),
    'terminal.close': async (p: unknown) => {
      requireTerminals().close(RpcMethods['terminal.close'].params.parse(p).terminalId)
      return { ok: true as const }
    },
    'themes.import': async (p: unknown) => requireThemes().importFrom(RpcMethods['themes.import'].params.parse(p).path),
    'themes.resolve': async (p: unknown) => ({ path: requireThemes().pathOf(RpcMethods['themes.resolve'].params.parse(p).id) }),
    'machines.add': async (p: unknown) => {
      return requireMachines().add(RpcMethods['machines.add'].params.parse(p))
    },
    'machines.probe': async (p: unknown) => requireMachines().probe(RpcMethods['machines.probe'].params.parse(p).sshTarget),
    'machines.reconnect': async (p: unknown) => requireMachines().reconnect(RpcMethods['machines.reconnect'].params.parse(p).machineId),
    'machines.disconnect': async (p: unknown) => requireMachines().disconnect(RpcMethods['machines.disconnect'].params.parse(p).machineId),
    'machines.install': async (p: unknown) => requireMachines().install(RpcMethods['machines.install'].params.parse(p).machineId),
    'machines.cancelUpdate': async (p: unknown) => requireMachines().cancelUpdate(RpcMethods['machines.cancelUpdate'].params.parse(p).machineId),
    'machines.rollback': async (p: unknown) => requireMachines().rollback(RpcMethods['machines.rollback'].params.parse(p).machineId),
    'machines.uninstall': async (p: unknown) => requireMachines().uninstall(RpcMethods['machines.uninstall'].params.parse(p).machineId),
    'machines.activity': async (p: unknown) => ({ activity: await requireMachines().activity(RpcMethods['machines.activity'].params.parse(p).machineId) }),
    'machines.acceptVersions': async (p: unknown) =>
      requireMachines().acceptVersions(RpcMethods['machines.acceptVersions'].params.parse(p).machineId),
    'updates.status': async (p: unknown) => requireUpdates().check(RpcMethods['updates.status'].params.parse(p).force),
    'updates.setAuto': async (p: unknown) => requireUpdates().setAuto(RpcMethods['updates.setAuto'].params.parse(p).enabled),
  } satisfies Record<string, (p: unknown, ctx?: RpcContext) => Promise<unknown>>

  /** The answer of a method that only does something: `ack(work)` runs the work as an argument and answers `{ ok: true }` */
  const ack = (_done?: unknown) => ({ ok: true as const })

  const handlers: { [M in Exclude<RpcMethodName, keyof typeof raw>]: (p: z.output<(typeof RpcMethods)[M]['params']>, ctx?: RpcContext) => Promise<unknown> } = {
    // A script (the limited credential) that starts a session with a first message owes nobody a wait: the work is the person's, reported to their Inbox (§8.1)
    'agents.createSession': async (p, ctx) => mgr.createSession({ ...p, ...(ctx?.rights === 'limited' ? { fromScript: { credential: scriptLabel(ctx.label) } } : {}) }),
    'agents.send': async ({ sessionId, text, attachments, intent }, ctx) => {
      // A script (the limited credential) is not the person typing: its text is stored and handed on as the script's, under the label of its connection (§8.1)
      const fromScript = ctx?.rights === 'limited' ? { credential: scriptLabel(ctx.label) } : undefined
      await mgr.send(sessionId, text, attachments, undefined, true, intent, fromScript)
      return { ok: true as const }
    },
    'agents.reportOwed': async (p) => ({ owed: mgr.reportOwed(p.sessionId) }),
    'agents.respondApproval': async ({ sessionId, requestId, decision, scope, matcher }) => ack(mgr.respondApproval(sessionId, requestId, decision, scope, matcher)),
    'agents.answerQuestion': async ({ sessionId, requestId, answers }) => ack(mgr.answerQuestion(sessionId, requestId, answers)),
    'agents.models': async (p) => mgr.toolQueries.listModels(p.tool),
    'agents.interrupt': async (p) => ack(mgr.interrupt(p.sessionId)),
    'agents.stopBackgroundTask': async ({ sessionId, taskId }) => ack(await mgr.sessionSettings.stopBackgroundTask(sessionId, taskId)),
    'agents.clearBackgroundTasks': async (p) => ack(mgr.sessionSettings.clearBackgroundTasks(p.sessionId)),
    // Deleting moves the session to the trash (#204); only the trash.* methods below remove anything for good
    'agents.deleteSession': async ({ sessionId, deleteWorktree, deleteExternal }) => ack(await mgr.trashSession(sessionId, deleteWorktree, deleteExternal)),
    // The window's archive of a session that looks idle: only when nothing is lost (#1512)
    'agents.archiveIfAtRest': async ({ sessionId, deleteExternal }) => {
      return mgr.trash.archiveIfAtRest(sessionId, deleteExternal)
    },
    // What the window's archive dialog lists before it moves anything (#1595)
    'agents.archiveLosses': async ({ sessionId }) => {
      return { asks: mgr.trash.archiveLosses(sessionId) }
    },
    // A hub's start_agent child deleted with the worktree made for it, when nothing would be lost (#1161 item 3)
    'agents.deleteAgentChild': async ({ sessionId, worktreeBranch }) => {
      return mgr.worktrees.deleteHubChild(sessionId, worktreeBranch)
    },
    'agents.exportHandoffRecord': async ({ sessionId, toTool }) => {
      return mgr.handoffNotes.exportHandoffRecord(sessionId, toTool)
    },
    'agents.exportHandoffNote': async ({ sessionId, afterSeq }) => {
      return mgr.handoffNotes.exportHandoffNote(sessionId, afterSeq)
    },
    'agents.autoCompact': async (p) => mgr.autoCompactFor(p.sessionId),
    'agents.worktreeStatus': async (p) =>
      mgr.worktreeStatus(p.sessionId),
    'agents.mcpProposals': async () => ({ proposals: mgr.mcpProposals() }),
    'agents.resolveMcpProposal': async ({ name, approve }) => {
      const r = await mgr.orchestratorSlot.resolveMcpProposal(name, approve)
      if (!r.ok) throw rpcError(r.error ?? 'unknown proposal')
      return { ok: true as const }
    },
    'agents.skillProposals': async () => ({ proposals: mgr.orchestratorSlot.skillProposals() }),
    'agents.resolveSkillProposal': async ({ name, approve }) => {
      const r = await mgr.orchestratorSlot.resolveSkillProposal(name, approve)
      if (!r.ok) throw rpcError(r.error ?? 'unknown proposal')
      return { ok: true as const }
    },
    'agents.orchestratorSkills': async () => ({ skills: mgr.orchestratorSlot.orchestratorSkills() }),
    'agents.deleteOrchestratorSkill': async ({ name }) => {
      const r = await mgr.orchestratorSlot.deleteOrchestratorSkill(name)
      if (!r.ok) throw rpcError(r.error ?? 'unknown skill')
      return { ok: true as const }
    },
    'agents.listExternalSessions': async ({ projectId, tool, limit }) => {
      return mgr.externals.listExternalSessions(projectId, tool, limit)
    },
    'agents.restartSession': async (p) =>
      mgr.restartSession(p.sessionId),
    'agents.resumeSession': async (p) =>
      mgr.resumeSession(p.sessionId),
    'agents.forkConversation': async (p) =>
      mgr.forkConversation(p.sessionId),
    'agents.updateSettings': async (p) => {
      /*
       * **Fields are never pulled out one at a time.**
       *
       * When effort was added, pulling it out here was overlooked, and the UI sent it but it never
       * reached the host — nothing happened, silently, with no error. Passing the parsed result
       * through whole means this spot never needs fixing again as more settings are added.
       */
      const { sessionId, by, ...settings } = p
      return await mgr.updateSettings(sessionId, settings, by ?? 'person')
    },
    'agents.switchTool': async ({ sessionId, tool }) => {
      return mgr.switchTool(sessionId, tool)
    },
    'agents.capabilities': async ({ tool }) => {
      const a = adapters.get(tool)
      if (!a) throw rpcError(`Unknown tool: ${tool}`, 'tool_not_installed')
      return a.capabilities
    },
    'agents.sleepPolicy': async () => requireSleeper().policy(),
    'agents.detect': async () =>
      Promise.all(
        [...adapters.values()].map(async (a) => {
          const { installed, loggedIn, detail, setup } = await a.detect()
          // Every tool in one shape (#59): the header's donut reads `setup.state` for each, whoever installs and signs it in
          return { ...a.descriptor, installed, loggedIn, detail, setup: setup ?? setupOfDetection(installed, loggedIn) }
        }),
      ),
    'agents.installTool': async (p) => toolSetup(p.tool).install(),
    'agents.cancelInstallTool': async (p) => toolSetup(p.tool).cancelInstall(),
    'agents.signIn': async (p) => toolSetup(p.tool).signIn(),
    'agents.cancelSignIn': async (p) => toolSetup(p.tool).cancelSignIn(),
    'git.status': async (p) => mgr.files.gitStatusFiles(p.projectId),
    'git.diff': async ({ projectId, path, staged }) => {
      return mgr.files.gitDiff(projectId, path, staged)
    },
    'git.log': async ({ projectId, limit }) => {
      return mgr.files.gitLog(projectId, limit)
    },
    'git.commitDetail': async ({ projectId, sha }) => {
      return mgr.files.gitCommitDetail(projectId, sha)
    },
    'git.branches': async (p) => mgr.files.gitBranches(p.projectId),
    'git.ignoredEntries': async (p) =>
      mgr.files.gitIgnoredEntries(p.projectId),
    'git.checkout': async ({ projectId, branch, dryRun }) => {
      return mgr.files.gitCheckout(projectId, branch, dryRun)
    },
    'git.stage': async ({ projectId, paths, unstage }) => ack(await mgr.files.gitStage(projectId, paths, unstage)),
    'git.commit': async ({ projectId, message }) => {
      return mgr.files.gitCommit(projectId, message)
    },
    'git.push': async (p) => mgr.files.gitPush(p.projectId),
    'git.cancel': async (p) => mgr.files.gitCancel(p.projectId),
    'attachments.save': async ({ sessionId, name, mime, dataBase64 }) => {
      return mgr.record.saveAttachment(sessionId, name, mime, dataBase64)
    },
    'fs.listDir': async ({ projectId, path }) => {
      return mgr.files.listDir(projectId, path)
    },
    'fs.watch': async ({ projectId, paths }, ctx) => {
      // Each window's set is its own, and the watchers are the union (#842 item 6)
      return { watched: mgr.files.watchDirs(projectId, paths, ctx?.client) }
    },
    'fs.readFile': async ({ projectId, path, sessionId }) => {
      return mgr.files.readTextFile(projectId, path, sessionId)
    },
    'fs.move': async ({ projectId, from, toDir }) => {
      return mgr.files.moveEntry(projectId, from, toDir)
    },
    'fs.importFile': async ({ projectId, toDir, name, dataBase64 }) => {
      return mgr.files.importFile(projectId, toDir, name, dataBase64)
    },
    'fs.resolve': async ({ projectId, path, purpose, sessionId }) => {
      return { path: await mgr.files.resolveFile(projectId, path, purpose, sessionId) }
    },
    'messages.search': async ({ query, limit }) => {
      return mgr.searchMessages(query, limit)
    },
    'mail.list': async () => requireMail().list(),
    'mail.thread': async ({ threadId, after, all, tail, before }) => {
      return requireMail().thread(threadId, { after, all, tail, before })
    },
    'mail.reply': async ({ threadId, text, kind }) => {
      return requireMail().reply(threadId, text, kind)
    },
    'mail.close': async ({ threadId, outcome }) => {
      return requireMail().close(threadId, outcome)
    },
    'mail.reassign': async ({ threadId, sessionId, text }) => {
      return requireMail().reassign(threadId, sessionId, text)
    },
    'mail.unblock': async ({ threadId, n }) => {
      return requireMail().unblock(threadId, n)
    },
    'mail.held': async ({ action, recipient, messageIds }) => {
      return requireMail().held(action, recipient, messageIds)
    },
    'approvals.deleteRule': async (p) => ack(mgr.approvalRules.deleteApprovalRule(p.id)),
    'workspace.save': async (p) => ack(mgr.prefs.saveWorkspace(p.layout)),
    'workspace.load': async () => mgr.prefs.loadWorkspace(),
    // The orchestrator's add_project registers through the same `addProject` and apps refresh (#1220, `registerFolder`)
    'projects.add': async (p) => {
      const info = await mgr.addProject(p.path)
      externalApps?.refresh()
      return info
    },
    'projects.inspect': async (p) => mgr.projectCreation.inspectFolder(p.path),
    'projects.create': async ({ name, parent, source }) => {
      const info = await mgr.projectCreation.createProject(name, parent, source)
      externalApps?.refresh()
      return info
    },
    'projects.createPreview': async ({ name, parent, source }) => {
      return mgr.projectCreation.projectCreatePreview(name, parent, source)
    },
    'orchestrator.get': async () => mgr.orchestrator(),
    'orchestrator.peek': async () => mgr.orchestratorSlot.orchestratorPeek(),
    'orchestrator.configure': async (p) => ack(mgr.orchestratorSlot.configureOrchestrator(p.tool)),
    'apps.viewFrame': async ({ appId, projectId, instanceId, hostOrigin }) => {
      return requireViews().frame({ app: { appId, projectId }, instanceId, hostOrigin })
    },
    // A hub asks this of the machine a view is open on, and serves the view in its own window (remote-hub.md §11)
    'apps.viewDocument': async ({ instanceId }) => {
      const d = await requireViews().document(instanceId)
      return { appId: d.app.appId, projectId: d.app.projectId, uri: d.uri, origin: d.origin, resource: d.resource as { contents: unknown[] } }
    },
    'apps.openView': async ({ appId, projectId, lease, openKey }, ctx) => {
      // A window that asks for a lease holds the view through its connection (#392); an older window's view lives until closed
      return openHomeView(requireExternalApps(), requireViews(), { appId, projectId }, lease && ctx ? ctx.client : undefined, openKey)
    },
    'apps.recoverView': async ({ appId, projectId, openKey, lease }, ctx) => {
      const prior = requireViews().homeOpen({ appId, projectId }, openKey, lease && ctx ? ctx.client : undefined)
      if (prior) return prior
      // No reservation survived (a crash, an eviction, or an older host). Repeating a home tool is unsafe.
      throw new Error('The original app open could not be recovered — the home tool may or may not have run; check before opening again')
    },
    'apps.holdViews': async ({ instanceIds }, ctx) => {
      if (!ctx) throw rpcError('App views are held through a window connection')
      return { missing: requireViews().hold(instanceIds, ctx.client) }
    },
    'apps.closeView': async ({ instanceId }) => {
      // If it is a view inside a conversation, that side closes it (along with its own record). Otherwise it is the fixed view
      if (!inlineViews?.close(instanceId)) requireViews().close(instanceId)
      return { ok: true as const }
    },
    'apps.inlineReopen': async ({ sessionId, callId }) => {
      if (!inlineViews) throw rpcError('App views are unavailable')
      return inlineViews.reopen(sessionId, callId)
    },
    // A host with no app runtime holds no views either — a reopened UI shows nothing but "open app"
    'apps.viewMessage': async ({ sessionId, instanceId, text }) => {
      /*
       * The app is decided by **the instance** — whatever the caller claims is only checked against
       * it (#93, #94).
       *   A view inside a conversation  the destination is also decided by the instance (the
       *     conversation that view belongs to). Claiming a different conversation is rejected
       *   A fixed view                  does not belong to any conversation — the destination is
       *     whichever conversation the person picked (the UI asks, and only calls this after they pick)
       * Either way it goes through the same path (sendFromApp) into the same frame (an app's
       * message) — so a fixed view's message never leaks in as if it were the person's own.
       */
      const owner = inlineViews?.owner(instanceId) ?? null
      if (owner && owner.sessionId !== sessionId) {
        throw rpcError('This app view is not open in that conversation')
      }
      const ref = owner?.ref ?? views?.describe(instanceId)?.app ?? null
      if (!ref) throw rpcError('This app view is not open')
      const name = externalApps?.list().find((a) => a.appId === ref.appId && a.projectId === ref.projectId)?.name
      await mgr.sendFromApp(sessionId, text, { appId: ref.appId, projectId: ref.projectId, name: name ?? ref.appId }, owner ? 'inline' : 'pinned')
      return { ok: true as const }
    },
    'apps.readResource': async ({ appId, projectId, uri, instanceId }) => {
      // The shape of the answer is known between the view and the app. Here, only enough is checked to keep the envelope from breaking
      return RpcMethods['apps.readResource'].result.parse(await requireViews().readResource({ appId, projectId }, uri, instanceId))
    },
    'apps.invoke': async ({ appId, name, args, projectId, instanceId }) => {
      // The instance is used only as the cause of "changed" — so that view does not hear the change
      // it caused itself (B-5). Unrelated to permissions
      const caller = { kind: 'view' as const, ...(instanceId ? { instanceId } : {}) }
      const out = await requireExternalApps().call({ appId, projectId: projectId ?? null }, name, args, caller)
      return {
        text: out.result ? resultText(out.result) : (out.error ?? ''),
        isError: out.status !== 'ok',
        status: out.status,
        runId: out.runId,
        result: out.result ?? undefined,
      }
    },
    'apps.list': async () => externalApps?.list() ?? [],
    'apps.runs': async ({ appId, projectId, limit }) => {
      return requireExternalApps().runs({ appId, projectId }, limit)
    },
    'apps.restart': async ({ appId, projectId }) => ack(await requireExternalApps().restart({ appId, projectId })),
    'apps.remove': async ({ appId, projectId }) => ack(await requireExternalApps().removeUserApp({ appId, projectId })),
    'apps.setSecret': async (p) => {
      // The value goes straight to the runtime here — this layer never records it and never returns it
      const { appId, projectId, name, value } = p
      requireExternalApps().updateSecret({ appId, projectId }, name, value)
      return { ok: true as const }
    },
    'apps.setShared': async (p) => {
      // Sharing a project app with the person's other projects (#371 part A) — the manager stores it and recounts sessions
      const { appId, projectId, shared } = p
      mgr.apps.setAppShared({ projectId, appId }, shared)
      return { ok: true as const }
    },
    // Import (M4 E-3) — prepare (waiting room) → the person looks it over → admit (disabled at first,
    // with a review step if requested). All the judgment calls are made by the runtime's handoff
    'apps.importCommit': async ({ token, enable, reviewKey, parent }) => {
      // An import lands as a project of its own (#1141): `<parent>/<id>`, `~/Centralu` unless the person chose a parent
      requireExternalApps()
      return mgr.appSessions.commitImport(token, { enable, ...(reviewKey !== undefined ? { reviewKey } : {}) }, parent)
    },
    'apps.review': async ({ appId, projectId }) => {
      return requireExternalApps().reviewApp({ appId, projectId })
    },
    'apps.enable': async ({ appId, projectId, reviewKey }) => {
      return requireExternalApps().enableApp({ appId, projectId }, reviewKey)
    },
    /*
     * App versions (M4 E-1). For a user-folder app, versions are snapshots the runtime took; for a
     * project app, they are git — the recent commits that touched that app's folder are read here
     * (the core). The runtime does not know git (`host-app-runtime-physics-only`): deciding what
     * counts as a version, based on where the app lives, is the core's call.
     */
    'apps.versions': async ({ appId, projectId }) => {
      const apps = requireExternalApps()
      // A user-folder app, or a root app outside git (#1141): the copies Centralu keeps. Otherwise git's history
      if (apps.keepsVersions({ appId, projectId })) return { kind: 'snapshots' as const, snapshots: apps.snapshots({ appId, projectId }).map(({ stamp: _stamp, depth: _depth, ...s }) => s) }
      const project = (await mgr.listProjects()).find((x) => x.id === projectId)
      const app = apps.list().find((a) => a.appId === appId && a.projectId === projectId)
      if (!project || !app) throw rpcError(noSuchAppText({ projectId, appId }))
      const { repo, commits } = await gitLogPath(project.path, relative(project.path, app.dir), 20)
      return { kind: 'git' as const, repo, commits }
    },
    'apps.restoreVersion': async ({ appId, projectId, id }) => {
      return requireExternalApps().restoreVersion({ appId, projectId }, id)
    },
    'apps.create': async (p) => mgr.appSessions.createApp(p),
    'apps.builder': async ({ appId, projectId }) => {
      return mgr.appSessions.builderOf({ appId, projectId })
    },
    'apps.errors': async ({ appId, projectId }) => {
      return requireExternalApps().errors({ appId, projectId })
    },
    'apps.reach': async ({ sessionId, appId, projectId }) => {
      return mgr.apps.appReach(sessionId, { appId, projectId })
    },
    'apps.check': async ({ appId, projectId }) => {
      const r = await mgr.appSessions.checkApp({ appId, projectId })
      return { ok: r.ok, text: r.text, findings: r.findings }
    },
    // A capability question (M4 D-4) — one from a chain started by a view. One started by a session
    // comes through `agents.respondApproval` as that session's own approval card
    'apps.questions': async () => mgr.hostCards.appQuestionList(),
    'apps.answerQuestion': async ({ questionId, decision }) => ack(mgr.hostCards.answerAppQuestion(questionId, decision)),
    'apps.permissions': async ({ appId, projectId }) => {
      return requireExternalApps().permissions({ appId, projectId })
    },
    'apps.forgetPermission': async ({ appId, projectId, capability }) => ack(requireExternalApps().forgetPermission({ appId, projectId }, capability)),
    // Cross-project consents (#371) — the host owns them; Settings lists and revokes
    'projectConsents.list': async () => mgr.consents.projectConsents(),
    'projectConsents.revoke': async ({ fromProjectId, toProjectId, kind }) => ack(mgr.consents.revokeProjectConsent(fromProjectId, toProjectId, kind)),
    'apps.usage': async ({ appId, projectId }) => {
      return requireExternalApps().agentUse({ appId, projectId })
    },
    'apps.createBuilder': async ({ appId, projectId, tool }) => {
      return mgr.appSessions.createAppBuilder({ appId, projectId }, tool)
    },
    'apps.sendError': async ({ appId, projectId, at }) => {
      return sendErrorToBuilder(
        { apps: requireExternalApps(), views, builderOf: (ref) => mgr.appSessions.builderOf(ref), send: (id, t, a) => mgr.send(id, t, a) },
        { appId, projectId },
        at,
      )
    },
    'apps.askBuilder': async ({ appId, projectId, text, attachments, instanceId }) => {
      return askBuilder(
        { apps: requireExternalApps(), views, builderOf: (ref) => mgr.appSessions.builderOf(ref), send: (id, t, a) => mgr.send(id, t, a) },
        { ref: { appId, projectId }, text, attachments, instanceId },
      )
    },
    'orchestrator.tools': async ({ sessionId }) => {
      // The full list when no session is given (for compatibility) — only that session's bundle when one is known (#69: the manager takes a subset)
      if (!sessionId) return orchestratorToolSchemas('orchestrator')
      // A session with no bundle is offered nothing — the full list here would advertise tools its calls are refused
      const profile = mgr.toolProfileOf(sessionId)
      return profile ? orchestratorToolSchemas(profile) : []
    },
    'orchestrator.tool': async ({ sessionId, name, args }) => {
      return mgr.runOrchestratorTool(sessionId, name, args)
    },
    'apps.sessionTools': async ({ sessionId, server }) => {
      return { tools: await mgr.apps.appSessionTools(sessionId, server) }
    },
    'apps.sessionCall': async ({ sessionId, server, name, args, waitMs }) => {
      return mgr.apps.callAppForSession(sessionId, server, name, args, waitMs)
    },
    'grid.get': async () => mgr.layout.grid(),
    'grid.set': async (p) => mgr.layout.setGridView(p.panels),
    /*
     * Not listed with no protection (#841 item 7): a keeper that could not answer made every agent it holds a stray,
     * offered to be stopped on quit. The stop refuses that case already; the list says it too.
     */
    'processes.strays': async () => {
      const held = await heldOrUnknown()
      if (held === null) throw rpcError('The keeper could not say which processes it holds for this host, so leftover processes cannot be told apart; try again')
      return findStrays(mgr.projectRegistry.folderRoots(), process.pid, held)
    },
    'processes.stop': async (p) =>
      stopStrays(p.pids, mgr.projectRegistry.folderRoots(), process.pid, await heldOrUnknown()),
    'projects.list': async () => mgr.listProjects(),
    'projects.origin': async (p) => ({ origin: await mgr.files.projectOrigin(p.projectId) }),
    'projects.reorder': async (p) =>
      mgr.projectRegistry.reorderProjects(p.orderedIds),
    'projects.delete': async ({ projectId }) => {
      /*
       * That project's terminals and Run-menu executions are also ended here (#177). Both use the
       * path as their key, and the manager does not know about them, so this door does it. The path
       * is read **before** the row is deleted — after deletion, cwdOfProject throws Project not
       * found, leaving neither the view nor this door any way to reach that process (this used to
       * be the spot where a port stayed held until the app quit). If deletion fails, the project
       * remains, so its terminal is left in place too.
       */
      let cwd: string | null = null
      try {
        cwd = mgr.cwdOfProject(projectId)
      } catch {
        // No such project — nothing to clean up
      }
      await mgr.deleteProject(projectId)
      if (cwd !== null) {
        terminals?.closeCwd(cwd)
        commands?.stopCwd(cwd)
      }
      externalApps?.refresh()
      // After the refresh, which stops its apps: a folder an app works in does not move on Windows
      void settleDeletedProjects?.()
      return { ok: true as const }
    },
    'projects.setTrusted': async ({ projectId, trusted }) => {
      // The toggle answers at once; the project's idle sessions restart behind it (#663)
      void mgr.setProjectTrusted(projectId, trusted).catch((err) => console.error('[sessions] restarting for a trust change failed:', err))
      externalApps?.refresh()
      return { ok: true as const }
    },
    'projects.setCommands': async ({ projectId, commands }) => {
      return mgr.projectRegistry.setProjectCommands(projectId, commands)
    },
    'worktrees.setTrunk': async ({ projectId, baseBranch }) => ack(await mgr.projectRegistry.setWorktreeTrunk(projectId, baseBranch)),
    'projects.setAgentInstructions': async ({ projectId, text }) => ack(mgr.setAgentInstructions(projectId, text)),
    'projects.setWorktreeSetup': async ({ projectId, setup }) => ack(mgr.projectRegistry.setWorktreeSetup(projectId, setup)),
    'sessions.reorder': async ({ projectId, orderedIds }) => {
      return mgr.layout.reorderSessions(projectId, orderedIds)
    },
    'projects.gitStatus': async ({ projectId }) => {
      return mgr.projectRegistry.projectGitStatus(projectId)
    },
    'sessions.list': async () => mgr.listSessions(),
    'sessions.rename': async ({ sessionId, name }) => ack(mgr.rename(sessionId, name)),
    'sessions.clearError': async ({ sessionId, seq }) => {
      return { ok: true as const, ...mgr.clearError(sessionId, seq) }
    },
    'sessions.markRead': async ({ sessionId, seq }) => ack(mgr.sessionSettings.markRead(sessionId, seq)),
    'messages.load': async ({ sessionId, limit, beforeSeq }) => {
      return mgr.loadMessages(sessionId, limit, beforeSeq)
    },
    'messages.image': async ({ sessionId, path }) => {
      return mgr.record.messageImage(sessionId, path)
    },
    'messages.subagent': async ({ sessionId, parentCallId, afterSeq, limit }) => {
      return mgr.loadSubagentMessages(sessionId, parentCallId, afterSeq, limit)
    },
    'messages.subagentTrashed': async ({ sessionId, parentCallId }) => {
      return mgr.trash.subagentTrashed(sessionId, parentCallId)
    },
    'agents.commands': async (p) =>
      mgr.toolQueries.listCommands(p.sessionId),
    'agents.usage': async ({ tool, limits, settle }) => {
      return mgr.toolQueries.usageFor(tool, { limits, settle })
    },
    'usage.history': async (p) => mgr.usageHistory(p),
    'agents.account': async (p) => mgr.toolRegistry.accountFor(p.tool),
    'files.search': async ({ projectId, query, limit }) => {
      return searchFiles(mgr.cwdOfProject(projectId), query, limit, mgr.projectRegistry.gitTrust(projectId))
    },
    'terminal.list': async ({ projectId }) => {
      // A terminal's key is the **directory**, not the project (preparation for worktrees)
      const cwd = mgr.cwdOfProject(projectId)
      return { terminals: requireTerminals().list(cwd).map(toInfo) }
    },
    'terminal.create': async ({ projectId, cols, rows }) => {
      return toInfo(requireTerminals().create(mgr.cwdOfProject(projectId), cols, rows))
    },
    'terminal.input': async ({ terminalId, data }) => ack(requireTerminals().input(terminalId, data)),
    'terminal.resize': async ({ terminalId, cols, rows }) => ack(requireTerminals().resize(terminalId, cols, rows)),
    'terminal.restart': async ({ terminalId, cols, rows }) => {
      const h = requireTerminals().restart(terminalId, cols, rows)
      if (!h) throw rpcError('Terminal not found')
      return toInfo(h)
    },
    // Runner for frequently used commands (#60) — the same cwd rule as the terminal (preparation for worktrees)
    'commands.run': async ({ projectId, command, cols, rows }) => {
      const { history: _h, ...rest } = requireCommands().run(mgr.cwdOfProject(projectId), command, cols, rows)
      return rest
    },
    'commands.stop': async ({ projectId, command }) => ack(requireCommands().stop(mgr.cwdOfProject(projectId), command)),
    'commands.state': async ({ projectId }) => {
      return { runs: requireCommands().state(mgr.cwdOfProject(projectId)) }
    },
    'commands.log': async ({ projectId, command }) => {
      return { run: requireCommands().log(mgr.cwdOfProject(projectId), command) }
    },
    'commands.resize': async ({ projectId, command, cols, rows }) => ack(requireCommands().resize(mgr.cwdOfProject(projectId), command, cols, rows)),
    'prefs.get': async () => mgr.uiPreferences(),
    'prefs.set': async (p) => {
      const patch = p.patch
      const saved = mgr.setUiPreferences(patch)
      // The hub's setting governs the machines it links (#1376): they are told at once, and at every connect
      if (patch.autoCompact) void machines?.offerAutoCompact?.()
      return saved
    },
    'themes.list': async () => requireThemes().list(),
    'themes.save': async ({ id, content }) => {
      return requireThemes().save(id, content)
    },
    'approvals.rules': async () => mgr.approvalRules.listApprovalRules(),
    /*
     * The session archive (#204; "trash" until #1404, kept in the method names because the protocol only grows).
     * These are the person's: this handler is reached over the UI's socket and, for the central
     * orchestrator's trash commands (#1219, `trash-flow.ts`), through the router; its deletes for good wait for the
     * person's card. The other agents' tools (`orchestrator-tools.ts`) and the apps' broker (`broker.ts`, `host_data`)
     * have no verb for any of it.
     */
    'trash.list': async () => mgr.trash.listTrash(),
    'trash.read': async ({ sessionId, limit, beforeSeq }) => {
      return mgr.trash.readTrashed(sessionId, limit, beforeSeq)
    },
    'trash.restore': async (p) => {
      const r = await mgr.trash.restoreSession(p.sessionId)
      // A project registered again is a project added — its apps are read the same way (`projects.add`)
      if (r.project) externalApps?.refresh()
      return r
    },
    'trash.purge': async (p) => {
      await mgr.trash.purgeSession(p.sessionId)
      void settleDeletedProjects?.()
      return { ok: true as const }
    },
    'trash.empty': async () => {
      const r = await mgr.trash.emptyTrash()
      void settleDeletedProjects?.()
      return r
    },
    // The records of deleted app-agent sessions (#378), the person's like the rest of the trash
    'trash.readRun': async ({ runId, limit, beforeSeq }) => {
      return mgr.trash.readTrashedRun(runId, limit, beforeSeq)
    },
    'trash.purgeRuns': async (p) => mgr.trash.purgeTrashedRuns(p.runIds),
    // A session's subagent steps, to the trash without it and back (#418): the person's too, like the rest of the trash
    'subagents.usage': async () => mgr.trash.subagentUsage(),
    'subagents.trash': async (p) => mgr.trash.trashSubagentSteps(p.sessionId),
    'trash.restoreSubagentSteps': async (p) => ack(await mgr.trash.restoreSubagentSteps(p.sessionId)),
    'trash.purgeSubagentSteps': async ({ sessionId, upTo }) => ack(await mgr.trash.purgeSubagentSteps(sessionId, upTo)),
    // Linked machines (#82). The hub's own: the router never forwards these (links/routes.ts)
    'machines.list': async () => machines?.list() ?? [],
    'machines.sshHosts': async () => requireMachines().sshHosts(),
    'machines.remove': async ({ machineId }) => {
      await requireMachines().remove(machineId)
      // Its asks' cards close with it (#550 review)
      mgr.closeMachineAskCards(machineId)
      return { ok: true as const }
    },
    'machines.revokeCredential': async ({ machineId, credentialId }) => {
      return requireMachines().revokeCredential(machineId, credentialId)
    },
    'machines.setAutoReconnect': async ({ machineId, autoReconnect }) => {
      return requireMachines().setAutoReconnect(machineId, autoReconnect)
    },
    'machines.update': async ({ machineId, when }, ctx) => {
      /*
       * A limited caller's update that went without a card (#1508, method-rights.ts; the transport's verdict, not judged again here)
       * stops no session it cannot see and gives up once automatic updates go off, as the hub's own catch-up does
       */
      const unasked = ctx?.covered === true
      return requireMachines().update(machineId, { when: when ?? 'idle', ...(unasked ? { unasked } : {}) })
    },
    'machines.autostart': async ({ machineId, on }) => {
      return requireMachines().autostart(machineId, on)
    },
    'machines.hubAuto': async ({ machineId, allowed }) => {
      return { state: await requireMachines().hubAuto(machineId, allowed) }
    },
    // The reverse direction (#550): the switch per machine, and the pairs approved on this computer's card
    'machines.setAsks': async ({ machineId, on }) => {
      const machine = await requireMachines().setAsks(machineId, on)
      // Off closes what still stands: the card would only be refused once answered (#550 review)
      if (!on) mgr.closeMachineAskCards(machineId)
      return machine
    },
    'machines.askConsents': async () => {
      const names = new Map((machines?.list() ?? []).map((m) => [m.id, m.name]))
      return mgr.machineAskConsents((id) => names.get(id))
    },
    'machines.withdrawAsk': async ({ machineId, sessionId, projectId }) => ack(mgr.withdrawMachineAsk(machineId, sessionId, projectId)),
    'host.hubOffer': async (p, ctx) => {
      const offer = p
      if (hubs && ctx) hubs.offer(ctx.client, offer)
      return { ok: true as const }
    },
    'host.activity': async () => {
      if (!activity) throw rpcError('This host does not report its activity')
      return activity()
    },
    // What a hub's orchestrator reads of this host's sessions (#82 phase 4, docs/plans/remote-hub.md §12)
    'host.sessions': async () => mgr.hostReader().sessions(),
    'host.readSession': async ({ sessionId, limit, around, tools, offset, toolLines, maxChars, before, from }) => {
      return mgr.hostReader().read(sessionId, limit, {
        around,
        tools: toolLines ?? tools,
        ...(offset !== undefined ? { offset } : {}),
        ...(maxChars !== undefined ? { maxChars } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(from !== undefined ? { from } : {}),
      })
    },
    'host.lastAnswer': async ({ sessionId, maxChars, turn }) => {
      return mgr.hostReader().lastAnswer(sessionId, maxChars, turn)
    },
    'host.recall': async ({ query, limit }) => {
      return mgr.hostReader().recall(query, limit)
    },
    // Whether a hub's auto session's child here runs auto (#1273): the hub reads it before it decides on its card
    'host.hubAuto': async () => ({ allowed: hubAutoOf(mgr.uiPreferences()) }),
    // Who else holds full access here (#1405): the hub's machine row reads it between links
    // The hub's Settings → Machines sets it for a machine with no window of its own (#1273 review)
    'host.setHubAuto': async (p) => ({ allowed: hubAutoOf(mgr.setUiPreferences({ hubAuto: p.allowed })) }),
    'host.send': async ({ sessionId, text, from, ask }) => ack(await mgr.sendFromHub(sessionId, text, from.name, ask)),
    'updates.setAutoApply': async (p) => {
      const enabled = p.enabled
      const status = requireUpdates().setAutoApply(enabled)
      // Automatic updates cover the linked machines too (#1508): one found older starts following now, not at its next connect
      if (enabled) machines?.followHub?.()
      return status
    },
    // Answers once the install has started, not once it has finished — see the note on
    // `updates.apply` in the protocol. The rest arrives as `update_status` events.
    'updates.apply': async () => requireUpdates().apply(),
    // A window's answer and report for an agent's "Apply now" (#665). Without the broker (tests) nothing is waiting
    'updates.answerApply': async (p, ctx) => {
      const a = p
      return updateApply && ctx ? updateApply.answer(ctx.client, a) : { ticket: null }
    },
    // The person's answers to the limited credential's calls (#1405). Without the service (tests) nothing ever waits
    'requests.list': async () => requests?.list() ?? [],
    'requests.answer': async (p) => {
      const a = p
      return { ok: requests?.answer(a.requestId, a.decision) ?? false }
    },
    'ui.reportCrash': async (p) => {
      reportUiCrash(p)
      return {}
    },
    'updates.reportApply': async (p, ctx) => {
      const r = p
      if (updateApply && ctx) updateApply.report(ctx.client, r)
      return {}
    },
    'host.handover': async ({ handover: h }) => ack(handover?.(h)),
  }

  const routes: Record<string, ((p: never, ctx?: RpcContext) => Promise<unknown>) | undefined> = { ...raw, ...handlers }

  return async (method: string, params: unknown, ctx?: RpcContext): Promise<unknown> => {
    const name = method as RpcMethodName
    const h = routes[method]
    /*
     * Also the answer to a method this protocol retired (docs/protocol.md §3.2): a window of an older build attached to
     * this host may still call one, and every caller in a released build catches the failure. Not retryable (the
     * transport says so for everything but a swap's cut): asking again gets the same answer.
     */
    if (!h) {
      throw rpcError(`Unknown method: ${method}. This Centralu host does not have it; the window may be from another build.`)
    }
    /*
     * Parsed here, once, by the method's own schema, before anything of the handler runs: a failure is the ZodError a handler
     * parsing for itself threw. A handler that takes no parameter (`async () =>`) never had them looked at, and still has not.
     * The limited credential's rights were judged before this (transport/server.ts), on the parameters as sent.
     */
    const result: unknown = await Reflect.apply(h, undefined, [Object.hasOwn(raw, method) || h.length === 0 ? params : RpcMethods[name].params.parse(params), ctx])

    /*
     * Checks here whether what is being sent out **matches its declared shape.**
     *
     * The 50 result schemas went a long time without ever being run against the runtime — they
     * were documentation only, a promise nobody actually kept. All that time, nothing happened even
     * when the wire diverged from the schema, and it actually diverged twice (the effort field
     * being lost, and the Codex model shape).
     *
     * Before turning this on, 47 of 50 were checked against a real host to confirm the schemas
     * matched the real responses (`pnpm smoke:schemas`). Turning it on without doing that would let
     * a wrong schema kill a perfectly working feature.
     *
     * Why this throws: sending a malformed response through as is makes it show up oddly on the
     * screen, and by then there is no way to tell where it went wrong. This is the closest point to
     * where it actually happened.
     */
    const checked = RpcMethods[name].result.safeParse(result)
    if (!checked.success) {
      const where = checked.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join(' / ')
      throw rpcError(`${method}'s response does not match its declaration — ${where}`)
    }
    return checked.data
  }
}
