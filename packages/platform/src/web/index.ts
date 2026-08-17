import type {
  AdapterCapabilities,
  Attachment,
  PermissionPreset,
  ApprovalDecision,
  ApprovalScope,
  CreateSessionParams,
  CommandInfo,
  ExternalSession,
  NormalizedEvent,
  ProjectInfo,
  SessionInfo,
  StoredMessage,
  UsageSnapshot,
  TerminalInfo,
  ToolName,
  ModelOption,
} from '@cc/protocol'
import type { AgentPort, ConnectionState, Platform, ProjectPort, SystemPort, Unsubscribe, WorkspaceSnapshot } from '../ports/index.js'
import { RpcClient } from './rpc-client.js'

/**
 * 브라우저(dev) 구현. 대부분이 "WS로 host에 위임"이다 —
 * Tauri 전환 1단계에서 이 구현을 그대로 재사용한다 (docs/platform-abstraction.md §5).
 */
export type WebPlatformOptions = {
  /** host 재기동 시 새 포트·토큰을 알려주는 구독 (Tauri에서 주입) */
  onEndpointChange?: (cb: (info: { port: number; token: string }) => void) => Unsubscribe
  hostUrl?: string
  token: string
  WebSocketImpl?: typeof WebSocket
}

class WebAgentPort implements AgentPort {
  constructor(private rpc: RpcClient) {}
  createSession(params: CreateSessionParams) {
    return this.rpc.call<SessionInfo>('agents.createSession', params)
  }
  async send(sessionId: string, text: string, attachments?: Attachment[]) {
    await this.rpc.call('agents.send', { sessionId, text, attachments })
  }
  saveAttachment(sessionId: string, name: string, mime: string, dataBase64: string) {
    return this.rpc.call<Attachment>('attachments.save', { sessionId, name, mime, dataBase64 })
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
  reorderSessions(projectId: string, orderedIds: string[]) {
    return this.rpc.call<SessionInfo[]>('sessions.reorder', { projectId, orderedIds })
  }

  controlCenter() {
    return this.rpc.call<string[]>('controlCenter.get', {})
  }

  setControlCenter(sessionIds: string[]) {
    return this.rpc.call<string[]>('controlCenter.set', { sessionIds })
  }

  models(tool: ToolName) {
    return this.rpc.call<{ supported: boolean; reason?: string; models: ModelOption[] }>('agents.models', {
      tool,
    })
  }

  async interrupt(sessionId: string) {
    await this.rpc.call('agents.interrupt', { sessionId })
  }
  async archiveSession(sessionId: string, archived = true) {
    await this.rpc.call('agents.archiveSession', { sessionId, archived })
  }
  restartSession(sessionId: string) {
    return this.rpc.call<{ session: SessionInfo; resumed: boolean; reason?: string }>('agents.restartSession', {
      sessionId,
    })
  }
  updateSettings(sessionId: string, settings: { model?: string | null; permissionPreset?: PermissionPreset }) {
    return this.rpc.call<SessionInfo>('agents.updateSettings', { sessionId, ...settings })
  }
  async deleteSession(sessionId: string) {
    await this.rpc.call('agents.deleteSession', { sessionId })
  }
  listExternalSessions(projectId: string, tool: ToolName, limit = 30) {
    return this.rpc.call<{ supported: boolean; reason?: string; sessions: ExternalSession[] }>(
      'agents.listExternalSessions',
      { projectId, tool, limit },
    )
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
  commands(sessionId: string) {
    return this.rpc.call<{ ready: boolean; commands: CommandInfo[] }>('agents.commands', { sessionId })
  }
  usage(tool: ToolName) {
    return this.rpc.call<{ supported: boolean; reason?: string; usage: UsageSnapshot | null }>('agents.usage', {
      tool,
    })
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
  reorder(orderedIds: string[]) {
    return this.rpc.call<ProjectInfo[]>('projects.reorder', { orderedIds })
  }
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
  async startWindowDrag(): Promise<void> {
    // 브라우저에는 옮길 창이 없다
  }

  async pickDirectory(): Promise<string | null> {
    // 브라우저에는 디렉토리 피커가 없다 — dev 전용 폴백
    return window.prompt('Enter the full path of the project directory', '')
  }
  async openInIde(_path: string, _line?: number) {
    /* Tauri에서만 (capability로 UI가 비활성) */
  }
}

export function createWebPlatform(opts: WebPlatformOptions): Platform {
  const url = new URL(opts.hostUrl ?? 'ws://127.0.0.1:5175')
  const rpc = new RpcClient({ url: url.toString(), token: opts.token, WebSocketImpl: opts.WebSocketImpl })
  rpc.connect()

  // host가 재기동되면 새 주소로 갈아탄다 (Tauri 수퍼바이저가 알려준다)
  const unsubscribeEndpoint = opts.onEndpointChange?.((next) => {
    rpc.updateEndpoint(`ws://127.0.0.1:${next.port}`, next.token)
  })

  return {
    agents: new WebAgentPort(rpc),
    projects: new WebProjectPort(rpc),
    system: new WebSystemPort(),
    search: {
      messages: (query, limit) => rpc.call('messages.search', { query, limit }),
    },
    rules: {
      list: () => rpc.call('approvals.rules', {}),
      remove: async (id) => {
        await rpc.call('approvals.deleteRule', { id })
      },
    },
    fs: {
      search: (projectId, query, limit) => rpc.call('files.search', { projectId, query, limit }),
      listDir: (projectId, path) => rpc.call('fs.listDir', { projectId, path }),
      readFile: (projectId, path) => rpc.call('fs.readFile', { projectId, path }),
    },
    git: {
      status: (projectId) => rpc.call('git.status', { projectId }),
      diff: (projectId, path, staged) => rpc.call('git.diff', { projectId, path, staged }),
      log: (projectId, limit) => rpc.call('git.log', { projectId, limit }),
      commitDetail: (projectId, sha) => rpc.call('git.commitDetail', { projectId, sha }),
      branches: (projectId) => rpc.call('git.branches', { projectId }),
      checkout: (projectId, branch, dryRun) => rpc.call('git.checkout', { projectId, branch, dryRun }),
      stage: async (projectId, paths, unstage) => {
        await rpc.call('git.stage', { projectId, paths, unstage })
      },
      commit: (projectId, message) => rpc.call('git.commit', { projectId, message }),
      push: (projectId) => rpc.call('git.push', { projectId }),
    },
    terminal: {
      list: async (projectId) =>
        (await rpc.call<{ terminals: TerminalInfo[] }>('terminal.list', { projectId })).terminals,
      create: (projectId, cols, rows) => rpc.call('terminal.create', { projectId, cols, rows }),
      close: async (terminalId) => {
        await rpc.call('terminal.close', { terminalId })
      },
      input: async (terminalId, data) => {
        await rpc.call('terminal.input', { terminalId, data })
      },
      resize: async (terminalId, cols, rows) => {
        await rpc.call('terminal.resize', { terminalId, cols, rows })
      },
      restart: (terminalId, cols, rows) => rpc.call('terminal.restart', { terminalId, cols, rows }),
      onOutput: (h) => rpc.onTerminalOutput(h),
      onExit: (h) => rpc.onTerminalExit(h),
    },
    workspace: {
      async save(snapshot) {
        await rpc.call('workspace.save', { layout: snapshot })
      },
      async load() {
        return (await rpc.call('workspace.load', {})) as WorkspaceSnapshot | null
      },
    },
    capabilities: {
      osNotifications: typeof Notification !== 'undefined',
      dockBadge: false,
      globalShortcuts: false,
      processSupervision: false,
      openInIde: false,
    },
    async dispose() {
      unsubscribeEndpoint?.()
      rpc.close()
    },
  }
}

export { RpcClient }
