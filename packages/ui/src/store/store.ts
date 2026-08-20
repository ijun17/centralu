import { create } from 'zustand'
import type { Attachment, NormalizedEvent, PermissionPreset, ProjectInfo, QuestionAnswer, SessionInfo, StoredMessage, ToolName } from '@cc/protocol'
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
import { isOnScreen } from '../app/onscreen.js'

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

/**
 * 증거 패널이 보여주는 것.
 *
 * `history`는 깃 탭 안의 기록 띠를 **대신하지 않는다** (#21). 그 띠는 스테이징·커밋을
 * 하는 동안 곁에 두는 맥락이라 `treeHeight`(기본 200px ≈ 일곱 줄)에 갇혀 있다 —
 * 변경 목록이 나머지 높이를 가져가야 하기 때문이다. 기록을 **읽으러** 오는 것은 다른
 * 용무이고, 그때는 세로 한 칸이 통째로 필요하다. 같은 데이터, 다른 일.
 *
 * 깃과 나란한 평평한 탭으로 둔다. 깃 탭 안에 또 탭을 넣으면 340px 한 칸에 탭 층이 둘이
 * 되고, #20이 탭 배치를 다시 짤 때 옮길 것이 상태까지 딸린 덩어리가 된다.
 */
export type PanelTab = 'files' | 'git' | 'history' | 'terminal'

/**
 * 화면 밖에서 일어난 일 하나.
 *
 * `sessionId`가 곧 신원이다 — 같은 세션이 또 끝나면 카드가 늘지 않고 갱신된다.
 * 그래야 바쁜 세션 하나가 나머지를 밀어내지 않고, 카드 수가 세션 수를 넘지 않는다.
 */
export type Notice = {
  sessionId: string
  kind: 'done' | 'approval' | 'error'
  /** 그때의 세션 이름 — 나중에 바뀌어도 카드에 적힌 것은 그대로 둔다 */
  name: string
  at: number
}

