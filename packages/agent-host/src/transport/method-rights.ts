import type { RpcMethodName } from '@cc/protocol'

/**
 * What a connection holding the **limited** credential may call (#1405).
 *
 * The full token is the window's: it calls everything, and the window shows its own confirmations
 * first. Anything else of this user (an agent, a script an agent wrote, a tool, `pnpm dev:live`) is
 * meant to hold the limited credential (`limited-token.ts`), and each method says what that one does:
 *
 *   everyday   runs: reading, creating and messaging sessions, renaming, what the OS user could do
 *              by hand anyway (git, files, terminals, stopping a process)
 *   asks       irreversible or trust-widening: deletes beyond what the trash brings back, moves out of
 *              reach what the trash does not fully restore, widens what agents, apps or machines may do
 *              without the person, or brings in code that later runs unasked. Waits for the person's
 *              card in the window and runs once allowed (host-requests.ts); refused at once when no
 *              window that shows the card is attached
 *   window     the person's own answers (a card, a question, an apply) and the window's own state,
 *              written whole: refused, and never a card (a card that answers a card means nothing)
 *   link       host-to-host calls of a hub linked to this host, which holds this host's full token
 *   bridge     a session's own tool channel; a Codex bridge has its own credential for it, and through
 *              it a limited caller could act as an `auto` session, whose tool cards are skipped
 *
 * `{ asks, when }` is for a method that asks only for some parameters (raising a preset, turning a switch
 * on); the function is given the parameters as sent, before they are parsed, so it reads them
 * defensively and asks when in doubt. `when` says it in words, for docs/generated/method-rights.md.
 * A method whose answer depends on the host's state too reads it from `RightsHost`, the second argument;
 * a host that gives none (a test, a server without it) makes every such call ask.
 *
 * The table is keyed by `RpcMethodName` with no default, as `ROUTES` is (`links/routes.ts`): a method
 * added to the protocol does not compile until someone decides what the limited credential does with
 * it. The classification and its rule are in docs/security-boundaries.md ("Who holds full power").
 */
export type Rights =
  | 'everyday'
  | 'asks'
  | { readonly asks: (params: unknown, host: RightsHost | null) => boolean; readonly when: string }
  | 'window'
  | 'link'
  | 'bridge'

/** What of the host's state a conditional right reads (main.ts wires it into the server) */
export type RightsHost = {
  /**
   * Whether an idle update of this linked machine is the catch-up to this hub's own version that its automatic updates
   * cover (#1508, `LinkedMachine.followsHub`, the one place the condition lives). False for an id that is not linked
   */
  followsHub(machineId: string): boolean
  /**
   * Whether the person's Automatic updates are on and nothing is running (`hostBusy`, idle.ts): installing the update now is
   * what the host does by itself then (#1509, `UpdateService.setAutoApply`). False while the host drains for a swap
   */
  updateAtRest(): boolean
}

