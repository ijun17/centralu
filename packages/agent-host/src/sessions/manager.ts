import { randomUUID } from 'node:crypto'
import { ORCHESTRATOR_ROLE, orchestratorHome, projectOrchestratorRole } from './orchestrator-home.js'
import { dedupeNearbyHits, windowAround } from './snippet.js'
import { runOrchestratorTool } from './orchestrator-tools.js'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import type {
  ModelOption,
  ApprovalDecision,
  CommandInfo,
  ExternalSession,
  Attachment,
  ApprovalScope,
  CreateSessionParams,
  NormalizedEvent,
  PermissionPreset,
  QuestionAnswer,
  ProjectInfo,
  SessionInfo,
  SessionState,
  StoredMessage,
  UsageSnapshot,
  ToolName,
} from '@cc/protocol'
import { APP_SLUG, DATA_DIR, sessionLiveDefaults } from '@cc/protocol'
import type { AgentAdapter, OrchestratorTools, HistoryMessage, SessionHandle } from '../adapters/contract.js'
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
  gitWorktreeAdd,
  gitWorktreeDirty,
  gitWorktreeRemove,
} from '../dev-services/git.js'
import { importFile, listDir, moveEntry, readTextFile, resolveExisting } from '../dev-services/fs.js'
import { DirWatchers } from '../dev-services/watch.js'
import { saveAttachment, clearAttachments } from '../dev-services/attachments.js'

