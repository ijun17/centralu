import type {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalScope,
  CreateSessionParams,
  NormalizedEvent,
  ProjectInfo,
  SessionInfo,
  StoredMessage,
  ToolName,
} from '@cc/protocol'
import type { AgentPort, ConnectionState, Platform, ProjectPort, SystemPort, Unsubscribe } from '../ports/index.js'
import { RpcClient } from './rpc-client.js'

/**
 * 브라우저(dev) 구현. 대부분이 "WS로 host에 위임"이다 —
 * Tauri 전환 1단계에서 이 구현을 그대로 재사용한다 (docs/platform-abstraction.md §5).
 */
export type WebPlatformOptions = {
  hostUrl?: string
  token: string
  WebSocketImpl?: typeof WebSocket
}

class WebAgentPort implements AgentPort {
  constructor(private rpc: RpcClient) {}
  createSession(params: CreateSessionParams) {
    return this.rpc.call<SessionInfo>('agents.createSession', params)
  }
  async send(sessionId: string, text: string) {
    await this.rpc.call('agents.send', { sessionId, text })
  }
  async respondApproval(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
    matcher?: string,
  ) {
    await this.rpc.call('agents.respondApproval', { sessionId, requestId, decision, scope, matcher })
  }
  async interrupt(sessionId: string) {
    await this.rpc.call('agents.interrupt', { sessionId })
  }
  async archiveSession(sessionId: string) {
    await this.rpc.call('agents.archiveSession', { sessionId })
  }
  resumeSession(sessionId: string) {
    return this.rpc.call<{ session: SessionInfo; resumed: boolean; reason?: string }>('agents.resumeSession', {
      sessionId,
    })
  }
  async rename(sessionId: string, name: string) {
    await this.rpc.call('sessions.rename', { sessionId, name })
  }
  async markRead(sessionId: string, seq: number) {
    await this.rpc.call('sessions.markRead', { sessionId, seq })
  }
  listSessions() {
    return this.rpc.call<SessionInfo[]>('sessions.list', {})
  }
  loadMessages(sessionId: string, limit = 200, beforeSeq?: number) {
    return this.rpc.call<StoredMessage[]>('messages.load', { sessionId, limit, beforeSeq })
  }
  capabilities(tool: ToolName) {
    return this.rpc.call<AdapterCapabilities>('agents.capabilities', { tool })
  }
  detect() {
    return this.rpc.call<{ tool: ToolName; installed: boolean; loggedIn: boolean; detail: string }[]>('agents.detect', {})
  }
  subscribe(handler: (e: NormalizedEvent) => void): Unsubscribe {
    return this.rpc.onEvent(handler)
  }
  onConnectionChange(handler: (s: ConnectionState) => void): Unsubscribe {
    return this.rpc.onConnectionChange(handler)
  }
}

class WebProjectPort implements ProjectPort {
  constructor(private rpc: RpcClient) {}
  add(path: string) {
    return this.rpc.call<ProjectInfo>('projects.add', { path })
  }
  list() {
    return this.rpc.call<ProjectInfo[]>('projects.list', {})
  }
  gitStatus(projectId: string) {
    return this.rpc.call<ProjectInfo>('projects.gitStatus', { projectId })
  }
}

/** 웹 폴백 — capability가 false이므로 UI가 알아서 기능을 숨긴다 */
class WebSystemPort implements SystemPort {
  async notify(title: string, body: string) {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'granted') new Notification(title, { body })
  }
  async setBadge(_count: number) {
    /* 브라우저에는 독 뱃지가 없다 */
  }
  async pickDirectory(): Promise<string | null> {
    // 브라우저에는 디렉토리 피커가 없다 — dev 전용 폴백
    return window.prompt('프로젝트 디렉토리의 전체 경로를 입력하세요', '')
  }
  async openInIde(_path: string, _line?: number) {
    /* Tauri에서만 (capability로 UI가 비활성) */
  }
}

export function createWebPlatform(opts: WebPlatformOptions): Platform {
  const url = new URL(opts.hostUrl ?? 'ws://127.0.0.1:5175')
  const rpc = new RpcClient({ url: url.toString(), token: opts.token, WebSocketImpl: opts.WebSocketImpl })
  rpc.connect()

  return {
    agents: new WebAgentPort(rpc),
    projects: new WebProjectPort(rpc),
    system: new WebSystemPort(),
    capabilities: {
      osNotifications: typeof Notification !== 'undefined',
      dockBadge: false,
      globalShortcuts: false,
      processSupervision: false,
      openInIde: false,
    },
    async dispose() {
      rpc.close()
    },
  }
}

export { RpcClient }
