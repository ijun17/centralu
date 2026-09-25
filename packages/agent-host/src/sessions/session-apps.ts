import type { SessionKind } from '@cc/protocol'
import type { AppToolResult, AppToolSpec, AttachedApp, SessionApps } from '../adapters/contract.js'
import { appMcpServerName } from '../apps/contract.js'
import type { AppCallOutcome, AppRef, ExternalApps } from '../apps/external/runtime.js'

/**
 * 세션에 외부 앱을 붙인다 (M4 A-5) — **어느 세션이 어느 앱을 받는가**와, 세션의 에이전트가
 * 앱을 부르는 길을 여기서 한 번 정한다.
 *
 * 어댑터는 이 결정을 모른다. 받은 목록을 자기 방식(Claude는 인프로세스 대리 서버, Codex는
 * stdio 다리)으로 붙이고, 호출은 전부 `call`로 보낸다. `call`은 런타임의 단 하나의 길
 * (`ExternalApps.call`)을 호출자 `{ kind: 'session' }`으로 부른다 — 그래서 에이전트가 부른
 * 것도 화면이 부른 것과 같은 공개 범위 검사, 실행 id, 기록을 지난다(A-4, A-6).
 *
 * 코어가 외부 앱에 대해 아는 문은 `apps/external/runtime.ts` 하나다(`host-core-blind-to-apps`).
 * 이 파일도 그 문만 쓴다.
 */

/**
 * 붙일 앱을 정하는 데 필요한 세션의 모양 — 이것이 결정 4가 보는 전부다. `builderOf`는 그 세션이 만드는 앱이다
 * (M4 C-3): 만드는 세션은 자기 앱을 늘 받는다.
 */
export type AppSessionKey = { id: string; kind: SessionKind; projectId: string | null; builderOf?: AppRef | null }

/**
 * 도구 목록을 모르는 앱을 띄워 알아낼 때 기다리는 상한.
 *
 * Claude CLI는 세션을 시작하며 붙은 서버마다 `tools/list`를 부르고, Codex는 스레드를 시작하며
 * 다리의 `tools/list`를 기다린다. 앱이 뜨다 멈추면 세션까지 멈춘다 — 그래서 상한을 두고, 넘으면
 * 빈 목록으로 붙인다. 늦게라도 앱이 뜨면 목록을 다시 읽고 알린다(Claude는 곧바로, Codex는 다음
 * 스레드부터). 런타임의 연결 상한(30초)보다 짧아야 이 상한이 먼저 걸린다.
 */
export const TOOL_LIST_WAIT_MS = 15_000

/**
 * 먼저 돌려준 실행의 결말을 들고 있는 시간 (A-5 "오래 걸리는 호출"). 에이전트는 보통 몇 분 안에
 * `run_status`로 다시 묻는다. 이보다 오래된 것은 결과 본문 없이 기록(상태·이유)으로만 답한다.
 */
export const DETACHED_KEEP_MS = 60 * 60_000
/** 세션 하나가 들고 있을 수 있는 먼저 돌려준 실행의 수 — 넘치면 오래된 끝난 것부터 버린다 */
const DETACHED_PER_SESSION = 50

/**
 * 모든 앱 대리 서버에 host가 더하는 도구 (A-5) — 먼저 돌려받은 호출의 상태와 결과를 본다.
 *
 * 읽기만 한다(`readOnlyHint`) — 그래서 어느 프리셋에서도 묻지 않는다(결정 5). 앱에 같은 이름의
 * 도구가 있으면 host의 것이 이긴다: 오래 걸리는 호출을 이어서 볼 길이 앱마다 달라지면 안 된다.
 */
export const RUN_STATUS_TOOL = 'run_status'
const RUN_STATUS_SPEC: AppToolSpec = {
  name: RUN_STATUS_TOOL,
  title: 'Run status',
  description:
    'If a call to this app took long and you got "still running" with a run id (run_…) first, pass that id here to see its state now and its result once it has finished. Check with this instead of calling the tool again.',
  inputSchema: {
    type: 'object',
    properties: { run_id: { type: 'string', description: 'The run id you got first (it starts with run_)' } },
    required: ['run_id'],
  },
  annotations: { title: 'Run status', readOnlyHint: true, openWorldHint: false },
}

