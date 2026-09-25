import type { CallToolResult } from '@modelcontextprotocol/client'
import type { AppRef, ExternalApps } from './apps/external/runtime.js'
import type { ViewHost } from './views/view-host.js'

/**
 * 고정 화면 하나를 연다 (M4 B-2) — RPC `apps.openView`의 몸통.
 *
 * 사이드바에서 앱을 누르면 host가 매니페스트의 `home` 도구를 부르고, 그 도구가 선언한 화면을 연다.
 * 호스트가 도구를 부르는 것도 규격에 맞는다. 화면은 여전히 도구 호출 한 번에서 태어난다(플랜 "화면이
 * 뜨는 두 자리"). 그래서 부르는 길은 다른 모든 호출과 같은 **단 하나의 길**(`ExternalApps.call`)이고,
 * 호출자는 **화면**이다. 공개 범위(`app`)도, 실행 기록도 거기서 한 번씩 일어난다. 기록에는 "화면이
 * home을 불렀다"로 남는다. 사람이 누른 것이지만, 화면의 호출을 "사람"으로 적지 않는 것과 같은 이유다.
 *
 * 순서: 화면이 있는지 먼저 보고(`homeView`), 부르고, 앱이 답했을 때만 인스턴스를 연다. 앱에 닿지
 * 못한 호출(거절, 기동 실패)에는 띄울 결과가 없으므로 인스턴스를 남기지 않고 이유로 실패한다. 앱이
 * 실패를 답한 호출(`isError`)은 연다. 그 실패를 그리는 것도 화면의 몫이다(규격의 tool-result).
 *
 * 다른 앱의 화면을 사칭할 길은 여기에 없다. 인스턴스는 부른 앱의 것이고, ViewHost는 문서를
 * 인스턴스의 앱에서만 읽는다. 결과에 무엇이 적혀 있든 읽는 곳은 이 앱의 프로세스다.
 *
 * main.ts(rpc.ts)와 시험이 같은 함수를 쓴다(`app-view-source.ts`와 같은 자리).
 */
export type HomeView = {
  instanceId: string
  tool: string
  resourceUri: string
  /** 화면에 tool-input으로 보낼 것 — host가 부른 인자 그대로다 */
  toolInput: Record<string, unknown>
  /** 앱의 답 그대로 — 화면의 tool-result가 된다 */
  toolResult: CallToolResult
  runId: string
}

export async function openHomeView(apps: ExternalApps, views: ViewHost, ref: AppRef): Promise<HomeView> {
  const home = await apps.homeView(ref)
  const toolInput: Record<string, unknown> = {}
  const out = await apps.call(ref, home.tool, toolInput, { kind: 'view' })
  if (!out.result) throw Object.assign(new Error(out.error ?? `The home tool "${home.tool}" did not answer`), { code: 'internal' })
  const { instanceId } = views.open(ref, home.resourceUri)
  return { instanceId, tool: home.tool, resourceUri: home.resourceUri, toolInput, toolResult: out.result, runId: out.runId }
}
