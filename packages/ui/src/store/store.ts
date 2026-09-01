import { create } from 'zustand'
import { SessionInfo } from '@cc/protocol'
import type { Attachment, NormalizedEvent, PermissionPreset, ProjectInfo, QuestionAnswer, StoredMessage, ToolName, UpdateStatus } from '@cc/protocol'
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
import { activateTab, defaultLayout, sanitizeLayout, type PanelGroup, type PanelTab } from './panelLayout.js'

/**
 * 스토어는 배선만 한다 — 상태 변경 로직은 전부 core (docs/state-management.md §2).
 * 명령은 포트로, 상태 갱신은 이벤트 → core 리듀서로만 (CQRS-lite: 낙관적 갱신 없음).
 */

/**
 * 대화를 덮는 넓은 표면. null이면 아무것도 덮여 있지 않다.
 *  - viewer: 파일 한 개 (viewerPath)
 *  - git: 변경·기록·브랜치 전체. path를 주면 그 파일의 diff부터 편다
 *
 * `pick` counts opens instead of naming one. The wide view now outlives the click that made
 * it — the change list beside it is no longer covered (#15), so it keeps being clicked while
 * the view is up. That makes "open this file" an **event**, not a state: two clicks on the
 * same row are two instructions, and the fields below are identical for both. Without a
 * number that moves, the second one is indistinguishable from no click at all.
 */
export type Overlay =
  | { kind: 'viewer' }
  | { kind: 'git'; path?: string | null; sha?: string | null; sub?: 'changes' | 'history' | 'branches'; pick: number }
  | null

/** 앞서 연 것보다 하나 큰 번호. 깃 밖에서 오면 다시 1부터 — 그 사이 패널은 새로 붙는다 */
const nextPick = (o: Overlay): number => (o?.kind === 'git' ? o.pick : 0) + 1

/**
 * The tab set and arrangement live in panelLayout.ts (#20) — the single `panelTab`
 * value became a group structure when the panel learned to split, and the reasoning
 * for what the tabs *are* (e.g. why `history` sits beside `git` rather than inside it,
 * #21) moved with the type. Re-exported so screens keep one import site for the store.
 */
export type { PanelGroup, PanelTab } from './panelLayout.js'

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

/**
 * 첨부 + 화면용 바이트.
 *
 * data는 이미지 썸네일을 그릴 때만 쓴다 — 저장·전송은 경로로만 오간다 (D-1).
 * 보낼 때는 방금 읽은 바이트가 손에 있으니 왕복 없이 채우고, 재시작 후에는
 * host가 loadMessages에서 파일을 다시 실어 준다 (#40의 에이전트 이미지와 같은 규칙).
 */
export type ChatAttachment = Attachment & { data?: string }

/** 아직 보내지 않은 것. 글과 첨부는 함께 움직인다 — 한쪽만 세션에 묶으면 반쪽만 고친 게 된다 */
export type Draft = { text: string; attachments: ChatAttachment[] }
export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

/** 증거 패널 폭의 한계. 좁으면 경로가, 넓으면 대화가 죽는다 */
export const PANEL_MIN = 260
export const PANEL_MAX = 900
export const PANEL_DEFAULT = 340

/** 세션 목록(관찰 레인) 폭 */
/** 깃 탭에서 '기록'이 차지할 높이. 나머지는 '변경'이 가져간다 */

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 480
export const SIDEBAR_DEFAULT = 240

/**
 * 전체 글자 크기의 다섯 단계 (가운데가 기본).
 *
 * 값은 루트의 CSS zoom 배율이다. 글꼴만 키우는 길(rem 전환)은 이 코드베이스의 텍스트가
 * 전부 px 고정(text-[11px]…)이라 전면 개편이 되고, 글자만 커지고 칸이 안 커지면
 * 좁은 그리드 칸에서 줄바꿈이 먼저 무너진다 — 화면 전체가 같은 비율로 커지는 쪽이
 * OS의 디스플레이 배율과 같은 문법이라 예측 가능하다.
 */
export const TEXT_SCALES = [0.85, 0.925, 1, 1.1, 1.25] as const
export const TEXT_SCALE_DEFAULT = 2

/**
 * 대화 레인이 최소한 지켜야 할 폭.
 *
 * 이게 없으면 양쪽 패널을 늘렸을 때 가운데가 0으로 눌리다 못해 전체 레이아웃이
 * 창 밖으로 밀려나고, 화면이 통째로 가로 스크롤된다 (도그푸딩에서 실제로 나왔다).
 * 게다가 그 상태에서는 손잡이 위치 계산이 어긋나 끌수록 더 커지는 되먹임이 생긴다.
 */
export const CENTER_MIN = 360

/**
 * 창 안에 실제로 들어갈 수 있는 폭으로 자른다.
 *
 * `zoom`이 필요한 이유 (전체 글자 크기): 레이아웃 폭은 zoom 좌표계인데
 * window.innerWidth는 **실픽셀**이라, 나누지 않으면 배율에서 사용 가능 폭을 부풀려
 * 계산해 레이아웃이 창 밖으로 밀린다. 그리고 최소 폭(min)은 **실픽셀로 고정**한다 —
 * 글자를 키웠다고 패널을 좁힐 수 있는 한계까지 커지면, 좁은 창에서 배율을 올리는
 * 순간 패널이 화면을 다 먹는다 (도그푸딩 요청: 최소 너비는 그대로).
 */
function fitWidth(px: number, minReal: number, max: number, otherLane: number, zoom = 1): number {
  const winW = (typeof window === 'undefined' ? 1280 : window.innerWidth) / zoom
  const available = winW - otherLane - CENTER_MIN / zoom
  return Math.min(max, Math.max(Math.round(minReal / zoom), Math.round(Math.min(px, available))))
}

/** 지금 배율 (TEXT_SCALES 값). 실픽셀 ↔ zoom 좌표 환산에 쓴다 */
export function useTextZoom(): number {
  return TEXT_SCALES[useStore((s) => s.textScale)] ?? 1
}

