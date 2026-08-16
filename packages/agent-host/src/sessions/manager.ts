import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import type {
  ApprovalDecision,
  CommandInfo,
  ExternalSession,
  Attachment,
  ApprovalScope,
  CreateSessionParams,
  NormalizedEvent,
  PermissionPreset,
  ProjectInfo,
  SessionInfo,
  StoredMessage,
  UsageSnapshot,
  ToolName,
} from '@cc/protocol'
import type { AgentAdapter, HistoryMessage, SessionHandle } from '../adapters/contract.js'
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

/** 응답이 오지 않는 호출로 화면을 붙잡아 두지 않는다 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('시간 초과')), ms)),
  ])
}

/**
 * 불러올 대화의 최대 줄 수. 오래된 쪽부터 잘린다.
 * 수백 턴짜리 세션을 통째로 밀어 넣으면 첫 렌더가 눈에 띄게 느려지고,
 * 정작 사람이 보는 건 마지막 몇 턴이다.
 */
const HISTORY_LIMIT = 200

/**
 * 따라잡을 때 읽는 분량. 복원(200)보다 넉넉히 잡는다 —
 * 밖에서 한참 작업하고 돌아왔다면 그 사이가 200줄을 넘을 수 있고,
 * 우리가 아는 마지막 말을 못 찾으면 아무것도 못 붙인다.
 */
const SYNC_LIMIT = 600

/**
 * 세션 수명주기 + 영속화. 어댑터는 상태를 갖지 않으므로 (docs/agent-host.md §2)
 * 상태 추적·저장은 전부 여기서 한다.
 */
export class SessionManager {
  private handles = new Map<string, SessionHandle>()
  private meta = new Map<string, SessionInfo>()
  /**
   * **지금 돌고 있는 프로세스가 실제로 들고 있는 설정.**
   *
   * meta(=화면에 보이는 값)와 다를 수 있다. 권한·모델은 도구를 띄울 때 고정되므로,
   * 화면만 '자동'으로 바뀌고 프로세스는 옛 설정으로 도는 어긋남이 생긴다.
   * 그 상태에서 '자동'을 다시 골라도 meta 기준으로는 '바뀐 게 없음'이라 아무 일도 일어나지 않는다
   * (도그푸딩: "자동으로 선택되어 있는데 계속 물어본다").
   * 그래서 비교 기준은 언제나 이쪽이다.
   */
  private running = new Map<string, { model: string | null; permissionPreset: PermissionPreset }>()
  /** 도구+디렉토리별 슬래시 명령 캐시 (세션이 준비되기 전에도 목록을 줄 수 있게) */
  private commandCache = new Map<string, CommandInfo[]>()
  /** 도구가 갖고 있는 대화 id 목록 (짧은 캐시 — 삭제 여부 판단용) */
  private externalIndex = new Map<string, { ids: Set<string>; at: number }>()
  /** 사용량 캐시 — 모달을 여닫을 때마다 도구를 띄우지 않는다 */
  private usageCache = new Map<ToolName, { snapshot: UsageSnapshot; at: number }>()

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

