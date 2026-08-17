import { create } from 'zustand'
import type { Attachment, NormalizedEvent, PermissionPreset, ProjectInfo, SessionInfo, StoredMessage, ToolName } from '@cc/protocol'
import {
  allDoneNotification,
  applyEvent,
  archive as archiveSession,
  badgeCount,
  countWaiting,
  notificationFor,
  suggestMatcher,
  DEFAULT_NOTIFY_POLICY,
  type NotifyPolicy,
  bumpSeq,
  initialSession,
  markRead as markReadPure,
  rename as renamePure,
  type SessionSummary,
} from '@cc/core'
import type { ConnectionState, Platform } from '@cc/platform/ports'

/**
 * 스토어는 배선만 한다 — 상태 변경 로직은 전부 core (docs/state-management.md §2).
 * 명령은 포트로, 상태 갱신은 이벤트 → core 리듀서로만 (CQRS-lite: 낙관적 갱신 없음).
 */

/**
 * 대화를 덮는 넓은 표면. null이면 아무것도 덮여 있지 않다.
 *  - viewer: 파일 한 개 (viewerPath)
 *  - git: 변경·기록·브랜치 전체. path를 주면 그 파일의 diff부터 편다
 */
export type Overlay =
  | { kind: 'viewer' }
  | { kind: 'git'; path?: string | null; sha?: string | null; sub?: 'changes' | 'history' | 'branches' }
  | null

/** 증거 패널이 보여주는 것 */
export type PanelTab = 'files' | 'git' | 'terminal'

/** 증거 패널 폭의 한계. 좁으면 경로가, 넓으면 대화가 죽는다 */
export const PANEL_MIN = 260
export const PANEL_MAX = 900
export const PANEL_DEFAULT = 340

/** 세션 목록(관찰 레인) 폭 */
/** 깃 탭에서 '기록'이 차지할 높이. 나머지는 '변경'이 가져간다 */
export const TREE_MIN = 80
export const TREE_MAX = 900
export const TREE_DEFAULT = 200

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 480
export const SIDEBAR_DEFAULT = 240

/**
 * 대화 레인이 최소한 지켜야 할 폭.
 *
 * 이게 없으면 양쪽 패널을 늘렸을 때 가운데가 0으로 눌리다 못해 전체 레이아웃이
 * 창 밖으로 밀려나고, 화면이 통째로 가로 스크롤된다 (도그푸딩에서 실제로 나왔다).
 * 게다가 그 상태에서는 손잡이 위치 계산이 어긋나 끌수록 더 커지는 되먹임이 생긴다.
 */
export const CENTER_MIN = 360

/** 창 안에 실제로 들어갈 수 있는 폭으로 자른다 */
function fitWidth(px: number, min: number, max: number, otherLane: number): number {
  const available = (typeof window === 'undefined' ? 1280 : window.innerWidth) - otherLane - CENTER_MIN
  return Math.min(max, Math.max(min, Math.round(Math.min(px, available))))
}

export type ChatItem =
  | { kind: 'user'; seq: number; text: string }
  | { kind: 'assistant'; seq: number; text: string }
  | { kind: 'tool'; seq: number; tool: string; title: string; readOnly: boolean; result?: string; ok?: boolean }
  | { kind: 'approval'; seq: number; requestId: string; summary: string; decision?: string }
  /** 대화의 경계 표식 (압축 지점 등). 대화가 아니라 대화에 대한 사실이다 */
  | { kind: 'mark'; seq: number; text: string }