/** 먼저 돌려준 실행 하나 — 결말이 오면 채운다 */
type Detached = { sessionId: string; server: string; startedAt: number; outcome: AppCallOutcome | null }

/**
 * 카드 id 짝짓기 (M4 B-1) — 어댑터가 본 호출 시작과 다리로 들어온 호출이 서로를 기다리는 시간.
 * 같은 host 안의 두 길(어댑터의 표준 출력, 다리의 WebSocket)이라 보통 몇 ms 안에 만난다. 넘기면
 * 그 호출에는 대화 안 화면이 서지 않는다(호출 자체는 그대로 돈다).
 */
export const CALL_JOIN_WAIT_MS = 5_000
/** 짝을 못 만난 채 적어 둔 호출 시작을 들고 있는 시간과 수 — 넘치면 오래된 것부터 버린다 */
const NOTED_KEEP_MS = 60_000
const NOTED_MAX = 64

type Noted = { callId: string; server: string; tool: string; args: string; at: number }
type Waiter = { server: string; tool: string; args: string; resolve: (callId: string | null) => void; timer: NodeJS.Timeout }

/**
 * 세션의 에이전트가 앱 도구를 부른 한 번 (M4 B-1) — 대화 안 화면이 듣는다.
 *
 * 부르는 순간에 알린다(결말을 기다리지 않는다). 화면은 호출이 시작될 때 tool-input을, 끝날 때
 * tool-result를 받는다 — 규격의 순서가 곧 이 두 약속의 순서다.
 */
/** 세션의 앱 호출이 보낸 진행의 말 — 어느 대화의 어느 카드인지와 그 한 줄 */
export type SessionAppProgress = { sessionId: string; callId: string; message: string }

export type SessionAppCall = {
  sessionId: string
  ref: AppRef
  server: string
  tool: string
  args: Record<string, unknown>
  /** 대화의 도구 카드 id — 어댑터가 알려 줬거나 짝지은 것. 끝내 못 찾으면 null */
  callId: Promise<string | null>
  /** 호출의 결말 (먼저 돌려준 호출이어도 진짜 결말이다) */
  outcome: Promise<AppCallOutcome>
}

/**
 * 세션에 붙을 수 없는 앱의 상태 (결정 4) — 틀린 매니페스트, 신뢰하지 않은 프로젝트, 연달아 실패해 멈춤, 그리고 사람이 아직 켜지
 * 않은 가져온 앱(M4 E-3). 붙이지 않아도 부를 때마다 런타임이 다시 막는다(Codex 스레드에 남은 이름).
 */
const UNUSABLE = new Set(['invalid', 'untrusted', 'unconfirmed', 'failed'])

type Hit = { ref: AppRef; server: string }

export class SessionAppsHub {
  /** 세션 id → 지금 살아 있는 핸들의 붙이기. 핸들을 갈아 끼우면 새 것이 자리를 잇는다 */
  private live = new Map<string, Attachment>()
  /**
   * 실행 id → 먼저 돌려준 실행. **핸들이 아니라 hub에 둔다** — 세션이 다시 떠도(재개·재시작)
   * 같은 세션의 에이전트는 같은 id로 이어서 물을 수 있어야 한다.
   */
  readonly detached = new Map<string, Detached>()
  private stopListening: () => void
  private callListeners = new Set<(c: SessionAppCall) => void>()
  private progressListeners = new Set<(p: SessionAppProgress) => void>()
  private goneListeners = new Set<(sessionId: string) => void>()

  constructor(
    readonly rt: ExternalApps,
    readonly opts: { toolListWaitMs?: number; callJoinWaitMs?: number } = {},
  ) {
    this.stopListening = rt.onAppsChanged(() => {
      for (const a of [...this.live.values()]) a.recheck()
    })
  }

  /** 핸들 하나를 위한 붙이기를 만든다 — 어댑터에 넘기고, 핸들이 닫힐 때 어댑터가 닫는다 */
  attach(session: AppSessionKey): SessionApps {
    const a = new Attachment(this, session)
    this.live.set(session.id, a)
    return a
  }

