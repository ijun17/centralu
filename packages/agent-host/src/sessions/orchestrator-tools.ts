import { z } from 'zod'
import type { OrchestratorTools } from '../adapters/contract.js'

/**
 * 오케스트레이터 도구의 **유일한 정의**.
 *
 * 도구를 붙이는 길이 어댑터마다 다르다:
 *   Claude — 인프로세스 MCP (별도 프로세스 없음)
 *   Codex  — stdio 다리를 거쳐 host로 되돌아온다 (HTTP는 실측에서 안 붙었다)
 *
 * 길이 둘이어도 **도구는 하나여야 한다.** 각자 정의하면 이름이나 설명이 갈라지고,
 * 그러면 같은 앱인데 도구가 다르게 동작한다. 여기서 한 번 정하고 양쪽이 가져다 쓴다.
 */

export const ORCHESTRATOR_TOOLS = [
  {
    name: 'list_sessions',
    description:
      '이 앱이 관리하는 세션 목록 (프로젝트·상태·마지막 한 줄). 오케스트레이터 자신과 보관된 세션은 빠진다.',
    schema: z.object({}),
  },
  {
    name: 'recall',
    description:
      '지난 대화 전체에서 찾는다 (프로젝트를 가로지른다). "저번에 저쪽에서 하던 방식" 같은 것을 떠올릴 때 쓴다.',
    schema: z.object({
      query: z.string().describe('찾을 낱말. 문장보다 낱말이 잘 걸린다'),
      limit: z.number().optional().describe('가져올 조각 수 (기본 12)'),
    }),
  },
  {
    name: 'read_session',
    description:
      '한 세션의 최근 대화를 읽는다. 이미 끝난 일을 확인할 때 쓴다 — 방금 시킨 일의 결과를 기다리는 용도로는 send_to_session의 reportBack이 맞다.',
    schema: z.object({
      sessionId: z.string().describe('list_sessions가 준 세션 id'),
      limit: z.number().optional().describe('읽을 줄 수 (기본 40, 최근 것부터)'),
      around: z
        .number()
        .optional()
        .describe('recall이 준 seq. 주면 그 대목 언저리를 읽는다 (없으면 맨 끝)'),
      tools: z
        .boolean()
        .optional()
        .describe('도구 호출 본문까지 펼칠지. 기본은 한 줄로 접는다 — 스크립트 전문이 대화를 덮는다'),
    }),
  },
  {
    name: 'archive_session',
    description:
      '세션을 보관하거나(archived=true) 목록으로 되돌린다(false). 보관하면 그 세션의 프로세스가 내려가고 대기 중이던 승인·질문 카드도 걷힌다 — 화면이 막혔을 때 푸는 방법이다. 기록은 지워지지 않는다.',
    schema: z.object({
      sessionId: z.string().describe('list_sessions가 준 세션 id'),
      archived: z.boolean().describe('true면 보관, false면 되돌리기'),
    }),
  },
  {
    name: 'send_to_session',
    description: '한 세션에 메시지를 보내 일을 시킨다. sessionId는 list_sessions가 준 것이어야 한다.',
    schema: z.object({
      sessionId: z.string().describe('list_sessions가 준 세션 id'),
      text: z.string().describe('그 세션에 보낼 지시'),
      reportBack: z
        .boolean()
        .optional()
        .describe('그 세션이 일을 마치면 나에게 알려줄지. 사람이 결과를 기다리는 일이면 true'),
    }),
  },
] as const

export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOLS)[number]['name']

/** 모델에게 주는 안내 — 도구 목록과 함께 간다 */
export const ORCHESTRATOR_INSTRUCTIONS = [
  '이 앱(Centralu)이 관리하는 세션들을 다루는 도구다.',
  '프로젝트를 가로지르는 질문이나 여러 세션에 걸친 일이면 먼저 list_sessions로 지금 상태를 본다.',
  '일을 시킬 때는 send_to_session을 쓴다 — 대상 세션의 승인 설정이 그대로 적용되므로,',
  '위험한 작업이면 그 세션에서 사람에게 승인을 묻게 된다.',
  '사람이 결과를 기다리는 일이면 reportBack을 켠다 — 그 세션이 마치면 여기로 알려준다.',
  '보고만으로 부족하면 read_session으로 그 세션의 대화를 직접 읽는다.',
  'recall이 준 seq를 read_session의 around에 넣으면 찾은 대목으로 바로 간다 — 세션을 통째로 읽지 않는다.',
  '"저번에", "예전에 저쪽에서" 같은 이야기가 나오면 recall로 지난 대화를 찾는다 —',
  '사람과 나눈 대화가 프로젝트를 가로지르는 기억이고, 그 기억은 검색으로만 닿는다.',
].join('\n')

