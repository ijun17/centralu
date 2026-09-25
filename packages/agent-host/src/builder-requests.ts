import { builderRequestFrame, type Attachment, type BuilderRequestFacts, type BuilderRunFact, type SessionInfo } from '@cc/protocol'
import type { AppRef, ExternalApps } from './apps/external/runtime.js'
import type { ViewHost } from './views/view-host.js'

/**
 * 앱에서 만드는 세션으로 가는 말 (M4 C-5) — RPC `apps.askBuilder`의 몸통.
 *
 * 앱 화면 아래 입력줄("여기를 고쳐 줘")에 사람이 쓴 말이 그 앱의 만드는 세션에 간다. 사람은 앱을 떠나지 않는다. 말 앞에는
 * host가 **아는 사실**로 지은 머리말이 붙는다(protocol의 `builderRequestFrame`): 어느 앱의 어느 화면에서 왔는지, 앱이 멈춰
 * 있거나 마지막 실행이 실패했으면 그 사실. 사실은 host의 기록에서 읽는다 — 화면은 인스턴스(ViewHost)가, 상태는 앱 목록이,
 * 실행은 실행 기록이 정한다. 부른 쪽이 "이 화면이다"라고 적어 보낸 것을 믿지 않는 것은 #93·#94와 같은 원칙이다.
 *
 * 보내는 길은 사람의 말과 같다(`send`) — 첨부는 입력창과 같은 방식으로 경로가 붙고, 잠든 세션은 되살아난 뒤 받는다.
 * main.ts(rpc.ts)와 시험이 같은 함수를 쓴다(app-home-view.ts와 같은 자리).
 */
export type BuilderRequestDeps = {
  apps: ExternalApps
  /** 화면 인스턴스 — 없으면(화면 호스팅이 없는 host) 어느 화면인지는 말하지 않는다 */
  views?: ViewHost
  builderOf(ref: AppRef): SessionInfo | null
  send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>
}

export type BuilderRequest = {
  ref: AppRef
  text: string
  attachments?: Attachment[]
  /** 사람이 보던 고정 화면의 인스턴스 */
  instanceId?: string
}

function refuse(message: string): never {
  throw Object.assign(new Error(message), { code: 'internal' })
}

export async function askBuilder(deps: BuilderRequestDeps, req: BuilderRequest): Promise<{ sessionId: string }> {
  const text = req.text.trim()
  if (!text && !req.attachments?.length) refuse('Write what to change, or attach a screenshot')
  const info = deps.apps.list().find((a) => a.appId === req.ref.appId && a.projectId === req.ref.projectId)
  if (!info) refuse('This app no longer exists')
  const builder = deps.builderOf(req.ref)
  if (!builder) refuse('This app has no builder session yet. Start one, then ask again')
  const facts: BuilderRequestFacts = {
    app: { appId: info.appId, name: info.name ?? info.appId },
    screen: null,
    stopped: info.status === 'crashed' || info.status === 'failed' ? { status: info.status, reason: info.error } : null,
    latestRun: null,
  }
  if (req.instanceId) {
    const inst = deps.views?.describe(req.instanceId) ?? null
    if (!inst || inst.app.appId !== req.ref.appId || inst.app.projectId !== req.ref.projectId) {
      refuse("That view is not open for this app. Reopen the app's view and ask again")
    }
    // 고정 화면은 home 도구가 연 화면이다 — 대화 안 화면은 이 줄을 쓰지 않는다
    facts.screen = { tool: info.home ?? '(no home tool)', resourceUri: inst.uri }
  }
  // 마지막 실행이 성공이 아니면 싣는다 — 성공한 실행은 "이게 안 된다"는 말의 증거가 아니다
  facts.latestRun = notOk(deps.apps.runs(req.ref, 1)[0])
  await deps.send(builder.id, builderRequestFrame(facts, text), req.attachments)
  return { sessionId: builder.id }
}

const CALLERS: readonly string[] = ['view', 'session', 'app'] satisfies BuilderRunFact['callerKind'][]
const NOT_OK: readonly string[] = ['running', 'error', 'cancelled', 'rejected'] satisfies BuilderRunFact['status'][]

/** 기록의 한 줄(저장소는 글자로 준다) → 머리말의 사실. 성공했거나 모르는 모양이면 null */
function notOk(run: { tool: string; callerKind: string; status: string; error: string | null } | undefined): BuilderRunFact | null {
  if (!run || !NOT_OK.includes(run.status) || !CALLERS.includes(run.callerKind)) return null
  return {
    tool: run.tool,
    callerKind: run.callerKind as BuilderRunFact['callerKind'],
    status: run.status as BuilderRunFact['status'],
    error: run.error,
  }
}
