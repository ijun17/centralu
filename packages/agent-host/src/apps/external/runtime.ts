import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CallToolResult, ListResourcesResult, PriorDiscovery, ReadResourceResult, Tool } from '@modelcontextprotocol/client'
import type { AppReview, ExternalAppInfo } from '@cc/protocol'
import { proposedMcpServerNameError } from '../contract.js'
import { DirWatchers } from '../../dev-services/watch.js'
import { AppProcess, AppStartError, type SpawnSpec } from './app-process.js'
import { BROKER_KEEPALIVE_MS, RUN_META, serveBroker } from './broker.js'
import { BrokerDesk, type BrokerHost, type CapabilityDecisionListed, type CapabilityOrigin } from './desk.js'
import { memoryCapabilityBook, type CapabilityBook } from './capabilities.js'
import { checkScreen, checkTools, formatReport, type AppCheckReport, type CheckFinding, type CheckedTool } from './check.js'
import { ERRORS_KEPT, errorBundle, type AppErrorBundle } from './errors.js'
import { folderFingerprint } from './fingerprint.js'
import { PROJECT_APPS_PARTS, PROJECT_APPS_REL, USER_APPS_PARTS, USER_APPS_REL, scanApps, type ScannedApp } from './discovery.js'
import { MANIFEST_FILE, MANIFEST_VERSION, parseManifest, toolNameError, type AppManifest } from './manifest.js'
import { FAILURES_KEPT, RUN_RETENTION_MS, describeArgs, type AgentUse, type AppRunListed, type RunLedger } from './runs.js'
import { appTemplateDir, ensureDirInside, oneLine, scaffoldApp } from './scaffold.js'
import { SecretStore, redactor, secretValueProblem } from './secrets.js'
import type { AppRef } from './ref.js'
import { AppHandover, type HandoverOptions } from './handover.js'
import type { Snapshot } from './versions.js'
import { resourceUriOf, visibilityOf, type Audience } from './visibility.js'

/**
 * 외부 앱 런타임 (M4 A) — **코어가 외부 앱에 대해 아는 문은 이 파일 하나다.**
 *
 * 내장 앱(`registry.ts`의 HOST_APPS)은 컴파일된 모듈이고, 외부 앱은 실행 중에 발견되는
 * 폴더와 그 폴더가 띄우는 프로세스다. 둘은 사는 방식이 달라 명부도 다르지만, 코어가 앱을
 * 아는 길이 좁아야 한다는 규칙(#81)은 같다 — 그래서 이 런타임은 코어를 임포트하지 않고,
 * 필요한 것(프로젝트 목록과 신뢰, 데이터 폴더)을 `ExternalAppsDeps`로 **받는다.**
 * #97이 UI 런타임에서 한 뒤집기와 같다: 런타임이 필요한 것을 선언하고 host가 채운다.
 *
 * 저장소(Store)도 임포트하지 않는다. 프로젝트와 신뢰는 함수로 묻는다 — 매번 묻는 이유는
 * 정본이 저장소 하나라서다. 여기에 사본을 들고 있으면 신뢰를 끈 뒤에도 사본이 "예"라고 답한다.
 */

/**
 * 사용자 폴더 앱의 범위 이름 — 메모리의 키이자 데이터·로그 폴더의 한 칸이다.
 * 프로젝트 id는 UUID라 이 이름과 겹치지 않는다.
 */
const USER_SCOPE = '_user'

export type { AppRef } from './ref.js'

/** 점검 보고서의 모양도 이 문으로 나간다 (C-3) */
export type { AppCheckReport, CheckFinding } from './check.js'
/** 오류 묶음의 모양 (C-6) */
export type { AppErrorBundle } from './errors.js'
/** 중개의 몸통 가운데 host의 코어가 채우는 것 (D) — 매니저가 `attachBrokerHost`로 준다 */
export type { AgentRunRequest, AgentRunResult, BrokerHost, CapabilityOrigin, CapabilityQuestion, CapabilityDecisionListed } from './desk.js'
/** 능력 승인의 답을 둘 자리 (D-4) — host가 저장소로 채운다(`app-permission-book.ts`) */
export type { CapabilityBook, CapabilityDecision } from './capabilities.js'
/** host 데이터의 닫힌 목록 (D-3) — 매니저가 이름마다 무엇을 줄지 채운다 */
export { HOST_CAPABILITIES, type HostCapability } from './capabilities.js'

/** 기록의 모양은 이 문으로 나간다 — 코어가 채울 자리다(main.ts, `app-run-ledger.ts`) */
export type { RunLedger, AppRunRow, AppRunListed, AgentTokens, AgentUse } from './runs.js'
/** 도구가 선언한 화면을 읽는 규칙도 이 문으로 나간다 — 대화 안 화면(B-1)이 고정 화면과 같은 판정을 쓴다 */
export { resourceUriOf } from './visibility.js'

/**
 * 누가 불렀나 (플랜 "호출 경로는 하나다") — 셋이다.
 *
 *   view     앱의 화면. v1 플랜은 이것을 "사람"이라 적었는데 틀렸다 — 화면은 앱의 코드라서
 *            아무도 누르지 않아도 도구를 부를 수 있다. 어느 화면인지(`instanceId`)는 "바뀌었다"의
 *            주인으로만 쓴다 — 그 화면은 자기가 낸 바뀜을 다시 듣지 않는다(B-5)
 *   session  세션의 에이전트 (A-5가 붙인다)
 *   app      다른 앱의 중개 호출 (D-2) — 부모 실행 id로 사슬이 이어진다
 */
export type AppCaller =
  | { kind: 'view'; instanceId?: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'app'; parentRunId: string }

export type AppRunStatus = 'ok' | 'error' | 'cancelled' | 'rejected'

/**
 * 호출 하나의 결말. **정책의 거절은 던지지 않고 돌려준다** — 거절도 기록되는 결말이고
 * (A-6), 부른 쪽(RPC·세션 대리 서버)은 그것을 "실패한 도구 호출"로 옮겨 주기만 하면 된다.
 *
 *   ok         앱이 답했다
 *   error      앱이 실패를 답했거나(isError), 뜨지 못했거나, 호출 중에 죽었다
 *   cancelled  부른 쪽이 취소했다 — 앱에는 notifications/cancelled가 갔다
 *   rejected   host가 앱에 보내지 않았다 (공개 범위·신뢰·없는 도구·멈춘 앱·열려 있지 않은 부모)
 */
export type AppCallOutcome = {
  runId: string
  status: AppRunStatus
  /** 앱의 답 그대로 (화면의 AppBridge가 받는 모양) — 답이 없었으면 null */
  result: CallToolResult | null
  error: string | null
  durationMs: number
}

/**
 * 수명의 숫자들. 기본값이 제품의 값이고, 테스트는 줄여서 쓴다.
 */
export type RuntimeTiming = {
  /** 열린 화면도 진행 중인 호출도 없으면 이만큼 뒤에 내린다 (플랜 A-3: 5분) */
  idleMs: number
  /** n번째 연속 실패 뒤 다음 기동까지 base × 2^(n-1) */
  backoffBaseMs: number
  /** 연속 실패가 이만큼이면 멈추고 이유를 들고 있는다 (플랜 A-3: 3번) */
  maxFailures: number
  /** 이만큼 살아 있다가 죽었으면 연속 실패를 새로 센다 */
  stableMs: number
  /** 표준 입력과 fd 3을 닫은 뒤 스스로 끝나기를 기다리는 시간 */
  graceMs: number
  /** 세대 탐색(`server/discover`)에 답이 없을 때 옛 세대로 내려가기까지 */
  probeTimeoutMs: number
  /** 연결과 첫 도구 목록 각각의 상한 */
  connectTimeoutMs: number
  /**
   * host → 앱 도구 호출 하나의 상한. 앱이 진행 알림을 보내면 다시 센다. 부르는 쪽마다 제 상한이
   * 따로 있다(Codex 300초, 화면 60초 — 플랜 "오래 걸리는 호출"); 이것은 그 바깥의 울타리다.
   */
  callTimeoutMs: number
  /** 앱별 로그 파일 한 세대의 크기 */
  logMaxBytes: number
  /**
   * 점검(C-3)이 진행 중인 호출이 끝나기를 기다리는 상한. 넘으면 다시 띄우지 않고 떠 있는 프로세스를 본다 —
   * 호출을 끊지 않는다는 약속이 점검보다 앞선다.
   */
  checkDrainMs: number
  /**
   * 만드는 세션이 없거나 쉬고 있을 때, 앱 폴더의 마지막 변화 뒤 이만큼 조용하면 다시 띄운다 (C-4). 편집기의 저장
   * 여러 번이 한 번의 재시작이 된다.
   */
  reloadQuietMs: number
  /** 만드는 세션의 턴 끝 알림을 모으는 시간 (C-4) — 턴 끝과 상태 변화가 잇달아 와도 한 번 다시 띄운다 */
  turnEndDebounceMs: number
  /** 기다리는 중개 호출에 살려 두는 진행 알림을 보내는 간격 (D) — `broker.ts`의 BROKER_KEEPALIVE_MS 주석 */
  brokerKeepaliveMs: number
  /**
   * 능력 승인(D-4)에 사람의 답을 기다리는 상한. 넘으면 거절로 닫는다(기억하지 않는다). 5분인 이유: 물음은 사람이 보는 자리(세션의
   * 카드, 앱의 고정 화면)에 서지만 사람이 늘 거기 있지는 않다. 그동안 부탁한 앱의 호출과 그 위의 사슬이 모두 붙들린다 — 더
   * 길면 사람이 떠난 자리에서 호출이 쌓이고, 더 짧으면 화면을 옮겨 다니는 사람이 답하기 전에 닫힌다.
   */
  capabilityQuestionMs: number
  /** 한 앱이 에이전트를 몇 번 세웠나를 세는 창 (D-5, `AGENT_RUNS_PER_WINDOW`) — 1분. 시험이 줄인다 */
  agentRateWindowMs: number
}

export const DEFAULT_TIMING: RuntimeTiming = {
  idleMs: 5 * 60_000,
  backoffBaseMs: 1_000,
  maxFailures: 3,
  stableMs: 60_000,
  // S-5 실측: 잘 만든 앱은 입력이 닫히고 2~11ms 안에 끝났다. 2초면 느린 정리도 넉넉하다
  graceMs: 2_000,
  /*
   * 탐색에 **답하지 않는** 2025 세대 서버만 이 시간을 낸다(모르는 메서드라고 답하는 서버는
   * 즉시 내려간다 — 공식 v1 SDK 서버는 218ms에 legacy로 붙었다). 알아낸 세대는 앱마다
   * 기억하므로 이 값은 host가 뜬 뒤 앱마다 많아야 한 번이다.
   */
  probeTimeoutMs: 10_000,
  connectTimeoutMs: 30_000,
  callTimeoutMs: 10 * 60_000,
  logMaxBytes: 1024 * 1024,
  checkDrainMs: 30_000,
  reloadQuietMs: 2_000,
  turnEndDebounceMs: 300,
  brokerKeepaliveMs: BROKER_KEEPALIVE_MS,
  capabilityQuestionMs: 5 * 60_000,
  agentRateWindowMs: 60_000,
}

export type ExternalAppsDeps = {
  /** 등록된 프로젝트의 뿌리와 신뢰 — 부를 때마다 저장소에서 읽는다 */
  projects(): readonly { id: string; path: string; trusted: boolean }[]
  /** host의 데이터 폴더 (`dataRoot()`) — 사용자 앱과 앱 데이터가 이 아래에 산다 */
  dataRoot: string
  /** 외부 앱이 가져갈 수 없는 id — 내장 앱의 id. 같은 이름이면 `apps.invoke`가 갈라진다 */
  reservedIds: readonly string[]
  /** 폴더 감시 플러시 간격 (테스트가 줄인다) */
  watchFlushMs?: number
  timing?: Partial<RuntimeTiming>
  /** 앱 프로세스가 물려받을 환경 (기본 process.env) — host 자신의 변수는 걸러진다 */
  env?: NodeJS.ProcessEnv
  /**
   * 앱의 도구 호출이 끝났다(앱에 닿은 호출만 — 거절은 아무것도 바꾸지 않았다. 읽기만 하는 도구도 마찬가지다). 열린
   * 화면이 같은 값을 보게 하는 신호다(플랜 "열린 화면이 같은 값을 보는 법"). host가 방송으로 옮긴다.
   * `cause`는 그 호출을 한 쪽이다 — 앱이 다시 떠서 바뀐 것처럼 호출이 아니면 없다(모든 화면이 듣는다).
   */
  emitChanged?: (ref: AppRef, cause?: AppCaller | null) => void
  /** 실행 기록을 둘 자리 (A-6) — host가 저장소로 채운다. 없으면 기록하지 않는다 */
  runs?: RunLedger
  /**
   * 능력 승인의 답을 둘 자리 (D-4) — host가 저장소로 채운다. 없으면 메모리에 둔다: host가 떠 있는 동안은 한 번 묻는다는
   * 약속이 서고, 다시 뜨면 다시 묻는다.
   */
  permissions?: CapabilityBook
  /** 새 앱을 펼칠 템플릿 폴더 (C-1). 기본은 제품이 싣고 다니는 것(`appTemplateDir`) */
  templateDir?: string
  /**
   * 이 앱의 만드는 세션이 지금 턴 안에 있나 (C-4) — host가 세션 상태로 채운다. 있으면 앱 폴더가 바뀌어도 바로
   * 다시 띄우지 않고 턴 끝(`builderTurnEnded`)을 기다린다. 없으면(편집기에서 고쳤다) 조용해지기를 기다린다.
   */
  builderBusy?: (ref: AppRef) => boolean
  /** 건네기(E)의 상한과 내려받기 — 시험이 줄이고 가짜를 꽂는다. 없으면 제품의 값이다 */
  handover?: HandoverOptions
}

