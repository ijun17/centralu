import { relative } from 'node:path'
import { RpcMethods, type RpcMethodName } from '@cc/protocol'
import type { SessionManager } from './sessions/manager.js'
import { searchFiles } from './dev-services/file-search.js'
import type { TerminalHandle, TerminalService } from './dev-services/terminal.js'
import type { CommandRunner } from './dev-services/commands.js'
import { findStrays, stopStrays } from './dev-services/strays.js'
import { gitLogPath } from './dev-services/git.js'

/** Internal handle → protocol shape (history is rendered as a fresh snapshot each time) */
const toInfo = (h: TerminalHandle) => ({
  terminalId: h.id,
  cwd: h.cwd,
  title: h.title,
  history: h.history(),
  alive: h.alive,
})
import type { UpdateService } from './updates.js'
import { resultText, type ExternalApps } from './apps/external/runtime.js'
import { openHomeView } from './app-home-view.js'
import { askBuilder, sendErrorToBuilder } from './builder-requests.js'
import { HOST_APPS } from './apps/registry.js'
import { orchestratorToolSchemas } from './sessions/orchestrator-tools.js'
import type { AgentAdapter } from './adapters/contract.js'
import type { ViewHost } from './views/view-host.js'
import type { InlineViews } from './inline-views.js'
import type { ToolName } from '@cc/protocol'

/**
 * The optional services a host has. Without one, that feature simply does not exist on this host
 * (tests wire in only what they need).
 * Received by name — so that as more services get added later, there is never a spot that has to
 * count in `undefined` placeholders.
 */
export type RpcServices = {
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
}

