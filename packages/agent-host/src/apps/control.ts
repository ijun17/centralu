import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { HostAppModule, HostAppContext, AppToolCaller, ToolOutput } from './contract.js'

/**
 * 관제 앱의 host 절반 (#80·#81) — 레일 알림, 선언형 감시, 그리고 **업무**.
 *
 * "업무·반장"이라는 개념 전체가 이 파일(앱)에 산다. 코어가 주는 것은 이름 없는
 * 물리 둘(시야 허용 목록, 역할문 박제)뿐이고, 여기가 그 위에 의미를 입힌다 —
 * 앱을 꺼도 만들어진 조율 세션은 "시야 잘린 조율 세션"이라는 일관된 코어 객체로
 * 우아하게 강등된다 (#81 소유권 경계).
 */

/** 알림 보관 상한 — 사람이 안 지운 옛 알림이 문서를 무한히 불리면 안 된다 */
const NOTIFY_CAP = 50

export type ControlNotify = {
  id: string
  text: string
  sessionId?: string
  priority?: 'high' | 'normal'
  ts: number
}

/**
 * 선언형 감시 (#80 체크포인트 v1 — 알림만, 멈춤 없음).
 *
 * bypass로 도는 세션은 도중에 멈출 수 없다 — 승인 요청은 도구 쪽 권한 모드가
 * 만드는 것이라서. 그래서 v1의 계약은 "지켜봐 주고, 걸리면 즉시 부른다"다.
 */
export type ControlWatch = { id: string; pattern: string; sessionId?: string }

/** 업무 — 세션 여럿 + 반장(조율 세션) 하나 + 보드 하나. 완료돼도 지우지 않는다(재소집 가능) */
export type ControlTask = {
  id: string
  title: string
  goal: string
  members: string[]
  coordinatorId: string
  status: 'active' | 'done'
  createdAt: number
}

/** 반장 스폰 설정 — 걸러듣는 판단력이 필요해 저가 모델 금지 (사용자 결정: opus/terra high급) */
export type ForemanSettings = { tool: 'claude' | 'codex'; model?: string; effort?: string }

export type ControlDoc = {
  notifies: ControlNotify[]
  metrics?: Record<string, number>
  watches?: ControlWatch[]
  tasks?: ControlTask[]
  foreman?: ForemanSettings
}

/**
 * 반장의 역할문 — 창조 시 세션 행에 박제된다 (코어 손잡이 ②).
 *
 * 핵심 요구 둘 (사용자 지정): **걸러듣기** — 구성원 보고를 그대로 전달하면 반장이
 * 아니라 확성기다 — 와 **보드가 기억** — 대화는 컴팩트되면 사라지므로 상태는
 * board_update로 물질화한다 (매니저 지침의 "파일에 적힌 배정만 살아남는다"와 동형).
 */
export function taskRole(taskId: string, title: string, goal: string): string {
  return [
    `너는 업무 "${title}"의 반장이다. 목표: ${goal}`,
    `업무 id: ${taskId} — board_read/board_update의 taskId가 이것이다.`,
    '',
    '규칙:',
    '- 구성원 세션들에게 일을 나눠 시키고(send_to_session, reportBack 권장), 결과를 **걸러 들어라** —',
    '  구성원의 "됐습니다"를 검증 없이 믿고 전달하면 너는 반장이 아니라 확성기다.',
    '  의심스러우면 read_session으로 실제 작업 내용을 확인하고, 필요하면 재작업을 시켜라.',
    '- **보드가 네 기억이다.** 단계·배정·결정·산출물을 board_update로 그때그때 물질화하라 —',
    '  네 대화는 압축되면 사라지지만 보드는 남는다. 깨어나면 board_read부터 하라.',
    '- 사람이 봐야 할 일(막힘·범위 결정·완료)은 control_notify로 레일에 올려라.',
    '- 업무가 끝나면 control_task_done으로 마감하라 — 보드에 최종 요약을 남긴 뒤에.',
    '- 네 시야는 배정된 구성원이 전부다. 그 밖이 필요하면 사람에게 보고하라.',
  ].join('\n')
}

const BOARD_TEMPLATE = (title: string, goal: string, members: string[]) =>
  [
    `# 업무 보드: ${title}`,
    '',
    `## 목표`,
    goal,
    '',
    `## 구성원`,
    ...members.map((m) => `- ${m}`),
    '',
    '## 단계',
    '(반장이 채운다)',
    '',
    '## 결정과 산출물',
    '(반장이 채운다)',
  ].join('\n')

function readDoc(ctx: HostAppContext): ControlDoc {
  return ctx.kv.get<ControlDoc>('doc') ?? { notifies: [] }
}