type Scope = { key: string; projectId: string | null; root: string; trusted: boolean }

/** 한 앱의 수명 — 프로세스는 오고 가도 이 칸은 앱이 목록에 있는 동안 산다 */
type Life = {
  proc: AppProcess | null
  starting: Promise<AppProcess> | null
  /** 연속 실패 수 — 기동 실패와 예고 없는 종료를 센다 */
  failures: number
  /** 다음 기동이 이 시각 전에는 일어나지 않는다 (지수 백오프) */
  retryAt: number
  /** 마지막 실패의 이유 (표준에러 끝부분 포함) */
  lastError: string | null
  /** 멈췄다 — maxFailures번 연달아 실패했다. 사람이 다시 시작하기 전까지 뜨지 않는다 */
  gaveUp: boolean
  /** 알아낸 규격 세대 — 다음 기동은 탐색 없이 붙는다 */
  verdict: PriorDiscovery | undefined
  /**
   * 세대 번호. 내리거나 바뀔 때마다 올린다 — 진행 중이던 기동이 끝났을 때 번호가 다르면
   * 그 프로세스는 이미 쓸모없는 것이라 버린다(바뀐 매니페스트로 떠야 할 앱이 옛 명령으로 뜨지 않게).
   */
  epoch: number
  inflight: number
  /** inflight가 0이 되기를 기다리는 쪽 — 점검(C-3)은 진행 중인 호출을 끊지 않고 기다린 뒤 다시 띄운다 */
  idleWaiters: (() => void)[]
  /**
   * 마지막으로 띄운 프로세스가 본 앱 폴더의 지문 (C-4) — 한 번도 띄우지 않았으면 null. 반영은 지금 폴더와 이것을
   * 대 보고, 다르면 다시 띄운다. 프로세스가 내려가도 남는다: 쉬다 내려간 뒤에 고친 것도 "바뀌었다"다.
   */
  stamp: string | null
  /**
   * 마지막으로 **떠 오른** 프로세스가 읽은 지문 (C-4) — 목록의 `codeStamp`. `stamp`와 달리 못 뜬 기동에는 바뀌지 않는다:
   * 열린 화면은 떠 있는 코드와 대조해 옛 HTML인지를 가린다. 못 뜬 새 코드로 화면을 다시 열면 보이는 것은 실패뿐이다.
   */
  loaded: string | null
  idle: NodeJS.Timeout | null
  /** 지금 프로세스의 도구 목록(이름·공개 범위 규칙을 통과한 것)과, 걸러 낸 이유 */
  tools: AppTool[] | null
  toolWarnings: string[]
  /**
   * 마지막으로 읽은 도구 목록 — `tools`와 달리 **프로세스가 내려가도 남는다** (A-5).
   *
   * 세션에 앱을 붙이려면 도구 목록이 있어야 하는데, 목록을 알려면 앱을 띄워야 한다. 세션이 뜰
   * 때마다 붙은 앱을 전부 띄우면 "아무것도 안 할 때 앱 프로세스 0개"(성능 예산)가 세션 하나에
   * 깨진다. 한 번 읽은 목록은 기억해 두고, 앱이 다시 뜰 때 새로 읽어 바뀌었으면 알린다.
   * 매니페스트가 바뀌면 항목이 새로 서므로 옛 목록은 함께 사라진다.
   */
  known: AppTool[] | null
  /**
   * 지금 프로세스의 파이프 번호. 열린 실행은 자기가 태어난 파이프 번호를 들고 있고, 중개는
   * 같은 번호의 실행만 받는다 — 앱이 다시 떠도 죽은 프로세스의 실행 id가 새 파이프에서 통하지 않는다.
   */
  pipeId: number
}

type AppTool = { tool: Tool; visibility: Audience[] }

/** 지금 열려 있는 host → 앱 호출 */
type OpenRun = {
  entry: AppEntry
  pipeId: number
  tool: string
  /** 누가 불렀나 — 사슬을 따라 올라가 누가 시작했는지 찾는 근거다 (D-4의 물음이 설 자리) */
  caller: AppCaller
  /** 호출이 끝나거나 취소되면 선다 — 이 실행 아래의 중개 일이 함께 멈춘다 */
  abort: AbortController
}

type AppEntry = {
  ref: AppRef
  scope: Scope
  /** 발견이 본 그대로 — 다음 훑기와 비교하는 기준이다 */
  found: ScannedApp
  dir: string
  /** 발견의 판정 위에 런타임의 판정(예약된 id)까지 얹은 결과 */
  manifest: AppManifest | null
  error: string | null
  warnings: string[]
  life: Life
}

/**
 * 도구 실패 뒤 표준에러를 한 번 더 옮겨 담기까지 (C-6). 앱이 던진 스택은 표준에러로, 실패 답은 표준출력으로 가서
 * 도착 순서가 정해져 있지 않다. 같은 기계의 파이프라 몇 밀리초면 둘 다 온다.
 */
const STDERR_SETTLE_MS = 150

/** 물으면 답하는 오류 묶음 — 만드는 세션에 보냈으면 그 때가 붙는다 (C-6) */
export type SentErrorBundle = AppErrorBundle & { sentAt: number | null }

/** 보낸 묶음의 열쇠 — 한 앱에서 묶음은 (종류, 때)로 하나다. 표준에러를 다시 담아 갈아 끼워져도 같은 열쇠다 */
const sentKey = (holdKey: string, b: Pick<AppErrorBundle, 'kind' | 'at'>): string => `${holdKey}\n${b.kind}\n${b.at}`

/** 부를 수 없는 앱 — 이유가 곧 메시지다 */
export class AppUnavailableError extends Error {
  readonly code = 'internal'
}

export class ExternalApps {
  /** 범위 키 → (앱 id → 항목) */
  private scopes = new Map<string, { scope: Scope; apps: Map<string, AppEntry> }>()
  private watchers: DirWatchers
  private disposed = false
  private timing: RuntimeTiming
  private secrets: SecretStore
  /** 실행 id → 열린 실행. 중개의 문지기가 여기에 묻는다 */
  private openRuns = new Map<string, OpenRun>()
  /**
   * (범위, 앱 id) → 열린 화면 수. 앱 칸(AppEntry)이 아니라 이름에 묶는다: 매니페스트가 바뀌면
   * 칸은 새로 서지만 사람 앞의 화면은 그대로 열려 있다. 칸에 두면 새 칸은 화면을 0개로 알고,
   * 화면이 열린 앱을 쉬는 앱으로 내린다.
   */
  private viewHolds = new Map<string, number>()
  private pipeSeq = 0
  /** `onAppsChanged` 구독자와, 이번 틱에 알림이 이미 잡혀 있는가 */
  private appsListeners = new Set<() => void>()
  private appsNotePending = false
  /** 반영의 시계 (C-4) — 앱 이름(holdKey)마다. 매니페스트가 바뀌어 칸이 새로 서도 이어진다 */
  private turnEndTimers = new Map<string, NodeJS.Timeout>()
  private quietTimers = new Map<string, NodeJS.Timeout>()
  /** 진행 중인 반영 — 겹쳐 부르면 같은 것을 기다린다 */
  private reloading = new Map<string, Promise<boolean>>()
  /** 앱 이름(holdKey)마다 최근 오류 묶음, 최근 것부터 (C-6) — 매니페스트가 바뀌어 칸이 새로 서도 이어진다 */
  private errorLog = new Map<string, AppErrorBundle[]>()
  /**
   * 만드는 세션에 보낸 묶음 → 보낸 때 (C-6). 묶음에 적지 않고 따로 드는 이유: 도구 실패의 묶음은 표준에러를 조금 뒤에
   * 다시 옮겨 담으며 **새 객체로 갈아 끼워진다**(recordError) — 묶음에 적은 표시는 그때 사라진다.
   */
  private errorsSent = new Map<string, number>()
  /**
   * 이 런타임이 띄운 프로세스 전부 — 아직 끝나지 않은 것. 칸(`Life.proc`)이 들고 있는 것만이 아니다: 매니페스트가 바뀌어
   * 새 칸이 선 뒤 호출을 마치기를 기다리는 옛 프로세스(`haltWhenDrained`), 점검·반영이 내리는 중인 프로세스는 어느 칸에도
   * 없다. `dispose`는 칸이 아니라 이 목록을 끝낸다 — 칸만 끝내면 그런 프로세스가 host가 끝난 뒤 launchd 아래 고아로
   * 남는다(점검·반영 시험을 뒤집어 돌린 뒤 픽스처 앱 셋이 그렇게 남아 있었다).
   */
  private spawned = new Set<AppProcess>()
  /**
   * 중개 창구 (D) — 앱이 fd 3으로 부탁한 것을 푸는 한 자리. 앱끼리의 호출(D-2)은 이 런타임의 단 하나의 길(`call`)로 간다.
   * 생성자에서 세운다 — 답을 둘 자리(`deps.permissions`)와 기다림의 상한(`timing`)이 그때 정해진다.
   */
  private desk: BrokerDesk
  /** 건네기 (E) — 가져온 앱의 대기실과 사람의 확인(`handover.ts`) */
  private handover: AppHandover

  constructor(private deps: ExternalAppsDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
    this.desk = new BrokerDesk(
      {
        has: (ref) => this.find(ref) !== undefined,
        name: (ref) => this.find(ref)?.manifest?.name ?? ref.appId,
        redactor: (ref) => redactor(this.secrets.all(this.appKey(ref))),
        origin: (runId) => this.chainOrigin(runId),
        chain: (runId) => this.chainOf(runId),
        call: (ref, tool, args, caller, opts) => this.call(ref, tool, args, caller, opts),
      },
      deps.permissions ?? memoryCapabilityBook(),
      () => ({ questionMs: this.timing.capabilityQuestionMs, agentRateWindowMs: this.timing.agentRateWindowMs }),
      deps.runs ?? null,
    )
    this.secrets = new SecretStore(deps.dataRoot)
    this.watchers = new DirWatchers((key) => this.rescan(key), deps.watchFlushMs)
    /*
     * 기동에 한 번: 끝을 못 본 실행을 닫고, 보관 기간 밖을 걷는다. 지금이 안전한 순간이다 —
     * 이 host가 연 실행은 아직 하나도 없다.
     */
    const settled = deps.runs?.settleUnfinished('the host stopped before this call finished') ?? 0
    const pruned = deps.runs?.prune(Date.now() - RUN_RETENTION_MS) ?? 0
    if (settled || pruned) console.error(`[apps] run records: ${settled} unfinished closed, ${pruned} past retention removed`)
    // 건네기 (E) — 가져온 앱의 대기실과 확인. 런타임은 확인을 기다리는 앱을 띄우지 않는다(`held`)
    this.handover = new AppHandover(
      {
        dataRoot: deps.dataRoot,
        reservedIds: deps.reservedIds,
        rescanUser: () => this.rescanUser(),
        userApp: (appId) => {
          const e = this.find({ projectId: null, appId })
          return e ? { dir: e.dir, manifest: e.manifest } : null
        },
        changed: () => this.appsChanged(),
      },
      deps.handover,
    )
  }

  /**
   * 한 앱의 최근 오류 묶음 (M4 C-6) — 뜨지 못함·예고 없는 종료·도구 실패. `latest`가 "만드는 세션에 보내기"가 보낼
   * 것이다. **보내지는 않는다** — 사람이 누를 때 UI가 이것을 읽어 보낸다(errors.ts 주석).
   */
  errors(ref: AppRef): { latest: SentErrorBundle | null; recent: SentErrorBundle[] } {
    const key = this.holdKey(ref)
    const recent = (this.errorLog.get(key) ?? []).map((b) => ({ ...b, sentAt: this.errorsSent.get(sentKey(key, b)) ?? null }))
    return { latest: recent[0] ?? null, recent }
  }