export type AppState = {
  platform: Platform | null
  connection: ConnectionState
  projects: Record<string, ProjectInfo>
  sessions: Record<string, SessionSummary>
  chat: Record<string, ChatItem[]>
  focusedSessionId: string | null
  /** 깃·파일·뷰어는 프로젝트의 것이다 — 세션 없이도 봐야 한다 */
  focusedProjectId: string | null
  /**
   * 세션별로 지금 화면에 있는 가장 오래된 기록 지점.
   * 압축으로 모델이 잊은 대화도 우리 저장소에는 남아 있으므로, 여기서부터 더 거슬러 읽는다.
   */
  history: Record<string, { oldestSeq: number; more: boolean; loading: boolean }>
  /**
   * 지금 깨우는 중인 세션.
   *
   * 세션을 고르면 **바로 깨운다.** 예전에는 메시지를 보낼 때 깨웠는데,
   * 그러면 앱을 켜고 첫 응답까지 프로세스 기동 시간이 통째로 얹힌다.
   * 게다가 잠든 세션에는 물어볼 프로세스가 없어서 슬래시 스킬 목록도 못 받는다.
   * 고르는 행동이 이미 "이 세션을 쓰겠다"는 뜻이므로 그때 준비를 시작한다.
   */
  resuming: Record<string, boolean>
  /**
   * 깨우기가 **왜** 실패했나.
   *
   * 예전에는 조용히 넘겼다("보낼 때 다시 시도하니까"). 그런데 화면에는
   * "메시지를 보내면 자동으로 이어집니다"라고 쓰여 있는데 실제로는 안 이어지는
   * 상태가 되어, 사용자는 원인을 알 길이 없었다 (도그푸딩 지적).
   * 조용한 실패 금지 — 이유를 그 자리에 적는다.
   */
  wakeError: Record<string, string>
  /**
   * 증거 레인(깃·파일)이 열려 있는가.
   * 탭이 아니라 패널인 이유: 깃 상태는 대화를 **대신하는** 화면이 아니라
   * 대화가 주장하는 것의 **증거**다. 대체 관계가 아닌 것을 탭으로 묶으면
   * "그거 어디서 봐?"가 나온다 (도그푸딩에서 실제로 나왔다).
   */
  panelOpen: boolean
  /** 증거 패널이 파일을 보여주나 깃을 보여주나 */
  panelTab: PanelTab
  /** 증거 패널 폭(px). 터미널을 쓰면 넓히고 싶어지므로 조절할 수 있어야 한다 */
  panelWidth: number
  treeHeight: number
  /** 세션 목록 폭(px) */
  sidebarWidth: number
  /**
   * 넓은 표면. 코드·diff는 360px 패널에서 읽을 수 없다.
   * 대화 위에 덮었다가 esc로 걷는다 — 돌아오면 대화는 스크롤 위치까지 그대로다.
   */
  overlay: Overlay
  inboxOpen: boolean
  toast: string | null
  appFocused: boolean
  /** 코드 뷰어가 보고 있는 파일 (프로젝트 상대 경로) */
  viewerPath: string | null
  paletteOpen: boolean
  /** 사용량 모달 (FR-9) */
  usageOpen: boolean
  settingsOpen: boolean
  notifyPolicy: NotifyPolicy

  attach(platform: Platform): Promise<void>
  dispatchEvent(e: NormalizedEvent): void
  focusSession(id: string | null): void
  focusProject(id: string): void
  setAppFocused(focused: boolean): void
  loadHistory(sessionId: string, force?: boolean): Promise<void>
  /** 더 오래된 대화를 앞에 붙인다 (압축 이전 대화를 읽기 위한 길) */
  loadOlder(sessionId: string): Promise<void>
  saveWorkspace(): void
  togglePanel(open?: boolean): void
  /** 탭을 고르면 패널이 닫혀 있어도 함께 열린다 — 고른 것이 안 보이면 안 된다 */
  setPanelTab(tab: PanelTab): void
  setPanelWidth(px: number): void
  setTreeHeight(px: number): void
  setSidebarWidth(px: number): void
  /** 파일을 넓은 오버레이로 연다 (파일 트리·깃 패널의 공통 진입점) */
  openFile(path: string): void
  /** 깃 전체 화면(변경·기록·브랜치)을 오버레이로 연다. path를 주면 그 diff부터 편다 */
  openGit(path?: string): void
  /** 커밋 하나를 넓은 곳에서 펼친다 (340px에서 diff는 못 읽는다) */
  openCommit(sha: string): void
  /** 브랜치 전환 화면 */
  openBranches(): void
  closeOverlay(): void
  toggleInbox(open?: boolean): void
  togglePalette(open?: boolean): void
  toggleUsage(open?: boolean): void
  toggleSettings(open?: boolean): void
  setNotifyPolicy(p: NotifyPolicy): void
  setToast(msg: string | null): void

  addProject(path: string): Promise<ProjectInfo>
  createSession(
    projectId: string,
    opts?: {
      tool?: ToolName
      model?: string
      permissionPreset?: PermissionPreset
      initialPrompt?: string
      /** 도구가 갖고 있던 이전 세션을 이어받는다 (터미널에서 만든 대화 포함) */
      resumeExternalId?: string
      importHistory?: boolean
    },
  ): Promise<SessionInfo>
  send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>
  attachFile(sessionId: string, file: File): Promise<Attachment | null>
  respondApproval(sessionId: string, requestId: string, decision: 'allow' | 'deny' | 'always', scope?: 'session' | 'project'): Promise<void>
  interrupt(sessionId: string): Promise<void>
  /** 목록에서 숨긴다 / 다시 꺼낸다 (기록은 남는다) */
  archive(sessionId: string, archived?: boolean): Promise<void>
  /** 에이전트만 재시작한다 (대화는 그대로) */
  restartSession(sessionId: string): Promise<boolean>
  deleteSession(sessionId: string): Promise<void>
  updateSessionSettings(
    sessionId: string,
    s: { model?: string | null; effort?: string | null; permissionPreset?: PermissionPreset },
  ): Promise<void>
  resumeSession(sessionId: string): Promise<boolean>
  /** 세션을 고르는 즉시 깨운다 (첫 응답을 기다리지 않게) */
  wake(sessionId: string): Promise<void>
  /** 재연결 후 돌던 세션 되살리기 (host가 죽으면 프로세스도 함께 죽는다) */
  recoverAfterReconnect(): Promise<void>
  /** 사이드바 순서 (사람이 끌어서 정한다) */
  reorderProjects(orderedIds: string[]): Promise<void>
  reorderSessions(projectId: string, orderedIds: string[]): Promise<void>
  /**
   * 컨트롤 센터.
   *
   * `view`는 화면 하나를 고르는 값이다 — 포커스 뷰와 그리드는 **같은 세션 상태를**
   * 다르게 보여줄 뿐이므로, 세션 데이터를 따로 들지 않고 보는 방식만 바꾼다.
   * (그래야 그리드에서 모델을 바꿔도 사이드바·포커스 뷰가 같이 따라온다.)
   */
  view: 'focus' | 'grid'
  gridPanels: string[]
  setView(view: 'focus' | 'grid'): void
  setGridPanels(sessionIds: string[]): Promise<void>
  rename(sessionId: string, name: string): Promise<void>
  markRead(sessionId: string): Promise<void>
}

/**
 * 대화 항목의 고유 번호. 이 값이 곧 React key이고 가상 스크롤의 항목 키다.
 *
 * **저장소에서 읽어온 항목과 절대 겹치면 안 된다.** 겹치면 같은 key가 둘이 되고,
 * 가상 스크롤이 둘을 같은 자리에 겹쳐 그려서 글자가 이어붙은 것처럼 뭉개진다.
 * (실제로 "가끔 이상하게 렌더링된다"로 보고된 증상이 이것이었다:
 *  기록을 불러온 세션 — 저장 seq 1..N — 에 새 메시지가 붙으면 그 seq도 1부터 셌다.)
 * 그래서 저장소 항목을 들일 때마다 이 번호를 그 위로 밀어 올린다.
 */