function pushNotify(doc: ControlDoc, n: Omit<ControlNotify, 'id' | 'ts'>): void {
  doc.notifies.push({ id: randomUUID(), ts: Date.now(), ...n })
  if (doc.notifies.length > NOTIFY_CAP) doc.notifies = doc.notifies.slice(-NOTIFY_CAP)
}

/** 보드 접근 판정 — 그 업무의 반장이거나 사람(null)만. 남의 업무 보드는 남의 것이다 */
function boardDenied(task: ControlTask | undefined, caller: AppToolCaller): ToolOutput | null {
  if (!task) return { text: '그런 업무가 없습니다', isError: true }
  if (caller.sessionId !== null && caller.sessionId !== task.coordinatorId && caller.profile !== 'orchestrator') {
    return { text: '이 업무의 반장만 보드를 만질 수 있습니다', isError: true }
  }
  return null
}

export const controlHostApp: HostAppModule = {
  id: 'control',
  tools: {
    // scoped(반장)도 notify·보드를 쓴다 — 사람 호출과 기억이 반장 역할의 반쪽이다
    profiles: ['orchestrator', 'manager', 'scoped'],
    defs: [
      {
        name: 'control_notify',
        description:
          '사람의 관제 레일(내 차례 큐)에 알림을 올린다 — 사람이 봐야 할 일이 생겼는데 세션 상태(승인·질문)로는 드러나지 않을 때. ' +
          '예: 어떤 세션이 외부 조건에 막혔다, 여러 세션에 걸친 결정이 필요하다. 알림은 사람이 읽고 지운다 — 너는 올릴 수만 있다.',
        schema: z.object({
          text: z.string().describe('사람이 읽을 한 줄 — 무엇이, 왜 사람을 필요로 하는가'),
          sessionId: z.string().optional().describe('관련 세션 id — 주면 레일에서 바로 그 세션으로 이동할 수 있다'),
          priority: z.enum(['high', 'normal']).optional().describe('high는 줄 맨 위에 선다. 기본 normal'),
        }),
      },
      {
        name: 'control_create_task',
        description:
          '업무를 만든다: 구성원 세션들을 묶고, 그 업무만 보는 반장(조율 세션)이 선다. ' +
          '여러 세션에 걸친 일을 사람이 중계하는 대신 반장에게 맡길 때 쓴다. 반장은 보드에 상태를 적고, 사람이 필요하면 레일로 부른다.',
        schema: z.object({
          title: z.string().describe('업무 이름 — 반장 세션의 이름이 된다'),
          goal: z.string().describe('업무의 목표 — 반장의 역할문에 박제된다'),
          memberSessionIds: z.array(z.string()).min(1).describe('구성원 워커 세션 id들 (list_sessions의 [id])'),
        }),
        // 반장(scoped)에게는 노출조차 안 한다 — 깊이 1의 구조적 보장 (실행 쪽 판정과 이중)
        profiles: ['orchestrator'],
      },
      {
        name: 'board_read',
        description: '업무 보드를 읽는다 — 반장의 기억이자 사람의 현황판. 깨어난 반장은 이것부터 한다.',
        schema: z.object({ taskId: z.string().describe('업무 id (역할문에 적혀 있다)') }),
        profiles: ['orchestrator', 'scoped'],
      },
      {
        name: 'board_update',
        description:
          '업무 보드를 통째로 갱신한다 — 단계·배정·결정·산출물을 그때그때 물질화하라. 대화는 압축되면 사라지지만 보드는 남는다.',
        schema: z.object({
          taskId: z.string().describe('업무 id'),
          content: z.string().describe('보드 전문 (마크다운) — 부분 수정이 아니라 전체 교체다'),
        }),
        profiles: ['scoped'],
      },
      {
        name: 'control_task_done',
        description: '업무를 마감한다 — 보드에 최종 요약을 남긴 뒤 불러라. 사람의 레일에 완료 알림이 선다.',
        schema: z.object({
          taskId: z.string().describe('업무 id'),
          summary: z.string().optional().describe('한 줄 마감 보고 — 레일 알림에 실린다'),
        }),
        profiles: ['scoped'],
      },
    ],

    async run(ctx, name, args, caller) {
      const doc = readDoc(ctx)

      if (name === 'control_notify') {
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined
        if (sessionId && !ctx.sessionSummary(sessionId)) {
          return { text: `그런 세션이 없습니다: ${sessionId}`, isError: true }
        }
        pushNotify(doc, {
          text: String(args.text ?? ''),
          ...(sessionId ? { sessionId } : {}),
          ...(args.priority === 'high' ? { priority: 'high' as const } : {}),
        })
        ctx.kv.set('doc', doc)
        ctx.emitChanged()
        return { text: '관제 레일에 알림을 올렸습니다. 지우는 것은 사람입니다.' }
      }

      if (name === 'control_create_task') {
        // 반장은 만드는 자가 아니라 만들어지는 자다 — scoped가 이 도구를 부르면 깊이가 자란다.
        // 프로필 노출에서 이미 걸러지지만, 실행 쪽도 같은 판정을 한 번 더 한다 (#69 규칙).
        if (caller.profile === 'scoped') return { text: '반장은 업무를 만들 수 없습니다', isError: true }
        const members = args.memberSessionIds as string[]
        for (const id of members) {
          if (!ctx.sessionSummary(id)) return { text: `구성원 세션이 없습니다: ${id}`, isError: true }
        }
        const taskId = randomUUID().slice(0, 8)
        const title = String(args.title ?? '').trim() || '이름 없는 업무'
        const goal = String(args.goal ?? '').trim()
        const foreman = doc.foreman ?? { tool: 'claude' as const, effort: 'high' }
        const coordinator = await ctx.sessions.createCoordinator({
          name: title,
          memberSessionIds: members,
          roleAppend: taskRole(taskId, title, goal),
          tool: foreman.tool,
          model: foreman.model,
          effort: foreman.effort ?? 'high',
        })
        ctx.kv.set(`board:${taskId}`, BOARD_TEMPLATE(title, goal, members.map((m) => ctx.sessionSummary(m)?.name ?? m)))
        doc.tasks = [
          ...(doc.tasks ?? []),
          { id: taskId, title, goal, members, coordinatorId: coordinator.id, status: 'active', createdAt: Date.now() },
        ]
        ctx.kv.set('doc', doc)
        ctx.emitChanged()
        return {
          text:
            `업무 "${title}"를 만들었습니다 (id: ${taskId}). 반장 세션 [${coordinator.id}]이 구성원 ${members.length}명을 조율합니다. ` +
            '반장에게 첫 지시를 보내면 일이 시작됩니다.',
        }
      }

      if (name === 'board_read') {
        const task = (doc.tasks ?? []).find((t) => t.id === args.taskId)
        const denied = boardDenied(task, caller)
        if (denied) return denied
        const board = ctx.kv.get<string>(`board:${task!.id}`) ?? '(보드가 비어 있습니다)'
        return { text: board }
      }

      if (name === 'board_update') {
        const task = (doc.tasks ?? []).find((t) => t.id === args.taskId)
        const denied = boardDenied(task, caller)
        if (denied) return denied
        ctx.kv.set(`board:${task!.id}`, String(args.content ?? ''))
        ctx.emitChanged()
        return { text: '보드를 갱신했습니다.' }
      }

      if (name === 'control_task_done') {
        const task = (doc.tasks ?? []).find((t) => t.id === args.taskId)
        const denied = boardDenied(task, caller)
        if (denied) return denied
        task!.status = 'done'
        pushNotify(doc, {
          text: `✅ 업무 완료: ${task!.title}${args.summary ? ` — ${String(args.summary)}` : ''}`,
          sessionId: task!.coordinatorId,
          priority: 'high',
        })
        ctx.kv.set('doc', doc)
        ctx.emitChanged()
        return { text: '업무를 마감했습니다. 사람의 레일에 완료 알림이 섰습니다.' }
      }

      return { text: `모르는 도구입니다: ${name}`, isError: true }
    },
  },

  observe(ctx, e) {
    if (e.type !== 'tool_call' || !e.sessionId) return
    const doc = ctx.kv.get<ControlDoc>('doc')
    const watches = doc?.watches ?? []
    if (watches.length === 0) return // 감시가 없으면 이 훅은 공짜여야 한다 — kv 읽기 하나로 끝
    const line = `${e.summary.tool}: ${e.summary.title} ${(e.summary.paths ?? []).join(' ')}`.toLowerCase()
    const hits = watches.filter(
      (w) =>
        w.pattern.trim() &&
        (!w.sessionId || w.sessionId === e.sessionId) &&
        line.includes(w.pattern.trim().toLowerCase()),
    )
    if (hits.length === 0) return
    const name = ctx.sessionSummary(e.sessionId)?.name ?? e.sessionId
    const next: ControlDoc = doc ?? { notifies: [] }
    for (const w of hits) {
      pushNotify(next, { text: `⏱ ${w.pattern} — ${name}: ${e.summary.title}`, sessionId: e.sessionId, priority: 'high' })
    }
    ctx.kv.set('doc', next)
    ctx.emitChanged()
  },
}