export type ToolOutput = { text: string; isError?: boolean }

/**
 * 도구 하나를 실행하고 **모델이 읽을 글**로 만든다.
 *
 * 렌더링까지 여기서 하는 이유: 두 길이 각자 문장을 만들면 같은 결과가 다르게 보인다.
 * 판단(무엇을 줄지)은 OrchestratorTools에, 표현(어떻게 보일지)은 여기에 둔다.
 */
export async function runOrchestratorTool(
  tools: OrchestratorTools,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutput> {
  if (name === 'list_sessions') {
    const list = await tools.listSessions()
    if (list.length === 0) return { text: '관리 중인 세션이 없습니다.' }
    return {
      text: list
        .map(
          (s) =>
            `- ${s.name} [${s.sessionId}] · 프로젝트 ${s.project} · ${s.tool} · ${s.state}` +
            (s.lastActive ? ` · 마지막 ${s.lastActive}` : '') +
            (s.preview ? `\n    최근: ${s.preview}` : ''),
        )
        .join('\n'),
    }
  }

  if (name === 'recall') {
    const query = String(args.query ?? '')
    const r = await tools.recall(query, args.limit as number | undefined)
    if (r.hits.length === 0) return { text: `"${query}"로는 찾은 것이 없습니다. 다른 낱말로 다시 찾아보세요.` }
    /*
     * seq를 함께 준다 — 이게 recall과 read_session을 맞물리게 하는 고리다.
     * 없으면 "찾긴 했는데 갈 수가 없어" 세션을 통째로 퍼올려 눈으로 찾아야 한다.
     */
    return {
      text: r.hits
        .map(
          (h) =>
            `- [${h.project}] ${h.session}${h.at ? ` · ${h.at}` : ''}\n` +
            `    ${h.snippet}\n` +
            `    → read_session(sessionId="${h.sessionId}", around=${h.seq})`,
        )
        .join('\n'),
    }
  }

  if (name === 'read_session') {
    const r = await tools.readSession(String(args.sessionId ?? ''), args.limit as number | undefined, {
      around: typeof args.around === 'number' ? args.around : undefined,
      tools: args.tools === true,
    })
    if (!r.ok) return { text: `읽지 못했습니다 — ${r.error}`, isError: true }
    /*
     * 아직 답하는 중이면 그렇다고 말한다.
     * 실측: read_session이 생기자 모델이 reportBack 대신 이것을 골랐는데, 보내자마자
     * 읽어서 사람의 지시만 있고 답은 없는 상태를 "결과"로 받았다.
     * 설득하는 문구 대신 지금 상태라는 사실을 준다 — 판단은 읽는 쪽이 한다.
     */
    const head =
      r.state === 'working'
        ? '⏳ 이 세션은 아직 답하는 중입니다. 아래는 지금까지의 대화이고, 마지막 답은 빠져 있을 수 있습니다.\n' +
          '   끝난 뒤에 알고 싶으면 send_to_session의 reportBack을 쓰세요.\n\n'
        : ''
    return { text: head + (r.lines?.join('\n') || '(대화 없음)') }
  }

  if (name === 'archive_session') {
    const sessionId = String(args.sessionId ?? '')
    const archived = args.archived === true
    const r = await tools.archiveSession(sessionId, archived)
    return {
      text: r.ok ? `${archived ? '보관했습니다' : '되돌렸습니다'}: ${sessionId}` : `하지 못했습니다 — ${r.error}`,
      isError: !r.ok,
    }
  }

  if (name === 'send_to_session') {
    const sessionId = String(args.sessionId ?? '')
    const reportBack = args.reportBack === true
    const r = await tools.sendToSession(sessionId, String(args.text ?? ''), reportBack)
    /*
     * 실패를 그대로 말해준다. 조용히 성공한 척하면 오케스트레이터는 시켰다고 믿고
     * 다음으로 넘어가고, 사람은 "시켰는데 안 했다"만 보게 된다.
     */
    return {
      text: r.ok
        ? `보냈습니다: ${sessionId}${reportBack ? ' (끝나면 알려드립니다)' : ''}`
        : `보내지 못했습니다 — ${r.error}`,
      isError: !r.ok,
    }
  }

  return { text: `알 수 없는 도구입니다: ${name}`, isError: true }
}

/** 다리(별도 프로세스)가 tools/list에 쓸 수 있는 형태 */
export function orchestratorToolSchemas(): { name: string; description: string; inputSchema: unknown }[] {
  return ORCHESTRATOR_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.schema),
  }))
}
