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

/** 붙일 앱을 정하는 데 필요한 세션의 모양 — 이것이 결정 4가 보는 전부다 */
export type AppSessionKey = { id: string; kind: SessionKind; projectId: string | null }

/**
 * 도구 목록을 모르는 앱을 띄워 알아낼 때 기다리는 상한.
 *
 * Claude CLI는 세션을 시작하며 붙은 서버마다 `tools/list`를 부르고, Codex는 스레드를 시작하며
 * 다리의 `tools/list`를 기다린다. 앱이 뜨다 멈추면 세션까지 멈춘다 — 그래서 상한을 두고, 넘으면
 * 빈 목록으로 붙인다. 늦게라도 앱이 뜨면 목록을 다시 읽고 알린다(Claude는 곧바로, Codex는 다음
 * 스레드부터). 런타임의 연결 상한(30초)보다 짧아야 이 상한이 먼저 걸린다.
 */
export const TOOL_LIST_WAIT_MS = 15_000

/** 세션에 붙을 수 없는 앱의 상태 (결정 4) — 틀린 매니페스트, 신뢰하지 않은 프로젝트, 연달아 실패해 멈춤 */
const UNUSABLE = new Set(['invalid', 'untrusted', 'failed'])

type Hit = { ref: AppRef; server: string }

export class SessionAppsHub {
  /** 세션 id → 지금 살아 있는 핸들의 붙이기. 핸들을 갈아 끼우면 새 것이 자리를 잇는다 */
  private live = new Map<string, Attachment>()
  private stopListening: () => void

  constructor(
    readonly rt: ExternalApps,
    readonly opts: { toolListWaitMs?: number } = {},
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
   *
   * 신뢰는 런타임의 상태(`untrusted`)로 읽는다 — 정본은 저장소 하나고 런타임이 그것을 부를
   * 때마다 읽는다. 여기에 사본을 두면 신뢰를 끈 뒤에도 사본이 "예"라고 답한다.
   */
  refsFor(session: AppSessionKey): Hit[] {
    return this.rt
      .list()
      .filter((a) => !UNUSABLE.has(a.status))
      .filter((a) => (session.kind === 'orchestrator' ? a.projectId === null : session.projectId !== null && a.projectId === session.projectId))
      .map((a) => ({ ref: { projectId: a.projectId, appId: a.appId }, server: appMcpServerName(a.appId) }))
      .sort((x, y) => x.server.localeCompare(y.server))
  }

  dispose(): void {
    this.stopListening()
    for (const a of [...this.live.values()]) a.close()
  }
}

/** 핸들 하나의 붙이기 — 어댑터가 보는 `SessionApps`의 구현 */
class Attachment implements SessionApps {
  private listeners = new Set<() => void>()
  /** 마지막으로 알린(또는 처음 본) 모양 — 같으면 알리지 않는다 */
  private seen: string
  private closed = false

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
      return { server, appId: ref.appId, tools: known ? known.map(toSpec) : null }
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
    if (!hit) throw new Error(`이 세션에 붙은 앱이 아닙니다: ${server}`)
    const known = this.hub.rt.knownTools(hit.ref, 'model')
    if (known) return known.map(toSpec)
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
      return listed.map(toSpec)
    } catch (err) {
      console.error(`[apps] ${server} attached with no tools for now: ${(err as Error).message.split('\n')[0]}`)
      return []
    } finally {
      clearTimeout(timer)
    }
  }

  async call(server: string, tool: string, args: Record<string, unknown>, opts: { signal?: AbortSignal } = {}): Promise<AppToolResult> {
    const hit = this.find(server)
    // 붙지 않은 앱은 런타임까지 가지 않는다 — 이 세션이 부를 수 있는 앱은 결정 4가 정한 것뿐이다
    if (!hit) return failure(`이 세션에 붙은 앱이 아닙니다: ${server}`)
    const outcome = await this.hub.rt.call(hit.ref, tool, args, { kind: 'session', sessionId: this.session.id }, { signal: opts.signal })
    return toResult(outcome)
  }

  readOnly(server: string, tool: string): boolean {
    const hit = this.find(server)
    if (!hit) return false
    /*
     * 앱을 띄우지 않고 이미 읽은 목록만 본다. 승인 콜백은 모델이 **이미 본** 목록의 도구를 두고
     * 불리므로, 목록을 모르는 채로 불렸다면 그 도구는 모델이 우리 목록에서 고른 것이 아니다 —
     * 그때는 묻는다.
     */
    const found = this.hub.rt.knownTools(hit.ref, 'model')?.find((t) => t.name === tool)
    return found?.annotations?.readOnlyHint === true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.listeners.clear()
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
  const what = o.status === 'cancelled' ? '취소됐습니다' : o.status === 'rejected' ? '거절됐습니다' : '실패했습니다'
  return failure(`앱 호출이 ${what} — ${o.error ?? '이유를 받지 못했습니다'}`)
}

function failure(text: string): AppToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}