/** 아직 보내지 않은 것. 글과 첨부는 함께 움직인다 — 한쪽만 세션에 묶으면 반쪽만 고친 게 된다 */
export type Draft = { text: string; attachments: Attachment[] }
export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

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
  /** pending: UI가 낙관적으로 그렸고 host의 확인(user_message)을 아직 못 받았다 */
  | { kind: 'user'; seq: number; text: string; pending?: boolean }
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
  /**
   * 아직 보내지 않은 글 — **세션별로** 둔다.
   *
   * 예전에는 입력창 부품이 들고 있었다. 그러면 글이 세션이 아니라 화면의 그 자리에
   * 붙는다: 포커스 뷰에서 세션을 바꿔도 같은 부품이 재사용되므로 A에 쓰던 글이
   * B의 입력창에 그대로 앉아 있었다 — 그대로 보내면 **엉뚱한 세션에 간다** (실측 확인).
   * 반대로 화면을 갈아 끼우는 그리드에서는 부품이 사라지며 글도 같이 사라졌다.
   *
   * 저장소에는 넣지 않는다. 앱을 껐다 켤 때까지 살아남아야 할 만큼 무거운 것은 아니다.
   */
  drafts: Record<string, Draft>
  /**
   * Whether a conversation was left standing at its newest line — **per session** (#31).
   *
   * The flag used to be a ref inside the chat stream, so it was born `true` with every
   * mount, and the grid mounts and unmounts panels as you move around: look at another
   * session, come back, and the panel had decided for itself that you were at the bottom.
   * Fourth time state that belongs to the work has been kept by the view instead (drafts,
   * the elapsed count, expanded folders, this).
   *
   * Per session, and that is the opposite call from expanded folders (#16) on purpose. An
   * open folder is a fact about *the code*, so every session on that repo wants it; where
   * you are in a conversation is a fact about *that conversation*, and you read one at a
   * time.
   *
   * **What is kept is "were you at the bottom", not the offset.** A pixel `scrollTop`
   * restored into a virtualiser that has not measured its rows yet lands *near* the right
   * place — which is the symptom #31 reported, not a cure for it. The bottom needs no
   * measurements to be reachable: it is wherever the content ends.
   *
   * Absent means yes: a conversation nobody has scrolled starts at its newest line. Not
   * persisted — where you had scrolled to is not worth surviving the app closing.
   */
  stickToBottom: Record<string, boolean>
  /**
   * When the turn a session is currently running started — the instant, per session.
   *
   * The "Waiting for response" line used to take `Date.now()` on mount and count up from
   * there, so switching views restarted the clock: a turn three minutes old read as if it
   * had just begun (issue #23). The component was holding the wrong half. **Elapsed time is
   * derived; the start instant is the fact.** Keeping the instant here means the count is
   * recomputed rather than resumed, and nothing depends on a component staying alive.
   *
   * Not `waitingSince`, which sounds like the same thing and is the opposite one: that is
   * when the session started waiting for *a human* (approval, input, error), and the
   * reducer sets it to null the moment a session goes back to `working` — precisely when
   * this line is on screen. Two clocks, because there are two directions of waiting.
   *
   * Not persisted. A turn does not survive the app closing.
   */
  workingSince: Record<string, number>
  /**
   * Which folders are expanded in the file tree — **per project** (issue #16).
   *
   * The tree rows used to hold this themselves, so it went away with the component: moving
   * between sessions collapsed everything and you dug down the same path again. Third time
   * we have made this mistake (drafts, the elapsed count, this).
   *
   * Per project, not per session, and the difference is not an accident. A draft is
   * something *you* were saying to *one* agent, so it belongs to that session. An expanded
   * folder is a fact about **the code** — `src/features/session` is where the work is no
   * matter which of that project's sessions you happen to be reading. Two sessions on the
   * same repo want the same tree open; two projects almost never do.
   *
   * **Not persisted, deliberately.** The complaint was "every time", and every time meant
   * every session switch — dozens an hour. A relaunch happens once a day, and it is exactly
   * the moment the tree is most likely to be wrong: branches moved, folders were deleted,
   * a worktree came and went. Restoring yesterday's paths would either quietly expand into
   * nothing or fire a listDir per stale path on first paint, which is the cost the lazy
   * tree exists to avoid. There is a mechanical reason too: the workspace snapshot is one
   * layout record written straight through to the host with no debounce, so persisting this
   * would mean an RPC per folder click. If a relaunch turns out to hurt, it can move there
   * later — but it should arrive as its own decision, not as a side effect of this one.
   */
  expandedDirs: Record<string, string[]>
  /**
   * Whether the file tree shows what `.gitignore` hides (issue #17).
   *
   * **Defaults to on.** It used to default to off, and that was the wrong way round for a
   * tree you open to *look at a file*: the file you want is often exactly the one git does
   * not track — a `.env`, a build artefact you are checking, a local note. A tree that
   * silently omits it does not read as filtered, it reads as "that file is not there", and
   * the toggle that would explain it is one line of small text you were not looking at.
   *
   * Still a toggle rather than always-on, because of *what* is behind it: not a curiosity
   * or two but `node_modules`, `dist`, `.next` — thousands of entries that sort in among
   * `src`. Whoever finds that unusable turns it off once, and it stays off. Shown rows read
   * in slate, since "the repo does not track this" is background information, not urgency.
   *
   * **Global, and remembered** — unlike expanded folders, which belong to their project.
   * That difference is the point: an open folder is a fact about a repo, while this is a
   * way of looking, and a way of looking belongs to the person. It sits with panelOpen and
   * panelTab in the workspace snapshot for the same reason, and unlike a folder click it is
   * flipped rarely, so a write per flip costs nothing.
   */
  showIgnored: boolean
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
   * 못 깨운 이유가 **다른 쪽이 쥐고 있어서**인가.
   *
   * 이유 문구를 정규식으로 되읽어 판정하지 않는다 — 문구를 고치는 순간 조용히 깨진다.
   * host가 신호로 따로 내려주므로 그대로 들고만 있는다. 이 값이 참일 때만
   * "갈라서 이어가기"를 내민다 (그 길이 실제로 열려 있는 경우가 그때뿐이다).
   */
  wakeLocked: Record<string, boolean>
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
  /**
   * 방금 응답을 마친 세션 — 화면을 한 번 쓸고 갈 바람의 방아쇠.
   * at을 함께 두는 이유: 같은 세션이 연달아 끝나도 **매번** 불어야 한다 (키로 쓴다).
   */
  completion: { sessionId: string; at: number } | null
  /**
   * 화면 밖에서 일어난 일들 — 우측 상단에 쌓이는 알림 카드.
   *
   * **스스로 사라지지 않는다.** OS 배너는 몇 초 뒤 걷혀서, 자리를 비운 사이에 온 것은
   * 돌아왔을 때 이미 없다. 그게 이 앱이 배너로 못 푸는 부분이고, 그래서 여기 남는다.
   * 걷히는 경우는 셋뿐이다: 그 세션을 보게 되거나, 카드를 눌러 그리로 가거나, ×를 누르거나.
   *
   * 세션당 하나만 둔다. 바쁜 세션 하나가 화면을 채우면 나머지가 묻힌다.
   */
  notices: Notice[]
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
  /** 알림 카드를 걷는다 (×를 누르거나, 그 세션을 보게 됐거나) */
  dismissNotices(sessionIds: string[]): void
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
  /** 아직 보내지 않은 것을 세션에 붙여 둔다 (비면 지운다) */
  setDraft(sessionId: string, draft: Draft): void
  /** Remember whether the conversation was left at its newest line (#31) */
  setStickToBottom(sessionId: string, sticking: boolean): void
  /** Open or close a folder in the file tree. The project owns it, not the session (#16) */
  toggleDir(projectId: string, path: string): void
  /** Show or hide what .gitignore hides (#17) */
  setShowIgnored(show: boolean): void
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
      /** 이 세션만 깃 워크트리에서 돌린다 (FR-2 옵션) */
      worktree?: boolean
    },
  ): Promise<SessionInfo>
  send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>
  attachFile(sessionId: string, file: File): Promise<Attachment | null>
  respondApproval(sessionId: string, requestId: string, decision: 'allow' | 'deny' | 'always', scope?: 'session' | 'project'): Promise<void>
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): Promise<void>
  interrupt(sessionId: string): Promise<void>
  /** 목록에서 숨긴다 / 다시 꺼낸다 (기록은 남는다) */
  archive(sessionId: string, archived?: boolean): Promise<void>
  /** 에이전트만 재시작한다 (대화는 그대로) */
  restartSession(sessionId: string): Promise<boolean>
  deleteSession(sessionId: string, deleteWorktree?: boolean): Promise<void>
  updateSessionSettings(
    sessionId: string,
    s: { model?: string | null; effort?: string | null; permissionPreset?: PermissionPreset },
  ): Promise<void>
  resumeSession(sessionId: string): Promise<boolean>
  /**
   * 세션의 에이전트를 바꾼다 (claude ↔ codex).
   * **대화는 이어지지 않는다** — 부르는 쪽이 사람에게 먼저 그 사실을 알려야 한다.
   */
  switchTool(sessionId: string, tool: ToolName): Promise<void>
  /** 세션을 고르는 즉시 깨운다 (첫 응답을 기다리지 않게) */
  wake(sessionId: string): Promise<void>
  /**
   * 잠긴 대화에서 갈라져 나와 이어간다.
   * 다른 앱을 닫으러 가지 않아도 되는 유일한 출구 — 원본은 그대로 둔다.
   */
  forkConversation(sessionId: string): Promise<void>
  /**
   * 재연결 후 복구. host의 세션 목록을 스토어에 병합하고(끊긴 사이 생기고·바뀌고·지워진
   * 세션), 돌고 있던 세션을 되살린다 (host가 죽으면 프로세스도 함께 죽는다).
   * `resync`가 참이면 이벤트 재전송이 불가능했다는 뜻이다 — 보던 대화도 저장소에서 다시 읽는다.
   */
  recoverAfterReconnect(resync?: boolean): Promise<void>
  /** 사이드바 순서 (사람이 끌어서 정한다) */
  reorderProjects(orderedIds: string[]): Promise<void>
  reorderSessions(projectId: string, orderedIds: string[]): Promise<void>
  /**
   * 그리드.
   *
   * `view`는 화면 하나를 고르는 값이다 — 포커스 뷰와 그리드는 **같은 세션 상태를**
   * 다르게 보여줄 뿐이므로, 세션 데이터를 따로 들지 않고 보는 방식만 바꾼다.
   * (그래야 그리드에서 모델을 바꿔도 사이드바·포커스 뷰가 같이 따라온다.)
   */
  /**
   * 지금 무엇을 보고 있나.
   *   focus        세션 하나 (기본)
   *   grid         그리드 — 눈으로 관제
   *   orchestrator 오케스트레이터 — 말로 관제
   */
  view: 'focus' | 'grid' | 'orchestrator'
  /** 오케스트레이터 세션 id (아직 부른 적 없으면 null) */
  orchestratorId: string | null
  gridPanels: string[]
  setView(view: 'focus' | 'grid' | 'orchestrator'): void
  /**
   * 오케스트레이터를 연다. **없으면 그때 만들어진다** (host가 판단한다).
   * 미리 만들지 않는 이유: 쓰지도 않는 세션이 도구 프로세스를 물고 있게 된다.
   */
  openOrchestrator(): Promise<void>
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

