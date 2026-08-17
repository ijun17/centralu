import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { OrchestratorTools } from '../contract.js'

/**
 * 오케스트레이터의 도구를 Claude에게 붙인다 (FR-11).
 *
 * **인프로세스 MCP다** — 별도 프로세스도, 포트도, 인증도 없다. host 안의 함수가
 * 그대로 도구가 된다. 그래서 "이 앱이 관리하는 세션만"이 규칙이 아니라 구조다:
 * 이 도구들이 볼 수 있는 것은 넘겨받은 OrchestratorTools가 전부고,
 * 거기엔 파일도 프로젝트도 다른 도구도 없다.
 *
 * SDK 타입은 이 파일 밖으로 나가지 않는다 (anti-corruption).
 */
/** 서버 이름. 승인 예외가 이 이름으로 판정하므로 한 곳에서만 정한다 */
export const ORCHESTRATOR_MCP_NAME = 'control_center'

export function orchestratorMcp(tools: OrchestratorTools) {
  return createSdkMcpServer({
    name: ORCHESTRATOR_MCP_NAME,
    version: '1',
    /*
     * **미루지 않는다.**
     *
     * SDK는 기본적으로 MCP 도구를 도구 검색(ToolSearch) 뒤로 미룬다. 실측에서 그 탓에
     * 오케스트레이터가 list_sessions만 찾아 부르고 send_to_session은 보지도 못한 채
     * 아무 말 없이 턴을 끝냈다 — 목록만 읽고 일은 안 시킨 셈이다.
     *
     * 도구가 둘뿐이라 미뤄서 아낄 것도 없다. 오케스트레이터에게 이 둘은
     * 곁다리가 아니라 존재 이유다.
     */
    alwaysLoad: true,
    instructions: [
      '이 앱(Control Center)이 관리하는 세션들을 다루는 도구다.',
      '프로젝트를 가로지르는 질문이나 여러 세션에 걸친 일이면 먼저 list_sessions로 지금 상태를 본다.',
      '일을 시킬 때는 send_to_session을 쓴다 — 대상 세션의 승인 설정이 그대로 적용되므로,',
      '위험한 작업이면 그 세션에서 사람에게 승인을 묻게 된다.',
    ].join('\n'),
    tools: [
      tool(
        'list_sessions',
        '이 앱이 관리하는 세션 목록 (프로젝트·상태·마지막 한 줄). 오케스트레이터 자신과 보관된 세션은 빠진다.',
        {},
        async () => {
          const list = await tools.listSessions()
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  list.length === 0
                    ? '관리 중인 세션이 없습니다.'
                    : list
                        .map(
                          (s) =>
                            `- ${s.name} [${s.sessionId}] · 프로젝트 ${s.project} · ${s.tool} · ${s.state}` +
                            (s.preview ? `\n    최근: ${s.preview}` : ''),
                        )
                        .join('\n'),
              },
            ],
          }
        },
      ),

      tool(
        'send_to_session',
        '한 세션에 메시지를 보내 일을 시킨다. sessionId는 list_sessions가 준 것이어야 한다.',
        {
          sessionId: z.string().describe('list_sessions가 준 세션 id'),
          text: z.string().describe('그 세션에 보낼 지시'),
        },
        async ({ sessionId, text }) => {
          const r = await tools.sendToSession(sessionId, text)
          /*
           * 실패를 그대로 말해준다. 조용히 성공한 척하면 오케스트레이터는 시켰다고
           * 믿고 다음으로 넘어가고, 사람은 "시켰는데 안 했다"만 보게 된다.
           */
          return {
            content: [{ type: 'text' as const, text: r.ok ? `보냈습니다: ${sessionId}` : `보내지 못했습니다 — ${r.error}` }],
            isError: !r.ok,
          }
        },
      ),
    ],
  })
}
