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
 * 도구 셋(`run_agent`, `call_app`, `host_data`)의 실제 몸통은 D의 일이다. 지금은 "아직 없다"를
 * 분명히 말하는 자리표시로 서서, 파이프·실행 id·취소가 이어져 있는지를 시험할 수 있게 한다.
 * 몸통은 `BrokerImpls`로 주입된다 — D가 채울 자리이자 테스트가 느린 몸통을 끼우는 자리다.
 */

/** 실행 id가 실리는 `_meta` 키. host→앱 호출과 앱→중개 호출이 같은 키를 쓴다 */
export const RUN_META = 'centralu/runId'

export const BROKER_TOOLS = ['run_agent', 'call_app', 'host_data'] as const
export type BrokerToolName = (typeof BROKER_TOOLS)[number]

/** 중개 호출을 부른 실행 — 몸통이 사슬을 이어 붙이는 데 쓴다 */
export type BrokerCall = {
  /** 이 중개 호출을 일으킨 host→앱 호출의 실행 id */
  parentRunId: string
  /** 앱이 취소했거나, 부모 실행이 끝나거나 취소되면 선다 */
  signal: AbortSignal
}

export type BrokerImpl = (args: Record<string, unknown>, call: BrokerCall) => Promise<CallToolResult>
export type BrokerImpls = Partial<Record<BrokerToolName, BrokerImpl>>

/** 파이프 하나의 문지기가 묻는 것 — "이 id가 지금 이 앱에 열려 있나" */
export type BrokerAdmission = {
  /** 열려 있으면 그 실행의 취소 신호, 아니면 null */
  openRun(runId: string): AbortSignal | null
  /** 거절을 앱별 로그에 남긴다 — 만드는 에이전트가 왜 막혔는지 읽는 자리다 */
  note(line: string): void
}

const schemas: Record<BrokerToolName, { description: string; input: z.ZodObject<z.ZodRawShape> }> = {
  run_agent: {
    description: '부른 세션의 에이전트에게 일을 맡긴다 (D-1)',
    input: z.object({ prompt: z.string(), tool: z.string().optional(), schema: z.unknown().optional() }),
  },
  call_app: {
    description: '다른 앱의 model 도구를 부른다 (D-2)',
    input: z.object({ app: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
  },
  host_data: {
    // 모양은 D-3이 정한다(uses.host의 어휘) — 지금은 파이프가 이어졌는지만 본다
    description: '호스트 데이터를 읽는다 (D-3, uses.host에 선언한 것만)',
    input: z.object({ query: z.string() }),
  },
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })

const notYet = (tool: BrokerToolName): BrokerImpl => async () =>
  text(`${tool} is not available yet — the broker's tools arrive with Centralu M4 section D`, true)

/**
 * fd 3 위에 중개 서버를 연다. 돌려받은 함수로 닫는다.
 *
 * host 쪽은 SDK의 전송을 그대로 쓴다(S-5: 추가 코드 0줄) — `serveStdio`가 두 세대를 다 받는다.
 */
export function serveBroker(fd3: Socket, admission: BrokerAdmission, impls: BrokerImpls = {}): () => void {
  const handle = serveStdio(
    () => {
      const server = new McpServer({ name: `${CLIENT_INFO.name}-broker`, version: CLIENT_INFO.version }, { capabilities: { tools: {} } })
      for (const tool of BROKER_TOOLS) {
        const impl = impls[tool] ?? notYet(tool)
        server.registerTool(tool, { description: schemas[tool].description, inputSchema: schemas[tool].input }, async (args, ctx) => {
          const presented = ctx.mcpReq._meta?.[RUN_META]
          if (typeof presented !== 'string' || presented.length === 0) {
            admission.note(`broker rejected ${tool}: no run id`)
            return text('rejected: a broker call must carry the run id of the call being handled (an app waking up by itself is out of scope)', true)
          }
          const runSignal = admission.openRun(presented)
          if (!runSignal) {
            admission.note(`broker rejected ${tool}: ${presented} is not an open run of this app`)
            return text(`rejected: ${presented} is not an open run of this app`, true)
          }
          /*
           * 취소는 두 길로 온다: 앱이 자기 중개 호출을 취소하거나(notifications/cancelled →
           * ctx.mcpReq.signal), 위쪽이 부모 실행을 취소하거나. 앱이 신호를 넘겨주지 않는
           * 앱이어도 아래 일이 부모보다 오래 살지 않게 둘을 묶는다.
           */
          const signal = AbortSignal.any([ctx.mcpReq.signal, runSignal])
          try {
            return await impl(args as Record<string, unknown>, { parentRunId: presented, signal })
          } catch (e) {
            if (signal.aborted) return text(`cancelled: ${tool} under ${presented}`, true)
            return text(`${tool} failed: ${(e as Error).message}`, true)
          }
        })
      }
      return server
    },
    { transport: new StdioServerTransport(fd3, fd3), onerror: (e) => admission.note(`broker error: ${e.message}`) },
  )
  return () => void handle.close().catch(() => {})
}
