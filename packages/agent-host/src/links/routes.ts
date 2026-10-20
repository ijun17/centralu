import type { RpcMethodName } from '@cc/protocol'
import { isObj, type Obj } from '../json-value.js'
import type { Qualifier } from './qualifier.js'

/**
 * How every RPC method reaches a linked machine (docs/plans/remote-hub.md §5).
 *
 * The table is keyed by `RpcMethodName` with no default, so a method added to the protocol does not
 * compile until someone decides how it routes: forwarding a new call by accident, or keeping on the
 * hub one that names a remote session, would both be silent.
 *
 *   hub        Served by the hub's own host whatever its parameters say: the person's layout,
 *              preferences, themes, updates, the orchestrator, app imports, screen questions
 *   internal   The callbacks of the hub's own agents (the Codex bridge). A remote's bridge talks
 *              to its own host; these never cross a link
 *   session    The machine named by `sessionId`'s prefix; the hub's own session when unprefixed
 *   project    The same by `projectId` (or `key`). A null project (a user-folder app) is the hub's
 *   terminal   The same by `terminalId`
 *   machine    The machine named by the optional `machine` parameter; the hub when absent
 *   merge      Every reachable machine, answers combined by the router (`router.ts`)
 *   view       An app view's call, named by several ids at once (`keys`: its project, its instance,
 *              the conversation it sends to). Goes to the machine any of them names, all of them
 *              stripped; ids of two different machines (or of a machine and the hub) are refused,
 *              since a view is open on one machine and reaches only what is there (plan §11)
 *   noRemote   Routed like `session`/`project`, but refused for a remote one: the answer is a path
 *              for this computer's OS (reveal in Finder)
 *
 * `params` turns the hub's parameters into the remote's (the routing key is always stripped);
 * `result` turns the remote's answer into the hub's terms, field by field through `fields` and `each`.
 */

type ParamsFix = (p: Record<string, unknown>, q: Qualifier) => Record<string, unknown>
type ResultFix = (r: unknown, q: Qualifier) => unknown

export type Route =
  | { kind: 'hub' }
  | { kind: 'internal' }
  | { kind: 'merge' }
  | { kind: 'session'; params?: ParamsFix; result?: ResultFix }
  /** `orMachine`: with no project, the optional `machine` parameter names the machine (a user-folder app of it) */
  | { kind: 'project'; key?: string; params?: ParamsFix; result?: ResultFix; orMachine?: boolean }
  | { kind: 'terminal'; result?: ResultFix }
  /** `sharesAccount`: a tool logged in to the same account here and there reads its limits once, on the hub (`agents.usage`, #726) */
  | { kind: 'machine'; result?: ResultFix; sharesAccount?: boolean }
  | { kind: 'view'; keys: readonly string[]; result?: ResultFix; orMachine?: boolean }
  | { kind: 'noRemote'; key: 'sessionId' | 'projectId' }

const session = (result?: ResultFix, params?: ParamsFix): Route => ({ kind: 'session', result, params })
const project = (result?: ResultFix, params?: ParamsFix): Route => ({ kind: 'project', result, params })
const view = (keys: readonly string[], result?: ResultFix): Route => ({ kind: 'view', keys, result })
/** An app's own call: by its project, or for a linked machine's user-folder app by the optional `machine` (plan §11.9) */
const app = (result?: ResultFix): Route => ({ kind: 'project', orMachine: true, result })
const HUB: Route = { kind: 'hub' }
const INTERNAL: Route = { kind: 'internal' }
const MERGE: Route = { kind: 'merge' }

/**
 * An answer object with the named fields rewritten, by the rule the qualifier's own rewrites follow (qualifier.ts): what
 * is not an object, and a field it does not have, passes as it is, for the window to parse through the method's schema.
 * The hand-written copies drifted (#850): some spread a list as an object, threw on a field that was not a list, or
 * invented an empty list for a missing one
 */
const fields =
  (fix: Readonly<Record<string, ResultFix>>): ResultFix =>
  (r, q) => {
    if (!isObj(r)) return r
    const out: Obj = { ...r }
    for (const [k, f] of Object.entries(fix)) if (k in r) out[k] = f(r[k], q)
    return out
  }
/** Each item of a list rewritten the same way; anything else passes as it is */
const each =
  (fix: ResultFix): ResultFix =>
  (r, q) =>
    Array.isArray(r) ? r.map((x) => fix(x, q)) : r

