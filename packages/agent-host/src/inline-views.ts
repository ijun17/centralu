import type { CallToolResult } from '@modelcontextprotocol/client'
import { APP_VIEWS_LIVE_PER_SESSION, type NormalizedEvent } from '@cc/protocol'
import { resourceUriOf, type AppRef, type ExternalApps } from './apps/external/runtime.js'
import type { SessionAppCall, SessionAppsHub } from './sessions/session-apps.js'
import type { ViewHost } from './views/view-host.js'

/**
 * 대화 안 앱 화면 (M4 B-1) — 세션의 에이전트가 화면이 달린 앱 도구를 부르면, 그 호출 카드 아래에
 * 화면이 선다(플랜 "화면이 뜨는 두 자리"의 1번, 표준의 본래 쓰임).
 *
 * 이 층이 하는 일은 셋이다.
 *   1. 세션의 앱 호출을 듣고(`SessionAppsHub.onCall`), 그 도구가 `_meta.ui.resourceUri`를 선언했으면
 *      화면 인스턴스를 연다(`ViewHost.open` — 연 동안 앱을 붙든다). 호출이 시작될 때 입력을, 끝날 때
 *      결과를 `app_view` 이벤트로 낸다. 화면은 규격대로 tool-input → tool-result(또는 tool-cancelled)를 받는다.
 *   2. **열기 전에 화면이 그 앱의 것인지 본다** (플랜 "사칭 차단"). 도구가 선언한 `ui://`가 그 앱의
 *      `resources/list`에 없으면 열지 않고 거절을 남긴다. 결과가 다른 화면을 가리켜도 같다.
 *   3. 인스턴스를 닫는다 — UI가 말할 때, 세션이 지워질 때, 앱이 사라지거나 더 돌 수 없을 때.
 *
 * 이 층은 호출을 바꾸지 않는다. 화면을 못 열어도(거절, 카드를 못 찾음) 호출은 그대로 돌고 에이전트는
 * 결과를 받는다 — 화면은 사람을 위한 덧붙임이지 호출의 조건이 아니다.
 *
 * 누가 부른 호출인지는 붙이기(session-apps.ts)가 안다. 어느 카드인지는 어댑터가 알려 주거나 짝지은
 * `callId`다(Claude: 요청의 `_meta`, Codex: 어댑터가 본 호출 시작과 짝짓기). 매니저와 런타임은 이 층을
 * 모른다 — host(main.ts)와 시험이 `attachInlineViews`로 잇는다(app-view-source.ts와 같은 자리).
 */

type AppViewEvent = Extract<NormalizedEvent, { type: 'app_view' }>

/**
 * 대화 안 화면의 숫자들 (B-1). 기본값이 제품의 값이고, 시험은 줄여서 쓴다.
 *
 * **다시 열기에 드는 것은 host의 메모리에만 둔다.** 화면을 다시 열 때 도구를 다시 부르지 않으려면(부르면
 * 앱의 상태가 또 바뀐다) 그 호출의 입력과 결과가 있어야 한다. 결과는 앱이 준 그대로라 무엇이 들었는지
 * 모르고, 실행 기록(A-6)도 인자를 요약만 남긴다 — 그래서 디스크에 쓰지 않고, 크기를 묶는다. host가
 * 다시 뜨면 사라지고, 그때 자리표시는 "앱 열기"만 준다.
 */
export type InlineLimits = {
  /** 한 대화에서 동시에 열어 두는 화면 수 — 넘치면 가장 오래 열린 것부터 닫는다(플랜: 살아 있는 화면은 최근 몇 개) */
  livePerSession: number
  /** 한 대화에서 다시 열 수 있게 들고 있는 호출 수 — 넘치면 오래된 것부터 버린다 */
  keptPerSession: number
  /** 호출 하나의 입력+결과(JSON 글자 수) 상한 — 넘치면 들고 있지 않는다 */
  keptCallMax: number
  /** host 전체의 상한 — 넘치면 어느 대화든 오래된 것부터 버린다 */
  keptTotalMax: number
}

