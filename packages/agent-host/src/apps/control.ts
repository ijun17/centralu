import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { HostAppModule } from './contract.js'

/**
 * 관제 앱의 host 절반 (#80·#81) — 도구 하나: `control_notify`.
 *
 * 인박스(사람의 큐)에 **기계가 항목을 꽂는 유일한 입**이다. ambient agents의
 * notify 타입 — 오케스트레이터/매니저가 "세션 X가 Y에서 막혔다"를 사람의 레일에
 * 직접 올린다. 지우기·재배열 권한은 일부러 없다: 인박스는 사람의 자리라,
 * 기계가 그 목록을 조용히 주무르는 것이 곧 조용한-행동 문제다.
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
 * 만드는 것이라서. 그래서 v1의 계약은 "지켜봐 주고, 걸리면 즉시 부른다"다:
 * 사람이 패턴을 선언하면 host의 관찰 훅이 툴 호출마다 대조하고, 걸린 순간
 * 레일 알림(high)이 선다. 멈춤은 프리셋 연동이 생기면 그때의 일이다.
 */
export type ControlWatch = { id: string; pattern: string; sessionId?: string }

export type ControlDoc = { notifies: ControlNotify[]; metrics?: Record<string, number>; watches?: ControlWatch[] }

export const controlHostApp: HostAppModule = {
  id: 'control',
  tools: {
    profiles: ['orchestrator', 'manager'],
    defs: [
      {
        name: 'control_notify',
        description:
          '사람의 관제 레일(내 차례 큐)에 알림을 올린다 — 사람이 봐야 할 일이 생겼는데 세션 상태(승인·질문)로는 드러나지 않을 때. ' +
          '예: 어떤 세션이 외부 조건에 막혔다, 여러 세션에 걸친 결정이 필요하다. ' +
          '알림은 사람이 읽고 지운다 — 너는 올릴 수만 있다.',
        schema: z.object({
          text: z.string().describe('사람이 읽을 한 줄 — 무엇이, 왜 사람을 필요로 하는가'),
          sessionId: z.string().optional().describe('관련 세션 id — 주면 레일에서 바로 그 세션으로 이동할 수 있다'),
          priority: z.enum(['high', 'normal']).optional().describe('high는 줄 맨 위에 선다. 기본 normal'),
        }),
      },
    ],
    async run(ctx, _name, args) {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined
      if (sessionId && !ctx.sessionSummary(sessionId)) {
        return { text: `그런 세션이 없습니다: ${sessionId}`, isError: true }
      }
      const doc = ctx.kv.get<ControlDoc>('doc') ?? { notifies: [] }
      doc.notifies.push({
        id: randomUUID(),
        text: String(args.text ?? ''),
        ...(sessionId ? { sessionId } : {}),
        ...(args.priority === 'high' ? { priority: 'high' as const } : {}),
        ts: Date.now(),
      })
      // 오래된 것부터 밀어낸다 — 상한은 문서 크기의 예산이지 알림의 가치 판단이 아니다
      if (doc.notifies.length > NOTIFY_CAP) doc.notifies = doc.notifies.slice(-NOTIFY_CAP)
      ctx.kv.set('doc', doc)
      ctx.emitChanged()
      return { text: '관제 레일에 알림을 올렸습니다. 지우는 것은 사람입니다.' }
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
    const notifies = doc?.notifies ?? []
    for (const w of hits) {
      notifies.push({
        id: randomUUID(),
        text: `⏱ ${w.pattern} — ${name}: ${e.summary.title}`,
        sessionId: e.sessionId,
        priority: 'high',
        ts: Date.now(),
      })
    }
    const next: ControlDoc = { ...(doc ?? { notifies: [] }), notifies: notifies.slice(-NOTIFY_CAP) }
    ctx.kv.set('doc', next)
    ctx.emitChanged()
  },
}