/** The parameters as an object to read fields from; anything else reads as having none */
function fields(params: unknown): Record<string, unknown> {
  return isRecord(params) ? params : {}
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * A preset above `normal` (`auto` never asks), or one that cannot be read, asks. So does `fromHub`: a hub's session
 * carries its own preset with it, and an `auto` one starts this session under `auto` while the hub-auto switch is on
 * (`presetFromHub`, sessions/hub-preset.ts). Only a hub sends it, and a hub holds the token
 */
const presetAbove = (params: unknown): boolean => {
  const p = fields(params).permissionPreset
  if ('fromHub' in fields(params)) return true
  return p !== undefined && p !== 'safe' && p !== 'normal'
}

/**
 * Setting a session's preset to anything but `safe` may raise it (`safe` → `normal`, or to `auto`),
 * and the parameters alone do not say what it was before: ask unless it only narrows to `safe`
 */
const presetRaised = (params: unknown): boolean => {
  const p = fields(params).permissionPreset
  return p !== undefined && p !== 'safe'
}

/** A switch turned on, or a value that is not plainly `false` */
const switchedOn = (key: string) => (params: unknown): boolean => fields(params)[key] !== false

/**
 * The preferences that widen what agents may do, or hide the person's own notice of a card
 * (as the orchestrator's `set_preferences` cards them): a ceiling or depth set at all (raising or
 * removing it), the hub-auto switch turned on, approval notifications or their sound turned off
 */
const prefsWiden = (params: unknown): boolean => {
  const patch = fields(fields(params).patch)
  if ('agentCeiling' in patch || 'agentDepth' in patch) return true
  if ('hubAuto' in patch && patch.hubAuto !== false) return true
  const notify = fields(patch.notifyPolicy)
  return notify.approval === false || notify.sound === false
}

/**
 * An update of a linked machine asks unless it is the catch-up the hub's automatic updates already cover (#1508, owner
 * 2026-10-24): `when` is `idle` or absent (its default), and the machine follows this hub's version (`RightsHost.followsHub`).
 * `now` stops what runs there, so it always asks
 */
const updateAsks = (params: unknown, host: RightsHost | null): boolean => {
  const p = fields(params)
  if (p.when !== undefined && p.when !== 'idle') return true
  return typeof p.machineId !== 'string' || host === null || !host.followsHub(p.machineId)
}

/**
 * Applying an update asks unless the person's Automatic updates are on and the host is idle (#1509, owner 2026-10-24): then the
 * host would install it by itself, and asking guards nothing. A host that gives no state asks
 */
const applyAsks = (_params: unknown, host: RightsHost | null): boolean => host === null || !host.updateAtRest()

export const METHOD_RIGHTS: { readonly [M in RpcMethodName]: Rights } = {
  // Sessions
  'agents.createSession': { asks: presetAbove, when: "the preset is above `normal`, or it carries a hub's preset (`fromHub`)" },
  'agents.send': 'everyday',
  'agents.respondApproval': 'window',
  'agents.answerQuestion': 'window',
  'agents.interrupt': 'everyday',
  'agents.stopBackgroundTask': 'everyday',
  'agents.clearBackgroundTasks': 'everyday',
  /** Moving to the trash drops owed reports, delegations, grants and waiting cards (owner, #1371) */
  'agents.deleteSession': 'asks',
  /** Moves the session to the archive when that loses nothing, and says so otherwise (#1512): the card names the move */
  'agents.archiveIfAtRest': 'asks',
  /** Reads what an archive would lose (#1595): nothing moves; it names unfinished mail threads, which only the window reads (mail.thread), so the window's class */
  'agents.archiveLosses': 'window',
  'agents.deleteAgentChild': 'asks',
  'agents.mcpProposals': 'everyday',
  'agents.resolveMcpProposal': 'window',
  'agents.skillProposals': 'everyday',
  'agents.resolveSkillProposal': 'window',
  'agents.orchestratorSkills': 'everyday',
  'agents.deleteOrchestratorSkill': 'asks',
  'agents.exportHandoffRecord': 'everyday',
  'agents.exportHandoffNote': 'everyday',
  'agents.worktreeStatus': 'everyday',
  /** Reads: who a session's work is owed to (#1377), and where its agent compacts by itself (#1376) */
  'agents.reportOwed': 'everyday',
  'agents.autoCompact': 'everyday',
  'agents.restartSession': 'everyday',
  'agents.resumeSession': 'everyday',
  'agents.forkConversation': 'everyday',
  'agents.switchTool': 'everyday',
  'agents.updateSettings': { asks: presetRaised, when: 'it sets a preset other than `safe`' },
  'agents.listExternalSessions': 'everyday',
  'agents.capabilities': 'everyday',
  'agents.detect': 'everyday',
  // Brings in a program that later runs (the vendor's agent, checked against the pinned sha256): the person says yes first
  'agents.installTool': 'asks',
  'agents.cancelInstallTool': 'everyday',
  // Opens a browser on the person's machine to sign an account in to a tool
  'agents.signIn': 'asks',
  'agents.cancelSignIn': 'everyday',
  'agents.versions': 'everyday',
  'agents.setAutoApplyVersions': 'everyday',
  'agents.applyVersions': 'everyday',
  'agents.sleepPolicy': 'everyday',
  'agents.setSleepPolicy': 'everyday',
  'agents.commands': 'everyday',
  'agents.models': 'everyday',
  'agents.usage': 'everyday',
  'agents.account': 'everyday',
  'usage.history': 'everyday',
  'messages.image': 'everyday',
  'messages.search': 'everyday',
  'messages.load': 'everyday',
  'messages.subagent': 'everyday',
  'messages.subagentTrashed': 'everyday',
  'sessions.reorder': 'everyday',
  'sessions.list': 'everyday',
  'sessions.rename': 'everyday',
  'sessions.markRead': 'everyday',
  // Hiding a failure is the person's (an agent's script may not clear what went wrong with it)
  'sessions.clearError': 'window',

  // The trash: reading and restoring run; deleting for good asks
  'trash.list': 'everyday',
  'trash.readRun': 'everyday',
  'trash.purgeRuns': 'asks',
  'trash.read': 'everyday',
  'trash.restore': 'everyday',
  'trash.purge': 'asks',
  'subagents.usage': 'everyday',
  'subagents.trash': 'everyday',
  'trash.restoreSubagentSteps': 'everyday',
  'trash.purgeSubagentSteps': 'asks',
  'trash.empty': 'asks',

  // The orchestrator
  'orchestrator.get': 'everyday',
  'orchestrator.peek': 'everyday',
  'orchestrator.configure': 'everyday',
  'orchestrator.tools': 'bridge',
  'orchestrator.tool': 'bridge',

  // Git and files in a project: what the OS user does with git and a shell anyway
  'git.status': 'everyday',
  'git.diff': 'everyday',
  'git.log': 'everyday',
  'git.commitDetail': 'everyday',
  'git.branches': 'everyday',
  'git.ignoredEntries': 'everyday',
  'git.checkout': 'everyday',
  'git.stage': 'everyday',
  'git.commit': 'everyday',
  'git.push': 'everyday',
  'git.cancel': 'everyday',
  'attachments.save': 'everyday',
  'fs.listDir': 'everyday',
  'fs.watch': 'everyday',
  'fs.readFile': 'everyday',
  'fs.move': 'everyday',
  'fs.importFile': 'everyday',
  'fs.resolve': 'everyday',
  'files.search': 'everyday',

  // Projects
  'projects.add': 'asks',
  'projects.inspect': 'everyday',
  'projects.create': 'asks',
  'projects.createPreview': 'everyday',
  'projects.delete': 'asks',
  'projects.deleteOutlook': 'everyday',
  /** Both ways, as `set_project_trust`: taking trust away drops the project's own deny rules and hooks */
  'projects.setTrusted': 'asks',
  'projects.reorder': 'everyday',
  'projects.setCommands': 'asks',
  'worktrees.setTrunk': 'everyday',
  'projects.setWorktreeSetup': 'asks',
  'projects.setAgentInstructions': 'asks',
  'projects.list': 'everyday',
  'projects.gitStatus': 'everyday',
  'projects.origin': 'everyday',

  // Terminals, commands and processes
  'processes.strays': 'everyday',
  'processes.stop': 'everyday',
  'terminal.list': 'everyday',
  'terminal.create': 'everyday',
  'terminal.close': 'everyday',
  'terminal.input': 'everyday',
  'terminal.resize': 'everyday',
  'terminal.restart': 'everyday',
  'commands.run': 'everyday',
  'commands.stop': 'everyday',
  'commands.state': 'everyday',
  'commands.log': 'everyday',
  'commands.resize': 'everyday',

  // App views: drawing and clicking an app's screen means a window
  'apps.viewFrame': 'window',
  'apps.viewDocument': 'window',
  'apps.openView': 'window',
  'apps.closeView': 'window',
  'apps.recoverView': 'window',
  'apps.holdViews': 'window',
  'apps.inlineReopen': 'window',
  'apps.inlineViews': 'everyday',
  'apps.viewMessage': 'window',
  'apps.readResource': 'window',
  'apps.invoke': 'window',

  // Apps
  'apps.list': 'everyday',
  'apps.runs': 'everyday',
  'apps.restart': 'everyday',
  'apps.remove': 'asks',
  'apps.create': 'everyday',
  'apps.builder': 'everyday',
  'apps.errors': 'everyday',
  'apps.reach': 'everyday',
  'apps.questions': 'everyday',
  'apps.answerQuestion': 'window',
  'projectConsents.list': 'everyday',
  'projectConsents.revoke': 'everyday',
  'apps.permissions': 'everyday',
  'apps.forgetPermission': 'everyday',
  'apps.usage': 'everyday',
  'apps.createBuilder': 'everyday',
  'apps.sendError': 'everyday',
  'apps.askBuilder': 'everyday',
  'apps.check': 'everyday',
  'apps.setShared': { asks: switchedOn('shared'), when: 'it shares the app' },
  'apps.setSecret': 'window',
  'apps.importPrepare': 'window',
  'apps.importCommit': 'asks',
  'apps.importCancel': 'window',
  'apps.review': 'everyday',
  'apps.enable': 'asks',
  'apps.versions': 'everyday',
  /** A snapshot comes back, and the one it replaces is kept */
  'apps.restoreVersion': 'everyday',
  'apps.sessionTools': 'bridge',
  'apps.sessionCall': 'bridge',

  // Updates
  'updates.status': 'everyday',
  'updates.setAuto': { asks: switchedOn('enabled'), when: 'it turns automatic updates on' },
  'updates.setAutoApply': { asks: switchedOn('enabled'), when: 'it turns automatic applying on' },
  'updates.apply': { asks: applyAsks, when: "the person's Automatic updates are off, or something is running (a turn, a card waiting, background work, a terminal or a command)" },
  'requests.list': 'everyday',
  /** The person's answer to a host request: a card answering itself means nothing */
  'requests.answer': 'window',
  'updates.answerApply': 'window',
  /** The window's report on an apply it was handed (`update_apply_go` carries the ticket to every client) */
  'updates.reportApply': 'window',

  // Linked machines
  'machines.list': 'everyday',
  'machines.add': 'asks',
  'machines.sshHosts': 'everyday',
  'machines.probe': 'everyday',
  'machines.remove': 'asks',
  'machines.reconnect': 'everyday',
  'machines.disconnect': 'everyday',
  /**
   * It only narrows: a credential there is withdrawn, and nothing gains access by it. The holder pairs again (a hub at
   * its next link, the window at its next start); the same user could run `serve --revoke` over ssh anyway
   */
  'machines.revokeCredential': 'everyday',
  'machines.setAutoReconnect': 'everyday',
  'machines.acceptVersions': 'asks',
  'machines.install': 'asks',
  'machines.update': {
    asks: updateAsks,
    when: "`when` is `now`, or the hub's automatic updates are off, or the machine does not run an older release that the update brings to the hub's own version",
  },
  'machines.rollback': 'asks',
  'machines.uninstall': 'asks',
  'machines.autostart': 'asks',
  'machines.activity': 'everyday',
  /** Ends an update's wait for the sessions there (#1399): the update fails and nothing is switched, as Disconnect only narrows */
  'machines.cancelUpdate': 'everyday',
  /** Without `allowed` it only reads the switch */
  'machines.hubAuto': { asks: (params) => 'allowed' in fields(params) && fields(params).allowed !== false, when: 'it turns the switch on' },
  'machines.setAsks': { asks: switchedOn('on'), when: 'it turns the switch on' },
  'machines.askConsents': 'everyday',
  'machines.withdrawAsk': 'everyday',

  // The person's side of the mailbox (#1347): what the person writes and decides is theirs by who is asking, so only a
  // window holding the token speaks as them. An agent's mail goes through its own tool channel (the bridge's), never here
  'mail.list': 'window',
  'mail.thread': 'window',
  'mail.reply': 'window',
  'mail.close': 'window',
  'mail.reassign': 'window',
  'mail.unblock': 'window',
  'mail.held': 'window',
  'mail.resume': 'window',
  'mail.wake': 'window',

  // Host to host: a hub linked to this host
  'host.activity': 'everyday',
  'host.sessions': 'link',
  'host.readSession': 'link',
  'host.recall': 'link',
  'host.hubAuto': 'link',
  'host.setHubAuto': 'link',
  'host.credentials': 'link',
  'host.lastAnswer': 'link',
  'host.send': 'link',
  /** What `kill` does anyway; `centralu serve --stop` asks for it */
  'host.stop': 'everyday',
  /**
   * A sign-in's serve saying it waits to take over, or gave up (#1224): a note of a fixed shape (a state and a time, no
   * text) on the machine's row, which moves and stops nothing (#1711, docs/plans/key-pairing.md §4.4). Everyday, so the
   * launcher says it with the limited credential and no full one crosses a port for it; `host.stop` does far more
   */
  'host.handover': 'everyday',
  'host.hubOffer': 'link',

  // The window's own state, preferences, themes and approval rules
  'workspace.save': 'window',
  'approvals.deleteRule': 'everyday',
  'workspace.load': 'everyday',
  'grid.get': 'everyday',
  'grid.set': 'window',
  'prefs.get': 'everyday',
  'prefs.set': { asks: prefsWiden, when: 'it sets the agent ceiling or depth, turns hub auto on, or turns approval notifications or their sound off' },
  'themes.list': 'everyday',
  'themes.save': 'everyday',
  'themes.import': 'everyday',
  'themes.resolve': 'everyday',
  'approvals.rules': 'everyday',
}

/** What a limited call of `method` with `params` comes to: run it, or which class refuses it */
export function limitedRight(method: string, params: unknown, host: RightsHost | null = null): 'everyday' | 'asks' | 'window' | 'link' | 'bridge' | 'unknown' {
  // Read as a table of any name: an own key only, so `constructor` or `__proto__` is no method
  const table: Readonly<Record<string, Rights>> = METHOD_RIGHTS
  const rights = Object.prototype.hasOwnProperty.call(table, method) ? table[method] : undefined
  if (rights === undefined) return 'unknown'
  if (typeof rights === 'object') return rights.asks(params, host) ? 'asks' : 'everyday'
  return rights
}

/** Whether `method`'s right depends on its parameters or the host (`{ asks, when }`): a limited call of it that runs went without a card */
export function conditionalRight(method: string): boolean {
  const table: Readonly<Record<string, Rights>> = METHOD_RIGHTS
  return Object.prototype.hasOwnProperty.call(table, method) && typeof table[method] === 'object'
}

/**
 * Why a connection holding the limited credential may not make this call, or null if it may: the class
 * that refuses it and a sentence to show. An `asks` call goes to the person's card instead
 * (host-requests.ts) where the host has one; this sentence is for a host without it.
 */
export function limitedRefusal(
  method: string,
  params: unknown,
  host: RightsHost | null = null,
): { rights: Exclude<ReturnType<typeof limitedRight>, 'everyday'>; message: string } | null {
  const rights = limitedRight(method, params, host)
  switch (rights) {
    case 'everyday':
      return null
    case 'asks':
      return { rights, message: `${method} cannot be undone or widens what runs without asking, so it needs the person in the Centralu window` }
    case 'window':
      return { rights, message: `${method} is the person's own answer or the window's own state, so only the Centralu window can call it` }
    case 'link':
      return { rights, message: `${method} is for a computer linked to this one, not for the limited credential` }
    case 'bridge':
      return { rights, message: `${method} is a session's own tool channel, not for the limited credential` }
    case 'unknown':
      return { rights, message: `Unknown method ${method}` }
  }
}