export const DEFAULT_INLINE_LIMITS: InlineLimits = {
  // UI가 그려 두는 프레임의 수와 같다 — 넘치는 인스턴스는 앱을 붙들 뿐 보이지 않는다
  livePerSession: APP_VIEWS_LIVE_PER_SESSION,
  keptPerSession: 20,
  keptCallMax: 256 * 1024,
  keptTotalMax: 8 * 1024 * 1024,
}

/** 대화 안 화면 하나 — 호출 한 번, 카드 하나. 인스턴스는 오고 가도 이 칸은 들고 있는 동안 산다 */
type InlineView = {
  sessionId: string
  callId: string
  ref: AppRef
  tool: string
  uri: string
  /** 열린 인스턴스. 닫히면 null — 칸은 남는다(다시 열기) */
  instanceId: string | null
  /** 연 순서 — 상한은 가장 오래 **열린** 것부터 닫는다. 다시 열면 새 번호를 받는다 */
  openedAt: number
  toolInput: Record<string, unknown>
  /** 호출의 결말 — 아직 도는 중이면 둘 다 없다 */
  toolResult: CallToolResult | null
  cancelled: string | null
  /** 다시 열 수 있는가 — 결말이 너무 컸거나 앱이 사칭했으면 false */
  kept: boolean
  /** 들고 있는 크기 (keptTotalMax를 센다) */
  bytes: number
}

export type InlineViewsDeps = {
  rt: ExternalApps
  views: ViewHost
  hub: SessionAppsHub
  /** 이벤트를 내보내는 길 — host에서는 매니저의 기록·방송(`SessionManager.recordAppView`) */
  emit: (e: AppViewEvent) => void
  log?: (line: string) => void
  limits?: Partial<InlineLimits>
}

/** 다시 연 화면 — AppFrame이 규격대로 다시 보낼 것(입력, 그리고 결과나 취소) */
export type ReopenedView = {
  instanceId: string
  appId: string
  projectId: string | null
  tool: string
  toolInput: Record<string, unknown>
  toolResult?: CallToolResult
  cancelled?: string
}

/** 다시 열 수 없다 — 이유가 곧 메시지다(자리표시에 그대로 선다) */
function refuse(message: string): never {
  throw Object.assign(new Error(message), { code: 'internal' })
}

export class InlineViews {
  /** 세션 → (카드 id → 화면) */
  private bySession = new Map<string, Map<string, InlineView>>()
  private byInstance = new Map<string, InlineView>()
  private stops: (() => void)[]
  private disposed = false
  private readonly log: (line: string) => void
  private readonly limits: InlineLimits
  private seq = 0
  private keptBytes = 0

  constructor(private deps: InlineViewsDeps) {
    this.log = deps.log ?? ((line) => console.error(line))
    this.limits = { ...DEFAULT_INLINE_LIMITS, ...deps.limits }
    this.stops = [
      deps.hub.onCall((c) => {
        this.onCall(c).catch((err: unknown) => this.log(`[apps] inline view failed: ${(err as Error)?.message ?? String(err)}`))
      }),
      deps.hub.onSessionGone((sessionId) => this.dropSession(sessionId)),
      deps.rt.onAppsChanged(() => this.recheckApps()),
    ]
  }

  /**
   * UI가 화면을 내렸다(`apps.closeView`). 대화 안 화면이었으면 true — 인스턴스를 닫고 앱을 놓는다.
   * 그 밖의 인스턴스(고정 화면)는 부른 쪽이 ViewHost에서 닫는다.
   */
  close(instanceId: string): boolean {
    const v = this.byInstance.get(instanceId)
    if (!v) return false
    this.shut(v)
    return true
  }

