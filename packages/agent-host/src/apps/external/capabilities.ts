import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AppRef } from './ref.js'
import { canonicalJson } from './runs.js'

/**
 * 앱이 host에게서 읽을 수 있는 데이터 — **닫힌 목록** (M4 D-3, #97 셋째 항목의 "능력 모델"을 외부 앱 쪽에서 푼다).
 *
 * 앱은 이 목록에서 쓸 것을 매니페스트의 `uses.host`에 적는다. 적지 않은 것은 주지 않는다(기본은 거절). 목록 밖의 이름은
 * 아예 없는 능력이다 — "host 데이터를 읽는 도구" 하나를 열어 두고 무엇을 줄지를 요청의 글자로 정하면, 무엇이 새는지를
 * 코드가 아니라 앱의 요청이 정하게 된다. 그래서 이름마다 무엇을 얼마나 주는지 여기서 정하고, 이름을 늘리는 것은 이 파일을
 * 고치는 일이다.
 *
 * 모두 **읽기 전용**이다. host를 바꾸는 능력(세션에 말 걸기, 세션 만들기)은 이 목록에 넣지 않는다 — 그런 일은 사람의
 * 에이전트에게 부탁하는 길(`run_agent`)이 있고, 그 길은 사람이 보는 세션에서 승인 규칙을 따른다.
 *
 *   sessions.list  세션 요약 — 이름·상태·도구·종류·시각. 대화(미리보기 포함)는 싣지 않는다. 이름은 사이드바에 보이는 그
 *                  이름이다: 사람이 짓지 않은 이름은 첫 메시지의 앞 40자라 그 조각이 이름으로 나간다 — 목록에 이름이
 *                  없으면 앱이 쓸 수 없고, 더 나가지는 않는다. 프로젝트 앱은 그 프로젝트의 세션, 사용자 폴더 앱은
 *                  모든 세션(사용자 폴더 앱은 오케스트레이터의 것이다 — 결정 4)
 *   git.status     프로젝트의 브랜치와 바뀐 파일 목록. 프로젝트 앱만 — 사용자 폴더 앱에는 고를 프로젝트가 없다
 */
export const HOST_CAPABILITIES = ['sessions.list', 'git.status'] as const
export const HostCapability = z.enum(HOST_CAPABILITIES)
export type HostCapability = z.infer<typeof HostCapability>

export function isHostCapability(name: string): name is HostCapability {
  return HostCapability.safeParse(name).success
}

/** 사람이 읽을 말 — 능력 승인(D-4)의 질문과 거절의 이유가 쓴다. 범위에 따라 말이 다르다 */
export function hostCapabilityText(name: HostCapability, scope: 'project' | 'user'): string {
  switch (name) {
    case 'sessions.list':
      return scope === 'project'
        ? "read the list of this project's sessions (the names you see in the sidebar and their states, not the conversations)"
        : 'read the list of all your sessions (the names you see in the sidebar and their states, not the conversations)'
    case 'git.status':
      return "read this project's git branch and changed files"
  }
}

/**
 * 앱이 쓰려는 능력 하나 (M4 D-4) — 사람에게 묻고 답을 기억하는 단위.
 *
 *   agent  에이전트를 부탁한다 — 도구마다 따로(Claude를 허락했다고 Codex까지 허락한 것이 아니다)
 *   app    다른 앱을 부른다 — 부를 앱마다 따로. 앱은 (범위, id)라 범위까지 적는다: 같은 id의 앱이 프로젝트에 새로 생기면
 *          부르는 대상이 바뀐 것이고(resolveCallTarget), 사람이 허락한 것은 그 앱이 아니다
 *   host   host 데이터를 읽는다 — 이름마다 따로
 */
export type Capability =
  | { kind: 'agent'; tool: string }
  | { kind: 'app'; target: AppRef }
  | { kind: 'host'; name: HostCapability }

/** 기억의 열쇠 — 한 앱 안에서 능력 하나를 가리킨다 */
export function capabilityKey(c: Capability): string {
  switch (c.kind) {
    case 'agent':
      return `agent:${c.tool}`
    case 'app':
      return `app:${c.target.projectId ?? '_user'}/${c.target.appId}`
    case 'host':
      return `host:${c.name}`
  }
}

/**
 * 매니페스트의 선언(`uses`)의 지문 — 답은 이 지문과 함께 기억되고, 지문이 달라지면 다시 묻는다(플랜 D-4). 선언 전체를
 * 본다: 어느 칸이 바뀌었든 앱을 만든 쪽이 앱이 무엇을 쓰는지 다시 말한 것이고, 사람도 다시 볼 까닭이 있다. 키 순서가
 * 달라도 같은 선언은 같은 지문이다(`canonicalJson`).
 */
export function usesStamp(uses: unknown): string {
  return createHash('sha256').update(canonicalJson(uses ?? {})).digest('hex')
}

/** 기억된 답 하나 */
export type CapabilityDecision = {
  capability: string
  /** 물을 때 사람에게 보인 말 — 목록에서 그대로 다시 보인다 */
  text: string
  decision: 'allow' | 'deny'
  /** 답할 때의 선언 지문 (`usesStamp`) */
  stamp: string
  decidedAt: number
}

/**
 * 답을 둘 자리 — 런타임은 모양만 선언하고 host가 저장소로 채운다(`RunLedger`와 같은 뒤집기, main.ts). 없으면 메모리에
 * 둔다(`memoryCapabilityBook`) — host가 떠 있는 동안은 한 번 묻는다는 약속이 선다.
 */
export type CapabilityBook = {
  get(app: AppRef, capability: string): CapabilityDecision | null
  put(app: AppRef, d: CapabilityDecision): void
  forget(app: AppRef, capability: string): void
  list(app: AppRef): CapabilityDecision[]
}

export function memoryCapabilityBook(): CapabilityBook {
  const key = (app: AppRef) => `${app.projectId ?? '_user'}/${app.appId}`
  const rows = new Map<string, Map<string, CapabilityDecision>>()
  return {
    get: (app, capability) => rows.get(key(app))?.get(capability) ?? null,
    put: (app, d) => {
      const m = rows.get(key(app)) ?? new Map<string, CapabilityDecision>()
      m.set(d.capability, { ...d })
      rows.set(key(app), m)
    },
    forget: (app, capability) => void rows.get(key(app))?.delete(capability),
    list: (app) => [...(rows.get(key(app))?.values() ?? [])].map((d) => ({ ...d })),
  }
}
