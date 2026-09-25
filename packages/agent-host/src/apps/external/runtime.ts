import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CallToolResult, PriorDiscovery, ReadResourceResult, Tool } from '@modelcontextprotocol/client'
import type { ExternalAppInfo } from '@cc/protocol'
import { DirWatchers } from '../../dev-services/watch.js'
import { AppProcess, type SpawnSpec } from './app-process.js'
import { RUN_META, serveBroker, type BrokerImpls } from './broker.js'
import { PROJECT_APPS_REL, USER_APPS_REL, scanApps, type ScannedApp } from './discovery.js'
import { toolNameError, type AppManifest } from './manifest.js'
import { FAILURES_KEPT, RUN_RETENTION_MS, describeArgs, type AppRunListed, type RunLedger } from './runs.js'
import { SecretStore, redactor } from './secrets.js'
import { visibilityOf, type Audience } from './visibility.js'

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

export type AppRef = { projectId: string | null; appId: string }

/** 기록의 모양은 이 문으로 나간다 — 코어가 채울 자리다(main.ts, `app-run-ledger.ts`) */
export type { RunLedger, AppRunRow, AppRunListed } from './runs.js'

/**
 * 누가 불렀나 (플랜 "호출 경로는 하나다") — 셋이다.
 *
 *   view     앱의 화면. v1 플랜은 이것을 "사람"이라 적었는데 틀렸다 — 화면은 앱의 코드라서
 *            아무도 누르지 않아도 도구를 부를 수 있다
 *   session  세션의 에이전트 (A-5가 붙인다)
 *   app      다른 앱의 중개 호출 (D-2) — 부모 실행 id로 사슬이 이어진다
 */