  /**
   * 묶음 하나를 만드는 세션에 보낸다고 적는다 (C-6) — **한 번만.** 보낼 묶음을 돌려주고, 이미 보냈으면 'sent', 들고 있지
   * 않으면(오래돼 밀려났다, host가 다시 떴다) null. 적는 것이 보내기보다 먼저다: 사람이 두 번 눌러도, 두 창에서 눌러도
   * 한 번만 간다. 보내다 실패하면 부른 쪽이 `unmarkErrorSent`로 되돌린다 — 못 간 묶음을 "보냈다"로 남기지 않는다.
   *
   * 보내는 일은 여기서 하지 않는다. 런타임은 묶음을 모으고 물으면 답할 뿐이고(errors.ts), 보내는 쪽은 사람이 누른 RPC다.
   */
  markErrorSent(ref: AppRef, at: number): AppErrorBundle | 'sent' | null {
    const key = this.holdKey(ref)
    const list = this.errorLog.get(key) ?? []
    const b = list.find((x) => x.at === at)
    if (!b) return null
    const k = sentKey(key, b)
    if (this.errorsSent.has(k)) return 'sent'
    // 목록에서 밀려난 묶음의 표시는 걷는다 — 표시가 묶음보다 오래 살 까닭이 없다
    for (const old of [...this.errorsSent.keys()]) {
      if (old.startsWith(`${key}\n`) && !list.some((x) => sentKey(key, x) === old)) this.errorsSent.delete(old)
    }
    this.errorsSent.set(k, Date.now())
    return b
  }

  unmarkErrorSent(ref: AppRef, at: number): void {
    const key = this.holdKey(ref)
    const b = (this.errorLog.get(key) ?? []).find((x) => x.at === at)
    if (b) this.errorsSent.delete(sentKey(key, b))
  }

  /**
   * 오류 묶음 하나를 적는다. 도구 실패는 앱의 답이 표준에러보다 먼저 올 수 있어서(파이프가 둘이다 — 던진 스택은
   * 표준에러로, 실패 답은 표준출력으로 간다), 그 프로세스의 표준에러를 조금 뒤에 한 번 더 옮겨 담는다.
   */
  private recordError(e: AppEntry, b: Omit<AppErrorBundle, 'text'>, proc: AppProcess | null = null): void {
    const key = this.holdKey(e.ref)
    const app = `${e.manifest?.name ?? e.ref.appId} (${this.label(e.ref)})`
    const list = this.errorLog.get(key) ?? []
    let bundle = errorBundle(app, proc ? { ...b, stderr: proc.log.tailLines() } : b)
    list.unshift(bundle)
    if (list.length > ERRORS_KEPT) list.length = ERRORS_KEPT
    this.errorLog.set(key, list)
    /*
     * 목록이 말하는 "마지막 오류의 때"가 바뀌었다 — 화면(오류 줄)은 그것을 보고 묶음을 다시 읽는다. "바뀌었다"
     * (emitChanged)에 기대지 않는 이유: 읽기 전용 도구의 호출은 그것을 내지 않는다(내면 화면이 다시 읽다가 또
     * 실패하는 고리가 된다). 뜨지 못함·죽음은 상태가 바뀌며 이미 알렸지만, 도구 실패는 이것이 유일한 신호다.
     */
    this.appsChanged()
    if (!proc) return
    setTimeout(() => {
      const i = list.indexOf(bundle)
      if (i < 0) return
      bundle = errorBundle(app, { ...b, stderr: proc.log.tailLines() })
      list[i] = bundle
    }, STDERR_SETTLE_MS).unref()
  }

  /**
   * 중개의 몸통 가운데 host의 코어가 할 일(에이전트 세션)을 받는다 (D). 매니저가 런타임을 받을 때 부른다
   * (`SessionManager.useExternalApps`) — host의 main과 테스트가 같은 이음새를 쓴다. null이면 비운다: 그 뒤의 부탁은
   * "빌려줄 에이전트가 없다"로 거절된다.
   */
  attachBrokerHost(host: BrokerHost | null): void {
    this.desk.attach(host)
  }

  /**
   * 한 앱에 대해 기억된 능력의 답 (D-4) — 최근 것부터. `current`는 지금 매니페스트의 `uses`로 답한 것인가: 아니면 더 쓰이지
   * 않는다. 매니페스트가 틀렸거나 앱이 사라졌으면 모두 current가 아니다.
   */
  permissions(ref: AppRef): CapabilityDecisionListed[] {
    const m = this.find(ref)?.manifest
    return this.desk.permissions(ref, m ? m.uses : null)
  }

  /** 기억된 답 하나를 잊는다 (D-4) — 다음에 그 능력을 쓰려 하면 다시 묻는다 */
  forgetPermission(ref: AppRef, capability: string): void {
    this.desk.forgetPermission(ref, capability)
  }

  /**
   * 이 실행까지의 사슬 (D-5) — 사슬을 시작한 호출부터 이 실행까지의 (앱, 도구). 열린 실행만 따라간다: 아래의 호출은 부모가
   * 열려 있는 동안에만 산다(부모가 끝나면 취소된다), 그래서 도는 부탁의 사슬은 끊기지 않는다.
   */
  private chainOf(runId: string): { ref: AppRef; tool: string }[] {
    const path: { ref: AppRef; tool: string }[] = []
    let run = this.openRuns.get(runId)
    for (let hops = 0; run && hops < 32; hops++) {
      path.unshift({ ref: run.entry.ref, tool: run.tool })
      run = run.caller.kind === 'app' ? this.openRuns.get(run.caller.parentRunId) : undefined
    }
    return path
  }

  /**
   * 한 앱이 부탁한 에이전트의 쓰임 (D-5) — 지난 하루와 기록이 남는 30일. 기록 판이 읽는다(`apps.usage`).
   */
  agentUse(ref: AppRef): { day: AgentUse; month: AgentUse } {
    const now = Date.now()
    const none = { runs: 0, durationMs: 0, tokens: null }
    const ledger = this.deps.runs
    return {
      day: ledger?.agentUse(ref.projectId, ref.appId, now - 24 * 60 * 60 * 1000) ?? none,
      month: ledger?.agentUse(ref.projectId, ref.appId, now - RUN_RETENTION_MS) ?? none,
    }
  }

  /**
   * 이 실행의 사슬을 누가 시작했나 (D-4) — 부모를 따라 올라가 앱이 아닌 첫 호출자. 화면이면 그 화면의 앱이 답이다(물음이 그
   * 고정 화면에 선다). 중간의 부모가 이미 끝났으면 따라갈 수 없다 — null.
   */
  private chainOrigin(runId: string): CapabilityOrigin | null {
    let run = this.openRuns.get(runId)
    for (let hops = 0; run && run.caller.kind === 'app' && hops < 32; hops++) run = this.openRuns.get(run.caller.parentRunId)
    if (!run) return null
    if (run.caller.kind === 'session') return { kind: 'session', sessionId: run.caller.sessionId }
    if (run.caller.kind === 'view') return { kind: 'view', app: run.entry.ref }
    return null
  }

  /** 한 앱의 실행 기록, 최근 것부터 (B-7) — 폴더가 사라진 앱의 기록도 읽힌다 */
  runs(ref: AppRef, limit = 100): AppRunListed[] {
    return this.deps.runs?.list(ref.projectId, ref.appId, limit) ?? []
  }

  /**
   * 프로젝트 목록과 신뢰를 다시 읽고 전부 다시 훑는다.
   *
   * 기동할 때 한 번, 그리고 프로젝트가 늘거나 줄거나 신뢰가 바뀔 때 부른다(RPC 문이 부른다).
   * 폴더 안의 변화는 감시가 따로 따라간다 — 이 함수는 "어느 폴더를 볼 것인가"를 정한다.
   * **아무것도 띄우지 않는다** — 앱은 처음 필요할 때 뜬다.
   */
  refresh(): void {
    if (this.disposed) return
    const want = new Map<string, Scope>()
    want.set(USER_SCOPE, { key: USER_SCOPE, projectId: null, root: this.deps.dataRoot, trusted: true })
    for (const p of this.deps.projects()) {
      want.set(p.id, { key: p.id, projectId: p.id, root: p.path, trusted: p.trusted })
    }
    for (const key of [...this.scopes.keys()]) {
      if (!want.has(key)) this.dropScope(key)
    }
    for (const scope of want.values()) {
      const cur = this.scopes.get(scope.key)
      if (cur) cur.scope = scope
      else this.scopes.set(scope.key, { scope, apps: new Map() })
      this.rescan(scope.key)
    }
  }

  /** 발견된 외부 앱 전부 — 신뢰하지 않은 프로젝트의 앱과 깨진 매니페스트도 이유와 함께 선다 */
  list(): ExternalAppInfo[] {
    const out: ExternalAppInfo[] = []
    for (const { apps } of this.scopes.values()) {
      for (const e of apps.values()) out.push(this.info(e))
    }
    return out
  }

  /**
   * 앱의 도구 목록 — 앱이 내려가 있으면 **여기서 띄운다**(처음 필요할 때).
   *
   * 이름에 `__`가 있는 도구는 여기서 빠진다(A-1 `toolNameError`). 목록을 읽는 자리가 곧
   * 막는 자리다: 이 목록이 세션에 붙는 목록(A-5)과 화면이 부르는 도구의 정본이 된다.
   */
  async tools(ref: AppRef, audience?: Audience): Promise<Tool[]> {
    const e = this.require(ref)
    const all = await this.use(e, async () => e.life.tools ?? [])
    return all.filter((t) => !audience || t.visibility.includes(audience)).map((t) => t.tool)
  }

  /**
   * 마지막으로 읽은 도구 목록 — **앱을 띄우지 않는다.** 한 번도 읽은 적이 없으면 null이다.
   *
   * 세션에 붙이는 쪽(A-5)이 먼저 이것을 보고, 없을 때만 `tools()`로 띄운다. 앱이 내려가 있어도
   * 목록은 남아 있으므로, 세션이 뜰 때마다 앱 프로세스가 뜨지 않는다.
   */
  knownTools(ref: AppRef, audience?: Audience): Tool[] | null {
    const known = this.require(ref).life.known
    if (!known) return null
    return known.filter((t) => !audience || t.visibility.includes(audience)).map((t) => t.tool)
  }

  /**
   * 앱 목록이나 어떤 앱의 에이전트 도구가 바뀌었을 수 있다 (A-5) — 세션에 붙은 앱을 다시 셀 때다.
   *
   * 알리는 때: 앱 폴더가 생기거나 사라지거나 매니페스트가 바뀜, 프로젝트가 늘고 줆, 신뢰가 바뀜,
   * 앱이 멈춤(연달아 실패)과 다시 시작, 다시 읽은 도구 목록이 달라짐. **무엇이** 바뀌었는지는
   * 싣지 않는다 — 받는 쪽은 `list()`와 `knownTools()`를 다시 읽는다(#81의 "알림 하나와 다시
   * 읽기"와 같은 방식이다). 한 틱에 몰린 변화는 한 번으로 모은다.
   *
   * 앱의 수명(뜨는 중, 떴다, 쉬어서 내렸다, 죽었다)에도 알린다 (A-8). 사이드바와 고정 화면이
   * `list()`의 상태를 보여 주므로, 그 상태가 바뀌는 자리는 모두 여기를 지나야 한다. 세션 쪽은
   * 자기가 보는 모양(붙은 앱과 도구)을 비교해 같으면 아무것도 하지 않으므로, 알림이 늘어도
   * 할 일은 늘지 않는다. 알림을 둘로 나누지 않은 이유: 목록을 바꾸는 자리가 두 알림 중 하나만
   * 부르는 날, 그 변화는 한쪽 받는 이에게만 닿는다.
   */
  onAppsChanged(listener: () => void): () => void {
    this.appsListeners.add(listener)
    return () => void this.appsListeners.delete(listener)
  }

  private appsChanged(): void {
    if (this.appsNotePending || this.disposed) return
    this.appsNotePending = true
    queueMicrotask(() => {
      this.appsNotePending = false
      if (this.disposed) return
      for (const l of [...this.appsListeners]) {
        try {
          l()
        } catch (err) {
          // 받는 쪽 하나의 실패가 다른 세션의 갱신을 막지 않는다
          console.error('[apps] apps-changed listener failed:', err)
        }
      }
    })
  }