  /**
   * 다리(인프로세스로 못 붙이는 어댑터 — Codex)가 들어오는 문. 다리는 별도 프로세스라 세션 id와
   * 서버 이름만 들고 온다 — 그 세션의 **지금 살아 있는 핸들의** 붙이기가 답한다. 살아 있는 핸들이
   * 없으면(세션이 잠들었거나 닫혔으면) 거절한다: 핸들 없는 세션의 이름으로 앱을 부를 수는 없다.
   */
  forSession(sessionId: string): SessionApps {
    const a = this.live.get(sessionId)
    if (!a) throw Object.assign(new Error(`This session cannot call apps right now (it is not running): ${sessionId}`), { code: 'session_not_found' })
    return a
  }

  /**
   * 세션의 앱 호출을 듣는다 (M4 B-1). 대화 안 화면이 여기서 "화면이 달린 도구인가"를 보고 화면을 연다.
   * 이 층은 화면을 모른다 — 알리기만 한다.
   */
  onCall(listener: (c: SessionAppCall) => void): () => void {
    this.callListeners.add(listener)
    return () => void this.callListeners.delete(listener)
  }

  /**
   * 세션의 앱 호출이 보낸 진행의 말을 듣는다 (M4 D) — 앱이 중개에서 받은 "사람을 기다린다" 같은 한 줄. 매니저가 그 세션의 도구 카드에
   * 실행 중 출력으로 붙인다. 이 층은 대화를 모른다 — 알리기만 한다.
   */
  onCallProgress(listener: (p: SessionAppProgress) => void): () => void {
    this.progressListeners.add(listener)
    return () => void this.progressListeners.delete(listener)
  }

  /** @internal 붙이기가 진행의 말 하나를 알린다 */
  progress(p: SessionAppProgress): void {
    for (const l of [...this.progressListeners]) {
      try {
        l(p)
      } catch (err) {
        console.error(`[apps] session-call progress listener failed:`, err)
      }
    }
  }

  /** 세션이 **지워졌다** (잠든 것과 다르다 — 잠든 세션은 다시 깬다). 그 세션의 화면을 걷는 신호다 */
  onSessionGone(listener: (sessionId: string) => void): () => void {
    this.goneListeners.add(listener)
    return () => void this.goneListeners.delete(listener)
  }

  /** 매니저가 세션을 지울 때 부른다 */
  sessionGone(sessionId: string): void {
    for (const l of [...this.goneListeners]) {
      try {
        l(sessionId)
      } catch (err) {
        console.error(`[apps] session-gone listener failed:`, err)
      }
    }
  }

  /** @internal 붙이기가 호출 하나를 알린다 — 듣는 쪽의 실패는 호출을 막지 않는다 */
  announce(c: SessionAppCall): void {
    for (const l of [...this.callListeners]) {
      try {
        l(c)
      } catch (err) {
        console.error(`[apps] session-call listener failed:`, err)
      }
    }
  }

  /** @internal 닫힌 붙이기가 자리를 비운다 — 이미 새 핸들이 이었으면 건드리지 않는다 */
  release(a: Attachment): void {
    if (this.live.get(a.session.id) === a) this.live.delete(a.session.id)
  }

  /**
   * 이 세션이 받는 앱 (결정 4).
   *
   *   오케스트레이터        사용자 폴더의 앱 (프로젝트에 속하지 않으므로 프로젝트 앱은 없다)
   *   프로젝트의 세션        그 프로젝트의 앱 — 신뢰한 프로젝트일 때만. 워크트리 세션도 같은
   *                        프로젝트 id를 가지므로 뿌리의 앱을 받는다(A-2: 인스턴스는 프로젝트당 하나)
   *   그 밖(프로젝트 없음)   없음
   *   만드는 세션 (C-3)       위에 더해 **자기 앱** — 사용자 폴더 앱의 만드는 세션은 프로젝트가 없어 위 규칙으로는
   *                        아무것도 받지 못한다. 자기가 만드는 앱의 도구를 불러 보는 것이 그 세션의 일이다
   *
   * 신뢰는 런타임의 상태(`untrusted`)로 읽는다 — 정본은 저장소 하나고 런타임이 그것을 부를
   * 때마다 읽는다. 여기에 사본을 두면 신뢰를 끈 뒤에도 사본이 "예"라고 답한다.
   */
  refsFor(session: AppSessionKey): Hit[] {
    return this.rt
      .list()
      .filter((a) => !UNUSABLE.has(a.status))
      .filter(
        (a) =>
          (session.kind === 'orchestrator' ? a.projectId === null : session.projectId !== null && a.projectId === session.projectId) ||
          (session.builderOf?.appId === a.appId && session.builderOf.projectId === a.projectId),
      )
      .map((a) => ({ ref: { projectId: a.projectId, appId: a.appId }, server: appMcpServerName(a.appId) }))
      .sort((x, y) => x.server.localeCompare(y.server))
  }

