import type {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalScope,
  Attachment,
  CreateSessionParams,
  CommandInfo,
  ExternalSession,
  UpdateSettingsParams,
  GitBranch,
  GitCommit,
  GitDiff,
  GitFileStatus,
  NormalizedEvent,
  ProjectInfo,
  SessionInfo,
  StoredMessage,
  UsageSnapshot,
  TerminalInfo,
  CommandRunInfo,
  ToolName,
  ModelOption,
  QuestionAnswer,
  UpdateStatus,
} from '@cc/protocol'

/**
 * Platform 포트 (docs/platform-abstraction.md §2).
 * ui가 아는 유일한 외부 세계. 구현(web/tauri/mock)은 apps 진입점만 안다.
 *
 * 규칙:
 *  - 모든 메서드는 Promise 반환 (동기 구현이라도 — IPC로 바뀌어도 시그니처 불변)
 *  - 스트림은 subscribe(handler): Unsubscribe 형태로 통일
 *  - 입출력 타입은 전부 protocol의 것. 구현 세부(WS 프레임, invoke 이름) 노출 금지
 */

export type Unsubscribe = () => void

export type PlatformError = {
  code: string
  message: string
  retryable: boolean
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'resync_required'

export interface AgentPort {
  createSession(params: CreateSessionParams): Promise<SessionInfo>
  send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>
  /** 붙여넣은 이미지를 저장하고 경로를 받는다 (base64를 대화 기록에 넣지 않기 위해) */
  saveAttachment(sessionId: string, name: string, mime: string, dataBase64: string): Promise<Attachment>
  respondApproval(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
    /** '항상 허용'의 대상 패턴 (core가 계산) */
    matcher?: string,
  ): Promise<void>
  /** 선택지에 답한다 (AskUserQuestion) — 답은 그 도구의 결과로 모델에게 간다 */
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): Promise<void>
  interrupt(sessionId: string): Promise<void>
  /** 사이드바 순서 (사람이 끌어서 정한다). 전체 순서를 통째로 보낸다 */
  reorderSessions(projectId: string, orderedIds: string[]): Promise<SessionInfo[]>
  /**
   * 앱에 하나뿐인 오케스트레이터. **부르면 없을 때 만든다.**
   * 프로젝트에 속하지 않으므로 projectId는 null이다.
   */
  orchestrator(): Promise<SessionInfo>
  /**
   * 있으면 주고, **없으면 만들지 않는다** (#63). 화면을 여는 쪽이 쓴다 —
   * 만드는 것은 사람이 첫 질문을 던지는 순간의 orchestrator()다 (지연 기동).
   */
  orchestratorPeek(): Promise<SessionInfo | null>
  /** 중앙 오케스트레이터가 돌 도구 (#63, 소개 화면의 카드 선택). 생성 전에만 의미가 있다 */
  configureOrchestrator(tool: ToolName): Promise<void>
  /** 그리드 배치 — 추가·제거·순서가 전부 이 한 가지로 온다 */
  grid(): Promise<string[]>
  setGridView(sessionIds: string[]): Promise<string[]>
  /** 고를 수 있는 모델과 각 모델의 추론 강도 (도구가 공식 API로 알려주는 것) */
  models(tool: ToolName): Promise<{ supported: boolean; reason?: string; models: ModelOption[] }>
  /** 목록에서 숨긴다 / 다시 꺼낸다 (삭제와 달리 기록이 남는다) */
  archiveSession(sessionId: string, archived?: boolean): Promise<void>
  /** 세션에 연결된 에이전트만 재시작한다 (대화는 그대로) */
  restartSession(sessionId: string): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }>
  /** 완전 삭제 — 아카이브와 달리 기록도 사라진다 */
  /** 워크트리 세션이면 워크트리까지 지울지 함께 받는다. 기본은 남기는 것 */
  deleteSession(sessionId: string, deleteWorktree?: boolean): Promise<void>
  /** 지워도 되는지 사람에게 묻기 위한 재료. 워크트리 세션이 아니면 null */
  worktreeStatus(sessionId: string): Promise<{ path: string; branch: string; dirty: boolean; changedFiles: number } | null>
  /**
   * 도구가 보관 중인 이전 세션 (터미널에서 만든 것 포함).
   * supported=false면 이유가 함께 온다 — 구버전 도구에서도 '새 세션'은 막지 않는다.
   */
  listExternalSessions(
    projectId: string,
    tool: ToolName,
    limit?: number,
  ): Promise<{ supported: boolean; reason?: string; sessions: ExternalSession[] }>
  /**
   * 죽은 세션을 되살린다 (FR-10). resumed=false면 이유가 함께 온다.
   * `lockedElsewhere`면 이유를 읽지 않고도 "갈라서 이어가기"를 내밀 수 있다.
   */
  resumeSession(
    sessionId: string,
  ): Promise<{ session: SessionInfo; resumed: boolean; reason?: string; lockedElsewhere?: boolean }>
  /**
   * 잠긴 대화에서 갈라져 나와 이 세션으로 이어간다.
   * 원본은 그대로 둔다 — 다른 앱이 쓰던 대화를 빼앗지 않는다.
   */
  forkConversation(sessionId: string): Promise<{ session: SessionInfo; resumed: boolean; reason?: string }>
  /**
   * 세션의 에이전트를 바꾼다 (claude ↔ codex).
   * **대화는 이어지지 않는다** — 새 도구는 옛 대화를 모른다. 기록은 우리 저장소에 남는다.
   */
  switchTool(sessionId: string, tool: ToolName): Promise<SessionInfo>
  /**
   * 모델·권한·추론 강도를 대화 도중에 바꾼다 (FR-7).
   * 항목은 프로토콜이 정한다 — 여기 다시 적으면 늦게 추가된 필드가 조용히 빠진다.
   */
  updateSettings(sessionId: string, settings: Omit<UpdateSettingsParams, 'sessionId'>): Promise<SessionInfo>
  rename(sessionId: string, name: string): Promise<void>
  markRead(sessionId: string, seq: number): Promise<void>
  listSessions(): Promise<SessionInfo[]>
  loadMessages(sessionId: string, limit?: number, beforeSeq?: number): Promise<StoredMessage[]>
  capabilities(tool: ToolName): Promise<AdapterCapabilities>
  /**
   * 이 세션의 슬래시 명령(스킬).
   * ready=false는 '없음'이 아니라 '아직 도구가 준비되지 않았다'는 뜻이다.
   */
  commands(sessionId: string): Promise<{ ready: boolean; commands: CommandInfo[] }>
  /** 계정 사용량·한도 (FR-9). 구독 한도만 다룬다 */
  usage(tool: ToolName): Promise<{ supported: boolean; reason?: string; usage: UsageSnapshot | null }>
  detect(): Promise<{ tool: ToolName; installed: boolean; loggedIn: boolean; detail: string }[]>
  /** 이벤트 스트림 — 구독 시점 이후의 이벤트를 받는다 */
  subscribe(handler: (event: NormalizedEvent) => void): Unsubscribe
  onConnectionChange(handler: (state: ConnectionState) => void): Unsubscribe
}