  /**
   * 앱 도구를 부르는 **단 하나의 길** (M4 A-4).
   *
   * 화면이 부른 것(`apps.invoke`)도, 세션의 대리 서버가 부른 것(A-5)도, 다른 앱이 중개로 부른
   * 것(D-2)도 여기로 들어온다. 그래서 공개 범위 검사, 실행 id 발급, 취소, "바뀌었다" 알림,
   * 기록(A-6)이 호출마다 한 번씩, 같은 코드로 일어난다 — 경로가 둘이면 그중 하나는 언젠가
   * 검사를 빠뜨린다.
   */
  async call(
    ref: AppRef,
    name: string,
    args: Record<string, unknown>,
    caller: AppCaller,
    opts: {
      signal?: AbortSignal
      /**
       * 실행 id가 정해지는 순간 한 번 불린다 — 결말을 기다리지 않고 id를 먼저 알아야 하는 쪽이 쓴다
       * (A-5의 "오래 걸리는 호출": Codex의 상한 전에 "아직 도는 중, 실행 id는 …"을 먼저 돌려준다).
       */
      onRun?: (runId: string) => void
    } = {},
  ): Promise<AppCallOutcome> {
    const e = this.require(ref)
    const runId = `run_${randomUUID()}`
    opts.onRun?.(runId)
    const t0 = Date.now()
    /*
     * 기록은 호출이 들어온 순간 `running`으로 한 줄, 끝날 때 결말로 고친다 — 거절도 한 줄이다.
     * 가리는 값은 이 앱에 저장된 비밀 전부다: 인자·결과·실패 이유 어디에 섞여 들어와도 이름만 남는다.
     */
    const redact = this.deps.runs ? redactor(this.secrets.all(this.appKey(e.ref))) : (t: string) => t
    const described = this.deps.runs ? describeArgs(args, redact) : null
    this.deps.runs?.begin({
      id: runId,
      projectId: e.ref.projectId,
      appId: e.ref.appId,
      kind: 'tool',
      sessionId: null,
      tool: name,
      callerKind: caller.kind,
      callerSessionId: caller.kind === 'session' ? caller.sessionId : null,
      parentRunId: caller.kind === 'app' ? caller.parentRunId : null,
      status: 'running',
      durationMs: null,
      argsDigest: described?.digest ?? '',
      argsSummary: described?.summary ?? '',
      error: null,
      createdAt: t0,
    })
    /** 앱에 실제로 보냈는가 — "바뀌었다"는 앱에 닿은 호출만 알린다 (거절·뜨는 중 취소·기동 실패는 아무것도 바꾸지 않았다) */
    let sent = false
    /*
     * 읽기만 하는 도구인가(`readOnlyHint: true`) — 읽기는 아무것도 바꾸지 않았으니 "바뀌었다"도 알리지 않는다.
     * 실측(65acb43): 템플릿 화면은 알림마다 `show`를 다시 부르는데 그 `show`가 또 알림을 내서, 화면 하나가 초당
     * 약 700번 `show`를 불렀다(1초에 실행 기록 618줄, 3초에 2035줄). 주석이 없는 도구는 MCP의 기본값대로 바꿀 수
     * 있는 도구로 친다 — 틀린 쪽이 "안 알림"이면 화면이 낡은 값을 보여 준다.
     */
    let readOnly = false
    /** 이 호출을 받은 프로세스 — 실패했을 때 그 프로세스의 표준에러를 오류 묶음에 싣는다 (C-6) */
    let callee: AppProcess | null = null
    const done = (status: AppRunStatus, result: CallToolResult | null, error: string | null): AppCallOutcome => {
      /*
       * 앱에 닿은 호출이 실패했다 (C-6) — 앱의 잘못일 수 있는 것만 적는다. 거절은 정책이고, 뜨지 못한 것은
       * 기동 쪽이 따로 적었다. 인자는 기록과 같은 규칙으로 가린다 — 이 묶음은 만드는 세션의 프롬프트가 될 수 있다.
       */
      if (status === 'error' && sent) {
        const hide = this.deps.runs ? redact : redactor(this.secrets.all(this.appKey(e.ref)))
        this.recordError(
          e,
          { kind: 'tool', at: Date.now(), message: hide(error ?? '').split('\n')[0]!, stderr: [], tool: name, args: (described ?? describeArgs(args, hide)).summary, runId },
          callee,
        )
      }
      const durationMs = Date.now() - t0
      const ledger = this.deps.runs
      if (ledger && described) {
        ledger.end(runId, { status, durationMs, error: error === null ? null : redact(error) })
        // 실패한 입력은 만드는 에이전트가 고치는 데 필요하다 — 최근 것만, 가린 채로
        if (status === 'error') {
          ledger.keepFailure(
            { runId, projectId: e.ref.projectId, appId: e.ref.appId, args: described.json, result: result ? redact(JSON.stringify(result)) : null, createdAt: t0 },
            FAILURES_KEPT,
          )
        }
      }
      if (sent && !readOnly) this.deps.emitChanged?.(e.ref, caller)
      return { runId, status, result, error, durationMs }
    }

    // 앱에 보내기 전에 끝나는 판정 — 프로세스를 띄울 필요도 없다
    if (!e.manifest) return done('rejected', null, `매니페스트가 틀린 앱입니다: ${e.error}`)
    if (!e.scope.trusted) return done('rejected', null, '신뢰하지 않은 프로젝트의 앱은 부르지 않습니다')
    const held = this.held(e)
    if (held) return done('rejected', null, held)
    if (e.life.gaveUp) return done('rejected', null, `${this.timing.maxFailures}번 연달아 실패해 멈춘 앱입니다`)
    let parent: OpenRun | null = null
    if (caller.kind === 'app') {
      parent = this.openRuns.get(caller.parentRunId) ?? null
      if (!parent) return done('rejected', null, `부모 실행이 열려 있지 않습니다: ${caller.parentRunId}`)
    }
    if (opts.signal?.aborted) return done('cancelled', null, '부르기 전에 취소됐습니다')

    try {
      return await this.use(e, async (proc) => {
        const found = e.life.tools?.find((t) => t.tool.name === name)
        if (!found) return done('rejected', null, `그런 도구가 없습니다: ${name}`)
        /*
         * 화면은 `app` 도구만, 에이전트와 다른 앱은 `model` 도구만. 세션은 애초에 `model` 도구만
         * 목록으로 받지만(A-5), 이름을 알면 부를 수 있다 — 목록에서 숨기는 것과 호출을 막는 것은
         * 다른 일이고, 막는 것은 여기서 한다.
         */
        const need: Audience = caller.kind === 'view' ? 'app' : 'model'
        if (!found.visibility.includes(need)) {
          return done('rejected', null, `${name}은(는) ${need === 'app' ? '화면' : '에이전트'}에게 열린 도구가 아닙니다 (visibility: ${JSON.stringify(found.visibility)})`)
        }

        const upstream = [opts.signal, parent?.abort.signal].filter((x): x is AbortSignal => !!x)
        /*
         * 앱이 뜨는 동안 취소됐으면 보내지 않는다. 실측: 뜨는 중에 취소된 호출이 5초짜리 도구를
         * 끝까지 돌렸다 — 이미 선 신호에 붙인 리스너는 영영 불리지 않는다.
         */
        if (upstream.some((sig) => sig.aborted)) return done('cancelled', null, '앱이 뜨는 동안 취소됐습니다')
        const abort = new AbortController()
        const onUp = () => abort.abort(new Error('the caller cancelled this call'))
        for (const sig of upstream) sig.addEventListener('abort', onUp, { once: true })
        this.openRuns.set(runId, { entry: e, pipeId: e.life.pipeId, tool: name, caller, abort })
        sent = true
        readOnly = found.tool.annotations?.readOnlyHint === true
        callee = proc
        try {
          /*
           * `onprogress`를 주는 이유: MCP SDK는 이것이 있을 때만 요청에 진행 토큰을 싣는다(client의 request — 토큰 없이는
           * 앱이 진행 알림을 보낼 수 없다). 그래서 `resetTimeoutOnProgress`는 지금까지 아무것도 하지 않았다. 앱이 에이전트를
           * 부탁하고 기다리는 동안(D-1, 몇 분이 걸린다) 템플릿의 도우미가 그 기다림을 이 호출의 진행으로 올려 보내야 이
           * 호출이 `callTimeoutMs`에 끊기지 않는다. 받은 알림 자체는 쓰지 않는다 — 살아 있다는 뜻이면 된다.
           */
          const result = await proc.client.callTool(
            { name, arguments: args, _meta: { [RUN_META]: runId } },
            { signal: abort.signal, timeout: this.timing.callTimeoutMs, resetTimeoutOnProgress: true, onprogress: () => {} },
          )
          return result.isError ? done('error', result, resultText(result) || '도구가 실패를 돌려줬습니다') : done('ok', result, null)
        } catch (err) {
          if (abort.signal.aborted) return done('cancelled', null, '부른 쪽이 취소했습니다')
          return done('error', null, (err as Error).message)
        } finally {
          this.openRuns.delete(runId)
          // 실행이 끝나면 그 아래의 중개 일도 끝난다 — 앱이 기다리지 않고 답했어도 아래가 남지 않게
          abort.abort()
          for (const sig of upstream) sig.removeEventListener('abort', onUp)
        }
      })
    } catch (err) {
      // 뜨지 못했다(기동 실패·백오프 중 바뀜) — 앱에 닿지 못했지만 정책의 거절은 아니다
      return done('error', null, (err as Error).message)
    }
  }

  /**
   * 앱의 리소스를 읽는다 — 화면이 자기 `ui://` 문서와 리소스를 읽는 길(B-3·B-4의 `onreadresource`).
   * 도구 호출이 아니라 실행 기록은 남기지 않지만, 앱을 띄우는 규칙(신뢰·처음 필요할 때)은 같다.
   */
  async readResource(ref: AppRef, uri: string): Promise<ReadResourceResult> {
    const e = this.require(ref)
    return this.use(e, (proc) => proc.client.readResource({ uri }, { timeout: this.timing.connectTimeoutMs }))
  }

  /**
   * 앱이 내놓은 리소스 목록 (MCP `resources/list`, 쪽 넘김까지) — 대화 안 화면(B-1)이 도구가 선언한
   * `ui://`가 **이 앱의 것인지** 보는 근거다(플랜 "사칭 차단"). 읽기와 같은 규칙으로 앱을 띄운다.
   * 쪽은 몇 개까지만 넘긴다 — 끝없이 다음 쪽을 주는 앱이 host를 붙잡지 못하게.
   */
  async listResources(ref: AppRef, maxPages = 20): Promise<ListResourcesResult['resources']> {
    const e = this.require(ref)
    return this.use(e, async (proc) => {
      const out: ListResourcesResult['resources'] = []
      let cursor: string | undefined
      for (let page = 0; page < maxPages; page++) {
        const r = await proc.client.listResources(cursor ? { cursor } : {}, { timeout: this.timing.connectTimeoutMs })
        out.push(...r.resources)
        cursor = r.nextCursor
        if (!cursor) break
      }
      return out
    })
  }