  /** @internal 먼저 돌려준 실행을 적는다 — 적을 때마다 오래된 것을 걷는다 */
  remember(runId: string, d: Detached): void {
    const now = Date.now()
    for (const [id, x] of this.detached) {
      if (x.outcome && now - x.startedAt > DETACHED_KEEP_MS) this.detached.delete(id)
    }
    const mine = [...this.detached].filter(([, x]) => x.sessionId === d.sessionId)
    for (const [id, x] of mine.slice(0, Math.max(0, mine.length - DETACHED_PER_SESSION + 1))) {
      if (x.outcome) this.detached.delete(id)
    }
    this.detached.set(runId, d)
  }

  dispose(): void {
    this.stopListening()
    this.callListeners.clear()
    this.goneListeners.clear()
    for (const a of [...this.live.values()]) a.close()
  }
}

/** 핸들 하나의 붙이기 — 어댑터가 보는 `SessionApps`의 구현 */
class Attachment implements SessionApps {
  private listeners = new Set<() => void>()
  /**
   * 이 핸들이 부른, 아직 끝나지 않은 호출 (먼저 돌려준 것 포함). 세션을 멈추거나 핸들을 닫으면
   * 여기 있는 것을 모두 취소한다 — 취소는 런타임이 앱(notifications/cancelled)과 그 아래 중개
   * 일까지 전한다(A-4의 부모 신호).
   */
  private inflight = new Set<AbortController>()
  /** 마지막으로 알린(또는 처음 본) 모양 — 같으면 알리지 않는다 */
  private seen: string
  private closed = false
  /** 카드 id 짝짓기 (B-1) — 어댑터가 본 호출 시작, 그리고 짝을 기다리는 호출 */
  private noted: Noted[] = []
  private waiters: Waiter[] = []

  constructor(
    private hub: SessionAppsHub,
    readonly session: AppSessionKey,
  ) {
    this.seen = JSON.stringify(this.current())
  }

