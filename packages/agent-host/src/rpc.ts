import { RpcMethods, type RpcMethodName } from '@cc/protocol'
import type { SessionManager } from './sessions/manager.js'
import type { AgentAdapter } from './adapters/contract.js'
import type { ToolName } from '@cc/protocol'

/** RPC 라우팅. 파라미터는 경계에서 1회만 검증한다 (docs/protocol.md §4) */
export function createRpcHandler(mgr: SessionManager, adapters: Map<ToolName, AgentAdapter>) {
  const handlers: { [M in RpcMethodName]: (p: unknown) => Promise<unknown> } = {
    'agents.createSession': async (p) => mgr.createSession(RpcMethods['agents.createSession'].params.parse(p)),
    'agents.send': async (p) => {
      const { sessionId, text } = RpcMethods['agents.send'].params.parse(p)
      mgr.send(sessionId, text)
      return { ok: true as const }
    },
    'agents.respondApproval': async (p) => {
      const { sessionId, requestId, decision, scope } = RpcMethods['agents.respondApproval'].params.parse(p)
      mgr.respondApproval(sessionId, requestId, decision, scope)
      return { ok: true as const }
    },
    'agents.interrupt': async (p) => {
      mgr.interrupt(RpcMethods['agents.interrupt'].params.parse(p).sessionId)
      return { ok: true as const }
    },
    'agents.archiveSession': async (p) => {
      await mgr.archive(RpcMethods['agents.archiveSession'].params.parse(p).sessionId)
      return { ok: true as const }
    },
    'agents.capabilities': async (p) => {
      const { tool } = RpcMethods['agents.capabilities'].params.parse(p)
      const a = adapters.get(tool)
      if (!a) throw Object.assign(new Error(`알 수 없는 도구: ${tool}`), { code: 'tool_not_installed' })
      return a.capabilities
    },
    'agents.detect': async () => Promise.all([...adapters.values()].map((a) => a.detect())),
    'projects.add': async (p) => mgr.addProject(RpcMethods['projects.add'].params.parse(p).path),
    'projects.list': async () => mgr.listProjects(),
    'projects.gitStatus': async (p) => {
      const { projectId } = RpcMethods['projects.gitStatus'].params.parse(p)
      const all = await mgr.listProjects()
      const found = all.find((x) => x.id === projectId)
      if (!found) throw Object.assign(new Error('프로젝트를 찾을 수 없습니다'), { code: 'internal' })
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
    'approvals.rules': async () => [],
  }

  return async (method: string, params: unknown): Promise<unknown> => {
    const h = handlers[method as RpcMethodName]
    if (!h) throw Object.assign(new Error(`알 수 없는 메서드: ${method}`), { code: 'internal' })
    return h(params)
  }
}
