import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import type {
  ApprovalDecision,
  ApprovalScope,
  CreateSessionParams,
  NormalizedEvent,
  ProjectInfo,
  SessionInfo,
  StoredMessage,
  ToolName,
} from '@cc/protocol'
import type { AgentAdapter, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { gitSummary } from '../dev-services/git.js'

/**
 * 세션 수명주기 + 영속화. 어댑터는 상태를 갖지 않으므로 (docs/agent-host.md §2)
 * 상태 추적·저장은 전부 여기서 한다.
 */
export class SessionManager {
  private handles = new Map<string, SessionHandle>()
  private meta = new Map<string, SessionInfo>()

  constructor(
    private store: Store,
    private adapters: Map<ToolName, AgentAdapter>,
    private emit: (e: NormalizedEvent) => void,
  ) {
    for (const s of store.listSessions()) this.meta.set(s.id, s)
  }

  async addProject(path: string): Promise<ProjectInfo> {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw Object.assign(new Error(`디렉토리를 찾을 수 없습니다: ${path}`), { code: 'internal' })
    }
    const existing = this.store.findProjectByPath(path)
    const id = existing?.id ?? randomUUID()
    this.store.addProject({ id, path, name: basename(path) })
    return this.projectInfo(id, path)
  }

  private async projectInfo(id: string, path: string): Promise<ProjectInfo> {
    const git = await gitSummary(path)
    return {
      id, path, name: basename(path), defaultTool: 'claude',
      git: git.isRepo ? git : null,
    }
  }

  async listProjects(): Promise<ProjectInfo[]> {
    return Promise.all(this.store.listProjects().map((p) => this.projectInfo(p.id, p.path)))
  }

  listSessions(): SessionInfo[] {
    return [...this.meta.values()].map((s) => ({ ...s, live: this.handles.has(s.id) }))
  }

  /** 같은 디렉토리에서 실행 중인 활성 세션 (FR-2 동시 세션 경고의 근거) */
  activeSessionsIn(projectId: string): SessionInfo[] {
    return this.listSessions().filter((s) => s.projectId === projectId && !s.archived)
  }

  async createSession(params: CreateSessionParams): Promise<SessionInfo> {
    const adapter = this.adapters.get(params.tool)
    if (!adapter) throw Object.assign(new Error(`알 수 없는 도구: ${params.tool}`), { code: 'tool_not_installed' })

    const id = randomUUID()
    const info: SessionInfo = {
      id, projectId: params.projectId, tool: params.tool, externalId: null,
      name: params.initialPrompt ? truncate(params.initialPrompt) : '새 세션',
      autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
      createdAt: Date.now(), waitingSince: null, live: true,
    }
    this.meta.set(id, info)
    this.store.upsertSession(info)

    const handle = await adapter.createSession(
      {
        sessionId: id, cwd: params.cwd, model: params.model,
        permissionPreset: params.permissionPreset, resumeExternalId: params.resumeExternalId,
      },
      (e) => this.onEvent(e),
    )
    this.handles.set(id, handle)

    if (params.initialPrompt) handle.send(params.initialPrompt)
    return info
  }

  /**
   * 기존 세션을 되살린다 (FR-10). host를 껐다 켜도 대화를 이어가기 위한 경로.
   *
   * 프로세스는 사라졌지만 external_id와 대화 기록은 store에 남아 있다.
   * 어댑터의 resume이 성공하면 같은 대화를 이어가고, 실패하면 **조용히 죽지 않고**
   * `resumable: false`로 알린다 — UI가 "기록 보기 + 새 세션"을 안내할 수 있도록.
   */
  async resumeSession(sessionId: string): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }> {
    const m = this.meta.get(sessionId)
    if (!m) throw Object.assign(new Error(`세션을 찾을 수 없습니다: ${sessionId}`), { code: 'session_not_found' })

    // 이미 살아 있으면 그대로 쓴다 (중복 프로세스를 만들지 않는다)
    if (this.handles.has(sessionId)) return { session: m, resumed: true }

    const adapter = this.adapters.get(m.tool)
    if (!adapter) return { session: m, resumed: false, reason: `${m.tool} 어댑터가 없습니다` }
    if (!adapter.capabilities.resume) return { session: m, resumed: false, reason: `${m.tool}는 재개를 지원하지 않습니다` }
    if (!m.externalId) return { session: m, resumed: false, reason: '재개에 필요한 세션 식별자가 없습니다' }

    const project = this.store.listProjects().find((p) => p.id === m.projectId)
    if (!project) return { session: m, resumed: false, reason: '프로젝트를 찾을 수 없습니다' }

    try {
      const handle = await adapter.createSession(
        { sessionId, cwd: project.path, permissionPreset: 'normal', resumeExternalId: m.externalId },
        (e) => this.onEvent(e),
      )
      this.handles.set(sessionId, handle)
      m.state = 'idle'
      m.waitingSince = null
      this.store.upsertSession(m)
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'resumed' })
      return { session: m, resumed: true }
    } catch (err) {
      return { session: m, resumed: false, reason: (err as Error).message }
    }
  }

  /** 프로세스가 살아 있는 세션 (UI가 "이어갈 수 있는지"를 아는 근거) */
  isLive(sessionId: string): boolean {
    return this.handles.has(sessionId)
  }

  /** 이벤트 수신 → 메타 갱신 → 메시지 영속화 → 전파 */
  private onEvent(e: NormalizedEvent): void {
    if (e.sessionId) {
      const m = this.meta.get(e.sessionId)
      if (m) {
        const handle = this.handles.get(e.sessionId)
        if (handle?.externalId && m.externalId !== handle.externalId) {
          m.externalId = handle.externalId
        }
        this.applyStateHint(e, m)
        this.persistMessage(e, m)
        this.store.upsertSession(m)
      }
    }
    this.emit(e)
  }

  /**
   * 저장용 상태 힌트.
   * 살아있는 상태의 권위는 UI(core 리듀서)에 있다 — agent-host는 core를 import하지 않으므로
   * (docs/architecture.md §2) 여기서는 복원(M1.5)에 쓸 최소 힌트만 기록한다.
   * 전이 규칙 판정은 하지 않는다 — 그건 core의 몫.
   */
  private applyStateHint(e: NormalizedEvent, m: SessionInfo): void {
    const hint =
      e.type === 'approval_request' ? 'waiting_approval'
      : e.type === 'turn_complete' ? 'waiting_input'
      : e.type === 'limit_reached' ? 'limited'
      : e.type === 'error' ? 'error'
      : e.type === 'state_change' ? e.state
      : e.type === 'message_delta' || e.type === 'tool_call' ? 'working'
      : null
    if (!hint || m.archived) return
    m.state = hint
    const waiting = hint === 'waiting_approval' || hint === 'waiting_input' || hint === 'error'
    m.waitingSince = waiting ? (m.waitingSince ?? Date.now()) : null
  }

  /** 대화 기록으로 남길 이벤트만 저장 (델타는 합치지 않고 텍스트만 누적) */
  private persistMessage(e: NormalizedEvent, m: SessionInfo): void {
    const kind =
      e.type === 'tool_call' ? 'tool_call'
      : e.type === 'tool_result' ? 'tool_result'
      : e.type === 'approval_request' || e.type === 'approval_resolved' ? 'approval'
      : e.type === 'message_delta' ? 'text'
      : null
    if (!kind) return
    const seq = this.store.nextSeq(m.id)
    const msg: StoredMessage = {
      sessionId: m.id, seq, role: e.type === 'message_delta' ? 'assistant' : 'system',
      kind, payload: e, ts: Date.now(),
    }
    this.store.appendMessages([msg])
    m.lastSeq = seq
  }

  send(sessionId: string, text: string): void {
    const h = this.requireHandle(sessionId)
    const m = this.meta.get(sessionId)!
    const seq = this.store.nextSeq(sessionId)
    this.store.appendMessages([{ sessionId, seq, role: 'user', kind: 'text', payload: { text }, ts: Date.now() }])
    m.lastSeq = seq
    m.lastReadSeq = seq // 내가 보낸 건 읽은 것
    if (m.autoNamed && m.name === '새 세션') {
      m.name = truncate(text)
      this.emit({ type: 'session_title', sessionId, title: m.name })
    }
    this.store.upsertSession(m)
    h.send(text)
  }

  respondApproval(sessionId: string, requestId: string, decision: ApprovalDecision, scope?: ApprovalScope): void {
    const m = this.meta.get(sessionId)
    if (decision === 'always' && m) {
      // 규칙 영속화 — 어댑터는 세션 메모리에만 갖고 있으므로 재시작 후에도 남으려면 여기 필요
      this.store.addApprovalRule({
        scope: scope ?? 'session',
        sessionId: scope === 'project' ? undefined : sessionId,
        projectId: scope === 'project' ? m.projectId : undefined,
        matcher: '', // 매처는 UI가 확정해 별도 RPC로 저장 (M1: 기본 명령 전문)
        decision: 'allow',
      })
    }
    this.requireHandle(sessionId).respondApproval(requestId, decision, scope)
  }

  interrupt(sessionId: string): void {
    this.requireHandle(sessionId).interrupt()
  }

  async archive(sessionId: string): Promise<void> {
    const h = this.handles.get(sessionId)
    if (h) await h.dispose()
    this.handles.delete(sessionId)
    const m = this.meta.get(sessionId)
    if (m) {
      m.archived = true
      m.state = 'idle'
      m.waitingSince = null
      this.store.upsertSession(m)
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'archived' })
    }
  }

  rename(sessionId: string, name: string): void {
    const m = this.meta.get(sessionId)
    if (!m) return
    m.name = name
    m.autoNamed = false
    this.store.upsertSession(m)
  }

  markRead(sessionId: string, seq: number): void {
    const m = this.meta.get(sessionId)
    if (!m) return
    m.lastReadSeq = Math.max(m.lastReadSeq, seq)
    this.store.markRead(sessionId, seq)
  }

  loadMessages(sessionId: string, limit: number, beforeSeq?: number): StoredMessage[] {
    return this.store.loadMessages(sessionId, limit, beforeSeq)
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.handles.values()].map((h) => h.dispose()))
    this.handles.clear()
  }

  private requireHandle(sessionId: string): SessionHandle {
    const h = this.handles.get(sessionId)
    if (!h) throw Object.assign(new Error(`세션을 찾을 수 없습니다: ${sessionId}`), { code: 'session_not_found' })
    return h
  }
}

function truncate(s: string, max = 40): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine
}