  current(): AttachedApp[] {
    if (this.closed) return []
    return this.hub.refsFor(this.session).map(({ ref, server }) => {
      const known = this.hub.rt.knownTools(ref, 'model')
      return { server, appId: ref.appId, tools: known ? withRunStatus(known.map(toSpec)) : null }
    })
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** @internal 런타임이 "바뀌었을 수 있다"고 했다 — 이 세션이 보는 것이 정말 바뀌었을 때만 알린다 */
  recheck(): void {
    if (this.closed) return
    const now = JSON.stringify(this.current())
    if (now === this.seen) return
    this.seen = now
    for (const l of [...this.listeners]) {
      try {
        l()
      } catch (err) {
        console.error(`[apps] session ${this.session.id.slice(0, 8)} change listener failed:`, err)
      }
    }
  }

  async tools(server: string): Promise<AppToolSpec[]> {
    const hit = this.find(server)
    if (!hit) throw new Error(`This app is not attached to this session: ${server}`)
    const known = this.hub.rt.knownTools(hit.ref, 'model')
    if (known) return withRunStatus(known.map(toSpec))
    /*
     * 처음 필요한 순간이다 — 앱을 띄워 목록을 읽는다. 상한을 넘기거나 뜨지 못하면 빈 목록으로
     * 붙이고 그 이유를 남긴다. 뜨는 일 자체는 계속되고, 목록이 읽히면 런타임이 알린다.
     */
    const waitMs = this.hub.opts.toolListWaitMs ?? TOOL_LIST_WAIT_MS
    let timer: NodeJS.Timeout | undefined
    try {
      const listed = await Promise.race([
        this.hub.rt.tools(hit.ref, 'model'),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`did not list its tools within ${Math.round(waitMs / 1000)}s`)), waitMs)
        }),
      ])
      return withRunStatus(listed.map(toSpec))
    } catch (err) {
      console.error(`[apps] ${server} attached with no tools for now: ${(err as Error).message.split('\n')[0]}`)
      return withRunStatus([])
    } finally {
      clearTimeout(timer)
    }
  }

  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; waitMs?: number; callId?: string } = {},
  ): Promise<AppToolResult> {
    const hit = this.find(server)
    // 붙지 않은 앱은 런타임까지 가지 않는다 — 이 세션이 부를 수 있는 앱은 결정 4가 정한 것뿐이다
    if (!hit) return failure(`This app is not attached to this session: ${server}`)
    if (tool === RUN_STATUS_TOOL) return this.runStatus(hit, args)

    /*
     * 호출마다 취소 손잡이 하나 — 부른 쪽의 신호(CLI의 notifications/cancelled)와 이 세션의 멈춤
     * (cancelAll) 둘 중 먼저 오는 것이 당긴다. 먼저 돌려준 호출도 끝날 때까지 여기 남는다.
     */
    const abort = new AbortController()
    const onUp = () => abort.abort()
    if (opts.signal?.aborted) abort.abort()
    else opts.signal?.addEventListener('abort', onUp, { once: true })
    this.inflight.add(abort)

    let runId: string | null = null
    /** 이 호출의 대화 카드 — 아래에서 짝짓는다. 진행의 말은 호출이 앱에 간 뒤에 오므로 그때는 서 있다 */
    let card: Promise<string | null> | null = null
    const sessionId = this.session.id
    const onProgress = (message: string) =>
      void card?.then((callId) => {
        // 카드가 없는 호출(Claude 서브에이전트의 호출 등)은 붙일 자리가 없다 — 호출 자체는 그대로 돈다
        if (callId) this.hub.progress({ sessionId, callId, message })
      })
    const pending = this.hub.rt
      .call(hit.ref, tool, args, { kind: 'session', sessionId: this.session.id }, { signal: abort.signal, onRun: (id) => (runId = id), onProgress })
      // 앱이 부르는 사이에 사라졌다(폴더가 지워짐) — 던지지 않고 실패한 호출로 돌려준다
      .catch((err: Error): AppCallOutcome => ({ runId: runId ?? '', status: 'error', result: null, error: err.message, durationMs: 0 }))
      .finally(() => {
        this.inflight.delete(abort)
        opts.signal?.removeEventListener('abort', onUp)
      })
    // 대화 안 화면(B-1)이 듣는다 — 짝짓기는 모든 호출이 한다: 적어 둔 시작을 호출마다 소비해야 남은 것이 엉뚱한 호출과 짝지어지지 않는다
    this.hub.announce({
      sessionId: this.session.id,
      ref: hit.ref,
      server,
      tool,
      args,
      callId: (card = this.joinCall(server, tool, args, opts.callId)),
      outcome: pending,
    })
    if (!opts.waitMs) return toResult(await pending)

    /*
     * **상한이 있는 쪽의 호출** (플랜 "오래 걸리는 호출"). Codex는 MCP 도구 호출을 300초에 끊는다.
     * 그 전에(240초) 실행 id와 "아직 도는 중"을 먼저 돌려주고, 호출은 그대로 둔다 — 결과는 앱
     * 화면과 기록에 남고, 에이전트는 `run_status`로 이어서 본다. 끊기게 두면 앱의 일은 계속되는데
     * 에이전트는 결과를 받을 길을 잃는다.
     */
    let timer: NodeJS.Timeout | undefined
    const first = await Promise.race([
      pending.then((o) => ({ o })),
      new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), opts.waitMs))),
    ])
    clearTimeout(timer)
    if (first) return toResult(first.o)
    const entry: Detached = { sessionId: this.session.id, server, startedAt: Date.now() - opts.waitMs, outcome: null }
    this.hub.remember(runId!, entry)
    void pending.then((o) => (entry.outcome = o))
    const seconds = Math.round(opts.waitMs / 1000)
    return {
      content: [
        {
          type: 'text',
          text:
            `This call is still running (past ${seconds} s). Run id: ${runId}\n` +
            `The call has not stopped and carries on. Do not call it again: pass this id as run_id to the ${RUN_STATUS_TOOL} tool of the same server to get its result.`,
        },
      ],
      isError: false,
      structuredContent: { runId, status: 'running' },
    }
  }

  /**
   * `run_status` — 이 세션이 **이 앱에** 부른 실행만 본다. 다른 세션이나 화면의 실행은 결과가 그
   * 쪽의 것이라 보이지 않는다(실행 id를 알아도).
   *
   * 먼저 돌려준 실행은 결과 본문까지, 그 밖의 실행(제때 끝났거나 오래전 것)은 기록이 아는 상태와
   * 이유까지만 답한다 — 기록은 결과 본문을 남기지 않는다(A-6: 인자도 요약만 남긴다).
   */
  private runStatus(hit: Hit, args: Record<string, unknown>): AppToolResult {
    const runId = typeof args.run_id === 'string' ? args.run_id.trim() : ''
    if (!runId) return failure(`${RUN_STATUS_TOOL} needs a run_id`)
    const d = this.hub.detached.get(runId)
    if (d && d.sessionId === this.session.id && d.server === hit.server) {
      if (!d.outcome) {
        const seconds = Math.round((Date.now() - d.startedAt) / 1000)
        return {
          content: [{ type: 'text', text: `Run ${runId} is still running (${seconds} s so far). Check again a little later.` }],
          isError: false,
          structuredContent: { runId, status: 'running' },
        }
      }
      const o = d.outcome
      const done = toResult(o)
      return {
        content: [{ type: 'text', text: `Run ${runId} has finished (${o.status}, ${Math.round(o.durationMs / 1000)} s). Its result:` }, ...done.content],
        isError: done.isError,
        structuredContent: { runId, status: o.status, ...(done.structuredContent ? { result: done.structuredContent } : {}) },
      }
    }
    const row = this.hub.rt.runs(hit.ref, 500).find((r) => r.id === runId && r.callerKind === 'session' && r.callerSessionId === this.session.id)
    if (!row) return failure(`Unknown run id: ${runId} — a session can see only the runs it started on this app`)
    const why = row.error ? ` — ${row.error}` : ''
    return {
      content: [{ type: 'text', text: `Run ${runId}: ${row.status}${why}${row.status === 'running' ? '' : ' (its result is no longer kept)'}` }],
      isError: row.status !== 'ok' && row.status !== 'running',
      structuredContent: { runId, status: row.status },
    }
  }

  readOnly(server: string, tool: string): boolean {
    const hit = this.find(server)
    if (!hit) return false
    // host가 더한 도구 — 상태를 읽기만 한다
    if (tool === RUN_STATUS_TOOL) return true
    /*
     * 앱을 띄우지 않고 이미 읽은 목록만 본다. 승인 콜백은 모델이 **이미 본** 목록의 도구를 두고
     * 불리므로, 목록을 모르는 채로 불렸다면 그 도구는 모델이 우리 목록에서 고른 것이 아니다 —
     * 그때는 묻는다.
     */
    const found = this.hub.rt.knownTools(hit.ref, 'model')?.find((t) => t.name === tool)
    return found?.annotations?.readOnlyHint === true
  }

  cancelAll(): void {
    for (const abort of [...this.inflight]) abort.abort()
  }

  noteCall(callId: string, server: string, tool: string, args: unknown): void {
    if (this.closed || !callId) return
    const key = argsKey(args)
    // 다리가 먼저 왔다 — 기다리던 호출이 곧 이 카드다
    const w = this.waiters.findIndex((x) => x.server === server && x.tool === tool && x.args === key)
    if (w !== -1) {
      const [waiter] = this.waiters.splice(w, 1)
      clearTimeout(waiter!.timer)
      waiter!.resolve(callId)
      return
    }
    this.pruneNoted()
    this.noted.push({ callId, server, tool, args: key, at: Date.now() })
    if (this.noted.length > NOTED_MAX) this.noted.shift()
  }

  callEnded(callId: string): void {
    this.noted = this.noted.filter((n) => n.callId !== callId)
  }

  /**
   * 이 호출의 카드 id (B-1).
   *
   * **어댑터가 id를 알려 주면 그것이 답이다** — 에이전트의 MCP 클라이언트가 요청에 실어 보낸 id라서
   * 짝짓기가 필요 없다. 같은 id로 적어 둔 시작은 버린다(두 길이 모두 알린 경우). 없으면 적어 둔 시작
   * 중 (서버, 도구, 인자)가 같은 가장 오래된 것이다. 아직 없으면 잠깐 기다린다 — 어댑터의 알림이
   * 다리의 호출보다 늦게 도착할 수 있다.
   */
  private joinCall(server: string, tool: string, args: Record<string, unknown>, explicit?: string): Promise<string | null> {
    if (explicit) {
      this.callEnded(explicit)
      return Promise.resolve(explicit)
    }
    const key = argsKey(args)
    this.pruneNoted()
    const i = this.noted.findIndex((n) => n.server === server && n.tool === tool && n.args === key)
    if (i !== -1) return Promise.resolve(this.noted.splice(i, 1)[0]!.callId)
    if (this.closed) return Promise.resolve(null)
    const waitMs = this.hub.opts.callJoinWaitMs ?? CALL_JOIN_WAIT_MS
    return new Promise((resolve) => {
      const waiter: Waiter = {
        server,
        tool,
        args: key,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== waiter)
          resolve(null)
        }, waitMs),
      }
      waiter.timer.unref?.()
      this.waiters.push(waiter)
    })
  }

  private pruneNoted(): void {
    const cutoff = Date.now() - NOTED_KEEP_MS
    if (this.noted.length && this.noted[0]!.at < cutoff) this.noted = this.noted.filter((n) => n.at >= cutoff)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    // 닫힌 핸들의 호출은 받을 곳이 없다 — 먼저 돌려준 것까지 멈춘다
    this.cancelAll()
    this.listeners.clear()
    this.noted = []
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer)
      w.resolve(null)
    }
    this.hub.release(this)
  }

  /**
   * 서버 이름 → 앱. **부를 때마다 결정 4를 다시 본다** — 세션이 떴을 때 붙었던 앱이라도 지금
   * 신뢰를 잃었거나 멈췄으면 부르지 않는다. Codex는 스레드가 도는 동안 붙은 서버를 못 바꾸므로
   * 이 검사가 떼어 낸 앱을 실제로 막는 자리다.
   */
  private find(server: string): Hit | null {
    if (this.closed) return null
    return this.hub.refsFor(this.session).find((h) => h.server === server) ?? null
  }
}

