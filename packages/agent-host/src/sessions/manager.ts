import { randomUUID } from 'node:crypto'
import { ORCHESTRATOR_ROLE, orchestratorHome } from './orchestrator-home.js'
import { dedupeNearbyHits, windowAround } from './snippet.js'
import { profileAllows, registerAppTools, runOrchestratorTool, type ToolProfile } from './orchestrator-tools.js'
import { buildHandoffRecord } from './handoff-record.js'
import { HOST_APPS } from '../apps/registry.js'
import type { HostAppContext } from '../apps/contract.js'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { exec } from 'node:child_process'
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
import { APP_SLUG, DATA_DIR, TOOL_META, sessionLiveDefaults } from '@cc/protocol'
import type { AgentAdapter, OrchestratorTools, HistoryMessage, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import {
  gitSummary,
  gitStatusFiles,
  gitDiff,
  gitHeadSha,
  gitRevParse,
  gitBranchMerged,
  gitBranchPr,
  gitBranchDelete,
  type BranchPr,
  gitLog,
  gitCommitDetail,
  gitBranches,
  gitIgnoredEntries,
  gitCheckout,
  gitStage,
  gitCommit,
  gitPush,
  gitWorktreeAdd,
  gitValidBranchName,
  type Worktree,
  gitWorktreeDirty,
  gitWorktreeRemove,
} from '../dev-services/git.js'
import { copyTree, importFile, listDir, moveEntry, readTextFile, resolveExisting } from '../dev-services/fs.js'
import { DirWatchers } from '../dev-services/watch.js'
import { saveAttachment, clearAttachments, sweepAttachments } from '../dev-services/attachments.js'
import { attachCommitSessions, looksLikeGitCommit, parseCommitSha } from '../dev-services/git-attrib.js'

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
 * 새 오케스트레이터에게 넘길 지난 대화의 분량 (줄 수와 줄 길이).
 *
 * 시스템 프롬프트에 붙는 글이라 예산이 있다. 전부 넣으면 문맥을 되찾자고 문맥을
 * 다 쓰는 셈이고, 너무 적으면 "무슨 이야기 중이었나"가 안 남는다. 40줄 × 600자면
 * 최근 몇 턴의 줄기가 남는다 — 세부가 필요하면 recall이 우리 저장소를 뒤진다.
 */
const MEMORY_MESSAGES = 40
const MEMORY_LINE_CHARS = 600

/**
 * 스트리밍 중 디스크에 남기는 주기 (#66).
 *
 * 메시지 하나가 행 하나가 되면서, 델타마다 쓰던 안전은 주기 flush가 대신한다 —
 * 죽어도 잃는 것은 마지막 2초(또는 2천 자) 안쪽이다. 델타마다 쓰지 않는 이유:
 * 자라는 본문을 매번 통째로 다시 쓰는 것이라, 긴 답변에서 쓰기량이 제곱이 된다.
 */
const STREAM_FLUSH_CHARS = 2000
const STREAM_FLUSH_MS = 2000

/**
 * recall 결과 둘레를 되살릴 때의 예산 (#66) — 개수가 아니라 **글자**로 잰다.
 *
 * 행이 델타였을 때는 행 120개가 한두 문장이었지만, 행이 메시지가 되면 행 120개는
 * 수십만 자가 될 수 있다 — recall 한 번이 오케스트레이터의 문맥을 다 태운다.
 * 그래서 목표 지점에서 가까운 메시지부터, 메시지당 상한을 두고, 총예산까지 담는다.
 */
const CONTEXT_SPAN_MSGS = 8
const CONTEXT_MSG_CHARS = 600
const CONTEXT_CHARS = 4000

/**
 * "여기까지는 옛 도구의 대화다" 표식이 저장되는 자리.
 *
 * 세션 행에 컬럼을 더하지 않는 이유: 이건 세션의 성질이 아니라 **이 설치본에서
 * 일어난 사건**이고, 새 도구가 첫 마디를 하는 순간 의미를 잃는다 (그때부터는
 * externalId가 답을 갖는다). app_settings는 그런 값이 사는 자리다.
 */
const freshStartKey = (sessionId: string) => `fresh_start:${sessionId}`
/**
 * 이 세션의 **밖 기록을 어느 시점까지 읽었는가** (도구가 준 updatedAt 그대로).
 *
 * 도구마다 단위가 달라도 상관없다 — 비교는 언제나 같은 도구가 준 값끼리다.
 */
const externalSyncedKey = (sessionId: string) => `external_synced:${sessionId}`

/** 오케스트레이터 MCP 제안/승인 목록이 사는 app_setting 키 (propose_mcp_server 흐름) */
const MCP_PROPOSALS_KEY = 'orchestrator_mcp_proposals'
const MCP_SERVERS_KEY = 'orchestrator_mcp_servers'

/** 오케스트레이터 스킬 (#71) — 파일이 아니라 DB에 산다 (워커는 파일은 쓰지만 DB는 못 쓴다) */
const SKILL_PROPOSALS_KEY = 'orchestrator_skill_proposals'
const SKILLS_KEY = 'orchestrator_skills'
/** 스킬 예산 (#71 미결 질문의 답): 시스템 프롬프트를 침식하지 않게 개수·길이를 자른다 */
const SKILL_MAX_COUNT = 10
const SKILL_MAX_CHARS = 2_000
/*
 * 값의 뜻: **이 시각까지의 밖 기록은 전부 내가 아는 내용이다.** 두 손이 쓴다 —
 * 따라잡기가 읽고 나서(도구가 준 updatedAt), 그리고 writer lock이 있는 도구의 핸들을
 * 내려놓을 때(우리 시계). 같은 기계라 두 시계는 비교 가능하다.
 */

/**
 * 세션 수명주기 + 영속화. 어댑터는 상태를 갖지 않으므로 (docs/agent-host.md §2)
 * 상태 추적·저장은 전부 여기서 한다.
 */
export class SessionManager {
  private handles = new Map<string, SessionHandle>()
  private meta = new Map<string, SessionInfo>()
  /**
   * 지금 스트리밍 중인 메시지 — 세션당 하나 (#66).
   *
   * 저장의 단위가 델타에서 메시지로 바뀌면서, "이 세션의 열린 메시지가 어느 행인가"를
   * 여기서 든다. 델타가 오면 본문이 자라고(주기 flush), 경계(도구 호출·턴 종료·
   * 사람 말·프로세스 종료)를 만나면 닫히며 그때 한 번 색인된다.
   */
  private streams = new Map<
    string,
    { seq: number; kind: 'text' | 'reasoning'; payload: Record<string, unknown>; text: string; written: number; lastWrite: number }
  >()
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
    { model: string | null; effort: string | null; verbosity: string | null; serviceTier: string | null; permissionPreset: PermissionPreset }
  >()
  /**
   * 파일 트리의 감시자 (#34). 펼쳐진 디렉토리만 본다 — 집합은 UI가 fs.watch로 보낸다.
   * 변화는 fs_changed 이벤트로 나간다 (프로젝트의 사건이라 sessionId가 없다).
   */
  private watchers = new DirWatchers((projectId, dirs) => this.emit({ type: 'fs_changed', projectId, dirs }))
  /** 도구+디렉토리별 슬래시 명령 캐시 (세션이 준비되기 전에도 목록을 줄 수 있게) */
  private commandCache = new Map<string, CommandInfo[]>()
  /**
   * 도구가 갖고 있는 대화 → 마지막으로 바뀐 시각 (짧은 캐시).
   *
   * 예전엔 id만 담은 Set이었다 — 살았나 죽었나만 물었으니까. 그런데 목록은
   * `updatedAt`도 같이 주고(ExternalSessionSummary), 그걸 버리는 바람에 바로 뒤에서
   * "밖에서 바뀐 게 있나"를 **대화를 통째로 다시 읽어서** 물었다. 이미 산 답이었다.
   */
  private externalIndex = new Map<string, { ids: Map<string, number>; at: number }>()
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
     * 앱 관찰 훅 (#81) — 방송을 가로채 켜진 앱에 흘린다. 규칙(무엇에 반응할지)은
     * 앱의 의견이고 관찰 자체는 물리라 여기(코어)가 배선한다. app_state_changed는
     * 앱 자신의 산물이라 되돌리지 않는다 — 앱이 알림을 쓰고 그 방송을 다시 관찰하면
     * 고리가 된다. 앱의 실패는 방송을 막지 못한다: 삼키고 기록한다.
     */
    const rawEmit = this.emit
    this.emit = (e) => {
      rawEmit(e)
      if (e.type === 'app_state_changed') return
      for (const app of HOST_APPS) {
        if (!app.observe || !this.appEnabled(app.id)) continue
        try {
          app.observe(this.appContext(app.id), e)
        } catch (err) {
          console.error(`[apps] ${app.id} observe failed:`, err)
        }
      }
    }
    /*
     * 기동 시 상태를 **있는 그대로 되살리지 않는다.**
     *
     * host가 죽으면 세션 프로세스도 함께 죽는다. 그런데 DB에는 마지막 상태가
     * 그대로 남아 있어서, 다시 켜면 프로세스가 하나도 없는데 화면에는 `working`이라고
     * 적혀 있다. 사람은 도는 줄 알고 기다리지만 영원히 아무 일도 일어나지 않는다
     * (도그푸딩: "40분 넘게 working에 갇혀 있다". 그때 사람들이 찾아낸 우회로가
     * 아카이브했다 되돌리기였는데, 그건 archive가 state를 idle로 되돌렸기 때문이다 —
     * 아카이브는 그 뒤 폐기됐고, 그 우회로가 필요 없도록 여기서 바로잡는다).
     *
     * 살아 있는 상태(working·승인 대기)는 **프로세스가 있어야만 참**이다.
     * 기동 시점에는 어느 세션에도 프로세스가 없으므로 전부 idle로 바로잡는다.
     * 말을 걸면 그때 깨어난다 — 사실이 아닌 상태를 보여주는 것보다 낫다.
     */
    const LIVE_ONLY: SessionState[] = ['working', 'waiting_approval']
    for (const s of store.listSessions()) {
      const stale = LIVE_ONLY.includes(s.state)
      const fixed = stale ? { ...s, state: 'idle' as const, waitingSince: null } : s
      this.meta.set(s.id, fixed)
      if (stale) {
        console.error(`[agent-host] stale state reset: ${s.id.slice(0, 8)} ${s.state} -> idle`)
        store.upsertSession(fixed)
      }
    }
    this.adoptOrphanWorktrees()
    /*
     * 병합 감지도 기동에 한 번 돈다 (#69) — 앱이 꺼진 사이 터미널에서 병합됐을 수 있다.
     * 실패는 세션 복원을 막을 이유가 못 되므로 기다리지 않는다.
     */
    for (const pid of new Set(
      [...this.meta.values()].filter((s) => s.worktree && s.projectId).map((s) => s.projectId as string),
    )) {
      void this.refreshMergedWorktrees(pid).catch(() => {})
    }
    /*
     * 앱 도구 등록 (#81). 명부(HOST_APPS)를 이 매니저의 문맥(KV·세션 조회·방송)에
     * 바인딩해서 orchestrator-tools의 레지스트리에 싣는다 — Claude MCP와 Codex
     * 다리가 그 레지스트리 하나를 본다. enabled는 클로저로 매번 묻는다.
     */
    registerAppTools(
      HOST_APPS.flatMap((app) => {
        const t = app.tools
        if (!t) return []
        return t.defs.map((d) => ({
          name: d.name,
          description: d.description,
          schema: d.schema,
          profiles: t.profiles,
          enabled: () => this.appEnabled(app.id),
          run: (args: Record<string, unknown>) => t.run(this.appContext(app.id), d.name, args),
        }))
      }),
    )
  }

  // ── 앱 상태 (#81) — 앱마다 JSON 문서 하나 + 켜짐 여부. 의미는 앱만 안다 ──

  private appKey(appId: string, key: string): string {
    return `app:${appId}:${key}`
  }

  /** 기본 켜짐 — 실험 기능이지만 도그푸딩이 곧 실험이다. 끄기는 설정의 토글로 */
  appEnabled(appId: string): boolean {
    return this.store.appSetting(this.appKey(appId, 'enabled')) !== '0'
  }

  appState(appId: string): { doc: unknown; enabled: boolean } {
    const raw = this.store.appSetting(this.appKey(appId, 'doc'))
    let doc: unknown = null
    try {
      doc = raw ? JSON.parse(raw) : null
    } catch {
      doc = null // 깨진 문서는 빈 것으로 — 앱 하나의 상태가 앱 목록 전체를 막으면 안 된다
    }
    return { doc, enabled: this.appEnabled(appId) }
  }

  setAppDoc(appId: string, doc: unknown): void {
    this.store.setAppSetting(this.appKey(appId, 'doc'), JSON.stringify(doc ?? null))
    this.emit({ type: 'app_state_changed', appId })
  }

  setAppEnabled(appId: string, enabled: boolean): void {
    this.store.setAppSetting(this.appKey(appId, 'enabled'), enabled ? '1' : '0')
    this.emit({ type: 'app_state_changed', appId })
  }

  private appContext(appId: string): HostAppContext {
    return {
      kv: {
        get: <T,>(key: string): T | null => {
          const raw = this.store.appSetting(this.appKey(appId, key))
          try {
            return raw ? (JSON.parse(raw) as T) : null
          } catch {
            return null
          }
        },
        set: (key: string, value: unknown) => {
          this.store.setAppSetting(this.appKey(appId, key), JSON.stringify(value ?? null))
        },
      },
      sessionSummary: (id: string) => {
        const m = this.meta.get(id)
        return m ? { name: m.name, state: m.state, projectId: m.projectId } : null
      },
      emitChanged: () => this.emit({ type: 'app_state_changed', appId }),
    }
  }

  /**
   * 워크트리 세션은 매니저 없이 서지 않는다 (#69).
   *
   * 이 분류의 1번 문서화된 실패가 고아 워크트리다 (Vibe Kanban #1764/#2335/#1571 —
   * 병합 후 안 치워지고, 과욕한 수거기가 산 것을 지우고, 사라진 트리에 유령 실행이
   * 남는다). 고아는 **아무도 책임지지 않을 때** 생기므로, 소속을 기동마다 강제한다:
   * 부모 없는 워크트리 세션은 프로젝트의 매니저에 붙이고, 매니저가 없으면 만든다.
   *
   * 매니저는 새 종류가 아니라 **워크트리 자식을 가진 보통 세션**이다. 여기서 만드는
   * 것도 행 하나뿐이다 — 프로세스는 뜨지 않는다 (오케스트레이터의 lazy-spawn과 같은
   * 분리: 행이 먼저 있고, 말을 걸 때 태어난다). 붙일 매니저를 고를 때 기존 세션을
   * 마음대로 승격시키지 않는 이유도 같다: 어떤 세션이 매니저가 되는가는 곧 어떤
   * 세션이 삭제 보호를 받는가라서, 조용한 승격은 조용한 잠금이 된다.
   *
   * 덧셈뿐이라(링크만 쓰고 아무것도 지우지 않는다) 재실행해도 안전하고, #66의 행
   * 재작성 같은 마이그레이션 의식이 필요 없다.
   */
  private adoptOrphanWorktrees(): void {
    const all = [...this.meta.values()]
    // 부모가 없는 것뿐 아니라 **부모가 사라진 것**도 고아다 — 아카이브된 자식만 남긴 채
    // 매니저가 지워지면 링크는 허공을 가리킨다 (삭제 보호는 산 자식만 지킨다)
    const orphans = all.filter(
      (s) => s.worktree && s.projectId && (!s.parentSessionId || !this.meta.has(s.parentSessionId)),
    )
    if (orphans.length === 0) return

    const byProject = new Map<string, SessionInfo[]>()
    for (const o of orphans) {
      const list = byProject.get(o.projectId as string) ?? []
      list.push(o)
      byProject.set(o.projectId as string, list)
    }

    for (const [projectId, kids] of byProject) {
      let manager: SessionInfo
      try {
        manager = this.managerFor(projectId)
      } catch {
        continue // 프로젝트 행이 없으면 다음 기동에 다시 본다 — 지금 지어내지 않는다
      }
      for (const kid of kids) {
        const linked = { ...kid, parentSessionId: manager.id }
        this.store.upsertSession(linked)
        this.meta.set(kid.id, linked)
      }
      console.error(
        `[agent-host] adopted ${kids.length} orphan worktree session(s) under manager ${manager.id.slice(0, 8)} (${projectId.slice(0, 8)})`,
      )
    }
  }

  /**
   * 이 프로젝트의 워크트리 매니저 — 없으면 행 하나를 만든다 (#69).
   *
   * 판정: **워크트리 자식을 가진, 워크트리가 아닌 세션.** 표식 컬럼을 더하지 않는
   * 이유는 설계 그대로다 — 매니저는 새 종류가 아니라 관계의 이름이고, 관계는 이미
   * parent_session_id가 말한다. 표식이 따로 있으면 링크와 표식이 어긋나는 상태가
   * 생긴다 (#13이 is_orchestrator로 흩어진 판정을 모은 것과 같은 이유로, 판정은
   * 한 곳에만 둔다).
   *
   * 만들 때는 행만 만든다 — 프로세스는 뜨지 않는다 (오케스트레이터의 lazy-spawn과
   * 같은 분리). 기존 세션을 조용히 매니저로 승격시키지도 않는다: 매니저가 된다는 것은
   * 삭제 보호를 받는다는 뜻이라, 조용한 승격은 조용한 잠금이다.
   */
  private managerFor(projectId: string, baseBranch?: string): SessionInfo {
    /*
     * 찾는 순서가 곧 이 기능의 역사다 (#76).
     *
     * 1) 프로젝트가 가리키는 자리 — 자식이 없어도 매니저다. 이게 없으면 첫 브랜치를
     *    정하기 전에 매니저와 상의할 방법이 없었다.
     * 2) 관계로 찾기 — #76 이전에 생긴 매니저들에는 링크가 없다. 찾으면 그 자리에서
     *    링크를 적어 준다(자가 치유): 다음부터는 1)에서 바로 걸리고, 자식을 다 정리해도
     *    자리가 사라지지 않는다.
     * 3) 없으면 만든다.
     *
     * 가리키는 세션이 사라졌거나 보관됐으면 없는 것으로 친다 — 유령을 붙들면 말을
     * 걸 수 없는 자리에 자식이 매달린다.
     */
    const all = [...this.meta.values()]
    const link = this.store.worktreeManager(projectId)
    if (link) {
      const seated = this.meta.get(link.sessionId)
      if (seated) return seated
    }

    const withKids = new Set(all.filter((s) => s.parentSessionId).map((s) => s.parentSessionId as string))
    const existing = all.find((s) => s.projectId === projectId && !s.worktree && withKids.has(s.id))
    if (existing) {
      this.store.setWorktreeManager(projectId, { sessionId: existing.id, baseBranch: link?.baseBranch ?? '' })
      return existing
    }

    const stored = this.store.listProjects().find((p) => p.id === projectId)
    if (!stored) throw Object.assign(new Error(`Project not found: ${projectId}`), { code: 'internal' })
    const manager: SessionInfo = {
      id: randomUUID(),
      projectId,
      kind: 'worker',
      tool: stored.defaultTool === 'codex' ? 'codex' : 'claude',
      externalId: null,
      name: 'Worktrees',
      autoNamed: false,
      state: 'idle',
      lastReadSeq: 0,
      lastSeq: 0,
      createdAt: Date.now(),
      waitingSince: null,
      // 행만 만든다 — 프로세스가 없으므로 live는 거짓이 맞다 (말을 걸면 깨어난다)
      live: false,
      model: null,
      effort: null,
      verbosity: null,
      serviceTier: null,
      permissionPreset: 'normal',
      importedFrom: null,
      worktree: null,
      parentSessionId: null,
      ...sessionLiveDefaults(),
    }
    this.store.upsertSession(manager)
    this.store.setSessionCwd(manager.id, stored.path)
    this.store.setWorktreeManager(projectId, { sessionId: manager.id, baseBranch: baseBranch ?? link?.baseBranch ?? '' })
    this.meta.set(manager.id, manager)
    this.emit({ type: 'session_created', sessionId: manager.id, session: manager })
    return manager
  }

  /**
   * 매니저 자리를 **먼저** 만든다 (#76) — 자식이 하나도 없을 때도.
   *
   * 자식이 없는 매니저는 도구를 못 쓰는 게 아니라 **볼 것이 없는** 상태다: 도구 묶음은
   * 그대로 받되 시야(childrenOf)가 비어 있어서, list_sessions는 빈 목록을 주고
   * read/send는 "이 매니저의 워크트리 세션이 아닙니다"로 거절한다. 그래서 프로필을
   * 하나 더 만들지 않았다 — 이미 있는 범위 판정이 그 일을 한다.
   *
   * 줄기(baseBranch)는 여기서만 정해진다. 기본값을 우리가 지어내지 않는 이유: 어느
   * 브랜치가 줄기인지는 저장소마다 다르고(main·master·develop), 틀린 기본값은 워크트리가
   * 엉뚱한 데서 갈라진 뒤에야 드러난다. 부르는 쪽(화면)이 현재 브랜치를 채워 보낸다.
   */
  async createWorktreeManager(projectId: string, baseBranch: string): Promise<SessionInfo> {
    const stored = this.store.listProjects().find((p) => p.id === projectId)
    if (!stored) throw Object.assign(new Error(`Project not found: ${projectId}`), { code: 'internal' })
    const branch = baseBranch.trim()
    if (!branch) throw Object.assign(new Error('Pick the branch worktrees should fork from'), { code: 'internal' })
    if (!(await gitValidBranchName(branch))) {
      throw Object.assign(new Error(`Not a branch name: ${branch}`), { code: 'internal' })
    }
    const manager = this.managerFor(projectId, branch)
    // 이미 있던 자리에도 줄기를 적어 준다 — 만들기를 다시 눌러 줄기를 고치는 길이 된다
    this.store.setWorktreeManager(projectId, { sessionId: manager.id, baseBranch: branch })
    return { ...manager, live: this.handles.has(manager.id) }
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

  /**
   * 프로젝트를 지운다 (등록 해제가 아니라 **삭제**다).
   *
   * 파일은 건드리지 않는다 — 폴더를 지우는 일은 OS의 휴지통을 통해서만 하고, 그건
   * 셸(Rust)의 일이라 호출하는 쪽에서 이 명령보다 **먼저** 끝낸다. 순서가 그 방향인
   * 이유: 경로를 아는 유일한 근거가 이 DB의 행이라, 행을 먼저 지우면 무엇을 버릴지
   * 물어볼 곳이 없어진다. 반대로 휴지통이 실패하면 아무것도 안 지운 채로 끝난다.
   *
   * 세션은 `deleteSession`을 그대로 거친다 — 프로세스를 정리하고 첨부를 지우고
   * `session_deleted`를 쏘는 일을 여기서 다시 쓰면 언젠가 두 벌이 어긋난다.
   * 다만 **워크트리는 남긴다.** 지우려면 git이 필요한데 그 저장소가 방금 사라졌을 수도
   * 있고, 무엇보다 워크트리 안의 것은 아직 병합되지 않은 사람의 일이다 —
   * 세션 삭제 창이 워크트리를 기본으로 남기는 것과 같은 판단이다.
   *
   * 자식이 있는 매니저를 먼저 지우려 하면 #69의 보호가 막는다. 그래서 **잎부터** 지운다.
   */
  async deleteProject(projectId: string): Promise<void> {
    const mine = [...this.meta.values()].filter((s) => s.projectId === projectId)
    const leavesFirst = [...mine].sort(
      (a, b) => Number(!!b.parentSessionId) - Number(!!a.parentSessionId),
    )
    for (const s of leavesFirst) await this.deleteSession(s.id).catch(() => {})
    this.store.deleteProject(projectId)
  }

  private async projectInfo(id: string, path: string): Promise<ProjectInfo> {
    const git = await gitSummary(path)
    /*
     * **저장된 값을 읽는다.** 여기 'claude'가 상수로 박혀 있어서, DB의 default_tool은
     * 읽히는 자리가 하나도 없는 컬럼이었다 — 쓰는 자리도 없었으니 아무도 눈치채지
     * 못했다 (2026-08-27, 기억하기 기능을 붙이다 테스트가 잡았다).
     */
    const row = this.store.listProjects().find((p) => p.id === id)
    const stored = row?.defaultTool
    return {
      id, path, name: basename(path), defaultTool: stored === 'codex' ? 'codex' : 'claude',
      defaultModel: row?.defaultModel ?? null,
      defaultEffort: row?.defaultEffort ?? null,
      // Saved shell commands ride along with the project so the Run menu never has a
      // "loading" state to distinguish from an empty one (issue #44)
      commands: this.store.projectCommands(id),
      // 워크트리 프로비저닝(#69)도 함께 실린다 — 새 세션 창이 별도 fetch 없이 프리필한다
      worktreeSetup: this.store.worktreeSetup(id),
      // 매니저 자리와 줄기 (#76). 가리키는 세션이 없거나 보관됐으면 없는 것으로 준다 —
      // 화면이 유령 자리로 안내하지 않게, 판정은 세션을 아는 이쪽에서 한다
      worktreeManager: (() => {
        const link = this.store.worktreeManager(id)
        if (!link) return null
        const seated = this.meta.get(link.sessionId)
        return seated ? link : null
      })(),
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

  /** 워크트리 프로비저닝 설정 (#69) — 새 세션 창의 워크트리 영역이 저장한다 */
  setWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): void {
    if (!this.store.listProjects().some((p) => p.id === projectId)) {
      throw Object.assign(new Error('Project not found'), { code: 'internal' })
    }
    const clean = setup
      ? { command: setup.command.trim(), copyFiles: setup.copyFiles.map((f) => f.trim()).filter(Boolean) }
      : null
    this.store.setWorktreeSetup(projectId, clean && (clean.command || clean.copyFiles.length) ? clean : null)
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
    /*
     * 병합 감지(#69)가 여기 얹혀 산다 — UI가 턴이 끝날 때마다 디바운스로 부르는 길이라,
     * "일이 방금 움직였다"는 신호와 같은 주기다. 터미널에서 병합해도 다음 새로고침에 잡힌다.
     * 응답을 막지 않는다: 배지는 이벤트로 따로 흐른다.
     */
    void this.refreshMergedWorktrees(projectId).catch(() => {})
    return this.projectInfo(p.id, p.path)
  }

  listSessions(): SessionInfo[] {
    return [...this.meta.values()].map((s) => ({ ...s, live: this.handles.has(s.id) }))
  }

  /** 같은 디렉토리에서 실행 중인 활성 세션 (FR-2 동시 세션 경고의 근거) */
  activeSessionsIn(projectId: string): SessionInfo[] {
    return this.listSessions().filter((s) => s.projectId === projectId)
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
        if (s.tool !== tool) continue
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
       * (orchestrator()가 유일한 길이다),
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
    let worktree: Worktree | null = null
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
      /*
       * 브랜치 이름은 사람이 정할 수 있다 (#69) — 브랜치 이름이 곧 세션 이름이라
       * 사실상 영구라서다. 안 정하면 세션 id 앞자리를 쓴다 (세션 이름은 아직 없거나
       * 자동 이름은 나중에 붙고, 공백·유니코드가 섞여 브랜치 이름으로 못 쓴다).
       * 검증은 git 자신에게 시킨다 — ref 규칙을 우리가 다시 적지 않는다.
       */
      const requested = params.worktreeBranch?.trim()
      if (requested && !(await gitValidBranchName(requested))) {
        throw Object.assign(new Error(`Not a valid branch name: ${requested}`), { code: 'internal' })
      }
      const branch = requested || `${APP_SLUG}/${id.slice(0, 8)}`
      /*
       * 어디서 갈라지는가 (#76). 매니저가 줄기를 쥐고 있으면 거기서, 없으면 예전처럼
       * 루트의 HEAD에서 갈라진다. 줄기를 못 찾으면(브랜치가 지워졌다) HEAD로 물러나되
       * 조용히는 아니다 — 로그에 남긴다.
       */
      const trunk = params.projectId ? this.trunkOf(params.projectId) : null
      const from = trunk && (await gitRevParse(params.cwd, trunk)) ? trunk : null
      if (trunk && !from) console.error(`[worktree] trunk not found, forking from HEAD instead: ${trunk}`)
      // 병합 감지의 기준점 (#69): 브랜치가 갈라진 지점. 이게 없으면 갓 만든 브랜치가
      // 줄기의 조상이라는 이유만으로 "병합됨"으로 읽힌다.
      const baseSha = from ? await gitRevParse(params.cwd, from) : await gitHeadSha(params.cwd)
      try {
        worktree = await gitWorktreeAdd(params.cwd, path, branch, from ?? undefined)
        if (baseSha) worktree = { ...worktree, base: baseSha }
      } catch (err) {
        const msg = (err as { stderr?: string; message?: string }).stderr ?? (err as Error).message
        throw Object.assign(new Error(`Could not create the worktree: ${String(msg).trim()}`), { code: 'internal' })
      }
      // 빈 작업대를 차린다 (#69): 파일 복사 → 셋업 커맨드. 순서는 VK가 검증한 그대로다
      await this.provisionWorktree(params.cwd, worktree, params.projectId)
    }

    /*
     * 세션 이름 = 브랜치 이름 (#69, 사람이 브랜치를 정한 경우). Conductor는 워크스페이스마다
     * "고유한 도시 이름"을 붙이는데 그 이름은 브랜치가 무엇을 하는지 아무것도 말하지 않는다 —
     * 뜻을 나르는 사람이 읽을 식별자는 브랜치 이름뿐이다. autoNamed=false로 두어
     * 자동 이름이 덮지 않는다.
     */
    const namedByBranch = worktree && params.worktreeBranch ? worktree.branch : null
    const info: SessionInfo = {
      id, projectId: params.projectId, kind: params.kind ?? 'worker', tool: params.tool, externalId: null,
      name: namedByBranch ?? (params.initialPrompt ? truncate(params.initialPrompt) : 'New session'),
      autoNamed: !namedByBranch, state: 'idle', lastReadSeq: 0, lastSeq: 0,
      createdAt: Date.now(), waitingSince: null, live: true,
      model: params.model ?? null, effort: params.effort ?? null,
      verbosity: params.verbosity ?? null,
      serviceTier: params.serviceTier ?? null,
      permissionPreset: params.permissionPreset,
      importedFrom: params.importHistory ? (params.resumeExternalId ?? null) : null,
      worktree,
      // 워크트리 세션은 태어나는 순간부터 매니저 아래에 선다 (#69) — 고아는 만들지 않는다.
      // (worktree가 있으면 projectId도 있다 — 워크트리는 프로젝트 디렉토리에서만 만들어진다)
      parentSessionId: worktree && params.projectId ? this.managerFor(params.projectId).id : null,
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
          serviceTier: params.serviceTier,
          permissionPreset: params.permissionPreset, resumeExternalId: params.resumeExternalId,
          // 오케스트레이터는 전부, 워크트리 매니저(#69)는 부분집합을 받는다.
          // 갓 만든 세션은 자식이 없으므로 여기서 매니저일 수 없다 — 매니저가 되는 것은
          // 첫 자식이 붙은 뒤 다음에 깰 때다 (wake 쪽 조건이 그 승격의 실제다).
          orchestratorTools: info.kind === 'orchestrator' ? this.orchestratorToolsFor(id) : undefined,
          toolProfile: info.kind === 'orchestrator' ? 'orchestrator' : undefined,
          systemPromptAppend: info.kind === 'orchestrator' ? ORCHESTRATOR_ROLE + this.skillsPrompt() : undefined,
          orchestratorBridge: info.kind === 'orchestrator' ? (this.endpoint?.() ?? undefined) : undefined,
          // 사람이 승인한 MCP 서버 (propose_mcp_server → 승인 → 재시작의 결과가 여기서 실린다)
          extraMcpServers: info.kind === 'orchestrator' ? this.mcpServers() : undefined,
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
    /*
     * UI가 이 세션을 **이벤트로도** 알게 한다 (#69).
     *
     * RPC로 만든 쪽은 응답으로 이미 알지만, host가 만드는 세션(오케스트레이터의
     * create_session, 워크트리 입양의 매니저)은 이 이벤트가 유일한 통지다. 이게 없던
     * 동안 그런 세션의 이벤트는 pendingEvents 보관함에 들어가 등록을 기다렸는데,
     * 등록시켜 줄 것이 아무것도 없었다 — 재연결 후 listSessions로만 나타났다.
     * 받는 쪽은 이미 아는 세션이면 버린다(멱등).
     */
    this.emit({ type: 'session_created', sessionId: id, session: info })
    /*
     * **마지막에 고른 도구가 이 프로젝트의 기본값이 된다.**
     *
     * default_tool은 프로젝트 생성 시 'claude'로 박힌 뒤 갱신되는 자리가 없었다 —
     * codex를 쓰는 사람은 새 세션마다 영원히 필을 다시 눌렀다. 설정 화면을 만드는
     * 대신 여기 두는 이유: "무엇을 기본으로 쓰는가"는 **세션을 만드는 행위가 이미
     * 말해 준다.** 그래서 UI든 오케스트레이터의 create_session이든 같은 규칙을 받는다.
     */
    if (params.projectId) {
      const owner = this.store.listProjects().find((p) => p.id === params.projectId)
      if (owner && owner.defaultTool !== params.tool) {
        this.store.setProjectDefaultTool(params.projectId, params.tool)
      }
    }
    this.handles.set(id, handle)
    this.running.set(id, {
      model: info.model,
      effort: info.effort,
      verbosity: info.verbosity,
      serviceTier: info.serviceTier,
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

    /*
     * **바뀌지 않은 기록은 다시 읽지 않는다.**
     *
     * 이 따라잡기는 "앱 밖(터미널의 도구)에서 이 대화를 이어갔다면 그것도 가져오자"는
     * 보정이다. 그런데 밖에서 쓴 적이 없으면 읽을 것이 없는데도 매번 전문을 읽었고,
     * 그 값은 대화 길이를 따라 자란다 — 775턴짜리 codex 스레드에서 실측 **48.6MB /
     * 8.9초**였다. 게다가 그 8.9초는 첫 메시지가 나가기 전에 치른다 (아래 resume에서
     * 이걸 await한다). 잠든 세션을 깨워 말을 걸면 9초를 기다리게 한 정체가 이것이다.
     *
     * 도구에게 "조금만 달라"고 할 수는 없다. codex의 thread/read에는 개수라는 개념이
     * 없다 — 실측: limit을 실어도 무시하고 똑같이 48.6MB를 준다. 전부 아니면 전무다.
     * 그러니 **덜 받는 대신 안 묻는다.**
     *
     * 물을 상대는 이미 있다. 목록이 주는 `updatedAt`이 그것이고, 바로 앞 externalGone이
     * 그 목록을 이미 받아 캐시에 넣어 뒀다 — 여기서는 공짜다.
     *
     * 도구 이름이 나오지 않는다는 점이 중요하다. 이건 codex의 예외가 아니라 따라잡기의
     * 규칙이라, claude에도 그대로 적용되고 다음에 붙일 어댑터도 그냥 따라온다.
     * `listExternalSessions`가 없는 어댑터는 시각을 모르므로 예전처럼 매번 읽는다 —
     * **모르면 건너뛰지 않는다**(이 파일의 다른 선택 기능들과 같은 degrade 방향).
     */
    /* `cwd`(프로젝트 경로)가 아니라 `cwdFor`로 묻는다 — 바로 앞 externalGone이 그 열쇠로
       캐시를 채웠기 때문이다. 여기서 다른 열쇠를 쓰면 아끼려던 목록 조회를 한 번 더 낸다
       (워크트리 세션은 두 경로가 다르다). 목록에 없으면 시각을 모르니 예전처럼 읽는다. */
    const changedAt = (await this.externalIndexOf(info.tool, this.cwdFor(info)))?.get(externalId) ?? null
    const key = externalSyncedKey(info.id)
    if (changedAt !== null && changedAt <= Number(this.store.appSetting(key) ?? '-1')) return 0
    /* 읽어낸 지점을 남긴다. 붙일 것이 없었어도 남긴다 — "읽었다"와 "새 것이 있었다"는
       다른 사실이고, 전자를 안 적으면 바뀔 때마다가 아니라 매번 다시 읽는다. */
    const mark = () => {
      if (changedAt !== null) this.store.setAppSetting(key, String(changedAt))
    }

    let history: HistoryMessage[]
    try {
      history = await adapter.readExternalHistory(externalId, cwd, SYNC_LIMIT)
    } catch {
      return 0 // 못 읽어도 대화는 계속된다 (표식도 남기지 않는다 — 읽은 적이 없다)
    }
    if (history.length === 0) {
      mark()
      return 0
    }

    const ours = this.store.loadMessages(info.id, SYNC_LIMIT)
    /*
     * loadMessages는 이제 병합된 메시지를 준다 (#66). 이 되살리기 루프는 그래도
     * 남는다 — 도구 호출 없이 턴이 갈린 연속 assistant 메시지를 도구 기록과 같은
     * 단위로 잇는 일은 여전히 여기 몫이고, 병합된 행에는 멱등이라 해가 없다.
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
    if (start < 0 || start >= history.length) {
      mark()
      return 0
    }

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
    mark()
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
      /*
       * **잃어버린 것과 놓기로 한 것을 가른다.**
       *
       * 이 가드는 "기록은 있는데 이어갈 id가 없다"를 사고로 보고 막는다 — 옳다.
       * 그런데 도구를 바꾸면 정확히 같은 모양이 **의도적으로** 만들어진다(새 도구는
       * 옛 대화를 이어받을 수 없다). 그래서 그 순간 경계를 적어 두고, 그 뒤로 오간
       * 말이 없으면 새로 띄워도 잃을 것이 없다고 판단한다.
       * (경계 뒤에 말이 오갔다면 그건 새 도구의 대화이고, 그때는 externalId가 있다.)
       */
      const boundary = Number(this.store.appSetting(freshStartKey(m.id)) ?? '-1')
      const newest = this.store.loadMessages(m.id, 1)[0]
      if (newest && newest.seq > boundary) {
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

    /*
     * 단계별 시간을 잰다 — **성공했지만 느린 재개가 흔적을 남기게.**
     *
     * 시간제한 메시지는 실패에만 붙는다. 재개가 9초 걸리고 성공하면 로그에는
     * 아무것도 없어서, "깨우는 게 느린데?"라는 지적에 어느 단계가 먹었는지
     * 답할 길이 실측 스크립트를 새로 짜는 것뿐이었다 (도그푸딩에서 실제로 그랬다).
     * 아래 한 줄이 host.log에 남는다: 확인(목록)·시작(프로세스+resume)·따라잡기.
     */
    const t0 = Date.now()
    const gone = await this.externalGone(m, cwd)
    const tCheck = Date.now() - t0
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
          serviceTier: m.serviceTier ?? undefined,
          permissionPreset: m.permissionPreset,
          resumeExternalId: resumeId ?? undefined,
          /*
           * **도구와 역할은 되살릴 때도 따라와야 한다.**
           *
           * 만들 때만 붙이면, 다시 뜬 오케스트레이터는 도구도 역할도 없는
           * 평범한 세션이 된다 — 빈 폴더에 앉아 아무것도 못 하면서
           * 겉보기에는 멀쩡한, 가장 나쁜 상태다.
           *
           * 그리고 여기가 곧 **매니저가 실제가 되는 자리**다 (#69): 첫 자식이 붙은 세션이
           * 다음에 깰 때 이 조건을 지나며 자식만 보는 도구와 역할을 받는다.
           */
          orchestratorTools:
            m.kind === 'orchestrator'
              ? this.orchestratorToolsFor(sessionId)
              : // 워크트리 매니저 (#69): 자식이 있으면 매니저다 — 자식만 보는 도구를 받는다
                this.isWorktreeManager(sessionId)
                ? this.orchestratorToolsFor(sessionId, sessionId)
                : undefined,
          toolProfile:
            m.kind === 'orchestrator' ? 'orchestrator' : this.isWorktreeManager(sessionId) ? 'manager' : undefined,
          /*
           * 여기가 **기억을 넘기는 자리**다. 도구를 바꾸면 externalId가 끊겨서
           * 이 길(새 프로세스)로 들어오는데, 그때 지난 대화를 함께 실어 보낸다.
           * 이어가기(resume)로 들어온 세션은 도구가 이미 문맥을 갖고 있으므로
           * 같은 말을 두 번 넣지 않는다.
           */
          systemPromptAppend:
            m.kind === 'orchestrator'
              ? // 스킬(#71)은 언제나, 기억 인수인계는 새 프로세스일 때만 (기존 규칙 그대로)
                ORCHESTRATOR_ROLE + this.skillsPrompt() + (resumeId ? '' : this.orchestratorMemory(m.id))
              : undefined,
          orchestratorBridge:
            m.kind === 'orchestrator' || this.isWorktreeManager(sessionId)
              ? (this.endpoint?.() ?? undefined)
              : undefined,
          // 승인된 MCP 서버는 재시작(=이 길)에서 실려야 "승인 → 재시작 → 바로 사용"이 성립한다
          extraMcpServers: m.kind === 'orchestrator' ? this.mcpServers() : undefined,
        },
        (e) => this.onEvent(e),
      )
      /*
       * **여기가 상한 없이 기다리던 자리다** — 그리고 그 대기가 이 함수의 유일한
       * 진행 중(resuming) 약속을 붙들고 있었다. 도구가 뜨다 멈추면 바깥 RPC는 30초에
       * 포기하지만 이 약속은 안 풀리고, Retry는 dedup 때문에 **그 멈춘 약속에 다시
       * 합류한다**. 사람 눈에는 "Retry가 안 된다"로 보인다 (MGH 세션에서 실측).
       *
       * 150초인 이유: 되살리기 계열 RPC의 180초(rpc-client의 LONG_CALLS)보다 안쪽이어야
       * 화면이 이름 없는 RPC 시간제한 대신 이 단계의 이름이 붙은 이유를 받고,
       * resuming도 그때 풀려 Retry가 진짜 재시도가 된다. (원래 25초/30초였는데,
       * codex thread/resume이 rollout 크기에 비례해 — 550MB≈13.5초 실측 — 자라는 걸
       * 확인하고 늘렸다. "리소스 업로드" 세션이 25초 벽에 막혀 영영 못 깨어났다.)
       *
       * 시간제한이 이겨도 도구 프로세스는 이미 떠 있을 수 있다 — 늦게라도 도착하면
       * 거둔다. 안 거두면 잠긴 스레드를 쥔 app-server가 조용히 남는다.
       */
      const tStartFrom = Date.now()
      const handle = await withTimeout(creating, 150_000, `Starting ${m.tool}`).catch((err) => {
        void creating.then((h) => h.dispose()).catch(() => {})
        throw err
      })
      const tStart = Date.now() - tStartFrom
      this.handles.set(sessionId, handle)
      this.running.set(sessionId, {
        model: m.model,
        effort: m.effort,
        verbosity: m.verbosity,
        serviceTier: m.serviceTier,
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
      // 오케스트레이터는 앱이 관리하는 세션이라 밖에서 이어갈 일이 없다 — 프로젝트가 없어서
      // 이 조건에 원래 안 걸린다 (프로젝트를 가진 오케스트레이터는 이제 존재하지 않는다)
      let tCatchup = 0
      let added = 0
      if (project) {
        // 따라잡기가 멈춰도 세션은 이미 살아 있다 — 붙잡지 말고 다음 기회에 맡긴다
        const tCatchupFrom = Date.now()
        added = await withTimeout(this.syncImportedHistory(m, adapter, project.path), 10_000, 'History catch-up').catch(() => 0)
        tCatchup = Date.now() - tCatchupFrom
        if (added > 0) this.emit({ type: 'history_synced', sessionId, added })
      }
      // catchup이 수백 ms 미만이면 건너뛴 것이다 (바뀐 게 없어 전문을 안 읽었다)
      console.error(
        `[agent-host] resumed ${sessionId.slice(0, 8)} tool=${m.tool} ` +
          `check=${tCheck}ms start=${tStart}ms catchup=${tCatchup}ms added=${added} total=${Date.now() - t0}ms`,
      )
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
  async deleteSession(sessionId: string, deleteWorktree = false, deleteExternal = false): Promise<void> {
    const m = this.meta.get(sessionId)
    /*
     * 살아 있는 워크트리 자식이 있는 매니저는 지울 수 없다 (#69).
     *
     * 이 분류의 1번 실패가 고아 워크트리이고, 고아는 책임자가 사라질 때 생긴다.
     * 자식이 아카이브되면 더는 붙들지 않는다 — 병합된/끝난 작업이 매니저를 영원히
     * 고정하면 보호가 벌이 된다 (설계: merged children do not pin the manager).
     */
    const liveKids = [...this.meta.values()].filter(
      // 병합된 자식은 붙들지 않는다 (#69 설계: merged children do not pin the manager) —
      // 이력이지 진행 중인 일이 아니다. 아카이브도 같다.
      (s) => s.parentSessionId === sessionId && !s.worktreeMerged,
    )
    if (liveKids.length > 0) {
      throw Object.assign(
        new Error(
          `This session manages ${liveKids.length} worktree session(s) — delete them first`,
        ),
        { code: 'internal' },
      )
    }
    // 행이 곧 지워지므로 마지막 flush는 의미가 없다 — 추적만 걷는다 (#66)
    this.streams.delete(sessionId)
    const handle = this.handles.get(sessionId)
    if (handle) {
      await handle.dispose().catch(() => {})
      this.handles.delete(sessionId)
    }
    /*
     * 도구 쪽 원본 삭제 ("진짜로 삭제")는 **우리 쪽을 지우기 전에** 한다. 실패하면
     * 그대로 던져서 세션이 목록에 남게 — "지웠다"고 답했는데 원본이 살아 있는 것이
     * 최악이라서다(사람은 550MB가 사라진 줄 안다). dispose 뒤인 이유: codex는
     * 살아 있는 동안 writer lock을 쥐고 있어 지울 수 없다.
     */
    if (deleteExternal && m) {
      const externalId = m.externalId ?? m.importedFrom
      if (externalId) {
        const del = this.adapters.get(m.tool)?.deleteExternalConversation
        if (!del) {
          throw Object.assign(
            new Error(`${m.tool} does not support deleting its conversation file`),
            { code: 'internal' },
          )
        }
        await del.call(this.adapters.get(m.tool), externalId, this.cwdFor(m))
      }
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
    s: { model?: string | null; effort?: string | null; verbosity?: string | null; serviceTier?: string | null; permissionPreset?: PermissionPreset },
  ): Promise<SessionInfo> {
    const m = this.meta.get(sessionId)
    if (!m) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })

    if (s.model !== undefined) m.model = s.model
    if (s.effort !== undefined) m.effort = s.effort
    if (s.verbosity !== undefined) m.verbosity = s.verbosity
    if (s.serviceTier !== undefined) m.serviceTier = s.serviceTier
    if (s.permissionPreset) m.permissionPreset = s.permissionPreset
    this.store.upsertSession(m)
    /*
     * 마지막으로 고른 모델·강도가 이 프로젝트의 기본값이 된다 (#69 ⑤).
     * default_tool이 배운 교훈 그대로다: 설정 화면을 만드는 대신, 고르는 행위가
     * 이미 말해 주는 사실을 적는다. Opus·high를 쓰는 사람이 새 세션마다 네 번
     * 클릭하는 반복이 여기서 끝난다. 도구별 모델이라 도구가 같은 세션의 선택만 적는다.
     */
    if ((s.model !== undefined || s.effort !== undefined) && m.projectId) {
      const p = this.store.listProjects().find((x) => x.id === m.projectId)
      if (p && p.defaultTool === m.tool) {
        this.store.setProjectDefaultModel(m.projectId, m.model, m.effort)
      }
    }

    const handle = this.handles.get(sessionId)
    handle?.updateSettings?.(s)

    // 비교 기준은 화면값(meta)이 아니라 **돌고 있는 프로세스의 설정**이다
    const live = this.running.get(sessionId)
    const drifted =
      !!live &&
      (live.model !== m.model ||
        live.effort !== m.effort ||
        live.verbosity !== m.verbosity ||
        live.serviceTier !== m.serviceTier ||
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
        // 이미지는 파일로 영속된다 (#40 2차) — 비동기라 여기서 seq를 받지 않는다
        if (e.type === 'message_image') void this.persistImage(e, m)
        // 커밋 귀속 (#50) — git commit 도구 호출을 눈앞에서 지나갈 때 줍는다
        if (e.type === 'tool_call' || e.type === 'tool_result') this.observeCommit(e, m)
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
        undefined,
        // 보고도 사람 말이 아니다 (FR-11) — 보고한 워커 세션을 출처로 단다
        { sessionId, name: target.name },
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
    if (!hint) return
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
   * 대화 기록으로 남길 이벤트만 저장. 저장했다면 매긴 세션 내 seq를 돌려준다 —
   * 방송에 실어 UI의 안읽음 추적 기준이 된다.
   *
   * **스트리밍 델타는 행을 만들지 않고 열린 행을 키운다** (#66).
   * 예전에는 델타 하나가 행 하나였다 — 한 문장이 행 아홉 개가 되고, DB의 84%가
   * 조각이었으며, 페이지네이션은 행을 세느라 의미를 잃고, trigram 색인은 1~2자
   * 본문을 색인하지 못해 검색이 죽었다. 지금은 메시지가 시작될 때 행 하나를 만들고
   * (첫 조각은 그 자리에서 남긴다 — 죽어도 시작은 남게), 이후 조각은 본문에 이어
   * 붙이며 주기적으로만 flush한다. 색인은 스트림이 닫힐 때 한 번이다.
   */
  private persistMessage(e: NormalizedEvent, m: SessionInfo): number | null {
    // 추론 요약 (#58)은 텍스트가 실렸을 때만 기록이다. estTokens뿐인 조각(claude)은
    // 진행 표시로만 살다 사라진다: 내용 없는 행을 쌓으면 기록이 소음이 된다.
    if (e.type === 'message_delta' || (e.type === 'reasoning_delta' && e.text)) {
      const streamKind = e.type === 'message_delta' ? ('text' as const) : ('reasoning' as const)
      const text = e.text ?? ''
      const run = this.streams.get(m.id)
      if (run && run.kind === streamKind) {
        run.text += text
        if (run.text.length - run.written >= STREAM_FLUSH_CHARS || Date.now() - run.lastWrite >= STREAM_FLUSH_MS) {
          this.flushStream(m.id, run)
        }
        m.lastSeq = run.seq
        return run.seq
      }
      // 종류가 갈리면(답변↔추론) 그 자리가 경계다
      if (run) this.closeStream(m.id)
      // 빈 조각으로 행을 시작하지 않는다 — codex가 끝에 보내는 "" 델타가 빈 행 1,853개를 만들었다
      if (!text) return null
      const seq = this.store.nextSeq(m.id)
      const fresh = { seq, kind: streamKind, payload: { ...e } as Record<string, unknown>, text, written: 0, lastWrite: 0 }
      this.streams.set(m.id, fresh)
      this.flushStream(m.id, fresh)
      m.lastSeq = seq
      return seq
    }

    /*
     * 스트림이 아닌 **기록**은 전부 메시지의 경계다 — 도구 호출이 답변 중간에 오면
     * 그 앞까지가 한 덩어리다. 반면 activity·usage_update처럼 기록되지 않는
     * 이벤트는 스트리밍과 자연스럽게 섞이므로 경계가 아니다. 턴의 끝(turn_complete·
     * error·working이 아닌 state_change)도 경계다 — 기록은 안 남지만 메시지는 끝났다.
     */
    const kind =
      e.type === 'tool_call' ? 'tool_call'
      : e.type === 'tool_result' ? 'tool_result'
      : e.type === 'approval_request' || e.type === 'approval_resolved' ? 'approval'
      // 압축 지점을 기록에 남긴다. 모델의 컨텍스트에서는 옛 대화가 접혔지만
      // 우리 기록에는 그대로 있다 — 어디서 접혔는지 보여야 거슬러 읽을 수 있다.
      : e.type === 'compaction' ? 'marker'
      : null
    const boundary =
      kind !== null ||
      e.type === 'turn_complete' ||
      e.type === 'error' ||
      (e.type === 'state_change' && e.state !== 'working')
    if (boundary) this.closeStream(m.id)
    if (!kind) return null
    const seq = this.store.nextSeq(m.id)
    const msg: StoredMessage = { sessionId: m.id, seq, role: 'system', kind, payload: e, ts: Date.now() }
    this.store.appendMessages([msg])
    m.lastSeq = seq
    return seq
  }

  /** 열린 스트림 행을 지금 모습대로 디스크에 — 색인은 닫힐 때 한 번이다 (#66) */
  private flushStream(sessionId: string, run: { seq: number; kind: 'text' | 'reasoning'; payload: Record<string, unknown>; text: string; written: number; lastWrite: number }): void {
    this.store.upsertMessageNoIndex({
      sessionId, seq: run.seq, role: 'assistant', kind: run.kind,
      payload: { ...run.payload, text: run.text }, ts: Date.now(),
    })
    run.written = run.text.length
    run.lastWrite = Date.now()
  }

  /** 메시지가 끝났다 — 마지막 모습을 남기고 이제서야 검색 색인에 넣는다 (#66) */
  private closeStream(sessionId: string): void {
    const run = this.streams.get(sessionId)
    if (!run) return
    this.streams.delete(sessionId)
    this.store.appendMessages([
      {
        sessionId, seq: run.seq, role: 'assistant', kind: run.kind,
        payload: { ...run.payload, text: run.text }, ts: Date.now(),
      },
    ])
  }

  saveAttachment(sessionId: string, name: string, mime: string, dataBase64: string) {
    return saveAttachment(sessionId, name, mime, dataBase64)
  }

  /**
   * 에이전트가 내놓은 이미지의 영속 (#40, 2차 결정 2026-08-26: 표시만 → 영속하되
   * 총량 500MB). 바이트는 attachments 파일로, DB 행에는 경로만 — 사용자→에이전트
   * 방향의 첨부와 똑같은 구조라 DB는 계속 텍스트만 남는다.
   */
  private async persistImage(e: Extract<NormalizedEvent, { type: 'message_image' }>, m: SessionInfo): Promise<void> {
    let stored: string | undefined
    let note = e.note
    if (e.data) {
      try {
        stored = (await saveAttachment(m.id, 'agent-image', e.mime, e.data)).path
        // 상한 유지는 쓰는 쪽의 책임 — 넘치면 오래된 파일부터 걷는다
        void sweepAttachments().catch(() => {})
      } catch (err) {
        note = `이미지를 저장하지 못했습니다: ${(err as Error).message}`
      }
    }
    const payload: NormalizedEvent = {
      type: 'message_image', sessionId: m.id, mime: e.mime, data: '', path: stored ?? e.path, note,
    }
    const seq = this.store.nextSeq(m.id)
    this.store.appendMessages([{ sessionId: m.id, seq, role: 'system', kind: 'image', payload, ts: Date.now() }])
    m.lastSeq = seq
    this.store.upsertSession(m)
  }

  /** tool_call의 callId → 그 호출이 `git commit`이었던 세션 (#50) */
  private pendingCommits = new Map<string, string>()

  /**
   * 훅 없는 커밋 귀속 (#50). 에이전트의 커밋은 도구 호출로 일어나고 그 출력이 이미
   * 이 스트림에 있다 — `[branch abc1234]` 줄에서 해시를 줍고, 출력이 잘렸으면 방금의
   * HEAD가 그 커밋이다. 저장소에는 아무것도 쓰지 않는다 (결정 2026-08-23).
   */
  private observeCommit(e: Extract<NormalizedEvent, { type: 'tool_call' | 'tool_result' }>, m: SessionInfo): void {
    if (e.type === 'tool_call') {
      if (looksLikeGitCommit(e.summary.title)) this.pendingCommits.set(e.callId, m.id)
      return
    }
    const sid = this.pendingCommits.get(e.callId)
    if (!sid) return
    this.pendingCommits.delete(e.callId)
    const projectId = m.projectId
    if (!e.ok || !projectId) return
    const sha = parseCommitSha(e.summary)
    if (sha) {
      this.store.recordCommit(projectId, sha, sid)
      return
    }
    void gitHeadSha(this.cwdOf(projectId))
      .then((head) => head && this.store.recordCommit(projectId, head, sid))
      .catch(() => {})
  }

  /**
   * 말을 건다.
   *
   * 프로세스가 없으면 **되살리고 나서 보낸다.** 예전에는 "이 세션은 실행 중이 아닙니다"로
   * 되돌려보냈는데, 그건 기계 사정을 사람에게 떠넘기는 것이다 — 사람은 이어서 말하고
   * 싶을 뿐이고, 이어갈 수단(external_id)은 우리가 갖고 있다.
   */
  async send(
    sessionId: string,
    text: string,
    attachments?: Attachment[],
    /*
     * 누가 보냈나 (FR-11). 사람이 보낸 건 비어 있다 — 그게 기본값이라 마이그레이션이
     * 필요 없다. 오케스트레이터의 send_to_session과 보고 회신(reportBack)만 채운다.
     * 화면이 이걸로 "사람이 한 말"과 "다른 세션이 시킨 말"을 갈라 그린다.
     */
    from?: { sessionId: string; name: string },
  ): Promise<void> {
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
    // 사람의 말은 언제나 메시지의 경계다 — 인터럽트 후 이어 말하면 그 앞까지가 한 덩어리 (#66)
    this.closeStream(sessionId)
    const seq = this.store.nextSeq(sessionId)
    this.store.appendMessages([
      {
        sessionId,
        seq,
        role: 'user',
        kind: 'text',
        // 첨부도 말의 일부다 — 경로만 남기고(D-1), 이미지 바이트는 loadMessages가 다시 싣는다
        payload: { text, ...(from ? { from } : {}), ...(attachments?.length ? { attachments } : {}) },
        ts: Date.now(),
      },
    ])
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
    this.emit({ type: 'user_message', sessionId, seq, text, ...(from ? { from } : {}) })
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
      this.closeStream(sessionId) // 진행 중이던 메시지는 여기까지가 전부다 — 남기고 색인한다 (#66)
      await old.dispose().catch(() => {})
      this.handles.delete(sessionId)
      this.running.delete(sessionId)
    }

    m.tool = tool
    // 새 도구는 옛 대화를 모른다. 실마리를 들고 가면 엉뚱한 대화를 잡는다
    m.externalId = null
    m.importedFrom = null
    /*
     * **모델과 그 딸린 설정도 함께 놓는다.**
     *
     * 실측(smoke-switch-tool): claude에서 sonnet을 고른 세션을 codex로 바꾸면
     * 프로세스는 뜨는데 첫 턴이 400으로 죽는다 —
     *   "The 'sonnet' model is not supported when using Codex with a ChatGPT account."
     * 모델을 비우고 같은 일을 하면 정상이다. 즉 이 기능이 안 되는 것이 아니라,
     * 도구에만 의미가 있는 값을 도구를 건너 들고 갔던 것이다.
     *
     * 모델 id는 도구의 어휘다 — 'sonnet'과 'gpt-5.6-terra'는 같은 자리를 가리키는
     * 두 이름이 아니라 서로의 사전에 없는 낱말이다. effort도 범위가 다르고
     * (claude는 max까지, codex는 high까지), verbosity·serviceTier는 아예 codex 전용이다.
     * 그러니 옮길 수 있는 값이 아니라 **새로 고를 값**이고, null은 "그 도구의 기본"이다.
     *
     * 권한 프리셋은 남긴다: safe/normal/auto는 도구가 아니라 사람이 정한 방침이고,
     * 두 어댑터가 같은 뜻으로 구현한다.
     */
    m.model = null
    m.effort = null
    m.verbosity = null
    m.serviceTier = null
    /*
     * 여기까지가 옛 도구의 대화다 — 경계를 적어 둔다 (doResumeSession의 가드가 읽는다).
     * 이걸 안 남기면 "이어갈 id가 없는데 기록은 있다"가 사고로 보여서, 방금 바꾼
     * 세션이 다음 기동에서 "resume id를 잃었다"며 안 깨어난다.
     */
    // 경계는 **저장소의 마지막 seq**로 적는다. 메모리의 lastSeq는 뒤처질 수 있고
     // (이벤트로 들어온 줄이 meta를 거치지 않는 길이 있다), 한 줄만 어긋나도
     // 가드가 "잃어버렸다"로 읽어서 방금 바꾼 세션이 안 깨어난다
    this.store.setAppSetting(freshStartKey(m.id), String(this.store.loadMessages(m.id, 1)[0]?.seq ?? 0))
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
  /**
   * 핸들을 내려놓는 순간, "여기까지는 전부 내가 아는 내용"이라고 적는다.
   *
   * 스킵 표식(externalSyncedKey)은 따라잡기가 읽을 때만 갱신됐다. 그런데 앱 안에서
   * 대화하면 도구의 updatedAt이 올라가므로, **매일 쓰는 세션일수록** 다음 깨우기가
   * "밖에서 바뀌었나?"에 걸려 전문을 다시 읽었다 — 읽어 봐야 전부 우리가 한 말인데.
   * 스킵이 정작 제일 흔한 경우(아침 첫 깨우기)에 안 걸리는 셈이었다.
   *
   * writer lock이 있는 도구(capabilities.exclusiveWriter — codex)는 우리가 핸들을
   * 쥔 동안 밖에서 못 쓴다. 그러니 내려놓는 시각을 찍으면: 그보다 오래된 변화는
   * 전부 우리 것(스킵), 그 뒤의 변화는 진짜 밖의 것(읽음). 크래시로 여기를 못
   * 지나면 표식이 낡은 채 남고, 낡은 표식은 읽는 쪽으로 떨어진다 — 안전한 방향이다.
   *
   * 잠금이 없는 도구(claude)에는 찍지 않는다: 살아 있는 동안 밖에서 쓴 말이
   * 영영 안 들어오게 된다. 도구 이름이 아니라 능력 선언으로 가른다.
   */
  private stampExternalSynced(sessionId: string): void {
    const m = this.meta.get(sessionId)
    if (!m || !(m.externalId ?? m.importedFrom)) return
    if (!this.adapters.get(m.tool)?.capabilities.exclusiveWriter) return
    this.store.setAppSetting(externalSyncedKey(sessionId), String(Date.now()))
  }

  private async externalGone(m: SessionInfo, cwd: string): Promise<boolean> {
    const id = m.externalId ?? m.importedFrom
    if (!id) return false
    const ids = await this.externalIndexOf(m.tool, cwd)
    if (!ids) return false // 확인 못 했으면 막지 않는다
    // 이어받은 원본이 살아 있으면 그것도 인정한다 (resume이 새 id를 발급했을 수 있다)
    return !ids.has(id) && !(m.importedFrom && ids.has(m.importedFrom))
  }

  /**
   * 도구가 보관 중인 대화 목록 → `외부 id → 마지막으로 바뀐 시각`.
   *
   * 깨우는 길에서 두 번 필요하다 (아직 있나? / 밖에서 바뀌었나?). 한 번만 묻고
   * 30초 들고 있는다 — codex는 이 한 줄에도 app-server를 띄운다 (실측 0.27초).
   * 목록을 못 받았으면 `null`이다: **모르는 것과 없는 것을 섞지 않는다.**
   * 부르는 쪽 둘 다 모를 때는 아무것도 막지 않는 쪽으로 간다.
   */
  private async externalIndexOf(tool: ToolName, cwd: string): Promise<Map<string, number> | null> {
    const adapter = this.adapters.get(tool)
    if (!adapter?.listExternalSessions) return null

    const key = `${tool}:${cwd}`
    const cached = this.externalIndex.get(key)
    if (cached && Date.now() - cached.at < 30_000) return cached.ids
    try {
      const rows = await adapter.listExternalSessions(cwd, 200)
      const ids = new Map(rows.map((r) => [r.externalId, r.updatedAt]))
      this.externalIndex.set(key, { ids, at: Date.now() })
      return ids
    } catch {
      return null
    }
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

  /**
   * 새 워크트리의 작업대를 차린다 (#69): gitignored 파일 복사 → 셋업 커맨드.
   *
   * 새 워크트리는 추적 파일만 있는 빈 작업대다 — node_modules도 .env도 없어서,
   * 세션의 첫 턴이 일이 아니라 "command not found"로 시작한다. .env류는 에이전트가
   * 복구할 수도 없다 (내용이 git에 없다). 이 카테고리 전체의 최다 반복 불만이다.
   *
   * **실패해도 세션 생성은 계속한다.** 반쯤 차려진 작업대는 에이전트가 마저 차릴 수
   * 있지만, 셋업이 죽었다고 세션까지 안 만들면 사람은 이유도 모른 채 아무것도 못 얻는다.
   * 실패는 stderr(→host.log)에 남긴다.
   *
   * **상한 90초.** pnpm install이 이 레포에서 6.5초(실측)지만, 콜드 스토어나 무거운
   * 프로젝트는 더 걸린다. RPC 30초보다 길어서 생성 응답이 늦어질 수 있는데, 그건
   * 셋업이 도는 동안 세션을 미리 여는 것보다 낫다 — 첫 턴이 설치와 경합하면
   * 이 기능의 존재 이유가 사라진다.
   */
  private async provisionWorktree(projectCwd: string, worktree: Worktree, projectId: string): Promise<void> {
    const setup = this.store.worktreeSetup(projectId)
    if (!setup) return

    for (const f of setup.copyFiles) {
      const src = resolve(projectCwd, f)
      // 경로 이탈 차단 — 목록은 프로젝트 안의 상대 경로만 뜻한다 (fs 포트와 같은 규칙)
      if (!src.startsWith(resolve(projectCwd) + '/')) {
        console.error(`[worktree] copy refused (outside project): ${f}`)
        continue
      }
      if (!existsSync(src)) {
        // 없는 파일은 건너뛰되 흔적을 남긴다 — .env가 안 왔는데 조용하면 한참 뒤에 발견된다
        console.error(`[worktree] copy skipped (missing): ${f}`)
        continue
      }
      const dst = join(worktree.path, f)
      mkdirSync(dirname(dst), { recursive: true })
      // clone 우선 (#76) — 8.5GB target이 4초·10MB로 건너온다 (실측). 안 되면 일반 복사
      await copyTree(src, dst)
    }

    if (!setup.command) return
    /*
     * 결정론적 변수 두 개 — 앱이 자원 배정에 대해 아는 전부다 (#69 자원 결정).
     * 순번은 이 프로젝트의 기존 워크트리 세션 수 + 1. 삭제 후 재사용될 수 있지만
     * 충돌의 결과는 재앙이 아니라 에러 메시지고, 그건 에이전트가 읽고 고치는 종류다.
     */
    const index = [...this.meta.values()].filter((s) => s.projectId === projectId && s.worktree).length + 1
    await new Promise<void>((done) => {
      exec(
        setup.command,
        {
          cwd: worktree.path,
          timeout: 90_000,
          env: {
            ...process.env,
            CENTRALU_WORKTREE: worktree.branch,
            CENTRALU_WORKTREE_INDEX: String(index),
          },
        },
        (err, _stdout, stderr) => {
          if (err) {
            console.error(
              `[worktree] setup failed (${worktree.branch}): ${err.message}\n${String(stderr).slice(0, 2000)}`,
            )
          } else {
            console.error(`[worktree] setup ok (${worktree.branch}): ${setup.command}`)
          }
          done() // 실패해도 계속 — 위 주석의 이유
        },
      )
    })
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

  /**
   * 죽은-에이전트 인수인계 기록 (#78) — **그 세션의 도구를 부르지 않고** 만든다.
   *
   * 이 메서드가 불리는 순간은 그 도구가 응답 불능일 때다: 재료는 우리 저장소의
   * 원문 전부와, (codex라면) 롤아웃 파일의 마지막 컴팩트 요약뿐이다. 어느 쪽의
   * 실패도 기록 생성을 막지 않는다 — 요약이 없으면 빌더가 원문 압축으로 물러난다.
   */
  async exportHandoffRecord(sessionId: string): Promise<{ text: string }> {
    const m = this.meta.get(sessionId)
    if (!m) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'session_not_found' })
    const rows = this.store.loadMessages(sessionId, 1_000_000)
    // 피벗 = 마지막 **성공한** 컴팩트 마커 — 실패한 컴팩트는 아무것도 접지 않았다
    let pivotSeq: number | null = null
    for (const r of rows) {
      const p = r.payload as { type?: string; failed?: boolean }
      if (r.kind === 'marker' && p.type === 'compaction' && !p.failed) pivotSeq = r.seq
    }
    const externalId = m.externalId ?? m.importedFrom
    const summary = externalId
      ? ((await this.adapters.get(m.tool)?.lastCompactSummary?.(externalId).catch(() => null)) ?? null)
      : null
    return { text: buildHandoffRecord({ name: m.name, tool: m.tool, summary, rows, pivotSeq }) }
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
  async gitLog(projectId: string, limit?: number) {
    const commits = await gitLog(this.cwdOf(projectId), limit)
    // 어느 세션이 만든 커밋인지 단다 (#50) — 기록이 없으면 그대로 지나간다
    return attachCommitSessions(commits, this.store.commitSessions(projectId), (sid) => this.meta.get(sid)?.name)
  }
  gitCommitDetail(projectId: string, sha: string) {
    return gitCommitDetail(this.cwdOf(projectId), sha)
  }
  gitBranches(projectId: string) {
    return gitBranches(this.cwdOf(projectId))
  }
  /** 새 워크트리에 없을 것들 (#76) — 복사 후보를 짚어 주는 데 쓴다 */
  gitIgnoredEntries(projectId: string) {
    return gitIgnoredEntries(this.cwdOf(projectId))
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
   * 에이전트만 재시작한다 (FR-10 확장).
   * 도구가 먹통이 됐을 때 세션을 새로 만들면 대화가 끊긴다 — 프로세스만 갈아 끼운다.
   */
  async restartSession(sessionId: string): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }> {
    const h = this.handles.get(sessionId)
    if (h) {
      this.closeStream(sessionId) // 죽는 프로세스의 마지막 말을 남긴다 (#66)
      await h.dispose().catch(() => {})
      // dispose가 **끝난 뒤에** 찍는다 — 내려가는 프로세스의 마지막 flush까지 표식 안쪽에 들어오게
      this.stampExternalSynced(sessionId)
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
  private orchestratorToolsFor(orchestratorId: string, childrenOf?: string): OrchestratorTools {
    const projects = () => new Map(this.store.listProjects().map((p) => [p.id, p.name]))
    /**
     * 시야는 두 가지뿐이다. **중앙 오케스트레이터**는 전부 보고, **워크트리 매니저**(#69)는
     * 자기 자식만 본다. 자식 집합은 호출 시점에 판정한다 — 스폰 이후 생긴 자식도 보여야 하기
     * 때문이다.
     *
     * 가운데 단계였던 프로젝트 오케스트레이터(#13)는 폐기했다: 프로젝트마다 세션을 지휘하는
     * 자리가 매니저와 둘이 되면서, 만든 사람조차 둘을 헷갈렸다 (도그푸딩). 개념이 하나 많았다.
     */
    const inScope = (s: SessionInfo) => (childrenOf !== undefined ? s.parentSessionId === childrenOf : true)
    const scopeError = (id: string) =>
      childrenOf !== undefined
        ? `이 매니저의 워크트리 세션이 아닙니다: ${id}`
        : `이 앱이 관리하는 세션이 아닙니다: ${id}`

    return {
      listSessions: async () => {
        const byId = projects()
        return [...this.meta.values()]
          // 자기 자신은 뺀다 — 자기에게 시키는 것은 고리를 만든다
          .filter((s) => s.id !== orchestratorId && inScope(s))
          .map((s) => ({
            sessionId: s.id,
            name: this.labelOf(s),
            project: s.projectId ? (byId.get(s.projectId) ?? '(사라진 프로젝트)') : '(없음)',
            state: s.state,
            ...(s.worktreeMerged ? { merged: true } : {}),
            // PR 상태(#76 stage 3) — 매니저가 "리뷰 대기 중"과 "그냥 진행 중"을 가르는 근거
            ...(s.worktreePr ? { pr: { number: s.worktreePr.number, state: s.worktreePr.state } } : {}),
            tool: s.tool,
            preview: this.previewOf(s.id),
            lastActive: this.lastActiveOf(s.id),
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
            serviceTier: info.serviceTier,
          })
          return { ok: true }
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
      },

      createSession: async (opts) => {
        const all = this.store.listProjects()
        const project = all.find((p) => p.id === opts.project || p.name === opts.project)
        if (!project) {
          return {
            ok: false,
            error: opts.project ? `그런 프로젝트가 없습니다: ${opts.project}` : 'project를 지정하세요 (이름 또는 id)',
          }
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
         * `around`가 있으면 그 언저리를 읽는다 — recall이 준 seq를 그대로 넘기면 된다.
         * 이게 없어서 "찾았는데 갈 수가 없는" 상태였다: recall은 세션 id만 주고,
         * read_session은 맨 끝만 읽어서, 결국 세션을 통째로 퍼올려 눈으로 찾아야 했다.
         *
         * 읽는 개수는 메시지 단위다 (#66) — 행이 델타였던 시절의 ×8 보정은
         * 병합된 행에 그대로 쓰면 수백 메시지를 퍼올리는 일이 된다.
         */
        const around = opts?.around
        const rows = around
          ? [
              ...this.store.loadMessages(sessionId, limit, around + 1),
              ...this.store.loadMessagesFrom(sessionId, around, limit),
            ]
          : this.store.loadMessages(sessionId, limit * 2)

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

        try {
          // 출처를 달아 보낸다 (FR-11) — 대상 세션 화면에서 사람 말과 구분돼 보인다
          const orch = this.meta.get(orchestratorId)
          await this.send(sessionId, text, undefined, {
            sessionId: orchestratorId,
            name: orch?.name ?? 'Orchestrator',
          })
          // 부탁받았을 때만 되돌아온다 — 기본은 조용하다
          if (reportBack) this.awaitingReport.set(sessionId, orchestratorId)
          return { ok: true }
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
      },

      /*
       * 유일한 파괴 권한 (#76 하드 게이트) — propose가 아니라 power인 이유는 게이트다:
       * **증명 가능하게 무손실일 때만** 실행된다. 커밋 안 된 변경이 없고, 지금 이 순간의
       * 브랜치 끝이 줄기에 들어갔음이 측정되면, 지워서 잃는 git 내용물이 없다.
       * 그 증명 밖의 모든 삭제는 여전히 사람의 일이다(사이드바 삭제 대화).
       *
       * 판정은 캐시(worktreeMerged 배지)가 아니라 **삭제 순간의 측정**이다 — 배지가
       * 켜진 뒤에 새 커밋이 얹혔을 수 있다(TOCTOU). 크리티컬한 삭제라(사용자 지시)
       * 보수적으로 기운다: 도구 쪽 대화 원본은 남기고(마지막 복구 경로), 브랜치를
       * 지우기 전 팁 sha를 로그로 남긴다(reflog 복구의 표지판).
       */
      deleteWorktreeSession: async (sessionId) => {
        if (sessionId === orchestratorId) return { ok: false, error: '자기 자신은 지울 수 없습니다' }
        const target = this.meta.get(sessionId)
        if (!target || !inScope(target)) return { ok: false, error: scopeError(sessionId) }
        if (!target.worktree?.base || !target.projectId) {
          return { ok: false, error: '워크트리 브랜치 세션이 아닙니다 — 이 도구는 병합이 끝난 브랜치만 정리합니다' }
        }
        if (target.state === 'working' || target.state === 'waiting_approval') {
          return { ok: false, error: `아직 일하고 있습니다: ${target.name} — 턴이 끝난 뒤에 정리하세요` }
        }
        const cwd = this.cwdOf(target.projectId)
        const { branch, path, base } = target.worktree

        // 게이트 1: 커밋 안 된 변경 — 어느 커밋에도 없는 내용은 지우면 그냥 사라진다.
        // 측정 실패도 더러움으로 친다: 모르는 것은 안전한 쪽이 아니다.
        const wt = await gitWorktreeDirty(path).catch(() => ({ dirty: true, changedFiles: -1 }))
        if (wt.dirty) {
          const n = wt.changedFiles >= 0 ? `${wt.changedFiles}개 ` : ''
          return { ok: false, error: `커밋 안 된 변경이 ${n}있습니다 — 그 세션에 커밋(또는 폐기)을 시킨 뒤 다시 부르세요` }
        }

        // 게이트 2: **지금의** 브랜치 끝이 줄기에 들어갔는가
        const trunk = this.trunkOf(target.projectId) ?? 'HEAD'
        let proof: string | null = null
        if (await gitBranchMerged(cwd, branch, base, trunk).catch(() => false)) {
          proof = 'trunk ancestry'
        } else if (this.ghAvailable) {
          const pr = await this.prLookup(cwd, branch).catch(() => null)
          if (pr === 'unavailable') this.ghAvailable = false
          else if (pr && pr.state === 'merged') {
            const tip = await gitRevParse(cwd, `refs/heads/${branch}`)
            if (pr.headOid && tip && tip === pr.headOid) proof = `PR #${pr.number}`
            else if (pr.headOid && tip) {
              return {
                ok: false,
                error: `PR #${pr.number}는 병합됐지만 그 뒤에 새 커밋이 있습니다 — 새 커밋까지 줄기에 들어간 뒤에만 지웁니다`,
              }
            }
          }
        }
        if (!proof) {
          return {
            ok: false,
            error: `"${branch}"가 줄기에 들어갔음을 증명하지 못했습니다 — 병합(또는 PR 병합)이 확인된 뒤에만 지웁니다. 증명 없이 버리는 것은 사람이 삭제 대화에서 합니다`,
          }
        }

        const tip = await gitRevParse(cwd, `refs/heads/${branch}`)
        // 도구 쪽 대화 원본은 남긴다(deleteExternal=false) — 이 삭제의 마지막 복구 경로다
        await this.deleteSession(sessionId, true, false)
        // 실패해도 되돌리지 않는다: 남은 브랜치 ref는 배지 하나의 비용이지 손실이 아니다
        await gitBranchDelete(cwd, branch).catch(() => {})
        console.error(`[worktree] manager cleaned up ${branch} (tip ${tip?.slice(0, 8) ?? '?'}, proof: ${proof})`)
        return { ok: true }
      },

      /*
       * 제안만 한다 (propose-not-power). 설치·재시작은 사람의 승인 클릭이
       * resolveMcpProposal을 통해 시킨다 — MCP 등록은 임의 명령 실행의 등록이라,
       * 여기서 바로 설치하면 read_session으로 들어온 주입 한 줄이 프로세스가 된다.
       */
      proposeMcpServer: async (spec) => {
        if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(spec.name)) {
          return { ok: false, error: '이름은 영숫자·하이픈·밑줄 32자 이내여야 합니다' }
        }
        const installed = this.mcpServers().some((s) => s.name === spec.name)
        if (installed) return { ok: false, error: `"${spec.name}"은 이미 설치되어 있습니다` }
        const proposals = this.mcpProposals().filter((p) => p.name !== spec.name)
        proposals.push({ name: spec.name, command: spec.command, args: spec.args, why: spec.why })
        this.store.setAppSetting(MCP_PROPOSALS_KEY, JSON.stringify(proposals))
        return { ok: true }
      },

      // 스킬 제안 (#71) — MCP 제안과 같은 규칙: 제안은 저장만, 영향력은 승인 뒤에
      proposeSkill: async (spec) => {
        if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(spec.name)) {
          return { ok: false, error: '이름은 영숫자·하이픈·밑줄 32자 이내여야 합니다' }
        }
        if (!spec.content.trim()) return { ok: false, error: '내용이 비어 있습니다' }
        if (spec.content.length > SKILL_MAX_CHARS) {
          return { ok: false, error: `내용이 너무 깁니다 (${spec.content.length}자 > ${SKILL_MAX_CHARS}자) — 절차의 핵심만 남기세요` }
        }
        if (this.orchestratorSkills().some((s) => s.name === spec.name)) {
          return { ok: false, error: `"${spec.name}" 스킬은 이미 있습니다 — 고치려면 사람이 먼저 지워야 합니다` }
        }
        if (this.orchestratorSkills().length >= SKILL_MAX_COUNT) {
          return { ok: false, error: `스킬이 이미 ${SKILL_MAX_COUNT}개입니다 — 시스템 프롬프트 예산이 다 찼으니, 덜 쓰는 것을 지우자고 사람에게 제안하세요` }
        }
        const proposals = this.skillProposals().filter((p) => p.name !== spec.name)
        proposals.push({ name: spec.name, content: spec.content, why: spec.why })
        this.store.setAppSetting(SKILL_PROPOSALS_KEY, JSON.stringify(proposals))
        return { ok: true }
      },
    }
  }

  /** 사람의 승인을 기다리는 MCP 서버 제안들 */
  mcpProposals(): { name: string; command: string; args: string[]; why?: string }[] {
    try {
      const raw = this.store.appSetting(MCP_PROPOSALS_KEY)
      return raw ? (JSON.parse(raw) as ReturnType<SessionManager['mcpProposals']>) : []
    } catch {
      return []
    }
  }

  /** 승인되어 오케스트레이터에 붙는 MCP 서버들 */
  mcpServers(): { name: string; command: string; args: string[] }[] {
    try {
      const raw = this.store.appSetting(MCP_SERVERS_KEY)
      return raw ? (JSON.parse(raw) as ReturnType<SessionManager['mcpServers']>) : []
    } catch {
      return []
    }
  }

  /** 사람의 승인을 기다리는 스킬 제안들 (#71) */
  skillProposals(): { name: string; content: string; why?: string }[] {
    try {
      const raw = this.store.appSetting(SKILL_PROPOSALS_KEY)
      return raw ? (JSON.parse(raw) as ReturnType<SessionManager['skillProposals']>) : []
    } catch {
      return []
    }
  }

  /** 승인되어 오케스트레이터의 역할 프롬프트에 실리는 스킬들 (#71) */
  orchestratorSkills(): { name: string; content: string }[] {
    try {
      const raw = this.store.appSetting(SKILLS_KEY)
      return raw ? (JSON.parse(raw) as ReturnType<SessionManager['orchestratorSkills']>) : []
    } catch {
      return []
    }
  }

  /**
   * 승인된 스킬을 역할 프롬프트에 덧붙일 블록으로 (#71). 도구 불문 텍스트다 —
   * claude는 systemPrompt append로, codex는 developerInstructions로 같은 글이 간다
   * (한 저작 형식, N개 어댑터 — NormalizedEvent가 이벤트에 긋는 경계와 같은 자리).
   */
  private skillsPrompt(): string {
    const skills = this.orchestratorSkills()
    if (skills.length === 0) return ''
    return (
      '\n\n## 승인된 스킬 (사람이 승인한 작업 절차 — 해당 상황에서 따른다)\n' +
      skills.map((s) => `### ${s.name}\n${s.content}`).join('\n\n')
    )
  }

  /** 스킬 제안에 대한 사람의 답 (#71) — 승인이면 저장하고 오케스트레이터를 재시작한다 */
  async resolveSkillProposal(name: string, approve: boolean): Promise<{ ok: boolean; error?: string }> {
    const proposals = this.skillProposals()
    const hit = proposals.find((p) => p.name === name)
    if (!hit) return { ok: false, error: `No pending skill proposal named "${name}"` }
    this.store.setAppSetting(SKILL_PROPOSALS_KEY, JSON.stringify(proposals.filter((p) => p.name !== name)))
    if (!approve) return { ok: true }

    const skills = this.orchestratorSkills().filter((s) => s.name !== name)
    skills.push({ name: hit.name, content: hit.content })
    this.store.setAppSetting(SKILLS_KEY, JSON.stringify(skills))
    await this.restartOrchestrator()
    return { ok: true }
  }

  /** 스킬 삭제 (#71 미결 질문의 답: 넣을 수만 있고 못 지우는 스킬은 없느니만 못하다) */
  async deleteOrchestratorSkill(name: string): Promise<{ ok: boolean; error?: string }> {
    const skills = this.orchestratorSkills()
    if (!skills.some((s) => s.name === name)) return { ok: false, error: `No skill named "${name}"` }
    this.store.setAppSetting(SKILLS_KEY, JSON.stringify(skills.filter((s) => s.name !== name)))
    // 지운 스킬이 프롬프트에 남아 있으면 삭제가 거짓말이 된다 — 바로 갈아 끼운다
    await this.restartOrchestrator()
    return { ok: true }
  }

  /** 오케스트레이터가 살아 있으면 갈아 끼운다 — 스킬·MCP 변경을 즉시 반영하는 공통 경로 */
  private async restartOrchestrator(): Promise<void> {
    const orch = [...this.meta.values()].find((m) => m.kind === 'orchestrator')
    if (orch) await this.restartSession(orch.id).catch(() => {})
  }

  /**
   * 제안에 대한 사람의 답 (도그푸딩 요청 b안 — 제안 → 원클릭 승인 → 앱이 설치+재시작).
   * 승인이면 서버 목록에 올리고 **오케스트레이터를 재시작한다** — 재시작은 resume이라
   * 대화는 이어지고, 다음 기동의 어댑터 설정에 서버가 실려 도구가 바로 보인다.
   */
  async resolveMcpProposal(name: string, approve: boolean): Promise<{ ok: boolean; error?: string }> {
    const proposals = this.mcpProposals()
    const hit = proposals.find((p) => p.name === name)
    if (!hit) return { ok: false, error: `No pending proposal named "${name}"` }
    this.store.setAppSetting(MCP_PROPOSALS_KEY, JSON.stringify(proposals.filter((p) => p.name !== name)))
    if (!approve) return { ok: true }

    const servers = this.mcpServers().filter((s) => s.name !== name)
    servers.push({ name: hit.name, command: hit.command, args: hit.args })
    this.store.setAppSetting(MCP_SERVERS_KEY, JSON.stringify(servers))

    // 도는 중이어도 갈아 끼운다 — 승인한 사람이 기다리는 것은 "이제 쓸 수 있음"이다
    await this.restartOrchestrator()
    return { ok: true }
  }

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
    // 메시지 단위라 100이면 충분하다 (#66) — 400 메시지는 델타 시절의 보정이었다
    const rows = this.store.loadMessages(s.id, 100)
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
   * 예산은 개수가 아니라 **글자**다 (#66). 행이 델타였을 때는 행 120개가 한두
   * 문장이라 넉넉했지만, 행이 메시지가 되면 같은 개수가 수십만 자일 수 있다 —
   * recall 한 번이 오케스트레이터의 문맥을 다 태운다. 그래서 목표 지점에서 가까운
   * 메시지부터 번갈아(앞·뒤) 담고, 메시지당 상한과 총예산에서 멈춘다.
   */
  private contextAt(sessionId: string, seq: number): string {
    // seq+1: 목표 행 자신을 포함해 앞쪽으로, 그리고 그 뒤쪽으로
    const before = this.store.loadMessages(sessionId, CONTEXT_SPAN_MSGS, seq + 1)
    const after = this.store.loadMessagesFrom(sessionId, seq, CONTEXT_SPAN_MSGS)
    const nearFirst: StoredMessage[] = []
    const b = [...before].reverse()
    for (let i = 0; i < Math.max(b.length, after.length); i++) {
      if (b[i]) nearFirst.push(b[i]!)
      if (after[i]) nearFirst.push(after[i]!)
    }
    let budget = CONTEXT_CHARS
    const chosen: StoredMessage[] = []
    for (const r of nearFirst) {
      if (r.kind !== 'text') continue
      const t = ((r.payload as { text?: string }).text ?? '').slice(0, CONTEXT_MSG_CHARS)
      if (!t) continue
      if (budget < t.length) break
      budget -= t.length
      chosen.push(r)
    }
    chosen.sort((x, y) => x.seq - y.seq)
    const parts: string[] = []
    for (const r of chosen) {
      const t = ((r.payload as { text?: string }).text ?? '').slice(0, CONTEXT_MSG_CHARS)
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
    // 읽기는 병합된 메시지 단위다 (#66) — 마지막 응답을 찾는 데 수백 행이 필요 없다
    const rows = this.store.loadMessages(sessionId, 30)
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
    const profile = this.toolProfileOf(sessionId)
    if (!m || !profile) {
      throw Object.assign(new Error('오케스트레이터만 쓸 수 있는 도구입니다'), { code: 'internal' })
    }
    /*
     * 노출만 좁히면 이름을 아는 쪽이 그냥 부른다 (#69) — 다리는 별도 프로세스라
     * 토큰만 있으면 무엇이든 물을 수 있다. 실행 쪽에서도 같은 판정을 한다.
     */
    if (!profileAllows(profile, name)) {
      throw Object.assign(new Error(`이 세션의 도구가 아닙니다: ${name}`), { code: 'internal' })
    }
    const tools =
      profile === 'manager' ? this.orchestratorToolsFor(sessionId, sessionId) : this.orchestratorToolsFor(sessionId)
    return runOrchestratorTool(tools, name, args)
  }

  /**
   * 이 세션이 받는 도구 묶음 (#69). null이면 도구 없음.
   * 매니저 판정은 관계 하나다: 워크트리 자식이 있으면 매니저다 (아카이브된 자식 포함 —
   * 도구는 위험하지 않고, 입양으로 선 매니저가 자식을 정리한 뒤에도 제안은 할 수 있어야 한다).
   */
  toolProfileOf(sessionId: string): ToolProfile | null {
    const m = this.meta.get(sessionId)
    if (!m) return null
    if (m.kind === 'orchestrator') return 'orchestrator'
    return this.isWorktreeManager(sessionId) ? 'manager' : null
  }

  /**
   * 매니저인가 — 두 가지 중 하나면 그렇다.
   *
   *   1. 워크트리 자식이 있다 (아카이브된 자식 포함 — 도구는 위험하지 않고, 자식을
   *      정리한 뒤에도 제안은 할 수 있어야 한다). #69부터의 원래 규칙.
   *   2. 프로젝트가 이 세션을 자기 매니저로 가리킨다 (#76). 자식이 생기기 전의 자리다.
   *
   * 둘 다 링크다 — 세션에 플래그를 다는 대신 관계로 판정한다는 원칙은 그대로다.
   * 자식 없는 매니저도 도구는 다 받지만 **볼 것이 없다**: 시야가 childrenOf라
   * list_sessions는 비어 있고 read/send는 거절된다. 그래서 남는 일은 제안 하나다.
   */
  private isWorktreeManager(sessionId: string): boolean {
    if ([...this.meta.values()].some((s) => s.parentSessionId === sessionId)) return true
    const projectId = this.meta.get(sessionId)?.projectId
    return !!projectId && this.store.worktreeManager(projectId)?.sessionId === sessionId
  }

  /** 이 프로젝트의 줄기 브랜치 (#76). 매니저가 없거나 안 정했으면 null — 그때는 HEAD가 기준이다 */
  private trunkOf(projectId: string): string | null {
    return this.store.worktreeManager(projectId)?.baseBranch || null
  }

  /**
   * PR 상태 측정기 (#76 stage 3). 필드로 두는 이유: gh는 네트워크라 테스트가 실측할 수
   * 없다 — 시험은 이 자리를 갈아끼운다. prPollMs도 같은 이유로 필드다(시험은 0으로).
   */
  prLookup: (projectCwd: string, branch: string) => Promise<BranchPr | 'unavailable' | null> = gitBranchPr
  prPollMs = 120_000
  private prCheckedAt = new Map<string, number>()
  /** gh가 없는 기계에서 스윕마다 ENOENT를 다시 만나지 않기 위한 한 방향 스위치 */
  private ghAvailable = true

  /**
   * 이 프로젝트의 워크트리 브랜치들이 줄기에 들어갔는지 다시 판정한다 (#69).
   *
   * 부르는 곳은 둘이다: 기동(한 번), 그리고 프로젝트 git 새로고침(projects.gitStatus —
   * UI가 턴이 끝날 때마다 디바운스로 부르는 그 길). **우리 버튼에 의존하지 않는다**:
   * 터미널에서 병합하는 것이 정상 사용이고, 브랜치가 줄기에 들어갔는지는 git이 직접
   * 답할 수 있는 질문이다 (설계 결정). base가 없는 옛 세션은 건너뛴다 — 추측으로
   * 채우면 갓 만든 브랜치가 병합됨으로 읽힌다.
   *
   * false→true 한 방향만 흐른다: 병합은 되돌려지지 않고(revert는 새 커밋이다),
   * 한 방향이면 이벤트 폭풍도 없다.
   */
  async refreshMergedWorktrees(projectId: string): Promise<void> {
    const cwd = this.cwdOf(projectId)
    // 줄기가 정해져 있으면 그것을 기준으로 (#76). 없으면 HEAD — 매니저를 만들기 전에
    // 생긴 워크트리들이 그 경우고, 그때의 기준이 곧 그때의 뜻이다
    const trunk = this.trunkOf(projectId) ?? 'HEAD'
    for (const m of this.meta.values()) {
      if (m.projectId !== projectId || !m.worktree?.base || m.worktreeMerged) continue
      let merged = await gitBranchMerged(cwd, m.worktree.branch, m.worktree.base, trunk).catch(() => false)
      /*
       * 로컬이 못 보는 병합 (#76 stage 3): 스쿼시·리베이스 병합은 is-ancestor로 감지
       * 불가(실측, git.ts)인데, GitHub PR의 지배적 결말이 스쿼시다. PR의 MERGED는
       * 서버가 기록한 사실이라 그 사각지대가 없다 — gh가 있으면 물어서 메운다.
       *
       * 로컬이 이미 merged라면 안 묻는다(답이 안 바뀐다). 네트워크 호출이라 세션당
       * TTL을 두고(스윕은 턴이 끝날 때마다 도는 길이다), gh 자체가 없으면(ENOENT)
       * 이 프로세스에서는 다시 묻지 않는다 — 답이 변할 수 없는 질문이다.
       */
      if (!merged && this.ghAvailable) {
        const now = Date.now()
        if (now - (this.prCheckedAt.get(m.id) ?? 0) >= this.prPollMs) {
          this.prCheckedAt.set(m.id, now)
          const pr = await this.prLookup(cwd, m.worktree.branch).catch(() => null)
          if (pr === 'unavailable') {
            this.ghAvailable = false
            // 마지막 말을 남긴다 — 없으면 "왜 PR 칩이 안 뜨지"가 미스터리가 된다
            console.error('[worktree] gh not found — PR detection off for this run (local merge detection unaffected)')
          } else if (pr) {
            // headOid는 게이트(#76 하드 게이트)의 재료지 칩의 재료가 아니다 — 프로토콜 모양만 싣는다
            const chip = { number: pr.number, state: pr.state, url: pr.url }
            if (JSON.stringify(chip) !== JSON.stringify(m.worktreePr)) {
              this.meta.set(m.id, { ...this.meta.get(m.id)!, worktreePr: chip })
              this.emit({ type: 'worktree_pr', sessionId: m.id, pr: chip })
            }
          }
          if (pr && pr !== 'unavailable' && pr.state === 'merged') merged = true
        }
      }
      if (!merged) continue
      const next = { ...this.meta.get(m.id)!, worktreeMerged: true }
      this.meta.set(m.id, next)
      this.emit({ type: 'worktree_merged', sessionId: m.id })
      console.error(`[worktree] branch merged into trunk: ${m.worktree.branch} (${m.id.slice(0, 8)})`)
    }
  }

  /**
   * 새로 태어난 오케스트레이터에게 **지난 기억을 넘긴다**.
   *
   * 도구를 바꾸면 프로세스가 갈리고 그 도구의 문맥은 사라진다 — 화면에는 어제까지
   * 나눈 대화가 그대로 보이는데 정작 상대는 그걸 하나도 모르는 상태가 된다.
   * 워커 세션이라면 "새 대화를 시작했다"로 정직하지만, 오케스트레이터는 앱에 하나뿐인
   * **상주 상대**다. 기억을 잃는 것이 곧 관계가 끊기는 것이라 다르게 다뤄야 한다.
   *
   * 우리 저장소에는 그 대화가 남아 있으므로, 새 프로세스의 시스템 프롬프트에
   * 요약을 붙여 넘긴다. resume이 아니라 **인계**다 — 토씨까지 복원하지는 못하고,
   * 무슨 이야기를 하던 중이었는지를 넘긴다.
   *
   * **사람의 말과 자기 답만 넣는다.** 도구 결과(read_session·recall이 퍼온 다른
   * 세션의 본문)는 뺀다: 워커가 쓴 글이 시스템 프롬프트로 승격되는 길을 열면,
   * 낮은 권한에서 높은 권한으로 넘어가는 그 통로가 여기 다시 생긴다
   * (orchestrator-home.ts가 폴더 문서를 끈 것과 같은 이유).
   */
  private orchestratorMemory(sessionId: string): string {
    const rows = this.store.loadMessages(sessionId, MEMORY_MESSAGES)
    const lines: string[] = []
    for (const m of rows) {
      if (m.kind !== 'text') continue
      if (m.role !== 'user' && m.role !== 'assistant') continue
      const text = String((m.payload as { text?: unknown }).text ?? '').trim()
      if (!text) continue
      lines.push(`${m.role === 'user' ? '사람' : '나'}: ${text.slice(0, MEMORY_LINE_CHARS)}`)
    }
    if (lines.length === 0) return ''
    return [
      '',
      '# 지난 대화 (이 프로세스가 시작되기 전)',
      '이 앱의 기록에서 가져온 요약이다. 도구가 바뀌면서 문맥은 사라졌지만 대화는 이어진다 —',
      '처음 만난 것처럼 굴지 말고, 필요하면 recall로 더 찾아본다.',
      ...lines,
    ].join('\n')
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
  /**
   * 있으면 주고, 없으면 **만들지 않는다** (#63).
   *
   * 온보딩이 오케스트레이터 화면을 먼저 보여주면서 "화면을 연다 ≠ 프로세스를 만든다"가
   * 됐다. 화면은 이걸로 묻기만 하고, 만드는 것은 첫 질문이 던져지는 순간의
   * orchestrator()다 — 그 전에 만들면 묻지도 않은 사람 몫의 도구 프로세스가 뜬다.
   */
  orchestratorPeek(): SessionInfo | null {
    const known = this.store.orchestratorId()
    return known ? (this.meta.get(known) ?? null) : null
  }

  /**
   * 중앙 오케스트레이터가 돌 도구 (#63, 소개 화면의 카드 선택).
   *
   * **아직 세션이 없을 때를 위한 설정이다.** 선택과 생성 사이가 벌어졌기 때문에
   * (카드 클릭 → …언젠가… 첫 질문) 선택을 어딘가 적어둬야 하고, 이건 설치본의
   * 성질이므로 app_settings가 맞는 자리다. 이미 만들어진 뒤에는 세션 설정의
   * Agent 전환이 맡는다 — 이 값은 다시 읽히지 않는다.
   */
  configureOrchestrator(tool: 'claude' | 'codex'): void {
    this.store.setAppSetting('orchestrator_tool', tool)
  }

  async orchestrator(): Promise<SessionInfo> {
    const known = this.store.orchestratorId()
    if (known) {
      const m = this.meta.get(known)
      if (m) return m
      // id는 남았는데 세션이 사라진 경우 — 표식만 지우고 새로 만든다
    }

    /*
     * 도구는 소개 화면의 선택(configureOrchestrator)을 따른다 — 'claude' 하드코딩은
     * Codex만 설치한 사람이 소개 화면("Codex 준비됨")을 통과하고도 오케스트레이터를
     * 못 여는 모순을 만들었다 (#63). 코덱스 쪽 배선(stdio 다리)은 프로젝트
     * 오케스트레이터(#13)가 이미 실측으로 깔아 놓았다.
     */
    const configured = this.store.appSetting('orchestrator_tool')
    const info = await this.createSession({
      projectId: null,
      kind: 'orchestrator', // 표식은 세션과 함께 태어난다 — 따로 찍으면 그 사이가 무표식 상태다
      cwd: orchestratorHome(),
      tool: configured === 'codex' ? 'codex' : 'claude',
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

  async loadMessages(sessionId: string, limit: number, beforeSeq?: number): Promise<StoredMessage[]> {
    const rows = this.store.loadMessages(sessionId, limit, beforeSeq)
    /*
     * 이미지 행은 경로만 저장된다 (#40) — 화면에 줄 때 바이트를 다시 싣는다.
     * 파일이 없으면(500MB 상한 정리, 외부 삭제) 조용한 공백 대신 이유를 싣는다.
     */
    const { readFile } = await import('node:fs/promises')
    return Promise.all(
      rows.map(async (r) => {
        if (r.kind === 'image') {
          const p = r.payload as Extract<NormalizedEvent, { type: 'message_image' }>
          if (!p.path || p.note) return r
          try {
            const data = (await readFile(p.path)).toString('base64')
            return { ...r, payload: { ...p, data } }
          } catch {
            return { ...r, payload: { ...p, note: '이미지가 정리되어 더 이상 없습니다 (총량 상한)' } }
          }
        }
        // 사용자 첨부의 이미지도 같은 규칙 — 파일이 살아 있으면 바이트를 싣고,
        // 정리됐으면 조용히 경로만 남긴다 (화면은 이름 칩으로 눕는다)
        if (r.kind === 'text' && r.role === 'user') {
          const p = r.payload as { attachments?: Attachment[] }
          if (!p?.attachments?.some((a) => a.kind === 'image')) return r
          const attachments = await Promise.all(
            p.attachments.map(async (a) => {
              if (a.kind !== 'image') return a
              try {
                return { ...a, data: (await readFile(a.path)).toString('base64') }
              } catch {
                return a
              }
            }),
          )
          return { ...r, payload: { ...p, attachments } }
        }
        return r
      }),
    )
  }

  async disposeAll(): Promise<void> {
    this.watchers.close()
    // 진행 중이던 메시지들을 지금 모습대로 남긴다 — 종료가 마지막 2초를 삼키면 안 된다 (#66)
    for (const id of [...this.streams.keys()]) this.closeStream(id)
    // 하나가 실패해도 나머지는 정리한다 — 종료 길에 거절 하나가 전체 정리를 막으면 고아가 남는다
    await Promise.allSettled([...this.handles.values()].map((h) => h.dispose()))
    // dispose가 끝난 뒤에 찍는다 (stampExternalSynced 주석). 크래시에는 안 찍는다 —
    // 죽은 시각을 모르는데 지금 시각을 찍으면 죽음~발견 사이의 밖 기록을 삼킬 수 있다.
    for (const id of this.handles.keys()) this.stampExternalSynced(id)
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
  const label = TOOL_META[tool].label
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