export interface ProjectPort {
  reorder(orderedIds: string[]): Promise<ProjectInfo[]>
  add(path: string): Promise<ProjectInfo>
  list(): Promise<ProjectInfo[]>
  gitStatus(projectId: string): Promise<ProjectInfo>
  /**
   * Replace this project's saved shell commands, whole (issue #44).
   *
   * Adding and deleting come through the same door, as `reorder` above does: for a short
   * list a person edits by hand, "make it look like this" already states every edit.
   * What comes back is what was actually stored — the host drops blank entries, so it can
   * differ from what was sent.
   */
  setCommands(projectId: string, commands: string[]): Promise<string[]>
  /** 워크트리 프로비저닝 설정 저장 (#69). null이면 지운다 */
  setWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): Promise<void>
}

/**
 * 파일 트리·뷰어 (FR-5, FR-6 / C-1).
 * lazy 목록이 원칙 — 열어본 디렉토리만 읽는다 (대형 저장소에서 가벼움 유지).
 */
export interface FsPort {
  /** `@` 자동완성용 파일 검색 (프로젝트 안에서만) */
  search(projectId: string, query: string, limit?: number): Promise<{ path: string; name: string }[]>
  /** 한 단계만 읽는다. ignored는 .gitignore에 걸리는 항목 (git이 알려준 것을 재사용) */
  listDir(projectId: string, relPath: string): Promise<FsEntry[]>
  /**
   * 감시할 디렉토리 집합을 통째로 바꾼다 (#34). 화면의 펼쳐진 집합이 곧 감시 집합이다.
   * 변화는 이벤트 스트림의 `fs_changed`로 온다 — 이 호출은 등록만 한다.
   */
  watch(projectId: string, paths: string[]): Promise<{ watched: number }>
  readFile(projectId: string, relPath: string): Promise<FsFile>
  /**
   * Move an entry into another folder of the same project (#19, drag inside the tree).
   *
   * `toDir` is a folder (`''` is the project root), never a full path — the gesture is a
   * drop onto a row and the name never changes, which is also why renaming is not reachable
   * from here (out of scope for #19).
   *
   * **Never overwrites**: a destination that is already taken rejects, naming the
   * collision. `moved: false` means it landed where it already was — a miss, not a failure.
   */
  move(projectId: string, from: string, toDir: string): Promise<{ path: string; moved: boolean }>
  /**
   * Put a file dragged in from the desktop into the project (#19).
   *
   * Bytes, not a source path: the webview does not tell the page where a dropped file came
   * from, which is the same reason attachments already travel this way. So the original
   * stays where it was — the only direction that cannot destroy something outside the
   * project. Rejects rather than overwrite, like `move`.
   */
  importFile(projectId: string, toDir: string, name: string, dataBase64: string): Promise<{ path: string }>
  /**
   * Move to the OS trash (#18). **Not a delete** — that is the whole decision: the trash
   * stays reversible *after* the click, which is worth more than a dialog before it.
   *
   * `supported: false` comes with a reason the UI can show, the same shape `models()` uses.
   * A browser has no trash and cannot be given one.
   */
  trash(projectId: string, relPath: string): Promise<{ supported: boolean; reason?: string }>
  /** Show it in the desktop's file manager (#19). Unsupported in a browser, with a reason */
  reveal(projectId: string, relPath: string): Promise<{ supported: boolean; reason?: string }>
}