export type ChatItem =
  /**
   * pending: UI가 낙관적으로 그렸고 host의 확인(user_message)을 아직 못 받았다.
   * from: 사람이 아니라 다른 세션이 시킨 말 (FR-11 — 오케스트레이터 지시·워커 보고).
   */
  /**
   * attachments: 함께 실어 보낸 것들. 이미지는 실물 썸네일로 그린다 (📎 라벨의 후신 —
   * 라벨을 text에 섞던 시절엔 그린 것과 보낸 것이 달라 이중 렌더가 났다, #75).
   */
  | { kind: 'user'; seq: number; text: string; attachments?: ChatAttachment[]; pending?: boolean; from?: { sessionId: string; name: string } }
  | { kind: 'assistant'; seq: number; text: string }
  /** 추론 요약 (#58). codex만 텍스트를 준다 — claude의 생각은 세션의 thinkingTokens로만 보인다 */
  | { kind: 'reasoning'; seq: number; text: string }
  /*
   * 에이전트가 내놓은 이미지 (#40). 파일로 영속된다 (attachments/ + 경로 참조, 500MB 상한).
   * data가 비어 있으면 note가 이유를 말한다 (실패는 보이게).
   */
  | { kind: 'image'; seq: number; mime: string; data: string; path?: string; note?: string }
  /** live: 실행 중 출력의 꼬리 (#58, codex outputDelta). result가 오면 버린다 — 전체는 result에 있다 */
  | { kind: 'tool'; seq: number; tool: string; title: string; readOnly: boolean; result?: string; ok?: boolean; live?: string }
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
   * 바닥이 아닌 자리에서 떠났을 때 **어느 줄의 어디를** 보고 있었나 (#61).
   *
   * 위 주석이 "픽셀 offset은 안 남긴다"고 한 것은 지금도 맞다 — 재지 않은 가상
   * 스크롤에 생 scrollTop을 꽂으면 *비슷한* 자리에 떨어진다. 그런데 그 결론이
   * "아무것도 안 남긴다"였고, 그 결과 바닥이 아니었던 대화는 돌아올 때마다 맨 위에서
   * 다시 시작했다 (#61의 "스크롤이 위로 올라간다").
   *
   * 그래서 남기는 것은 픽셀이 아니라 **줄**이다: 화면 맨 위에 걸쳐 있던 항목의 seq와
   * 그 항목 안에서의 offset. seq는 측정과 무관한 사실이라 재고 나서도 같은 줄을
   * 가리키고, 나머지 몇 픽셀은 줄을 재는 동안 프레임마다 다시 맞춘다.
   *
   * 바닥에 있었으면 여기 없다 — 그건 stickToBottom이 이미 말하고, 바닥은 잴 필요가
   * 없는 자리다. 저장하지 않는다: 어디까지 읽었는지는 앱 종료를 넘길 값이 아니다.
   */
  scrollAnchor: Record<string, { seq: number; offset: number }>
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
  /** 전체 글자 크기 단계 — TEXT_SCALES의 인덱스 (0..4). 보는 방식이라 스냅샷에 실린다 */
  textScale: number
  focusedSessionId: string | null
  /** 깃·파일·뷰어는 프로젝트의 것이다 — 세션 없이도 봐야 한다 */
  focusedProjectId: string | null
  /**
   * 세션 생성 창이 열려 있는 프로젝트 (null이면 닫혀 있다).
   *
   * 사이드바 칸의 지역 상태였는데 스토어로 올렸다: **첫 실행 화면이 이 창을 열어야
   * 하기 때문이다.** 프로젝트가 하나 생기는 순간 첫 실행 화면은 사라지므로(App이
   * 프로젝트 유무로 가른다), 그 화면이 스스로 다음 걸음을 이어줄 방법은 사라지는
   * 자기 대신 다른 곳에 서게 될 창을 예약하는 것뿐이다.
   */
  newSessionFor: string | null
  /**
   * 매니저의 워크트리 제안 (#69). propose_worktree_session이 세우고, 그 프로젝트의
   * 새 세션 창이 열릴 때 소비된다 — 창은 워크트리가 켜지고 브랜치 이름이 채워진 채 뜬다.
   * 프로젝트에 키를 묶는 이유: 다른 프로젝트의 창까지 물들이면 제안이 오염이 된다.
   */
  /**
   * 큐다 (#69 도그푸딩): 매니저가 브랜치 둘을 연달아 제안했을 때 슬롯이 하나면
   * 마지막 것만 살아남았다 — 첫 제안은 대화 줄에서 이름을 읽어 손으로 쳐야 했다.
   * 창을 열 때마다 그 프로젝트의 가장 오래된 제안 하나를 소비한다 (FIFO).
   */
  worktreeProposals: { projectId: string; branch: string }[]
  /**
   * 새 세션 창이 워크트리 체크를 켠 채 열리는가 (#69).
   * 매니저 줄의 +가 켠다 — 매니저 아래에 만드는 세션은 워크트리 세션이 기본이라서다.
   * 창에서 끄는 것은 자유다 (강제가 아니라 예열이다).
   */
  newSessionWorktree: boolean
  /** 새 세션 창의 브랜치 이름 초기값 (#69) — 제안이 채운다. 빈 문자열이면 없음 */
  newSessionBranch: string
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
  /**
   * The tab arrangement (#20): groups stacked vertically, each an ordered tab list
   * plus its active tab. One group is the everyday panel; two is the split. Global —
   * one arrangement for the whole app, not per project — and carried in the workspace
   * snapshot, because the panel's shape is a way of looking, and a way of looking
   * belongs to the person (the same call as showIgnored, #17).
   */
  panelLayout: PanelGroup[]
  /** 증거 패널 폭(px). 터미널을 쓰면 넓히고 싶어지므로 조절할 수 있어야 한다 */
  panelWidth: number
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
  /**
   * 이 설치가 레지스트리에 비해 어디쯤인가 (이슈 #43).
   *
   * **host가 통째로 소유한다** — 여기서 계산하는 필드는 하나도 없다. 확인도 설치도
   * 저쪽에서 일어나고, 이 값은 그 결과가 도착해 앉는 자리일 뿐이다. null은 아직
   * 물어보지도 못한 것(연결 전)이고, '최신이다'가 아니다.
   */
  update: UpdateStatus | null

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
  /** Picking a tab opens the panel even if it was collapsed — what you picked must be visible */
  setPanelTab(tab: PanelTab): void
  /**
   * Replace the tab arrangement (#20). Callers hand in the output of the pure functions
   * in panelLayout.ts (moveTab / splitTab / …) — the store only wires and persists, per
   * docs/state-management.md §2.
   */
  setPanelLayout(groups: PanelGroup[]): void
  setPanelWidth(px: number): void
  setSidebarWidth(px: number): void
  /** 파일을 넓은 오버레이로 연다 (파일 트리·깃 패널의 공통 진입점) */
  openFile(path: string): void
  /** 대화 속 파일 링크의 우클릭 — 지금 보는 세션의 프로젝트에서 Finder로 보여준다 */
  revealFile(path: string): Promise<void>
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
  /** 지금 확인한다 (설정의 버튼). 실패는 화면에 남되 던지지 않는다 */
  checkUpdate(force?: boolean): Promise<void>
  /** 주기 확인을 켜고 끈다 */
  setUpdateAuto(enabled: boolean): Promise<void>
  /** 새 버전을 설치한다. **재시작은 하지 않는다** — 끝나면 사람에게 말하고 멈춘다 */
  applyUpdate(): Promise<void>
  setNotifyPolicy(p: NotifyPolicy): void
  /** 아직 보내지 않은 것을 세션에 붙여 둔다 (비면 지운다) */
  setDraft(sessionId: string, draft: Draft): void
  /** Remember whether the conversation was left at its newest line (#31) */
  setStickToBottom(sessionId: string, sticking: boolean): void
  /** 떠날 때 보고 있던 줄을 남긴다 (#61). null이면 지운다 — 바닥이었다는 뜻이다 */
  setScrollAnchor(sessionId: string, anchor: { seq: number; offset: number } | null): void
  /** Open or close a folder in the file tree. The project owns it, not the session (#16) */
  toggleDir(projectId: string, path: string): void
  /** Show or hide what .gitignore hides (#17) */
  setShowIgnored(show: boolean): void
  setTextScale(step: number): void
  setToast(msg: string | null): void
  /** 세션 생성 창을 연다/닫는다 (null이면 닫기) */
  openNewSession(projectId: string | null, opts?: { worktree?: boolean }): void

  addProject(path: string): Promise<ProjectInfo>
  /**
   * Ask for this project's git status again, debounced (issue #41).
   *
   * `project.git` was measured once, at attach, and never again — so the sidebar's changed
   * count was a snapshot from app start that an agent's edits and commits never moved.
   * Everything that shows git for a project reads that one field, so this writes back
   * there rather than growing a second, parallel copy for the sidebar.
   *
   * Returns nothing and is safe to call from anywhere: the call is a *hint* that the tree
   * may have moved, not a request the caller waits on.
   */
  refreshProjectGit(projectId: string): void
  /**
   * Changing a repository on purpose, from inside the app (issue #49).
   *
   * #41 gave the sidebar three ways to hear that a tree moved — a turn ending, an approval
   * granted, the window regaining focus — and every one of them is a *guess* that something
   * probably happened elsewhere. The git panel then went straight to `platform.git` and told
   * only itself, so **committing, the one change we make deliberately and know about, was the
   * only one the sidebar never heard**. The count sat on its old value until an unrelated
   * signal happened to fire.
   *
   * So the writes come through here and the refresh is part of the operation rather than
   * something each call site has to remember. Reads stay on `platform.git`: a panel asking
   * for its own file list or a diff is nobody else's business, and routing those through the
   * store would put a debounce in front of a list that has to repaint on the click.
   *
   * `push` is deliberately absent. It moves nothing the sidebar shows — `ProjectInfo['git']`
   * is branch, changed count and is-repo, with no ahead/behind — so a refresh after it would
   * be a status call whose answer can only be identical.
   */
  gitStage(projectId: string, paths: string[], unstage?: boolean): Promise<void>
  gitCommit(projectId: string, message: string): Promise<{ ok: boolean; message?: string }>
  /** Switching branch is the one of these that moves the **name** the sidebar shows, not the count */
  gitCheckout(projectId: string, branch: string): Promise<{ ok: boolean; conflicts: string[]; message?: string }>
  /**
   * Replace this project's saved shell commands (issue #44).
   * Adding one and deleting one both arrive here as "the list is this now".
   */
  setProjectCommands(projectId: string, commands: string[]): Promise<void>
  /** 워크트리 프로비저닝 설정 저장 (#69) — 새 세션 창의 워크트리 영역이 부른다 */
  saveWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): Promise<void>
  /**
   * Run one of the project's saved commands in that project's terminal (issue #44).
   *
   * Takes the **session**, not the project, because the session is what answers both
   * questions at once: whose terminal this belongs in, and where the person has to be
   * standing to see it.
   */
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
      /** 워크트리 브랜치 이름 (#69). 비우면 host가 자동 이름을 쓴다 */
      worktreeBranch?: string
    },
  ): Promise<SessionInfo>
  send(sessionId: string, text: string, attachments?: ChatAttachment[]): Promise<void>
  attachFile(sessionId: string, file: File): Promise<ChatAttachment | null>
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
    s: { model?: string | null; effort?: string | null; verbosity?: string | null; serviceTier?: string | null; permissionPreset?: PermissionPreset },
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
  /** 오케스트레이터 세션 id (아직 만든 적 없으면 null — 화면은 빈 대화 + 추천 질문) */
  orchestratorId: string | null
  /** 첫 질문으로 세션을 만드는 중 (#63) — 빈 화면이 죽은 척하지 않게 하는 표시 */
  orchestratorWaking: boolean
  /**
   * 사이드바의 Add project를 가리키는 중 (#63).
   *
   * 오케스트레이터의 propose_project가 켜고, **사람이 그 문으로 들어가거나 화제를
   * 옮기면 꺼진다.** 끄는 조건을 시간이 아니라 행동으로 두는 이유: 읽는 도중에
   * 꺼지면 가리킨 적이 없는 것과 같고, 영영 켜져 있으면 안내가 아니라 잔소리다.
   */
  addProjectHint: boolean
  /**
   * 소개 화면(오케스트레이터 + 도구 카드)을 지나왔는가 (#63).
   * 워크스페이스 스냅샷에 남는다 — 이 화면은 첫 실행에 딱 한 번이다.
   */
  introSeen: boolean
  gridPanels: string[]
  setView(view: 'focus' | 'grid' | 'orchestrator'): void
  /**
   * 오케스트레이터 **화면**을 연다. 세션은 만들지 않는다 (#63 지연 기동) —
   * 이미 있으면 붙고, 없으면 빈 대화가 첫 질문을 기다린다. 만드는 것은 askOrchestrator다.
   */
  openOrchestrator(): Promise<void>
  /**
   * 오케스트레이터에게 묻는다. **세션이 없으면 이 순간 만들어진다** — 추천 질문 카드와
   * 빈 화면의 입력창이 둘 다 이 문으로 들어온다 (#63).
   */
  askOrchestrator(text: string): Promise<void>
  /** 소개 화면 통과 (#63): 도구 선택을 host에 적고, 오케스트레이터 화면으로 간다 */
  completeIntro(tool: ToolName): Promise<void>
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

