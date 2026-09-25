import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { SessionApps } from '../contract.js'

/**
 * 외부 앱 하나를 Claude 세션에 붙이는 인프로세스 대리 서버 (M4 A-5).
 *
 * **대리 서버는 앱 프로세스에 붙지 않는다.** 도구 목록은 `SessionApps.tools`에서, 호출은
 * `SessionApps.call`로 간다 — 그 뒤는 런타임의 단 하나의 길(`ExternalApps.call`)이다. 그래서
 * 에이전트의 호출도 화면의 호출과 같은 공개 범위 검사·실행 id·기록을 지난다. 여기가 앱에 직접
 * 붙으면 그 셋을 한 벌 더 만들거나, 빠뜨리게 된다.
 *
 * **왜 SDK의 `tool()`을 쓰지 않나.** `tool()`은 zod 모양만 받는다(sdk.d.ts: `AnyZodRawShape`).
 * 앱의 입력 스키마는 JSON Schema이고, 그것을 zod로 옮겼다가 SDK가 다시 JSON Schema로 풀면
 * (`McpServer`의 tools/list가 그렇게 한다) 설명·기본값·`additionalProperties` 같은 것이
 * 오가며 달라진다 — 모델은 앱이 말한 것과 다른 도구를 본다. 그래서 `createSdkMcpServer`로
 * 서버의 자리(이름, SDK 전송)만 받고, `tools/list`·`tools/call` 처리기는 그 안의 저수준
 * 서버에 직접 단다. 앱의 스키마와 주석이 한 글자도 바뀌지 않고 모델에게 간다.
 *
 * 실측(설치된 0.3.263의 sdk.mjs): `createSdkMcpServer`는 `tools`가 주어지면(빈 배열이라도)
 * 도구 능력을 켠 v1 `McpServer`를 만들고, 도구를 하나도 등록하지 않으면 그 처리기를 달지
 * 않는다 — 그래서 우리 처리기와 겹치지 않는다. 처리기의 스키마는 메서드 이름만 읽힌다
 * (`Schema is missing a method literal`을 피하려고 `method` 리터럴을 둔다).
 *
 * SDK 타입은 이 폴더 밖으로 나가지 않는다 (anti-corruption).
 */

/** SDK가 품은 v1 저수준 서버 중 우리가 쓰는 부분 */
type LowLevelServer = {
  registerCapabilities(capabilities: Record<string, unknown>): void
  setRequestHandler(
    schema: unknown,
    handler: (request: { params: Record<string, unknown> }, extra: { signal?: AbortSignal }) => Promise<unknown>,
  ): void
  sendToolListChanged(): Promise<void>
}

const ListTools = z.object({ method: z.literal('tools/list'), params: z.optional(z.looseObject({})) })
const CallTool = z.object({
  method: z.literal('tools/call'),
  params: z.looseObject({ name: z.string(), arguments: z.optional(z.record(z.string(), z.unknown())) }),
})

export type AppProxy = {
  /** SDK에 넘길 설정 (`mcpServers[이름]`) — 같은 앱이 붙어 있는 동안은 같은 객체다 */
  config: ReturnType<typeof createSdkMcpServer>
  /** 도구 목록이 바뀌었다고 CLI에 알린다 — CLI가 `tools/list`를 다시 부른다 */
  toolsChanged(): void
}

export function appProxy(apps: SessionApps, server: string): AppProxy {
  const config = createSdkMcpServer({ name: server, version: '1', tools: [] })
  const low = (config.instance as unknown as { server: LowLevelServer }).server
  /*
   * 목록이 바뀌었다는 알림을 보낼 수 있다고 미리 말해 둔다(연결 전에만 된다). 앱의 도구가
   * 바뀌면 서버를 갈아 끼우는 대신 이 알림 하나로 끝난다 — Claude는 `tools/list_changed`를
   * 받으면 목록을 다시 읽는다.
   */
  low.registerCapabilities({ tools: { listChanged: true } })
  low.setRequestHandler(ListTools, async () => ({
    // 떨어져 나간 앱이면 빈 목록이다 — CLI가 이 서버를 아직 들고 있는 짧은 틈이 있다
    tools: await apps.tools(server).catch(() => []),
  }))
  low.setRequestHandler(CallTool, async (request, extra) => {
    const { name, arguments: args } = request.params as { name: string; arguments?: Record<string, unknown> }
    // CLI가 호출을 취소하면(notifications/cancelled) extra.signal이 선다 — 그대로 앱 호출까지 간다
    return apps.call(server, name, args ?? {}, { signal: extra?.signal })
  })
  return {
    config,
    toolsChanged: () => {
      // 아직 연결 전이면 알릴 곳이 없다 — 연결될 때 CLI가 어차피 목록을 읽는다
      void Promise.resolve()
        .then(() => low.sendToolListChanged())
        .catch(() => {})
    },
  }
}