/** RPC routing. Parameters are validated exactly once, at the boundary (docs/protocol.md §4) */
export function createRpcHandler(
  mgr: SessionManager,
  adapters: Map<ToolName, AgentAdapter>,
  { terminals, updates, commands, externalApps, views, inlineViews }: RpcServices = {},
) {
  const requireTerminals = (): TerminalService => {
    if (!terminals) throw Object.assign(new Error('Terminals are unavailable'), { code: 'internal' })
    return terminals
  }
  const requireCommands = (): CommandRunner => {
    if (!commands) throw Object.assign(new Error('Command runs are unavailable'), { code: 'internal' })
    return commands
  }
  const requireExternalApps = (): ExternalApps => {
    if (!externalApps) throw Object.assign(new Error('External apps are unavailable'), { code: 'internal' })
    return externalApps
  }
  const requireViews = (): ViewHost => {
    if (!views) throw Object.assign(new Error('App views are unavailable'), { code: 'internal' })
    return views
  }
  const requireUpdates = (): UpdateService => {
    if (!updates) throw Object.assign(new Error('Update checks are unavailable'), { code: 'internal' })
    return updates
  }

  const handlers: { [M in RpcMethodName]: (p: unknown) => Promise<unknown> } = {
    'agents.createSession': async (p) => mgr.createSession(RpcMethods['agents.createSession'].params.parse(p)),
    'agents.send': async (p) => {
      const { sessionId, text, attachments } = RpcMethods['agents.send'].params.parse(p)
      await mgr.send(sessionId, text, attachments)
      return { ok: true as const }
    },
    'agents.respondApproval': async (p) => {
      const { sessionId, requestId, decision, scope, matcher } =
        RpcMethods['agents.respondApproval'].params.parse(p)
      mgr.respondApproval(sessionId, requestId, decision, scope, matcher)
      return { ok: true as const }
    },
    'agents.answerQuestion': async (p) => {
      const { sessionId, requestId, answers } = RpcMethods['agents.answerQuestion'].params.parse(p)
      mgr.answerQuestion(sessionId, requestId, answers)
      return { ok: true as const }
    },
    'agents.models': async (p) => mgr.listModels(RpcMethods['agents.models'].params.parse(p).tool),
    'agents.interrupt': async (p) => {
      mgr.interrupt(RpcMethods['agents.interrupt'].params.parse(p).sessionId)
      return { ok: true as const }
    },
    // Deleting moves the session to the trash (#204); only the trash.* methods below remove anything for good
    'agents.deleteSession': async (p) => {
      const { sessionId, deleteWorktree, deleteExternal } = RpcMethods['agents.deleteSession'].params.parse(p)
      await mgr.trashSession(sessionId, deleteWorktree, deleteExternal)
      return { ok: true as const }
    },
    'agents.exportHandoffRecord': async (p) => {
      const { sessionId, toTool } = RpcMethods['agents.exportHandoffRecord'].params.parse(p)
      return mgr.exportHandoffRecord(sessionId, toTool)
    },
    'agents.exportHandoffNote': async (p) => {
      const { sessionId, afterSeq } = RpcMethods['agents.exportHandoffNote'].params.parse(p)
      return mgr.exportHandoffNote(sessionId, afterSeq)
    },
    'agents.createCoordinator': async (p) => {
      const params = RpcMethods['agents.createCoordinator'].params.parse(p)
      return mgr.createCoordinator(params)
    },
    'agents.worktreeStatus': async (p) =>
      mgr.worktreeStatus(RpcMethods['agents.worktreeStatus'].params.parse(p).sessionId),
    'agents.mcpProposals': async () => ({ proposals: mgr.mcpProposals() }),
    'agents.resolveMcpProposal': async (p) => {
      const { name, approve } = RpcMethods['agents.resolveMcpProposal'].params.parse(p)
      const r = await mgr.resolveMcpProposal(name, approve)
      if (!r.ok) throw Object.assign(new Error(r.error ?? 'unknown proposal'), { code: 'internal' })
      return { ok: true as const }
    },
    'agents.skillProposals': async () => ({ proposals: mgr.skillProposals() }),
    'agents.resolveSkillProposal': async (p) => {
      const { name, approve } = RpcMethods['agents.resolveSkillProposal'].params.parse(p)
      const r = await mgr.resolveSkillProposal(name, approve)
      if (!r.ok) throw Object.assign(new Error(r.error ?? 'unknown proposal'), { code: 'internal' })
      return { ok: true as const }
    },
    'agents.orchestratorSkills': async () => ({ skills: mgr.orchestratorSkills() }),
    'agents.deleteOrchestratorSkill': async (p) => {
      const { name } = RpcMethods['agents.deleteOrchestratorSkill'].params.parse(p)
      const r = await mgr.deleteOrchestratorSkill(name)
      if (!r.ok) throw Object.assign(new Error(r.error ?? 'unknown skill'), { code: 'internal' })
      return { ok: true as const }
    },
    'agents.listExternalSessions': async (p) => {
      const { projectId, tool, limit } = RpcMethods['agents.listExternalSessions'].params.parse(p)
      return mgr.listExternalSessions(projectId, tool, limit)
    },
    'agents.restartSession': async (p) =>
      mgr.restartSession(RpcMethods['agents.restartSession'].params.parse(p).sessionId),
    'agents.resumeSession': async (p) =>
      mgr.resumeSession(RpcMethods['agents.resumeSession'].params.parse(p).sessionId),
    'agents.forkConversation': async (p) =>
      mgr.forkConversation(RpcMethods['agents.forkConversation'].params.parse(p).sessionId),
    'agents.updateSettings': async (p) => {
      /*
       * **Fields are never pulled out one at a time.**
       *
       * When effort was added, pulling it out here was overlooked, and the UI sent it but it never
       * reached the host — nothing happened, silently, with no error. Passing the parsed result
       * through whole means this spot never needs fixing again as more settings are added.
       */
      const { sessionId, ...settings } = RpcMethods['agents.updateSettings'].params.parse(p)
      return await mgr.updateSettings(sessionId, settings)
    },
    'agents.switchTool': async (p) => {
      const { sessionId, tool } = RpcMethods['agents.switchTool'].params.parse(p)
      return mgr.switchTool(sessionId, tool)
    },
    'agents.capabilities': async (p) => {
      const { tool } = RpcMethods['agents.capabilities'].params.parse(p)
      const a = adapters.get(tool)
      if (!a) throw Object.assign(new Error(`Unknown tool: ${tool}`), { code: 'tool_not_installed' })
      return a.capabilities
    },
    'agents.detect': async () =>
      Promise.all(
        [...adapters.values()].map(async (a) => {
          const { installed, loggedIn, detail } = await a.detect()
          return { ...a.descriptor, installed, loggedIn, detail }
        }),
      ),
    'git.status': async (p) => mgr.gitStatusFiles(RpcMethods['git.status'].params.parse(p).projectId),
    'git.diff': async (p) => {
      const { projectId, path, staged } = RpcMethods['git.diff'].params.parse(p)
      return mgr.gitDiff(projectId, path, staged)
    },
    'git.log': async (p) => {
      const { projectId, limit } = RpcMethods['git.log'].params.parse(p)
      return mgr.gitLog(projectId, limit)
    },
    'git.commitDetail': async (p) => {
      const { projectId, sha } = RpcMethods['git.commitDetail'].params.parse(p)
      return mgr.gitCommitDetail(projectId, sha)
    },
    'git.branches': async (p) => mgr.gitBranches(RpcMethods['git.branches'].params.parse(p).projectId),
    'git.ignoredEntries': async (p) =>
      mgr.gitIgnoredEntries(RpcMethods['git.ignoredEntries'].params.parse(p).projectId),
    'git.checkout': async (p) => {
      const { projectId, branch, dryRun } = RpcMethods['git.checkout'].params.parse(p)
      return mgr.gitCheckout(projectId, branch, dryRun)
    },
    'git.stage': async (p) => {
      const { projectId, paths, unstage } = RpcMethods['git.stage'].params.parse(p)
      await mgr.gitStage(projectId, paths, unstage)
      return { ok: true as const }
    },
    'git.commit': async (p) => {
      const { projectId, message } = RpcMethods['git.commit'].params.parse(p)
      return mgr.gitCommit(projectId, message)
    },
    'git.push': async (p) => mgr.gitPush(RpcMethods['git.push'].params.parse(p).projectId),
    'attachments.save': async (p) => {
      const { sessionId, name, mime, dataBase64 } = RpcMethods['attachments.save'].params.parse(p)
      return mgr.saveAttachment(sessionId, name, mime, dataBase64)
    },
    'fs.listDir': async (p) => {
      const { projectId, path } = RpcMethods['fs.listDir'].params.parse(p)
      return mgr.listDir(projectId, path)
    },
    'fs.watch': async (p) => {
      const { projectId, paths } = RpcMethods['fs.watch'].params.parse(p)
      return { watched: mgr.watchDirs(projectId, paths) }
    },
    'fs.readFile': async (p) => {
      const { projectId, path } = RpcMethods['fs.readFile'].params.parse(p)
      return mgr.readTextFile(projectId, path)
    },
    'fs.move': async (p) => {
      const { projectId, from, toDir } = RpcMethods['fs.move'].params.parse(p)
      return mgr.moveEntry(projectId, from, toDir)
    },
    'fs.importFile': async (p) => {
      const { projectId, toDir, name, dataBase64 } = RpcMethods['fs.importFile'].params.parse(p)
      return mgr.importFile(projectId, toDir, name, dataBase64)
    },
    'fs.resolve': async (p) => {
      const { projectId, path } = RpcMethods['fs.resolve'].params.parse(p)
      return { path: await mgr.resolveFile(projectId, path) }
    },
    'messages.search': async (p) => {
      const { query, limit } = RpcMethods['messages.search'].params.parse(p)
      return mgr.searchMessages(query, limit)
    },
    'approvals.deleteRule': async (p) => {
      mgr.deleteApprovalRule(RpcMethods['approvals.deleteRule'].params.parse(p).id)
      return { ok: true as const }
    },
    'workspace.save': async (p) => {
      mgr.saveWorkspace(RpcMethods['workspace.save'].params.parse(p).layout)
      return { ok: true as const }
    },
    'workspace.load': async () => mgr.loadWorkspace(),
    'projects.add': async (p) => {
      const info = await mgr.addProject(RpcMethods['projects.add'].params.parse(p).path)
      externalApps?.refresh()
      return info
    },
    'orchestrator.get': async () => mgr.orchestrator(),
    'orchestrator.peek': async () => mgr.orchestratorPeek(),
    'orchestrator.configure': async (p) => {
      mgr.configureOrchestrator(RpcMethods['orchestrator.configure'].params.parse(p).tool)
      return { ok: true as const }
    },
    'apps.viewFrame': async (p) => {
      const { appId, projectId, instanceId, hostOrigin } = RpcMethods['apps.viewFrame'].params.parse(p)
      return requireViews().frame({ app: { appId, projectId }, instanceId, hostOrigin })
    },
    'apps.openView': async (p) => {
      const { appId, projectId } = RpcMethods['apps.openView'].params.parse(p)
      return openHomeView(requireExternalApps(), requireViews(), { appId, projectId })
    },
    'apps.closeView': async (p) => {
      const { instanceId } = RpcMethods['apps.closeView'].params.parse(p)
      // If it is a view inside a conversation, that side closes it (along with its own record). Otherwise it is the fixed view
      if (!inlineViews?.close(instanceId)) requireViews().close(instanceId)
      return { ok: true as const }
    },
    'apps.inlineReopen': async (p) => {
      const { sessionId, callId } = RpcMethods['apps.inlineReopen'].params.parse(p)
      if (!inlineViews) throw Object.assign(new Error('App views are unavailable'), { code: 'internal' })
      return inlineViews.reopen(sessionId, callId)
    },
    // A host with no app runtime holds no views either — a reopened UI shows nothing but "open app"
    'apps.inlineViews': async (p) => inlineViews?.list(RpcMethods['apps.inlineViews'].params.parse(p).sessionId) ?? [],
    'apps.viewMessage': async (p) => {
      const { sessionId, instanceId, text } = RpcMethods['apps.viewMessage'].params.parse(p)
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
        throw Object.assign(new Error('This app view is not open in that conversation'), { code: 'internal' })
      }
      const ref = owner?.ref ?? views?.describe(instanceId)?.app ?? null
      if (!ref) throw Object.assign(new Error('This app view is not open'), { code: 'internal' })
      const name = externalApps?.list().find((a) => a.appId === ref.appId && a.projectId === ref.projectId)?.name
      await mgr.sendFromApp(sessionId, text, { appId: ref.appId, projectId: ref.projectId, name: name ?? ref.appId }, owner ? 'inline' : 'pinned')
      return { ok: true as const }
    },
    'apps.readResource': async (p) => {
      const { appId, projectId, uri, instanceId } = RpcMethods['apps.readResource'].params.parse(p)
      // The shape of the answer is known between the view and the app. Here, only enough is checked to keep the envelope from breaking
      return RpcMethods['apps.readResource'].result.parse(await requireViews().readResource({ appId, projectId }, uri, instanceId))
    },
    'apps.state': async (p) => {
      const { appId } = RpcMethods['apps.state'].params.parse(p)
      return mgr.appState(appId)
    },
    'apps.setState': async (p) => {
      const { appId, doc } = RpcMethods['apps.setState'].params.parse(p)
      mgr.setAppDoc(appId, doc)
      return { ok: true as const }
    },
    'apps.invoke': async (p) => {
      const { appId, name, args, projectId, instanceId } = RpcMethods['apps.invoke'].params.parse(p)
      // The built-in registry is checked first — an external app can never take a built-in app's id
      // (discovery blocks it), so the two branches never overlap
      if (projectId === undefined && HOST_APPS.some((a) => a.id === appId)) return mgr.invokeAppTool(appId, name, args)
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
    'apps.setEnabled': async (p) => {
      const { appId, enabled } = RpcMethods['apps.setEnabled'].params.parse(p)
      mgr.setAppEnabled(appId, enabled)
      return { ok: true as const }
    },
    'apps.list': async () => externalApps?.list() ?? [],
    'apps.runs': async (p) => {
      const { appId, projectId, limit } = RpcMethods['apps.runs'].params.parse(p)
      return requireExternalApps().runs({ appId, projectId }, limit)
    },
    'apps.restart': async (p) => {
      const { appId, projectId } = RpcMethods['apps.restart'].params.parse(p)
      await requireExternalApps().restart({ appId, projectId })
      return { ok: true as const }
    },
    'apps.remove': async (p) => {
      const { appId, projectId } = RpcMethods['apps.remove'].params.parse(p)
      requireExternalApps().removeUserApp({ appId, projectId })
      return { ok: true as const }
    },
    'apps.setSecret': async (p) => {
      // The value goes straight to the runtime here — this layer never records it and never returns it
      const { appId, projectId, name, value } = RpcMethods['apps.setSecret'].params.parse(p)
      requireExternalApps().updateSecret({ appId, projectId }, name, value)
      return { ok: true as const }
    },
    // Import (M4 E-3) — prepare (waiting room) → the person looks it over → admit (disabled at first,
    // with a review step if requested). All the judgment calls are made by the runtime's handoff
    'apps.importPrepare': async (p) => requireExternalApps().prepareImport(RpcMethods['apps.importPrepare'].params.parse(p).source),
    'apps.importCommit': async (p) => {
      const { token, enable, reviewKey } = RpcMethods['apps.importCommit'].params.parse(p)
      return requireExternalApps().commitImport(token, { enable, ...(reviewKey !== undefined ? { reviewKey } : {}) })
    },
    'apps.importCancel': async (p) => {
      requireExternalApps().cancelImport(RpcMethods['apps.importCancel'].params.parse(p).token)
      return { ok: true as const }
    },
    'apps.review': async (p) => {
      const { appId, projectId } = RpcMethods['apps.review'].params.parse(p)
      return requireExternalApps().reviewApp({ appId, projectId })
    },
    'apps.enable': async (p) => {
      const { appId, projectId, reviewKey } = RpcMethods['apps.enable'].params.parse(p)
      return requireExternalApps().enableApp({ appId, projectId }, reviewKey)
    },
    /*
     * App versions (M4 E-1). For a user-folder app, versions are snapshots the runtime took; for a
     * project app, they are git — the recent commits that touched that app's folder are read here
     * (the core). The runtime does not know git (`host-app-runtime-physics-only`): deciding what
     * counts as a version, based on where the app lives, is the core's call.
     */
    'apps.versions': async (p) => {
      const { appId, projectId } = RpcMethods['apps.versions'].params.parse(p)
      const apps = requireExternalApps()
      if (projectId === null) return { kind: 'snapshots' as const, snapshots: apps.snapshots({ appId, projectId }).map(({ stamp: _stamp, ...s }) => s) }
      const project = (await mgr.listProjects()).find((x) => x.id === projectId)
      const app = apps.list().find((a) => a.appId === appId && a.projectId === projectId)
      if (!project || !app) throw Object.assign(new Error(`There is no such app: ${projectId}/${appId}`), { code: 'internal' })
      const { repo, commits } = await gitLogPath(project.path, relative(project.path, app.dir), 20)
      return { kind: 'git' as const, repo, commits }
    },
    'apps.restoreVersion': async (p) => {
      const { appId, projectId, id } = RpcMethods['apps.restoreVersion'].params.parse(p)
      return requireExternalApps().restoreVersion({ appId, projectId }, id)
    },
    'apps.create': async (p) => mgr.createApp(RpcMethods['apps.create'].params.parse(p)),
    'apps.builder': async (p) => {
      const { appId, projectId } = RpcMethods['apps.builder'].params.parse(p)
      return mgr.builderOf({ appId, projectId })
    },
    'apps.errors': async (p) => {
      const { appId, projectId } = RpcMethods['apps.errors'].params.parse(p)
      return requireExternalApps().errors({ appId, projectId })
    },
    'apps.check': async (p) => {
      const { appId, projectId } = RpcMethods['apps.check'].params.parse(p)
      const r = await mgr.checkApp({ appId, projectId })
      return { ok: r.ok, text: r.text, findings: r.findings }
    },
    // A capability question (M4 D-4) — one from a chain started by a view. One started by a session
    // comes through `agents.respondApproval` as that session's own approval card
    'apps.questions': async () => mgr.appQuestionList(),
    'apps.answerQuestion': async (p) => {
      const { questionId, decision } = RpcMethods['apps.answerQuestion'].params.parse(p)
      mgr.answerAppQuestion(questionId, decision)
      return { ok: true as const }
    },
    'apps.permissions': async (p) => {
      const { appId, projectId } = RpcMethods['apps.permissions'].params.parse(p)
      return requireExternalApps().permissions({ appId, projectId })
    },
    'apps.forgetPermission': async (p) => {
      const { appId, projectId, capability } = RpcMethods['apps.forgetPermission'].params.parse(p)
      requireExternalApps().forgetPermission({ appId, projectId }, capability)
      return { ok: true as const }
    },
    'apps.usage': async (p) => {
      const { appId, projectId } = RpcMethods['apps.usage'].params.parse(p)
      return requireExternalApps().agentUse({ appId, projectId })
    },
    'apps.createBuilder': async (p) => {
      const { appId, projectId, tool } = RpcMethods['apps.createBuilder'].params.parse(p)
      return mgr.createAppBuilder({ appId, projectId }, tool)
    },
    'apps.sendError': async (p) => {
      const { appId, projectId, at } = RpcMethods['apps.sendError'].params.parse(p)
      return sendErrorToBuilder(
        { apps: requireExternalApps(), views, builderOf: (ref) => mgr.builderOf(ref), send: (id, t, a) => mgr.send(id, t, a) },
        { appId, projectId },
        at,
      )
    },
    'apps.askBuilder': async (p) => {
      const { appId, projectId, text, attachments, instanceId } = RpcMethods['apps.askBuilder'].params.parse(p)
      return askBuilder(
        { apps: requireExternalApps(), views, builderOf: (ref) => mgr.builderOf(ref), send: (id, t, a) => mgr.send(id, t, a) },
        { ref: { appId, projectId }, text, attachments, instanceId },
      )
    },
    'orchestrator.tools': async (p) => {
      const { sessionId } = RpcMethods['orchestrator.tools'].params.parse(p)
      // The full list when no session is given (for compatibility) — only that session's bundle when one is known (#69: the manager takes a subset)
      const profile = sessionId ? mgr.toolProfileOf(sessionId) : 'orchestrator'
      return orchestratorToolSchemas(profile ?? 'orchestrator')
    },
    'orchestrator.tool': async (p) => {
      const { sessionId, name, args } = RpcMethods['orchestrator.tool'].params.parse(p)
      return mgr.runOrchestratorTool(sessionId, name, args)
    },
    'apps.sessionTools': async (p) => {
      const { sessionId, server } = RpcMethods['apps.sessionTools'].params.parse(p)
      return { tools: await mgr.appSessionTools(sessionId, server) }
    },
    'apps.sessionCall': async (p) => {
      const { sessionId, server, name, args, waitMs } = RpcMethods['apps.sessionCall'].params.parse(p)
      return mgr.callAppForSession(sessionId, server, name, args, waitMs)
    },
    'grid.get': async () => mgr.grid(),
    'grid.set': async (p) =>
      mgr.setGridView(RpcMethods['grid.set'].params.parse(p).panels),
    'processes.strays': async () => findStrays(mgr.folderRoots()),
    'processes.stop': async (p) =>
      stopStrays(RpcMethods['processes.stop'].params.parse(p).pids, mgr.folderRoots()),
    'projects.list': async () => mgr.listProjects(),
    'projects.reorder': async (p) =>
      mgr.reorderProjects(RpcMethods['projects.reorder'].params.parse(p).orderedIds),
    'projects.delete': async (p) => {
      const { projectId } = RpcMethods['projects.delete'].params.parse(p)
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
      return { ok: true as const }
    },
    'projects.setTrusted': async (p) => {
      const { projectId, trusted } = RpcMethods['projects.setTrusted'].params.parse(p)
      mgr.setProjectTrusted(projectId, trusted)
      externalApps?.refresh()
      return { ok: true as const }
    },
    'projects.setCommands': async (p) => {
      const { projectId, commands } = RpcMethods['projects.setCommands'].params.parse(p)
      return mgr.setProjectCommands(projectId, commands)
    },
    'worktrees.createManager': async (p) => {
      const { projectId, baseBranch } = RpcMethods['worktrees.createManager'].params.parse(p)
      return mgr.createWorktreeManager(projectId, baseBranch)
    },
    'projects.setWorktreeSetup': async (p) => {
      const { projectId, setup } = RpcMethods['projects.setWorktreeSetup'].params.parse(p)
      mgr.setWorktreeSetup(projectId, setup)
      return { ok: true as const }
    },
    'sessions.reorder': async (p) => {
      const { projectId, orderedIds } = RpcMethods['sessions.reorder'].params.parse(p)
      return mgr.reorderSessions(projectId, orderedIds)
    },
    'projects.gitStatus': async (p) => {
      const { projectId } = RpcMethods['projects.gitStatus'].params.parse(p)
      return mgr.projectGitStatus(projectId)
    },
    'sessions.list': async () => mgr.listSessions(),
    'sessions.rename': async (p) => {
      const { sessionId, name } = RpcMethods['sessions.rename'].params.parse(p)
      mgr.rename(sessionId, name)
      return { ok: true as const }
    },
    'sessions.markRead': async (p) => {
      const { sessionId, seq } = RpcMethods['sessions.markRead'].params.parse(p)
      mgr.markRead(sessionId, seq)
      return { ok: true as const }
    },
    'messages.load': async (p) => {
      const { sessionId, limit, beforeSeq } = RpcMethods['messages.load'].params.parse(p)
      return mgr.loadMessages(sessionId, limit, beforeSeq)
    },
    'messages.subagent': async (p) => {
      const { sessionId, parentCallId, afterSeq, limit } = RpcMethods['messages.subagent'].params.parse(p)
      return mgr.loadSubagentMessages(sessionId, parentCallId, afterSeq, limit)
    },
    'agents.commands': async (p) =>
      mgr.listCommands(RpcMethods['agents.commands'].params.parse(p).sessionId),
    'agents.usage': async (p) => mgr.usageFor(RpcMethods['agents.usage'].params.parse(p).tool),
    'files.search': async (p) => {
      const { projectId, query, limit } = RpcMethods['files.search'].params.parse(p)
      return searchFiles(mgr.cwdOfProject(projectId), query, limit)
    },
    'terminal.list': async (p) => {
      const { projectId } = RpcMethods['terminal.list'].params.parse(p)
      // A terminal's key is the **directory**, not the project (preparation for worktrees)
      const cwd = mgr.cwdOfProject(projectId)
      return { terminals: requireTerminals().list(cwd).map(toInfo) }
    },
    'terminal.create': async (p) => {
      const { projectId, cols, rows } = RpcMethods['terminal.create'].params.parse(p)
      return toInfo(requireTerminals().create(mgr.cwdOfProject(projectId), cols, rows))
    },
    'terminal.close': async (p) => {
      requireTerminals().close(RpcMethods['terminal.close'].params.parse(p).terminalId)
      return { ok: true as const }
    },
    'terminal.input': async (p) => {
      const { terminalId, data } = RpcMethods['terminal.input'].params.parse(p)
      requireTerminals().input(terminalId, data)
      return { ok: true as const }
    },
    'terminal.resize': async (p) => {
      const { terminalId, cols, rows } = RpcMethods['terminal.resize'].params.parse(p)
      requireTerminals().resize(terminalId, cols, rows)
      return { ok: true as const }
    },
    'terminal.restart': async (p) => {
      const { terminalId, cols, rows } = RpcMethods['terminal.restart'].params.parse(p)
      const h = requireTerminals().restart(terminalId, cols, rows)
      if (!h) throw Object.assign(new Error('Terminal not found'), { code: 'internal' })
      return toInfo(h)
    },
    // Runner for frequently used commands (#60) — the same cwd rule as the terminal (preparation for worktrees)
    'commands.run': async (p) => {
      const { projectId, command, cols, rows } = RpcMethods['commands.run'].params.parse(p)
      const { history: _h, ...rest } = requireCommands().run(mgr.cwdOfProject(projectId), command, cols, rows)
      return rest
    },
    'commands.stop': async (p) => {
      const { projectId, command } = RpcMethods['commands.stop'].params.parse(p)
      requireCommands().stop(mgr.cwdOfProject(projectId), command)
      return { ok: true as const }
    },
    'commands.state': async (p) => {
      const { projectId } = RpcMethods['commands.state'].params.parse(p)
      return { runs: requireCommands().state(mgr.cwdOfProject(projectId)) }
    },
    'commands.log': async (p) => {
      const { projectId, command } = RpcMethods['commands.log'].params.parse(p)
      return { run: requireCommands().log(mgr.cwdOfProject(projectId), command) }
    },
    'commands.resize': async (p) => {
      const { projectId, command, cols, rows } = RpcMethods['commands.resize'].params.parse(p)
      requireCommands().resize(mgr.cwdOfProject(projectId), command, cols, rows)
      return { ok: true as const }
    },
    'prefs.get': async () => mgr.uiPreferences(),
    'prefs.set': async (p) => mgr.setUiPreferences(RpcMethods['prefs.set'].params.parse(p).patch),
    'approvals.rules': async () => mgr.listApprovalRules(),
    /*
     * The trash (#204). These are the person's: this handler is reached only over the UI's socket. The agents'
     * tools (`orchestrator-tools.ts`) and the apps' broker (`broker.ts`, `host_data`) have no verb for any of it.
     */
    'trash.list': async () => mgr.listTrash(),
    'trash.read': async (p) => {
      const { sessionId, limit, beforeSeq } = RpcMethods['trash.read'].params.parse(p)
      return mgr.readTrashed(sessionId, limit, beforeSeq)
    },
    'trash.restore': async (p) => {
      const r = await mgr.restoreSession(RpcMethods['trash.restore'].params.parse(p).sessionId)
      // A project registered again is a project added — its apps are read the same way (`projects.add`)
      if (r.project) externalApps?.refresh()
      return r
    },
    'trash.purge': async (p) => {
      await mgr.purgeSession(RpcMethods['trash.purge'].params.parse(p).sessionId)
      return { ok: true as const }
    },
    'trash.empty': async () => mgr.emptyTrash(),
    'updates.status': async (p) => requireUpdates().check(RpcMethods['updates.status'].params.parse(p).force),
    'updates.setAuto': async (p) => requireUpdates().setAuto(RpcMethods['updates.setAuto'].params.parse(p).enabled),
    // Answers once the install has started, not once it has finished — see the note on
    // `updates.apply` in the protocol. The rest arrives as `update_status` events.
    'updates.apply': async () => requireUpdates().apply(),
  }

  return async (method: string, params: unknown): Promise<unknown> => {
    const name = method as RpcMethodName
    const h = handlers[name]
    if (!h) throw Object.assign(new Error(`Unknown method: ${method}`), { code: 'internal' })
    const result = await h(params)

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
      throw Object.assign(new Error(`${method}'s response does not match its declaration — ${where}`), { code: 'internal' })
    }
    return checked.data
  }
}