  /**
   * 접었던 화면을 다시 연다 (RPC `apps.inlineReopen`) — **도구를 다시 부르지 않는다.** 새 인스턴스를 열고,
   * 들고 있던 입력과 결말을 돌려준다(AppFrame이 규격대로 다시 보낸다). 호출이 아직 돌고 있으면 결말 없이
   * 돌려주고, 끝나면 `result`·`cancelled`가 평소처럼 온다. 이미 열려 있으면 그 인스턴스다.
   *
   * 화면이 그 앱의 것인지 다시 본다 — 접은 사이 앱이 바뀌었을 수 있다. 열면 상한이 다시 걸린다(다른 화면이
   * 닫힐 수 있다). 다시 열 수 없으면 이유와 함께 실패한다.
   */
  async reopen(sessionId: string, callId: string): Promise<ReopenedView> {
    const v = this.bySession.get(sessionId)?.get(callId)
    if (!v || !v.kept) refuse("This view's result is no longer kept. Open the app instead")
    if (!v.instanceId) {
      const gone = this.unavailable(v.ref)
      if (gone) refuse(gone)
      // 연달아 실패해 멈춘 앱은 스스로 뜨지 않는다 — 화면을 열어도 부를 곳이 없다(다시 시작은 고정 화면의 Restart)
      if (this.deps.rt.list().find((a) => a.appId === v.ref.appId && a.projectId === v.ref.projectId)?.status === 'failed') {
        refuse('This app stopped after failing repeatedly. Restart it, then reopen this view')
      }
      const refusal = await this.refusal(v.ref, v.uri)
      if (refusal) refuse(refusal)
      // 기다리는 사이 다른 쪽이 먼저 열었을 수 있다
      if (!v.instanceId) {
        let instanceId: string
        try {
          instanceId = this.deps.views.open(v.ref, v.uri).instanceId
        } catch {
          refuse('This app is no longer available')
        }
        v.instanceId = instanceId
        v.openedAt = ++this.seq
        this.byInstance.set(instanceId, v)
        this.capLive(v.sessionId, v)
      }
    }
    return {
      instanceId: v.instanceId!,
      appId: v.ref.appId,
      projectId: v.ref.projectId,
      tool: v.tool,
      toolInput: v.toolInput,
      ...(v.toolResult ? { toolResult: v.toolResult } : {}),
      ...(v.cancelled !== null ? { cancelled: v.cancelled } : {}),
    }
  }