const id: ResultFix = (r, q) => q.maybeId(r)
const sessionInfo: ResultFix = (r, q) => q.session(r)
const sessionResult: ResultFix = (r, q) => q.sessionResult(r)
const messages: ResultFix = (r, q) => q.messages(r)
const projectInfo: ResultFix = (r, q) => q.project(r)
const terminal: ResultFix = (r, q) => q.terminal(r)
const run: ResultFix = (r, q) => q.run(r)
const appInfo: ResultFix = (r, q) => q.app(r)
const builderSession = fields({ sessionId: id })
// The sessions the cache figures name are the remote's, so the hub's screen can open them (docs/agent-host.md §6.1)
const usageResult = fields({ cache: fields({ windows: each(fields({ sessions: each(fields({ sessionId: id })) })) }) })

export const ROUTES: { readonly [M in RpcMethodName]: Route } = {
  // ── Sessions ───────────────────────────────────────────────────────────────────────────
  'agents.createSession': project(sessionInfo, (p, q) => {
    const handoff = p.handoff as { fromSessionId?: unknown } | undefined
    if (!handoff || typeof handoff.fromSessionId !== 'string') return p
    // The predecessor's note file lives on its own machine; one elsewhere is passed as text alone
    const { fromSessionId, ...rest } = handoff
    return { ...p, handoff: q.owns(fromSessionId) ? { ...rest, fromSessionId: q.strip(fromSessionId, 'The predecessor') } : rest }
  }),
  'agents.send': session(),
  // Who the hub's own waits owe a report to: a linked session's is asked of the hub, not of its machine (#1377)
  'agents.reportOwed': HUB,
  'agents.respondApproval': session(),
  'agents.answerQuestion': session(),
  'agents.interrupt': session(),
  'agents.stopBackgroundTask': session(),
  'agents.clearBackgroundTasks': session(),
  'agents.deleteSession': session(),
  'agents.deleteAgentChild': session(),
  'agents.exportHandoffRecord': session(),
  'agents.exportHandoffNote': session(),
  'agents.worktreeStatus': session(),
  'agents.autoCompact': session(),
  'agents.restartSession': session(sessionResult),
  'agents.resumeSession': session(sessionResult),
  'agents.forkConversation': session(sessionResult),
  'agents.switchTool': session(sessionInfo),
  'agents.updateSettings': session(sessionInfo),
  'agents.commands': session(),
  'attachments.save': session(),
  'sessions.rename': session(),
  'sessions.markRead': session(),
  'messages.load': session(messages),
  'messages.subagent': session(messages),
  'messages.subagentTrashed': session(),
  // Read on the machine the session runs on; the path it resolved is that machine's, so there is nothing to reveal here
  'messages.image': session((r) => {
    if (!isObj(r) || !('file' in r)) return r
    const { file: _file, ...rest } = r
    return rest
  }),
  'trash.read': session(messages),
  'trash.restore': session(fields({ session: sessionInfo, project: projectInfo })),
  'trash.purge': session(),
  'subagents.trash': session(),
  'trash.restoreSubagentSteps': session(),
  'trash.purgeSubagentSteps': session(),
  'sessions.reorder': project(
    (r, q) => q.sessions(r),
    (p, q) => ({ ...p, orderedIds: Array.isArray(p.orderedIds) ? p.orderedIds.map((id) => q.strip(id, 'A session in the order')) : p.orderedIds }),
  ),

  // ── Projects, git, files, terminals, commands ───────────────────────────────────────────
  'agents.listExternalSessions': project((r, q) => q.externalSessions(r)),
  'projects.delete': project(),
  'projects.deleteOutlook': project(),
  'projects.setTrusted': project(),
  'projects.setCommands': project(),
  'projects.setWorktreeSetup': project(),
  'projects.setAgentInstructions': project(),
  'projects.gitStatus': project(projectInfo),
  // A remote address, nothing of this machine's ids in it
  'projects.origin': project(),
  'worktrees.createManager': project(sessionInfo),
  'worktrees.setTrunk': project(),
  'git.status': project(),
  'git.diff': project(),
  'git.log': project(),
  'git.commitDetail': project(),
  'git.branches': project(),
  'git.ignoredEntries': project(),
  'git.checkout': project(),
  'git.stage': project(),
  'git.commit': project(),
  'git.push': project(),
  'git.cancel': project(),
  'fs.listDir': project(),
  'fs.watch': project(),
  // The session whose folder the file is in (#1209) is that machine's too
  'fs.readFile': project(undefined, (p, q) => ({ ...p, sessionId: q.stripMaybe(p.sessionId, 'The session the file belongs to') })),
  'fs.move': project(),
  'fs.importFile': project(),
  'fs.resolve': { kind: 'noRemote', key: 'projectId' },
  'files.search': project(),
  'terminal.list': project(fields({ terminals: each(terminal) })),
  'terminal.create': project(terminal),
  'terminal.close': { kind: 'terminal' },
  'terminal.input': { kind: 'terminal' },
  'terminal.resize': { kind: 'terminal' },
  'terminal.restart': { kind: 'terminal', result: terminal },
  'commands.run': project(run),
  'commands.stop': project(),
  'commands.state': project(fields({ runs: each(run) })),
  'commands.log': project(fields({ run })),
  'commands.resize': project(),
  'projectConsents.revoke': {
    kind: 'project',
    key: 'fromProjectId',
    params: (p, q) => ({ ...p, toProjectId: q.strip(p.toProjectId, 'The project the consent reaches') }),
  },

  // ── Per machine, named by an optional `machine` parameter ───────────────────────────────
  'agents.capabilities': { kind: 'machine' },
  'agents.detect': { kind: 'machine' },
  'agents.versions': { kind: 'machine' },
  'agents.setAutoApplyVersions': { kind: 'machine' },
  'agents.sleepPolicy': { kind: 'machine' },
  'agents.setSleepPolicy': { kind: 'machine' },
  'agents.applyVersions': { kind: 'machine', result: fields({ restarted: each(id), busy: each(id) }) },
  'agents.models': { kind: 'machine' },
  'agents.usage': { kind: 'machine', result: usageResult, sharesAccount: true },
  'agents.account': { kind: 'machine' },
  'projects.add': { kind: 'machine', result: projectInfo },
  // What a folder there is (#1220), read by that machine's host; a project already kept for it named in the hub's terms
  'projects.inspect': { kind: 'machine', result: fields({ project: (p, q) => (isObj(p) ? { ...p, id: q.maybeId(p.id) } : p) }) },
  // Made by the host of the machine the project lives on, in its own home and path terms (#515)
  'projects.create': { kind: 'machine', result: projectInfo },
  'projects.createPreview': { kind: 'machine' },
  'processes.strays': { kind: 'machine' },
  'processes.stop': { kind: 'machine' },

  // ── Every machine at once (router.ts) ───────────────────────────────────────────────────
  'sessions.list': MERGE,
  'projects.list': MERGE,
  'projects.reorder': MERGE,
  'messages.search': MERGE,
  'apps.list': MERGE,
  'projectConsents.list': MERGE,
  'approvals.rules': MERGE,
  'approvals.deleteRule': MERGE,
  'trash.list': MERGE,
  'trash.empty': MERGE,
  // The records of deleted app-agent sessions (#378), on the machine whose app ran (`trash.list` names it)
  'trash.readRun': { kind: 'machine', result: fields({ messages }) },
  'trash.purgeRuns': { kind: 'machine' },
  'subagents.usage': MERGE,

  // ── Apps: a project app routes with its project; a user-folder app by `machine` where the call takes it ──
  'apps.runs': app(each((r, q) => q.appRun(r))),
  'apps.restart': app(),
  'apps.remove': app(),
  'apps.create': project(fields({ app: appInfo, builder: sessionInfo })),
  'apps.builder': app(sessionInfo),
  'apps.createBuilder': app(sessionInfo),
  'apps.errors': app((r, q) => q.errorBundles(r)),
  'apps.permissions': app(),
  'apps.forgetPermission': app(),
  'apps.usage': app(),
  'apps.sendError': app(builderSession),
  // It may name the view it came from, whose instance is qualified like any view's (plan §11)
  'apps.askBuilder': { kind: 'view', keys: ['projectId', 'instanceId'], orMachine: true, result: builderSession },
  'apps.check': project(),
  'apps.setShared': project(),
  'apps.setSecret': app(),
  'apps.review': project(),
  'apps.enable': project(appInfo),
  'apps.versions': app(),
  'apps.restoreVersion': app(appInfo),
  'apps.reach': session(undefined, (p, q) => ({ ...p, projectId: q.stripMaybe(p.projectId, 'The app') })),
  'apps.inlineViews': session(each((r, q) => q.inlineView(r))),
  /*
   * App views of another machine (plan §11): the instance stays open there and holds its app, and its id reaches the
   * window qualified. The hub serves every view's address itself (`apps.viewFrame`, views/view-host.ts), asking the
   * machine for the document (`apps.viewDocument`); what the view then calls goes to the machine it is open on.
   */
  'apps.viewFrame': HUB,
  'apps.viewDocument': view(['instanceId'], (r, q) => q.viewDocument(r)),
  // A linked machine's user-folder app has no project to name its machine: `machine` does (plan §11)
  /*
   * A lease (#392) ties a view to the window's connection on the host it is open on. A linked machine sees the hub's
   * link, not the window, so its views are opened without one and live until closed, as before
   */
  'apps.openView': { kind: 'project', orMachine: true, result: (r, q) => q.openedView(r), params: ({ lease: _lease, ...p }) => p },
  'apps.recoverView': { kind: 'project', orMachine: true, result: (r, q) => q.openedView(r), params: ({ lease: _lease, ...p }) => p },
  'apps.readResource': view(['projectId', 'instanceId']),
  'apps.invoke': view(['projectId', 'instanceId']),
  'apps.inlineReopen': session((r, q) => q.inlineView(r)),
  'apps.viewMessage': view(['sessionId', 'instanceId']),
  'apps.closeView': view(['instanceId']),
  // The hub's own leases; another machine's ids are passed over (views/view-host.ts `hold`)
  'apps.holdViews': HUB,
  'apps.questions': HUB,
  'apps.answerQuestion': HUB,
  'apps.importPrepare': HUB,
  'apps.importCommit': HUB,
  'apps.importCancel': HUB,

  // ── The hub's own ───────────────────────────────────────────────────────────────────────
  'agents.mcpProposals': HUB,
  'agents.resolveMcpProposal': HUB,
  'agents.skillProposals': HUB,
  'agents.resolveSkillProposal': HUB,
  'agents.orchestratorSkills': HUB,
  'agents.deleteOrchestratorSkill': HUB,
  'orchestrator.get': HUB,
  'orchestrator.peek': HUB,
  'orchestrator.configure': HUB,
  'workspace.save': HUB,
  'workspace.load': HUB,
  // The mailbox is the hub's: a linked machine's mail reaches it there (slice 4 of #1347)
  'mail.list': HUB,
  'mail.thread': HUB,
  'mail.reply': HUB,
  'mail.close': HUB,
  'mail.reassign': HUB,
  'mail.unblock': HUB,
  'mail.held': HUB,
  'mail.resume': HUB,
  'mail.wake': HUB,
  'grid.get': HUB,
  'grid.set': HUB,
  'prefs.get': HUB,
  'prefs.set': HUB,
  'themes.list': HUB,
  'themes.save': HUB,
  'themes.import': HUB,
  'themes.resolve': HUB,
  'updates.status': HUB,
  'updates.setAuto': HUB,
  'updates.setAutoApply': HUB,
  'updates.apply': HUB,
  // The hub's own windows answer the hub's own host (#665); a linked machine's events never ask them
  'updates.answerApply': HUB,
  'updates.reportApply': HUB,
  'machines.list': HUB,
  'machines.add': HUB,
  'machines.sshHosts': HUB,
  'machines.probe': HUB,
  'machines.remove': HUB,
  'machines.reconnect': HUB,
  'machines.disconnect': HUB,
  'machines.setAutoReconnect': HUB,
  'machines.setConnect': HUB,
  'machines.need': HUB,
  // Stopping a remote host is `centralu serve --stop` over ssh, never a call through the link
  'host.stop': HUB,
  // A sign-in's serve on this machine telling its own host about the hand-over (#1224); never through a link
  'host.handover': HUB,
  'machines.acceptVersions': HUB,
  'machines.install': HUB,
  'machines.update': HUB,
  'machines.cancelUpdate': HUB,
  'machines.rollback': HUB,
  'machines.uninstall': HUB,
  'machines.autostart': HUB,
  'machines.activity': HUB,
  'machines.hubAuto': HUB,
  // The reverse direction's switch and pairs are this computer's own (#550)
  'machines.setAsks': HUB,
  'machines.askConsents': HUB,
  'machines.withdrawAsk': HUB,
  // A hub offering itself to this host (#550): answered here, never passed on
  'host.hubOffer': HUB,
  // The hub's own answer; a hub asks a remote's through `machines.activity`
  'host.activity': HUB,
  // The hub's own sessions; the hub's orchestrator asks each machine's directly (links/linked-sessions.ts, plan §12)
  'host.sessions': HUB,
  'host.readSession': HUB,
  'host.recall': HUB,
  'host.lastAnswer': HUB,
  'host.send': HUB,
  'host.hubAuto': HUB,
  'host.setHubAuto': HUB,

  // ── Callbacks of the hub's own agents ───────────────────────────────────────────────────
  'orchestrator.tools': INTERNAL,
  'orchestrator.tool': INTERNAL,
  'apps.sessionTools': INTERNAL,
  'apps.sessionCall': INTERNAL,
}