type RuntimeTool = Awaited<ReturnType<ExternalApps['tools']>>[number]

/**
 * 인자의 비교 열쇠 — 키 순서를 가리지 않는 JSON. 어댑터가 본 인자는 문자열(Codex `item.arguments`)일
 * 수도, 객체일 수도 있다. 문자열이면 풀어서 같은 모양으로 맞춘다.
 */
function argsKey(args: unknown): string {
  let v = args
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v) as unknown
    } catch {
      return v as string
    }
  }
  return stable(v ?? {})
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** 앱의 도구 목록에 host의 `run_status`를 더한다 — 같은 이름의 앱 도구는 가린다(RUN_STATUS_SPEC 참고) */
function withRunStatus(tools: AppToolSpec[]): AppToolSpec[] {
  return [...tools.filter((t) => t.name !== RUN_STATUS_TOOL), RUN_STATUS_SPEC]
}

/** 런타임의 도구(MCP `Tool`) → 세션에 내놓는 모양. outputSchema는 뺀다(아래) */
function toSpec(t: RuntimeTool): AppToolSpec {
  /*
   * outputSchema를 싣지 않는 이유: 대리 서버를 거친 결과가 앱이 선언한 모양과 어긋나는 경우가
   * 있다 — 거절·취소는 host가 만든 글 한 줄이다. 받는 쪽 클라이언트가 선언을 믿고 검증하면
   * 그 한 줄이 "모양이 틀렸다"로 바뀌어 이유가 가려진다. structuredContent는 결과에 그대로 싣는다.
   */
  return {
    name: t.name,
    ...(t.title !== undefined ? { title: t.title } : {}),
    ...(t.description !== undefined ? { description: t.description } : {}),
    inputSchema: t.inputSchema as Record<string, unknown>,
    ...(t.annotations ? { annotations: t.annotations } : {}),
    ...(t._meta ? { _meta: t._meta } : {}),
  }
}

/** 런타임의 결말 → 에이전트가 받는 도구 결과 */
export function toResult(o: AppCallOutcome): AppToolResult {
  if (o.result) {
    return {
      content: o.result.content,
      isError: o.status !== 'ok',
      ...(o.result.structuredContent ? { structuredContent: o.result.structuredContent as Record<string, unknown> } : {}),
    }
  }
  const what = o.status === 'cancelled' ? 'was cancelled' : o.status === 'rejected' ? 'was refused' : 'failed'
  return failure(`The app call ${what} — ${o.error ?? 'no reason was given'}`)
}

function failure(text: string): AppToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}