/**
 * 한 번에 거슬러 읽는 기록 분량 — **행이 아니라 메시지 개수다** (#66).
 * host의 loadMessages가 델타 조각을 메시지로 병합해 세므로, 200이던 시절의
 * "행 200개 = 토큰 200개 = 두어 문장"이 아니라 진짜 메시지 100개가 온다.
 */
const HISTORY_PAGE = 100

/** 비포커스 세션이 유지하는 최근 메시지 수 — 다시 열면 저장소에서 더 불러온다 */
const WINDOW_SIZE = 50

/** 아직 스토어에 등록되지 않은 세션의 이벤트 보관함 (등록 직후 재생) */
const pendingEvents = new Map<string, NormalizedEvent[]>()

/**
 * How long a project's git refresh waits for the next trigger before it runs (issue #41).
 *
 * The triggers arrive in bursts, not singly: three sessions in one project finishing
 * seconds apart, an approval granted and the turn it unblocked ending right after, a
 * focus and a visibilitychange for one alt-tab. Each of those would otherwise be its own
 * `git status` over the same working tree. One trailing window per project collapses a
 * burst into one measurement, and it has to be short enough that the number has already
 * moved by the time the eye goes looking for it — 800ms is under the glance.
 *
 * The delay also puts the measurement *after* the write it was told about, which matters
 * for the approval trigger: the edit lands in the moment following the "allow", not in it.
 */
const GIT_REFRESH_MS = 800

/**
 * Pending git refreshes, one timer per project — module scope for the same reason
 * `subscriptions` is: nothing on screen reads a timer, so keeping it out of the store
 * costs no renders.
 */
const gitRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Whether two git summaries say the same thing — a refresh that found nothing must not redraw */
function sameGit(a: ProjectInfo['git'], b: ProjectInfo['git']): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.branch === b.branch && a.changedFiles === b.changedFiles && a.isRepo === b.isRepo && a.denied === b.denied
}

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
  scrollAnchor: {},
  workingSince: {},
  expandedDirs: {},
  showIgnored: true,
  textScale: TEXT_SCALE_DEFAULT,
  focusedSessionId: null,
  focusedProjectId: null,
  newSessionFor: null,
  newSessionWorktree: false,
  newSessionBranch: '',
  worktreeProposals: [],
  history: {},
  resuming: {},
  wakeError: {},
  wakeLocked: {},
  panelOpen: true,
  panelLayout: defaultLayout(),
  view: 'focus' as const,
  gridPanels: [] as string[],
  orchestratorId: null as string | null,
  orchestratorWaking: false,
  introSeen: false,
  addProjectHint: false,
  panelWidth: PANEL_DEFAULT,
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
  update: null,

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
            id: s.id, projectId: s.projectId, kind: s.kind, name: s.name, tool: s.tool,
            model: s.model, effort: s.effort, verbosity: s.verbosity, serviceTier: s.serviceTier, permissionPreset: s.permissionPreset, worktree: s.worktree,
            parentSessionId: s.parentSessionId, merged: s.worktreeMerged,
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

    /*
     * host가 이미 알아낸 것을 따라잡는다 (이슈 #43).
     *
     * **기다리지 않는다.** 버전 확인 때문에 앱이 늦게 뜨면 순서가 뒤집힌 것이다.
     * `force: false`라 대개 host의 캐시를 그대로 받아 오지만, 아직 아무것도 모를 때는
     * 네트워크를 기다릴 수 있다 — 그 몇 초가 화면 앞에 서면 안 된다.
     *
     * 구독만으로는 부족한 이유: host의 첫 확인은 기동 직후라 이 창이 붙기 전에 끝나 있다.
     * 방송은 그때 이미 지나갔으므로, 늦게 온 쪽이 한 번 물어봐야 한다.
     */
    void get().checkUpdate(false)

    // Come back to where you were (C-3). A session that no longer exists is quietly skipped.
    try {
      const snap = await platform.workspace.load()
      if (snap) {
        if (snap.focusedSessionId && get().sessions[snap.focusedSessionId]) {
          get().focusSession(snap.focusedSessionId)
        }
        /*
         * The view comes back *after* the session, on purpose: focusSession forces
         * view:'focus' (selecting a session must show it), so restoring in the other
         * order would have the session restore quietly undo the view restore — the
         * exact bug being fixed, reintroduced by ordering.
         *
         * The orchestrator goes through its own door (openOrchestrator) rather than a
         * bare set: the view alone would be a "Waking the orchestrator…" screen that
         * nothing is actually waking.
         */
        /*
         * introSeen은 **view보다 먼저** 되살린다 (#63). 아래 openOrchestrator가
         * saveWorkspace를 부르는데, 그 시점의 introSeen이 아직 초기값(false)이면
         * 방금 읽은 스냅샷 위에 false를 되써서 저장값이 지워진다 — 다음 실행이
         * 소개 화면을 또 보여줬다 (실측: 복원 도중의 부분 저장이 마지막에 복원되는
         * 필드를 잡아먹는다).
         */
        if ((snap as { introSeen?: boolean }).introSeen === true) set({ introSeen: true })
        const savedView = (snap as { view?: unknown }).view
        if (savedView === 'grid') set({ view: 'grid' })
        else if (savedView === 'orchestrator') void get().openOrchestrator()
        /*
         * Layout prefs come back even when the focused session is gone (#20). They used
         * to sit inside the session check above, so a snapshot whose session had been
         * deleted threw the whole arrangement away with it — but the panel's shape is a
         * fact about the person, not about any session. (The legacy `snap.tab` field is
         * still ignored: that tab structure was replaced by the three lanes.)
         */
        if (typeof snap.panelOpen === 'boolean') set({ panelOpen: snap.panelOpen })
        /*
         * The arrangement survives restart, globally (#20 decision). `panelLayout` is
         * the arrangement; `panelTab` is the pre-#20 single-tab field, kept as the
         * fallback so a snapshot written before the arrangement existed still restores
         * the tab that was showing.
         */
        const savedLayout = (snap as { panelLayout?: unknown }).panelLayout
        if (savedLayout != null) {
          set({ panelLayout: sanitizeLayout(savedLayout) })
        } else if (
          snap.panelTab === 'files' ||
          snap.panelTab === 'git' ||
          snap.panelTab === 'history' ||
          snap.panelTab === 'terminal'
        ) {
          set({ panelLayout: activateTab(defaultLayout(), snap.panelTab) })
        }
        if (typeof snap.panelWidth === 'number') get().setPanelWidth(snap.panelWidth)
        if (typeof snap.sidebarWidth === 'number') get().setSidebarWidth(snap.sidebarWidth)
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
        // 글자 크기도 보는 방식이다 — 같은 typeof 가드, 같은 이유 (없음 ≠ 기본으로 정했음)
        const savedScale = (snap as { textScale?: number }).textScale
        if (typeof savedScale === 'number') get().setTextScale(savedScale)
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
        view: s.view,
        panelOpen: s.panelOpen,
        // The single-tab field predates the arrangement (#20). It keeps carrying the
        // top group's active tab so an older build reading this snapshot still lands
        // on the tab that was showing.
        panelTab: s.panelLayout[0]?.active,
        panelLayout: s.panelLayout,
        panelWidth: s.panelWidth,
        sidebarWidth: s.sidebarWidth,
        notifyPolicy: s.notifyPolicy,
        showIgnored: s.showIgnored,
        textScale: s.textScale,
        introSeen: s.introSeen,
      } as never)
      .catch(() => {})
  },

  setAppFocused(focused) {
    /*
     * **Only the false→true edge.** `onVisibility` fires once at mount while `appFocused`
     * is already true and `attach` has just fetched every project — refreshing on every
     * call would repeat that fetch for no new information. Focus and visibilitychange also
     * both fire for a single alt-tab; the debounce would collapse those anyway, but there
     * is no reason to arm two timers to learn one thing.
     */
    const returning = focused && !get().appFocused
    set({ appFocused: focused })
    /*
     * Coming back to the window is the only signal we get for work done **outside** the app
     * (issue #41): a commit typed in a terminal, a rebase, a `git clean`. Nothing in here
     * watched it happen, so no project is more suspect than another and all of them are
     * re-measured — refreshing only the focused one would leave every other sidebar row
     * exactly as stale as before, which is the bug.
     */
    if (returning) for (const id of Object.keys(get().projects)) get().refreshProjectGit(id)
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
    /*
     * 세션에 속하지 않는 사건은 **세션 가드보다 먼저** 처리한다 (이슈 #43).
     *
     * 아래 `if (!sessionId) return`은 이 파일에서 가장 넓은 문이고, 여기 걸리면
     * 조용히 사라진다 — 업데이트 상태를 그 뒤에 두면 host가 보낸 것이 도착은 하는데
     * 아무 일도 안 일어나는, 원인을 찾기 가장 나쁜 종류의 결함이 된다.
     */
    if (e.type === 'update_status') {
      set({ update: e.status })
      return
    }

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

    /*
     * 오케스트레이터가 이 세션의 설정을 바꿨다 (#30).
     *
     * 토스트가 핵심이다 — 사람이 아닌 손이 바꾼 설정이 화면에 조용히 스며들면,
     * 다음에 메뉴를 연 사람은 자기가 고른 적 없는 값을 보고 어리둥절해진다.
     * 값은 스냅샷이라 그대로 덮어쓴다.
     */
    if (e.type === 'settings_changed') {
      const cur0 = get().sessions[sessionId]
      if (!cur0) return
      const what = [
        e.model !== cur0.model ? `model ${e.model ?? 'default'}` : null,
        e.effort !== cur0.effort ? `effort ${e.effort ?? 'default'}` : null,
        e.verbosity !== cur0.verbosity ? `verbosity ${e.verbosity ?? 'default'}` : null,
        (e.serviceTier ?? null) !== cur0.serviceTier ? `speed ${e.serviceTier ?? 'default'}` : null,
      ].filter(Boolean).join(' · ')
      set((s) => ({
        sessions: {
          ...s.sessions,
          [sessionId]: { ...s.sessions[sessionId]!, model: e.model, effort: e.effort, verbosity: e.verbosity, serviceTier: e.serviceTier ?? null },
        },
        ...(what ? { toast: `Orchestrator changed ${cur0.name}: ${what}` } : {}),
      }))
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

      /*
       * A finished turn is the cheapest strong hint that the working tree moved (issue #41):
       * an agent just stopped editing in that folder, which is the very thing that made the
       * sidebar's changed count wrong. No filesystem watcher needed for the common case —
       * that is a bigger design (#34) and this must not wait for it.
       *
       * The session may not be registered yet (its events arrive buffered and are replayed
       * after `attach` lists it); the replay runs this branch again with a project to name.
       */
      const projectId = s.sessions[sessionId]?.projectId
      if (projectId) get().refreshProjectGit(projectId)
    }

    /*
     * host가 스스로 만든 세션의 유일한 통지 (#69) — 오케스트레이터의 create_session,
     * 워크트리 입양이 세우는 매니저. 이게 없던 동안 그런 세션은 재연결 후에야 나타났고,
     * 그 전에 도착한 이벤트는 보관함에서 영영 나오지 못했다 (비우는 조건이 "등록되면"인데
     * 등록시켜 줄 것이 없었다). RPC로 만든 쪽은 응답으로 이미 등록했으므로 조용히 버린다.
     */
    if (e.type === 'session_created') {
      const parsed = SessionInfo.safeParse(e.session)
      if (parsed.success && !get().sessions[parsed.data.id]) {
        const s = parsed.data
        set((st) => ({
          sessions: {
            ...st.sessions,
            [s.id]: {
              ...initialSession({
                id: s.id, projectId: s.projectId, kind: s.kind, name: s.name, tool: s.tool,
                model: s.model, effort: s.effort, verbosity: s.verbosity, serviceTier: s.serviceTier,
                permissionPreset: s.permissionPreset, worktree: s.worktree, parentSessionId: s.parentSessionId, merged: s.worktreeMerged,
              }),
              autoNamed: s.autoNamed, state: s.state, archived: s.archived, live: s.live,
              lastSeq: s.lastSeq, lastReadSeq: s.lastReadSeq, waitingSince: s.waitingSince,
              ...liveFactsOf(s),
            },
          },
        }))
        // 등록 전에 도착해 보관해 둔 이벤트가 있으면 지금이 재생할 순간이다
        replayPendingEvents(get)
      }
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
          // 읽던 자리도 세션과 함께 사라진다 — 같은 id가 다시 날 일은 없다 (#61)
          scrollAnchor: omitKey(s.scrollAnchor, sessionId),
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
     * 프로젝트 제안 (#63)은 **가리키는 것**으로 끝난다.
     *
     * 대화 안에 폴더 피커 버튼을 두면 사이드바의 Add project와 같은 일을 하는 문이
     * 둘이 되고, 처음 보는 사람은 "프로젝트는 오케스트레이터에게 시키는 것"으로
     * 배운다 — 실제로는 그 반대여야 한다. 그래서 여기서는 사이드바 버튼에 불을
     * 켤 뿐이다: 문은 앱에 하나, 오케스트레이터는 그 문이 어디 있는지 알려준다.
     */
    if (e.type === 'tool_call' && /propose_project$/.test(e.summary.tool)) set({ addProjectHint: true })
    /*
     * 워크트리 제안 (#69) — 같은 원칙(가리키기)에 값이 하나 실린다: 브랜치 이름.
     * 어댑터가 제목에 실어 보낸다 (다른 운반로가 없다). 제목이 도구 이름 그대로면
     * 이름 없는 제안이다 — 창은 빈 이름으로 열린다.
     */
    if (e.type === 'tool_call' && /propose_worktree_session$/.test(e.summary.tool) && cur.projectId) {
      const branch = /propose_worktree_session$/.test(e.summary.title) ? '' : e.summary.title
      set((st) => ({
        worktreeProposals: st.worktreeProposals.some((p) => p.projectId === cur.projectId && p.branch === branch)
          ? st.worktreeProposals // 같은 제안이 다시 와도 줄을 서지 않는다 (재생·재연결 멱등)
          : [...st.worktreeProposals, { projectId: cur.projectId as string, branch }],
      }))
    }
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
      // 프로젝트 화면은 포커스 레인에만 있다 — 고른 것은 보여야 한다 (focusSession과 같은 규칙).
      // 온보딩이 오케스트레이터 뷰를 먼저 열면서(#63) 이 조합이 실제로 생겼다 (e2e가 잡았다)
      view: 'focus',
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

  setPanelTab(tab) {
    set((s) => ({ panelLayout: activateTab(s.panelLayout, tab), panelOpen: true }))
    get().saveWorkspace()
  },

  setPanelLayout(panelLayout) {
    set({ panelLayout })
    get().saveWorkspace()
  },

  setPanelWidth(px) {
    const s = get()
    const sidebar = s.panelOpen ? s.sidebarWidth : s.sidebarWidth
    set({ panelWidth: fitWidth(px, PANEL_MIN, PANEL_MAX, sidebar, TEXT_SCALES[s.textScale] ?? 1) })
    get().saveWorkspace()
  },

  setSidebarWidth(px) {
    const s = get()
    // 패널이 접혀 있으면 32px 띠만 차지한다
    const panel = s.panelOpen ? s.panelWidth : 32
    set({ sidebarWidth: fitWidth(px, SIDEBAR_MIN, SIDEBAR_MAX, panel, TEXT_SCALES[s.textScale] ?? 1) })
    get().saveWorkspace()
  },

  openFile(path) {
    set({ viewerPath: path, overlay: { kind: 'viewer' } })
  },

  /*
   * 우클릭의 Finder 열기. 경로는 파일 링크와 같은 자격(지금 보는 세션의 프로젝트 상대)으로
   * 들어오고, 파일 트리의 reveal과 같은 포트를 지난다 — 실패는 트리와 같은 문장으로 시끄럽다.
   */
  async revealFile(path) {
    const s = get()
    const projectId = s.focusedSessionId ? s.sessions[s.focusedSessionId]?.projectId : null
    if (!projectId || !s.platform) return
    try {
      const res = await s.platform.fs.reveal(projectId, path)
      if (!res.supported) set({ toast: res.reason ?? 'Showing files is not available here' })
    } catch (e) {
      set({ toast: `Could not show ${path}: ${(e as Error).message}` })
    }
  },

  openGit(path) {
    // 탭을 적어 보낸다 — 기록을 보던 중에 변경 파일을 누르면 변경으로 돌아와야 한다
    set((s) => ({ overlay: { kind: 'git', path: path ?? null, sub: 'changes', pick: nextPick(s.overlay) } }))
  },

  openCommit(sha) {
    set((s) => ({ overlay: { kind: 'git', sha, sub: 'history', pick: nextPick(s.overlay) } }))
  },

  openBranches() {
    set((s) => ({ overlay: { kind: 'git', sub: 'branches', pick: nextPick(s.overlay) } }))
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

  /*
   * 아래 셋은 전부 같은 모양이다: host에게 시키고, 돌아온 상태를 그대로 앉힌다.
   *
   * **낙관적으로 미리 그리지 않는다.** 다른 조작들과 다른 점인데, 이유가 있다 —
   * 여기서 화면이 앞서 나가면 "설치 중"이라고 써 놓고 실제로는 아무 일도 없는 상태가
   * 만들어질 수 있고, 그건 되돌릴 수 없는 일에 대해 할 수 있는 가장 나쁜 거짓말이다.
   * 진행 상황은 host가 이벤트로 계속 보내 주므로 기다려도 화면이 멈추지 않는다.
   */
  async checkUpdate(force = true) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ update: await platform.updates.status(force) })
    } catch (e) {
      // 버전 확인이 화면을 깨뜨리면 안 된다 — 확인 자체보다 앱이 중요하다
      set({ toast: `Could not check for updates: ${(e as Error).message}` })
    }
  },

  async setUpdateAuto(enabled) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ update: await platform.updates.setAuto(enabled) })
    } catch (e) {
      set({ toast: `Could not save that: ${(e as Error).message}` })
    }
  },

  async applyUpdate() {
    const platform = get().platform
    if (!platform) return
    try {
      set({ update: await platform.updates.apply() })
    } catch (e) {
      set({ toast: `Could not update: ${(e as Error).message}` })
    }
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
  setScrollAnchor(sessionId, anchor) {
    set((s) => {
      if (!anchor) {
        // 바닥에서 떠났다 — 지난 앵커가 남아 있으면 다음 도착이 그 옛 자리로 간다
        if (!(sessionId in s.scrollAnchor)) return {}
        return { scrollAnchor: omitKey(s.scrollAnchor, sessionId) }
      }
      const cur = s.scrollAnchor[sessionId]
      if (cur && cur.seq === anchor.seq && cur.offset === anchor.offset) return {}
      return { scrollAnchor: { ...s.scrollAnchor, [sessionId]: anchor } }
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
  setTextScale(step) {
    // 다섯 단계 밖의 값(망가진 스냅샷·미래 버전)은 가장 가까운 단계로 접는다
    set({ textScale: Math.min(TEXT_SCALES.length - 1, Math.max(0, Math.round(step))) })
    get().saveWorkspace()
  },
  setToast(toast) {
    set({ toast })
  },
  openNewSession(projectId, opts) {
    /*
     * 제안(#69)은 **여는 순간** 소비된다 — 어느 문으로 열든 (프로젝트 +, 매니저 +,
     * 제안 줄). 남겨 두면 다음에 무관하게 연 창까지 물들인다.
     */
    const queue = get().worktreeProposals
    const at = projectId !== null ? queue.findIndex((p) => p.projectId === projectId) : -1
    const prop = at >= 0 ? queue[at] : undefined
    set({
      newSessionFor: projectId,
      newSessionWorktree: (opts?.worktree ?? false) || !!prop,
      newSessionBranch: prop?.branch ?? '',
      ...(prop ? { worktreeProposals: queue.filter((_, i) => i !== at) } : {}),
    })
  },

  async addProject(path) {
    const p = await get().platform!.projects.add(path)
    // 가리키던 문으로 들어왔으니 불을 끈다 (#63) — 지나간 안내가 남아 반짝이면 잔소리다
    set((s) => ({ projects: { ...s.projects, [p.id]: p }, addProjectHint: false }))
    return p
  },

  refreshProjectGit(projectId) {
    const pending = gitRefreshTimers.get(projectId)
    if (pending !== undefined) clearTimeout(pending)
    gitRefreshTimers.set(
      projectId,
      setTimeout(() => {
        gitRefreshTimers.delete(projectId)
        const platform = get().platform
        // The project can be gone by the time the window closes (removed, or a reconnect
        // rebuilt the list). Measuring a folder nobody is showing helps no one.
        if (!platform || !get().projects[projectId]) return
        void platform.projects
          .gitStatus(projectId)
          .then(({ git }) =>
            set((s) => {
              const cur = s.projects[projectId]
              /*
               * Nothing new is not an update. This runs after every turn and every return to
               * the window, and "the count is the same" is the common answer — handing every
               * row a fresh object each time would re-render the whole sidebar to redraw
               * identical text.
               */
              if (!cur || sameGit(cur.git, git)) return {}
              /*
               * **Only `git` is taken from the answer.** The host rebuilds the rest of
               * ProjectInfo from its own defaults, so swallowing the whole row would let a
               * reply that landed mid-`setProjectCommands` undo the list being edited.
               * This action was asked for one field; it writes one field.
               */
              return { projects: { ...s.projects, [projectId]: { ...cur, git } } }
            }),
          )
          /*
           * Silence on failure, deliberately. This is a number in the margin that nobody
           * asked for — a repo that has just been deleted, or a host that dropped the
           * project, must not put a toast in front of someone who was doing something else.
           * The stale count stays, which is exactly where we were before.
           */
          .catch(() => {})
      }, GIT_REFRESH_MS),
    )
  },

  /*
   * The three writes (issue #49). Each does the thing, then says the tree moved — the
   * `await` matters, because a status read that overtakes its own commit measures the repo
   * as it was and writes that back as news.
   *
   * Staging is in here even though it rarely moves the number (porcelain counts one line per
   * changed path whether it is staged or not). "Rarely" is not "never" — staging a file whose
   * content matches HEAD drops it out of status entirely — and the debounce plus `sameGit`
   * mean an answer identical to the last one costs one call and re-renders nothing. The
   * alternative is a rule about which writes qualify, which is the kind of rule that is
   * silently wrong for a year.
   */
  async gitStage(projectId, paths, unstage) {
    await get().platform!.git.stage(projectId, paths, unstage)
    get().refreshProjectGit(projectId)
  },

  async gitCommit(projectId, message) {
    const res = await get().platform!.git.commit(projectId, message)
    // Refresh even when the commit was refused: git can reject *after* moving something
    // (a hook that stages, a partial index update), and the count must not be left guessing.
    get().refreshProjectGit(projectId)
    return res
  },

  async gitCheckout(projectId, branch) {
    const res = await get().platform!.git.checkout(projectId, branch)
    get().refreshProjectGit(projectId)
    return res
  },

  async saveWorktreeSetup(projectId, setup) {
    const platform = get().platform
    const before = get().projects[projectId]
    if (!platform || !before) return
    await platform.projects.setWorktreeSetup(projectId, setup)
    // 요약 줄이 다음에 열릴 때 맞아야 한다 — host의 정규화 규칙(빈 설정 = null)을 따라간다
    const clean = setup && (setup.command || setup.copyFiles.length) ? setup : null
    set((s) => {
      const now = s.projects[projectId]
      return now ? { projects: { ...s.projects, [projectId]: { ...now, worktreeSetup: clean } } } : {}
    })
  },

  async setProjectCommands(projectId, commands) {
    const platform = get().platform
    const before = get().projects[projectId]
    if (!platform || !before) return
    // Draw it first. This is a list being edited by hand, and a row that appears only after
    // a round trip reads as a click that missed.
    set((s) => ({ projects: { ...s.projects, [projectId]: { ...before, commands } } }))
    try {
      const saved = await platform.projects.setCommands(projectId, commands)
      set((s) => {
        const now = s.projects[projectId]
        // The project could have gone while we were away; nothing to correct if so
        return now ? { projects: { ...s.projects, [projectId]: { ...now, commands: saved } } } : {}
      })
    } catch (e) {
      /*
       * Put the old list back and say so. A command that looks saved and is gone at the
       * next launch is the worse half of this: the menu would then say "nothing saved yet",
       * which reads as never having added it rather than as having lost it.
       */
      set((s) => ({
        projects: { ...s.projects, [projectId]: before },
        toast: `Could not save commands: ${(e as Error).message}`,
      }))
    }
  },

  async createSession(projectId, opts) {
    const platform = get().platform!
    const project = get().projects[projectId]!
    const info = await platform.agents.createSession({
      projectId,
      cwd: project.path,
      // 고른 값이 그대로 host까지 간다 — 예전엔 프리셋이 'normal' 고정이고 모델은 전달조차 되지 않았다
      tool: opts?.tool ?? project.defaultTool,
      model: opts?.model ?? project.defaultModel ?? undefined,
      // 강도도 기억을 따라간다 (#69 ⑤) — 모델만 기억하면 Opus는 오는데 high는 또 눌러야 한다
      effort: project.defaultEffort ?? undefined,
      permissionPreset: opts?.permissionPreset ?? 'normal',
      initialPrompt: opts?.initialPrompt,
      resumeExternalId: opts?.resumeExternalId,
      importHistory: opts?.importHistory,
      worktree: opts?.worktree,
      worktreeBranch: opts?.worktreeBranch,
    })
    set((s) => ({
      sessions: {
        ...s.sessions,
        [info.id]: {
          ...initialSession({
            id: info.id, projectId, name: info.name, tool: info.tool, worktree: info.worktree,
            // 소속도 host가 정한다 (#69) — 빠뜨리면 매니저 아래 만든 세션이 재시작 전까지 최상위에 선다
            parentSessionId: info.parentSessionId, merged: info.worktreeMerged,
          }),
          lastSeq: info.lastSeq,
          lastReadSeq: info.lastReadSeq,
          ...liveFactsOf(info),
        },
      },
      /*
       * **고른 도구가 이 프로젝트의 기본값이 된다.**
       *
       * default_tool은 프로젝트를 만들 때 'claude'로 박힌 뒤 어디서도 갱신되지 않았다 —
       * codex를 쓰는 사람은 새 세션을 만들 때마다 영원히 필을 다시 눌러야 했다.
       * 별도의 설정 항목을 만들지 않는 이유: 마지막 선택이 곧 기본값이라는 사실은
       * **세션을 만든 행위가 이미 말해 준다.** host도 같은 자리에서 같은 판단을 한다
       * (manager.createSession) — 여기 것은 이번 실행에서 바로 보이게 하는 낙관적 갱신이다.
       */
      projects:
        opts?.tool && s.projects[projectId]
          ? { ...s.projects, [projectId]: { ...s.projects[projectId], defaultTool: opts.tool } }
          : s.projects,
      // 시작 프롬프트도 내가 한 말이다 — 대화창에 보여야 한다 (E2E가 잡은 누락)
      // pending을 세우는 이유: host도 첫 프롬프트를 저장하고 user_message로 알린다 —
      // 이 표식이 없으면 재생된 그 이벤트가 같은 말을 한 번 더 그린다 (send()와 같은 규칙)
      chat: opts?.initialPrompt
        ? { ...s.chat, [info.id]: [{ kind: 'user', seq: ++chatSeq, text: opts.initialPrompt, pending: true }] }
        : s.chat,
    }))
    /*
     * focusedSessionId를 직접 세우지 않고 focusSession을 거친다 — "고른 세션은 보여야
     * 한다"는 뷰 강제가 저기 있다. 직접 세우던 시절엔 문제가 없었다: 다이얼로그를 쓸 때
     * 화면은 이미 포커스 뷰였다. 온보딩이 오케스트레이터 뷰를 먼저 열면서(#63) 거기서
     * 만든 세션이 **보이지 않는** 조합이 생겼다 (e2e가 잡았다).
     */
    get().focusSession(info.id)

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
      const b64 = toBase64(new Uint8Array(buf))
      const saved = await platform.agents.saveAttachment(
        sessionId,
        file.name,
        file.type || 'application/octet-stream',
        b64,
      )
      // 이미지는 방금 읽은 바이트로 즉시 썸네일을 그린다 — host 왕복이 필요 없다
      return saved.kind === 'image' ? { ...saved, data: b64 } : saved
    } catch (e) {
      set({ toast: `Could not attach: ${(e as Error).message}` })
      return null
    }
  },

  async send(sessionId, text, attachments) {
    const seq = ++chatSeq
    /*
     * 보낸 즉시 '작업 중'으로 표시한다.
     *
     * host가 state_change를 보내주긴 하지만, 잠든 세션이면 프로세스를 되살리는 데
     * 몇 초가 걸리고 그동안 화면은 완전히 조용하다 — 보냈는지조차 알 수 없다.
     * 우리가 아는 사실은 이미 확정이다: **보냈고, 답을 기다린다.**
     * 실패하면 아래에서 되돌린다.
     */
    const prevState = get().sessions[sessionId]?.state
    // 다음 말을 걸었다 = 화제가 옮겨갔다. 지난 안내는 여기서 꺼진다 (#63)
    if (get().addProjectHint) set({ addProjectHint: false })
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
        chat: {
          ...s.chat,
          [sessionId]: [
            ...(s.chat[sessionId] ?? []),
            // 첨부는 라벨(📎 이름)로 text에 섞지 않는다 — 이미지는 실물로, 파일은 칩으로 따로 그린다.
            // text가 보낸 원문 그대로라 user_message 확정 대조도 이걸로 성립한다 (#75).
            { kind: 'user', seq, text, ...(attachments?.length ? { attachments } : {}), pending: true },
          ],
        },
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
      // 바이트는 이미 host의 파일에 있다 — 전송에는 경로만 싣는다 (data를 실으면 페이로드가 두 배)
      await get().platform!.agents.send(sessionId, text, attachments?.map(({ data: _, ...a }) => a))
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
      /*
       * Letting an edit or a command through means the tree is **about to** move (issue #41).
       *
       * Waiting for `turn_complete` alone would freeze the count for as long as the turn
       * runs — ten minutes of watching an agent edit twenty files while the sidebar insists
       * nothing has changed. A denial changes nothing, so it buys no refresh, and neither
       * does an `other` approval, which is by definition something we cannot read.
       *
       * The debounce is what makes this affordable: a run of approvals costs one status.
       */
      const changing =
        decision !== 'deny' && (pending?.detail.kind === 'file_edit' || pending?.detail.kind === 'command')
      const projectId = get().sessions[sessionId]?.projectId
      if (changing && projectId) get().refreshProjectGit(projectId)
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
          ? {
              ...s.sessions,
              [sessionId]: {
                ...s.sessions[sessionId]!,
                tool: info.tool,
                /*
                 * 모델과 딸린 설정은 host가 놓는다 (manager.switchTool의 주석) —
                 * 화면도 따라 놓지 않으면 메뉴에는 'sonnet'이 그대로 켜져 있는데
                 * 실제 세션은 codex 기본값으로 도는, 읽을수록 틀린 화면이 된다.
                 */
                model: info.model,
                effort: info.effort,
                verbosity: info.verbosity,
                serviceTier: info.serviceTier,
                live: false,
              },
            }
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
            verbosity: info.verbosity,
            serviceTier: info.serviceTier,
            permissionPreset: info.permissionPreset,
            worktree: info.worktree,
          },
        },
      }))
      /*
       * 무엇을 바꿨는지 그대로 말한다. 예전에는 model 아니면 전부 "Perms:"라고 했다 —
       * effort를 바꿔도 "Perms: normal"이 떠서, 방금 한 일과 화면의 말이 달랐다.
       * (verbosity(#54)를 더하면서 세 번째로 거짓말할 자리가 생겨 고친다)
       */
      const changed =
        s.model !== undefined
          ? `Model: ${info.model ?? 'Default'}`
          : s.effort !== undefined
            ? `Effort: ${info.effort ?? 'default'}`
            : s.verbosity !== undefined
              ? `Verbosity: ${info.verbosity ?? 'default'}`
              : s.serviceTier !== undefined
                ? `Speed: ${info.serviceTier ?? 'default'}`
                : `Perms: ${info.permissionPreset}`
      set({ toast: `${changed} (from next turn)` })
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
    /*
     * 화면을 골랐다 = 소개를 지나왔다 (#63).
     *
     * 소개 화면 옆의 사이드바에서 그리드나 오케스트레이터를 누르는 사람은 "설명은
     * 됐고 앱을 쓰겠다"고 말한 것이다. 그 클릭이 화면을 안 바꾸면 버튼이 고장 난
     * 것처럼 보이고, 그렇다고 버튼을 감추면 소개 읽기를 강요하는 셈이 된다 —
     * 대화를 강요하지 않겠다는 이 온보딩의 전제와 정면으로 어긋난다.
     */
    set({ view, introSeen: true })
    get().saveWorkspace()
  },

  async openOrchestrator() {
    const platform = get().platform
    if (!platform) return
    /*
     * 화면부터 바꾼다. 조회가 늦어도 그동안 아무 반응이 없으면 누른 사람은 버튼이
     * 죽은 줄 안다 — 보낸 즉시 '작업 중'으로 두는 것과 같은 이유다.
     */
    // 여기로 들어온 것도 소개를 지나온 것이다 (setView와 같은 이유, #63)
    set({ view: 'orchestrator', introSeen: true })
    get().saveWorkspace()
    try {
      /*
       * **묻기만 한다 — 만들지 않는다** (#63 지연 기동). 화면을 여는 것과 프로세스를
       * 만드는 것이 갈라졌다: 없으면 빈 대화(추천 질문 카드)가 서고, 만드는 것은
       * 첫 질문이 던져지는 순간의 askOrchestrator다. 예전처럼 여기서 만들면
       * 묻지도 않은 사람 몫의 도구 프로세스가 뜬다.
       */
      const info = await platform.agents.orchestratorPeek()
      if (!info) return
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

  async askOrchestrator(text) {
    const platform = get().platform
    if (!platform) return
    let id = get().orchestratorId
    if (!id) {
      // 첫 질문이 곧 탄생이다 (#63) — 카드를 누른 순간에만 프로세스가 뜬다
      set({ orchestratorWaking: true })
      try {
        const info = await platform.agents.orchestrator()
        set((s) => ({
          orchestratorId: info.id,
          sessions: { ...s.sessions, [info.id]: s.sessions[info.id] ?? initialSession({ ...info, projectId: null }) },
        }))
        replayPendingEvents(get)
        id = info.id
      } catch (e) {
        set({ toast: `Could not start the orchestrator: ${(e as Error).message}` })
        return
      } finally {
        set({ orchestratorWaking: false })
      }
    }
    await get().send(id, text)
  },

  async completeIntro(tool) {
    const platform = get().platform
    /*
     * 화면부터 통과시킨다 — 설정 저장이 실패해도 소개 화면에 사람을 가두지 않는다
     * (기본값 claude로 동작한다). 카드 클릭은 설정을 적을 뿐, 프로세스는 안 뜬다.
     */
    set({ introSeen: true })
    get().saveWorkspace()
    try {
      await platform?.agents.configureOrchestrator(tool)
    } catch (e) {
      set({ toast: `Could not save the choice: ${(e as Error).message}` })
    }
    void get().openOrchestrator()
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
              projectId: f.projectId, kind: f.kind, tool: f.tool, name: f.name, autoNamed: f.autoNamed,
              state: f.state, archived: f.archived, live: f.live,
              // lastSeq는 우리가 이벤트로 더 멀리 갔을 수 있다 — 뒤로 감으면 안읽음이 되살아난다
              lastSeq: Math.max(cur.lastSeq, f.lastSeq), lastReadSeq: f.lastReadSeq,
              waitingSince: f.waitingSince, model: f.model, effort: f.effort, verbosity: f.verbosity, permissionPreset: f.permissionPreset,
              worktree: f.worktree,
              parentSessionId: f.parentSessionId, merged: f.worktreeMerged,
              ...liveFactsOf(f),
            }
          : {
              ...initialSession({ id: f.id, projectId: f.projectId, kind: f.kind, name: f.name, tool: f.tool, effort: f.effort, verbosity: f.verbosity, model: f.model, permissionPreset: f.permissionPreset, worktree: f.worktree, parentSessionId: f.parentSessionId, merged: f.worktreeMerged }),
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
    const platform = get().platform
    /*
     * **두 번 누르지 못하게 한다** (도그푸딩).
     *
     * 재시작은 프로세스를 죽이고 다시 띄우는 일이라 몇 초가 걸리는데 그동안 화면은
     * 조용했다. 그래서 사람이 한 번 더 누르고, 두 번째 누름은 **방금 뜬 프로세스를
     * 다시 죽인다** — 고치려고 누른 버튼이 고장을 만드는 자리였다.
     *
     * 자물쇠는 wake·fork가 쓰는 그 `resuming`이다. 셋 다 "이 세션의 프로세스를 지금
     * 갈아 끼우는 중"이라는 같은 사실을 말하므로, 표시등을 따로 두면 한쪽이 도는
     * 동안 다른 쪽 버튼이 멀쩡해 보이는 상태가 생긴다.
     */
    if (!platform || get().resuming[sessionId]) return false
    set((s) => {
      const sessions = { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, state: 'idle' as const } }
      // Restarting ends whatever turn was running — its clock goes with it (issue #23)
      return {
        sessions,
        workingSince: trackWorkingSince(s.workingSince, sessions, Date.now()),
        resuming: { ...s.resuming, [sessionId]: true },
      }
    })
    try {
      const r = await platform.agents.restartSession(sessionId)
      set((s) => ({
        sessions: { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, live: r.resumed } },
        wakeError: r.resumed ? omitKey(s.wakeError, sessionId) : { ...s.wakeError, [sessionId]: r.reason ?? '' },
        toast: r.resumed ? 'Agent restarted' : `Could not restart: ${r.reason ?? ''}`,
      }))
      return r.resumed
    } catch (e) {
      // 던져서 끝나면 자물쇠가 영영 안 풀린다 — 버튼이 죽은 채로 남는다
      set({ toast: `Could not restart: ${(e as Error).message}` })
      return false
    } finally {
      set((s) => ({ resuming: omitKey(s.resuming, sessionId) }))
    }
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
    case 'reasoning_delta': {
      // 텍스트 없는 조각(claude의 토큰 추정)은 대화가 아니라 세션 상태(thinkingTokens)다
      if (!e.text) return items
      const last = items[items.length - 1]
      if (last?.kind === 'reasoning') {
        const copy = items.slice(0, -1)
        return [...copy, { ...last, text: last.text + e.text }]
      }
      return [...items, { kind: 'reasoning', seq: ++chatSeq, text: e.text }]
    }
    case 'tool_call':
      return [...items, { kind: 'tool', seq: ++chatSeq, tool: e.summary.tool, title: e.summary.title, readOnly: e.summary.readOnly }]
    case 'message_image':
      return [...items, { kind: 'image', seq: ++chatSeq, mime: e.mime, data: e.data, path: e.path, note: e.note }]
    case 'tool_result': {
      const idx = [...items].reverse().findIndex((i) => i.kind === 'tool' && i.result === undefined)
      if (idx === -1) return items
      const real = items.length - 1 - idx
      const target = items[real] as Extract<ChatItem, { kind: 'tool' }>
      // live는 여기서 버린다 — 완주한 출력 전체가 result로 왔으므로 조각은 역할이 끝났다
      return items.map((it, i) => (i === real ? { ...target, result: e.summary, ok: e.ok, live: undefined } : it))
    }
    /*
     * 실행 중 출력 (#58). tool_result와 같은 규칙으로 "열려 있는 마지막 도구 줄"에 단다 —
     * codex의 itemId를 ChatItem이 들고 있지 않아서이기도 하고, 열린 호출이 동시에 여럿인
     * 경우가 실측된 적도 없다. 꼬리만 남긴다: 보여줄 것은 "지금 뭐가 나오나"지 전문이 아니다.
     */
    case 'tool_output_delta': {
      const idx = [...items].reverse().findIndex((i) => i.kind === 'tool' && i.result === undefined)
      if (idx === -1) return items
      const real = items.length - 1 - idx
      const target = items[real] as Extract<ChatItem, { kind: 'tool' }>
      const live = ((target.live ?? '') + e.text).slice(-4000)
      return items.map((it, i) => (i === real ? { ...target, live } : it))
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
       *
       * from이 달린 말은 확정 대조에서 뺀다 (FR-11) — 사람이 우연히 같은 문장을
       * pending으로 띄워 뒀다면 오케스트레이터의 지시가 그 말풍선에 흡수되면서
       * 출처 표식이 조용히 사라진다. 텍스트 일치는 내 말끼리만 성립하는 가정이다.
       */
      /*
       * 대조는 **보낸 원문**으로 한다 (#75). 첨부를 📎 라벨로 text에 섞던 시절, 그린 것과
       * 보낸 것이 달라 확정이 안 맞물리고 두 번째 말풍선이 붙었다 (코덱스에서 발견).
       * 지금은 첨부가 별도 필드라 text가 곧 원문이다 — 이 동일성이 이 대조의 전제다.
       */
      const idx = e.from
        ? -1
        : items.findIndex((i) => i.kind === 'user' && i.pending && i.text === e.text)
      if (idx === -1) return [...items, { kind: 'user', seq: ++chatSeq, text: e.text, ...(e.from ? { from: e.from } : {}) }]
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
      const p = m.payload as { text?: string; from?: { sessionId: string; name: string }; attachments?: ChatAttachment[] }
      items.push({
        kind: 'user',
        seq: m.seq,
        text: String(p?.text ?? ''),
        ...(p?.from ? { from: p.from } : {}),
        // 첨부 복원 — 이미지 바이트(data)는 host가 loadMessages에서 파일을 읽어 실어 준다
        ...(p?.attachments?.length ? { attachments: p.attachments } : {}),
      })
    } else if (m.kind === 'text') {
      const e = m.payload as { text?: string }
      const last = items[items.length - 1]
      if (last?.kind === 'assistant') last.text += e.text ?? ''
      else items.push({ kind: 'assistant', seq: m.seq, text: e.text ?? '' })
    } else if (m.kind === 'reasoning') {
      // 델타 행들을 한 덩어리로 (assistant와 같은 규칙)
      const e = m.payload as { text?: string }
      const last = items[items.length - 1]
      if (last?.kind === 'reasoning') last.text += e.text ?? ''
      else items.push({ kind: 'reasoning', seq: m.seq, text: e.text ?? '' })
    } else if (m.kind === 'marker') {
      // 저장된 payload가 곧 그 이벤트다 — 라이브와 복원이 다른 문장을 쓰면 안 된다
      const e = m.payload as Extract<NormalizedEvent, { type: 'compaction' }>
      items.push({ kind: 'mark', seq: m.seq, text: compactionText(e) })
    } else if (m.kind === 'tool_call') {
      const e = m.payload as { summary?: { tool: string; title: string; readOnly: boolean } }
      if (e.summary) items.push({ kind: 'tool', seq: m.seq, tool: e.summary.tool, title: e.summary.title, readOnly: e.summary.readOnly })
    } else if (m.kind === 'image') {
      // 이미지는 영속된다 (#40 2차) — host가 파일에서 바이트를 다시 실어 보낸다
      const e = m.payload as { mime?: string; data?: string; path?: string; note?: string }
      items.push({ kind: 'image', seq: m.seq, mime: e.mime ?? '', data: e.data ?? '', path: e.path, note: e.note })
    }
  }
  return items
}