/**
 * SessionInfo에서 **살아-있는-동안 사실들**만 골라낸다 (승인·질문·활동·한도·사용량).
 *
 * host 메모리가 원본인 값들이라, 재연결·재시작 후 목록을 받을 때 이걸 안 옮기면
 * state=waiting_approval인데 카드 payload가 없어 승인이 화면에 영영 안 나타난다.
 * 통째로 spread하지 않는 이유: SessionInfo에는 SessionSummary에 없는 필드
 * (externalId·createdAt…)가 있어 섞이면 안 된다.
 */
function liveFactsOf(
  s: SessionInfo,
): Pick<SessionSummary, 'pendingApproval' | 'pendingQuestions' | 'activity' | 'limit' | 'usage' | 'context'> {
  return {
    pendingApproval: s.pendingApproval,
    pendingQuestions: s.pendingQuestions,
    activity: s.activity,
    limit: s.limit,
    usage: s.usage,
    context: s.context,
  }
}

/**
 * Keep `workingSince` in step with who is actually working (issue #23).
 *
 * A session that starts a turn gets the current instant; one that stops working loses its
 * entry, so the next turn cannot inherit the previous turn's start. An entry that is
 * already there is never overwritten — that is the whole point, since a turn's start does
 * not move just because we looked again.
 *
 * Returns `prev` unchanged when nothing moved. Zustand hands this object straight to
 * subscribers, so allocating a fresh one per streaming delta would re-render every reader
 * of it a few times a second for no reason.
 *
 * Sessions that were already running before we knew about them (first attach, reconnect)
 * are stamped with the moment we found out. That is not when the turn began, and we cannot
 * know when it did — the host does not send it. It is the earliest instant we can honestly
 * claim, and it is still stable across every view change after that.
 */
function trackWorkingSince(
  prev: Record<string, number>,
  sessions: Record<string, SessionSummary>,
  now: number,
): Record<string, number> {
  let next = prev
  const copy = () => (next === prev ? (next = { ...prev }) : next)
  for (const s of Object.values(sessions)) {
    if (s.state === 'working') {
      if (prev[s.id] == null) copy()[s.id] = now
    } else if (prev[s.id] != null) {
      delete copy()[s.id]
    }
  }
  // Drop instants for sessions that no longer exist — the ids never come back, but the map grows
  for (const id of Object.keys(prev)) if (!sessions[id]) delete copy()[id]
  return next
}

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

/**
 * 등록을 기다리며 보관된 이벤트를, **이제 등록된 세션에 한해** 순서대로 재생한다.
 *
 * createSession만 이 보관함을 비우던 동안, 앱을 켜기 전부터 host에서 돌던 세션의
 * 이벤트는 attach가 목록을 등록하기 전에 도착하면 영영 보관함에 남았다 —
 * 첫 턴의 출력이 재시작 전까지 통째로 사라졌다. 세션이 등록되는 길목마다 이걸 부른다.
 * 재생 전에 보관함에서 지우므로 두 길목이 겹쳐도 이중 적용은 없다.
 */
function replayPendingEvents(get: () => AppState): void {
  for (const id of [...pendingEvents.keys()]) {
    if (!get().sessions[id]) continue
    const buffered = pendingEvents.get(id)!
    pendingEvents.delete(id)
    for (const e of buffered) get().dispatchEvent(e)
  }
}

/**
 * 알림 카드를 쌓는다 — 세션당 하나.
 *
 * 같은 세션이 또 부르면 늘리지 않고 갱신하며, **자리는 처음 부른 순서를 지킨다.**
 * 매번 맨 아래로 보내면 바쁜 세션이 카드를 계속 움직여서, 누르려던 카드가
 * 손가락 밑에서 달아난다.
 */
function pushNotice(set: (fn: (s: AppState) => Partial<AppState>) => void, notice: Notice): void {
  set((s) => {
    const at = s.notices.findIndex((n) => n.sessionId === notice.sessionId)
    if (at === -1) return { notices: [...s.notices, notice] }
    const notices = [...s.notices]
    notices[at] = notice
    return { notices }
  })
}

/**
 * Which tools the Usage modal should report on — deduplicated, in screen order (#26).
 *
 * Usage is an **account** property that differs per tool, so the only honest question is
 * "which tools are on screen right now". The old picker asked a narrower one — *the*
 * focused session's tool, then the project default, then a hardcoded `'claude'` — and
 * that question has no answer in the grid: `focusedSessionId` does not name one of nine
 * panels, so a grid of Codex agents fell through to Claude's limits with nothing on
 * screen saying a substitution had happened.
 *
 * Deduplicated because usage belongs to the account, not the session: two Claude panels
 * share one number, and printing it twice would suggest they are two separate budgets.
 *
 * **An empty result is a real result.** The `'claude'` fallback is gone — it turned
 * "we cannot tell" into "here is the wrong tool", which is the failure the caller has no
 * way to detect. The modal says it does not know instead.
 */
export function usageTools(s: AppState): ToolName[] {
  const out: ToolName[] = []
  const add = (t: ToolName | undefined) => {
    if (t && !out.includes(t)) out.push(t)
  }

  // The grid is the case where "the session you are looking at" is not singular
  if (s.view === 'grid') {
    for (const id of s.gridPanels) add(s.sessions[id]?.tool)
    return out
  }

  // Focus (and the orchestrator) still look at one conversation — unchanged behaviour
  const session = s.focusedSessionId ? s.sessions[s.focusedSessionId] : undefined
  if (session) return [session.tool]
  add(s.focusedProjectId ? s.projects[s.focusedProjectId]?.defaultTool : undefined)
  return out
}

