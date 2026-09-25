import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { OrchestratorTools } from '../contract.js'
import {
  BUILDER_INSTRUCTIONS,
  MANAGER_INSTRUCTIONS,
  ORCHESTRATOR_MCP_NAME,
  ORCHESTRATOR_INSTRUCTIONS,
  SCOPED_INSTRUCTIONS,
  ORCHESTRATOR_TOOLS,
  appToolEntries,
  profileAllows,
  runOrchestratorTool,
} from '../../sessions/orchestrator-tools.js'
import type { ToolProfile } from '../../apps/contract.js'

/**
 * 오케스트레이터의 도구를 Claude에게 붙인다 (FR-11).
 *
 * **인프로세스 MCP다** — 별도 프로세스도, 포트도, 인증도 없다. host 안의 함수가
 * 그대로 도구가 된다. 그래서 "이 앱이 관리하는 세션만"이 규칙이 아니라 구조다:
 * 이 도구들이 볼 수 있는 것은 넘겨받은 OrchestratorTools가 전부고,
 * 거기엔 파일도 프로젝트도 다른 도구도 없다.
 *
 * **도구의 이름·설명·실행은 여기서 정하지 않는다** (sessions/orchestrator-tools.ts).
 * Codex는 다리를 거쳐 같은 것을 쓰므로, 정의가 둘이면 같은 앱인데 도구가 달라진다.
 *
 * SDK 타입은 이 파일 밖으로 나가지 않는다 (anti-corruption).
 */

/**
 * 서버 이름은 도구 정의 옆에서 온다 (sessions/orchestrator-tools.ts) — 승인 예외도,
 * 제안된 이름을 막는 검사도 같은 글자를 봐야 한다 (#93).
 */
export { ORCHESTRATOR_MCP_NAME }

export function orchestratorMcp(tools: OrchestratorTools, profile: ToolProfile = 'orchestrator', sessionId?: string) {
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
     * 오케스트레이터에게 이 도구들은 곁다리가 아니라 존재 이유다.
     */
    alwaysLoad: true,
    instructions:
      profile === 'manager' ? MANAGER_INSTRUCTIONS
      : profile === 'scoped' ? SCOPED_INSTRUCTIONS
      : profile === 'builder' ? BUILDER_INSTRUCTIONS
      : ORCHESTRATOR_INSTRUCTIONS,
    // 묶음이 허용하는 것만 노출한다 (#69) — 실행 쪽도 같은 판정을 한 번 더 한다.
    // 앱 도구(#81)도 같은 목록에 합류한다: 실행은 어차피 runOrchestratorTool이 명부로 라우팅한다
    tools: [
      ...ORCHESTRATOR_TOOLS.filter((t) => profileAllows(profile, t.name)),
      ...appToolEntries(profile),
    ].map((t) =>
      tool(t.name, t.description, t.schema.shape, async (args: Record<string, unknown>) => {
        const r = await runOrchestratorTool(tools, t.name, args, { sessionId: sessionId ?? null, profile })
        return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError }
      }),
    ),
  })
}