  /**
   * 도구가 보관 중인 이전 세션 목록 (터미널에서 만든 것 포함).
   *
   * 실패해도 던지지 않는다 — 목록을 못 가져오는 것과 세션을 못 만드는 것은 다른 문제다.
   * 구버전 도구를 쓰는 사람도 '새 세션'은 그대로 쓸 수 있어야 한다.
   */
  async listExternalSessions(
    projectId: string,
    tool: ToolName,
    limit: number,
  ): Promise<{ supported: boolean; reason?: string; sessions: ExternalSession[] }> {
    const project = this.store.listProjects().find((p) => p.id === projectId)
    if (!project) return { supported: false, reason: '프로젝트를 찾을 수 없습니다', sessions: [] }

    const adapter = this.adapters.get(tool)
    if (!adapter?.listExternalSessions) {
      return { supported: false, reason: `${tool}는 이전 세션 목록을 지원하지 않습니다`, sessions: [] }
    }

    try {
      const rows = await adapter.listExternalSessions(project.path, limit)
      /*
       * 이미 목록에 있는 대화를 또 열면 같은 세션이 둘이 되므로 표시해서 막는다.
       *
       * 두 가지를 지킨다:
       *  - 판정은 **이어받은 원본**으로 한다. externalId로 보면 안 된다 —
       *    도구가 resume하면서 새 식별자를 발급하면 원본과 달라져 매번 '안 불러옴'이 된다.
       *  - **숨긴 세션은 세지 않는다.** 숨김은 '내 목록에서 치우기'이고 도구에는 데이터가
       *    남아 있다. 여기서 '이미 불러옴'으로 막아버리면 되돌릴 길이 사라진다.
       */
      const known = new Map<string, string>()
      for (const s of this.meta.values()) {
        if (s.tool !== tool || s.archived) continue
        // 한 세션이 여러 식별자를 가질 수 있다: 이어받은 원본과 지금 것.
        // (도구가 resume하면서 새 id를 발급하면 둘이 달라진다)
        for (const key of [s.importedFrom, s.externalId]) {
          if (key && !known.has(key)) known.set(key, s.id)
        }
      }
      return {
        supported: true,
        sessions: rows.map((r) => ({
          externalId: r.externalId,
          tool,
          title: r.title,
          updatedAt: r.updatedAt,
          createdAt: r.createdAt ?? null,
          branch: r.branch ?? null,
          imported: known.has(r.externalId),
          importedAs: known.get(r.externalId) ?? null,
        })),
      }
    } catch (err) {
      return { supported: false, reason: (err as Error).message, sessions: [] }
    }
  }

  /**
   * 이 도구 대화를 **이미 붙잡고 있는 살아 있는 세션**이 있나.
   *
   * 도구는 한 대화에 쓰는 쪽이 둘이면 거부한다
   * (codex: "thread … already has an active writer"). 세션 id가 달라도 같은 원본을
   * 가리키면 충돌하므로, 우리 쪽에서 먼저 막고 **누가 쥐고 있는지** 알려준다.
   * 도구가 뱉는 원문은 사용자에게 아무것도 설명해 주지 않는다.
   */
  private holderOf(externalId: string, exceptSessionId?: string): SessionInfo | null {
    for (const s of this.meta.values()) {
      if (s.id === exceptSessionId || !this.handles.has(s.id)) continue
      if (s.externalId === externalId || s.importedFrom === externalId) return s
    }
    return null
  }