/** 객체에서 키 하나를 뺀 새 객체 (상태를 직접 고치지 않는다) */
function omitKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const next = { ...obj }
  delete next[key]
  return next
}

let chatSeq = 0

/** 저장소에서 들여온 항목보다 항상 큰 번호를 쓰도록 밀어 올린다 */
function bumpSeqAbove(items: { seq: number }[]): void {
  for (const it of items) if (it.seq > chatSeq) chatSeq = it.seq
}

/** 첨부 상한. 이보다 크면 base64 변환과 WS 전송 양쪽에서 앱이 눈에 띄게 멈춘다 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * 바이트 → base64.
 *
 * 한 글자씩 이어붙이면(`binary += String.fromCharCode(b)`) 문자열이 매번 새로 만들어져
 * 스크린샷 한 장(수 MB)에도 수십 초씩 멈춘다 — 화면에는 아무 일도 안 일어난 것처럼 보인다.
 * 실제로 "파일 첨부 안 됨"으로 보고된 증상이 이것이었다. 청크로 끊어 처리한다.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)))
  }
  return btoa(parts.join(''))
}

/** 한 번에 거슬러 읽는 기록 분량 */
const HISTORY_PAGE = 200

/** 비포커스 세션이 유지하는 최근 메시지 수 — 다시 열면 저장소에서 더 불러온다 */
const WINDOW_SIZE = 50

/** 아직 스토어에 등록되지 않은 세션의 이벤트 보관함 (등록 직후 재생) */
const pendingEvents = new Map<string, NormalizedEvent[]>()