/** 무엇 때문에 부르는지 — 소리와 독 튀김의 세기가 여기서 갈린다 */
export type AlertKind = 'approval' | 'error' | 'done' | 'all_done'

export type FsEntry = { name: string; path: string; isDir: boolean; ignored: boolean }
export type FsFile = { text: string; truncated: boolean; binary: boolean; bytes: number }

export interface SystemPort {
  notify(title: string, body: string): Promise<void>
  /**
   * 소리와 독 아이콘으로 부른다.
   *
   * `notify`(OS 배너)와 나눠 둔 이유는 **닿는 경로가 다르기** 때문이다. 배너는 알림 권한과
   * 코드 서명을 타지만 이쪽은 아무것도 타지 않는다. macOS에서 배너 경로가 죽어 있는 것을
   * 실측한 뒤로, 자리를 비운 사람에게 실제로 닿는 것은 이쪽이다.
   */
  alert(kind: AlertKind, sound: boolean): Promise<void>
  setBadge(count: number): Promise<void>
  openInIde(path: string, line?: number): Promise<void>
  /** 디렉토리 선택. 데스크톱은 네이티브 피커, 웹 dev는 경로 입력으로 폴백한다 (FR-19) */
  pickDirectory(): Promise<string | null>
  /**
   * 지금부터 창을 끈다 (타이틀바를 숨겼으므로 우리가 손잡이를 만들어야 한다).
   * data-tauri-drag-region만으로는 부족하다 — 그 속성은 **mousedown 타깃 자신**에
   * 있어야 해서, 헤더 안의 글자를 잡으면 죽는다. 실제로 "가끔만 된다"로 나타났다.
   * 웹에서는 아무 일도 하지 않는다.
   */
  startWindowDrag(): Promise<void>
}

export type PlatformCapabilities = {
  osNotifications: boolean
  dockBadge: boolean
  globalShortcuts: boolean
  processSupervision: boolean
  openInIde: boolean
  /**
   * How many px the OS window controls occupy at the left edge of our own top bar.
   *
   * macOS puts the traffic lights *inside* the overlay title bar, so our bar has to
   * leave a hole for them; other desktops draw their decorations in a separate strip
   * and the bar owns the full width. This used to be a hardcoded `pl-[86px]` in the
   * header, which is the exact shape of leak this package exists to prevent: the number
   * is a fact about the window manager, not about the design. Asking for a width rather
   * than an OS name keeps ui free of platform checks.
   */
  windowControlsInset: number
  /**
   * What this machine's keyboard prints on the modifier keys we put on screen.
   *
   * Every shortcut handler already accepts `metaKey || ctrlKey`, so the keys have always
   * worked on Linux and Windows — only the labels lied, and they lied in 61 places because
   * `⌘` was written out at every call site. A symbol nobody's keyboard has is worse than
   * no hint at all: it tells you the app is not for you.
   *
   * Asking for the *labels* rather than for an OS name is the same trade as
   * `windowControlsInset` above, for the same reason: ui is the one package with no
   * platform implementation behind it, so an OS check there is invisible to every test we
   * run (`tooling/styles.test.ts` fails the build if one appears).
   *
   * `⇧` is deliberately absent — it is printed on those keyboards too, so there is nothing
   * to translate and no reason to make the port carry it.
   */
  shortcutKeys: ShortcutKeys
  /**
   * What this desktop calls the thing that shows you a file in a folder (#19).
   *
   * Same trade as `shortcutKeys` above: "Reveal in Finder" is the phrase everyone knows on
   * a Mac and a lie everywhere else, and ui is not allowed to ask which OS it is on — so it
   * asks for the *word* and prints it. Linux has no single answer (Nautilus, Dolphin,
   * Thunar…), so the generic phrase is the honest one there rather than a guess.
   */
  fileManagerName: string
}

