import { z } from 'zod'
import { ToolName } from '@cc/protocol'
import type { OrchestratorTools } from '../adapters/contract.js'
import { appGuide, APP_GUIDE_TOPICS } from './app-guide.js'

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
  {
    name: 'app_guide',
    description:
      '이 앱(Centralu)의 안내서 (#30). 사람이 "이 앱으로 뭘 할 수 있어?"류를 물으면 여기서 읽고 답한다 — 짐작으로 답하지 않는다.',
    schema: z.object({
      topic: z
        .string()
        .optional()
        .describe(`주제: ${APP_GUIDE_TOPICS.join(' | ')}. 생략하면 개요와 주제 목록`),
    }),
  },
  {
    name: 'update_session_settings',
    description:
      '한 세션의 모델·추론 강도·응답 길이를 바꾼다 (#30). 권한(승인) 설정은 여기 없다 — 그건 사람만 바꾼다. 작업 중인 세션은 거절된다 (적용에 재시작이 필요해 진행 중인 턴이 죽는다).',
    schema: z.object({
      sessionId: z.string().describe('list_sessions가 준 세션 id'),
      model: z.string().nullable().optional().describe('모델 id. null이면 도구 기본값'),
      effort: z.string().nullable().optional().describe('추론 강도. null이면 기본값'),
      verbosity: z.string().nullable().optional().describe('응답 길이 (codex 전용). null이면 기본값'),
    }),
  },
  {
    name: 'propose_project',
    description:
      '사이드바의 "Add project" 버튼을 사람에게 **가리킨다** (#63). 그 버튼에 불이 켜지고, 대화에는 위치를 알려주는 한 줄이 남는다. 폴더 선택과 등록은 전적으로 사람이 그 버튼으로 한다 — 이 도구는 아무것도 만들지 않는다. "프로젝트는 어떻게 만들어?"에 답할 때 함께 쓴다: 말로 설명하고, 이걸로 자리를 짚어 준다.',
    schema: z.object({
      reason: z.string().optional().describe('왜 필요한지 짧게 한 마디. 가리키는 줄 끝에 덧붙는다'),
    }),
  },
  {
    name: 'create_session',
    description:
      '워커 세션을 하나 만든다 (#13). 시킬 세션이 마땅치 않을 때 쓴다 — 만든 세션은 사람 눈에 보이는 목록에 바로 나타난다. 지우기는 사람 몫이다.',
    schema: z.object({
      project: z
        .string()
        .optional()
        .describe('프로젝트 이름 또는 id. 프로젝트 오케스트레이터는 생략한다 (자기 프로젝트에만 만든다)'),
      /*
       * Deliberately the same union the rest of the app uses, not a copy of it. A second
       * literal here could fall behind and the orchestrator would be unable to name a tool
       * that exists — a failure with no error, only an option that is never offered.
       *
       * Note the coupling runs both ways: if `ToolName` ever opens up (#74), this schema
       * widens with it. That is a decision to make there, with the injection surface in
       * view, not something to discover here.
       */
      tool: ToolName.optional().describe('생략하면 프로젝트의 기본 도구'),
      name: z.string().optional().describe('세션 이름. 주면 자동 이름이 덮지 않는다'),
      firstMessage: z.string().optional().describe('만들자마자 보낼 첫 지시'),
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
  '시킬 세션이 마땅치 않으면 create_session으로 새로 만든다 — 지우기는 사람 몫이다.',
  '프로젝트를 만드는 방법을 물으면 propose_project로 사이드바의 Add project를 짚어 준다 — 등록은 사람이 한다.',
  '앱에 대한 질문에 답을 모르면 짐작하지 말고 GitHub 이슈로 안내한다: https://github.com/ijun17/centralu/issues',
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
            // 계급이 보여야 "그 프로젝트 일은 그쪽에 맡긴다"가 가능하다 (#13)
            (s.orchestrator ? ' · 오케스트레이터' : '') +
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

  if (name === 'propose_project') {
    /*
     * 매니저를 거치지 않는다 — 이 도구의 실행은 **가리키는 것 그 자체**다.
     * tool_call 이벤트가 대화에 남으면 UI가 사이드바의 Add project에 불을 켜고
     * 위치를 알려주는 한 줄을 그린다. 여기서 프로젝트를 만들면 안내가 아니라
     * 권한이 된다 (read_session/recall을 타고 들어온 주입이 임의 폴더에 닿는 길).
     */
    return {
      text:
        '사이드바의 "Add project" 버튼에 불을 켰습니다. 폴더 선택과 등록은 사람이 그 버튼으로 합니다 — ' +
        '대신 골라 줄 수도, 재촉할 수도 없습니다. 사람이 등록하면 그 사실을 알게 됩니다.',
    }
  }

  if (name === 'app_guide') {
    // 정적 내용이라 매니저를 거치지 않는다 — 빌드에 내장된 글이 곧 능력의 전부다 (#30)
    return appGuide(typeof args.topic === 'string' ? args.topic : undefined)
  }

  if (name === 'update_session_settings') {
    const r = await tools.updateSessionSettings(String(args.sessionId ?? ''), {
      ...(args.model !== undefined ? { model: args.model as string | null } : {}),
      ...(args.effort !== undefined ? { effort: args.effort as string | null } : {}),
      ...(args.verbosity !== undefined ? { verbosity: args.verbosity as string | null } : {}),
    })
    return {
      text: r.ok
        ? `바꿨습니다: ${args.sessionId} — 화면에도 알렸습니다` // 흔적 없는 변경 금지 (#30)
        : `바꾸지 못했습니다 — ${r.error}`,
      isError: !r.ok,
    }
  }

  if (name === 'create_session') {
    const r = await tools.createSession({
      project: typeof args.project === 'string' ? args.project : undefined,
      tool: ToolName.safeParse(args.tool).data,
      name: typeof args.name === 'string' ? args.name : undefined,
      firstMessage: typeof args.firstMessage === 'string' ? args.firstMessage : undefined,
    })
    return {
      text: r.ok
        ? `만들었습니다: ${r.name} [${r.sessionId}]` + (typeof args.firstMessage === 'string' ? ' — 첫 지시를 보냈습니다' : '')
        : `만들지 못했습니다 — ${r.error}`,
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