export const useStore = create<AppState>((set, get) => ({
  platform: null,
  connection: 'connecting',
  projects: {},
  sessions: {},
  chat: {},
  drafts: {},
  stickToBottom: {},
  workingSince: {},
  expandedDirs: {},
  showIgnored: true,
  focusedSessionId: null,
  focusedProjectId: null,
  history: {},
  resuming: {},
  wakeError: {},
  wakeLocked: {},
  panelOpen: true,
  panelTab: 'git',
  view: 'focus' as const,
  gridPanels: [] as string[],
  orchestratorId: null as string | null,
  panelWidth: PANEL_DEFAULT,
  treeHeight: TREE_DEFAULT,
  sidebarWidth: SIDEBAR_DEFAULT,
  overlay: null,
  inboxOpen: false,
  toast: null,
  appFocused: true,
  completion: null as { sessionId: string; at: number } | null,
  notices: [] as Notice[],
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
        /*
         * resync_required: 연결 자체는 살아 있는데 host가 끊긴 사이의 이벤트를
         * 재전송해 주지 못한다는 뜻이다 (재전송 버퍼 밖으로 밀렸다).
         *
         * 이 신호를 아무도 소비하지 않던 동안 두 가지가 잘못됐다: 놓친 이벤트는
         * 영영 복구되지 않았고, 라벨 로직이 connected가 아니면 전부 'Disconnected'로
         * 그려서 **연결돼 있는데 끊겼다고 표시**했다. 라벨에는 connected로 두고,
         * 빈 구간은 전체 재동기화(세션 목록 병합 + 보던 대화 다시 읽기)로 메운다.
         */
        if (connection === 'resync_required') {
          set({ connection: 'connected' })
          void get().recoverAfterReconnect(true)
          return
        }
        set({ connection })
        // 끊겼다가 돌아왔다 — 돌던 세션을 되살린다
        if (connection === 'connected' && was !== 'connected') void get().recoverAfterReconnect()
      }),
    )

    const [projects, sessions, gridPanels] = await Promise.all([
      platform.projects.list(),
      platform.agents.listSessions(),
      // 배치를 못 읽어도 앱은 떠야 한다 — 그리드가 비어 보일 뿐이다
      platform.agents.grid().catch(() => [] as string[]),
    ])
    const known: Record<string, SessionSummary> = Object.fromEntries(
      sessions.map((s) => [
        s.id,
        {
          /*
           * Take every stored setting the host hands back, not just one of them (issue #37).
           *
           * This asked for `effort` and stopped there, so a cold start rebuilt each session
           * with `model: null`, `permissionPreset: 'normal'` and `worktree: null` — the
           * defaults from initialSession — while the database still held what the user had
           * picked. Nothing was ever lost on the way down; the screen read back its own
           * defaults and presented them as the session, so every restart looked like the
           * settings had been thrown away (and the worktree badge vanished with them).
           * The reconnect merge builds the same summary from the same list and already names
           * all of these — two places that construct one thing have to ask for one set.
           */
          ...initialSession({
            id: s.id, projectId: s.projectId, name: s.name, tool: s.tool,
            model: s.model, effort: s.effort, permissionPreset: s.permissionPreset, worktree: s.worktree,
          }),
          autoNamed: s.autoNamed, state: s.state, archived: s.archived, live: s.live,
          lastSeq: s.lastSeq, lastReadSeq: s.lastReadSeq, waitingSince: s.waitingSince,
          // 살아-있는-동안 사실들도 host가 준다 — 이게 없으면 state=waiting_approval인데
          // 카드를 그릴 payload가 없어 승인 요청이 화면에 영영 안 나타난다 (재시작 후 실측)
          ...liveFactsOf(s),
        },
      ]),
    )
    set((st) => ({
      projects: Object.fromEntries(projects.map((p) => [p.id, p])),
      sessions: known,
      // A session can already be mid-turn when we arrive; stamp it now so the elapsed
      // line has an instant to count from instead of its own mount (issue #23)
      workingSince: trackWorkingSince(st.workingSince, known, Date.now()),
      gridPanels,
      connection: 'connected',
    }))

    // 목록 등록 전에 도착한 이벤트를 재생한다 — 앱을 켜기 전부터 돌던 세션의 첫 출력이 여기 있다
    replayPendingEvents(get)

    // 보던 자리로 돌아온다 (C-3). 없거나 사라진 세션이면 조용히 무시한다.
    try {
      const snap = await platform.workspace.load()
      if (snap?.focusedSessionId && get().sessions[snap.focusedSessionId]) {
        get().focusSession(snap.focusedSessionId)
        // 보던 탭까지 돌아온다 (B-0)
        // 구버전 스냅샷의 tab은 무시한다 (탭 구조는 3레인으로 대체됐다)
        if (typeof snap.panelOpen === 'boolean') set({ panelOpen: snap.panelOpen })
        if (
          snap.panelTab === 'files' ||
          snap.panelTab === 'git' ||
          snap.panelTab === 'history' ||
          snap.panelTab === 'terminal'
        ) {
          set({ panelTab: snap.panelTab })
        }
        if (typeof snap.panelWidth === 'number') get().setPanelWidth(snap.panelWidth)
        if (typeof snap.sidebarWidth === 'number') get().setSidebarWidth(snap.sidebarWidth)
        const savedTree = (snap as { treeHeight?: number }).treeHeight
        if (typeof savedTree === 'number') get().setTreeHeight(savedTree)
        const savedPolicy = (snap as { notifyPolicy?: NotifyPolicy }).notifyPolicy
        if (savedPolicy) set({ notifyPolicy: savedPolicy })
        // Whether the tree shows ignored files is a way of looking, so it comes back with
        // the rest of the panel's layout rather than being re-chosen every launch (#17).
        //
        // The `typeof` guard is what lets the default move. Reading the field as a plain
        // falsy check would make "never wrote one" indistinguishable from "turned it off",
        // and flipping the default to on would then quietly turn it back on for the one
        // person who had deliberately turned it off. An absent field takes the new default;
        // a stored `false` is a decision and outranks it.
        const savedIgnored = (snap as { showIgnored?: boolean }).showIgnored
        if (typeof savedIgnored === 'boolean') set({ showIgnored: savedIgnored })
      }
    } catch {
      /* 스냅샷이 없어도 앱은 정상 동작한다 */
    }
  },

  /**
   * 상태가 바뀔 때마다 저장한다 — '종료 시 저장'은 크래시에 무력하다.
   *
   * **스냅샷을 쓰는 곳은 여기 하나뿐이어야 한다.** host는 layout을 통째로 갈아
   * 끼우므로, 부분 스냅샷을 쓰는 두 번째 작성자가 생기는 순간 서로의 필드를 지운다 —
   * 실제로 setNotifyPolicy가 자기 목록으로 따로 저장해서, 알림 정책과 기록 높이가
   * 상대편 저장에 조용히 초기화됐다. 필드를 더하면 **이 함수에** 더해라.
   */
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
        notifyPolicy: s.notifyPolicy,
        showIgnored: s.showIgnored,
      } as never)
      .catch(() => {})
  },

  setAppFocused(focused) {
    set({ appFocused: focused })
  },

  dismissNotices(sessionIds) {
    if (sessionIds.length === 0) return
    const drop = new Set(sessionIds)
    set((s) => {
      const kept = s.notices.filter((n) => !drop.has(n.sessionId))
      // 같은 배열이면 그대로 둔다 — 새 배열을 넣으면 이걸 보는 효과가 다시 돈다
      return kept.length === s.notices.length ? {} : { notices: kept }
    })
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

    /** 이 이벤트로 이미 사람을 불렀나 — 같은 순간에 두 번 울리지 않기 위한 표시 */
    let announced = false

    /*
     * 응답이 끝났다 — 화면을 한 번 쓸고 갈 바람의 방아쇠.
     *
     * **보이는지를 지금 판정한다.** 예전에는 사실만 담아 두고 "보이는가"는 화면이
     * 나중에 곱했는데, 그러면 두 시점이 어긋난다: 세션을 옮겨 그 세션이 보이게 되는
     * 순간에도 곱셈의 답이 참이 되어 **새로 끝난 것이 없는데 바람이 불었다**
     * (도그푸딩: "세션 창 이동할 때도 막 나고"). 게다가 이 값을 지우지 않으므로
     * 오갈 때마다 몇 번이고 되풀이됐다.
     *
     * 사건이 일어난 그 순간에 한 번 판정하면 어긋날 자리가 없다.
     * 시각을 함께 담는 이유는 같은 세션이 연달아 끝나도 매번 불어야 해서다.
     *
     * 화면 밖에서 끝난 것은 바람이 아니라 **카드**로 남는다 — 보고 있지 않았으니
     * 지나가는 신호로는 놓친다. 둘은 같은 사건의 두 얼굴이고, 서로 배타적이다.
     */
    if (e.type === 'turn_complete') {
      const s = get()
      /*
       * **본다 = 앱이 앞에 있고 + 그 세션이 화면에 있고.**
       *
       * 앞엣것을 빠뜨렸었다. `isOnScreen`은 어느 세션이 UI에 떠 있는지만 보므로 앱이
       * 다른 창 뒤에 있어도 참이었다 — 그런데 자리를 비우면 앱이 통째로 안 보인다.
       * 그래서 바람은 빈 방에서 불고, 정작 자리 비움을 위해 만든 카드는 만들어지지
       * 않았다. 알림이 가장 필요한 경우에 정확히 아무 일도 일어나지 않은 셈이다.
       */
      const seen =
        s.appFocused &&
        isOnScreen(s.view, sessionId, {
          focusedSessionId: s.focusedSessionId,
          orchestratorId: s.orchestratorId,
          gridPanels: s.gridPanels,
        })
      if (seen) {
        set({ completion: { sessionId, at: Date.now() } })
      } else {
        pushNotice(set, { sessionId, kind: 'done', name: s.sessions[sessionId]?.name ?? sessionId, at: Date.now() })
        /*
         * 카드와 소리는 함께 간다. 카드만 쌓이고 소리가 없으면 "카드가 떴는데 왜 안
         * 불렀지"가 되고, 자리를 비운 사람에게 카드는 돌아와야 보이는 것이라 반쪽이다.
         * 소리는 다른 알림과 같은 정책을 탄다 — 눈앞에 있으면 조용히 카드만 남긴다.
         */
        if (s.notifyPolicy.done && (!s.appFocused || s.notifyPolicy.whenFocused)) {
          announced = true
          void s.platform?.system
            .alert('done', s.notifyPolicy.sound)
            .catch((err: Error) => set({ toast: `Could not alert: ${err.message}` }))
        }
      }
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
    /*
     * **안읽음 추적(lastSeq)은 host가 매긴 세션 내 seq로만 민다.**
     *
     * 예전에는 대화 아이템의 렌더 키(전 세션 공용 chatSeq)로 밀었다. 그 값이 markRead를
     * 타고 host의 last_read_seq로 저장되니, 200메시지 세션을 본 뒤 2메시지 세션에
     * 이벤트가 하나만 와도 그 세션의 last_read_seq가 ~201로 부풀어 — 재시작 후에도 —
     * 다시는 안읽음 점이 뜨지 않았다. 렌더 키와 저장 시퀀스는 다른 번호 체계다.
     */
    const hostSeq = 'seq' in e && typeof e.seq === 'number' ? e.seq : null
    let withSeq = hostSeq != null ? bumpSeq(next, hostSeq) : next
    // 내(혹은 오케스트레이터)가 보낸 말은 host도 읽음 처리한다 — 화면도 따라간다
    if (e.type === 'user_message') withSeq = markReadPure(withSeq, e.seq)

    set((st) => {
      const sessions = { ...st.sessions, [sessionId]: withSeq }
      return {
        sessions,
        chat: { ...st.chat, [sessionId]: chat },
        // A turn begins because an event arrived — this is where its start instant is
        // recorded, so the elapsed line survives remounting (issue #23)
        workingSince: trackWorkingSince(st.workingSince, sessions, Date.now()),
      }
    })

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
      // 개별 완료로 이미 울렸으면 "전부 완료"는 겹쳐 울리지 않는다 — 같은 순간에 두 번은 소음이다
      const notice = one ?? (announced ? null : all)
      if (notice) {
        // 배너는 되면 좋은 것으로 내려갔다 (macOS에서 이 경로는 죽어 있다).
        // 못 보냈으면 화면에 남긴다 — 조용히 사라지면 "알림이 안 온다"를 밝혀낼 수 없다.
        void platform.system.notify(notice.title, notice.body).catch((e: Error) => set({ toast: e.message }))
        // 실제로 사람에게 닿는 길. 권한도 서명도 타지 않는다.
        void platform.system
          .alert(notice.kind, st.notifyPolicy.sound)
          .catch((e: Error) => set({ toast: `Could not alert: ${e.message}` }))
      }
      // 승인·오류는 사람이 와야 풀린다 → 돌아왔을 때 남아 있도록 카드로도 남긴다.
      // "전부 완료"는 세션 하나의 일이 아니므로 카드를 만들지 않는다 (개별 카드가 이미 있다).
      if (one) {
        pushNotice(set, {
          sessionId,
          kind: one.kind === 'error' ? 'error' : 'approval',
          name: withSeq.name,
          at: Date.now(),
        })
      }
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
    /*
     * 세션을 고르면 **그 세션이 보여야 한다.**
     *
     * 그리드를 열어둔 채 사이드바에서 다른 세션을 눌러도 화면이 그대로였다:
     * 고른 것은 바뀌었는데 보이는 것은 안 바뀌니, 누른 사람 눈에는 아무 일도 안 일어난 것이다.
     * 여기 두는 이유는 부르는 곳이 열 군데(사이드바·인박스·팔레트·승인 배너…)라서다 —
     * 호출부마다 붙이면 언젠가 한 곳을 빠뜨린다.
     *
     * 선택 해제(null)는 뷰를 건드리지 않는다. 그건 "이걸 봐라"가 아니기 때문이다.
     */
    // 세션을 바꾸면 덮어둔 것은 걷는다 — 새 세션의 대화가 먼저 보여야 한다
    set({
      focusedSessionId: id,
      overlay: null,
      ...(id ? { view: 'focus' as const } : {}),
      ...(projectId ? { focusedProjectId: projectId } : {}),
    })
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
    // 정책은 워크스페이스 스냅샷에 함께 실린다 (E-5) — 저장은 단일 작성자를 태운다
    get().saveWorkspace()
  },
  setDraft(sessionId, draft) {
    set((s) => {
      // 빈 초안은 남기지 않는다 — 안 그러면 세션을 지워도 찌꺼기가 쌓인다
      if (!draft.text && draft.attachments.length === 0) {
        if (!(sessionId in s.drafts)) return {}
        const { [sessionId]: _gone, ...rest } = s.drafts
        return { drafts: rest }
      }
      return { drafts: { ...s.drafts, [sessionId]: draft } }
    })
  },
  setStickToBottom(sessionId, sticking) {
    set((s) => {
      // Scrolling fires this by the dozen; only a change is worth a new state object
      if ((s.stickToBottom[sessionId] ?? true) === sticking) return {}
      // Sticking is the default, so it is recorded by *not* being recorded — that way the
      // map only ever holds the sessions someone has actually scrolled away from
      if (sticking) return { stickToBottom: omitKey(s.stickToBottom, sessionId) }
      return { stickToBottom: { ...s.stickToBottom, [sessionId]: false } }
    })
  },
  toggleDir(projectId, path) {
    set((s) => {
      const cur = s.expandedDirs[projectId] ?? []
      /*
        Closing a folder leaves its children in the list on purpose. "As you left it" means
        the whole shape comes back when you open the parent again, not just its first row.
      */
      const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]
      return { expandedDirs: { ...s.expandedDirs, [projectId]: next } }
    })
  },
  setShowIgnored(show) {
    set({ showIgnored: show })
    get().saveWorkspace()
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
      worktree: opts?.worktree,
    })
    set((s) => ({
      sessions: {
        ...s.sessions,
        [info.id]: {
          ...initialSession({ id: info.id, projectId, name: info.name, tool: info.tool, worktree: info.worktree }),
          lastSeq: info.lastSeq,
          lastReadSeq: info.lastReadSeq,
          ...liveFactsOf(info),
        },
      },
      // 시작 프롬프트도 내가 한 말이다 — 대화창에 보여야 한다 (E2E가 잡은 누락)
      // pending을 세우는 이유: host도 첫 프롬프트를 저장하고 user_message로 알린다 —
      // 이 표식이 없으면 재생된 그 이벤트가 같은 말을 한 번 더 그린다 (send()와 같은 규칙)
      chat: opts?.initialPrompt
        ? { ...s.chat, [info.id]: [{ kind: 'user', seq: ++chatSeq, text: opts.initialPrompt, pending: true }] }
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
    replayPendingEvents(get)
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
    set((s) => {
      const sessions = s.sessions[sessionId]
        ? { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, state: 'working' as const } }
        : s.sessions
      return {
        /*
          pending: 내가 방금 그린 것이고 host의 확인을 아직 못 받았다.
          host가 user_message로 같은 말을 알려주면 이 항목이 그것으로 확정된다 —
          표식이 없으면 같은 말이 두 번 그려진다.
        */
        chat: { ...s.chat, [sessionId]: [...(s.chat[sessionId] ?? []), { kind: 'user', seq, text: label, pending: true }] },
        sessions,
        /*
          The wait starts here, not when the host's first event lands. Waking a sleeping
          session can take seconds, and those seconds are the ones a person is staring at —
          counting from the host's reply would quietly undercount the worst waits.
        */
        workingSince: trackWorkingSince(s.workingSince, sessions, Date.now()),
      }
    })
    try {
      await get().platform!.agents.send(sessionId, text, attachments)
      // 보내는 데 성공했다면 잠들어 있던 세션이 되살아난 것이다 (host가 알아서 이어준다)
      set((s) => ({
        sessions: s.sessions[sessionId]?.live
          ? s.sessions
          : { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, live: true } },
        wakeError: omitKey(s.wakeError, sessionId),
        // 보내졌다는 건 잠금이 풀렸다는 뜻이다 — 갈림길을 계속 내밀 이유가 없다
        wakeLocked: omitKey(s.wakeLocked, sessionId),
      }))
    } catch (err) {
      // 전송 실패를 조용히 삼키면 사용자는 답을 기다리며 계속 서 있게 된다.
      // 보낸 것처럼 남은 말풍선을 걷어내고 무엇을 해야 하는지 알린다.
      set((s) => {
        const sessions =
          s.sessions[sessionId] && prevState
            ? { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, state: prevState } }
            : s.sessions
        return {
          chat: { ...s.chat, [sessionId]: (s.chat[sessionId] ?? []).filter((i) => i.seq !== seq) },
          // 기다릴 것이 없으니 '작업 중' 표시도 걷는다
          sessions,
          // ...and the clock we started above stops with it, so a later turn cannot inherit it
          workingSince: trackWorkingSince(s.workingSince, sessions, Date.now()),
        }
      })
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
    /*
     * 이 스토어에서 유일하게 실패를 삼키던 동작이었다. 승인은 **눌렀는데 아무 일도
     * 안 일어나는 것이 가장 나쁜** 자리다 — 명령이 돌았는지 안 돌았는지 알 수 없다.
     */
    try {
      await get().platform!.agents.respondApproval(sessionId, requestId, decision, scope, matcher)
    } catch (e) {
      set({ toast: (e as Error).message || '승인을 전달하지 못했습니다' })
    }
  },

  /** 선택지에 답한다 — 답은 그 도구의 결과로 모델에게 간다 */
  async answerQuestion(sessionId, requestId, answers) {
    try {
      await get().platform!.agents.answerQuestion(sessionId, requestId, answers)
    } catch (e) {
      set({ toast: (e as Error).message || '답을 전달하지 못했습니다' })
    }
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
  async deleteSession(sessionId, deleteWorktree) {
    const platform = get().platform
    if (!platform) return
    const name = get().sessions[sessionId]?.name ?? 'Session'
    try {
      await platform.agents.deleteSession(sessionId, deleteWorktree)
      set({ toast: `Deleted: ${name}` })
    } catch (e) {
      set({ toast: `Could not delete: ${(e as Error).message}` })
    }
  },

  async switchTool(sessionId, tool) {
    const platform = get().platform
    if (!platform) return
    try {
      const info = await platform.agents.switchTool(sessionId, tool)
      set((s) => ({
        sessions: s.sessions[sessionId]
          ? { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, tool: info.tool, live: false } }
          : s.sessions,
      }))
    } catch (e) {
      set({ toast: `Could not switch the agent: ${(e as Error).message}` })
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
            worktree: info.worktree,
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

  async openOrchestrator() {
    const platform = get().platform
    if (!platform) return
    /*
     * 화면부터 바꾼다. 세션을 만드는 데 몇 초가 걸릴 수 있는데 그동안 아무 반응이
     * 없으면 누른 사람은 버튼이 죽은 줄 안다 — 보낸 즉시 '작업 중'으로 두는 것과 같은 이유다.
     */
    set({ view: 'orchestrator' })
    try {
      const info = await platform.agents.orchestrator()
      set((s) => ({
        orchestratorId: info.id,
        sessions: { ...s.sessions, [info.id]: s.sessions[info.id] ?? initialSession({ ...info, projectId: null }) },
      }))
      // 여기도 세션이 처음 등록되는 길목이다 — 보관해 둔 이벤트가 있으면 재생한다
      replayPendingEvents(get)
      if (!get().chat[info.id]) void get().loadHistory(info.id)
    } catch (e) {
      // 못 열었으면 화면을 되돌린다 — 빈 화면을 켜둔 채 이유를 안 말하는 것이 최악이다
      set({ view: 'focus', toast: `Could not open the orchestrator: ${(e as Error).message}` })
    }
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
      set({ gridPanels: await platform.agents.setGridView(sessionIds) })
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

  async recoverAfterReconnect(resync = false) {
    const s = get()
    if (!s.platform) return

    const wasLive = Object.values(s.sessions).filter((x) => x.live && !x.archived)

    const fresh = await s.platform.agents.listSessions().catch(() => null)
    if (!fresh) return

    /*
     * **새 host의 목록을 버리지 않고 병합한다.**
     *
     * 예전에는 fresh를 live 판정에만 쓰고 버렸다 — 끊긴 사이(다른 앱·터미널에서)
     * 만들어지거나 이름이 바뀌거나 지워진 세션이 앱을 껐다 켤 때까지 안 보였다.
     * host가 아는 사실(이름·상태·읽음 위치·승인/질문/한도…)만 덮고, 로컬 파생 상태
     * (preview·touchedPaths…)는 리듀서의 것이므로 지킨다.
     * 승인·질문도 host가 원본이다 — 끊긴 사이에 풀렸거나 새로 왔을 수 있어
     * 로컬 것을 지키면 죽은 requestId의 카드가 남는다.
     */
    set((st) => {
      const sessions: Record<string, SessionSummary> = {}
      for (const f of fresh) {
        const cur = st.sessions[f.id]
        sessions[f.id] = cur
          ? {
              ...cur,
              projectId: f.projectId, tool: f.tool, name: f.name, autoNamed: f.autoNamed,
              state: f.state, archived: f.archived, live: f.live,
              // lastSeq는 우리가 이벤트로 더 멀리 갔을 수 있다 — 뒤로 감으면 안읽음이 되살아난다
              lastSeq: Math.max(cur.lastSeq, f.lastSeq), lastReadSeq: f.lastReadSeq,
              waitingSince: f.waitingSince, model: f.model, effort: f.effort, permissionPreset: f.permissionPreset,
              worktree: f.worktree,
              ...liveFactsOf(f),
            }
          : {
              ...initialSession({ id: f.id, projectId: f.projectId, name: f.name, tool: f.tool, effort: f.effort, model: f.model, permissionPreset: f.permissionPreset, worktree: f.worktree }),
              autoNamed: f.autoNamed, state: f.state, archived: f.archived, live: f.live,
              lastSeq: f.lastSeq, lastReadSeq: f.lastReadSeq, waitingSince: f.waitingSince,
              ...liveFactsOf(f),
            }
      }
      // 지워진 세션의 잔해(대화·포커스)도 함께 걷는다
      const chat: typeof st.chat = {}
      for (const [id, items] of Object.entries(st.chat)) if (sessions[id]) chat[id] = items
      return {
        sessions,
        chat,
        // Same reason as attach: a session may have been working across the gap, and the
        // sessions that vanished should not leave their instants behind (issue #23)
        workingSince: trackWorkingSince(st.workingSince, sessions, Date.now()),
        focusedSessionId: st.focusedSessionId && sessions[st.focusedSessionId] ? st.focusedSessionId : null,
      }
    })
    // 병합으로 처음 등록된 세션이 있으면, 등록 전에 도착해 보관해 둔 이벤트를 재생한다
    replayPendingEvents(get)

    // 재동기화: 빈 구간의 이벤트는 다시 오지 않는다 — 보던 대화를 저장소의 진실로 갈아 끼운다
    const focused = get().focusedSessionId
    if (resync && focused) void get().loadHistory(focused, true)

    // 끊기기 직전에 돌고 있었는데 새 host가 모르는 프로세스만 되살린다
    const alive = new Set(fresh.filter((x) => x.live).map((x) => x.id))
    const toWake = wasLive.filter((x) => !alive.has(x.id) && get().sessions[x.id] && !get().sessions[x.id]!.archived)
    if (toWake.length === 0) return

    set({ toast: `Reconnected — resuming ${toWake.length} session${toWake.length > 1 ? 's' : ''}` })
    // 병합이 host의 live=false를 반영했으므로 wake가 "이미 살아 있다"고 오판하지 않는다
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
        wakeLocked:
          res.resumed || !res.lockedElsewhere
            ? omitKey(st.wakeLocked, sessionId)
            : { ...st.wakeLocked, [sessionId]: true },
      }))
    } catch (e) {
      set((st) => ({
        wakeError: { ...st.wakeError, [sessionId]: (e as Error).message },
        wakeLocked: omitKey(st.wakeLocked, sessionId),
      }))
    } finally {
      set((st) => {
        const next = { ...st.resuming }
        delete next[sessionId]
        return { resuming: next }
      })
    }
  },

  async forkConversation(sessionId) {
    const s = get()
    if (!s.platform || s.resuming[sessionId]) return
    set((st) => ({ resuming: { ...st.resuming, [sessionId]: true } }))
    try {
      const res = await s.platform.agents.forkConversation(sessionId)
      set((st) => ({
        sessions: { ...st.sessions, [sessionId]: { ...st.sessions[sessionId]!, live: res.resumed } },
        wakeError: res.resumed ? omitKey(st.wakeError, sessionId) : { ...st.wakeError, [sessionId]: res.reason ?? '' },
        // 갈라졌으면 더는 잠긴 상태가 아니다 — 실패했으면 갈림길은 그대로 남겨 둔다
        wakeLocked: res.resumed ? omitKey(st.wakeLocked, sessionId) : st.wakeLocked,
        toast: res.resumed
          ? 'Continuing in a forked conversation — the original is untouched'
          : `Could not fork: ${res.reason ?? 'unknown reason'}`,
      }))
    } catch (e) {
      set({ toast: `Could not fork: ${(e as Error).message}` })
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
    set((s) => {
      const sessions = { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, state: 'idle' as const } }
      // Restarting ends whatever turn was running — its clock goes with it (issue #23)
      return { sessions, workingSince: trackWorkingSince(s.workingSince, sessions, Date.now()) }
    })
    const r = await platform.agents.restartSession(sessionId)
    set((s) => ({
      sessions: { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, live: r.resumed } },
      wakeError: r.resumed ? omitKey(s.wakeError, sessionId) : { ...s.wakeError, [sessionId]: r.reason ?? '' },
      toast: r.resumed ? 'Agent restarted' : `Could not restart: ${r.reason ?? ''}`,
    }))
    return r.resumed
  },

  /**
   * 세션 이름 바꾸기 (이슈 #5).
   *
   * **먼저 host에 통과시키고, 그다음에 화면을 고친다.** 낙관적으로 먼저 그리면
   * 실패했을 때 화면에는 새 이름이, DB에는 옛 이름이 남는다 — 다음에 목록을
   * 다시 받는 순간 이름이 아무 설명 없이 되돌아간다. 이 저장소가 반복해서 데인 종류다.
   * 실패는 respondApproval/answerQuestion과 같은 방식으로 토스트에 띄운다.
   */
  async rename(sessionId, name) {
    const next = name.trim()
    if (!next) {
      set({ toast: 'Session name cannot be empty' })
      return
    }
    try {
      await get().platform!.agents.rename(sessionId, next)
    } catch (e) {
      set({ toast: `Could not rename: ${(e as Error).message}` })
      return
    }
    set((s) => ({ sessions: { ...s.sessions, [sessionId]: renamePure(s.sessions[sessionId]!, next) } }))
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
    case 'user_message': {
      /*
       * 내가 보낸 말이면 이미 그려져 있다 — 확정만 한다.
       * 남이 보낸 말(오케스트레이터의 send_to_session)이면 여기가 화면에 나타나는
       * 유일한 길이다. 이 갈래가 없던 동안 주입된 말은 저장만 되고 안 보였다.
       */
      const idx = items.findIndex((i) => i.kind === 'user' && i.pending && i.text === e.text)
      if (idx === -1) return [...items, { kind: 'user', seq: ++chatSeq, text: e.text }]
      return items.map((it, i) => (i === idx ? { ...(it as Extract<ChatItem, { kind: 'user' }>), pending: false } : it))
    }
    case 'history_synced':
      // 실제 내용은 저장소에 들어갔다 — 화면은 dispatchEvent 밖에서 다시 읽는다
      return items
    case 'compaction':
      // 모델의 컨텍스트에서만 접힌 것이지 우리 기록은 그대로다 —
      // 어디서 접혔는지 보여야 그 위로 거슬러 읽을 수 있다
      return [...items, { kind: 'mark', seq: ++chatSeq, text: compactionText(e) }]
    default:
      return items
  }
}

