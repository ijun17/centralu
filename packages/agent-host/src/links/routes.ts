import type { RpcMethodName } from '@cc/protocol'
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
 *   noRemote   Routed like `session`/`project`, but refused for a remote one in phase 1: the
 *              answer is a path for this computer's OS (reveal in Finder) or an app view, whose
 *              addresses carry the remote host's own ports and need the hub's proxy (phase 2)
 *
 * `params` turns the hub's parameters into the remote's (the routing key is always stripped);
 * `result` turns the remote's answer into the hub's terms.
 */

type ParamsFix = (p: Record<string, unknown>, q: Qualifier) => Record<string, unknown>
type ResultFix = (r: unknown, q: Qualifier) => unknown

export type Route =
  | { kind: 'hub' }
  | { kind: 'internal' }
  | { kind: 'merge' }
  | { kind: 'session'; params?: ParamsFix; result?: ResultFix }
  | { kind: 'project'; key?: string; params?: ParamsFix; result?: ResultFix }
  | { kind: 'terminal'; result?: ResultFix }
  | { kind: 'machine'; result?: ResultFix }
  | { kind: 'noRemote'; key: 'sessionId' | 'projectId' }

const session = (result?: ResultFix, params?: ParamsFix): Route => ({ kind: 'session', result, params })
const project = (result?: ResultFix, params?: ParamsFix): Route => ({ kind: 'project', result, params })
const HUB: Route = { kind: 'hub' }
const INTERNAL: Route = { kind: 'internal' }
const MERGE: Route = { kind: 'merge' }