  /**
   * 한 대화에서 들고 있는 화면 (RPC `apps.inlineViews`) — 다시 연 UI가 지난 카드의 자리표시에 "Reopen"을 줄지
   * 정하는 근거다(`kept`). 열린 인스턴스도 알린다: 다시 연 UI는 그 인스턴스를 모르므로(입력·결과를 다시 보낼
   * 프레임이 없다) 닫아서 앱을 놓고, 사람이 원하면 다시 연다. 본문은 싣지 않는다 — 다시 열 때 온다.
   */
  list(sessionId: string): { callId: string; appId: string; projectId: string | null; tool: string; kept: boolean; instanceId: string | null }[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])]
      .sort((a, b) => a.openedAt - b.openedAt)
      .map((v) => ({ callId: v.callId, appId: v.ref.appId, projectId: v.ref.projectId, tool: v.tool, kept: v.kept, instanceId: v.instanceId }))
  }

  /** 이 인스턴스가 어느 세션의 어느 카드 화면인가 — 대화 안 화면이 아니면 null */
  owner(instanceId: string): { sessionId: string; callId: string; ref: AppRef } | null {
    const v = this.byInstance.get(instanceId)
    return v ? { sessionId: v.sessionId, callId: v.callId, ref: v.ref } : null
  }

  dispose(): void {
    this.disposed = true
    for (const stop of this.stops) stop()
    for (const v of [...this.byInstance.values()]) this.shut(v)
    this.bySession.clear()
  }

  private async onCall(c: SessionAppCall): Promise<void> {
    /*
     * 화면이 달린 도구인가 — **에이전트가 받는 목록**(model 도구)에서 본다. 앱이 선언한 그대로다. 보통은
     * 이미 읽은 목록이 있다(에이전트는 목록을 받고 나서 부른다). 없으면 호출이 어차피 앱을 띄우는
     * 중이라 그 목록을 기다린다.
     */
    const known = this.deps.rt.knownTools(c.ref, 'model') ?? (await this.deps.rt.tools(c.ref, 'model').catch(() => null))
    const def = known?.find((t) => t.name === c.tool)
    if (!def) return
    const ui = resourceUriOf(def)
    if (!ui.uri) return
    const callId = await c.callId
    const where = `${c.ref.projectId === null ? 'user' : c.ref.projectId.slice(0, 8)}/${c.ref.appId} ${c.tool}`
    if (!callId) {
      this.log(`[apps] ${where}: no conversation card matched this call — its view is not shown`)
      return
    }
    if (this.disposed) return
    const base = { type: 'app_view', sessionId: c.sessionId, callId, appId: c.ref.appId, projectId: c.ref.projectId, tool: c.tool } as const

    const refusal = await this.refusal(c.ref, ui.uri)
    if (refusal) {
      this.log(`[apps] ${where}: view rejected — ${refusal}`)
      this.deps.emit({ ...base, phase: 'rejected', reason: refusal })
      return
    }
    let instanceId: string
    try {
      instanceId = this.deps.views.open(c.ref, ui.uri).instanceId
    } catch (err) {
      // 그사이 앱이 사라졌다 — 연 것이 없으니 알릴 화면도 없다. 호출의 결말은 에이전트가 받는다
      this.log(`[apps] ${where}: view not opened — ${(err as Error).message}`)
      return
    }
    const v: InlineView = {
      sessionId: c.sessionId,
      callId,
      ref: c.ref,
      tool: c.tool,
      uri: ui.uri,
      instanceId,
      openedAt: ++this.seq,
      toolInput: c.args,
      toolResult: null,
      cancelled: null,
      kept: true,
      bytes: 0,
    }
    this.track(v)
    this.keep(v)
    this.deps.emit({ ...base, phase: 'open', instanceId, toolInput: c.args })
    // 살아 있는 화면은 최근 몇 개뿐이다 — 이 화면을 연 뒤에 센다(닫히는 것은 가장 오래 열린 것이다)
    this.capLive(c.sessionId, v)

    const o = await c.outcome
    /*
     * 결과가 **다른 화면**을 가리키면 사칭이다 — 규격의 화면은 도구의 선언에서 오지 결과에서 오지 않는다.
     * 우리는 결과의 그 칸을 쓰지 않지만, 다른 앱의 화면을 대려는 결과를 그 화면에 그대로 넘기지 않는다.
     */
    const claimed = o.result ? resultViewUri(o.result) : null
    if (claimed !== null && claimed !== ui.uri) {
      const reason = `This call's result points at ${claimed}, not at the screen its tool declares (${ui.uri})`
      this.log(`[apps] ${where}: view rejected — ${reason}`)
      this.shut(v)
      this.forget(v)
      this.deps.emit({ ...base, phase: 'rejected', reason })
      return
    }
    if (o.result) v.toolResult = o.result
    else v.cancelled = o.error ?? `The call ended without an answer (${o.status})`
    const kept = this.keep(v)
    if (o.result) this.deps.emit({ ...base, phase: 'result', toolResult: o.result, kept })
    else this.deps.emit({ ...base, phase: 'cancelled', reason: v.cancelled!, kept })
  }

  /**
   * 들고 있는 크기를 다시 재고, 상한 안에 둔다. 들고 있으면 true.
   *
   * 한 호출이 상한을 넘으면 입력·결말을 버리고 다시 열 수 없는 칸으로 둔다(열린 화면은 그대로 산다 —
   * 이미 받은 것을 화면에서 빼앗지 않는다). 대화별·전체 상한을 넘으면 **열려 있지 않은** 가장 오래된
   * 칸부터 버린다 — 열린 화면의 칸을 버리면 그 화면이 보낼 말(ui/message)의 주인을 잃는다.
   */
  private keep(v: InlineView): boolean {
    this.keptBytes -= v.bytes
    v.bytes = 0
    if (v.kept) {
      const bytes = jsonLength(v.toolInput) + (v.toolResult ? jsonLength(v.toolResult) : 0) + (v.cancelled?.length ?? 0)
      if (bytes > this.limits.keptCallMax) {
        v.kept = false
        this.log(`[apps] ${v.ref.appId} ${v.tool}: this call's view is too large to keep for reopening (${bytes} characters)`)
      } else v.bytes = bytes
    }
    // 들고 있지 않는 칸은 본문을 버린다 — 다시 열 수 없는 칸이 메모리를 쥐고 있을 까닭이 없다
    if (!v.kept) {
      v.toolInput = {}
      v.toolResult = null
    }
    this.keptBytes += v.bytes
    const mine = this.bySession.get(v.sessionId)
    if (mine) {
      const spare = [...mine.values()].filter((x) => !x.instanceId).sort((a, b) => a.openedAt - b.openedAt)
      while (mine.size > this.limits.keptPerSession && spare.length) this.forget(spare.shift()!)
    }
    if (this.keptBytes > this.limits.keptTotalMax) {
      const spare = [...this.bySession.values()]
        .flatMap((m) => [...m.values()])
        .filter((x) => !x.instanceId && x.bytes > 0)
        .sort((a, b) => a.openedAt - b.openedAt)
      while (this.keptBytes > this.limits.keptTotalMax && spare.length) this.forget(spare.shift()!)
    }
    return v.kept && !!this.bySession.get(v.sessionId)?.has(v.callId)
  }

  /** 칸을 버린다(인스턴스는 부르는 쪽이 먼저 닫는다) */
  private forget(v: InlineView): void {
    const mine = this.bySession.get(v.sessionId)
    if (mine?.get(v.callId) !== v) return
    mine.delete(v.callId)
    if (mine.size === 0) this.bySession.delete(v.sessionId)
    this.keptBytes -= v.bytes
    v.bytes = 0
  }

  /**
   * 한 대화의 살아 있는 화면을 상한 안에 둔다 — 가장 오래 열린 것부터 닫고 알린다(`closed`). UI는 그 화면에
   * teardown을 보낸 뒤 자리표시로 접는다. 방금 연 화면은 닫지 않는다.
   */
  private capLive(sessionId: string, keep: InlineView): void {
    const open = [...(this.bySession.get(sessionId)?.values() ?? [])].filter((x) => x.instanceId).sort((a, b) => a.openedAt - b.openedAt)
    const n = this.limits.livePerSession
    for (const old of open.slice(0, Math.max(0, open.length - n))) {
      if (old === keep) continue
      this.shut(old)
      this.deps.emit({
        type: 'app_view',
        sessionId,
        callId: old.callId,
        appId: old.ref.appId,
        projectId: old.ref.projectId,
        tool: old.tool,
        phase: 'closed',
        reason: `Only the ${n} most recent app views in a conversation stay open`,
      })
    }
  }

  /**
   * 이 화면이 이 앱의 것인가 — 앱이 내놓은 리소스 목록에 그 `ui://`가 있어야 한다. 문서는 어차피
   * 인스턴스의 앱에서만 읽지만(ViewHost), 남의 이름을 댄 선언은 여기서 끊고 이유를 남긴다: 앱을 만드는
   * 사람은 왜 화면이 안 뜨는지 알아야 한다. 리소스 템플릿은 받지 않는다(v1).
   */
  private async refusal(ref: AppRef, uri: string): Promise<string | null> {
    let listed: { uri: string }[]
    try {
      listed = await this.deps.rt.listResources(ref)
    } catch (err) {
      return `Could not check this app's screens: ${(err as Error).message.split('\n')[0]}`
    }
    if (listed.some((r) => r.uri === uri)) return null
    return `This app does not serve ${uri}. A tool may only show its own app's screen`
  }

  private track(v: InlineView): void {
    let mine = this.bySession.get(v.sessionId)
    if (!mine) this.bySession.set(v.sessionId, (mine = new Map()))
    const prev = mine.get(v.callId)
    if (prev) {
      this.shut(prev)
      this.forget(prev)
      mine = this.bySession.get(v.sessionId) ?? new Map()
      this.bySession.set(v.sessionId, mine)
    }
    mine.set(v.callId, v)
    if (v.instanceId) this.byInstance.set(v.instanceId, v)
  }

  /** 인스턴스를 닫는다(앱을 놓는다). 기록은 남긴다. 두 번 불러도 한 번 닫는다 */
  private shut(v: InlineView): void {
    if (!v.instanceId) return
    this.byInstance.delete(v.instanceId)
    this.deps.views.close(v.instanceId)
    v.instanceId = null
  }

  /**
   * 이 앱의 화면을 띄울 수 없는 까닭 — 앱이 사라졌거나, 그 프로젝트를 더 믿지 않거나, 매니페스트가 깨졌다.
   * 화면의 HTML도 그 앱의 코드라서 셋 모두 화면을 닫고 다시 열지 않는다(고정 화면 B-2와 같은 규칙). 죽었거나
   * 멈춘 앱은 여기 없다 — 화면의 다음 호출이 앱을 다시 띄운다. 이유는 화면에 그대로 서므로 사람의 말로 적는다.
   */
  private unavailable(ref: AppRef): string | null {
    const info = this.deps.rt.list().find((a) => a.appId === ref.appId && a.projectId === ref.projectId)
    if (!info) return 'This app was removed'
    if (info.status === 'untrusted') return "This app's project is no longer trusted"
    // 가져온 앱이 확인을 기다린다 (E-3) — 켠 뒤 무엇을 돌리는지가 바뀌었으면 화면의 HTML도 사람이 다시 보기 전의 코드다
    if (info.status === 'unconfirmed') return info.error ?? 'This imported app is not enabled'
    if (info.status === 'invalid') return `This app's manifest is invalid: ${info.error ?? 'unknown error'}`
    return null
  }

  /** 세션이 지워졌다 — 그 세션의 화면을 모두 닫고 잊는다. 알릴 대화가 없다 */
  private dropSession(sessionId: string): void {
    const mine = this.bySession.get(sessionId)
    if (!mine) return
    for (const v of [...mine.values()]) {
      this.shut(v)
      this.forget(v)
    }
    this.bySession.delete(sessionId)
  }

  /**
   * 앱이 사라졌거나 더 돌 수 없다 — 열린 화면을 닫고 이유를 알린다. 화면의 HTML도 그 앱의 코드라서,
   * 신뢰를 잃은 프로젝트의 화면을 계속 띄우지 않는다(고정 화면 B-2와 같은 규칙). 죽었거나 멈춘 앱은
   * 닫지 않는다 — 화면의 다음 호출이 앱을 다시 띄운다.
   */
  private recheckApps(): void {
    if (this.byInstance.size === 0) return
    for (const v of [...this.byInstance.values()]) {
      const reason = this.unavailable(v.ref)
      if (!reason) continue
      this.shut(v)
      this.deps.emit({
        type: 'app_view',
        sessionId: v.sessionId,
        callId: v.callId,
        appId: v.ref.appId,
        projectId: v.ref.projectId,
        tool: v.tool,
        phase: 'closed',
        reason,
      })
    }
  }
}

