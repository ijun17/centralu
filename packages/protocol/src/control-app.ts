import type { ToolName } from './entities.js'

/*
 * 관제 앱(#80·#81)의 문서 모양 — **한 번만 정의한다** (M4 P-5).
 *
 * 앱의 상태는 JSON 문서 하나이고, 프로토콜은 그것을 `unknown`으로 운반만 한다(`apps.*`).
 * 그 원칙은 그대로다: 여기 있는 타입은 전선의 어떤 스키마에도 쓰이지 않고, 이 패키지의
 * 다른 파일도 이것을 모른다. 여기 두는 이유는 하나 — 이 앱은 두 절반(호스트의 도구·관찰,
 * UI의 레일·설정)이 **같은 문서를 읽고 쓰는데**, 두 절반이 함께 임포트할 수 있는 곳이
 * 이 패키지뿐이다(agent-host는 protocol만, ui는 core·ports·protocol만 안다).
 *
 * 한 벌이던 적이 없어서 생긴 일: 호스트는 `notifies`를 필수로, UI는 선택으로 적었다.
 * 저장되는 것은 UI 쪽 모양이었다 — 문서가 아직 없을 때 UI는 `{ ...(doc ?? {}), metrics }`처럼
 * 알림 칸 없이 쓴다. 호스트는 그 문서에서 `doc.notifies.push`로 넘어졌다 — 새로 설치한 뒤
 * 레일에서 한 줄 답을 한 번 하면, 그 뒤의 control_notify는 TypeError로 실패하고 감시는 조용히
 * 울리지 않았다(apps/control.test.ts로 재현). 모양을 한 곳에 두는 것은 타입을 아끼려는 것이
 * 아니라, 저장되는 진실을 두 절반이 같은 말로 읽게 하려는 것이다.
 *
 * zod 스키마가 아니라 타입인 이유: 이 문서를 검증하는 자리가 없다(전선은 `unknown`이다).
 * 스키마를 두면 아무도 하지 않는 검사를 하는 것처럼 읽힌다.
 */

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

/**
 * 반장 스폰 설정 — 걸러듣는 판단력이 필요해 저가 모델 금지 (사용자 결정: opus/terra high급).
 * 도구는 열린 이름이다(#74): 어느 도구가 있는지는 호스트의 어댑터가 정한다.
 */
export type ForemanSettings = { tool: ToolName; model?: string; effort?: string }

/**
 * 관제 앱의 문서 전체. **모든 칸이 선택이다** — 어느 절반이 먼저 썼느냐에 따라 어느 칸이든
 * 없을 수 있고, 읽는 쪽이 빈 칸을 기본값으로 읽는다.
 */
export type ControlDoc = {
  notifies?: ControlNotify[]
  /** 판정 카운터 (#80) — inlineReplies, railOpens */
  metrics?: Record<string, number>
  watches?: ControlWatch[]
  tasks?: ControlTask[]
  foreman?: ForemanSettings
}