export type AppCaller =
  | { kind: 'view' }
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
   * 앱의 도구 호출이 끝났다(앱에 닿은 호출만 — 거절은 아무것도 바꾸지 않았다). 열린 화면이
   * 같은 값을 보게 하는 신호다(플랜 "열린 화면이 같은 값을 보는 법"). host가 방송으로 옮긴다.
   */
  emitChanged?: (ref: AppRef) => void
  /** 중개 서버 도구의 몸통 (D가 채운다). 없으면 "아직 없다"는 자리표시가 선다 */
  broker?: BrokerImpls
  /** 실행 기록을 둘 자리 (A-6) — host가 저장소로 채운다. 없으면 기록하지 않는다 */
  runs?: RunLedger
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
  idle: NodeJS.Timeout | null
  /** 지금 프로세스의 도구 목록(이름·공개 범위 규칙을 통과한 것)과, 걸러 낸 이유 */
  tools: AppTool[] | null
  toolWarnings: string[]
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

  constructor(private deps: ExternalAppsDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
    this.secrets = new SecretStore(deps.dataRoot)
    this.watchers = new DirWatchers((key) => this.rescan(key), deps.watchFlushMs)
    /*
     * 기동에 한 번: 끝을 못 본 실행을 닫고, 보관 기간 밖을 걷는다. 지금이 안전한 순간이다 —
     * 이 host가 연 실행은 아직 하나도 없다.
     */
    const settled = deps.runs?.settleUnfinished('the host stopped before this call finished') ?? 0
    const pruned = deps.runs?.prune(Date.now() - RUN_RETENTION_MS) ?? 0
    if (settled || pruned) console.error(`[apps] run records: ${settled} unfinished closed, ${pruned} past retention removed`)
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
    opts: { signal?: AbortSignal } = {},
  ): Promise<AppCallOutcome> {
    const e = this.require(ref)
    const runId = `run_${randomUUID()}`
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
    const done = (status: AppRunStatus, result: CallToolResult | null, error: string | null): AppCallOutcome => {
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
      if (sent) this.deps.emitChanged?.(e.ref)
      return { runId, status, result, error, durationMs }
    }

    // 앱에 보내기 전에 끝나는 판정 — 프로세스를 띄울 필요도 없다
    if (!e.manifest) return done('rejected', null, `매니페스트가 틀린 앱입니다: ${e.error}`)
    if (!e.scope.trusted) return done('rejected', null, '신뢰하지 않은 프로젝트의 앱은 부르지 않습니다')
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
        this.openRuns.set(runId, { entry: e, pipeId: e.life.pipeId, tool: name, abort })
        sent = true
        try {
          const result = await proc.client.callTool(
            { name, arguments: args, _meta: { [RUN_META]: runId } },
            { signal: abort.signal, timeout: this.timing.callTimeoutMs, resetTimeoutOnProgress: true },
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
  }

  /** 비밀 값을 적는다(`null`이면 지운다). 떠 있는 앱은 다음 기동부터 받는다 */
  setSecret(ref: AppRef, name: string, value: string | null): void {
    this.secrets.set(this.appKey(ref), name, value)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.watchers.close()
    const all = [...this.scopes.values()].flatMap((s) => [...s.apps.values()])
    this.scopes.clear()
    // 종료 예산(Tauri 3초) 안에서 — 유예를 줄이고, SIGKILL까지 기다리지는 않는다
    await Promise.allSettled(all.map((e) => this.halt(e, 'host shutting down', { graceMs: 1_000, awaitKill: false })))
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
      this.armIdle(e)
    }
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
      let proc: AppProcess
      try {
        proc = await AppProcess.start(this.spawnSpec(e, pipeId))
      } catch (err) {
        if (L.epoch === epoch) {
          // 기억한 세대로 붙다가 실패했다면 그 기억이 틀렸을 수 있다 — 다음엔 다시 묻는다
          if (usedPrior) L.verdict = undefined
          this.fail(e, (err as Error).message)
        }
        throw new AppUnavailableError((err as Error).message)
      }
      if (L.epoch !== epoch || this.disposed) {
        void proc.stop(this.timing.graceMs)
        throw new AppUnavailableError('앱이 바뀌거나 내려가서 기동을 그만뒀습니다')
      }
      L.verdict = proc.verdict() ?? L.verdict
      L.proc = proc
      L.pipeId = pipeId
      L.lastError = null
      this.readTools(e, proc)
      proc.onUnexpectedExit = (reason) => this.crashed(e, proc, reason)
      return proc
    })()
    L.starting = p
    p.then(
      () => void (L.starting === p && (L.starting = null)),
      () => void (L.starting === p && (L.starting = null)),
    )
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
    e.life.tools = kept
    e.life.toolWarnings = warnings
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
    // 파이프·로그를 정리하고, 그룹에 남은 자손이 있으면 거둔다
    void proc.stop(0)
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
    const dataDir = join(this.deps.dataRoot, 'app-data', scopeDir, e.ref.appId)
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
          },
          this.deps.broker,
        ),
    }
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
      error: e.error ?? e.life.lastError,
      warnings: [...e.warnings, ...e.life.toolWarnings],
    }
  }

  private status(e: AppEntry): ExternalAppInfo['status'] {
    if (!e.manifest) return 'invalid'
    if (!e.scope.trusted) return 'untrusted'
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
    for (const found of result.apps) {
      seen.add(found.folder)
      const prev = held.apps.get(found.folder)
      if (prev && prev.found.hash === found.hash && prev.found.error === found.error) {
        prev.scope = scope
        // 신뢰를 잃은 프로젝트의 앱은 바로 내린다 — 목록에는 남는다
        if (!scope.trusted) void this.halt(prev, 'project is no longer trusted')
        continue
      }
      // 매니페스트가 바뀌었다 — 옛 명령으로 뜬 프로세스는 내리고, 셈과 기억한 세대도 새로 시작한다
      if (prev) void this.halt(prev, 'manifest changed')
      held.apps.set(found.folder, this.entry(scope, found))
    }
    for (const [id, e] of [...held.apps]) {
      if (seen.has(id)) continue
      held.apps.delete(id)
      void this.halt(e, 'app folder removed')
    }
    this.watchers.setWatched(key, scope.root, result.watch)
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
        idle: null,
        tools: null,
        toolWarnings: [],
        pipeId: 0,
      },
    }
  }

  private dropScope(key: string): void {
    const held = this.scopes.get(key)
    this.watchers.setWatched(key, held?.scope.root ?? join(this.deps.dataRoot, USER_APPS_REL), [])
    this.scopes.delete(key)
    for (const e of held?.apps.values() ?? []) void this.halt(e, 'project removed')
  }
}

/** 결과의 글 부분을 이어 붙인다 — 사람이 읽을 한 줄(RPC의 `text`)과 실패의 이유가 된다 */
export function resultText(result: CallToolResult): string {
  return result.content
    .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
    .join('\n')
}