export const useStore = create<AppState>((set, get) => ({
  platform: null,
  connection: 'connecting',
  projects: {},
  sessions: {},
  chat: {},
  focusedSessionId: null,
  focusedProjectId: null,
  history: {},
  resuming: {},
  wakeError: {},
  panelOpen: true,
  panelTab: 'git',
  view: 'focus' as const,
  gridPanels: [] as string[],
  panelWidth: PANEL_DEFAULT,
  treeHeight: TREE_DEFAULT,
  sidebarWidth: SIDEBAR_DEFAULT,
  overlay: null,
  inboxOpen: false,
  toast: null,
  appFocused: true,
  viewerPath: null,
  paletteOpen: false,
  usageOpen: false,
  settingsOpen: false,
  notifyPolicy: DEFAULT_NOTIFY_POLICY,

  async attach(platform) {
    /*
     * **먼저 이전 구독을 끊는다.**
     *
     * 구독은 매번 **새 클로저**라 Set에 넣어도 겹치지 않는다. 그래서 attach가 두 번
     * 돌면 같은 이벤트가 두 번, 세 번 돌면 세 번 적용된다 — 화면에는 글자가
     * "호호스트가스트가"처럼 그대로 곱해져 나온다 (도그푸딩에서 ×3, ×2로 두 번 나왔다).
     *
     * 스트리밍 델타는 **누적**이라 이 유형이 특히 나쁘다: 한 번 어긋나면 그 뒤로
     * 전부 어긋난 채 쌓인다. attach는 언제 불려도 같은 상태가 되게(멱등) 만든다.
     */
    detachAll()
    set({ platform })
    subscriptions.push(
      platform.agents.subscribe((e) => get().dispatchEvent(e)),
      platform.agents.onConnectionChange((connection) => {
        const was = get().connection
        set({ connection })
        // 끊겼다가 돌아왔다 — 돌던 세션을 되살린다
        if (connection === 'connected' && was !== 'connected') void get().recoverAfterReconnect()
      }),
    )

    const [projects, sessions, gridPanels] = await Promise.all([
      platform.projects.list(),
      platform.agents.listSessions(),
      // 배치를 못 읽어도 앱은 떠야 한다 — 그리드가 비어 보일 뿐이다
      platform.agents.controlCenter().catch(() => [] as string[]),
    ])
    set({
      projects: Object.fromEntries(projects.map((p) => [p.id, p])),
      sessions: Object.fromEntries(
        sessions.map((s) => [
          s.id,
          {
            ...initialSession({ id: s.id, projectId: s.projectId, name: s.name, tool: s.tool, effort: s.effort }),
            autoNamed: s.autoNamed, state: s.state, archived: s.archived, live: s.live,
            lastSeq: s.lastSeq, lastReadSeq: s.lastReadSeq, waitingSince: s.waitingSince,
          },
        ]),
      ),
      gridPanels,
      connection: 'connected',
    })

    // 보던 자리로 돌아온다 (C-3). 없거나 사라진 세션이면 조용히 무시한다.
    try {
      const snap = await platform.workspace.load()
      if (snap?.focusedSessionId && get().sessions[snap.focusedSessionId]) {
        get().focusSession(snap.focusedSessionId)
        // 보던 탭까지 돌아온다 (B-0)
        // 구버전 스냅샷의 tab은 무시한다 (탭 구조는 3레인으로 대체됐다)
        if (typeof snap.panelOpen === 'boolean') set({ panelOpen: snap.panelOpen })
        if (snap.panelTab === 'files' || snap.panelTab === 'git' || snap.panelTab === 'terminal') {
          set({ panelTab: snap.panelTab })
        }
        if (typeof snap.panelWidth === 'number') get().setPanelWidth(snap.panelWidth)
        if (typeof snap.sidebarWidth === 'number') get().setSidebarWidth(snap.sidebarWidth)
        const savedTree = (snap as { treeHeight?: number }).treeHeight
        if (typeof savedTree === 'number') get().setTreeHeight(savedTree)
        const savedPolicy = (snap as { notifyPolicy?: NotifyPolicy }).notifyPolicy
        if (savedPolicy) set({ notifyPolicy: savedPolicy })
      }
    } catch {
      /* 스냅샷이 없어도 앱은 정상 동작한다 */
    }
  },

  /** 상태가 바뀔 때마다 저장한다 — '종료 시 저장'은 크래시에 무력하다 */
  saveWorkspace() {
    const s = get()
    void s.platform?.workspace
      .save({
        focusedSessionId: s.focusedSessionId,
        panelOpen: s.panelOpen,
        panelTab: s.panelTab,
        panelWidth: s.panelWidth,
        sidebarWidth: s.sidebarWidth,
        treeHeight: s.treeHeight,
      } as never)
      .catch(() => {})
  },

  setAppFocused(focused) {
    set({ appFocused: focused })
  },

  dispatchEvent(e) {
    const sessionId = e.sessionId
    if (!sessionId) return

    /*
     * 밖에서(터미널의 도구로) 이어간 대화를 host가 따라잡았다.
     * 내용은 저장소에 들어갔으므로 화면을 통째로 다시 읽는다 —
     * 이벤트로 한 줄씩 재생하면 우리가 이미 아는 부분과 섞일 수 있다.
     */
    if (e.type === 'history_synced') {
      void get().loadHistory(sessionId, true)
      return
    }

    // 삭제는 세션이 사라지는 것이므로 리듀서를 태우지 않는다
    if (e.type === 'session_deleted') {
      set((s) => {
        const sessions = { ...s.sessions }
        const chat = { ...s.chat }
        delete sessions[sessionId]
        delete chat[sessionId]
        return {
          sessions,
          chat,
          focusedSessionId: s.focusedSessionId === sessionId ? null : s.focusedSessionId,
        }
      })
      return
    }

    const cur = get().sessions[sessionId]
    if (!cur) {
      // 세션 등록 전에 도착한 이벤트 (초기 프롬프트가 곧바로 스트리밍되는 경우).
      // 버리면 첫 턴이 통째로 사라지므로 보관했다가 등록 직후 재생한다.
      pendingEvents.set(sessionId, [...(pendingEvents.get(sessionId) ?? []), e])
      return
    }

    const next = applyEvent(cur, e, Date.now())
    const chat = appendChat(get().chat[sessionId] ?? [], e)
    const withSeq = chat.length > 0 ? bumpSeq(next, chat[chat.length - 1]!.seq) : next

    set((st) => ({
      sessions: { ...st.sessions, [sessionId]: withSeq },
      chat: { ...st.chat, [sessionId]: chat },
    }))

    // 상태가 바뀌었을 때만 알림을 판정한다 (판정은 core, 전달은 system 포트)
    if (withSeq.state !== cur.state) {
      const st = get()
      const platform = st.platform
      if (!platform) return

      const ctx = { appFocused: st.appFocused, policy: st.notifyPolicy }
      const after = Object.values(st.sessions)
      const before = after.map((x) => (x.id === sessionId ? cur : x))

      const one = notificationFor({ id: sessionId, name: withSeq.name, state: withSeq.state }, cur.state, ctx)
      const all = allDoneNotification(after, before, ctx)
      // 개별 알림이 있으면 그것만 — 같은 순간에 두 번 울리지 않는다
      const notice = one ?? all
      if (notice) void platform.system.notify(notice.title, notice.body)
      void platform.system.setBadge(badgeCount(countWaiting(after)))
    }
  },

  /** 프로젝트만 선택 — 세션을 고르지 않아도 깃·파일·뷰어를 볼 수 있다 */
  focusProject(id) {
    set((s) => ({
      focusedProjectId: id,
      // 다른 프로젝트를 고르면 세션 포커스는 놓는다 (섞이면 어느 프로젝트를 보는지 헷갈린다)
      focusedSessionId: s.sessions[s.focusedSessionId ?? '']?.projectId === id ? s.focusedSessionId : null,
      viewerPath: null,
      overlay: null,
    }))
    get().saveWorkspace()
  },

  focusSession(id) {
    const prev = get().focusedSessionId
    const projectId = id ? get().sessions[id]?.projectId : undefined
    // 세션을 바꾸면 덮어둔 것은 걷는다 — 새 세션의 대화가 먼저 보여야 한다
    set({ focusedSessionId: id, overlay: null, ...(projectId ? { focusedProjectId: projectId } : {}) })
    get().saveWorkspace()

    // 포커스를 벗어난 세션의 메시지는 잘라낸다 (docs/state-management.md §4).
    // 세션 10개 × 수백 턴을 전부 들고 있으면 §7.1 메모리 목표를 지킬 수 없다.
    // 요약(상태·안읽음·미리보기)은 그대로 남으므로 사이드바·인박스는 정확하다.
    if (prev && prev !== id) {
      const items = get().chat[prev]
      if (items && items.length > WINDOW_SIZE) {
        set((s) => ({ chat: { ...s.chat, [prev]: items.slice(-WINDOW_SIZE) } }))
      }
    }

    if (!id) return
    void get().markRead(id)
    // 아직 안 읽어온 세션이면 저장된 대화를 불러온다 (host 재시작 후에도 기록은 남는다)
    if (!get().chat[id]) void get().loadHistory(id)
    void get().wake(id)
  },

  async loadHistory(sessionId, force = false) {
    const platform = get().platform
    if (!platform) return
    try {
      const msgs = await platform.agents.loadMessages(sessionId, HISTORY_PAGE)
      const items = messagesToChat(msgs)
      bumpSeqAbove(items)
      set((s) => ({
        // force면 갈아 끼운다 — 밖에서 이어간 대화를 따라잡을 때 쓴다
        chat: { ...s.chat, [sessionId]: force ? items : (s.chat[sessionId] ?? items) },
        history: {
          ...s.history,
          [sessionId]: {
            oldestSeq: msgs[0]?.seq ?? 0,
            more: msgs.length >= HISTORY_PAGE,
            loading: false,
          },
        },
      }))
    } catch {
      // 기록을 못 불러와도 새 대화는 가능하므로 조용히 넘어간다
    }
  },

  async loadOlder(sessionId) {
    const platform = get().platform
    const cur = get().history[sessionId]
    if (!platform || !cur?.more || cur.loading || cur.oldestSeq <= 1) return
    set((s) => ({ history: { ...s.history, [sessionId]: { ...cur, loading: true } } }))
    try {
      const msgs = await platform.agents.loadMessages(sessionId, HISTORY_PAGE, cur.oldestSeq)
      const older = messagesToChat(msgs)
      bumpSeqAbove(older)
      set((s) => ({
        chat: { ...s.chat, [sessionId]: [...older, ...(s.chat[sessionId] ?? [])] },
        history: {
          ...s.history,
          [sessionId]: {
            oldestSeq: msgs[0]?.seq ?? cur.oldestSeq,
            more: msgs.length >= HISTORY_PAGE,
            loading: false,
          },
        },
      }))
    } catch (e) {
      set((s) => ({
        history: { ...s.history, [sessionId]: { ...cur, loading: false } },
        toast: `Could not load past conversation: ${(e as Error).message}`,
      }))
    }
  },
  togglePanel(open) {
    set((s) => ({ panelOpen: open ?? !s.panelOpen }))
    get().saveWorkspace()
  },

  setPanelTab(panelTab) {
    set({ panelTab, panelOpen: true })
    get().saveWorkspace()
  },

  setPanelWidth(px) {
    const s = get()
    const sidebar = s.panelOpen ? s.sidebarWidth : s.sidebarWidth
    set({ panelWidth: fitWidth(px, PANEL_MIN, PANEL_MAX, sidebar) })
    get().saveWorkspace()
  },

  setTreeHeight(px) {
    set({ treeHeight: Math.min(TREE_MAX, Math.max(TREE_MIN, Math.round(px))) })
    get().saveWorkspace()
  },

  setSidebarWidth(px) {
    const s = get()
    // 패널이 접혀 있으면 32px 띠만 차지한다
    const panel = s.panelOpen ? s.panelWidth : 32
    set({ sidebarWidth: fitWidth(px, SIDEBAR_MIN, SIDEBAR_MAX, panel) })
    get().saveWorkspace()
  },

  openFile(path) {
    set({ viewerPath: path, overlay: { kind: 'viewer' } })
  },

  openGit(path) {
    set({ overlay: { kind: 'git', path: path ?? null } })
  },

  openCommit(sha) {
    set({ overlay: { kind: 'git', sha, sub: 'history' } })
  },

  openBranches() {
    set({ overlay: { kind: 'git', sub: 'branches' } })
  },

  closeOverlay() {
    set({ overlay: null })
  },
  toggleInbox(open) {
    set((s) => ({ inboxOpen: open ?? !s.inboxOpen }))
  },
  togglePalette(open) {
    set((s) => ({ paletteOpen: open ?? !s.paletteOpen }))
  },
  toggleUsage(open) {
    set((s) => ({ usageOpen: open ?? !s.usageOpen }))
  },
  toggleSettings(open) {
    set((s) => ({ settingsOpen: open ?? !s.settingsOpen }))
  },
  setNotifyPolicy(notifyPolicy) {
    set({ notifyPolicy })
    // 정책은 워크스페이스 스냅샷에 함께 실린다 (E-5)
    void get().platform?.workspace.save({
      focusedSessionId: get().focusedSessionId,
      panelOpen: get().panelOpen,
      panelTab: get().panelTab,
      panelWidth: get().panelWidth,
      sidebarWidth: get().sidebarWidth,
      notifyPolicy,
    } as never).catch(() => {})
  },
  setToast(toast) {
    set({ toast })
  },

  async addProject(path) {
    const p = await get().platform!.projects.add(path)
    set((s) => ({ projects: { ...s.projects, [p.id]: p } }))
    return p
  },

  async createSession(projectId, opts) {
    const platform = get().platform!
    const project = get().projects[projectId]!
    const info = await platform.agents.createSession({
      projectId,
      cwd: project.path,
      // 고른 값이 그대로 host까지 간다 — 예전엔 프리셋이 'normal' 고정이고 모델은 전달조차 되지 않았다
      tool: opts?.tool ?? project.defaultTool,
      model: opts?.model ?? project.defaultModel,
      permissionPreset: opts?.permissionPreset ?? 'normal',
      initialPrompt: opts?.initialPrompt,
      resumeExternalId: opts?.resumeExternalId,
      importHistory: opts?.importHistory,
    })
    set((s) => ({
      sessions: {
        ...s.sessions,
        [info.id]: {
          ...initialSession({ id: info.id, projectId, name: info.name, tool: info.tool }),
          lastSeq: info.lastSeq,
          lastReadSeq: info.lastReadSeq,
        },
      },
      // 시작 프롬프트도 내가 한 말이다 — 대화창에 보여야 한다 (E2E가 잡은 누락)
      chat: opts?.initialPrompt
        ? { ...s.chat, [info.id]: [{ kind: 'user', seq: ++chatSeq, text: opts.initialPrompt }] }
        : s.chat,
      focusedSessionId: info.id,
    }))

    // 불러온 세션은 host에 이미 이전 대화가 쌓여 있다 — 화면으로 끌어온다
    if (opts?.importHistory && opts.resumeExternalId) {
      const msgs = await platform.agents.loadMessages(info.id)
      if (msgs.length > 0) {
        const restored = messagesToChat(msgs)
        bumpSeqAbove(restored)
        set((s) => ({ chat: { ...s.chat, [info.id]: restored } }))
      }
    }

    // 등록 전에 도착해 보관해 둔 이벤트를 순서대로 재생한다
    const buffered = pendingEvents.get(info.id)
    if (buffered) {
      pendingEvents.delete(info.id)
      for (const e of buffered) get().dispatchEvent(e)
    }
    return info
  },

  /** 붙여넣기·드래그로 들어온 파일을 host에 저장하고 첨부 정보를 받는다 (FR-13) */
  async attachFile(sessionId, file) {
    const platform = get().platform
    if (!platform) return null
    if (file.size > MAX_ATTACHMENT_BYTES) {
      set({ toast: `${file.name} is too large (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB)` })
      return null
    }
    try {
      const buf = await file.arrayBuffer()
      return await platform.agents.saveAttachment(
        sessionId,
        file.name,
        file.type || 'application/octet-stream',
        toBase64(new Uint8Array(buf)),
      )
    } catch (e) {
      set({ toast: `Could not attach: ${(e as Error).message}` })
      return null
    }
  },

  async send(sessionId, text, attachments) {
    const seq = ++chatSeq
    const label = attachments?.length ? `${text}${text ? '\n' : ''}📎 ${attachments.map((a) => a.name).join(', ')}` : text
    /*
     * 보낸 즉시 '작업 중'으로 표시한다.
     *
     * host가 state_change를 보내주긴 하지만, 잠든 세션이면 프로세스를 되살리는 데
     * 몇 초가 걸리고 그동안 화면은 완전히 조용하다 — 보냈는지조차 알 수 없다.
     * 우리가 아는 사실은 이미 확정이다: **보냈고, 답을 기다린다.**
     * 실패하면 아래에서 되돌린다.
     */
    const prevState = get().sessions[sessionId]?.state
    set((s) => ({
      chat: { ...s.chat, [sessionId]: [...(s.chat[sessionId] ?? []), { kind: 'user', seq, text: label }] },
      sessions: s.sessions[sessionId]
        ? { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, state: 'working' } }
        : s.sessions,
    }))
    try {
      await get().platform!.agents.send(sessionId, text, attachments)
      // 보내는 데 성공했다면 잠들어 있던 세션이 되살아난 것이다 (host가 알아서 이어준다)
      set((s) => ({
        sessions: s.sessions[sessionId]?.live
          ? s.sessions
          : { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, live: true } },
        wakeError: omitKey(s.wakeError, sessionId),
      }))
    } catch (err) {
      // 전송 실패를 조용히 삼키면 사용자는 답을 기다리며 계속 서 있게 된다.
      // 보낸 것처럼 남은 말풍선을 걷어내고 무엇을 해야 하는지 알린다.
      set((s) => ({
        chat: { ...s.chat, [sessionId]: (s.chat[sessionId] ?? []).filter((i) => i.seq !== seq) },
        // 기다릴 것이 없으니 '작업 중' 표시도 걷는다
        sessions:
          s.sessions[sessionId] && prevState
            ? { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, state: prevState } }
            : s.sessions,
      }))
      const e = err as Error & { code?: string }
      // host가 알아서 되살린 뒤 보낸다 — 여기까지 왔다면 되살리기 자체가 실패한 것이다
      set({ toast: `Could not send: ${e.message}` })
    }
  },

  async resumeSession(sessionId) {
    const platform = get().platform
    if (!platform) return false
    try {
      const res = await platform.agents.resumeSession(sessionId)
      set((s) => ({
        sessions: { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, live: res.resumed } },
        toast: res.resumed ? null : `Could not resume: ${res.reason ?? 'unknown reason'}`,
      }))
      return res.resumed
    } catch (err) {
      set({ toast: `Could not resume: ${(err as Error).message}` })
      return false
    }
  },

  async respondApproval(sessionId, requestId, decision, scope) {
    // '항상 허용'의 패턴은 core가 계산한다 (host는 core를 모르므로 여기서 실어 보낸다)
    const pending = get().sessions[sessionId]?.pendingApproval
    const matcher =
      decision === 'always' && pending
        ? pending.detail.kind === 'command'
          ? suggestMatcher(pending.detail.command)
          : pending.detail.kind === 'file_edit'
            ? pending.detail.path
            : undefined
        : undefined
    await get().platform!.agents.respondApproval(sessionId, requestId, decision, scope, matcher)
  },

  async interrupt(sessionId) {
    try {
      await get().platform!.agents.interrupt(sessionId)
    } catch (err) {
      // 못 멈췄는데 조용하면 멈춘 줄 알고 기다린다 — 이 프로젝트가 금지하는 실패다
      set({ toast: `Could not stop: ${(err as Error).message}` })
    }
  },

  /** 세션 완전 삭제. 되돌릴 수 없으므로 호출 전에 확인을 받는다 (UI 책임) */
  async deleteSession(sessionId) {
    const platform = get().platform
    if (!platform) return
    const name = get().sessions[sessionId]?.name ?? 'Session'
    try {
      await platform.agents.deleteSession(sessionId)
      set({ toast: `Deleted: ${name}` })
    } catch (e) {
      set({ toast: `Could not delete: ${(e as Error).message}` })
    }
  },

  async updateSessionSettings(sessionId, s) {
    const platform = get().platform
    if (!platform) return
    try {
      const info = await platform.agents.updateSettings(sessionId, s)
      set((st) => ({
        sessions: {
          ...st.sessions,
          [sessionId]: {
            ...st.sessions[sessionId]!,
            model: info.model,
            effort: info.effort,
            permissionPreset: info.permissionPreset,
          },
        },
      }))
      set({ toast: s.model !== undefined ? `Model: ${info.model ?? 'Default'} (from next turn)` : `Perms: ${info.permissionPreset}` })
    } catch (e) {
      set({ toast: `Could not change settings: ${(e as Error).message}` })
    }
  },

  async archive(sessionId, archived = true) {
    await get().platform!.agents.archiveSession(sessionId, archived)
    set((s) => {
      const cur = s.sessions[sessionId]!
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: archived ? archiveSession(cur) : { ...cur, archived: false, live: false },
        },
        // 숨기면 포커스를 놓는다. 꺼내면 바로 그 세션을 본다 — 꺼낸 이유가 그것이다
        focusedSessionId:
          archived && s.focusedSessionId === sessionId ? null : archived ? s.focusedSessionId : sessionId,
      }
    })
    if (!archived) void get().loadHistory(sessionId)
  },

  /**
   * 에이전트만 재시작한다. 대화 기록은 그대로 두고 프로세스만 갈아 끼운다 —
   * 도구가 먹통이 됐을 때 세션을 새로 만들면 맥락이 끊긴다.
   */
  /**
   * 잠든 세션을 미리 깨운다 (고르는 즉시).
   *
   * **실패하면 이유를 남긴다.** 토스트로 띄우지는 않는다 — 목록을 훑는 동안
   * 화면이 시끄러워진다. 대신 그 세션의 안내 줄에 적어서, 왜 안 이어지는지
   * 보고 있는 사람이 알 수 있게 한다.
   */
  /**
   * 끊겼다 돌아온 뒤 **돌고 있던 세션을 되살린다.**
   *
   * host가 죽으면 수퍼바이저가 다시 띄우지만(최대 5회, 지수 백오프),
   * 그 host는 **살아 있던 에이전트 프로세스를 하나도 모른다** — 프로세스는 함께
   * 죽었고 새 host의 메모리는 비어 있다. 그래서 화면에는 세션이 전부 잠든 채로
   * 남고, 사람이 하나씩 눌러 깨워야 했다 (도그푸딩: "다른 데서 세션 연결이 끊긴다").
   *
   * 무엇이 돌고 있었는지는 **UI가 안다** — 끊기기 직전의 live 상태가 여기 있다.
   * 그걸 근거로 되살린다. 아카이브된 것과 원래 잠들어 있던 것은 건드리지 않는다:
   * 끊김을 핑계로 사람이 안 켠 것까지 켜면 그건 복구가 아니라 다른 일이다.
   */
  /**
   * 사이드바 순서.
   *
   * **화면을 먼저 바꾸고 저장은 뒤따라간다.** 끌어놓은 것이 서버 왕복을 기다렸다가
   * 움직이면 손이 멈칫한 것처럼 느껴진다. 저장에 실패하면 host가 준 진실로 되돌린다 —
   * 조용히 어긋난 채로 두지 않는다.
   */
  async reorderProjects(orderedIds) {
    const platform = get().platform
    if (!platform) return
    const before = get().projects
    set({ projects: Object.fromEntries(orderedIds.map((id) => [id, before[id]!]).filter(([, v]) => v)) })
    try {
      const fresh = await platform.projects.reorder(orderedIds)
      set({ projects: Object.fromEntries(fresh.map((p) => [p.id, p])) })
    } catch (e) {
      set({ projects: before, toast: `Could not save order: ${(e as Error).message}` })
    }
  },

  setView(view) {
    set({ view })
  },

  /**
   * 배치를 통째로 저장한다 (추가·제거·순서가 전부 이 한 가지로 온다).
   *
   * 화면을 먼저 바꾸고 저장이 뒤따라간다 — 끌어놓은 패널이 서버 왕복을 기다렸다가
   * 자리를 잡으면 손이 멈칫한 것처럼 느껴진다. 실패하면 host가 준 진실로 되돌린다.
   */
  async setGridPanels(sessionIds) {
    const platform = get().platform
    if (!platform) return
    const before = get().gridPanels
    set({ gridPanels: sessionIds })
    try {
      set({ gridPanels: await platform.agents.setControlCenter(sessionIds) })
    } catch (e) {
      set({ gridPanels: before, toast: `Could not save layout: ${(e as Error).message}` })
    }
  },

  async reorderSessions(projectId, orderedIds) {
    const platform = get().platform
    if (!platform) return
    const before = get().sessions
    // 이 프로젝트의 세션만 새 순서로, 나머지는 있던 자리에 그대로
    const mine = new Set(orderedIds)
    const reordered: typeof before = {}
    for (const [id, s] of Object.entries(before)) {
      if (!mine.has(id)) reordered[id] = s
    }
    for (const id of orderedIds) if (before[id]) reordered[id] = before[id]!
    set({ sessions: reordered })
    try {
      await platform.agents.reorderSessions(projectId, orderedIds)
    } catch (e) {
      set({ sessions: before, toast: `Could not save order: ${(e as Error).message}` })
    }
  },

  async recoverAfterReconnect() {
    const s = get()
    if (!s.platform) return

    const wasLive = Object.values(s.sessions).filter((x) => x.live && !x.archived)
    if (wasLive.length === 0) return

    // 새 host의 진실로 먼저 맞춘다 — 그 사이 도구에서 지워졌을 수도 있다
    const fresh = await s.platform.agents.listSessions().catch(() => null)
    if (!fresh) return
    const alive = new Set(fresh.filter((x) => x.live).map((x) => x.id))

    const toWake = wasLive.filter((x) => !alive.has(x.id))
    if (toWake.length === 0) return

    set({ toast: `Reconnected — resuming ${toWake.length} session${toWake.length > 1 ? 's' : ''}` })
    // live 표시를 먼저 내려야 wake가 "이미 살아 있다"고 판단하고 그냥 돌아가지 않는다
    set((st) => ({
      sessions: Object.fromEntries(
        Object.entries(st.sessions).map(([id, v]) => [id, toWake.some((w) => w.id === id) ? { ...v, live: false } : v]),
      ),
    }))
    for (const x of toWake) await get().wake(x.id)
  },

  async wake(sessionId) {
    const s = get()
    const session = s.sessions[sessionId]
    if (!s.platform || !session || session.live || session.archived || s.resuming[sessionId]) return

    set((st) => ({ resuming: { ...st.resuming, [sessionId]: true } }))
    try {
      const res = await s.platform.agents.resumeSession(sessionId)
      set((st) => ({
        sessions: { ...st.sessions, [sessionId]: { ...st.sessions[sessionId]!, live: res.resumed } },
        wakeError: res.resumed
          ? omitKey(st.wakeError, sessionId)
          : { ...st.wakeError, [sessionId]: res.reason ?? 'unknown reason' },
      }))
    } catch (e) {
      set((st) => ({ wakeError: { ...st.wakeError, [sessionId]: (e as Error).message } }))
    } finally {
      set((st) => {
        const next = { ...st.resuming }
        delete next[sessionId]
        return { resuming: next }
      })
    }
  },

  async restartSession(sessionId) {
    const platform = get().platform!
    set((s) => ({ sessions: { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, state: 'idle' } } }))
    const r = await platform.agents.restartSession(sessionId)
    set((s) => ({
      sessions: { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, live: r.resumed } },
      wakeError: r.resumed ? omitKey(s.wakeError, sessionId) : { ...s.wakeError, [sessionId]: r.reason ?? '' },
      toast: r.resumed ? 'Agent restarted' : `Could not restart: ${r.reason ?? ''}`,
    }))
    return r.resumed
  },

  async rename(sessionId, name) {
    await get().platform!.agents.rename(sessionId, name)
    set((s) => ({ sessions: { ...s.sessions, [sessionId]: renamePure(s.sessions[sessionId]!, name) } }))
  },

  async markRead(sessionId) {
    const s = get().sessions[sessionId]
    if (!s || s.lastReadSeq >= s.lastSeq) return
    await get().platform!.agents.markRead(sessionId, s.lastSeq)
    set((st) => ({ sessions: { ...st.sessions, [sessionId]: markReadPure(st.sessions[sessionId]!, s.lastSeq) } }))
  },
}))