/** JSON으로 쓴 길이 — 들고 있는 크기를 재는 자다. 못 쓰는 값은 무한으로 친다(들고 있지 않는다) */
function jsonLength(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** 결과가 가리키는 화면 (`_meta.ui.resourceUri`, 옛 모양 `_meta["ui/resourceUri"]`) — 없으면 null */
function resultViewUri(result: CallToolResult): string | null {
  const meta = result._meta as { ui?: { resourceUri?: unknown }; 'ui/resourceUri'?: unknown } | undefined
  const raw = meta?.ui?.resourceUri ?? meta?.['ui/resourceUri']
  return raw === undefined || raw === null ? null : String(raw)
}

/**
 * host의 이음새 — main.ts와 시험이 같은 함수로 잇는다. 매니저가 가진 붙이기(hub)에서 호출을 듣고,
 * 이벤트는 매니저의 기록·방송 길로 낸다. 런타임을 매니저에 붙인(`useExternalApps`) 뒤에 부른다.
 */
export function attachInlineViews(
  mgr: { sessionAppsHub(): SessionAppsHub | null; recordAppView(e: AppViewEvent): void },
  rt: ExternalApps,
  views: ViewHost,
  opts: { log?: (line: string) => void; limits?: Partial<InlineLimits> } = {},
): InlineViews {
  const hub = mgr.sessionAppsHub()
  if (!hub) throw new Error('attachInlineViews: the session manager has no external apps (call useExternalApps first)')
  return new InlineViews({ rt, views, hub, emit: (e) => mgr.recordAppView(e), ...opts })
}
