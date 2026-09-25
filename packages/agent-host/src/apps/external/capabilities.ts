import { z } from 'zod'

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
