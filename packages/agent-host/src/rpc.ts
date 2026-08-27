import { RpcMethods, type RpcMethodName } from '@cc/protocol'
import type { SessionManager } from './sessions/manager.js'
import { searchFiles } from './dev-services/file-search.js'
import type { TerminalHandle, TerminalService } from './dev-services/terminal.js'
import type { CommandRunner } from './dev-services/commands.js'

/** 내부 핸들 → 프로토콜 모양 (history는 그때그때 스냅샷으로 뜬다) */
const toInfo = (h: TerminalHandle) => ({
  terminalId: h.id,
  cwd: h.cwd,
  title: h.title,
  history: h.history(),
  alive: h.alive,
})
import type { UpdateService } from './updates.js'
import { orchestratorToolSchemas } from './sessions/orchestrator-tools.js'
import type { AgentAdapter } from './adapters/contract.js'
import type { ToolName } from '@cc/protocol'

/** RPC 라우팅. 파라미터는 경계에서 1회만 검증한다 (docs/protocol.md §4) */
export function createRpcHandler(
  mgr: SessionManager,
  adapters: Map<ToolName, AgentAdapter>,
  terminals?: TerminalService,
  updates?: UpdateService,
  commands?: CommandRunner,
) {
  const requireTerminals = (): TerminalService => {
    if (!terminals) throw Object.assign(new Error('Terminals are unavailable'), { code: 'internal' })
    return terminals
  }
  const requireCommands = (): CommandRunner => {
    if (!commands) throw Object.assign(new Error('Command runs are unavailable'), { code: 'internal' })
    return commands
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
    'agents.archiveSession': async (p) => {
      const a = RpcMethods['agents.archiveSession'].params.parse(p)
      await mgr.archive(a.sessionId, a.archived)
      return { ok: true as const }
    },
    'agents.deleteSession': async (p) => {
      const { sessionId, deleteWorktree } = RpcMethods['agents.deleteSession'].params.parse(p)
      await mgr.deleteSession(sessionId, deleteWorktree)
      return { ok: true as const }
    },
    'agents.worktreeStatus': async (p) =>
      mgr.worktreeStatus(RpcMethods['agents.worktreeStatus'].params.parse(p).sessionId),
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
       * **필드를 하나씩 꺼내 쓰지 않는다.**
       *
       * effort를 추가했을 때 여기서 꺼내는 걸 빠뜨렸고, UI는 보내는데 host에는
       * 도착하지 않아 아무 일도 안 일어났다 — 오류도 없이 조용히 무시됐다.
       * parse된 결과를 통째로 넘기면 설정이 늘어나도 이 자리를 다시 고칠 일이 없다.
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
    'agents.detect': async () => Promise.all([...adapters.values()].map((a) => a.detect())),
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
    'projects.add': async (p) => mgr.addProject(RpcMethods['projects.add'].params.parse(p).path),
    'orchestrator.get': async () => mgr.orchestrator(),
    'orchestrator.peek': async () => mgr.orchestratorPeek(),
    'orchestrator.configure': async (p) => {
      mgr.configureOrchestrator(RpcMethods['orchestrator.configure'].params.parse(p).tool)
      return { ok: true as const }
    },
    'orchestrator.tools': async () => orchestratorToolSchemas(),
    'orchestrator.tool': async (p) => {
      const { sessionId, name, args } = RpcMethods['orchestrator.tool'].params.parse(p)
      return mgr.runOrchestratorTool(sessionId, name, args)
    },
    'grid.get': async () => mgr.grid(),
    'grid.set': async (p) =>
      mgr.setGridView(RpcMethods['grid.set'].params.parse(p).sessionIds),
    'projects.list': async () => mgr.listProjects(),
    'projects.reorder': async (p) =>
      mgr.reorderProjects(RpcMethods['projects.reorder'].params.parse(p).orderedIds),
    'projects.setCommands': async (p) => {
      const { projectId, commands } = RpcMethods['projects.setCommands'].params.parse(p)
      return mgr.setProjectCommands(projectId, commands)
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
    'sessions.setKind': async (p) => {
      const { sessionId, kind } = RpcMethods['sessions.setKind'].params.parse(p)
      return mgr.setSessionKind(sessionId, kind)
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
    'agents.commands': async (p) =>
      mgr.listCommands(RpcMethods['agents.commands'].params.parse(p).sessionId),
    'agents.usage': async (p) => mgr.usageFor(RpcMethods['agents.usage'].params.parse(p).tool),
    'files.search': async (p) => {
      const { projectId, query, limit } = RpcMethods['files.search'].params.parse(p)
      return searchFiles(mgr.cwdOfProject(projectId), query, limit)
    },
    'terminal.list': async (p) => {
      const { projectId } = RpcMethods['terminal.list'].params.parse(p)
      // 터미널의 키는 프로젝트가 아니라 **디렉토리**다 (워크트리를 위한 준비)
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
    // 자주 쓰는 명령어 실행기 (#60) — 터미널과 같은 cwd 규칙 (워크트리 준비)
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
    'approvals.rules': async () => mgr.listApprovalRules(),
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
     * 내보내는 것이 **선언한 모양과 같은지** 여기서 확인한다.
     *
     * result 스키마 50개는 오랫동안 런타임에서 한 번도 쓰이지 않았다 — 문서일 뿐
     * 아무도 지키지 않는 약속이었다. 그동안 통로가 스키마와 어긋나도 아무 일도
     * 일어나지 않았고, 실제로 두 번 어긋났다 (effort 유실, Codex 모델 shape).
     *
     * 켜기 전에 실 host로 47/50을 대조해 스키마가 실제 응답과 맞는 것을 확인했다
     * (`pnpm smoke:schemas`). 그러지 않고 켜면 틀린 스키마가 멀쩡한 기능을 죽인다.
     *
     * 던지는 이유: 모양이 어긋난 응답을 그대로 보내면 화면에서 이상하게 나타나고,
     * 그때는 어디서 어긋났는지 알 수 없다. 여기가 가장 가까운 자리다.
     */
    const checked = RpcMethods[name].result.safeParse(result)
    if (!checked.success) {
      const where = checked.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join(' / ')
      throw Object.assign(new Error(`${method}의 응답이 선언과 다릅니다 — ${where}`), { code: 'internal' })
    }
    return checked.data
  }
}