/**
 * 압축 마커에 무엇을 적을 것인가.
 *
 * "압축됐다"만으로는 부족하다. 실패했는데 성공한 것처럼 보이면 최악이고,
 * 얼마나 줄었는지는 다음 압축이 언제 올지 가늠하게 해준다 (도구가 알려줄 때만).
 */
export function compactionText(e: Extract<NormalizedEvent, { type: 'compaction' }>): string {
  if (e.failed) return `Compaction failed — ${e.reason ?? 'unknown reason'}`
  if (e.before != null && e.after != null) {
    return `Context compacted here · ${fmtTokens(e.before)} → ${fmtTokens(e.after)}`
  }
  return 'Earlier messages were compacted here'
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

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
      // 저장된 payload가 곧 그 이벤트다 — 라이브와 복원이 다른 문장을 쓰면 안 된다
      const e = m.payload as Extract<NormalizedEvent, { type: 'compaction' }>
      items.push({ kind: 'mark', seq: m.seq, text: compactionText(e) })
    } else if (m.kind === 'tool_call') {
      const e = m.payload as { summary?: { tool: string; title: string; readOnly: boolean } }
      if (e.summary) items.push({ kind: 'tool', seq: m.seq, tool: e.summary.tool, title: e.summary.title, readOnly: e.summary.readOnly })
    }
  }
  return items
}
