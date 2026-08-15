import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import type {
  ApprovalDecision,
  Attachment,
  ApprovalScope,
  CreateSessionParams,
  NormalizedEvent,
  PermissionPreset,
  ProjectInfo,
  SessionInfo,
  StoredMessage,
  ToolName,
} from '@cc/protocol'
import type { AgentAdapter, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import {
  gitSummary,
  gitStatusFiles,
  gitDiff,
  gitLog,
  gitCommitDetail,
  gitBranches,
  gitCheckout,
  gitStage,
  gitCommit,
  gitPush,
} from '../dev-services/git.js'
import { listDir, readTextFile } from '../dev-services/fs.js'
import { saveAttachment, clearAttachments } from '../dev-services/attachments.js'

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
      model: params.model ?? null, permissionPreset: params.permissionPreset,
    }
    // **어댑터가 성공한 뒤에 저장한다.** 먼저 저장하면 어댑터가 실패했을 때
    // 목록에는 보이지만 말을 걸 수 없는 '유령 세션'이 DB에 남는다 (실측으로 확인).
    let handle: SessionHandle
    try {
      handle = await adapter.createSession(
        {
          sessionId: id, cwd: params.cwd, model: params.model,
          permissionPreset: params.permissionPreset, resumeExternalId: params.resumeExternalId,
        },
        (e) => this.onEvent(e),
      )
    } catch (err) {
      const msg = (err as Error).message
      throw Object.assign(new Error(`${params.tool} 세션을 시작하지 못했습니다: ${msg}`), { code: 'internal' })
    }

    this.meta.set(id, info)
    this.store.upsertSession(info)
    this.handles.set(id, handle)
    handle.applyRules?.(this.rulesFor(id, params.projectId))

    // 재개 식별자는 **생성 즉시** 저장한다. 이벤트가 오기를 기다리면,
    // 첫 응답 전에 host가 죽은 세션은 영원히 재개할 수 없게 된다 (FR-10).
    if (handle.externalId) {
      info.externalId = handle.externalId
      this.store.upsertSession(info)
    }

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
        {
          sessionId,
          cwd: project.path,
          model: m.model ?? undefined,
          permissionPreset: m.permissionPreset,
          resumeExternalId: m.externalId,
        },
        (e) => this.onEvent(e),
      )
      this.handles.set(sessionId, handle)
      handle.applyRules?.(this.rulesFor(sessionId, m.projectId))
      m.state = 'idle'
      m.waitingSince = null
      this.store.upsertSession(m)
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'resumed' })
      return { session: m, resumed: true }
    } catch (err) {
      return { session: m, resumed: false, reason: (err as Error).message }
    }
  }

  /** 세션을 완전히 지운다 (프로세스 종료 + 기록·첨부 삭제) */
  async deleteSession(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId)
    if (handle) {
      await handle.dispose().catch(() => {})
      this.handles.delete(sessionId)
    }
    this.meta.delete(sessionId)
    this.store.deleteSession(sessionId)
    await clearAttachments(sessionId).catch(() => {})
    this.emit({ type: 'session_deleted', sessionId })
  }

  /**
   * 모델·권한 변경 (FR-7). 어댑터가 지원하면 다음 턴부터 반영되고,
   * 지원하지 않으면 메타만 갱신한다 — 재개할 때 새 설정으로 뜬다.
   */
  updateSettings(sessionId: string, s: { model?: string | null; permissionPreset?: PermissionPreset }): SessionInfo {
    const m = this.meta.get(sessionId)
    if (!m) throw Object.assign(new Error(`세션을 찾을 수 없습니다: ${sessionId}`), { code: 'session_not_found' })
    if (s.model !== undefined) m.model = s.model
    if (s.permissionPreset) m.permissionPreset = s.permissionPreset
    this.store.upsertSession(m)
    this.handles.get(sessionId)?.updateSettings?.(s)
    return { ...m, live: this.handles.has(sessionId) }
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

  saveAttachment(sessionId: string, name: string, mime: string, dataBase64: string) {
    return saveAttachment(sessionId, name, mime, dataBase64)
  }

  send(sessionId: string, text: string, attachments?: Attachment[]): void {
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
    // 첨부는 도구가 이해하는 형태로 어댑터가 변환한다 (경로 멘션 또는 이미지 블록)
    h.send(attachments?.length ? `${text}\n\n${attachments.map((a) => `@${a.path}`).join('\n')}` : text)
  }

  respondApproval(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
    matcher?: string,
  ): void {
    const m = this.meta.get(sessionId)
    // 규칙 영속화 — 어댑터는 메모리에만 갖고 있으므로 재시작 후에도 남으려면 여기 필요 (C-2)
    if (decision === 'always' && m && matcher) {
      this.store.addApprovalRule({
        scope: scope ?? 'session',
        sessionId: scope === 'project' ? undefined : sessionId,
        projectId: scope === 'project' ? m.projectId : undefined,
        matcher,
        decision: 'allow',
      })
    }
    this.requireHandle(sessionId).respondApproval(requestId, decision, scope, matcher)
  }

  // ── 깃 (B-1) — 경로 해석만 하고 실제 작업은 dev-services에 위임한다 ──
  private cwdOf(projectId: string): string {
    const p = this.store.listProjects().find((x) => x.id === projectId)
    if (!p) throw Object.assign(new Error(`프로젝트를 찾을 수 없습니다: ${projectId}`), { code: 'internal' })
    return p.path
  }

  gitStatusFiles(projectId: string) {
    return gitStatusFiles(this.cwdOf(projectId))
  }
  gitDiff(projectId: string, path: string, staged?: boolean) {
    return gitDiff(this.cwdOf(projectId), path, { staged })
  }
  gitLog(projectId: string, limit?: number) {
    return gitLog(this.cwdOf(projectId), limit)
  }
  gitCommitDetail(projectId: string, sha: string) {
    return gitCommitDetail(this.cwdOf(projectId), sha)
  }
  gitBranches(projectId: string) {
    return gitBranches(this.cwdOf(projectId))
  }
  gitCheckout(projectId: string, branch: string, dryRun?: boolean) {
    return gitCheckout(this.cwdOf(projectId), branch, { dryRun })
  }
  gitStage(projectId: string, paths: string[], unstage?: boolean) {
    return gitStage(this.cwdOf(projectId), paths, unstage)
  }
  gitCommit(projectId: string, message: string) {
    return gitCommit(this.cwdOf(projectId), message)
  }
  gitPush(projectId: string) {
    return gitPush(this.cwdOf(projectId))
  }

  // ── 파일 트리·뷰어 (C-1) ──
  listDir(projectId: string, path: string) {
    return listDir(this.cwdOf(projectId), path)
  }
  readTextFile(projectId: string, path: string) {
    return readTextFile(this.cwdOf(projectId), path)
  }

  saveWorkspace(layout: Record<string, unknown>): void {
    this.store.saveWorkspace(layout)
  }

  loadWorkspace(): Record<string, unknown> | null {
    return this.store.loadWorkspace<Record<string, unknown>>()
  }

  /** 설정 화면에서 규칙을 보고 지울 수 있어야 한다 (FR-3: 결과를 보이게 한다) */
  listApprovalRules(): { id: number; scope: 'session' | 'project'; matcher: string; decision: string; createdAt: number }[] {
    return this.store
      .listApprovalRules()
      .filter((r) => r.matcher)
      .map((r) => ({
        id: r.id,
        scope: r.scope as 'session' | 'project',
        matcher: r.matcher,
        decision: r.decision,
        createdAt: r.createdAt,
      }))
  }

  deleteApprovalRule(id: number): void {
    this.store.deleteApprovalRule(id)
  }

  searchMessages(query: string, limit?: number) {
    return this.store.searchMessages(query, limit)
  }

  /** 이 세션에 적용되는 저장된 규칙 (세션 범위 + 프로젝트 범위) */
  private rulesFor(sessionId: string, projectId: string): string[] {
    return this.store
      .listApprovalRules()
      .filter((r) => (r.sessionId ? r.sessionId === sessionId : r.projectId === projectId))
      .map((r) => r.matcher)
      .filter(Boolean)
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