/**
 * 자판이 두 조합키를 뭐라고 부르는가, 그리고 조합을 한 덩어리로 쓸 때 사이에 뭘 넣는가.
 *
 * `join`이 있는 이유: 맥은 `⌘⇧A`처럼 붙여 쓰지만, 그 규칙을 그대로 옮기면 다른 자판에서는
 * `CtrlShiftA`가 된다. 붙여 쓰기는 기호였기 때문에 읽혔던 것이라, 이름이 되는 순간 구분자가
 * 필요하다 — 자판을 아는 쪽이 함께 답한다.
 */
export type ShortcutKeys = {
  /** `⌘` here, `Ctrl` where there is no command key */
  mod: string
  /** `⌥` here, `Alt` elsewhere */
  alt: string
  /** What goes between keys when a combination is written as one string */
  join: string
}

/**
 * 깃 조회·조작 (FR-4, B-1 신설).
 * 구현은 host의 dev-services에 있다 — git2(Rust) 이관은 측정으로 병목이 확인될 때까지 보류.
 */
export interface GitPort {
  status(projectId: string): Promise<GitFileStatus[]>
  diff(projectId: string, path: string, staged?: boolean): Promise<GitDiff>
  log(projectId: string, limit?: number): Promise<GitCommit[]>
  commitDetail(projectId: string, sha: string): Promise<{ files: string[]; diff: string; truncated: boolean }>
  branches(projectId: string): Promise<GitBranch[]>
  /** dryRun이면 무엇이 충돌하는지만 알려준다 (막지 말고 보이게) */
  checkout(projectId: string, branch: string, dryRun?: boolean): Promise<{ ok: boolean; conflicts: string[]; message?: string }>
  stage(projectId: string, paths: string[], unstage?: boolean): Promise<void>
  commit(projectId: string, message: string): Promise<{ ok: boolean; message?: string }>
  push(projectId: string): Promise<{ ok: boolean; message?: string }>
}

/** 워크스페이스 스냅샷 (C-3) — 창을 껐다 켜도 보던 자리로 돌아온다 */
export type WorkspaceSnapshot = {
  focusedSessionId?: string | null
  /**
   * Which of the three views was showing — focus, grid, or orchestrator. Restoring the
   * focused session without this landed a person who quit from the grid back in the focus
   * view: the *session* came back but the *way of looking* did not, which reads as the app
   * forgetting. Loosely typed like panelLayout: a snapshot is a file, the UI validates.
   */
  view?: string
  /** 증거 패널(깃·파일)이 열려 있었는가 */
  panelOpen?: boolean
  /** What the evidence panel was showing — pre-#20 single-tab field, kept for old snapshots/builds */
  panelTab?: string
  /**
   * The panel's tab arrangement (#20): vertically stacked groups, each an ordered tab
   * list plus its active tab. One arrangement for the whole app — the panel is a way
   * of looking, not project state. Loosely typed here on purpose: a snapshot is a file
   * on disk, and the UI sanitizes whatever comes back (store/panelLayout.ts).
   */
  panelLayout?: { tabs: string[]; active: string }[]
  /** 증거 패널 폭(px) */
  panelWidth?: number
  /** 세션 목록 폭(px) */
  sidebarWidth?: number
  /** 전체 글자 크기 단계 (TEXT_SCALES 인덱스, 0..4) — 보는 방식이라 여기 실린다 */
  textScale?: number
  /** @deprecated 탭 구조는 3레인으로 대체됐다. 구버전 스냅샷을 읽을 때만 나타난다 */
  tab?: string
}

/** 대화 검색·승인 규칙 관리 (E-1, E-4) */
export interface SearchPort {
  messages(query: string, limit?: number): Promise<{ sessionId: string; seq: number; snippet: string }[]>
}

