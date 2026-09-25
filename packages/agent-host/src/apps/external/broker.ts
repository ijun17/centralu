import type { Socket } from 'node:net'
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { CLIENT_INFO } from '@cc/protocol'
import { z } from 'zod'

/**
 * 중개 서버 — 앱이 밖으로 부탁하는 길 (M4 A-4, 플랜 "앱이 밖으로 부탁하는 길", 스파이크 S-5).
 *
 * host가 앱 프로세스에 건네는 fd 3 위에서 **host가 MCP 서버이고 앱이 클라이언트다.** 파이프를
 * 가진 프로세스만 부를 수 있으므로 토큰이 없고, 누가 불렀는지는 파이프가 말해 준다(파이프는
 * 앱 하나에 묶여 태어난다). 무엇을 위해 불렀는지는 **실행 id**가 말한다: host가 앱에 도구
 * 호출을 보낼 때 `_meta["centralu/runId"]`에 싣고, 앱은 그 호출을 처리하는 동안 중개를 부를 때
 * 같은 id를 되돌려 붙인다(템플릿의 도우미가 감춘다 — S-5의 AsyncLocalStorage).
 *
 * 받아 주는 조건은 하나다: **이 파이프의 앱에 지금 열려 있는 실행 id.** 없으면(앱이 스스로
 * 깨어난 경우 — v1 범위 밖) 거절하고, 남의 id나 지어낸 id도 거절한다.
 *
 * 이 파일은 **문지기와 통로**만이다. 받아 준 부탁을 무엇으로 푸는지(선언·능력 승인·폭주 막기·기록, 그리고 도구마다의
 * 몸통)는 런타임의 창구(`desk.ts`)가 정한다 — 하나의 `BrokerHandler`로 넘긴다.
 */

/** 실행 id가 실리는 `_meta` 키. host→앱 호출과 앱→중개 호출이 같은 키를 쓴다 */
export const RUN_META = 'centralu/runId'

export const BROKER_TOOLS = ['run_agent', 'call_app', 'host_data'] as const
export type BrokerToolName = (typeof BROKER_TOOLS)[number]

/**
 * 기다리는 중개 호출에 보내는 진행 알림의 간격.
 *
 * 앱의 클라이언트는 한 요청의 답을 무한히 기다리지 않는다 — MCP SDK의 기본 상한은 60초이고, 템플릿의 도우미도 말이 없는
 * 채 60초가 지나면 포기한다(`app-runtime/src/broker.mjs`). 에이전트 실행은 그보다 길고(실측: haiku로 한 문장 답에 4.0초,
 * 스키마를 준 답에 5.6초 — 도구를 쓰는 일은 몇 분이다), 능력 승인은 사람을 5분까지 기다린다(D-4). 10초마다 한 번이면
 * 60초 상한 안에 여섯 번 닿는다 — 몇 번 늦어도 끊기지 않는다.
 */
export const BROKER_KEEPALIVE_MS = 10_000

/** 중개 호출을 부른 실행 — 창구가 사슬을 이어 붙이는 데 쓴다 */
export type BrokerCall = {
  /** 이 중개 호출을 일으킨 host→앱 호출의 실행 id */
  parentRunId: string
  /** 앱이 취소했거나, 부모 실행이 끝나거나 취소되면 선다 */
  signal: AbortSignal
  /**
   * 기다리는 앱에 지금 무슨 일인지 한 줄을 보낸다(진행 알림) — 앱이 진행 토큰을 실었을 때만 닿는다. 살려 두는 알림은
   * 이 통로가 알아서 보내므로(`BROKER_KEEPALIVE_MS`) 몸통은 "사람의 답을 기다린다"처럼 알릴 것이 있을 때만 부른다.
   */
  progress(message: string): void
}

/** 받아 준 중개 호출을 푸는 창구 하나 — 어느 도구든 이 한 자리로 들어온다 */
export type BrokerHandler = (tool: BrokerToolName, args: Record<string, unknown>, call: BrokerCall) => Promise<CallToolResult>

/** 파이프 하나의 문지기가 묻는 것 — "이 id가 지금 이 앱에 열려 있나" */
export type BrokerAdmission = {
  /** 열려 있으면 그 실행의 취소 신호, 아니면 null */
  openRun(runId: string): AbortSignal | null
  /** 거절을 앱별 로그에 남긴다 — 만드는 에이전트가 왜 막혔는지 읽는 자리다 */
  note(line: string): void
  /** 받지 않은 부탁을 실행 기록에도 남긴다 (D-6) — 거절도 한 줄이다. 사람이 앱의 기록 판에서 읽는 자리다 */
  refused(tool: BrokerToolName, args: Record<string, unknown>, why: string): void
}