/**
 * 응답이 오지 않는 호출로 화면을 붙잡아 두지 않는다.
 *
 * `label`이 곧 진단이다. 이름 없는 시간제한은 바깥의 RPC 30초에서 "RPC timed out:
 * agents.resumeSession"으로만 터졌고, 그 문구는 **어디서** 멈췄는지를 말하지 않는다 —
 * 실제로 MGH 세션이 그렇게 죽었을 때 사후에 알아낼 방법이 없었다. 단계마다 제 이름을
 * 들고 실패하면, 같은 사고의 다음 발생이 곧 진단이 된다.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label = 'A call'): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not finish within ${Math.round(ms / 1000)}s`)), ms),
    ),
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
  private running = new Map<
    string,
    { model: string | null; effort: string | null; verbosity: string | null; permissionPreset: PermissionPreset }
  >()
  /**
   * 파일 트리의 감시자 (#34). 펼쳐진 디렉토리만 본다 — 집합은 UI가 fs.watch로 보낸다.
   * 변화는 fs_changed 이벤트로 나간다 (프로젝트의 사건이라 sessionId가 없다).
   */
  private watchers = new DirWatchers((projectId, dirs) => this.emit({ type: 'fs_changed', projectId, dirs }))
  /** 도구+디렉토리별 슬래시 명령 캐시 (세션이 준비되기 전에도 목록을 줄 수 있게) */
  private commandCache = new Map<string, CommandInfo[]>()
  /** 도구가 갖고 있는 대화 id 목록 (짧은 캐시 — 삭제 여부 판단용) */
  private externalIndex = new Map<string, { ids: Set<string>; at: number }>()
  /** 사용량 캐시 — 모달을 여닫을 때마다 도구를 띄우지 않는다 */
  private usageCache = new Map<ToolName, { snapshot: UsageSnapshot; at: number }>()
  /** 끝나면 알려달라고 부탁받은 세션 → 알릴 오케스트레이터 (한 번 알리면 지운다) */
  private awaitingReport = new Map<string, string>()
  /**
   * 지금 되살리는 중인 세션 → 그 약속.
   *
   * send()가 동시에 두 번 오면 둘 다 "프로세스가 없다"를 보고 각자 되살리기를 시작한다 —
   * 프로세스가 둘 뜨고, 늦게 핸들 맵에 앉은 쪽이 이기며 먼저 뜬 쪽은 dispose 없이
   * 영영 고아로 남는다. 그래서 되살리기는 세션당 하나만 돌리고 나머지는 그 약속을 기다린다.
   */
  private resuming = new Map<
    string,
    Promise<{ session: SessionInfo; resumed: boolean; reason?: string; lockedElsewhere?: boolean }>
  >()

  constructor(
    private store: Store,
    private adapters: Map<ToolName, AgentAdapter>,
    private emit: (e: NormalizedEvent) => void,
    /**
     * host 자신의 주소. 포트는 listen() 뒤에야 정해지므로 값이 아니라 **묻는 함수**로 받는다.
     * 인프로세스로 도구를 못 붙이는 어댑터(Codex)의 다리가 이 주소로 돌아온다.
     */
    private endpoint?: () => { url: string; token: string } | null,
    /**
     * 워크트리를 만들 뿌리. **데이터 폴더 옆에 둔다** — 그래야 dev와 배포 앱이 자연히 갈리고
     * (`~/.centralu-dev` vs `~/.centralu`), 테스트는 임시 디렉토리를 넣어
     * 사용자 홈을 건드리지 않는다.
     */
    private worktreeRoot = join(homedir(), DATA_DIR, 'worktrees'),
  ) {
    /*
     * 기동 시 상태를 **있는 그대로 되살리지 않는다.**
     *
     * host가 죽으면 세션 프로세스도 함께 죽는다. 그런데 DB에는 마지막 상태가
     * 그대로 남아 있어서, 다시 켜면 프로세스가 하나도 없는데 화면에는 `working`이라고
     * 적혀 있다. 사람은 도는 줄 알고 기다리지만 영원히 아무 일도 일어나지 않는다
     * (도그푸딩: "40분 넘게 working에 갇혀 있다", "아카이브했다 되돌리면 풀린다" —
     * archive가 state를 idle로 되돌리기 때문이었다).
     *
     * 살아 있는 상태(working·승인 대기)는 **프로세스가 있어야만 참**이다.
     * 기동 시점에는 어느 세션에도 프로세스가 없으므로 전부 idle로 바로잡는다.
     * 말을 걸면 그때 깨어난다 — 사실이 아닌 상태를 보여주는 것보다 낫다.
     */
    const LIVE_ONLY: SessionState[] = ['working', 'waiting_approval']
    for (const s of store.listSessions()) {
      const stale = !s.archived && LIVE_ONLY.includes(s.state)
      const fixed = stale ? { ...s, state: 'idle' as const, waitingSince: null } : s
      this.meta.set(s.id, fixed)
      if (stale) {
        console.error(`[agent-host] stale state reset: ${s.id.slice(0, 8)} ${s.state} -> idle`)
        store.upsertSession(fixed)
      }
    }
  }

  async addProject(path: string): Promise<ProjectInfo> {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw Object.assign(new Error(`Directory not found: ${path}`), { code: 'internal' })
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
      // Saved shell commands ride along with the project so the Run menu never has a
      // "loading" state to distinguish from an empty one (issue #44)
      commands: this.store.projectCommands(id),
      git: git.isRepo ? git : null,
    }
  }

  /**
   * Replace this project's saved shell commands (issue #44).
   *
   * Blank entries are dropped here rather than trusted to the caller: a row that runs
   * nothing when clicked is worse than no row, and this is the one place every edit —
   * from any client — has to pass through.
   *
   * Nothing else is inspected. These are the user's own commands and go to their own
   * shell; the approval machinery exists for what an agent proposes, and running these
   * through it would put a permission prompt in front of what the person just typed.
   */
  setProjectCommands(projectId: string, commands: readonly string[]): string[] {
    if (!this.store.listProjects().some((p) => p.id === projectId)) {
      throw Object.assign(new Error('Project not found'), { code: 'internal' })
    }
    const clean = commands.map((c) => c.trim()).filter(Boolean)
    this.store.setProjectCommands(projectId, clean)
    return clean
  }

  /**
   * 사이드바 순서 (사람이 끌어서 정한다).
   *
   * 받은 목록에 없는 것은 **뒤에 그대로 남긴다** — 화면 밖에 있던 것이
   * 순서 저장 한 번에 맨 앞으로 튀어나오면 안 된다.
   */
  async reorderProjects(orderedIds: readonly string[]): Promise<ProjectInfo[]> {
    const known = this.store.listProjects().map((p) => p.id)
    const rest = known.filter((id) => !orderedIds.includes(id))
    this.store.setProjectOrder([...orderedIds.filter((id) => known.includes(id)), ...rest])
    return this.listProjects()
  }

  reorderSessions(projectId: string, orderedIds: readonly string[]): SessionInfo[] {
    /*
     * 순서는 **전역 하나**다(sidebar_order). 이 프로젝트의 것만 0부터 다시 매기면
     * 다른 프로젝트의 값과 충돌해서, 한 프로젝트를 정렬했을 뿐인데 전체 목록이 섞인다.
     * 그래서 전역 순서에서 **이 프로젝트가 차지하던 자리만** 새 순서로 갈아 끼우고,
     * 나머지 세션은 있던 자리에 그대로 둔다.
     */
    const all = this.listSessions()
    const mine = new Set(all.filter((s) => s.projectId === projectId).map((s) => s.id))
    const rest = [...mine].filter((id) => !orderedIds.includes(id))
    const replacement = [...orderedIds.filter((id) => mine.has(id)), ...rest]
    let k = 0
    const globalOrder = all.map((s) => (mine.has(s.id) ? replacement[k++]! : s.id))
    this.store.setSessionOrder(globalOrder)
    // 메모리의 순서도 같이 맞춘다 — 저장만 하면 다시 뜨기 전까지 화면과 어긋난다
    const rank = new Map(globalOrder.map((id, i) => [id, i]))
    const sorted = [...this.meta.entries()].sort((a, b) => (rank.get(a[0]) ?? 0) - (rank.get(b[0]) ?? 0))
    this.meta = new Map(sorted)
    return this.listSessions()
  }

  /** 그리드 배치 */
  grid(): string[] {
    return this.store.listGridView()
  }

  /**
   * 배치 저장.
   *
   * **모르는 세션은 걷어낸다.** 지워진 세션의 id가 배치에 남아 돌아오면 화면이
   * 없는 것을 그리려 한다 — 저장 시점에 한 번 거르면 그 뒤로는 신경 쓸 일이 없다.
   */
  setGridView(sessionIds: readonly string[]): string[] {
    const known = new Set(this.meta.keys())
    const clean = [...new Set(sessionIds.filter((id) => known.has(id)))]
    this.store.setGridView(clean)
    return clean
  }

  async listProjects(): Promise<ProjectInfo[]> {
    return Promise.all(this.store.listProjects().map((p) => this.projectInfo(p.id, p.path)))
  }

  /**
   * One project, re-measured (issue #41).
   *
   * The caller is a refresh loop — the sidebar count is re-read every time a turn ends —
   * so this has to cost **one** `git status`. Answering it by calling `listProjects` and
   * discarding all but one row would run a status per registered project on every turn,
   * which is exactly the quiet cost that keeps this out of the hot path.
   */
  async projectGitStatus(projectId: string): Promise<ProjectInfo> {
    const p = this.store.listProjects().find((x) => x.id === projectId)
    if (!p) throw Object.assign(new Error('Project not found'), { code: 'internal' })
    return this.projectInfo(p.id, p.path)
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
    if (!project) return { supported: false, reason: 'Project not found', sessions: [] }

    const adapter = this.adapters.get(tool)
    if (!adapter?.listExternalSessions) {
      return { supported: false, reason: `${tool} does not support listing past sessions`, sessions: [] }
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

  /**
   * 세션을 만든다.
   *
   * projectId가 `string | null`인 이유: 오케스트레이터는 프로젝트에 속하지 않는다.
   * RPC 계약(CreateSessionParams)은 여전히 프로젝트를 요구하므로 밖에서는 null을 못 보낸다 —
   * 프로젝트 없는 세션을 만들 수 있는 곳은 아래 `orchestrator()` 하나뿐이다.
   */
  async createSession(
    params: Omit<CreateSessionParams, 'projectId'> & {
      projectId: string | null
      /**
       * 역할 (#13). RPC 계약에는 없다 — 밖에서 오케스트레이터를 "만들" 수는 없고
       * (중앙은 orchestrator()가, 프로젝트는 승격(sessions.setKind)이 유일한 길이다),
       * 여기 있는 이유는 orchestrator()가 자기 세션을 만들 때 쓰기 위해서다.
       */
      kind?: SessionInfo['kind']
    },
  ): Promise<SessionInfo> {
    const adapter = this.adapters.get(params.tool)
    if (!adapter) throw Object.assign(new Error(`Unknown tool: ${params.tool}`), { code: 'tool_not_installed' })

    if (params.resumeExternalId) {
      const holder = this.holderOf(params.resumeExternalId)
      if (holder) {
        throw Object.assign(
          new Error(`This conversation is already open in the "${holder.name}" session — continue there`),
          { code: 'internal' },
        )
      }
    }

    const id = randomUUID()

    /*
     * 워크트리 세션 (FR-2 옵션). **어댑터를 띄우기 전에** 만든다 — cwd로 넘겨야 하기 때문이다.
     *
     * 실패하면 세션 생성 자체를 멈춘다. 조용히 원본 디렉토리로 떨어뜨리면 사용자는
     * 격리된 줄 알고 두 세션을 같은 파일에 붙인다 — 이 기능을 켠 이유가 정확히 그것인데.
     */
    let worktree: { path: string; branch: string } | null = null
    if (params.worktree && params.projectId) {
      const summary = await gitSummary(params.cwd)
      if (!summary.isRepo || summary.denied) {
        throw Object.assign(
          new Error(
            summary.denied
              ? 'Cannot read this git repository — grant folder access and try again'
              : 'Worktrees need a git repository. This directory is not one.',
          ),
          { code: 'internal' },
        )
      }
      const path = this.worktreePathFor(params.projectId, id)
      // 브랜치 이름에 세션 id 앞자리를 쓴다 — 세션 이름은 아직 없거나(자동 이름은 나중에 붙는다)
      // 공백·유니코드가 섞여 브랜치 이름으로 못 쓴다
      const branch = `${APP_SLUG}/${id.slice(0, 8)}`
      try {
        worktree = await gitWorktreeAdd(params.cwd, path, branch)
      } catch (err) {
        const msg = (err as { stderr?: string; message?: string }).stderr ?? (err as Error).message
        throw Object.assign(new Error(`Could not create the worktree: ${String(msg).trim()}`), { code: 'internal' })
      }
    }

    const info: SessionInfo = {
      id, projectId: params.projectId, kind: params.kind ?? 'worker', tool: params.tool, externalId: null,
      name: params.initialPrompt ? truncate(params.initialPrompt) : 'New session',
      autoNamed: true, state: 'idle', archived: false, lastReadSeq: 0, lastSeq: 0,
      createdAt: Date.now(), waitingSince: null, live: true,
      model: params.model ?? null, effort: params.effort ?? null,
      verbosity: params.verbosity ?? null,
      permissionPreset: params.permissionPreset,
      importedFrom: params.importHistory ? (params.resumeExternalId ?? null) : null,
      worktree,
      ...sessionLiveDefaults(),
    }
    /*
     * The directory this session starts in. Remembered below, not derived again later —
     * the tool files the conversation under this exact path, so this is the only path that
     * can ever find it again (issue #28).
     */
    const cwd = worktree?.path ?? params.cwd

    // **어댑터가 성공한 뒤에 저장한다.** 먼저 저장하면 어댑터가 실패했을 때
    // 목록에는 보이지만 말을 걸 수 없는 '유령 세션'이 DB에 남는다 (실측으로 확인).
    let handle: SessionHandle
    try {
      handle = await adapter.createSession(
        {
          sessionId: id, cwd, model: params.model, effort: params.effort,
          verbosity: params.verbosity,
          permissionPreset: params.permissionPreset, resumeExternalId: params.resumeExternalId,
          // 오케스트레이터만 도구를 받는다 — 판정은 명시적 표식 하나다 (#13, kind)
          orchestratorTools: info.kind === 'orchestrator' ? this.orchestratorToolsFor(id, info.projectId) : undefined,
          systemPromptAppend: info.kind === 'orchestrator' ? this.orchestratorRoleFor(info.projectId) : undefined,
          orchestratorBridge: info.kind === 'orchestrator' ? (this.endpoint?.() ?? undefined) : undefined,
        },
        (e) => this.onEvent(e),
      )
    } catch (err) {
      // 어댑터가 실패하면 방금 만든 워크트리는 아무도 안 쓴다 — 고아 디렉토리를 남기지 않는다.
      // (여기서 실패한 세션은 저장조차 되지 않으므로, 안 지우면 되찾을 방법이 없다)
      if (worktree) {
        await gitWorktreeRemove(params.cwd, worktree.path, true).catch(() => {})
      }
      const msg = (err as Error).message
      throw Object.assign(new Error(`Could not start ${params.tool} session: ${msg}`), { code: 'internal' })
    }

    this.meta.set(id, info)
    this.store.upsertSession(info)
    this.store.setSessionCwd(id, cwd)
    this.handles.set(id, handle)
    this.running.set(id, {
      model: info.model,
      effort: info.effort,
      verbosity: info.verbosity,
      permissionPreset: info.permissionPreset,
    })
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

    /*
     * 첫 프롬프트도 **send()와 같은 규칙으로 남긴다.**
     *
     * 어댑터에 보내기만 하면 저장에는 첫 질문이 없다 — 다시 켜면 대화가 답부터
     * 시작하는 기록이 된다. UI는 user_message의 seq로 자기 낙관적 렌더와 맞추므로
     * 이벤트도 send()처럼 올린다.
     */
    if (params.initialPrompt) {
      const seq = this.store.nextSeq(id)
      this.store.appendMessages([
        { sessionId: id, seq, role: 'user', kind: 'text', payload: { text: params.initialPrompt }, ts: Date.now() },
      ])
      info.lastSeq = seq
      info.lastReadSeq = seq // 내가 보낸 건 읽은 것
      this.store.upsertSession(info)
      this.emit({ type: 'user_message', sessionId: id, seq, text: params.initialPrompt })
      handle.send(params.initialPrompt)
    }
    return info
  }

  /**
   * 도구 쪽에서 이어진 대화를 우리 기록에 따라잡는다.
   *
   * 왜 필요한가: Centralu에서 하다가 터미널의 클로드·코덱스로 옮겨 작업하고
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
    /*
     * 저장된 한 행은 메시지가 아니라 **스트리밍 델타 하나**다 (persistMessage).
     * 마지막 행만 집으면 답변의 꼬리 토막이 나와서, 완전한 메시지를 주는 도구 기록과는
     * 영원히 일치하지 않는다 — 그래서 따라잡기가 늘 0건이었다.
     * previewOf와 같은 규칙으로 **마지막 메시지를 조각에서 되살려** 비교한다.
     * (사람의 말은 통짜 한 행이라 그대로 쓴다)
     */
    const lastMessageText = (): string | undefined => {
      const parts: string[] = []
      for (let i = ours.length - 1; i >= 0; i--) {
        const r = ours[i]!
        if (r.kind !== 'text') {
          if (parts.length > 0) break // 다른 종류를 만나면 그 응답의 시작이다
          continue
        }
        const t = (r.payload as { text?: string }).text ?? ''
        if (r.role !== 'assistant') return parts.length > 0 ? parts.join('') : t
        parts.unshift(t)
      }
      return parts.length > 0 ? parts.join('') : undefined
    }
    const lastText = lastMessageText()?.trim()

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
          message: `Could not load past conversation: ${(err as Error).message}`,
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
    if (info.autoNamed && info.name === 'New session') {
      const firstUser = history.find((h) => h.role === 'user')
      if (firstUser) info.name = truncate(firstUser.text)
    }
    this.store.upsertSession(info)
    this.emit({ type: 'session_title', sessionId: info.id, title: info.name, auto: true })
  }

  /**
   * 기존 세션을 되살린다 (FR-10). host를 껐다 켜도 대화를 이어가기 위한 경로.
   *
   * 프로세스는 사라졌지만 external_id와 대화 기록은 store에 남아 있다.
   * 어댑터의 resume이 성공하면 같은 대화를 이어가고, 실패하면 **조용히 죽지 않고**
   * `resumable: false`로 알린다 — UI가 "기록 보기 + 새 세션"을 안내할 수 있도록.
   */
  /**
   * `lockedElsewhere`는 **문장이 아니라 신호다.**
   *
   * 이유를 문장으로만 주면 UI가 그 문장을 정규식으로 되읽어야 한다 — 문구를 고치는 순간
   * 조용히 깨지는 계약이다. 이 대화를 다른 쪽이 쥐고 있다는 사실만 따로 올려서,
   * 화면이 "갈라서 이어가기"를 내밀지 말지를 문구와 무관하게 정할 수 있게 한다.
   */
  async resumeSession(
    sessionId: string,
  ): Promise<{ session: SessionInfo; resumed: boolean; reason?: string; lockedElsewhere?: boolean }> {
    // 이미 되살리는 중이면 그 약속을 같이 기다린다 — 각자 시작하면 프로세스가 둘 뜬다
    const inflight = this.resuming.get(sessionId)
    if (inflight) return inflight
    const p = this.doResumeSession(sessionId).finally(() => this.resuming.delete(sessionId))
    this.resuming.set(sessionId, p)
    return p
  }

  private async doResumeSession(
    sessionId: string,
  ): Promise<{ session: SessionInfo; resumed: boolean; reason?: string; lockedElsewhere?: boolean }> {
    const m = this.meta.get(sessionId)
    if (!m) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })

    // 이미 살아 있으면 그대로 쓴다 (중복 프로세스를 만들지 않는다)
    if (this.handles.has(sessionId)) return { session: m, resumed: true }

    const adapter = this.adapters.get(m.tool)
    if (!adapter) return { session: m, resumed: false, reason: `No adapter for ${m.tool}` }
    if (!adapter.capabilities.resume) return { session: m, resumed: false, reason: `${m.tool} does not support resume` }
    /*
     * 이어갈 식별자를 고른다.
     *
     * **externalId가 없으면 이어받은 원본(importedFrom)을 쓴다.**
     * Claude는 external id를 system/init로 비동기로 주기 때문에, 대화를 불러오기만 하고
     * 말을 걸지 않은 세션은 그 값이 영영 채워지지 않는다. 그런데 그런 세션은 정의상
     * **원본 id를 갖고 있다** — 그게 바로 이어갈 대상이다.
     * (실측: ext=null인데 from=c1a50932이고 메시지가 95개인 세션들이 있었다)
     */
    const resumeId = m.externalId ?? m.importedFrom

    if (!resumeId) {
      if (this.store.loadMessages(m.id, 1).length > 0) {
        return {
          session: m,
          resumed: false,
          reason: 'Lost this session\'s resume id — the history is still readable, and you can continue in a new session',
        }
      }
      // 오간 말이 없다 = 새로 띄워도 잃을 것이 없다
    }

    /*
     * **오케스트레이터에는 프로젝트가 없다.**
     *
     * 여기서 프로젝트를 요구하는 바람에 앱을 다시 켜면 오케스트레이터가 영영 죽었다
     * ("Could not resume the conversation: Project not found" — 실측).
     * 만들 때만 되고 이어가지는 못하는 세션이었던 셈이다.
     */
    const project = m.projectId === null ? null : this.store.listProjects().find((p) => p.id === m.projectId)
    if (m.projectId !== null && !project) return { session: m, resumed: false, reason: 'Project not found' }
    const cwd = this.cwdFor(m)

    /*
     * 도구 쪽에서 이 대화가 지워졌는지 먼저 본다.
     *
     * 그냥 이어가려 하면 프로세스는 뜨지만 첫 턴이 error_during_execution으로 죽는다
     * (실측). 사용자에게는 원인을 전혀 알려주지 않는 문구다.
     * 없어진 걸 미리 알면 무엇이 일어났고 무엇을 할 수 있는지 말해줄 수 있다.
     */
    // 같은 대화를 두 세션이 붙잡으면 도구가 거부한다 — 먼저 막고 누가 쥐고 있는지 알린다
    if (resumeId) {
      const holder = this.holderOf(resumeId, sessionId)
      if (holder) {
        return {
          session: m,
          resumed: false,
          reason: `The "${holder.name}" session already has this conversation open (two sessions cannot share one conversation)`,
          lockedElsewhere: true,
        }
      }
    }

    const gone = await this.externalGone(m, cwd)
    if (gone) {
      return { session: m, resumed: false, reason: externalMissingReason(m.tool, cwd) }
    }

    try {
      const creating = adapter.createSession(
        {
          sessionId,
          cwd,
          model: m.model ?? undefined,
          effort: m.effort ?? undefined,
          verbosity: m.verbosity ?? undefined,
          permissionPreset: m.permissionPreset,
          resumeExternalId: resumeId ?? undefined,
          /*
           * **도구와 역할은 되살릴 때도 따라와야 한다.**
           *
           * 만들 때만 붙이면, 다시 뜬 오케스트레이터는 도구도 역할도 없는
           * 평범한 세션이 된다 — 빈 폴더에 앉아 아무것도 못 하면서
           * 겉보기에는 멀쩡한, 가장 나쁜 상태다.
           *
           * 그리고 여기가 곧 **승격이 실제가 되는 자리**다 (#13): 살아 있는 동안
           * 표식만 바뀐 세션이 다음에 깰 때 이 조건을 지나며 도구와 역할을 받는다.
           */
          orchestratorTools: m.kind === 'orchestrator' ? this.orchestratorToolsFor(sessionId, m.projectId) : undefined,
          systemPromptAppend: m.kind === 'orchestrator' ? this.orchestratorRoleFor(m.projectId) : undefined,
          orchestratorBridge: m.kind === 'orchestrator' ? (this.endpoint?.() ?? undefined) : undefined,
        },
        (e) => this.onEvent(e),
      )
      /*
       * **여기가 상한 없이 기다리던 자리다** — 그리고 그 대기가 이 함수의 유일한
       * 진행 중(resuming) 약속을 붙들고 있었다. 도구가 뜨다 멈추면 바깥 RPC는 30초에
       * 포기하지만 이 약속은 안 풀리고, Retry는 dedup 때문에 **그 멈춘 약속에 다시
       * 합류한다**. 사람 눈에는 "Retry가 안 된다"로 보인다 (MGH 세션에서 실측).
       *
       * 25초인 이유: RPC의 30초보다 안쪽이어야 화면이 이름 없는 RPC 시간제한 대신
       * 이 단계의 이름이 붙은 이유를 받고, resuming도 그때 풀려 Retry가 진짜 재시도가 된다.
       *
       * 시간제한이 이겨도 도구 프로세스는 이미 떠 있을 수 있다 — 늦게라도 도착하면
       * 거둔다. 안 거두면 잠긴 스레드를 쥔 app-server가 조용히 남는다.
       */
      const handle = await withTimeout(creating, 25_000, `Starting ${m.tool}`).catch((err) => {
        void creating.then((h) => h.dispose()).catch(() => {})
        throw err
      })
      this.handles.set(sessionId, handle)
      this.running.set(sessionId, {
        model: m.model,
        effort: m.effort,
        verbosity: m.verbosity,
        permissionPreset: m.permissionPreset,
      })
      handle.applyRules?.(this.rulesFor(sessionId, m.projectId))
      // 이제야 식별자가 잡혔을 수 있다 — 다음 재개를 위해 남긴다
      if (handle.externalId && handle.externalId !== m.externalId) m.externalId = handle.externalId
      m.state = 'idle'
      m.waitingSince = null
      this.store.upsertSession(m)
      this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'resumed' })
      void this.listCommands(sessionId).catch(() => {})

      // 밖에서(터미널의 도구로) 이어간 대화를 따라잡는다.
      // 오케스트레이터는 앱이 관리하는 세션이라 밖에서 이어갈 일이 없다 —
      // 중앙은 프로젝트가 없어 원래 안 걸렸고, 프로젝트 오케스트레이터(#13)는 여기서 거른다
      if (project && m.kind !== 'orchestrator') {
        // 따라잡기가 멈춰도 세션은 이미 살아 있다 — 붙잡지 말고 다음 기회에 맡긴다
        const added = await withTimeout(this.syncImportedHistory(m, adapter, project.path), 10_000, 'History catch-up').catch(() => 0)
        if (added > 0) this.emit({ type: 'history_synced', sessionId, added })
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
      // 사후 확인에도 상한을 둔다 — 진짜 실패 이유(err)를 들고 있는데, 확인이 멈추는
      // 바람에 그 이유조차 전달 못 하는 것이 최악이다. 판단 못 하면 막지 않는다(false)와 같은 규칙.
      const gone = await withTimeout(this.externalGone(m, cwd), 8_000, 'Checking the tool').catch(() => false)
      if (gone) {
        return { session: m, resumed: false, reason: externalMissingReason(m.tool, cwd) }
      }
      /*
       * 어댑터가 "이 대화는 다른 쪽이 쥐고 있다"고 코드로 말해 준다 (codex의 잠금).
       * 문장을 다시 읽지 않고 그 코드만 본다 — 여기가 화면에 갈림길을 내미는 근거다.
       */
      const locked = (err as { code?: string }).code === 'conversation_locked'
      return { session: m, resumed: false, reason: (err as Error).message, lockedElsewhere: locked || undefined }
    }
  }

  /**
   * 잠긴 대화에서 **갈라져 나와** 이 세션으로 이어간다.
   *
   * 원본은 그대로 둔다 — 다른 앱이 쓰던 대화를 빼앗지 않는다. 이 세션의 externalId만
   * 새 사본을 가리키게 바꾸고 되살린다. 여기까지 오는 사람은 이미 "다른 곳에서 열려
   * 있습니다"를 보고 스스로 고른 것이므로, 다시 묻지 않는다.
   *
   * 우리 저장소의 대화 기록은 손대지 않는다. 사람이 보는 화면은 그대로고,
   * 이어지는 말만 사본에 쌓인다.
   */
  async forkConversation(sessionId: string): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }> {
    const m = this.meta.get(sessionId)
    if (!m) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })

    const source = m.externalId ?? m.importedFrom
    if (!source) {
      return { session: m, resumed: false, reason: 'This session has no conversation to fork from' }
    }

    const adapter = this.adapters.get(m.tool)
    if (!adapter?.forkConversation) {
      // 능력이 없으면 없다고 말한다 — 조용히 아무 일도 안 하는 쪽이 훨씬 나쁘다
      return { session: m, resumed: false, reason: `${m.tool} cannot fork a conversation` }
    }

    try {
      const forked = await adapter.forkConversation(source, this.cwdFor(m))
      m.externalId = forked
      this.store.upsertSession(m)
    } catch (err) {
      return { session: m, resumed: false, reason: (err as Error).message }
    }

    return this.resumeSession(sessionId)
  }

  /** 세션을 완전히 지운다 (프로세스 종료 + 기록·첨부 삭제) */
  /**
   * @param deleteWorktree 워크트리까지 지울지. **기본은 남기는 것이다** — 에이전트가 몇 시간
   * 작업한 결과가 거기 있을 수 있고, 조용히 지우면 되돌릴 길이 없다. UI가 사람에게 먼저 묻는다.
   */
  async deleteSession(sessionId: string, deleteWorktree = false): Promise<void> {
    const m = this.meta.get(sessionId)
    const handle = this.handles.get(sessionId)
    if (handle) {
      await handle.dispose().catch(() => {})
      this.handles.delete(sessionId)
    }
    if (m?.worktree && deleteWorktree) {
      /*
       * force로 지운다 — 여기까지 온 것은 사람이 "커밋 안 된 변경이 있다"는 말을 듣고도
       * 지우겠다고 답한 경우다. force 없이는 git이 거부해서 결국 아무것도 못 지운다.
       * 실패해도 세션 삭제는 계속한다: 세션은 사라졌는데 목록에만 남는 편이 더 나쁘다.
       */
      await gitWorktreeRemove(this.cwdOf(m.projectId), m.worktree.path, true).catch(() => {})
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
    s: { model?: string | null; effort?: string | null; verbosity?: string | null; permissionPreset?: PermissionPreset },
  ): Promise<SessionInfo> {
    const m = this.meta.get(sessionId)
    if (!m) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })

    if (s.model !== undefined) m.model = s.model
    if (s.effort !== undefined) m.effort = s.effort
    if (s.verbosity !== undefined) m.verbosity = s.verbosity
    if (s.permissionPreset) m.permissionPreset = s.permissionPreset
    this.store.upsertSession(m)

    const handle = this.handles.get(sessionId)
    handle?.updateSettings?.(s)

    // 비교 기준은 화면값(meta)이 아니라 **돌고 있는 프로세스의 설정**이다
    const live = this.running.get(sessionId)
    const drifted =
      !!live &&
      (live.model !== m.model ||
        live.effort !== m.effort ||
        live.verbosity !== m.verbosity ||
        live.permissionPreset !== m.permissionPreset)

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
    let seq: number | null = null
    if (e.sessionId) {
      const m = this.meta.get(e.sessionId)
      if (m) {
        const handle = this.handles.get(e.sessionId)
        if (handle?.externalId && m.externalId !== handle.externalId) {
          m.externalId = handle.externalId
        }
        this.applyStateHint(e, m)
        seq = this.persistMessage(e, m)
        this.store.upsertSession(m)
      }
      /*
       * **죽은 프로세스의 핸들은 그 자리에서 걷는다.**
       *
       * adapter_crashed를 올리고도 핸들을 남겨두면 send()가 handles.has만 보고
       * 끝난 큐에 push해 **다음 말이 조용히 사라진다** (명시적 restart 전까지).
       * 걷어내면 send()의 "없으면 되살려 보낸다" 경로가 그대로 자동 복구가 된다.
       */
      if (e.type === 'error' && e.error.code === 'adapter_crashed') {
        const dead = this.handles.get(e.sessionId)
        if (dead) {
          this.handles.delete(e.sessionId)
          this.running.delete(e.sessionId)
          void dead.dispose().catch(() => {})
        }
      }
    }
    // 기록으로 남은 이벤트에는 매긴 세션 내 seq를 실어 보낸다 — UI 안읽음 추적의 기준
    this.emit(seq != null ? ({ ...e, seq } as NormalizedEvent) : e)
    if (e.type === 'turn_complete' && e.sessionId) void this.reportBackIfAwaited(e.sessionId)
  }

  /**
   * 시킨 일이 끝나면 오케스트레이터에게 알린다 — **"한 창"의 나머지 절반**.
   *
   * 이게 없으면 지시는 한 창에서 하고 결과는 그 세션에 가서 봐야 한다.
   * 그러면 창을 옮겨 다니는 고통이 그대로 남는다 — 애초에 없애려던 것이다.
   *
   * 밀기는 위험하므로 **부탁받았을 때만** 한다:
   *  - 지시할 때 오케스트레이터가 reportBack을 켠 건만 되돌아온다
   *  - 한 번 알리면 표식을 지운다. 그래야 그 세션이 이후 스스로 도는 턴마다
   *    오케스트레이터를 깨우지 않는다 — 그건 서로 깨우는 고리가 된다
   */
  private async reportBackIfAwaited(sessionId: string): Promise<void> {
    const orchestratorId = this.awaitingReport.get(sessionId)
    if (!orchestratorId) return
    this.awaitingReport.delete(sessionId)

    const target = this.meta.get(sessionId)
    if (!target || !this.meta.has(orchestratorId)) return

    /*
     * **이름만으로는 어느 세션인지 알 수 없다.**
     *
     * 세션 이름은 첫 프롬프트를 자른 것이라(FR-18), 압축된 대화를 이어받은 세션은
     * 전부 "This session is being continued from a p…"가 된다. 실제로 그런 세션이
     * 네 개 있었고, 보고에 이름만 실려 어느 프로젝트 것인지 알 수 없었다.
     * 잘못 짚으면 엉뚱한 프로젝트에 지시가 간다 — id와 프로젝트를 함께 싣는다.
     *
     * 보고 본문도 넉넉히 준다. 한 줄짜리 미리보기는 목록용이지 보고용이 아니다.
     */
    const project = target.projectId
      ? (this.store.listProjects().find((p) => p.id === target.projectId)?.name ?? '(사라진 프로젝트)')
      : '(없음)'
    const preview = this.previewOf(sessionId, 600)
    try {
      await this.send(
        orchestratorId,
        `[Centralu] 지시한 일이 끝났습니다.\n` +
          `세션: ${target.name}\n` +
          `id: ${sessionId}\n` +
          `프로젝트: ${project}\n\n` +
          `마지막 응답:\n${preview || '(내용 없음)'}\n\n` +
          `더 필요하면 read_session으로 그 세션의 최근 대화를 읽을 수 있습니다.`,
      )
    } catch {
      // 오케스트레이터가 잠들었거나 지워졌을 수 있다 — 보고 하나 때문에 앱이 흔들리면 안 된다
    }
  }

  /**
   * 저장용 상태 힌트.
   * 살아있는 상태의 권위는 UI(core 리듀서)에 있다 — agent-host는 core를 import하지 않으므로
   * (docs/architecture.md §2) 여기서는 복원(M1.5)에 쓸 최소 힌트만 기록한다.
   * 전이 규칙 판정은 하지 않는다 — 그건 core의 몫.
   */
  private applyStateHint(e: NormalizedEvent, m: SessionInfo): void {
    this.trackLiveFacts(e, m)
    const hint =
      e.type === 'approval_request' ? 'waiting_approval'
      : e.type === 'turn_complete' ? 'waiting_input'
      : e.type === 'limit_reached' ? 'limited'
      : e.type === 'error' ? 'error'
      : e.type === 'state_change' ? e.state
      : e.type === 'message_delta' || e.type === 'tool_call' ? 'working'
      : null
    if (!hint || m.archived) return
    const prev = m.state
    m.state = hint
    const waiting = hint === 'waiting_approval' || hint === 'waiting_input' || hint === 'error'
    m.waitingSince = waiting ? (m.waitingSince ?? Date.now()) : null
    // core 리듀서와 같은 소거 규칙 (docs/state-management.md §2):
    // 바쁨의 종류는 바쁨보다 오래 살지 못하고, 회복하면 한도 배너를 걷고,
    // 죽은 requestId의 카드(error·인터럽트·회복으로 requestId가 끝난 것)는
    // 클릭해도 답할 곳이 없으므로 함께 걷는다 — 재연결 복원이 죽은 카드를 되살리면 안 된다.
    if (hint !== 'working' && e.type !== 'activity') m.activity = null
    if (hint === 'working' || hint === 'idle') m.limit = null
    const cardsDead =
      hint === 'error' ||
      ((hint === 'working' || hint === 'idle') && prev !== hint) ||
      (prev === 'waiting_approval' && hint === 'waiting_input')
    if (cardsDead) {
      m.pendingApproval = null
      m.pendingQuestions = []
    }
  }

  /**
   * 재연결한 UI가 이어받아야 하는 **살아 있는 사실들**을 메타에 남긴다.
   *
   * SessionInfo에 이 필드들이 없던 동안, 끊겼다 돌아온 UI는 state=waiting_approval만
   * 받고 **payload가 없어 승인 카드를 못 그렸다** — requestId도 없어 응답조차 불가능했다.
   * DB에는 넣지 않는다 (upsert가 모르는 필드) — host가 재시작되면 정말로 사라진 것이다.
   */
  private trackLiveFacts(e: NormalizedEvent, m: SessionInfo): void {
    switch (e.type) {
      case 'approval_request':
        m.pendingApproval = { requestId: e.requestId, detail: e.detail }
        break
      case 'approval_resolved':
        if (m.pendingApproval?.requestId === e.requestId) m.pendingApproval = null
        break
      case 'question_request':
        m.pendingQuestions = [...m.pendingQuestions, { requestId: e.requestId, questions: e.questions }]
        break
      case 'question_resolved':
        m.pendingQuestions = m.pendingQuestions.filter((q) => q.requestId !== e.requestId)
        break
      case 'activity':
        m.activity = e.activity
        break
      case 'limit_reached':
        m.limit = { resumeAt: e.resumeAt, usedPercent: e.usedPercent, windowMins: e.windowMins }
        break
      case 'usage_update':
        m.usage = e.tokens
        break
      case 'context_update':
        m.context = { used: e.used, window: e.window, exactness: e.exactness }
        break
    }
  }

  /**
   * 대화 기록으로 남길 이벤트만 저장 (델타는 합치지 않고 텍스트만 누적).
   * 저장했다면 매긴 세션 내 seq를 돌려준다 — 방송에 실어 UI의 안읽음 추적 기준이 된다.
   */
  private persistMessage(e: NormalizedEvent, m: SessionInfo): number | null {
    const kind =
      e.type === 'tool_call' ? 'tool_call'
      : e.type === 'tool_result' ? 'tool_result'
      : e.type === 'approval_request' || e.type === 'approval_resolved' ? 'approval'
      : e.type === 'message_delta' ? 'text'
      // 압축 지점을 기록에 남긴다. 모델의 컨텍스트에서는 옛 대화가 접혔지만
      // 우리 기록에는 그대로 있다 — 어디서 접혔는지 보여야 거슬러 읽을 수 있다.
      : e.type === 'compaction' ? 'marker'
      : null
    if (!kind) return null
    const seq = this.store.nextSeq(m.id)
    const msg: StoredMessage = {
      sessionId: m.id, seq, role: e.type === 'message_delta' ? 'assistant' : 'system',
      kind, payload: e, ts: Date.now(),
    }
    this.store.appendMessages([msg])
    m.lastSeq = seq
    return seq
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
    if (!m) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })

    if (!this.handles.has(sessionId)) {
      const r = await this.resumeSession(sessionId)
      if (!r.resumed) {
        throw Object.assign(new Error(`Could not resume the conversation: ${r.reason ?? 'unknown reason'}`), {
          code: 'session_not_found',
        })
      }
    }

    const h = this.requireHandle(sessionId)
    const seq = this.store.nextSeq(sessionId)
    this.store.appendMessages([{ sessionId, seq, role: 'user', kind: 'text', payload: { text }, ts: Date.now() }])
    m.lastSeq = seq
    m.lastReadSeq = seq // 내가 보낸 건 읽은 것
    if (m.autoNamed && m.name === 'New session') {
      m.name = truncate(text)
      this.emit({ type: 'session_title', sessionId, title: m.name, auto: true })
    }
    this.store.upsertSession(m)
    /*
     * **말이 더해졌다고 알린다.**
     *
     * 예전에는 알리지 않았다. 사용자 메시지를 만드는 곳이 UI 하나뿐이라 UI가
     * 자기 것을 스스로 그리면 충분했기 때문이다. 오케스트레이터가 두 번째 생산자가
     * 되면서 그 가정이 깨졌다 — 주입된 말은 저장은 되는데 화면에는 영영 안 나타났다.
     */
    this.emit({ type: 'user_message', sessionId, seq, text })
    // 첨부는 도구가 이해하는 형태로 어댑터가 변환한다 (경로 멘션 또는 이미지 블록)
    h.send(attachments?.length ? `${text}\n\n${attachments.map((a) => `@${a.path}`).join('\n')}` : text)
  }

  /**
   * 세션의 에이전트를 바꾼다 (claude ↔ codex).
   *
   * **문맥은 이어지지 않는다.** externalId는 도구 자신의 대화 id다
   * (Claude의 session_id, Codex의 threadId). 도구만 바꾸고 그 id를 들고 가면
   * codex에게 Claude의 UUID를 넘기게 된다 — 그래서 여기서 **끊어낸다**.
   *
   * 잃는 것은 '이어갈 실마리'뿐이고 대화 기록은 우리 저장소에 그대로 남는다.
   * 옛 도구의 대화도 그 도구 안에 남아 있어 '+ → 이전 대화'로 다시 불러올 수 있다.
   *
   * 세션은 자리고 에이전트는 도구다 — 자리(이름·순서·기록·그리드 칸)는 그대로 두고
   * 도구만 갈아 끼운다.
   */
  async switchTool(sessionId: string, tool: ToolName): Promise<SessionInfo> {
    const m = this.meta.get(sessionId)
    if (!m) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })
    if (m.tool === tool) return { ...m, live: this.handles.has(sessionId) }

    const adapter = this.adapters.get(tool)
    if (!adapter) throw Object.assign(new Error(`Unknown tool: ${tool}`), { code: 'tool_not_installed' })

    /*
     * 바꾸기 전에 그 도구를 쓸 수 있는지 본다.
     * 확인 없이 갈아 끼우면 옛 프로세스는 이미 죽었는데 새 것은 안 뜨는 상태가 된다 —
     * 되돌릴 수도 없고 이유도 모르는 자리다.
     */
    const d = await adapter.detect()
    if (!d.installed || !d.loggedIn) {
      throw Object.assign(new Error(`${tool}를 쓸 수 없습니다: ${d.detail}`), { code: 'tool_not_installed' })
    }

    const old = this.handles.get(sessionId)
    if (old) {
      await old.dispose().catch(() => {})
      this.handles.delete(sessionId)
      this.running.delete(sessionId)
    }

    m.tool = tool
    // 새 도구는 옛 대화를 모른다. 실마리를 들고 가면 엉뚱한 대화를 잡는다
    m.externalId = null
    m.importedFrom = null
    this.store.upsertSession(m)
    this.emit({ type: 'state_change', sessionId, state: 'idle', reason: 'tool_changed' })

    // 새 프로세스는 말을 걸 때 뜬다 (resumeSession과 같은 규칙 — 여기서 띄우면 안 쓸 수도 있는 도구가 돈다)
    return { ...m, live: false }
  }

  respondApproval(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
    matcher?: string,
  ): void {
    const m = this.meta.get(sessionId)

    /*
     * **닿았는지를 먼저 본다.** 닿지 않았으면 규칙도 남기지 않는다 —
     * 실행되지도 않은 명령을 '항상 허용'으로 기억해 두면 다음에 조용히 통과한다.
     */
    const landed = this.requireHandle(sessionId).respondApproval(requestId, decision, scope, matcher)

    if (!landed) {
      /*
       * 그런 요청이 없다. 대개 그 사이에 프로세스가 갈아 끼워진 경우다(권한 프리셋을
       * 바꾸면 그렇게 된다). 화면의 카드는 이미 답할 수 없는 카드이므로 **먼저 걷어내고**,
       * 그다음에 알린다. 걷어내지 않으면 눌러도 반응 없는 카드가 계속 남는다.
       */
      this.emit({ type: 'approval_resolved', sessionId, requestId, decision: 'deny' })
      throw Object.assign(
        new Error('그 승인 요청은 이미 사라졌습니다 (에이전트가 다시 시작됨). 명령은 실행되지 않았습니다.'),
        { code: 'approval_gone' },
      )
    }

    // 규칙 영속화 — 어댑터는 메모리에만 갖고 있으므로 재시작 후에도 남으려면 여기 필요 (C-2)
    if (decision === 'always' && m && matcher) {
      this.store.addApprovalRule({
        scope: scope ?? 'session',
        sessionId: scope === 'project' ? undefined : sessionId,
        projectId: scope === 'project' ? (m.projectId ?? undefined) : undefined,
        matcher,
        decision: 'allow',
      })
    }
  }

  /**
   * 선택지에 답한다 (AskUserQuestion).
   *
   * 승인에서 배운 것을 그대로 지킨다 — **닿지 않았으면 조용히 성공으로 두지 않는다.**
   * 답할 수 없는 카드가 화면에 남으면 눌러도 아무 일이 없는 상태가 또 생긴다.
   */
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): void {
    const handle = this.requireHandle(sessionId)
    const landed = handle.answerQuestion?.(requestId, answers) ?? false
    if (!landed) {
      this.emit({ type: 'question_resolved', sessionId, requestId })
      throw Object.assign(
        new Error('그 질문은 이미 사라졌습니다 (에이전트가 다시 시작됨). 답은 전달되지 않았습니다.'),
        { code: 'question_gone' },
      )
    }
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
    const cwd = this.cwdFor(m)
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
    const id = m.externalId ?? m.importedFrom
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
    if (!adapter?.listUsage) return { supported: false, reason: `${tool} does not support usage queries`, usage: null }

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

  /**
   * 고를 수 있는 모델과 각 모델의 추론 강도.
   *
   * 사용량과 같은 계정 축이라 인자가 tool뿐이다. 목록은 자주 바뀌지 않으므로
   * 5분 캐시를 둔다 — 셀렉터를 열 때마다 도구 프로세스를 띄우면 그 클릭이 느려진다.
   */
  private modelCache = new Map<ToolName, { models: ModelOption[]; at: number }>()

  async listModels(tool: ToolName): Promise<{ supported: boolean; reason?: string; models: ModelOption[] }> {
    const adapter = this.adapters.get(tool)
    if (!adapter?.listModels) {
      return { supported: false, reason: `${tool} does not support listing models`, models: [] }
    }

    const hit = this.modelCache.get(tool)
    if (hit && Date.now() - hit.at < 5 * 60_000) return { supported: true, models: hit.models }

    try {
      const models = await withTimeout(adapter.listModels(), 15_000)
      this.modelCache.set(tool, { models, at: Date.now() })
      return { supported: true, models }
    } catch (err) {
      // 못 읽었다고 목록을 비워 두면 이미 고른 모델까지 사라진다 — 마지막으로 읽은 걸 남긴다
      return { supported: false, reason: (err as Error).message, models: hit?.models ?? [] }
    }
  }

  /** 프로젝트의 작업 디렉토리. 터미널이 자기 키(cwd)를 정할 때 쓴다 */
  cwdOfProject(projectId: string): string {
    return this.cwdOf(projectId)
  }

  // ── 깃 (B-1) — 경로 해석만 하고 실제 작업은 dev-services에 위임한다 ──
  /**
   * 프로젝트의 작업 디렉토리. **오케스트레이터(projectId=null)는 중립 자리를 쓴다.**
   *
   * 프로젝트 안에 두면 그 프로젝트의 세션과 같은 파일을 만지게 된다 — FR-2가 경고하는
   * 동시 세션 충돌을 우리 손으로 만드는 셈이다. 오케스트레이터에겐 손이 없다:
   * 일은 세션이 하고, 오케스트레이터는 시키고 읽는다.
   */
  /**
   * 이 세션이 실제로 도는 곳. **적어둔 경로가 계산한 경로를 이긴다** (이슈 #28).
   *
   * Recomputing this on every start is what orphaned the orchestrator. The data directory was
   * renamed, `orchestratorHome()` dutifully answered with the new path, and Claude Code — which
   * files conversations **by working directory** — went looking somewhere this session's history
   * had never been written. The tool said "not found"; the app called it a deletion. A session's
   * history lives where the session started, so that is the path we read back, not one we
   * re-derive from things that can move underneath it.
   *
   * 워크트리 세션이 이 규칙의 첫 사례였다: 재개할 때 프로젝트 경로로 되돌아가면 격리가
   * 조용히 풀리고, 사용자는 여전히 격리된 줄 안다. 이제는 워크트리 경로도 만들 때 적어두는
   * 같은 한 값이다 — 특례가 아니라 규칙의 일부다.
   *
   * Rows written before v14 have no stored path — the migration deliberately leaves the
   * orchestrator NULL rather than touching the user's home (see store.ts step 14). Derive
   * theirs once, here, and write it down; from then on the next rename cannot move them either.
   */
  private cwdFor(m: SessionInfo): string {
    const stored = this.store.sessionCwd(m.id)
    if (stored) return stored
    const derived = m.worktree?.path ?? this.cwdOf(m.projectId)
    this.store.setSessionCwd(m.id, derived)
    return derived
  }

  /** 워크트리는 **저장소 밖**에 만든다 — 사용자 저장소를 더럽히지 않는다 (.gitignore도 안 건드린다) */
  private worktreePathFor(projectId: string, sessionId: string): string {
    return join(this.worktreeRoot, projectId, sessionId)
  }

  /** 워크트리를 지워도 되는지 판단할 재료. 워크트리 세션이 아니면 null */
  async worktreeStatus(
    sessionId: string,
  ): Promise<{ path: string; branch: string; dirty: boolean; changedFiles: number } | null> {
    const m = this.meta.get(sessionId)
    if (!m?.worktree) return null
    const { dirty, changedFiles } = await gitWorktreeDirty(m.worktree.path).catch(() => ({
      dirty: false,
      changedFiles: 0,
    }))
    return { ...m.worktree, dirty, changedFiles }
  }

  private cwdOf(projectId: string | null): string {
    if (projectId === null) return orchestratorHome()
    const p = this.store.listProjects().find((x) => x.id === projectId)
    if (!p) throw Object.assign(new Error(`Project not found: ${projectId}`), { code: 'internal' })
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

  /**
   * 파일 트리의 감시 집합 갱신 (#34). UI가 펼친 디렉토리를 통째로 보내면
   * 변화가 `fs_changed` 이벤트로 되돌아간다 — 방향이 왕복이라 여기 있다:
   * 요청은 RPC로 오지만 답(변화)은 세션 이벤트와 같은 방송길로 나간다.
   */
  watchDirs(projectId: string, paths: readonly string[]): number {
    return this.watchers.setWatched(projectId, this.cwdOf(projectId), paths)
  }
  readTextFile(projectId: string, path: string) {
    return readTextFile(this.cwdOf(projectId), path)
  }

  // ── 파일 조작 (#19) — 경로 해석만 하고 검사·실행은 dev-services에 위임한다 ──
  moveEntry(projectId: string, from: string, toDir: string) {
    return moveEntry(this.cwdOf(projectId), from, toDir)
  }
  importFile(projectId: string, toDir: string, name: string, dataBase64: string) {
    return importFile(this.cwdOf(projectId), toDir, name, Buffer.from(dataBase64, 'base64'))
  }
  /** 데스크톱 셸이 OS에 넘길 절대 경로 (휴지통·파일 관리자). 프로젝트를 아는 쪽이 만든다 */
  resolveFile(projectId: string, path: string) {
    return resolveExisting(this.cwdOf(projectId), path)
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

  /**
   * 명령 팔레트의 검색. 저장소는 이제 본문을 통째로 주므로 **여기서 한 줄로 줄인다**
   * (팔레트는 한 줄만 보여준다). 오케스트레이터의 recall은 같은 본문에서
   * 훨씬 넓게 잘라 쓴다 — 얼마나 필요한지는 쓰는 쪽이 안다.
   */
  searchMessages(query: string, limit?: number) {
    return this.store
      .searchMessages(query, limit)
      .map((h) => ({ sessionId: h.sessionId, seq: h.seq, snippet: windowAround(h.body, query, 60) }))
  }

  /** 이 세션에 적용되는 저장된 규칙 (세션 범위 + 프로젝트 범위) */
  private rulesFor(sessionId: string, projectId: string | null): string[] {
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

  /**
   * 오케스트레이터에게 줄 도구 (FR-11).
   *
   * **이 앱이 관리하는 세션 밖으로 나갈 방법이 없다.** 매니저의 meta만 보므로
   * 터미널에서 만든 남의 세션도, 파일도, 프로젝트 디렉토리도 닿지 않는다 —
   * 막는 규칙을 따로 쓴 게 아니라 볼 수 있는 것이 그것뿐이다.
   */
  private orchestratorToolsFor(orchestratorId: string, scopeProjectId: string | null = null): OrchestratorTools {
    const projects = () => new Map(this.store.listProjects().map((p) => [p.id, p.name]))
    /**
     * 계급의 실체 (#13): 중앙(scope=null)은 전부 보고, 프로젝트 오케스트레이터는
     * **자기 프로젝트만** 본다. 규칙을 도구마다 다시 쓰지 않고 한 판정으로 모은다 —
     * 여섯 군데의 projectId 판정이 낳은 어긋남을 여기서 반복하지 않기 위해서다.
     */
    const inScope = (s: SessionInfo) => scopeProjectId === null || s.projectId === scopeProjectId
    const scopeError = (id: string) =>
      scopeProjectId === null ? `이 앱이 관리하는 세션이 아닙니다: ${id}` : `이 프로젝트의 세션이 아닙니다: ${id}`

    return {
      listSessions: async () => {
        const byId = projects()
        return [...this.meta.values()]
          // 자기 자신은 뺀다 — 자기에게 시키는 것은 고리를 만든다
          .filter((s) => s.id !== orchestratorId && !s.archived && inScope(s))
          .map((s) => ({
            sessionId: s.id,
            name: this.labelOf(s),
            project: s.projectId ? (byId.get(s.projectId) ?? '(사라진 프로젝트)') : '(없음)',
            state: s.state,
            tool: s.tool,
            preview: this.previewOf(s.id),
            lastActive: this.lastActiveOf(s.id),
            ...(s.kind === 'orchestrator' ? { orchestrator: true } : {}),
          }))
      },

      updateSessionSettings: async (sessionId, s) => {
        if (sessionId === orchestratorId) {
          // 자기 설정 변경은 자기 프로세스 재시작이다 — 도구 호출 도중의 자살이 된다
          return { ok: false, error: '자기 자신의 설정은 사람이 바꿉니다' }
        }
        const target = this.meta.get(sessionId)
        if (!target || !inScope(target)) return { ok: false, error: scopeError(sessionId) }
        if (target.state === 'working') {
          // 적용에는 재시작이 필요하다 (drift 경로) — 진행 중인 턴을 도구 호출이 죽이면 안 된다
          return { ok: false, error: `작업 중인 세션입니다: ${target.name} — 끝난 뒤에 바꾸세요` }
        }
        try {
          const info = await this.updateSettings(sessionId, s)
          /*
           * **흔적 없는 설정 변경 금지** (#30). 사람이 화면에서 바꾼 것은 RPC 응답이
           * 화면으로 돌아가지만, 이 길은 사람이 아닌 손이라 방송하지 않으면 화면이
           * 옛 값을 계속 보여준다 — 값이 몰래 바뀌는 것과 사람 눈에는 같다.
           */
          this.emit({
            type: 'settings_changed',
            sessionId,
            model: info.model,
            effort: info.effort,
            verbosity: info.verbosity,
          })
          return { ok: true }
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
      },

      createSession: async (opts) => {
        const all = this.store.listProjects()
        // 프로젝트 오케스트레이터는 자기 프로젝트 고정 — 인자로도 밖을 못 가리킨다
        const project =
          scopeProjectId !== null
            ? all.find((p) => p.id === scopeProjectId)
            : all.find((p) => p.id === opts.project || p.name === opts.project)
        if (!project) {
          return {
            ok: false,
            error:
              scopeProjectId !== null
                ? '이 오케스트레이터의 프로젝트를 찾을 수 없습니다'
                : opts.project
                  ? `그런 프로젝트가 없습니다: ${opts.project}`
                  : 'project를 지정하세요 (이름 또는 id)',
          }
        }
        if (scopeProjectId !== null && opts.project && opts.project !== project.id && opts.project !== project.name) {
          return { ok: false, error: `이 오케스트레이터는 "${project.name}"에만 세션을 만들 수 있습니다` }
        }
        try {
          const info = await this.createSession({
            projectId: project.id,
            cwd: project.path,
            tool: opts.tool ?? project.defaultTool,
            permissionPreset: 'normal',
          })
          if (opts.name) this.rename(info.id, opts.name)
          if (opts.firstMessage) await this.send(info.id, opts.firstMessage)
          return { ok: true, sessionId: info.id, name: this.meta.get(info.id)?.name ?? info.name }
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
      },

      recall: async (query, limit = 12) => {
        const byId = projects()
        // 넉넉히 긁어와서 겹치는 것을 걷어낸 뒤 자른다 — 걷기 전에 자르면 limit이 중복에 먹힌다
        const raw = this.store.searchMessages(query, limit * 12)
        const mine = raw.filter((h) => {
          const s = this.meta.get(h.sessionId)
          // 오케스트레이터 자신의 말은 뺀다 — 자기가 한 말을 근거로 되짚으면 메아리가 된다
          return s && s.id !== orchestratorId && inScope(s)
        })
        const out: {
          sessionId: string
          session: string
          project: string
          snippet: string
          seq: number
          at?: string
        }[] = []
        for (const h of dedupeNearbyHits(mine)) {
          const s = this.meta.get(h.sessionId)!
          out.push({
            sessionId: s.id,
            session: this.labelOf(s),
            project: s.projectId ? (byId.get(s.projectId) ?? '(사라진 프로젝트)') : '(없음)',
            // 델타 한 조각이 아니라 **둘레의 말**에서 잘라낸다 (조각만 보면 판단이 안 된다)
            snippet: windowAround(this.contextAt(s.id, h.seq) || h.body, query, 160),
            seq: h.seq, // read_session의 around로 넘기면 그 대목으로 바로 간다
            at: this.timeOf(h.sessionId, h.seq),
          })
          if (out.length >= limit) break
        }
        return { hits: out }
      },

      readSession: async (sessionId, limit = 40, opts) => {
        // 범위 판정은 sendToSession과 같은 규칙 — 자기 범위의 세션만
        if (sessionId === orchestratorId) return { ok: false, error: '자기 자신은 읽지 않습니다' }
        const target = this.meta.get(sessionId)
        if (!target || !inScope(target)) return { ok: false, error: scopeError(sessionId) }

        /*
         * 저장된 한 행은 스트리밍 델타 하나다. 그대로 주면 토막 수백 개가 나가므로
         * UI가 하는 것과 같이 **연속된 assistant 조각을 한 줄로 이어붙인다.**
         */
        /*
         * `around`가 있으면 그 언저리를 읽는다 — recall이 준 seq를 그대로 넘기면 된다.
         * 이게 없어서 "찾았는데 갈 수가 없는" 상태였다: recall은 세션 id만 주고,
         * read_session은 맨 끝만 읽어서, 결국 세션을 통째로 퍼올려 눈으로 찾아야 했다.
         */
        const around = opts?.around
        const rows = around
          ? this.store.loadMessages(sessionId, Math.max(limit * 8, 200), around + Math.max(limit * 4, 100))
          : this.store.loadMessages(sessionId, 800)

        const lines: string[] = []
        /** around가 가리키는 seq가 들어간 줄 — 창을 여기에 맞춰 자른다 */
        let anchor = -1
        const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
        for (const r of rows) {
          const p = r.payload as { text?: string; summary?: { title?: string; tool?: string } }
          if (r.kind === 'text' && r.role === 'assistant') {
            const last = lines[lines.length - 1]
            if (last?.includes('에이전트: ')) lines[lines.length - 1] = last + (p.text ?? '')
            else lines.push(`[${stamp(r.ts)}] 에이전트: ` + (p.text ?? ''))
          } else if (r.kind === 'text') {
            lines.push(`[${stamp(r.ts)}] 사람: ` + (p.text ?? ''))
          } else if (r.kind === 'tool_call' && p.summary?.title) {
            /*
             * **도구는 접는다.** 펼치면 python 스크립트 전문과 커밋 메시지 전문이
             * 자리를 다 차지해서 정작 사람↔에이전트 대화가 파묻힌다 (도그푸딩).
             * 무엇을 했는지는 한 줄이면 충분하고, 본문이 필요하면 tools:true로 펼친다.
             */
            const title = opts?.tools ? p.summary.title : p.summary.title.split('\n')[0]!.slice(0, 100)
            lines.push(`[${stamp(r.ts)}] 도구(${p.summary.tool ?? '?'}): ${title}`)
          }
          if (around != null && anchor < 0 && r.seq >= around && lines.length > 0) anchor = lines.length - 1
        }
        /*
         * around가 있으면 **그 대목을 가운데에 두고** 자른다.
         * 예전에는 두 갈래가 똑같이 꼬리를 잘라서, recall이 짚어준 seq로 와도
         * 창 끝머리만 보였다 — "찾았는데 갈 수가 없는" 상태가 그대로 남았다.
         */
        const from = around != null && anchor >= 0 ? Math.max(0, anchor - Math.floor(limit / 2)) : -1
        const picked = from >= 0 ? lines.slice(from, from + limit) : lines.slice(-limit)
        return {
          ok: true,
          state: target.state,
          lines: picked.map((l) => (l.length > 2000 ? l.slice(0, 2000) + '…' : l)),
        }
      },

      archiveSession: async (sessionId, archived) => {
        if (sessionId === orchestratorId) return { ok: false, error: '자기 자신은 보관할 수 없습니다' }
        const target = this.meta.get(sessionId)
        if (!target || !inScope(target)) return { ok: false, error: scopeError(sessionId) }
        try {
          await this.archive(sessionId, archived)
          return { ok: true }
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
      },

      sendToSession: async (sessionId, text, reportBack) => {
        /*
         * 조용히 실패하지 않는다. 오케스트레이터가 이름을 잘못 짚었을 때
         * 아무 일도 안 일어나면 사람은 "시켰는데 안 했다"로만 보게 된다 —
         * 이유를 돌려주면 오케스트레이터가 스스로 되묻거나 고칠 수 있다.
         */
        if (sessionId === orchestratorId) {
          return { ok: false, error: '자기 자신에게는 보낼 수 없습니다' }
        }
        const target = this.meta.get(sessionId)
        if (!target || !inScope(target)) return { ok: false, error: scopeError(sessionId) }
        if (target.archived) return { ok: false, error: `보관된 세션입니다: ${target.name}` }

        try {
          await this.send(sessionId, text)
          // 부탁받았을 때만 되돌아온다 — 기본은 조용하다
          if (reportBack) this.awaitingReport.set(sessionId, orchestratorId)
          return { ok: true }
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
      },
    }
  }

  /**
   * 마지막 응답 — **조각이 아니라 한 덩어리로.**
   *
   * 저장소의 한 행은 메시지 하나가 아니라 **스트리밍 델타 하나**다
   * (persistMessage가 message_delta마다 한 행씩 쌓는다). 그래서 마지막 한 행만 읽으면
   * 답변의 꼬리 토막이 나온다 — 실제로 오케스트레이터에게 문장 중간부터 시작하는
   * 보고가 갔다 ("걸러야 합니다 — ...").
   *
   * UI는 이 조각들을 이어붙여 되돌린다(messagesToChat). 여기서도 같이 한다:
   * 뒤에서부터 연속된 assistant 조각을 모으고, 다른 종류를 만나면 거기가 경계다.
   */
  /**
   * 사람이 세션을 **구분할 수 있는** 이름.
   *
   * 압축을 거친 세션은 이름이 전부 "This session is being continued from a previous…"가 된다
   * (압축 요약이 첫 사용자 메시지가 되고, 자동 이름이 그걸 집는다). 도그푸딩에서
   * list_sessions의 네 세션이 같은 제목이었다 — 지금은 프로젝트 이름으로 겨우 갈리지만
   * **한 프로젝트에 세션이 둘이면 못 가른다.** 그러면 오케스트레이터는 짐작하면 안 되니
   * 매번 사람에게 되물어야 한다.
   *
   * 그럴 때는 제목 대신 **첫 진짜 지시**를 이름으로 쓴다. 무엇을 하는 세션인지는
   * 그쪽이 훨씬 잘 말해준다.
   */
  private labelOf(s: SessionInfo): string {
    if (!/^This session is being continued|^Caveat: The messages below/i.test(s.name)) return s.name
    const rows = this.store.loadMessages(s.id, 400)
    for (const r of rows) {
      if (r.kind !== 'text' || r.role !== 'user') continue
      const t = ((r.payload as { text?: string }).text ?? '').trim()
      // 압축 요약 자체는 건너뛴다 — 그게 이름을 망친 장본인이다
      if (!t || /^This session is being continued|^Caveat:/i.test(t)) continue
      const one = t.replace(/\s+/g, ' ').slice(0, 60)
      return `${one}${t.length > 60 ? '…' : ''} (이어받은 세션)`
    }
    return `${s.name.slice(0, 40)}…`
  }

  /**
   * 그 자리 **둘레의 말**을 되살린다.
   *
   * 색인의 한 행은 메시지가 아니라 **스트리밍 델타 하나**라, 대개 수십 자짜리 토막이다.
   * 그래서 그 행만 잘라 주면 아무리 넓게 잡아도 넓어지지 않는다 —
   * 도그푸딩에서 `"이 풀리고, 이번에 고친 승인 카드 수정 + 은하수 바"` 같은 것이 그것이다.
   *
   * 앞뒤 행을 모아 한 덩어리로 되돌린 다음에야 "이게 찾던 대목인가"를 가릴 수 있다.
   */
  private contextAt(sessionId: string, seq: number, span = 60): string {
    const rows = this.store.loadMessages(sessionId, span * 2, seq + span)
    const parts: string[] = []
    for (const r of rows) {
      if (r.kind !== 'text') continue
      const t = (r.payload as { text?: string }).text ?? ''
      if (!t) continue
      // 사람의 말은 경계를 표시한다 — 누가 한 말인지 섞이면 오히려 헷갈린다
      parts.push(r.role === 'user' ? `\n[사람] ${t}\n` : t)
    }
    return parts.join('')
  }

  /** 마지막으로 움직인 시각 — 어느 세션이 지금 이야기인지 가른다 */
  private lastActiveOf(sessionId: string): string | undefined {
    const rows = this.store.loadMessages(sessionId, 1)
    const ts = rows[rows.length - 1]?.ts
    return ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : undefined
  }

  /** 그 자리의 시각 — 여러 세션 이야기를 맞출 때 순서를 세울 수 있어야 한다 */
  private timeOf(sessionId: string, seq: number): string | undefined {
    const rows = this.store.loadMessages(sessionId, 1, seq + 1)
    const ts = rows[0]?.ts
    return ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : undefined
  }

  private previewOf(sessionId: string, maxChars = 120): string {
    // 델타는 잘게 쪼개지므로 넉넉히 읽는다. 한 응답이 수백 조각인 경우가 흔하다
    const rows = this.store.loadMessages(sessionId, 500)
    const parts: string[] = []
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!
      const isAssistantText = r.kind === 'text' && r.role === 'assistant'
      if (isAssistantText) {
        parts.unshift((r.payload as { text?: string }).text ?? '')
        continue
      }
      // 모으기 시작한 뒤에 다른 종류를 만나면 그 응답의 시작이다
      if (parts.length > 0) break
      // 아직 못 만났으면 도구 호출 등을 건너뛰고 그 앞의 응답을 찾는다
      const title = (r.payload as { summary?: { title?: string } }).summary?.title
      if (r.kind === 'tool_call' && title && rows.every((x) => x.role !== 'assistant')) {
        return title.slice(0, maxChars)
      }
    }
    const text = parts.join('').trim()
    return text.length > maxChars ? text.slice(0, maxChars) + '…' : text
  }

  /**
   * 다리가 부르는 도구 실행 (Codex 경로).
   *
   * **오케스트레이터 자신만 부를 수 있다.** 다리는 별도 프로세스라 토큰만 있으면
   * 무엇이든 부를 수 있는데, 그 문으로 다른 세션이 남의 세션에 지시하게 두면
   * 접근 범위가 구조가 아니라 약속이 된다.
   */
  async runOrchestratorTool(sessionId: string, name: string, args: Record<string, unknown>) {
    const m = this.meta.get(sessionId)
    if (m?.kind !== 'orchestrator') {
      throw Object.assign(new Error('오케스트레이터만 쓸 수 있는 도구입니다'), { code: 'internal' })
    }
    return runOrchestratorTool(this.orchestratorToolsFor(sessionId, m.projectId), name, args)
  }

  /** 역할 텍스트 — 중앙(projectId=null)과 프로젝트 오케스트레이터가 다르다 (#13) */
  private orchestratorRoleFor(projectId: string | null): string {
    if (projectId === null) return ORCHESTRATOR_ROLE
    const p = this.store.listProjects().find((x) => x.id === projectId)
    return projectOrchestratorRole(p?.name ?? projectId)
  }

  /**
   * 승격·강등 (#13). **다음에 깰 때 적용된다** — 도구·역할은 프로세스를 띄울 때
   * 주입되므로, 살아 있는 세션은 표식만 먼저 바뀐다. 그 자리에서 재시작하지 않는
   * 이유: 승격 대상은 대개 한창 일하던 세션이고, 재시작은 진행 중인 턴을 죽인다.
   */
  async setSessionKind(sessionId: string, kind: SessionInfo['kind']): Promise<SessionInfo> {
    const m = this.meta.get(sessionId)
    if (!m) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })
    if (m.projectId === null) {
      // 중앙 오케스트레이터를 강등하면 프로젝트 없는 워커가 남는다 — 그런 세션은 이 앱에 없다
      throw Object.assign(new Error('The central orchestrator cannot change roles'), { code: 'internal' })
    }
    if (kind === 'orchestrator' && m.kind !== 'orchestrator') {
      /*
       * 프로젝트당 하나. 몰래 갈아치우지 않는다 — 승격이 다른 세션을 조용히 강등하면
       * 그 세션은 다음에 깰 때 말없이 도구를 잃는다. 지금 누가 그 자리에 있는지
       * 이름으로 알려주고, 바꾸는 것은 사람이 한다.
       */
      const holder = [...this.meta.values()].find(
        (s) => s.projectId === m.projectId && s.kind === 'orchestrator' && s.id !== sessionId,
      )
      if (holder) {
        throw Object.assign(
          new Error(`"${holder.name}" is already this project's orchestrator — demote it first`),
          { code: 'internal' },
        )
      }
    }
    m.kind = kind
    this.store.upsertSession(m)
    return { ...m, live: this.handles.has(sessionId) }
  }

  /**
   * 앱에 하나뿐인 오케스트레이터. 없으면 그 자리에서 만든다.
   *
   * **불러야 생긴다.** 앱을 켤 때 미리 만들면 쓰지도 않는 세션이 도구 프로세스를
   * 하나 물고 있게 된다 — 관제탑을 켜는 값으로는 비싸다.
   *
   * 프로세스가 죽어 있어도 그대로 돌려준다. 살리는 건 말을 걸 때의 일이고(FR-10),
   * 여기서 되살리면 사이드바를 그리는 것만으로 도구가 뜬다.
   */
  async orchestrator(): Promise<SessionInfo> {
    const known = this.store.orchestratorId()
    if (known) {
      const m = this.meta.get(known)
      if (m) return m
      // id는 남았는데 세션이 사라진 경우 — 표식만 지우고 새로 만든다
    }

    const info = await this.createSession({
      projectId: null,
      kind: 'orchestrator', // 표식은 세션과 함께 태어난다 — 따로 찍으면 그 사이가 무표식 상태다
      cwd: orchestratorHome(),
      tool: 'claude',
      permissionPreset: 'normal',
    })
    // 자동 이름(FR-18)이 첫 프롬프트로 덮어쓰지 않게 사람이 정한 이름으로 둔다
    this.rename(info.id, 'Orchestrator')
    return this.meta.get(info.id)!
  }

  /**
   * 사람이 이름을 정한다 (FR-18).
   *
   * **autoNamed를 내려서 자동 이름이 다시 덮지 못하게 한다.** 자동 이름은 첫 프롬프트를
   * 잘라 쓰는데, 재개·불러오기로 만든 세션은 첫 마디가 다 같아서
   * `This session is being continued…`짜리 세션이 목록에 넷이나 나란히 섰다 —
   * 이름으로는 아무것도 못 고르고 본문을 뒤져야 했다 (이슈 #5).
   * 그러니 사람이 한 번 고른 이름은 무슨 일이 있어도 살아남아야 한다.
   *
   * **조용히 넘어가지 않는다.** 예전에는 세션이 없으면 그냥 `return`이었고, RPC는
   * 그래도 `{ ok: true }`를 돌려줬다 — 이름은 안 바뀌었는데 화면은 성공한 얼굴을 했다.
   */
  rename(sessionId: string, name: string): void {
    const m = this.meta.get(sessionId)
    if (!m) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })
    const next = name.trim()
    // 빈 이름은 목록에서 아무것도 못 가리키는 줄이 된다 — 받아주면 이름 없는 세션이 생긴다
    if (!next) throw Object.assign(new Error('Session name cannot be empty'), { code: 'internal' })
    m.name = next
    m.autoNamed = false
    this.store.upsertSession(m)
    // auto:false — 받는 쪽이 "사람이 정했다"를 알아야 다음 자동 이름을 막는다
    this.emit({ type: 'session_title', sessionId, title: next, auto: false })
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
    this.watchers.close()
    // 하나가 실패해도 나머지는 정리한다 — 종료 길에 거절 하나가 전체 정리를 막으면 고아가 남는다
    await Promise.allSettled([...this.handles.values()].map((h) => h.dispose()))
    this.handles.clear()
  }

  private requireHandle(sessionId: string): SessionHandle {
    const h = this.handles.get(sessionId)
    if (!h) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })
    return h
  }
}

/**
 * What we may honestly say when the tool has no record of a conversation.
 *
 * This used to read "This conversation was deleted in Claude Code". Nobody ever observed a
 * deletion. The tool only answered "not in this directory" — and it keys its session store
 * **by working directory**, so it says that whenever the folder moves too. That is what
 * happened (issue #28): renaming the data directory moved the orchestrator's cwd, the tool
 * looked under a slug that had never existed, and the app told its owner that 924 messages
 * and an 821KB transcript — both still sitting on disk — had been deleted.
 *
 * So: report the observation, name the directory we looked in, and offer the two causes we
 * cannot tell apart from here. Claiming a deletion we did not witness reads as data loss,
 * and a person who believes their data is gone stops looking for it.
 */
function externalMissingReason(tool: ToolName, cwd: string): string {
  const label = tool === 'codex' ? 'Codex' : 'Claude Code'
  return (
    `${label} has no record of this conversation under ${cwd} — either it was removed there, ` +
    `or this folder has moved since the session started. The history kept here is still readable, ` +
    `and you can continue in a new session`
  )
}

function truncate(s: string, max = 40): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine
}