  async createSession(params: CreateSessionParams): Promise<SessionInfo> {
    const adapter = this.adapters.get(params.tool)
    if (!adapter) throw Object.assign(new Error(`알 수 없는 도구: ${params.tool}`), { code: 'tool_not_installed' })

    if (params.resumeExternalId) {
      const holder = this.holderOf(params.resumeExternalId)
      if (holder) {
        throw Object.assign(
          new Error(`이 대화는 이미 "${holder.name}" 세션에서 열려 있습니다 — 그 세션에서 이어가세요`),
          { code: 'internal' },
        )
      }
    }

    const id = randomUUID()
    const info: SessionInfo = {
      id, projectId: params.projectId, tool: params.tool, externalId: null,
      name: params.initialPrompt ? truncate(params.initialPrompt) : '새 세션',
      autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
      createdAt: Date.now(), waitingSince: null, live: true,
      model: params.model ?? null, permissionPreset: params.permissionPreset,
      importedFrom: params.importHistory ? (params.resumeExternalId ?? null) : null,
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
    this.running.set(id, { model: info.model, permissionPreset: info.permissionPreset })
    handle.applyRules?.(this.rulesFor(id, params.projectId))

    // 이전 대화 복원. **어댑터가 뜬 다음에** 한다 —
    // 기록만 있고 말은 못 거는 세션은 유령 세션과 똑같이 나쁘다.
    if (params.importHistory && params.resumeExternalId) {
      await this.importHistory(info, adapter, params.resumeExternalId, params.cwd)
    }

    // 재개 식별자는 **생성 즉시** 저장한다. 이벤트가 오기를 기다리면,
    // 첫 응답 전에 host가 죽은 세션은 영원히 재개할 수 없게 된다 (FR-10).
    if (handle.externalId) {
      info.externalId = handle.externalId
      this.store.upsertSession(info)
    }

    // 세션이 살아 있는 지금 스킬을 미리 받아둔다.
    // 나중에 잠든 뒤에는 물어볼 프로세스가 없다 — 그때를 위한 준비다.
    void this.listCommands(id).catch(() => {})

    if (params.initialPrompt) handle.send(params.initialPrompt)
    return info
  }

  /**
   * 도구 쪽에서 이어진 대화를 우리 기록에 따라잡는다.
   *
   * 왜 필요한가: Control Center에서 하다가 터미널의 클로드·코덱스로 옮겨 작업하고
   * 다시 돌아올 수 있다. 그동안 오간 말은 도구에만 쌓이고 우리 화면은 멈춰 있다
   * (도그푸딩 지적). 모델은 resume으로 전체를 기억하므로 **화면만 어긋난다** —
   * 그래서 더 헷갈린다.
   *
   * 붙이는 규칙: 도구 기록에서 **우리가 마지막으로 아는 말**을 찾고 그 뒤만 가져온다.
   * 우리가 보낸 말도 도구를 거쳐 갔으므로 도구 기록은 완전본이다 — 뒤쪽만 이어붙이면
   * 중복 없이 맞춰진다. 못 찾으면 아무것도 붙이지 않는다:
   * 어긋난 채 두는 것이 같은 말을 두 번 쌓는 것보다 낫다.
   */
  private async syncImportedHistory(info: SessionInfo, adapter: AgentAdapter, cwd: string): Promise<number> {
    const externalId = info.externalId ?? info.importedFrom
    if (!adapter.readExternalHistory || !externalId) return 0

    let history: HistoryMessage[]
    try {
      history = await adapter.readExternalHistory(externalId, cwd, SYNC_LIMIT)
    } catch {
      return 0 // 못 읽어도 대화는 계속된다
    }
    if (history.length === 0) return 0

    const ours = this.store.loadMessages(info.id, SYNC_LIMIT)
    const lastKnown = [...ours].reverse().find((m) => m.kind === 'text')
    const lastText = (lastKnown?.payload as { text?: string } | undefined)?.text?.trim()

    // 우리가 아는 마지막 말 뒤부터가 새 것이다
    let start = -1
    if (lastText) {
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i]!.text.trim() === lastText) {
          start = i + 1
          break
        }
      }
    } else if (ours.length === 0) {
      start = 0 // 기록이 비었으면 전부 새 것이다
    }
    if (start < 0 || start >= history.length) return 0

    const fresh = history.slice(start)
    const base = this.store.nextSeq(info.id)
    this.store.appendMessages(
      fresh.map((h, i) => ({
        sessionId: info.id,
        seq: base + i,
        role: h.role,
        kind: 'text' as const,
        payload: { text: h.text },
        ts: h.ts ?? Date.now(),
      })),
    )
    info.lastSeq = base + fresh.length - 1
    // 밖에서 오간 말이다 — 내가 읽은 적이 없으니 안 읽음으로 둔다
    this.store.upsertSession(info)
    return fresh.length
  }

  /**
   * 이전 대화를 화면에 복원한다.
   *
   * 이건 **표시용 스냅샷**이다. 모델이 실제로 기억하는 컨텍스트는 도구가 갖고 있고
   * (resume이 그걸 이어준다), 여기서 저장하는 건 사람이 읽을 대화 기록이다.
   * 실패해도 세션은 살린다 — 기록을 못 읽었다고 대화까지 막을 이유가 없다.
   */
  private async importHistory(
    info: SessionInfo,
    adapter: AgentAdapter,
    externalId: string,
    cwd: string,
  ): Promise<void> {
    if (!adapter.readExternalHistory) return
    let history: HistoryMessage[]
    try {
      history = await adapter.readExternalHistory(externalId, cwd, HISTORY_LIMIT)
    } catch (err) {
      this.emit({
        type: 'error',
        sessionId: info.id,
        error: {
          code: 'internal',
          message: `이전 대화를 불러오지 못했습니다: ${(err as Error).message}`,
          retryable: false,
        },
      })
      return
    }
    if (history.length === 0) return

    // nextSeq는 DB의 MAX(seq) 기준이라 **넣기 전에는 계속 같은 값**을 준다.
    // 한 번만 받아서 직접 증가시킨다 (그러지 않으면 전부 같은 seq로 서로를 덮어쓴다).
    const base = this.store.nextSeq(info.id)
    const rows: StoredMessage[] = history.map((h, i) => ({
      sessionId: info.id,
      seq: base + i,
      role: h.role,
      kind: 'text' as const,
      payload: { text: h.text },
      ts: h.ts ?? info.createdAt,
    }))
    this.store.appendMessages(rows)

    info.lastSeq = rows[rows.length - 1]!.seq
    // 불러온 대화는 이미 읽은 것이다 — 안 읽음 표시로 사람을 부르면 안 된다
    info.lastReadSeq = info.lastSeq
    if (info.autoNamed && info.name === '새 세션') {
      const firstUser = history.find((h) => h.role === 'user')
      if (firstUser) info.name = truncate(firstUser.text)
    }
    this.store.upsertSession(info)
    this.emit({ type: 'session_title', sessionId: info.id, title: info.name })
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

    /*
     * 도구 쪽에서 이 대화가 지워졌는지 먼저 본다.
     *
     * 그냥 이어가려 하면 프로세스는 뜨지만 첫 턴이 error_during_execution으로 죽는다
     * (실측). 사용자에게는 원인을 전혀 알려주지 않는 문구다.
     * 없어진 걸 미리 알면 무엇이 일어났고 무엇을 할 수 있는지 말해줄 수 있다.
     */
    // 같은 대화를 두 세션이 붙잡으면 도구가 거부한다 — 먼저 막고 누가 쥐고 있는지 알린다
    if (m.externalId) {
      const holder = this.holderOf(m.externalId, sessionId)
      if (holder) {
        return {
          session: m,
          resumed: false,
          reason: `이 대화는 "${holder.name}" 세션이 이미 열고 있습니다 (같은 대화를 둘이 쓸 수 없습니다)`,
        }
      }
    }

    const gone = await this.externalGone(m, project.path)
    if (gone) {
      return {
        session: m,
        resumed: false,
        reason: `이 대화가 ${m.tool === 'codex' ? 'Codex' : 'Claude Code'}에서 삭제되었습니다 — 여기 남은 기록은 읽을 수 있고, 새 세션으로 이어서 시작할 수 있습니다`,
      }
    }

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
      this.running.set(sessionId, { model: m.model, permissionPreset: m.permissionPreset })
      handle.applyRules?.(this.rulesFor(sessionId, m.projectId))
      m.state = 'idle'
      m.waitingSince = null
      this.store.upsertSession(m)
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'resumed' })
      void this.listCommands(sessionId).catch(() => {})

      // 밖에서(터미널의 도구로) 이어간 대화를 따라잡는다
      const added = await this.syncImportedHistory(m, adapter, project.path)
      if (added > 0) {
        this.emit({ type: 'history_synced', sessionId, added })
      }
      return { session: m, resumed: true }
    } catch (err) {
      /*
       * 실패한 **뒤에야** 왜 실패했는지 캔다.
       *
       * 예전에는 이어가기 전에 매번 도구 목록을 조회했는데, codex는 그때마다
       * app-server를 띄우므로 세션을 고를 때마다 몇 초가 얹혔다 (도그푸딩 지적).
       * 값이 비싼 확인은 잘못됐을 때만 한다 — 잘 되는 길은 빨라야 한다.
       */
      const gone = await this.externalGone(m, project.path)
      if (gone) {
        return {
          session: m,
          resumed: false,
          reason: `이 대화가 ${m.tool === 'codex' ? 'Codex' : 'Claude Code'}에서 삭제되었습니다 — 여기 남은 기록은 읽을 수 있고, 새 세션으로 이어서 시작할 수 있습니다`,
        }
      }
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
    this.running.delete(sessionId)
    this.meta.delete(sessionId)
    this.store.deleteSession(sessionId)
    await clearAttachments(sessionId).catch(() => {})
    this.emit({ type: 'session_deleted', sessionId })
  }

  /**
   * 모델·권한 변경 (FR-7). 어댑터가 지원하면 다음 턴부터 반영되고,
   * 지원하지 않으면 메타만 갱신한다 — 재개할 때 새 설정으로 뜬다.
   */
  async updateSettings(
    sessionId: string,
    s: { model?: string | null; permissionPreset?: PermissionPreset },
  ): Promise<SessionInfo> {
    const m = this.meta.get(sessionId)
    if (!m) throw Object.assign(new Error(`세션을 찾을 수 없습니다: ${sessionId}`), { code: 'session_not_found' })

    if (s.model !== undefined) m.model = s.model
    if (s.permissionPreset) m.permissionPreset = s.permissionPreset
    this.store.upsertSession(m)

    const handle = this.handles.get(sessionId)
    handle?.updateSettings?.(s)

    // 비교 기준은 화면값(meta)이 아니라 **돌고 있는 프로세스의 설정**이다
    const live = this.running.get(sessionId)
    const drifted =
      !!live && (live.model !== m.model || live.permissionPreset !== m.permissionPreset)

    /**
     * 권한·모델은 도구 프로세스를 **띄울 때 고정된다**.
     * Claude는 permissionMode를 query() 시작에 받고, Codex는 approvalPolicy를 thread/start에 받는다.
     * 그래서 살아 있는 세션의 메타만 고쳐 두면 화면에는 '자동'이라고 쓰여 있는데
     * 실제로는 계속 승인을 묻는다 — 도그푸딩에서 "권한 자동으로 바꿨는데 왜 물어보냐"로 나왔다.
     *
     * 어댑터가 실시간 반영을 지원하지 않으면 **프로세스를 갈아 끼운다.**
     * resume으로 이어지므로 대화는 끊기지 않는다. 조용히 무시하는 것보다 낫다.
     */
    if (drifted && handle && !handle.updateSettings) {
      await this.restartSession(sessionId)
    }

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
      // 압축 지점을 기록에 남긴다. 모델의 컨텍스트에서는 옛 대화가 접혔지만
      // 우리 기록에는 그대로 있다 — 어디서 접혔는지 보여야 거슬러 읽을 수 있다.
      : e.type === 'compaction' ? 'marker'
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

  /**
   * 말을 건다.
   *
   * 프로세스가 없으면 **되살리고 나서 보낸다.** 예전에는 "이 세션은 실행 중이 아닙니다"로
   * 되돌려보냈는데, 그건 기계 사정을 사람에게 떠넘기는 것이다 — 사람은 이어서 말하고
   * 싶을 뿐이고, 이어갈 수단(external_id)은 우리가 갖고 있다.
   */
  async send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void> {
    const m = this.meta.get(sessionId)
    if (!m) throw Object.assign(new Error(`세션을 찾을 수 없습니다: ${sessionId}`), { code: 'session_not_found' })

    if (!this.handles.has(sessionId)) {
      const r = await this.resumeSession(sessionId)
      if (!r.resumed) {
        throw Object.assign(new Error(`대화를 이어갈 수 없습니다: ${r.reason ?? '알 수 없는 이유'}`), {
          code: 'session_not_found',
        })
      }
    }

    const h = this.requireHandle(sessionId)
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

  /**
   * 슬래시 명령 목록.
   *
   * **스킬은 세션이 아니라 도구+디렉토리의 성질이다.** 그래서 (tool, cwd)로 캐시한다 —
   * 세션을 막 만든 직후에는 CLI가 뜨는 중이라 물어볼 수 없는데(도그푸딩에서 지적됨),
   * 같은 프로젝트에서 한 번이라도 받아둔 적이 있으면 새 세션도 바로 목록을 갖는다.
   *
   * 도구가 준비되지 않았으면 ready=false로 알린다 — '없음'과 '아직'은 다르다.
   */
  async listCommands(sessionId: string): Promise<{ ready: boolean; commands: CommandInfo[] }> {
    const m = this.meta.get(sessionId)
    if (!m) return { ready: false, commands: [] }
    const cwd = this.cwdOf(m.projectId)
    const key = `${m.tool}:${cwd}`
    // 메모리 → 디스크 순으로 찾는다. host를 껐다 켜도 목록이 남아 있어야
    // 잠든 세션에서도 슬래시가 동작한다
    const cached = this.commandCache.get(key) ?? this.store.loadCommands<CommandInfo[]>(m.tool, cwd) ?? undefined
    if (cached) this.commandCache.set(key, cached)

    const handle = this.handles.get(sessionId)
    if (handle?.listCommands) {
      try {
        // 준비 전에는 응답이 오지 않을 수 있다 — 입력창을 붙잡아 두지 않는다
        const rows = await withTimeout(handle.listCommands(), 4000)
        const commands = rows
          .filter((c) => typeof c.name === 'string' && c.name.length > 0)
          .map((c) => ({ name: c.name, description: c.description ?? '', argumentHint: c.argumentHint ?? '' }))
        if (commands.length > 0) {
          this.commandCache.set(key, commands)
          this.store.saveCommands(m.tool, cwd, commands)
        }
        return { ready: true, commands }
      } catch {
        // 아래에서 캐시로 물러난다
      }
    }
    return cached ? { ready: true, commands: cached } : { ready: false, commands: [] }
  }

  /**
   * 이어갈 대화가 도구 쪽에 아직 있는지.
   *
   * 목록 조회 자체가 공짜가 아니므로(codex는 app-server를 띄운다) 짧게 캐시한다.
   * **판단이 안 서면 없다고 하지 않는다** — 목록을 못 받았다고 멀쩡한 세션을
   * 삭제된 것으로 막아버리면, 도구가 잠깐 응답하지 않는 것만으로 대화가 끊긴다.
   */
  private async externalGone(m: SessionInfo, cwd: string): Promise<boolean> {
    const id = m.externalId
    const adapter = this.adapters.get(m.tool)
    if (!id || !adapter?.listExternalSessions) return false

    const key = `${m.tool}:${cwd}`
    const cached = this.externalIndex.get(key)
    let ids = cached && Date.now() - cached.at < 30_000 ? cached.ids : null
    if (!ids) {
      try {
        const rows = await adapter.listExternalSessions(cwd, 200)
        ids = new Set(rows.map((r) => r.externalId))
        this.externalIndex.set(key, { ids, at: Date.now() })
      } catch {
        return false // 확인 못 했으면 막지 않는다
      }
    }
    // 이어받은 원본이 살아 있으면 그것도 인정한다 (resume이 새 id를 발급했을 수 있다)
    return !ids.has(id) && !(m.importedFrom && ids.has(m.importedFrom))
  }

  /**
   * 계정 사용량·한도 (FR-9).
   *
   * 짧게 캐시한다 — 모달을 여닫을 때마다 codex app-server를 띄우면 느리다.
   * 실패해도 던지지 않는다: 사용량을 못 본다고 대화를 막을 이유가 없다.
   */
  async usageFor(tool: ToolName): Promise<{ supported: boolean; reason?: string; usage: UsageSnapshot | null }> {
    const adapter = this.adapters.get(tool)
    if (!adapter?.listUsage) return { supported: false, reason: `${tool}는 사용량 조회를 지원하지 않습니다`, usage: null }

    const hit = this.usageCache.get(tool)
    if (hit && Date.now() - hit.at < 60_000) return { supported: true, usage: hit.snapshot }

    try {
      const snapshot = await withTimeout(adapter.listUsage(), 15_000)
      this.usageCache.set(tool, { snapshot, at: Date.now() })
      return { supported: true, usage: snapshot }
    } catch (err) {
      return { supported: false, reason: (err as Error).message, usage: hit?.snapshot ?? null }
    }
  }

  /** 프로젝트의 작업 디렉토리. 터미널이 자기 키(cwd)를 정할 때 쓴다 */
  cwdOfProject(projectId: string): string {
    return this.cwdOf(projectId)
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

  /**
   * 목록에서 숨긴다 / 다시 꺼낸다. 삭제와 다르다 — 기록·첨부는 그대로 남는다.
   * 숨길 때 프로세스는 정리한다(자원을 붙들 이유가 없다). 꺼낼 때 자동으로 띄우지는
   * 않는다 — 말을 걸면 그때 알아서 이어진다 (send의 자동 이어가기).
   */
  async archive(sessionId: string, archived = true): Promise<void> {
    const m = this.meta.get(sessionId)
    if (!m) return
    if (archived) {
      const h = this.handles.get(sessionId)
      if (h) await h.dispose().catch(() => {})
      this.handles.delete(sessionId)
    }
    m.archived = archived
    m.state = 'idle'
    m.waitingSince = null
    this.store.upsertSession(m)
    this.emit({ type: 'state_change', sessionId, state: 'idle', reason: archived ? 'archived' : 'unarchived' })
  }

  /**
   * 에이전트만 재시작한다 (FR-10 확장).
   * 도구가 먹통이 됐을 때 세션을 새로 만들면 대화가 끊긴다 — 프로세스만 갈아 끼운다.
   */
  async restartSession(sessionId: string): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }> {
    const h = this.handles.get(sessionId)
    if (h) {
      await h.dispose().catch(() => {})
      this.handles.delete(sessionId)
      this.running.delete(sessionId)
    }
    return this.resumeSession(sessionId)
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
