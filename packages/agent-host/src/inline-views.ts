import type { CallToolResult } from '@modelcontextprotocol/client'
import type { NormalizedEvent } from '@cc/protocol'
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

/** 열린 대화 안 화면 하나 — 호출 한 번, 카드 하나 */
type InlineView = {
  sessionId: string
  callId: string
  ref: AppRef
  tool: string
  uri: string
  /** 열린 인스턴스. 닫히면 null — 기록은 남는다 */
  instanceId: string | null
}

export type InlineViewsDeps = {
  rt: ExternalApps
  views: ViewHost
  hub: SessionAppsHub
  /** 이벤트를 내보내는 길 — host에서는 매니저의 기록·방송(`SessionManager.recordAppView`) */
  emit: (e: AppViewEvent) => void
  log?: (line: string) => void
}

export class InlineViews {
  /** 세션 → (카드 id → 화면) */
  private bySession = new Map<string, Map<string, InlineView>>()
  private byInstance = new Map<string, InlineView>()
  private stops: (() => void)[]
  private disposed = false
  private readonly log: (line: string) => void

  constructor(private deps: InlineViewsDeps) {
    this.log = deps.log ?? ((line) => console.error(line))
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
    const v: InlineView = { sessionId: c.sessionId, callId, ref: c.ref, tool: c.tool, uri: ui.uri, instanceId }
    this.track(v)
    this.deps.emit({ ...base, phase: 'open', instanceId, toolInput: c.args })

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
      this.deps.emit({ ...base, phase: 'rejected', reason })
      return
    }
    if (o.result) this.deps.emit({ ...base, phase: 'result', toolResult: o.result })
    else this.deps.emit({ ...base, phase: 'cancelled', reason: o.error ?? `The call ended without an answer (${o.status})` })
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
    if (prev) this.shut(prev)
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

  /** 세션이 지워졌다 — 그 세션의 화면을 모두 닫고 잊는다. 알릴 대화가 없다 */
  private dropSession(sessionId: string): void {
    const mine = this.bySession.get(sessionId)
    if (!mine) return
    for (const v of mine.values()) this.shut(v)
    this.bySession.delete(sessionId)
  }

  /**
   * 앱이 사라졌거나 더 돌 수 없다 — 열린 화면을 닫고 이유를 알린다. 화면의 HTML도 그 앱의 코드라서,
   * 신뢰를 잃은 프로젝트의 화면을 계속 띄우지 않는다(고정 화면 B-2와 같은 규칙). 죽었거나 멈춘 앱은
   * 닫지 않는다 — 화면의 다음 호출이 앱을 다시 띄운다.
   */
  private recheckApps(): void {
    if (this.byInstance.size === 0) return
    const list = this.deps.rt.list()
    for (const v of [...this.byInstance.values()]) {
      const info = list.find((a) => a.appId === v.ref.appId && a.projectId === v.ref.projectId)
      const reason =
        !info ? 'This app was removed'
        : info.status === 'untrusted' ? "This app's project is no longer trusted"
        : info.status === 'invalid' ? `This app's manifest is invalid: ${info.error ?? 'unknown error'}`
        : null
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
  log?: (line: string) => void,
): InlineViews {
  const hub = mgr.sessionAppsHub()
  if (!hub) throw new Error('attachInlineViews: the session manager has no external apps (call useExternalApps first)')
  return new InlineViews({ rt, views, hub, emit: (e) => mgr.recordAppView(e), log })
}