  /**
   * 화면 하나가 이 앱을 붙들고 있다 (ViewHost의 open이 부른다). 열린 화면이 있는 동안은 쉬는
   * 앱으로 치지 않는다 — 돌려받은 함수를 부르면 놓는다(close).
   */
  retainView(ref: AppRef): () => void {
    const e = this.require(ref)
    const key = this.holdKey(e.ref)
    this.viewHolds.set(key, (this.viewHolds.get(key) ?? 0) + 1)
    this.clearIdle(e)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (this.viewHolds.get(key) ?? 1) - 1
      if (left > 0) this.viewHolds.set(key, left)
      else this.viewHolds.delete(key)
      // 붙들 때의 칸이 아니라 **지금의** 칸 — 그사이 매니페스트가 바뀌었으면 새 칸이 쉬기 시작한다
      const now = this.find(ref)
      if (now) this.armIdle(now)
    }
  }

  /**
   * 고정 화면을 여는 도구와 그 화면 (B-2) — 매니페스트의 `home`과, 그 도구가 선언한
   * `_meta.ui.resourceUri`. 도구 목록을 알아야 해서 앱이 내려가 있으면 **여기서 띄운다**.
   *
   * 화면을 선언하지 않은 도구는 받지 않는다. 고정 화면은 도구 호출에서 태어나는 화면이고(플랜 "화면이
   * 뜨는 두 자리"), 화면이 없는 도구를 부르면 결과만 남고 띄울 것이 없다. 그때 호출부터 해 버리면
   * 사람은 아무것도 안 뜬 채로 앱의 상태만 바뀐 것을 보게 된다. 그래서 부르기 **전에** 거절한다.
   * 이유는 화면에 그대로 보이므로 사람의 말로 적는다.
   */
  async homeView(ref: AppRef): Promise<{ tool: string; resourceUri: string }> {
    const e = this.require(ref)
    if (!e.manifest) throw new AppUnavailableError(`This app's manifest is invalid: ${e.error ?? 'unknown error'}`)
    const home = e.manifest.home
    if (!home) throw new AppUnavailableError('This app has no screen: its manifest names no home tool')
    const all = await this.use(e, async () => e.life.tools ?? [])
    const found = all.find((t) => t.tool.name === home)
    if (!found) throw new AppUnavailableError(`This app has no screen: its home tool "${home}" is not in its tool list`)
    const ui = resourceUriOf(found.tool)
    if (ui.error) throw new AppUnavailableError(`This app's screen is declared wrong: ${ui.error}`)
    if (!ui.uri) throw new AppUnavailableError(`This app has no screen: its home tool "${home}" declares no _meta.ui.resourceUri`)
    return { tool: home, resourceUri: ui.uri }
  }

  /**
   * 화면의 출처 방식 (B-3) — 매니페스트의 `view.origin`. 앱이 없거나 매니페스트가 틀렸으면
   * 불투명이다: 모르는 앱에 진짜 출처(저장소가 남는 포트)를 내주지 않는다.
   */
  viewOrigin(ref: AppRef): 'opaque' | 'app' {
    return this.find(ref)?.manifest?.view?.origin ?? 'opaque'
  }

  /**
   * 멈춘 앱을 다시 시작할 수 있게 한다 (B-6의 "다시 시작"). 연속 실패와 백오프를 지우고
   * 떠 있으면 내린다 — **띄우지는 않는다**, 다음 필요가 띄운다.
   */
  async restart(ref: AppRef): Promise<void> {
    const e = this.require(ref)
    await this.halt(e, 'restart requested')
    Object.assign(e.life, { failures: 0, retryAt: 0, lastError: null, gaveUp: false, verdict: undefined })
    // 멈췄던 앱은 세션에서 떨어져 있었다 — 다시 붙을 수 있게 알린다. 죽었던(crashed) 앱도 이유가
    // 지워져 목록의 상태가 바뀐다(A-8)
    this.appsChanged()
  }

  /**
   * 사용자 폴더에 화면 없는 앱을 하나 만든다 (M4 A-7, 결정 8) — 사람이 승인한 MCP 서버가 앱이 되는 자리.
   *
   * 승인한 서버가 따로 된 명부(app_settings)에 살면 승인 흐름도 붙이는 길도 둘이 된다. 그 서버의 호출은
   * 중개를 지나지 않았고, 기록되지 않았고, 목록에서 지울 수도 없었다. 앱이 되면 다른 앱과 같은 한 길
   * (공개 범위·실행 기록·처음 필요할 때 띄우기·쉬면 내리기)을 탄다. 사용자 폴더 앱이라 오케스트레이터에
   * 붙는다(결정 4 — 예전에 승인된 서버가 붙던 자리와 같다).
   *
   * 판정은 발견과 같은 한 벌이다: 매니페스트를 만들어 `parseManifest`에 읽혀 본 뒤에 쓴다(id 규칙 #93도
   * 거기 있다). 내장 앱의 id는 가져갈 수 없다. **같은 id의 앱이 이미 있으면** — 같은 서버면 그 앱을
   * 그대로 돌려주고(다시 불러도 같다: 옮기기가 중간에 끊겼다 다시 돌 때), 다르면 거절한다(사람이 만든
   * 앱을 덮어쓰지 않는다).
   *
   * 쓰는 방법: 점으로 시작하는 임시 폴더(발견이 건너뛴다)에 쓰고 이름을 바꾼다 — 반쯤 쓴 매니페스트를
   * 발견이 "틀린 앱"으로 읽는 순간이 없다. 쓴 뒤 바로 다시 훑는다: 사용자 쪽은 `apps/`가 없을 때 아무것도
   * 감시하지 않으므로(데이터 폴더 자체를 보면 store.db가 쓰일 때마다 깨어난다) 첫 앱은 감시가 못 본다.
   * **띄우지는 않는다** — 처음 필요할 때 뜬다.
   */
  installUserApp(spec: { id: string; name: string; description: string; server: { command: string; args: string[] } }): ExternalAppInfo {
    if (this.disposed) throw new AppUnavailableError('앱 런타임이 내려갔습니다')
    if (this.deps.reservedIds.includes(spec.id)) throw new AppUnavailableError(`"${spec.id}"는 내장 앱의 이름입니다 — 다른 이름을 쓰세요`)
    const text = JSON.stringify(
      {
        manifestVersion: MANIFEST_VERSION,
        id: spec.id,
        name: spec.name,
        version: '1.0.0',
        description: spec.description,
        server: { command: spec.server.command, args: spec.server.args },
      },
      null,
      2,
    )
    const parsed = parseManifest(text)
    if (!parsed.ok) throw new AppUnavailableError(`앱으로 만들 수 없습니다 — ${parsed.error}`)

    this.rescanUser()
    const ref: AppRef = { projectId: null, appId: spec.id }
    const parent = join(this.deps.dataRoot, USER_APPS_REL)
    const dir = join(parent, spec.id)
    const held = this.find(ref)
    if (held || existsSync(dir)) {
      const same =
        held?.manifest?.server.command === spec.server.command &&
        JSON.stringify(held.manifest.server.args) === JSON.stringify(spec.server.args)
      if (held && same) return this.info(held)
      throw new AppUnavailableError(`사용자 폴더에 "${spec.id}" 앱이 이미 있습니다 — 다른 이름을 쓰거나 그 앱을 먼저 지우세요`)
    }

    mkdirSync(parent, { recursive: true })
    const staging = join(parent, `.${spec.id}.${randomUUID()}`)
    mkdirSync(staging)
    try {
      writeFileSync(join(staging, MANIFEST_FILE), text + '\n')
      renameSync(staging, dir)
    } catch (err) {
      rmSync(staging, { recursive: true, force: true })
      throw new AppUnavailableError(`앱 폴더를 쓰지 못했습니다: ${(err as Error).message}`)
    }
    this.rescanUser()
    const made = this.find(ref)
    if (!made) throw new AppUnavailableError(`앱 폴더를 썼지만 발견되지 않았습니다: ${dir}`)
    return this.info(made)
  }

  /**
   * 앱을 점검한다 (M4 C-3) — 만드는 세션의 `check`와 `apps.check`가 부른다. 만드는 에이전트가 사람 대신 자기 앱을
   * 시험하는 자리다.
   *
   *   1. 다시 훑는다 — 방금 고친 매니페스트를 발견과 같은 판정(`parseManifest`)으로 읽는다
   *   2. **지금 파일로** 다시 띄운다 — 떠 있던 프로세스는 옛 코드일 수 있다. 진행 중인 호출은 끊지 않는다:
   *      끝나기를 기다리고(`checkDrainMs`), 넘으면 떠 있는 것을 보고 그렇다고 적는다
   *   3. 도구 목록을 **실제로** 부른다 — S-6에서 깨진 서버도 프로세스는 살아 있었다
   *   4. 도구가 가리키는 `ui://` 화면을 하나씩 읽는다
   *   5. 이름·공개 범위·주석·home의 문제를 판정한다(`check.ts`)
   *
   * **앱을 이상한 상태로 두지 않는다.** 멈춘(failed) 앱도 점검은 다시 띄워 본다 — 사람이 "다시 시작"을 누른
   * 것과 같다(연속 실패를 지운다). 그래서 점검을 되풀이해도 앱이 멈춤으로 밀려나지 않는다: 못 뜨면 그 한 번의
   * 실패(crashed)와 이유가 남고, 뜨면 보통의 떠 있는 앱이 된다(쉬면 내려간다). 점검은 도구를 부르지 않으므로
   * 실행 기록에 줄을 남기지 않는다.
   */
  async check(ref: AppRef): Promise<AppCheckReport> {
    const label = `${ref.projectId === null ? 'user' : ref.projectId.slice(0, 8)}/${ref.appId}`
    const findings: CheckFinding[] = []
    const notes: string[] = []
    let tools: CheckedTool[] = []
    const screens: { uri: string; chars: number }[] = []
    let procLine: string | null = null
    const report = (stderr: string | null) => formatReport(label, { findings, tools, screens }, { process: procLine, notes, stderr })

    const key = ref.projectId ?? USER_SCOPE
    if (this.scopes.has(key)) this.rescan(key)
    else this.refresh()
    const e = this.find(ref)
    if (!e) {
      findings.push({ level: 'problem', where: '앱', message: '그런 앱이 없습니다 — 앱 폴더가 지워졌거나 이름이 바뀌었습니다' })
      return report(null)
    }
    for (const w of e.warnings) findings.push({ level: 'warning', where: 'centralu.app.json', message: w })
    if (!e.manifest) {
      findings.push({ level: 'problem', where: 'centralu.app.json', message: e.error ?? '매니페스트가 틀렸습니다' })
      return report(null)
    }
    if (!e.scope.trusted) {
      findings.push({ level: 'problem', where: '신뢰', message: '신뢰하지 않은 프로젝트의 앱이라 띄우지 않습니다 — 프로젝트를 신뢰하면 점검할 수 있습니다' })
      return report(null)
    }
    const held = this.held(e)
    if (held) {
      findings.push({ level: 'problem', where: '확인', message: held })
      return report(null)
    }

    // 지금 파일로 다시 띄운다 — 호출이 끝난 **바로 그 틱에** 내린다(drain 주석)
    let restarted = false
    for (;;) {
      if (e.life.inflight === 0) {
        const wasStopped = e.life.gaveUp
        void this.halt(e, 'check: starting again from the files on disk')
        Object.assign(e.life, { failures: 0, retryAt: 0, lastError: null, gaveUp: false })
        if (wasStopped) this.appsChanged()
        restarted = true
        break
      }
      const busy = e.life.inflight
      if (!(await this.drain(e, this.timing.checkDrainMs))) {
        const limit = this.timing.checkDrainMs >= 1000 ? `${Math.round(this.timing.checkDrainMs / 1000)}초` : `${this.timing.checkDrainMs}ms`
        notes.push(`호출 ${busy}개가 ${limit} 넘게 도는 중이라 다시 띄우지 않았습니다 — 떠 있던 프로세스를 봤습니다(고친 코드가 아닐 수 있습니다)`)
        break
      }
    }

    let stderr: string | null = null
    try {
      await this.use(e, async (proc) => {
        const listed = await proc.client.listTools(undefined, { timeout: this.timing.connectTimeoutMs })
        proc.tools = listed.tools
        this.readTools(e, proc)
        const t = checkTools(e.manifest!, listed.tools)
        findings.push(...t.findings)
        tools = t.tools
        for (const uri of t.screens) {
          let read: ReadResourceResult | Error
          try {
            read = await proc.client.readResource({ uri }, { timeout: this.timing.connectTimeoutMs })
          } catch (err) {
            read = err as Error
          }
          const s = checkScreen(uri, read)
          findings.push(...s.findings)
          screens.push({ uri, chars: s.chars })
        }
        procLine = `pid ${proc.child.pid}, ${proc.client.getProtocolEra()} (${proc.client.getNegotiatedProtocolVersion()}), ${restarted ? '지금 파일로 다시 띄움' : '떠 있던 것'}`
        stderr = proc.log.tail() || null
      })
    } catch (err) {
      // 뜨지 못했다 — 이유에 표준에러 끝부분이 이미 들어 있다(AppProcess.start)
      findings.push({ level: 'problem', where: '시작', message: (err as Error).message })
    }
    return report(stderr)
  }

  /**
   * 새 앱을 템플릿으로 만든다 (M4 C-1b) — "새 앱"(`apps.create`)과 오케스트레이터의 `create_app`이 같은 문을 쓴다.
   *
   *   프로젝트 앱     `<프로젝트>/.centralu/apps/<id>/` — 저장소에 커밋되어 팀과 나뉜다 (결정 1의 기본)
   *   사용자 폴더 앱   `<데이터 폴더>/apps/<id>/` — 여러 프로젝트에서 쓰는 것 (`projectId: null`)
   *
   * 거절하는 것 셋, 모두 폴더가 생기기 전에:
   *   - **이름**: 제안된 MCP 서버와 같은 규칙(`proposedMcpServerNameError` — #93의 글자·`centralu` 예약에 `app-`
   *     머리 금지). 발견은 `app-` 머리의 id도 읽지만(손으로 만든 앱), 새로 만드는 앱에 `app-app-notes`라는
   *     서버 이름을 줄 까닭이 없다. 내장 앱의 id도 안 된다.
   *   - **신뢰하지 않은 프로젝트**: 만든 앱은 이 기계에서 도는 코드이고, 신뢰하지 않은 프로젝트의 앱은 뜨지 않는다
   *     (결정 3). 만들 수는 있는데 뜨지 않는 앱은 만드는 세션을 헛돌게 한다.
   *   - **이미 있는 id**: 틀린 매니페스트로 서 있는 폴더라도 사람이나 에이전트의 것이다 — 덮어쓰지 않는다.
   *
   * 쓰는 방법은 `installUserApp`과 같다: 점으로 시작하는 임시 폴더에 펼치고 이름을 바꾼다(발견이 반쯤 쓴 앱을
   * 보지 않는다). 부모 폴더는 한 칸씩 경로 가드를 지나며 만든다(`ensureDirInside` — `.centralu`가 밖을
   * 가리키는 링크면 멈춘다). 데이터 폴더도 지금 만든다. 쓴 뒤 바로 다시 훑는다 — 감시가 아직 그 자리를 보지
   * 않을 수 있다. **띄우지는 않는다** — 처음 필요할 때 뜬다.
   */
  createApp(spec: { projectId: string | null; id: string; name: string; description?: string }): ExternalAppInfo {
    if (this.disposed) throw new AppUnavailableError('앱 런타임이 내려갔습니다')
    const idError = proposedMcpServerNameError(spec.id)
    if (idError) throw new AppUnavailableError(`앱 id로 쓸 수 없습니다 ("${spec.id}") — ${idError}`)
    if (this.deps.reservedIds.includes(spec.id)) throw new AppUnavailableError(`"${spec.id}"는 내장 앱의 이름입니다 — 다른 id를 쓰세요`)
    const name = oneLine(spec.name)
    if (!name) throw new AppUnavailableError('앱 이름이 비어 있습니다')
    const description = oneLine(spec.description ?? '') || `${name} (a Centralu app)`

    // 신뢰는 부를 때마다 정본(저장소)에서 읽는다 — 런타임의 범위 사본이 아니라
    let root = this.deps.dataRoot
    if (spec.projectId !== null) {
      const project = this.deps.projects().find((p) => p.id === spec.projectId)
      if (!project) throw new AppUnavailableError(`그런 프로젝트가 없습니다: ${spec.projectId}`)
      if (!project.trusted) {
        throw new AppUnavailableError('신뢰하지 않은 프로젝트에는 앱을 만들지 않습니다 — 앱은 이 기계에서 도는 코드라, 프로젝트를 먼저 신뢰해야 뜹니다')
      }
      root = project.path
    }
    const key = spec.projectId ?? USER_SCOPE
    if (this.scopes.has(key)) this.rescan(key)
    else this.refresh()

    const ref: AppRef = { projectId: spec.projectId, appId: spec.id }
    const parts = spec.projectId === null ? USER_APPS_PARTS : PROJECT_APPS_PARTS
    const dir = join(root, ...parts, spec.id)
    if (this.find(ref) || existsSync(dir)) {
      throw new AppUnavailableError(`"${spec.id}" 앱이 이미 있습니다 (${dir}) — 다른 id를 쓰세요`)
    }

    let staging: string | null = null
    try {
      const parent = ensureDirInside(root, parts)
      staging = join(parent, `.${spec.id}.${randomUUID()}`)
      scaffoldApp(this.deps.templateDir ?? appTemplateDir(), staging, { id: spec.id, name, description })
      renameSync(staging, dir)
      staging = null
    } catch (err) {
      if (staging) rmSync(staging, { recursive: true, force: true })
      throw new AppUnavailableError(`앱 폴더를 만들지 못했습니다: ${(err as Error).message}`)
    }
    mkdirSync(this.dataDirOf(ref), { recursive: true })
    this.rescan(key)
    const made = this.find(ref)
    if (!made) throw new AppUnavailableError(`앱 폴더를 만들었지만 발견되지 않았습니다: ${dir}`)
    return this.info(made)
  }

  /**
   * 사용자 폴더의 앱을 지운다 (M4 A-7) — 승인한 MCP 서버를 목록에서 거두는 길이다(예전 명부에는 없었다).
   *
   * 폴더는 버리지 않고 데이터 폴더의 `app-trash/`로 옮긴다: 손으로 만든 앱일 수도 있고, 되돌릴 길이 있는
   * 편이 낫다. 실행 기록·데이터 폴더·비밀은 남는다(기록은 지운 앱의 것도 읽힌다 — `runs`).
   * **프로젝트 앱은 지우지 않는다** — 저장소의 파일이라 거두는 자리는 git이다.
   *
   * 옮긴 뒤 바로 다시 훑는다: 떠 있던 프로세스가 내려가고, 붙어 있던 세션이 떼어 낸다(appsChanged).
   * Claude 세션은 재시작 없이 서버 집합에서 빠지고, Codex 스레드는 다음 스레드까지 도구 이름이 남지만
   * 부르면 "붙은 앱이 아니다"로 거절된다(세션 붙이기가 부를 때마다 다시 본다).
   */
  removeUserApp(ref: AppRef): void {
    if (ref.projectId !== null) {
      throw new AppUnavailableError('프로젝트 앱은 저장소의 파일입니다 — 저장소에서 지우세요')
    }
    this.rescanUser()
    const e = this.require(ref)
    const trash = join(this.deps.dataRoot, 'app-trash')
    mkdirSync(trash, { recursive: true })
    renameSync(e.dir, join(trash, `${ref.appId}-${Date.now()}`))
    // 가져온 앱의 표시도 걷는다 (E-3) — 휴지통에서 되살린 폴더는 사람이 손으로 옮긴 것이다(결정 3: 사용자 폴더 앱은 신뢰)
    this.handover.forget(ref.appId)
    this.rescanUser()
  }

  /** 사용자 폴더를 지금 다시 훑는다 — 한 번도 훑지 않았으면(기동 전) 전부 훑는다 */
  private rescanUser(): void {
    if (this.scopes.has(USER_SCOPE)) this.rescan(USER_SCOPE)
    else this.refresh()
  }

  /** 비밀 값을 적는다(`null`이면 지운다). 떠 있는 앱은 다음 기동부터 받는다 */
  setSecret(ref: AppRef, name: string, value: string | null): void {
    this.secrets.set(this.appKey(ref), name, value)
  }

  /**
   * 사람이 비밀 값을 넣거나 바꾸거나 지운다 (M4 E, 비밀 칸) — `apps.setSecret`의 몸통.
   *
   * 넣는 것은 **매니페스트가 선언한 이름만**이다. 선언하지 않은 이름은 앱이 받지 못하니(`forApp`) 넣어도 아무 일이 없고,
   * 사람은 "넣었는데 왜 안 되나"를 묻게 된다. 지우기는 이름을 가리지 않는다 — 선언에서 빠진 이름의 값도 치울 수 있어야 한다.
   * **어떤 문구에도 값을 싣지 않는다**: 거절은 RPC 오류로 화면까지 간다.
   *
   * 떠 있는 앱은 **진행 중인 호출을 마친 뒤** 내린다 — 다음 필요가 새 값으로 띄운다(앱은 환경을 뜰 때 한 번 받는다). 멈춘 앱의
   * 셈도 지운다: 키가 없어 연달아 못 떴던 앱에게 값을 넣는 것은 사람이 고친 것이다(다시 시작과 같다).
   */
  updateSecret(ref: AppRef, name: string, value: string | null): void {
    const e = this.require(ref)
    if (value !== null) {
      if (!e.manifest) throw new AppUnavailableError(`This app's manifest is invalid: ${e.error ?? 'unknown error'}`)
      if (!(e.manifest.secrets ?? []).includes(name)) throw new AppUnavailableError(`This app does not declare a secret named ${name}`)
      const problem = secretValueProblem(value)
      if (problem) throw new AppUnavailableError(problem)
    }
    this.secrets.set(this.appKey(ref), name, value)
    const L = e.life
    const fresh = () => {
      if (!L.proc && !L.starting) Object.assign(L, { failures: 0, retryAt: 0, lastError: null, gaveUp: false })
      this.appsChanged()
    }
    if (L.proc || L.starting) void this.haltWhenDrained(e, 'a secret changed; the next need starts it with the new value').then(fresh)
    else fresh()
    // 목록의 "있음·없음"은 지금 바뀌었다 — 내리기를 기다리지 않고 알린다
    this.appsChanged()
  }

  // ── 건네기: 가져오기 (E-3) ──────────────────────────────────────────────────────
  //
  // 몸통은 `handover.ts`에 있다. 여기서는 사람의 말로 된 거절을 RPC의 오류로 옮기고, 들인 앱의 목록 모양을 돌려준다. 가져온 앱이
  // 확인 전에 뜨지 않게 막는 자리는 호출·기동·점검·상태가 공통으로 묻는 `held` 하나다.

  /** 가져올 준비 — 대기실로 옮겨 담고 사람이 볼 것을 돌려준다. 아직 아무것도 들어오지 않았다 */
  prepareImport(source: string): Promise<{ token: string; review: AppReview }> {
    if (this.disposed) throw new AppUnavailableError('앱 런타임이 내려갔습니다')
    return this.handover.prepare(source)
  }

  /** 대기실의 앱을 사용자 폴더로 들인다 — 꺼진 채로, `enable`이면 사람이 본 열쇠로 확인까지 적는다. **띄우지는 않는다** */
  commitImport(token: string, opts: { enable: boolean; reviewKey?: string }): ExternalAppInfo {
    const id = this.handover.commit(token, opts)
    const made = this.find({ projectId: null, appId: id })
    if (!made) throw new AppUnavailableError(`앱을 들였지만 발견되지 않았습니다: ${id}`)
    return this.info(made)
  }

  cancelImport(token: string): void {
    this.handover.cancel(token)
  }

  /** 들어온 앱의 확인 창 — 사용자 폴더의 앱만(프로젝트 앱은 프로젝트 신뢰를 따른다, 결정 3) */
  reviewApp(ref: AppRef): AppReview {
    if (ref.projectId !== null) throw new AppUnavailableError("A project's apps follow the project's trust; there is nothing to review here")
    return this.handover.review(ref.appId)
  }

  /** 가져온 앱을 켠다 — 사람이 본 확인 창의 열쇠가 지금의 매니페스트와 같을 때만 */
  enableApp(ref: AppRef, key: string): ExternalAppInfo {
    if (ref.projectId !== null) throw new AppUnavailableError("A project's apps follow the project's trust; they are not enabled one by one")
    this.handover.enable(ref.appId, key)
    return this.info(this.require(ref))
  }

  // ── 건네기: 판 (E-1) ────────────────────────────────────────────────────────────

  /** git 밖의 앱의 판 — 사용자 폴더 앱만(프로젝트 앱의 판은 git이고, 그것은 host의 코어가 읽는다) */
  snapshots(ref: AppRef): (Snapshot & { current: boolean })[] {
    if (ref.projectId !== null) throw new AppUnavailableError('Project apps are versioned by git')
    this.rescanUser()
    return this.handover.versionsOf(ref.appId, this.require(ref).dir)
  }

  /**
   * 판 하나로 되돌린다 — 지금 코드를 판으로 떠 둔 뒤 되쓰고, 사람이 고른 코드라 연달아 실패한 셈을 지우고, **그 코드로 다시 띄운다**
   * (한 번이라도 떴던 앱이면. 진행 중인 호출은 끝나기를 기다린다 — 반영과 같은 길이다). 매니페스트까지 바뀌었으면 새 칸이 서고
   * 옛 프로세스는 호출을 마친 뒤 내려간다. 가져온 앱의 판이 다른 server·uses를 가졌으면 그 칸은 다시 확인을 기다린다.
   */
  restoreVersion(ref: AppRef, id: string): ExternalAppInfo {
    if (ref.projectId !== null) throw new AppUnavailableError("A project app's versions are its git history; restore it with git")
    this.rescanUser()
    const before = this.require(ref)
    this.handover.restore(ref.appId, id, before.dir)
    this.rescanUser()
    const e = this.require(ref)
    Object.assign(e.life, { failures: 0, retryAt: 0, lastError: null, gaveUp: false })
    void this.reloadIfChanged(ref, { startIfStopped: true, why: 'a previous version was restored' })
    this.appsChanged()
    return this.info(e)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.watchers.close()
    this.handover.dispose()
    for (const t of [...this.turnEndTimers.values(), ...this.quietTimers.values()]) clearTimeout(t)
    this.turnEndTimers.clear()
    this.quietTimers.clear()
    this.appsListeners.clear()
    const all = [...this.scopes.values()].flatMap((s) => [...s.apps.values()])
    this.scopes.clear()
    // 종료 예산(Tauri 3초) 안에서 — 유예를 줄이고, SIGKILL까지 기다리지는 않는다
    await Promise.allSettled([
      ...all.map((e) => this.halt(e, 'host shutting down', { graceMs: 1_000, awaitKill: false })),
      // 어느 칸에도 없는 프로세스까지 (`spawned` 주석) — 이미 내리는 중이면 그 내림을 기다린다(stop은 한 번만 돈다)
      ...[...this.spawned].map((p) => p.stop(1_000, { awaitKill: false })),
    ])
    this.spawned.clear()
  }

  // ── 반영 (C-4) ─────────────────────────────────────────────────────────────────

  /**
   * 이 앱의 만드는 세션의 턴이 끝났다 (M4 C-4) — host가 세션 상태로 알린다.
   *
   * 앱 폴더가 바뀔 때마다 다시 띄우지 않는다: 만드는 에이전트는 한 턴에 파일 여러 개를 여러 번 고치고, 그 사이의
   * 앱은 반쯤 고친 코드다. 턴이 끝나야 한 덩어리의 수정이 끝난 것이고, 그것을 아는 것은 세션 상태를 보는 host뿐이다.
   * 알림은 짧게 모은다(턴 끝과 상태 변화가 잇달아 온다) — 한 턴에 한 번 다시 띄운다.
   *
   * 턴 끝에는 지금 폴더를 **직접 잰다**(지문). 감시 이벤트를 몇 개 놓쳤든 답이 맞다. 앱이 쉬다 내려가 있어도 바뀌었으면
   * 띄운다 — 만드는 세션의 도구 목록을 새 코드로 갈아야 한다.
   */
  builderTurnEnded(ref: AppRef): void {
    if (this.disposed) return
    const key = this.holdKey(ref)
    clearTimeout(this.turnEndTimers.get(key))
    const t = setTimeout(() => {
      this.turnEndTimers.delete(key)
      void this.reloadIfChanged(ref, { startIfStopped: true, why: "the builder's turn ended and the app folder changed" })
    }, this.timing.turnEndDebounceMs)
    t.unref()
    this.turnEndTimers.set(key, t)
  }

  /**
   * 앱 폴더가 바뀐 것을 훑기가 보았다 (C-4). 만드는 세션이 턴 안에 있으면 아무것도 하지 않는다 — 턴 끝이 반영한다.
   * 없거나 쉬고 있으면(편집기에서 고쳤다) 마지막 변화 뒤 조용해지기를 기다렸다가, 그때도 만드는 세션이 턴 밖이면
   * 반영한다. 이 길은 떠 있는 앱만 다시 띄운다 — 아무도 쓰지 않는 앱을 편집 때문에 깨우지 않는다(성능 예산).
   */
  private folderChanged(e: AppEntry): void {
    if (this.deps.builderBusy?.(e.ref)) return
    const key = this.holdKey(e.ref)
    clearTimeout(this.quietTimers.get(key))
    const ref = e.ref
    const t = setTimeout(() => {
      this.quietTimers.delete(key)
      if (this.deps.builderBusy?.(ref)) return
      void this.reloadIfChanged(ref, { startIfStopped: false, why: 'the app folder changed and stayed quiet' })
    }, this.timing.reloadQuietMs)
    t.unref()
    this.quietTimers.set(key, t)
  }

  /**
   * 폴더가 마지막으로 띄운 때와 다르면 지금 파일로 다시 띄운다 — 다시 띄웠으면 true.
   *
   * **진행 중인 호출은 끊지 않는다.** 끝날 때까지 기다린다(상한 없이 — 끊는 것이 더 나쁘다). 끝난 바로 그 틱에 내린다
   * (`drain` 주석). 폴더가 바뀌었다는 것은 작성자가 무언가 고쳤다는 뜻이라, 연달아 실패해 멈춘 앱도 다시 기회를
   * 얻는다(셈을 지운다). 다시 띄우면 도구 목록을 새로 읽고, 에이전트 도구가 달라졌으면 세션이 알림을 받는다
   * (Claude는 곧바로, Codex는 다음 스레드부터 — A-5 그대로). 열린 화면에도 "바뀌었다"를 보낸다.
   */
  private reloadIfChanged(ref: AppRef, opts: { startIfStopped: boolean; why: string }): Promise<boolean> {
    const key = this.holdKey(ref)
    const running = this.reloading.get(key)
    if (running) return running
    const p = (async () => {
      const e = this.find(ref)
      if (!e || !e.manifest || !e.scope.trusted || this.disposed) return false
      const L = e.life
      if (L.stamp === null || folderFingerprint(e.dir) === L.stamp) return false
      if (!opts.startIfStopped && !L.proc?.alive) return false
      while (L.inflight > 0) await this.drain(e, 60_000)
      // 기다리는 사이에 매니페스트가 바뀌어 칸이 갈렸거나 내려갔다 — 새 칸은 제 길로 뜬다
      if (this.find(ref) !== e || this.disposed) return false
      const pid = L.proc?.child.pid
      L.proc?.log.note(`reloading: ${opts.why}`)
      void this.halt(e, opts.why)
      Object.assign(L, { failures: 0, retryAt: 0, lastError: null, gaveUp: false })
      this.appsChanged()
      try {
        await this.use(e, async () => {})
        console.error(`[apps] ${this.label(ref)} reloaded (${opts.why})${pid ? `, was pid ${pid}` : ''}`)
        this.deps.emitChanged?.(ref)
      } catch (err) {
        // 못 떴다 — 이유는 목록(crashed)과 오류 묶음에 남는다. 만드는 세션의 check가 그 이유를 읽는다
        console.error(`[apps] ${this.label(ref)} reload failed: ${(err as Error).message.split('\n')[0]}`)
      }
      return true
    })().finally(() => this.reloading.delete(key))
    this.reloading.set(key, p)
    return p
  }

  /** 진행 중인 호출을 마친 뒤에 내린다 — 바뀐 매니페스트로 칸이 갈렸을 때 옛 칸의 프로세스를 거두는 길 */
  private async haltWhenDrained(e: AppEntry, why: string): Promise<void> {
    while (e.life.inflight > 0) await this.drain(e, 60_000)
    await this.halt(e, why)
  }

  // ── 수명 ──────────────────────────────────────────────────────────────────────

  /** 앱을 쓰는 동안은 쉬는 앱이 아니다 — 끝나면 쉬는 시계를 다시 건다 */
  private async use<T>(e: AppEntry, fn: (proc: AppProcess) => Promise<T>): Promise<T> {
    e.life.inflight += 1
    this.clearIdle(e)
    try {
      return await fn(await this.ensureRunning(e))
    } finally {
      e.life.inflight -= 1
      if (e.life.inflight === 0) for (const w of e.life.idleWaiters.splice(0)) w()
      this.armIdle(e)
    }
  }

  /**
   * 진행 중인 호출이 다 끝날 때까지 기다린다 — `ms` 안에 끝나면 true. 돌려받은 뒤 **같은 틱에** 내려야 한다:
   * 한 번 양보하면 그 사이에 들어온 호출이 다시 inflight를 올린다(부르는 쪽이 while로 다시 본다).
   */
  private drain(e: AppEntry, ms: number): Promise<boolean> {
    if (e.life.inflight === 0) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(t)
        resolve(true)
      }
      const t = setTimeout(() => {
        e.life.idleWaiters = e.life.idleWaiters.filter((w) => w !== waiter)
        resolve(false)
      }, ms)
      t.unref()
      e.life.idleWaiters.push(waiter)
    })
  }

  /**
   * 떠 있으면 그것을, 뜨는 중이면 그 약속을, 아니면 새로 띄운다.
   *
   * **한 번에 하나만 띄운다.** 동시에 온 필요 다섯이 각자 "없다"를 보고 각자 띄우면 프로세스
   * 다섯이 같은 데이터 폴더를 붙잡는다 — 세션 되살리기에서 겪은 것과 같은 모양이다
   * (`manager.ts`의 `resuming` 주석). 뜨는 중인 약속을 모두가 기다린다.
   */
  private ensureRunning(e: AppEntry): Promise<AppProcess> {
    const L = e.life
    if (!e.manifest) throw new AppUnavailableError(`앱을 띄울 수 없습니다 — 매니페스트가 틀렸습니다: ${e.error}`)
    if (!e.scope.trusted) {
      throw new AppUnavailableError('신뢰하지 않은 프로젝트의 앱은 띄우지 않습니다 — 프로젝트를 신뢰하면 뜹니다')
    }
    // 가져온 앱은 사람이 보고 켜기 전에 뜨지 않는다 (E-3) — 부를 때마다 본다: 켠 뒤 server·uses가 바뀌면 다음 기동부터 막힌다
    const held = this.held(e)
    if (held) throw new AppUnavailableError(held)
    if (L.gaveUp) {
      throw new AppUnavailableError(
        `${this.timing.maxFailures}번 연달아 실패해 멈췄습니다 — 고친 뒤 다시 시작하세요.\n${L.lastError ?? ''}`,
      )
    }
    if (L.proc?.alive) return Promise.resolve(L.proc)
    if (L.starting) return L.starting

    const epoch = L.epoch
    const p = (async () => {
      const wait = L.retryAt - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      if (L.epoch !== epoch || this.disposed) throw new AppUnavailableError('앱이 바뀌거나 내려가서 기동을 그만뒀습니다')
      const usedPrior = L.verdict !== undefined
      const pipeId = ++this.pipeSeq
      /*
       * 띄우기 **전에** 지문을 잰다 (C-4) — 못 뜬 앱도 "이 코드로 한 번 떠 봤다"가 남아야, 고친 뒤 턴 끝이 다시 띄운다.
       * 떴으면 한 번 더 잰다: 뜨면서 제 폴더에 무언가 쓰는 앱을 "바뀌었다"로 읽어 끝없이 다시 띄우지 않게.
       */
      L.stamp = folderFingerprint(e.dir)
      // git 밖의 앱은 이제 돌 코드를 판으로 떠 둔다 (E-1) — 같은 코드면 아무것도 하지 않는다. 판을 못 떠도 앱은 뜬다
      if (e.ref.projectId === null) this.handover.snapshot(e.ref.appId, e.dir, 'started', L.stamp)
      let proc: AppProcess
      try {
        proc = await AppProcess.start(this.spawnSpec(e, pipeId))
      } catch (err) {
        if (L.epoch === epoch) {
          // 기억한 세대로 붙다가 실패했다면 그 기억이 틀렸을 수 있다 — 다음엔 다시 묻는다
          if (usedPrior) L.verdict = undefined
          this.fail(e, (err as Error).message)
          const started = err instanceof AppStartError ? err : null
          this.recordError(e, {
            kind: 'start',
            at: Date.now(),
            message: started?.head ?? (err as Error).message.split('\n')[0]!,
            stderr: started?.stderr ?? [],
            tool: null,
            args: null,
            runId: null,
          })
        }
        throw new AppUnavailableError((err as Error).message)
      }
      if (L.epoch !== epoch || this.disposed) {
        this.remember(proc)
        void proc.stop(this.timing.graceMs)
        throw new AppUnavailableError('앱이 바뀌거나 내려가서 기동을 그만뒀습니다')
      }
      this.remember(proc)
      L.verdict = proc.verdict() ?? L.verdict
      L.stamp = folderFingerprint(e.dir)
      L.loaded = L.stamp
      L.proc = proc
      L.pipeId = pipeId
      L.lastError = null
      this.readTools(e, proc)
      proc.onUnexpectedExit = (reason) => this.crashed(e, proc, reason)
      return proc
    })()
    L.starting = p
    // 뜨는 중(starting)도, 뜬 뒤(running)와 못 뜬 뒤(crashed·failed)도 목록이 말하는 상태다 (A-8)
    this.appsChanged()
    const settled = () => {
      if (L.starting === p) L.starting = null
      this.appsChanged()
    }
    p.then(settled, settled)
    return p
  }

  private readTools(e: AppEntry, proc: AppProcess): void {
    const kept: AppTool[] = []
    const warnings: string[] = []
    const drop = (why: string) => {
      warnings.push(`도구를 뺐습니다 — ${why}`)
      proc.log.note(`tool dropped: ${why}`)
    }
    for (const t of proc.tools) {
      const err = toolNameError(t.name)
      if (err) {
        drop(err)
        continue
      }
      const vis = visibilityOf(t)
      if (!vis.ok) {
        drop(vis.error)
        continue
      }
      kept.push({ tool: t, visibility: vis.visibility })
    }
    if (e.manifest?.home && !kept.some((t) => t.tool.name === e.manifest?.home)) {
      warnings.push(`home 도구(${e.manifest.home})가 도구 목록에 없습니다`)
    }
    // 세션이 보는 것(에이전트 도구)이 달라졌을 때만 알린다 — 화면 전용 도구의 변화는 세션과 무관하다
    const forModel = (list: AppTool[] | null) =>
      list === null ? null : JSON.stringify(list.filter((t) => t.visibility.includes('model')).map((t) => t.tool))
    const before = forModel(e.life.known)
    e.life.tools = kept
    e.life.known = kept
    e.life.toolWarnings = warnings
    if (forModel(kept) !== before) this.appsChanged()
  }

  /**
   * 실패 하나를 센다. 세 번째면 멈추고, 아니면 다음 기동을 미룬다.
   *
   * **되살리기는 다음 필요가 한다.** 죽은 앱을 백오프 뒤 알아서 다시 띄우지 않는다 — 쉬는
   * 앱을 내리는 것(A-3)과 같은 원칙이다: 부르는 이가 없는 앱 프로세스는 떠 있을 이유가 없다.
   * 백오프는 "다음 기동이 이보다 이르지 않다"로 걸린다. 그 사이에 온 호출은 남은 시간을
   * 기다렸다가 띄운다.
   */
  private fail(e: AppEntry, reason: string): void {
    const L = e.life
    L.failures += 1
    L.lastError = reason
    const where = this.label(e.ref)
    if (L.failures >= this.timing.maxFailures) {
      L.gaveUp = true
      // 멈춘 앱은 세션에 붙지 않는다(결정 4) — 붙어 있던 세션이 떼어 내도록 알린다
      this.appsChanged()
      console.error(`[apps] ${where} stopped after ${L.failures} consecutive failures: ${reason.split('\n')[0]}`)
    } else {
      L.retryAt = Date.now() + this.timing.backoffBaseMs * 2 ** (L.failures - 1)
      console.error(`[apps] ${where} failed (${L.failures}/${this.timing.maxFailures}): ${reason.split('\n')[0]}`)
    }
  }

  private crashed(e: AppEntry, proc: AppProcess, reason: string): void {
    const L = e.life
    if (L.proc !== proc) return
    L.proc = null
    L.tools = null
    this.clearIdle(e)
    // 오래 잘 돌다 죽었다면 연속 실패가 아니다 — 새로 센다
    if (Date.now() - proc.startedAt >= this.timing.stableMs) L.failures = 0
    this.fail(e, reason)
    this.recordError(e, { kind: 'crash', at: Date.now(), message: reason.split('\n')[0]!, stderr: proc.log.tailLines(), tool: null, args: null, runId: null })
    // 파이프·로그를 정리하고, 그룹에 남은 자손이 있으면 거둔다
    void proc.stop(0)
    // 떠 있던 앱이 예고 없이 죽었다 — 화면 앞의 사람이 이유를 봐야 한다 (A-8, B-6)
    this.appsChanged()
  }

  /** 띄운 프로세스를 적는다 — 적을 때마다 이미 끝난 것은 걷는다(목록이 host의 수명 동안 자라지 않게) */
  private remember(proc: AppProcess): void {
    for (const p of this.spawned) if (!p.alive) this.spawned.delete(p)
    this.spawned.add(proc)
  }

  /** 내린다 — 쉬어서, 바뀌어서, 신뢰를 잃어서, host가 끝나서 */
  private async halt(e: AppEntry, why: string, opts: { graceMs?: number; awaitKill?: boolean } = {}): Promise<void> {
    const L = e.life
    L.epoch += 1
    this.clearIdle(e)
    const proc = L.proc
    L.proc = null
    L.tools = null
    if (!proc) return
    // 떠 있던 것이 내려간다 — 목록에서는 이 순간 running이 아니다 (A-8)
    this.appsChanged()
    proc.log.note(`stopping: ${why}`)
    await proc.stop(opts.graceMs ?? this.timing.graceMs, { awaitKill: opts.awaitKill })
  }

  private armIdle(e: AppEntry): void {
    this.clearIdle(e)
    const L = e.life
    if (L.inflight > 0 || this.viewsOf(e) > 0 || !L.proc) return
    L.idle = setTimeout(() => {
      L.idle = null
      if (L.inflight === 0 && this.viewsOf(e) === 0) void this.halt(e, `idle for ${this.timing.idleMs}ms`)
    }, this.timing.idleMs)
    L.idle.unref()
  }

  private viewsOf(e: AppEntry): number {
    return this.viewHolds.get(this.holdKey(e.ref)) ?? 0
  }

  /** 열린 화면의 열쇠. 경로에 쓰지 않으므로 프로젝트 id의 모양을 따지지 않는다(scopeDir와 다르다) */
  private holdKey(ref: AppRef): string {
    return `${ref.projectId ?? USER_SCOPE}/${ref.appId}`
  }

  private clearIdle(e: AppEntry): void {
    if (e.life.idle) clearTimeout(e.life.idle)
    e.life.idle = null
  }

  /**
   * 띄울 모양. 앱이 받는 것:
   *   - cwd = 앱 폴더
   *   - `CENTRALU_APP_DATA` = 저장소 밖의 데이터 폴더 (없으면 만든다). 앱 폴더에 쓰면 커밋되어
   *     팀에게 새어 나간다(플랜 "데이터와 비밀").
   *   - 매니페스트가 **선언한** 비밀만 환경 변수로
   * 받지 않는 것: host 자신의 변수(`CC_*`). 그중에는 host WebSocket 토큰(`CC_HOST_TOKEN`)이
   * 있다 — 앱에 넘기면 앱이 host의 모든 RPC를 부를 수 있다.
   */
  private spawnSpec(e: AppEntry, pipeId: number): SpawnSpec {
    const m = e.manifest!
    const scopeDir = this.scopeDir(e.ref)
    const dataDir = this.dataDirOf(e.ref)
    mkdirSync(dataDir, { recursive: true })
    const appKey = this.appKey(e.ref)
    const secrets = this.secrets.forApp(appKey, m.secrets ?? [])
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(this.deps.env ?? process.env)) {
      if (k.startsWith('CC_') || k.startsWith('CENTRALU_')) continue
      env[k] = v
    }
    Object.assign(env, secrets, { CENTRALU_APP_ID: e.ref.appId, CENTRALU_APP_DATA: dataDir })
    return {
      command: m.server.command,
      args: m.server.args,
      cwd: e.dir,
      env,
      logPath: join(this.deps.dataRoot, 'app-logs', scopeDir, `${e.ref.appId}.log`),
      logMaxBytes: this.timing.logMaxBytes,
      // 선언에서 빠졌어도 저장된 값은 전부 가린다 — 가려서 잃는 것은 없다
      redact: redactor(this.secrets.all(appKey)),
      prior: e.life.verdict,
      probeTimeoutMs: this.timing.probeTimeoutMs,
      connectTimeoutMs: this.timing.connectTimeoutMs,
      serveFd3: (fd3, note) =>
        serveBroker(
          fd3,
          {
            // 이 파이프의 앱, 이 파이프에서 열린 실행만 — 남의 id도 죽은 프로세스의 id도 통하지 않는다
            openRun: (runId) => {
              const run = this.openRuns.get(runId)
              return run && run.entry === e && run.pipeId === pipeId ? run.abort.signal : null
            },
            note,
            refused: (tool, args, why) => this.desk.refused({ ref: e.ref, name: m.name, manifest: m }, tool, args, why),
          },
          /*
           * 부탁한 앱은 이 파이프의 앱이고, 매니페스트는 **이 프로세스가 뜰 때 읽은 것**이다. 그 사이 매니페스트가 바뀌었으면
           * 새 칸이 서고 이 프로세스는 호출을 마친 뒤 내려간다 — 도는 동안은 자기가 뜬 선언대로 부탁한다(검증한 것이 곧 쓰는 것).
           */
          (tool, args, call) => this.desk.handle({ ref: e.ref, name: m.name, manifest: m }, tool, args, call),
          { keepaliveMs: this.timing.brokerKeepaliveMs },
        ),
    }
  }

  /** 앱의 데이터 폴더 — 앱 폴더 밖이다(플랜 "데이터와 비밀"). 앱은 `CENTRALU_APP_DATA`로 받는다 */
  private dataDirOf(ref: AppRef): string {
    return join(this.deps.dataRoot, 'app-data', this.scopeDir(ref), ref.appId)
  }

  /** 경로의 한 칸이 되는 범위 이름. 프로젝트 id는 UUID다 — 아니면 경로에 쓰지 않는다 */
  private scopeDir(ref: AppRef): string {
    if (ref.projectId === null) return USER_SCOPE
    if (!/^[A-Za-z0-9-]+$/.test(ref.projectId)) throw new AppUnavailableError(`경로에 쓸 수 없는 프로젝트 id: ${ref.projectId}`)
    return ref.projectId
  }

  private appKey(ref: AppRef): string {
    return `${this.scopeDir(ref)}/${ref.appId}`
  }

  private label(ref: AppRef): string {
    return `${ref.projectId === null ? 'user' : ref.projectId.slice(0, 8)}/${ref.appId}`
  }

  // ── 발견 ──────────────────────────────────────────────────────────────────────

  private require(ref: AppRef): AppEntry {
    const e = this.find(ref)
    if (!e) throw new AppUnavailableError(`그런 앱이 없습니다: ${ref.projectId ?? 'user'}/${ref.appId}`)
    return e
  }

  private find(ref: AppRef): AppEntry | undefined {
    return this.scopes.get(ref.projectId ?? USER_SCOPE)?.apps.get(ref.appId)
  }

  private info(e: AppEntry): ExternalAppInfo {
    const m = e.manifest
    const lastErrorAt = this.errorLog.get(this.holdKey(e.ref))?.[0]?.at
    return {
      appId: e.ref.appId,
      projectId: e.ref.projectId,
      dir: e.dir,
      name: m?.name ?? null,
      version: m?.version ?? null,
      description: m?.description ?? null,
      home: m?.home ?? null,
      trusted: e.scope.trusted,
      status: this.status(e),
      error: e.error ?? this.held(e) ?? e.life.lastError,
      warnings: [...e.warnings, ...e.life.toolWarnings],
      // 지문 전체는 쓸모가 없다 — 대조만 하는 열쇠라 앞 16자면 충분하다
      ...(e.life.loaded ? { codeStamp: e.life.loaded.slice(0, 16) } : {}),
      ...(lastErrorAt !== undefined ? { lastErrorAt } : {}),
      ...this.secretSlots(e),
      ...this.importMark(e),
    }
  }

  /**
   * 가져온 앱이 사람의 확인을 기다리나 (E-3) — 그 까닭, 아니면 null. 사용자 폴더 앱만 가져온 앱일 수 있다(프로젝트 앱은 프로젝트
   * 신뢰가 정한다, 결정 3). 부를 때마다 표시와 지금의 매니페스트를 대 본다(`AppHandover.gate`).
   */
  private held(e: AppEntry): string | null {
    return e.ref.projectId === null && e.manifest ? this.handover.gate(e.ref.appId, e.dir, e.manifest) : null
  }

  /** 목록에 실을 가져온 앱의 표시 (E-3) — 가져온 앱이 아니면 칸이 없다 */
  private importMark(e: AppEntry): Pick<ExternalAppInfo, 'imported'> {
    const imported = e.ref.projectId === null ? this.handover.imported(e.ref.appId, e.dir) : undefined
    return imported ? { imported } : {}
  }

  /** 선언한 비밀마다 값이 들어 있는가 (E, 비밀 칸) — 이름과 있음·없음만. 선언이 없으면 칸도 없다 */
  private secretSlots(e: AppEntry): Pick<ExternalAppInfo, 'secrets'> {
    const declared = e.manifest?.secrets ?? []
    if (declared.length === 0) return {}
    const stored = this.secrets.names(this.appKey(e.ref))
    return { secrets: declared.map((name) => ({ name, set: stored.has(name) })) }
  }

  private status(e: AppEntry): ExternalAppInfo['status'] {
    if (!e.manifest) return 'invalid'
    if (!e.scope.trusted) return 'untrusted'
    if (this.held(e)) return 'unconfirmed'
    const L = e.life
    if (L.gaveUp) return 'failed'
    if (L.proc?.alive) return 'running'
    if (L.starting) return 'starting'
    if (L.lastError) return 'crashed'
    return 'stopped'
  }

  private rescan(key: string): void {
    const held = this.scopes.get(key)
    if (!held || this.disposed) return
    const { scope } = held
    const result =
      scope.projectId === null
        ? scanApps(scope.root, USER_APPS_REL, [])
        : scanApps(scope.root, PROJECT_APPS_REL, ['', '.centralu'])
    const seen = new Set<string>()
    /** 세션에 붙는 앱의 집합이 달라질 수 있는 변화가 있었나 (A-5) */
    let changed = false
    for (const found of result.apps) {
      seen.add(found.folder)
      const prev = held.apps.get(found.folder)
      if (prev && prev.found.hash === found.hash && prev.found.error === found.error) {
        if (prev.scope.trusted !== scope.trusted) changed = true
        prev.scope = scope
        // 신뢰를 잃은 프로젝트의 앱은 바로 내린다 — 목록에는 남는다
        if (!scope.trusted) void this.halt(prev, 'project is no longer trusted')
        // 매니페스트 밖(server.mjs, 화면…)이 바뀌었나 (C-4) — 한 번이라도 띄운 앱만 잰다
        else if (prev.life.stamp !== null && folderFingerprint(prev.dir) !== prev.life.stamp) this.folderChanged(prev)
        continue
      }
      /*
       * 매니페스트가 바뀌었다 — 옛 명령으로 뜬 프로세스는 내리고, 셈과 기억한 세대도 새로 시작한다. 새 호출은 새 칸이
       * 받는다. 옛 프로세스는 **진행 중인 호출을 마친 뒤에** 내린다(C-4): 파일을 고쳤다고 누군가의 호출이 끊기면 안 된다.
       */
      if (prev) void this.haltWhenDrained(prev, 'manifest changed')
      held.apps.set(found.folder, this.entry(scope, found))
      changed = true
    }
    for (const [id, e] of [...held.apps]) {
      if (seen.has(id)) continue
      held.apps.delete(id)
      void this.halt(e, 'app folder removed')
      changed = true
    }
    this.watchers.setWatched(key, scope.root, result.watch)
    if (changed) this.appsChanged()
  }

  private entry(scope: Scope, found: ScannedApp): AppEntry {
    let { manifest, error } = found
    if (manifest && this.deps.reservedIds.includes(manifest.id)) {
      // 내장 앱과 같은 id면 `apps.invoke`가 어느 쪽을 부를지 갈린다 — 먼저 선 쪽이 이긴다
      error = `"${manifest.id}"는 내장 앱의 이름입니다 — 다른 id를 쓰세요`
      manifest = null
    }
    return {
      ref: { projectId: scope.projectId, appId: found.folder },
      scope,
      found,
      dir: found.dir,
      manifest,
      error,
      warnings: found.warnings,
      life: {
        proc: null,
        starting: null,
        failures: 0,
        retryAt: 0,
        lastError: null,
        gaveUp: false,
        verdict: undefined,
        epoch: 0,
        inflight: 0,
        idleWaiters: [],
        stamp: null,
        loaded: null,
        idle: null,
        tools: null,
        toolWarnings: [],
        known: null,
        pipeId: 0,
      },
    }
  }

  private dropScope(key: string): void {
    const held = this.scopes.get(key)
    this.watchers.setWatched(key, held?.scope.root ?? join(this.deps.dataRoot, USER_APPS_REL), [])
    this.scopes.delete(key)
    for (const e of held?.apps.values() ?? []) void this.halt(e, 'project removed')
    if (held?.apps.size) this.appsChanged()
  }
}

/** 결과의 글 부분을 이어 붙인다 — 사람이 읽을 한 줄(RPC의 `text`)과 실패의 이유가 된다 */
export function resultText(result: CallToolResult): string {
  return result.content
    .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
    .join('\n')
}