export interface ApprovalRulesPort {
  list(): Promise<{ id: number; scope: string; matcher: string; decision: string; createdAt: number }[]>
  remove(id: number): Promise<void>
}

/**
 * 앱 자체의 업데이트 (이슈 #43).
 *
 * **확인도 설치도 전부 저쪽(host)에서 한다.** 레지스트리에 묻고 `npm i -g`를 돌리는 것은
 * 브라우저가 할 수 없는 일이고, 무엇보다 확인을 실행기(launcher)에 맡기면 사용자 기계에
 * 이미 깔린 낡은 사본이 답하게 된다 — 그 사본의 비교가 틀려 있었던 것이 #42다.
 *
 * 포트가 나르는 것은 상태 하나뿐이다. 화면은 "지금 어디쯤인가"만 알면 되고,
 * **재시작은 절대 이쪽에서 하지 않는다** — 앱은 사람에게 말하고 거기서 멈춘다.
 */
export interface UpdatePort {
  /** 지금 아는 것. `force`면 레지스트리에 다시 묻는다 (설정의 '지금 확인') */
  status(force?: boolean): Promise<UpdateStatus>
  /** 주기 확인을 켜고 끈다 */
  setAuto(enabled: boolean): Promise<UpdateStatus>
  /**
   * 새 버전을 설치한다. **사람이 눌렀을 때만.**
   *
   * 시작하자마자 답한다 — `npm i -g`는 RPC 제한 시간을 넘기기 일쑤라, 끝을 기다리는
   * 계약으로 두면 실제로는 성공한 설치가 화면에서는 실패로 보인다. 나머지는 이벤트로 온다.
   */
  apply(): Promise<UpdateStatus>
}

export interface WorkspacePort {
  save(snapshot: WorkspaceSnapshot): Promise<void>
  load(): Promise<WorkspaceSnapshot | null>
}

/**
 * 프로젝트 터미널.
 *
 * **정체성은 cwd다** — 세션이 아니다. 같은 프로젝트에서 세션을 바꿔도 같은 터미널들이
 * 이어지고, 깃 워크트리 세션은 cwd가 달라 자기 터미널을 자동으로 갖는다.
 */
export interface TerminalPort {
  /** 그 프로젝트의 터미널 목록 (history로 화면을 되살린다) */
  list(projectId: string): Promise<TerminalInfo[]>
  /** 터미널을 하나 더 연다 */
  create(projectId: string, cols: number, rows: number): Promise<TerminalInfo>
  /** 터미널 하나를 닫는다 */
  close(terminalId: string): Promise<void>
  input(terminalId: string, data: string): Promise<void>
  resize(terminalId: string, cols: number, rows: number): Promise<void>
  /** 셸이 먹통일 때 다시 띄운다 (기록은 남는다) */
  restart(terminalId: string, cols: number, rows: number): Promise<TerminalInfo>
  onOutput(handler: (e: { terminalId: string; data: string }) => void): Unsubscribe
  onExit(handler: (e: { terminalId: string; exitCode: number | null }) => void): Unsubscribe
}

/**
 * 자주 쓰는 명령어 실행기 (#60). 터미널 탭과 별개의 실행 경로다 —
 * 명령별 프로세스 하나, 마지막 실행 로그 하나 (host 수명 동안).
 * 출력 스트림은 terminal.onOutput/onExit을 그대로 탄다 (runId가 terminalId 자리).
 */
export interface CommandRunPort {
  /** 실행. 같은 명령이 돌고 있으면 죽이고 새로 시작한다 */
  run(projectId: string, command: string, cols: number, rows: number): Promise<CommandRunInfo>
  /** 데브 서버를 끈다. 로그는 남는다 */
  stop(projectId: string, command: string): Promise<void>
  /** 실행된 적 있는 명령들의 상태 (목록 뱃지용) */
  state(projectId: string): Promise<CommandRunInfo[]>
  /** 마지막 실행, 로그째. 실행된 적 없으면 null */
  log(projectId: string, command: string): Promise<(CommandRunInfo & { history: string }) | null>
  resize(projectId: string, command: string, cols: number, rows: number): Promise<void>
}

export interface Platform {
  agents: AgentPort
  projects: ProjectPort
  system: SystemPort
  git: GitPort
  fs: FsPort
  search: SearchPort
  rules: ApprovalRulesPort
  workspace: WorkspacePort
  updates: UpdatePort
  terminal: TerminalPort
  commands: CommandRunPort
  capabilities: PlatformCapabilities
  dispose(): Promise<void>
}