/**
 * 살아 있는 구독들. 스토어 상태가 아니라 모듈 스코프에 둔다 —
 * 화면이 다시 그려질 이유가 없는 값이라 상태에 넣으면 불필요한 렌더만 는다.
 */
const subscriptions: (() => void)[] = []

function detachAll(): void {
  for (const off of subscriptions.splice(0)) off()
}

/** 이벤트를 대화 아이템으로 (스트리밍 델타는 마지막 assistant 항목에 append) */
function appendChat(items: ChatItem[], e: NormalizedEvent): ChatItem[] {
  switch (e.type) {
    case 'message_delta': {
      const last = items[items.length - 1]
      if (last?.kind === 'assistant') {
        const copy = items.slice(0, -1)
        return [...copy, { ...last, text: last.text + e.text }]
      }
      return [...items, { kind: 'assistant', seq: ++chatSeq, text: e.text }]
    }
    case 'tool_call':
      return [...items, { kind: 'tool', seq: ++chatSeq, tool: e.summary.tool, title: e.summary.title, readOnly: e.summary.readOnly }]
    case 'tool_result': {
      const idx = [...items].reverse().findIndex((i) => i.kind === 'tool' && i.result === undefined)
      if (idx === -1) return items
      const real = items.length - 1 - idx
      const target = items[real] as Extract<ChatItem, { kind: 'tool' }>
      return items.map((it, i) => (i === real ? { ...target, result: e.summary, ok: e.ok } : it))
    }
    case 'approval_request':
      return [
        ...items,
        {
          kind: 'approval', seq: ++chatSeq, requestId: e.requestId,
          summary: e.detail.kind === 'command' ? e.detail.command : e.detail.kind === 'file_edit' ? e.detail.path : e.detail.raw,
        },
      ]
    case 'approval_resolved':
      return items.map((it) => (it.kind === 'approval' && it.requestId === e.requestId ? { ...it, decision: e.decision } : it))
    case 'history_synced':
      // 실제 내용은 저장소에 들어갔다 — 화면은 dispatchEvent 밖에서 다시 읽는다
      return items
    case 'compaction':
      // 모델의 컨텍스트에서만 접힌 것이지 우리 기록은 그대로다 —
      // 어디서 접혔는지 보여야 그 위로 거슬러 읽을 수 있다
      return [...items, { kind: 'mark', seq: ++chatSeq, text: 'Earlier messages were compacted here' }]
    default:
      return items
  }
}

/** 메시지 복원 (재시작·세션 전환 시) */
export function messagesToChat(msgs: StoredMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  for (const m of msgs) {
    if (m.kind === 'text' && m.role === 'user') {
      items.push({ kind: 'user', seq: m.seq, text: String((m.payload as { text?: string })?.text ?? '') })
    } else if (m.kind === 'text') {
      const e = m.payload as { text?: string }
      const last = items[items.length - 1]
      if (last?.kind === 'assistant') last.text += e.text ?? ''
      else items.push({ kind: 'assistant', seq: m.seq, text: e.text ?? '' })
    } else if (m.kind === 'marker') {
      items.push({ kind: 'mark', seq: m.seq, text: 'Earlier messages were compacted here' })
    } else if (m.kind === 'tool_call') {
      const e = m.payload as { summary?: { tool: string; title: string; readOnly: boolean } }
      if (e.summary) items.push({ kind: 'tool', seq: m.seq, tool: e.summary.tool, title: e.summary.title, readOnly: e.summary.readOnly })
    }
  }
  return items
}