const schemas: Record<BrokerToolName, { description: string; input: z.ZodObject<z.ZodRawShape> }> = {
  run_agent: {
    description:
      'Ask the agent of the person using this app, and get its final answer. Each request runs in a new session under this app. With schema (a JSON Schema whose top level is an object) the answer comes as JSON of that shape in structuredContent',
    input: z.object({
      prompt: z.string(),
      /** 매니페스트의 `uses.agent`가 허락한 도구 이름. 없으면 사람의 기본 에이전트 */
      tool: z.string().optional(),
      schema: z.record(z.string(), z.unknown()).optional(),
    }),
  },
  call_app: {
    description: "Call a tool of another app that this app's manifest lists in uses.apps (its tools open to agents only)",
    input: z.object({ app: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
  },
  host_data: {
    description:
      "Read Centralu's own data by name — a closed list (sessions.list, git.status), only the names this app declares in uses.host. All of it is read-only",
    // 이름은 여기서 열거로 막지 않는다 — 모르는 이름에 SDK의 입력 오류 대신 창구가 줄 수 있는 목록을 말한다
    input: z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
  },
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })

/**
 * fd 3 위에 중개 서버를 연다. 돌려받은 함수로 닫는다.
 *
 * host 쪽은 SDK의 전송을 그대로 쓴다(S-5: 추가 코드 0줄) — `serveStdio`가 두 세대를 다 받는다.
 */
export function serveBroker(
  fd3: Socket,
  admission: BrokerAdmission,
  handle: BrokerHandler,
  opts: { keepaliveMs?: number } = {},
): () => void {
  const keepaliveMs = opts.keepaliveMs ?? BROKER_KEEPALIVE_MS
  const serve = serveStdio(
    () => {
      const server = new McpServer({ name: `${CLIENT_INFO.name}-broker`, version: CLIENT_INFO.version }, { capabilities: { tools: {} } })
      for (const tool of BROKER_TOOLS) {
        server.registerTool(tool, { description: schemas[tool].description, inputSchema: schemas[tool].input }, async (args, ctx) => {
          const presented = ctx.mcpReq._meta?.[RUN_META]
          if (typeof presented !== 'string' || presented.length === 0) {
            const why = 'rejected: a broker call must carry the run id of the call being handled (an app waking up by itself is out of scope)'
            admission.note(`broker rejected ${tool}: no run id`)
            admission.refused(tool, args as Record<string, unknown>, why)
            return text(why, true)
          }
          const runSignal = admission.openRun(presented)
          if (!runSignal) {
            // 내민 id는 앱이 지어낸 글일 수 있다 — 이유에 싣되 길이를 자른다
            const shown = presented.length > 80 ? `${presented.slice(0, 80)}…` : presented
            const why = `rejected: ${shown} is not an open run of this app`
            admission.note(`broker rejected ${tool}: ${shown} is not an open run of this app`)
            admission.refused(tool, args as Record<string, unknown>, why)
            return text(why, true)
          }
          /*
           * 취소는 두 길로 온다: 앱이 자기 중개 호출을 취소하거나(notifications/cancelled →
           * ctx.mcpReq.signal), 위쪽이 부모 실행을 취소하거나. 앱이 신호를 넘겨주지 않는
           * 앱이어도 아래 일이 부모보다 오래 살지 않게 둘을 묶는다.
           */
          const signal = AbortSignal.any([ctx.mcpReq.signal, runSignal])
          /*
           * 기다리는 동안 앱을 살려 둔다 — 앱이 진행 토큰을 실었을 때만(규격: 토큰이 없으면 진행 알림을 보내지 않는다).
           * 값은 보낼 때마다 오른다(규격: progress는 늘어야 한다). 끝나면 멈춘다 — 답 뒤에 오는 알림은 받는 쪽이 모르는 토큰이다.
           */
          const token = ctx.mcpReq._meta?.progressToken
          let beat = 0
          const progress = (message?: string) => {
            if (token === undefined || signal.aborted) return
            beat += 1
            void ctx.mcpReq
              .notify({ method: 'notifications/progress', params: { progressToken: token, progress: beat, ...(message ? { message } : {}) } })
              .catch(() => {})
          }
          const timer = token === undefined ? null : setInterval(() => progress(), keepaliveMs)
          timer?.unref()
          try {
            return await handle(tool, args as Record<string, unknown>, { parentRunId: presented, signal, progress })
          } catch (e) {
            if (signal.aborted) return text(`cancelled: ${tool} under ${presented}`, true)
            return text(`${tool} failed: ${(e as Error).message}`, true)
          } finally {
            if (timer) clearInterval(timer)
          }
        })
      }
      return server
    },
    { transport: new StdioServerTransport(fd3, fd3), onerror: (e) => admission.note(`broker error: ${e.message}`) },
  )
  return () => void serve.close().catch(() => {})
}