const sessionInfo: ResultFix = (r, q) => q.session(r)
const sessionResult: ResultFix = (r, q) => q.sessionResult(r)
const messages: ResultFix = (r, q) => q.messages(r)
const builderSession: ResultFix = (r, q) => (r && typeof r === 'object' ? { ...(r as object), sessionId: q.maybeId((r as { sessionId?: unknown }).sessionId) } : r)

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
  'agents.respondApproval': session(),
  'agents.answerQuestion': session(),
  'agents.interrupt': session(),
  'agents.stopBackgroundTask': session(),
  'agents.clearBackgroundTasks': session(),
  'agents.deleteSession': session(),
  'agents.exportHandoffRecord': session(),
  'agents.exportHandoffNote': session(),
  'agents.worktreeStatus': session(),
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
  // Read on the machine the session runs on; the path it resolved is that machine's, so there is nothing to reveal here
  'messages.image': session((r) => {
    if (!r || typeof r !== 'object' || !('file' in r)) return r
    const { file: _file, ...rest } = r as Record<string, unknown>
    return rest
  }),
  'trash.read': session(messages),
  'trash.restore': session((r, q) =>
    r && typeof r === 'object'
      ? { ...(r as object), session: q.session((r as { session?: unknown }).session), project: q.project((r as { project?: unknown }).project) }
      : r,
  ),
  'trash.purge': session(),
  'sessions.reorder': project(
    (r, q) => q.sessions(r),
    (p, q) => ({ ...p, orderedIds: Array.isArray(p.orderedIds) ? p.orderedIds.map((id) => q.strip(id, 'A session in the order')) : p.orderedIds }),
  ),

  // ── Projects, git, files, terminals, commands ───────────────────────────────────────────
  'agents.listExternalSessions': project(),
  'projects.delete': project(),
  'projects.setTrusted': project(),
  'projects.setCommands': project(),
  'projects.setWorktreeSetup': project(),
  'projects.gitStatus': project((r, q) => q.project(r)),
  'worktrees.createManager': project(sessionInfo),
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
  'fs.listDir': project(),
  'fs.watch': project(),
  'fs.readFile': project(),
  'fs.move': project(),
  'fs.importFile': project(),
  'fs.resolve': { kind: 'noRemote', key: 'projectId' },
  'files.search': project(),
  'terminal.list': project((r, q) =>
    r && typeof r === 'object'
      ? { ...(r as object), terminals: ((r as { terminals?: unknown[] }).terminals ?? []).map((t) => q.terminal(t)) }
      : r,
  ),
  'terminal.create': project((r, q) => q.terminal(r)),
  'terminal.close': { kind: 'terminal' },
  'terminal.input': { kind: 'terminal' },
  'terminal.resize': { kind: 'terminal' },
  'terminal.restart': { kind: 'terminal', result: (r, q) => q.terminal(r) },
  'commands.run': project((r, q) => q.run(r)),
  'commands.stop': project(),
  'commands.state': project((r, q) =>
    r && typeof r === 'object' ? { ...(r as object), runs: ((r as { runs?: unknown[] }).runs ?? []).map((x) => q.run(x)) } : r,
  ),
  'commands.log': project((r, q) => (r && typeof r === 'object' ? { ...(r as object), run: q.run((r as { run?: unknown }).run) } : r)),
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
  'agents.applyVersions': {
    kind: 'machine',
    result: (r, q) => {
      if (!r || typeof r !== 'object') return r
      const { restarted, busy } = r as { restarted?: unknown[]; busy?: unknown[] }
      return { ...(r as object), restarted: (restarted ?? []).map((x) => q.maybeId(x)), busy: (busy ?? []).map((x) => q.maybeId(x)) }
    },
  },
  'agents.models': { kind: 'machine' },
  'agents.usage': { kind: 'machine' },
  'projects.add': { kind: 'machine', result: (r, q) => q.project(r) },
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

  // ── Apps: a project app routes with its project; a user-folder app is the hub's in phase 1 ──
  'apps.runs': project(),
  'apps.restart': project(),
  'apps.remove': project(),
  'apps.create': project((r, q) =>
    r && typeof r === 'object'
      ? { ...(r as object), app: q.app((r as { app?: unknown }).app), builder: q.session((r as { builder?: unknown }).builder) }
      : r,
  ),
  'apps.builder': project(sessionInfo),
  'apps.createBuilder': project(sessionInfo),
  'apps.errors': project(),
  'apps.permissions': project(),
  'apps.forgetPermission': project(),
  'apps.usage': project(),
  'apps.sendError': project(builderSession),
  'apps.askBuilder': project(builderSession),
  'apps.check': project(),
  'apps.setShared': project(),
  'apps.setSecret': project(),
  'apps.review': project(),
  'apps.enable': project((r, q) => q.app(r)),
  'apps.versions': project(),
  'apps.restoreVersion': project((r, q) => q.app(r)),
  'apps.reach': session(undefined, (p, q) => ({ ...p, projectId: q.stripMaybe(p.projectId, 'The app') })),
  'apps.inlineViews': session((r, q) => (Array.isArray(r) ? r.map((v) => q.inlineView(v)) : r)),
  // App views on a remote machine open through the hub's proxy, in phase 2
  'apps.viewFrame': { kind: 'noRemote', key: 'projectId' },
  'apps.openView': { kind: 'noRemote', key: 'projectId' },
  'apps.readResource': { kind: 'noRemote', key: 'projectId' },
  'apps.invoke': { kind: 'noRemote', key: 'projectId' },
  'apps.inlineReopen': { kind: 'noRemote', key: 'sessionId' },
  'apps.viewMessage': { kind: 'noRemote', key: 'sessionId' },
  'apps.closeView': HUB,
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
  'machines.list': HUB,
  'machines.add': HUB,
  'machines.remove': HUB,
  'machines.reconnect': HUB,
  // Stopping a remote host is `centralu serve --stop` over ssh, never a call through the link
  'host.stop': HUB,
  'machines.acceptVersions': HUB,
  'machines.install': HUB,
  'machines.update': HUB,
  'machines.rollback': HUB,
  'machines.uninstall': HUB,
  'machines.activity': HUB,
  // The hub's own answer; a hub asks a remote's through `machines.activity`
  'host.activity': HUB,

  // ── Callbacks of the hub's own agents ───────────────────────────────────────────────────
  'orchestrator.tools': INTERNAL,
  'orchestrator.tool': INTERNAL,
  'apps.sessionTools': INTERNAL,
  'apps.sessionCall': INTERNAL,
}
