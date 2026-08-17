import { RpcMethods, type RpcMethodName } from '@cc/protocol'
import type { SessionManager } from './sessions/manager.js'
import { searchFiles } from './dev-services/file-search.js'
import type { TerminalHandle, TerminalService } from './dev-services/terminal.js'

/** 내부 핸들 → 프로토콜 모양 (history는 그때그때 스냅샷으로 뜬다) */
const toInfo = (h: TerminalHandle) => ({
  terminalId: h.id,
  cwd: h.cwd,
  title: h.title,
  history: h.history(),
  alive: h.alive,
})
import type { AgentAdapter } from './adapters/contract.js'
import type { ToolName } from '@cc/protocol'

/** RPC 라우팅. 파라미터는 경계에서 1회만 검증한다 (docs/protocol.md §4) */
export function createRpcHandler(
  mgr: SessionManager,
  adapters: Map<ToolName, AgentAdapter>,
  terminals?: TerminalService,
) {
  const requireTerminals = (): TerminalService => {
    if (!terminals) throw Object.assign(new Error('Terminals are unavailable'), { code: 'internal' })
    return terminals
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
      await mgr.deleteSession(RpcMethods['agents.deleteSession'].params.parse(p).sessionId)
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
    'fs.readFile': async (p) => {
      const { projectId, path } = RpcMethods['fs.readFile'].params.parse(p)
      return mgr.readTextFile(projectId, path)
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
    'projects.list': async () => mgr.listProjects(),
    'projects.reorder': async (p) =>
      mgr.reorderProjects(RpcMethods['projects.reorder'].params.parse(p).orderedIds),
    'sessions.reorder': async (p) => {
      const { projectId, orderedIds } = RpcMethods['sessions.reorder'].params.parse(p)
      return mgr.reorderSessions(projectId, orderedIds)
    },
    'projects.gitStatus': async (p) => {
      const { projectId } = RpcMethods['projects.gitStatus'].params.parse(p)
      const all = await mgr.listProjects()
      const found = all.find((x) => x.id === projectId)
      if (!found) throw Object.assign(new Error('Project not found'), { code: 'internal' })
      return found
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
    'approvals.rules': async () => mgr.listApprovalRules(),
  }

  return async (method: string, params: unknown): Promise<unknown> => {
    const h = handlers[method as RpcMethodName]
    if (!h) throw Object.assign(new Error(`Unknown method: ${method}`), { code: 'internal' })
    return h(params)
  }
}
